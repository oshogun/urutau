/** POST /mcp: origin, query and bearer checks, then the MCP SDK. */
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server'
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { bearerFromHeader } from '../auth/bearer.ts'
import type { Logger } from '../log.ts'
import {
  MCP_HTTP_ERROR_TEXT,
  MCP_SERVER_INFO,
  MCP_WWW_AUTHENTICATE,
  type McpCallContext,
  type McpHttpErrorCode,
  type McpPrincipal,
} from './contract.ts'
import { SERVER_INSTRUCTIONS } from './tools.ts'

export interface McpEndpointDeps {
  log: Logger
  /** Looks a well-formed token up; null when unknown, revoked or expired. */
  verifyBearer(token: string): Promise<McpPrincipal | null>
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
const MAX_REQUEST_BODY_BYTES = 1_048_576
const REFUSED_PREFIX = 'Rejected inbound request ('

/** A copy of the request without Authorization, Cookie and Proxy-Authorization. */
export function withoutCredentials(raw: Request): Request {
  const headers = new Headers(raw.headers)
  headers.delete('authorization')
  headers.delete('cookie')
  headers.delete('proxy-authorization')
  return new Request(raw, { headers, signal: raw.signal })
}

function errorResponse(status: ContentfulStatusCode, error: McpHttpErrorCode, headers: Record<string, string> = {}): Response {
  return Response.json({ error, message: MCP_HTTP_ERROR_TEXT[error] }, { status, headers })
}

export function createMcpEndpoint(deps: McpEndpointDeps): McpEndpoint {
  const { log } = deps
  const calls = new WeakMap<AuthInfo, McpCallContext>()
  const principals = new WeakMap<Request, McpPrincipal>()

  const handler = createMcpHandler(
    (ctx) => {
      const server = new McpServer(MCP_SERVER_INFO, {
        capabilities: { tools: { listChanged: false } },
        instructions: SERVER_INSTRUCTIONS,
      })
      const call = ctx.authInfo ? calls.get(ctx.authInfo) : undefined
      if (call) deps.registerTools(server, call)
      return server
    },
    {
      legacy: 'stateless',
      responseMode: 'sse',
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
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
      const site = c.req.header('sec-fetch-site')
      if (site !== undefined && site !== 'same-origin') {
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
    const principal = token === null ? null : await deps.verifyBearer(token)
    if (principal === null) {
      const ip = deps.clientIp(c)
      const wait = deps.failures.retryAfter(ip)
      if (wait !== null) {
        record(429)
        return errorResponse(429, 'too-many-attempts', { 'Retry-After': String(wait) })
      }
      deps.failures.recordFailure(ip)
      record(401)
      return errorResponse(401, 'invalid-token', { 'WWW-Authenticate': MCP_WWW_AUTHENTICATE })
    }
    user = principal.userId
    principals.set(c.req.raw, principal)

    await next()
    record(c.res.status)
  })

  routes.post('/mcp', async (c) => {
    const principal = principals.get(c.req.raw)
    if (!principal) return errorResponse(401, 'invalid-token', { 'WWW-Authenticate': MCP_WWW_AUTHENTICATE })
    const authInfo: AuthInfo = { token: VERIFIED_PLACEHOLDER, clientId: principal.userId, scopes: [] }
    calls.set(authInfo, { principal })
    try {
      return await handler.fetch(withoutCredentials(c.req.raw), { authInfo })
    } catch {
      return errorResponse(503, 'unavailable')
    }
  })

  routes.all('/mcp', () => errorResponse(405, 'method-not-allowed', { Allow: 'POST' }))

  return { routes, close: () => handler.close() }
}
