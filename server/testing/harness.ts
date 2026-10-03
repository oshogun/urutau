import type { Hono } from 'hono'
import { CSRF_HEADER, type BoardDeletedEvent, type BoardUpdatedEvent } from '../../src/domain/api.ts'
import { setPasswordCost } from '../auth/password.ts'
import { closeApp, createAppWithContext, type AppContext, type AppDeps, type BoardEventPublisher } from '../app.ts'
import { loadConfig, type Config } from '../config.ts'
import { createEventHub, type EventHub } from '../events/publisher.ts'
import { GrantStore } from '../oidc/grants.ts'
import { openDatabase, type Database } from '../db/index.ts'
import { createLogger } from '../log.ts'
import type { AppEnv } from '../http/types.ts'

export type PublishedEvent = { type: 'board-updated'; data: BoardUpdatedEvent } | { type: 'board-deleted'; data: BoardDeletedEvent }

export interface TestOverrides {
  config?: Partial<Config>
  /** Start time of the fixed clock. */
  start?: Date
  fetch?: typeof fetch
  /** bcrypt cost for this app's password hashes; low by default so tests stay fast under CPU contention. */
  passwordCost?: number
}

export const TEST_PASSWORD_COST = 4

/** The `Accept` header every MCP POST needs. */
export const MCP_ACCEPT = 'application/json, text/event-stream'

/** One tool call's answer, read from the event stream to its end. */
export interface ToolReply {
  isError: boolean
  /** The text of the first content block. */
  text: string
  structured: Record<string, any> | undefined
  /** The whole JSON-RPC message. */
  message: Record<string, any>
}

/** One agent: bearer-authenticated requests and no cookie jar. */
export interface BearerClient {
  readonly secret: string
  /** Any request to the app with the bearer in the Authorization header. */
  request(path: string, init?: RequestInit): Promise<Response>
  /** POST /mcp with a JSON-RPC body (an object is serialised). */
  mcp(body: unknown, headers?: Record<string, string>): Promise<Response>
  /** A JSON-RPC request; resolves with the first message of the answer. */
  rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>
  /** `tools/call`, read to the end of the answer. */
  tool(name: string, args?: Record<string, unknown>): Promise<ToolReply>
}

/** The JSON-RPC messages of a text/event-stream (or plain JSON) answer body. */
export function mcpMessages(text: string): Record<string, any>[] {
  const data = text.split('\n').filter((line) => line.startsWith('data:'))
  if (data.length === 0) {
    try {
      return [JSON.parse(text)]
    } catch {
      return []
    }
  }
  return data.map((line) => JSON.parse(line.slice(5)))
}

/** One browser: its own cookies and the CSRF token of its current session. */
export interface TestClient {
  request(path: string, init?: RequestInit): Promise<Response>
  /** A request with a JSON body and the CSRF header (the session's token once signed in, `1` before). */
  send(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
  get(path: string): Promise<Response>
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
  put(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
  delete(path: string, headers?: Record<string, string>): Promise<Response>
  /** Cookie name to value, as the browser would hold them. */
  readonly cookies: ReadonlyMap<string, string>
  csrfToken: string | null
}

export interface TestApp extends TestClient {
  app: Hono<AppEnv>
  deps: AppDeps
  /** What the routes received; its config has no TOKEN_ENCRYPTION_KEY. */
  ctx: AppContext
  database: Database
  /** Every log line written so far. */
  logs: string[]
  events: PublishedEvent[]
  /** The open event streams. */
  hub: EventHub
  /** The Keycloak grants held in memory. */
  grants: GrantStore
  clock: { now: Date; advance(ms: number): void }
  /** Another browser with its own cookie jar. */
  newClient(): TestClient
  /** An agent client that sends `secret` as a bearer token and holds no cookies. */
  bearerClient(secret: string): BearerClient
  close(): Promise<void>
}

function readCookies(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';')
    const index = pair.indexOf('=')
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    const cleared = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === ''
    if (cleared) jar.delete(name)
    else jar.set(name, value)
  }
}

export async function createTestApp(overrides: TestOverrides = {}): Promise<TestApp> {
  setPasswordCost(overrides.passwordCost ?? TEST_PASSWORD_COST)
  const database = await openDatabase('sqlite::memory:')
  await database.migrate()
  const config: Config = { ...loadConfig({}), databaseUrl: 'sqlite::memory:', ...overrides.config }
  const clock = {
    now: overrides.start ?? new Date('2026-10-02T12:00:00.000Z'),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms)
    },
  }
  const logs: string[] = []
  const events: PublishedEvent[] = []
  const boardEvents: BoardEventPublisher = { publish: (event) => void events.push(event) }
  const hub = createEventHub()
  const grants = new GrantStore()
  const deps: AppDeps = {
    config,
    database,
    log: createLogger({ write: (line) => void logs.push(line), now: () => clock.now }),
    now: () => clock.now,
    fetch:
      overrides.fetch ??
      (() => {
        throw new Error('unexpected fetch in a test')
      }),
    boardEvents,
    eventHub: hub,
    grants,
  }
  const { app, ctx } = createAppWithContext(deps)

  function newClient(): TestClient {
    const jar = new Map<string, string>()
    const client: TestClient = {
      cookies: jar,
      csrfToken: null,
      async request(path, init = {}) {
        const headers = new Headers(init.headers)
        if (jar.size > 0 && !headers.has('cookie')) {
          headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
        }
        const response = await app.request(path, { ...init, headers })
        readCookies(jar, response)
        return response
      },
      async send(method, path, body, headers = {}) {
        const init: RequestInit = {
          method,
          headers: { [CSRF_HEADER]: client.csrfToken ?? '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        }
        if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
        const response = await client.request(path, init)
        const text = await response.clone().text()
        try {
          const parsed = JSON.parse(text) as { csrfToken?: string; session?: { csrfToken?: string } }
          client.csrfToken = parsed.csrfToken ?? parsed.session?.csrfToken ?? client.csrfToken
        } catch {
          // Not JSON: nothing to learn from it.
        }
        return response
      },
      get: (path) => client.request(path),
      post: (path, body, headers) => client.send('POST', path, body, headers),
      put: (path, body, headers) => client.send('PUT', path, body, headers),
      delete: (path, headers) => client.send('DELETE', path, undefined, headers),
    }
    return client
  }

  function bearerClient(secret: string): BearerClient {
    const client: BearerClient = {
      secret,
      async request(path, init = {}) {
        const headers = new Headers(init.headers)
        headers.set('authorization', `Bearer ${secret}`)
        return app.request(path, { ...init, headers })
      },
      mcp(body, headers = {}) {
        return client.request('/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        })
      },
      async rpc(method, params = {}) {
        const response = await client.mcp({ jsonrpc: '2.0', id: 1, method, params })
        const [message] = mcpMessages(await response.text())
        return message ?? {}
      },
      async tool(name, args = {}) {
        const message = await client.rpc('tools/call', { name, arguments: args })
        const result = message.result ?? {}
        return {
          isError: result.isError === true,
          text: result.content?.[0]?.text ?? '',
          structured: result.structuredContent,
          message,
        }
      },
    }
    return client
  }

  const primary = newClient()
  return {
    ...primary,
    // The spread copies the getters' current values; keep one live object for the mutable csrfToken.
    get csrfToken() {
      return primary.csrfToken
    },
    set csrfToken(value) {
      primary.csrfToken = value
    },
    app,
    deps,
    ctx,
    database,
    logs,
    events,
    hub,
    grants,
    clock,
    newClient,
    bearerClient,
    close: async () => {
      await closeApp(app)
      await database.close()
    },
  } as TestApp
}

/** The GitHub token every through-app test stores; the format check accepts it and it is not a real token. */
export const FIXTURE_GITHUB_TOKEN = 'github_pat_urutau_fixture_not_a_real_token'

/** A TOKEN_ENCRYPTION_KEY value for tests that store GitHub tokens: a development key that protects nothing. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7)

export const ADMIN_CREDENTIALS = { username: 'admin', password: 'correct horse battery' }

export interface AgentSetup {
  /** The integration's account id. */
  id: string
  username: string
  tokenId: string
  /** The plain bearer token, as the admin saw it once. */
  secret: string
  bearer: BearerClient
}

export interface AgentOptions {
  username?: string
  /** Repositories the integration may read (owner/name). */
  repos?: string[]
  /** Store FIXTURE_GITHUB_TOKEN; needs the app created with TEST_ENCRYPTION_KEY. Default true. */
  githubToken?: boolean
}

/** Signs `client` in as the first-run admin (creating the account). */
export async function signInFirstAdmin(client: TestClient): Promise<void> {
  const response = await client.post('/api/auth/first-run', ADMIN_CREDENTIALS)
  if (response.status !== 201) throw new Error(`first-run answered ${response.status}`)
}

/** Through the admin API (as the signed-in admin `h`): creates an integration, a token, a repository list and a GitHub token. */
export async function setUpAgent(h: TestApp, options: AgentOptions = {}): Promise<AgentSetup> {
  const username = options.username ?? 'planner-bot'
  const created = await h.post('/api/integrations', { username })
  if (created.status !== 201) throw new Error(`creating the integration answered ${created.status}`)
  const id = ((await created.json()) as { integration: { id: string } }).integration.id
  const issued = await h.post(`/api/integrations/${id}/tokens`, { label: 'laptop', expiresInDays: 90 })
  if (issued.status !== 201) throw new Error(`issuing the token answered ${issued.status}`)
  const { token, secret } = (await issued.json()) as { token: { id: string }; secret: string }
  if ((await h.put(`/api/integrations/${id}/repos`, { repos: options.repos ?? [] })).status !== 200) throw new Error('setting the repositories failed')
  if (options.githubToken !== false) {
    const stored = await h.put(`/api/integrations/${id}/github-token`, { token: FIXTURE_GITHUB_TOKEN })
    if (stored.status !== 200) throw new Error(`storing the GitHub token answered ${stored.status}`)
  }
  return { id, username, tokenId: token.id, secret, bearer: h.bearerClient(secret) }
}
