import type { McpServer } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import * as z from 'zod'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bearerFromHeader, newBearerToken, verifyBearer } from '../auth/bearer.ts'
import { originAllowed } from '../auth/csrf.ts'
import { RateLimiter } from '../auth/rateLimit.ts'
import { createApiToken, deleteApiToken } from '../db/apiTokens.ts'
import { openDatabase, type Database } from '../db/index.ts'
import { createIntegration } from '../db/integrations.ts'
import { createAccount } from '../db/users.ts'
import { createLogger } from '../log.ts'
import { MCP_WWW_AUTHENTICATE, type McpCallContext } from './contract.ts'
import { SERVER_INSTRUCTIONS } from './tools.ts'
import { createMcpEndpoint, type McpEndpoint } from './endpoint.ts'

const T0 = new Date('2026-10-03T12:00:00.000Z')
const ACCEPT = 'application/json, text/event-stream'
const ORIGIN = 'http://urutau.test'

let database: Database
let endpoint: McpEndpoint
let app: Hono
let logs: string[]
let failures: RateLimiter
let clock: Date
let seen: { authorization: string | null; cookie: string | null; proxyAuthorization: string | null; clientId: string | undefined }[]
let release: (() => void) | null
let integrationId: string
let adminId: string

beforeEach(async () => {
  database = await openDatabase('sqlite::memory:')
  await database.migrate()
  clock = T0
  const admin = await createAccount(database.db, { username: 'admin', displayName: null, passwordHash: null, now: T0 })
  if (!admin.created) throw new Error('admin not created')
  adminId = admin.user.id
  integrationId = (await createIntegration(database.db, { username: 'planner-bot', createdBy: adminId, now: T0 })).id
  logs = []
  seen = []
  release = null
  failures = new RateLimiter(() => clock)
  endpoint = createMcpEndpoint({
    log: createLogger({ write: (line) => logs.push(line), now: () => T0 }),
    verifyBearer: (token) => verifyBearer(database.db, token, clock),
    failures,
    clientIp: (c) => c.req.header('x-test-ip') ?? '10.0.0.1',
    originAllowed: (origin, host) => originAllowed({ publicUrl: ORIGIN }, origin, host),
    registerTools: (server: McpServer, _call: McpCallContext) => {
      server.registerTool('echo', { description: 'Echo', inputSchema: z.object({ n: z.number().max(5) }) }, async ({ n }) => ({
        content: [{ type: 'text', text: `n=${n}` }],
      }))
      server.registerTool('headers', { description: 'Headers', inputSchema: z.object({}) }, async (_args, ctx) => {
        const headers = ctx.http?.req?.headers
        seen.push({
          authorization: headers?.get('authorization') ?? null,
          cookie: headers?.get('cookie') ?? null,
          proxyAuthorization: headers?.get('proxy-authorization') ?? null,
          clientId: ctx.http?.authInfo?.clientId,
        })
        return { content: [{ type: 'text', text: 'ok' }] }
      })
      server.registerTool('slow', { description: 'Waits for release', inputSchema: z.object({}) }, async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { content: [{ type: 'text', text: 'done' }] }
      })
    },
  })
  app = new Hono()
  app.route('/', endpoint.routes)
  app.notFound((c) => c.json({ error: 'not-found', message: 'There is nothing at this address.' }, 404))
})

afterEach(async () => {
  await endpoint.close()
  await database.close()
})

async function issue(expiresAt: Date | null = null) {
  const { secret, hash } = newBearerToken()
  const row = await createApiToken(database.db, { userId: integrationId, tokenHash: hash, label: 'laptop', createdBy: adminId, now: T0, expiresAt })
  return { secret, row }
}

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params })

const INIT = rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

function post(body: string, token: string | null, headers: Record<string, string> = {}) {
  return app.request('http://urutau.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body,
  })
}

/** The JSON-RPC messages of a text/event-stream answer. */
function frames(text: string): { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[]; protocolVersion?: string }; error?: { code: number } }[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
}

describe('authenticated calls', () => {
  test('initialize, notifications/initialized, tools/list and tools/call succeed', async () => {
    const { secret } = await issue()
    const init = await post(INIT, secret)
    expect(init.status).toBe(200)
    expect(init.headers.get('content-type')).toContain('text/event-stream')
    expect(frames(await init.text())[0].result?.protocolVersion).toBe('2025-11-25')

    const initialized = await post(rpc('notifications/initialized', {}, null), secret)
    expect(initialized.status).toBe(202)

    const list = await post(rpc('tools/list'), secret)
    expect(frames(await list.text())[0].result?.tools?.map((tool) => tool.name)).toContain('echo')

    const call = await post(rpc('tools/call', { name: 'echo', arguments: { n: 3 } }), secret)
    expect(call.status).toBe(200)
    expect(frames(await call.text())[0].result?.content?.[0].text).toBe('n=3')
  })

  test('answers a modern request with its envelope', async () => {
    const { secret } = await issue()
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    const res = await post(rpc('tools/call', { name: 'echo', arguments: { n: 2 }, _meta: meta }), secret, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'echo',
    })
    expect(res.status).toBe(200)
    expect(frames(await res.text())[0].result?.content?.[0].text).toBe('n=2')
  })

  test('a request without the full Accept header gets 406', async () => {
    const { secret } = await issue()
    const res = await post(INIT, secret, { accept: 'application/json' })
    expect(res.status).toBe(406)
  })

  test('an unknown tool gives -32602 and invalid arguments give an error result', async () => {
    const { secret } = await issue()
    const unknown = await post(rpc('tools/call', { name: 'nope', arguments: {} }), secret)
    expect(frames(await unknown.text())[0].error?.code).toBe(-32602)
    const invalid = await post(rpc('tools/call', { name: 'echo', arguments: { n: 9 } }), secret)
    expect(frames(await invalid.text())[0].result?.isError).toBe(true)
  })

  test('sends the response headers before a slow tool finishes', async () => {
    const { secret } = await issue()
    const res = await post(rpc('tools/call', { name: 'slow', arguments: {} }), secret)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(release).not.toBeNull()
    const body = res.text()
    release?.()
    expect(frames(await body).at(-1)?.result?.content?.[0].text).toBe('done')
  })

  test('the initialize answer carries the server instructions', async () => {
    const { secret } = await issue()
    const init = await post(INIT, secret)
    const message = frames(await init.text())[0].result as { instructions?: string } | undefined
    expect(message?.instructions).toBe(SERVER_INSTRUCTIONS)
  })

  test('sends the response headers of a modern request before a slow tool finishes', async () => {
    const { secret } = await issue()
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    const res = await post(rpc('tools/call', { name: 'slow', arguments: {}, _meta: meta }), secret, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'slow',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(release).not.toBeNull()
    const body = res.text()
    release?.()
    expect(frames(await body).at(-1)?.result?.content?.[0].text).toBe('done')
  })

  test('a tool sees no Authorization, Cookie or Proxy-Authorization header', async () => {
    const { secret } = await issue()
    const res = await post(rpc('tools/call', { name: 'headers', arguments: {} }), secret, {
      cookie: 'urutau_session=abc',
      'proxy-authorization': 'Basic eDp5',
    })
    await res.text()
    expect(seen).toEqual([{ authorization: null, cookie: null, proxyAuthorization: null, clientId: integrationId }])
  })
})

describe('authentication', () => {
  async function expectInvalid(res: Response) {
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('www-authenticate')).toBe(MCP_WWW_AUTHENTICATE)
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect(await res.json()).toMatchObject({ error: 'invalid-token' })
  }

  test('no token, a bad token, an expired token and a revoked token each give 401', async () => {
    await expectInvalid(await post(INIT, null))
    await expectInvalid(await post(INIT, 'urutau_mcp_' + 'A'.repeat(43)))
    await expectInvalid(await post(INIT, 'not-a-token'))
    const expired = await issue(new Date(T0.getTime() + 1000))
    clock = new Date(T0.getTime() + 2000)
    await expectInvalid(await post(INIT, expired.secret))
    clock = T0
    const revoked = await issue()
    await deleteApiToken(database.db, integrationId, revoked.row.id)
    await expectInvalid(await post(INIT, revoked.secret))
  })

  test('50 bad tokens from one address do not refuse a valid token from it', async () => {
    const { secret } = await issue()
    for (let i = 0; i < 50; i++) expect((await post(INIT, 'urutau_mcp_' + 'B'.repeat(43))).status).toBe(401)
    const refused = await post(INIT, 'urutau_mcp_' + 'B'.repeat(43))
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await refused.json()).toMatchObject({ error: 'too-many-attempts' })
    expect((await post(INIT, secret)).status).toBe(200)
  })

  test('another address is not limited by the first one failing', async () => {
    for (let i = 0; i < 50; i++) await post(INIT, null)
    expect((await post(INIT, null, { 'x-test-ip': '10.0.0.2' })).status).toBe(401)
  })
})

describe('refusals before the SDK', () => {
  test('any query string gives 400, before the token is looked at', async () => {
    const { secret } = await issue()
    for (const query of ['?token=x', '?', '?a=1&b=2']) {
      const res = await app.request(`http://urutau.test/mcp${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, accept: ACCEPT, 'content-type': 'application/json' },
        body: INIT,
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'query-not-allowed' })
    }
    const unauthenticated = await app.request('http://urutau.test/mcp?token=x', { method: 'POST', body: INIT })
    expect(unauthenticated.status).toBe(400)
  })

  test('GET and DELETE give 405 with Allow: POST', async () => {
    const { secret } = await issue()
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request('http://urutau.test/mcp', { method, headers: { authorization: `Bearer ${secret}`, accept: ACCEPT } })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
      expect(await res.json()).toMatchObject({ error: 'method-not-allowed' })
    }
  })

  test('a 2 MiB body gives 413', async () => {
    const { secret } = await issue()
    const big = rpc('tools/call', { name: 'echo', arguments: { n: 1, pad: 'x'.repeat(2 * 1024 * 1024) } })
    const res = await post(big, secret)
    expect(res.status).toBe(413)
  })

  test('another site as Origin, or a cross-site fetch, gives 403 without CORS headers', async () => {
    const { secret } = await issue()
    const foreign = await post(INIT, secret, { origin: 'http://evil.test' })
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toMatchObject({ error: 'origin-rejected' })
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
    const crossSite = await post(INIT, secret, { 'sec-fetch-site': 'cross-site' })
    expect(crossSite.status).toBe(403)
    expect((await post(INIT, secret, { origin: ORIGIN })).status).toBe(200)
    expect((await post(INIT, secret, { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  })

  test('other paths get the JSON 404, never HTML', async () => {
    for (const path of ['/mcp/', '/mcp/x', '/.well-known/oauth-protected-resource', '/register', '/authorize', '/token']) {
      const res = await app.request(`http://urutau.test${path}`, { method: 'POST', body: '{}' })
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    }
  })

  test('answers 503 after the endpoint is closed', async () => {
    const { secret } = await issue()
    await endpoint.close()
    const res = await post(INIT, secret)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'unavailable' })
  })
})

describe('logging', () => {
  test('the request line carries the integration id and no log line holds a token', async () => {
    const { secret } = await issue()
    await (await post(INIT, secret)).text()
    const bad = 'urutau_mcp_' + 'C'.repeat(43)
    await post(INIT, bad)
    await app.request(`http://urutau.test/mcp?token=${secret}`, { method: 'POST', body: INIT })
    const lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({ msg: 'request', method: 'POST', path: '/mcp', status: 200, user: integrationId })
    expect(lines[1]).toMatchObject({ status: 401, user: null })
    expect(lines[2]).toMatchObject({ status: 400 })
    const text = logs.join('\n')
    expect(text).not.toContain(secret)
    expect(text).not.toContain(bad)
    expect(text).not.toContain('urutau_mcp_')
  })

  test('a refused modern request logs the cell and never the header value', async () => {
    const { secret } = await issue()
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    const res = await post(rpc('tools/call', { name: 'echo', arguments: { n: 1 }, _meta: meta }), secret, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'secret-looking-value',
    })
    expect(res.status).toBe(400)
    await res.text()
    const text = logs.join('\n')
    expect(text).toContain('mcp request refused')
    expect(text).not.toContain('secret-looking-value')
  })
})

test('bearerFromHeader is what the endpoint uses to read the header', () => {
  const { secret } = newBearerToken()
  expect(bearerFromHeader(`bearer   ${secret}`)).toBe(secret)
})
