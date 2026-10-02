import type { Hono } from 'hono'
import { CSRF_HEADER, type BoardDeletedEvent, type BoardUpdatedEvent } from '../../src/domain/api.ts'
import { setPasswordCost } from '../auth/password.ts'
import { createApp, type AppDeps, type BoardEventPublisher } from '../app.ts'
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
  const app = createApp(deps)

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
    database,
    logs,
    events,
    hub,
    grants,
    clock,
    newClient,
    close: () => database.close(),
  } as TestApp
}
