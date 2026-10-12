/** POST /mcp: origin, query and bearer checks, then the MCP SDK. */
import { createMcpHandler, isJsonContentType, McpServer, readRequestBody, type AuthInfo } from '@modelcontextprotocol/server'
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { bearerFromHeader } from '../auth/bearer.ts'
import type { Logger } from '../log.ts'
import {
  jsonRpcError,
  MCP_HTTP_ERROR_TEXT,
  MCP_JSONRPC_BATCH_TEXT,
  MCP_JSONRPC_INVALID_REQUEST,
  MCP_JSONRPC_PARSE_ERROR,
  MCP_JSONRPC_PARSE_ERROR_TEXT,
  MCP_LIMITS,
  MCP_SERVER_INFO,
  MCP_WWW_AUTHENTICATE,
  MCP_WWW_AUTHENTICATE_NO_CREDENTIALS,
  type McpCallContext,
  type McpHttpErrorCode,
  type McpVerifiedBearer,
} from './contract.ts'
import { serverInstructions } from './tools.ts'

export interface McpEndpointDeps {
  log: Logger
  /** Looks a well-formed token up; null when unknown, revoked or expired. */
  verifyBearer(token: string): Promise<McpVerifiedBearer | null>
  /** The bearer-failure limiter: a RateLimiter of its own, keyed by client IP. */
  failures: { retryAfter(ip: string): number | null; recordFailure(ip: string): void }
  clientIp(c: Context): string
  /** csrfGuard's origin rule, bound to the server's configuration. */
  originAllowed(origin: string, host: string): boolean
  registerTools(server: McpServer, call: McpCallContext): void
}

export interface McpEndpoint {
  /** Mount with app.route('/', endpoint.routes). */
  routes: Hono
  /** Closes the SDK handler; later POSTs get 503. */
  close(): Promise<void>
}

/** Only this text goes into the AuthInfo handed to the SDK; the bearer token itself never does. */
const VERIFIED_PLACEHOLDER = 'urutau-verified'
const REFUSED_PREFIX = 'Rejected inbound request ('

/** A copy of the request without Authorization, Cookie and Proxy-Authorization. */
export function withoutCredentials(raw: Request): Request {
  const headers = new Headers(raw.headers)
  headers.delete('authorization')
  headers.delete('cookie')
  headers.delete('proxy-authorization')
  return new Request(raw, { headers, signal: raw.signal })
}

/** RFC 6750 §3.1: no error attribute when the request sent no credentials at all. */
function challengeFor(req: Request): string {
  return req.headers.has('authorization') ? MCP_WWW_AUTHENTICATE : MCP_WWW_AUTHENTICATE_NO_CREDENTIALS
}

/** The 413 the SDK itself would give for a body over MCP_LIMITS.requestBodyBytes. */
const BODY_TOO_LARGE_TEXT = `Payload Too Large: Request body must not exceed ${MCP_LIMITS.requestBodyBytes} bytes`

/**
 * Reads a JSON POST body up to the byte cap and refuses what the SDK must not see: a body that is
 * not JSON (-32700) and a batch (-32600). MCP 2025-06-18 removed JSON-RPC batching; refusing it
 * here also means a batch's tools/list and ping calls can no longer get past the call limits.
 * Returns the request to forward and its parsed body, or the refusal.
 */
async function preparseBody(raw: Request): Promise<{ request: Request; parsedBody: unknown } | Response> {
  let text: string
  try {
    const read = await readRequestBody(raw, MCP_LIMITS.requestBodyBytes)
    if (read.tooLarge) return Response.json(jsonRpcError(-32000, BODY_TOO_LARGE_TEXT), { status: 413 })
    text = read.text
  } catch {
    return Response.json(jsonRpcError(MCP_JSONRPC_PARSE_ERROR, MCP_JSONRPC_PARSE_ERROR_TEXT), { status: 400 })
  }
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(text)
  } catch {
    return Response.json(jsonRpcError(MCP_JSONRPC_PARSE_ERROR, MCP_JSONRPC_PARSE_ERROR_TEXT), { status: 400 })
  }
  if (Array.isArray(parsedBody)) {
    return Response.json(jsonRpcError(MCP_JSONRPC_INVALID_REQUEST, MCP_JSONRPC_BATCH_TEXT), { status: 400 })
  }
  const headers = new Headers(raw.headers)
  headers.delete('content-length')
  const request = new Request(raw.url, { method: raw.method, headers, body: text, signal: raw.signal })
  return { request, parsedBody }
}

function errorResponse(status: ContentfulStatusCode, error: McpHttpErrorCode, headers: Record<string, string> = {}): Response {
  return Response.json({ error, message: MCP_HTTP_ERROR_TEXT[error] }, { status, headers })
}

export function createMcpEndpoint(deps: McpEndpointDeps): McpEndpoint {
  const { log } = deps
  const calls = new WeakMap<AuthInfo, McpCallContext>()
  const principals = new WeakMap<Request, McpVerifiedBearer>()

  const handler = createMcpHandler(
    (ctx) => {
      const call = ctx.authInfo ? calls.get(ctx.authInfo) : undefined
      const server = new McpServer(MCP_SERVER_INFO, {
        capabilities: { tools: { listChanged: false } },
        instructions: serverInstructions(call?.permissions ?? { moveCards: false }),
      })
      if (call) deps.registerTools(server, call)
      return server
    },
    {
      legacy: 'stateless',
      responseMode: 'sse',
      maxRequestBodySize: MCP_LIMITS.requestBodyBytes,
      // The SDK puts header values into error messages, so only the name and the refusal cell are logged.
      onerror: (error) => {
        if (error.message.startsWith(REFUSED_PREFIX)) {
          const cell = error.message.slice(REFUSED_PREFIX.length).split(')', 1)[0]
          log.warn('mcp request refused', { name: error.name, cell: /^[a-z0-9-]{1,64}$/.test(cell) ? cell : 'other' })
        } else {
          log.warn('mcp handler error', { name: error.name })
        }
      },
    },
  )

  const routes = new Hono()

  routes.use('/mcp', async (c, next) => {
    const started = Date.now()
    let user: string | null = null
    const record = (status: number) =>
      log.info('request', { method: c.req.method, path: '/mcp', status, ms: Date.now() - started, user })

    // 1. Origin: a browser page of another site never reaches the token check.
    const origin = c.req.header('origin')
    if (origin !== undefined) {
      const host = c.req.header('host') ?? new URL(c.req.url).host
      if (!deps.originAllowed(origin, host)) {
        record(403)
        return errorResponse(403, 'origin-rejected')
      }
    } else {
      // Browsers send 'none' only for navigations the user started (address bar, bookmark), which no
      // cross-site page can cause; clients that are not browsers send no Sec-Fetch-Site at all.
      const site = c.req.header('sec-fetch-site')
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        record(403)
        return errorResponse(403, 'origin-rejected')
      }
    }

    // 2. Query string: refused before any lookup, so a token put in the address is never read.
    if (c.req.url.includes('?')) {
      record(400)
      return errorResponse(400, 'query-not-allowed')
    }

    // 3. Bearer: a live token always passes; the failure limiter only gates misses.
    const token = bearerFromHeader(c.req.header('authorization'))
    let principal: McpVerifiedBearer | null = null
    try {
      principal = token === null ? null : await deps.verifyBearer(token)
    } catch (error) {
      record(500)
      throw error
    }
    if (principal === null) {
      const ip = deps.clientIp(c)
      const wait = deps.failures.retryAfter(ip)
      if (wait !== null) {
        record(429)
        return errorResponse(429, 'too-many-attempts', { 'Retry-After': String(wait) })
      }
      deps.failures.recordFailure(ip)
      record(401)
      return errorResponse(401, 'invalid-token', { 'WWW-Authenticate': challengeFor(c.req.raw) })
    }
    user = principal.userId
    principals.set(c.req.raw, principal)

    try {
      await next()
    } catch (error) {
      record(500)
      throw error
    }
    record(c.res.status)
  })

  routes.post('/mcp', async (c) => {
    const verified = principals.get(c.req.raw)
    if (!verified) return errorResponse(401, 'invalid-token', { 'WWW-Authenticate': challengeFor(c.req.raw) })
    const { permissions, ...principal } = verified
    // scopes is information only: the tool list itself follows call.permissions.
    const scopes = ['read', ...Object.entries(permissions).filter(([, granted]) => granted).map(([key]) => key)]
    const authInfo: AuthInfo = { token: VERIFIED_PLACEHOLDER, clientId: principal.userId, scopes }
    calls.set(authInfo, { principal, permissions })
    // A body that is not JSON by its Content-Type goes on unread, so the SDK still answers 415.
    let request = c.req.raw
    let parsedBody: unknown
    if (isJsonContentType(request.headers.get('content-type'))) {
      const prepared = await preparseBody(request)
      if (prepared instanceof Response) return prepared
      request = prepared.request
      parsedBody = prepared.parsedBody
    }
    try {
      return await handler.fetch(withoutCredentials(request), { authInfo, ...(parsedBody !== undefined && { parsedBody }) })
    } catch {
      return errorResponse(503, 'unavailable')
    }
  })

  routes.all('/mcp', () => errorResponse(405, 'method-not-allowed', { Allow: 'POST' }))

  return { routes, close: () => handler.close() }
}
