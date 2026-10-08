import { Hono } from 'hono'
import type { BoardDeletedEvent, BoardUpdatedEvent } from '../src/domain/api.ts'
import { verifyBearer } from './auth/bearer.ts'
import { csrfGuard, originAllowed } from './auth/csrf.ts'
import { RateLimiter } from './auth/rateLimit.ts'
import { createSecretBox, type SecretSealer } from './auth/secretBox.ts'
import { loadSession, requireUser } from './auth/sessions.ts'
import { saveAndPublish } from './boards/save.ts'
import type { Config } from './config.ts'
import { apiTokenIsLive, deleteExpiredApiTokens } from './db/apiTokens.ts'
import { getBoard, listBoardsByKeys } from './db/boards.ts'
import type { Database } from './db/index.ts'
import { listIntegrationRepos } from './db/integrationRepos.ts'
import { deleteExpiredSessions } from './db/sessions.ts'
import { createGitHubReader, type GitHubReader } from './github/reader.ts'
import { limitBodies } from './http/body.ts'
import { HttpError } from './http/errors.ts'
import { hostGuard } from './http/hostGuard.ts'
import { clientIp } from './http/ip.ts'
import { requestLog, securityHeaders } from './http/middleware.ts'
import { isJsonPath } from './http/paths.ts'
import type { AppEnv } from './http/types.ts'
import { urlSecrets, type Logger } from './log.ts'
import { createEventHub, normalizeClientId, type EventHub } from './events/publisher.ts'
import type { CallLimiter, InflightRegistry, SnapshotProvider, ToolDeps } from './mcp/contract.ts'
import { createMcpEndpoint, type McpEndpoint } from './mcp/endpoint.ts'
import { createInflightRegistry } from './mcp/inflight.ts'
import { createCallLimiter, createRepoLocks } from './mcp/locks.ts'
import { createSnapshotCache } from './mcp/snapshots.ts'
import { registerTools } from './mcp/tools.ts'
import { GrantStore } from './oidc/grants.ts'
import { createRunStore } from './runs/store.ts'
import { createKeycloak, type Keycloak } from './oidc/keycloak.ts'
import { authRoutes } from './routes/auth.ts'
import { boardsRoutes } from './routes/boards.ts'
import { eventsRoutes } from './routes/events.ts'
import { githubRoutes } from './routes/github.ts'
import { invitesRoutes } from './routes/invites.ts'
import { integrationsRoutes } from './routes/integrations.ts'
import { issuesRoutes } from './routes/issues.ts'
import { oidcRoutes } from './routes/oidc.ts'
import { settingsRoutes } from './routes/settings.ts'
import { usersRoutes } from './routes/users.ts'

export interface BoardEventPublisher {
  publish(event: { type: 'board-updated'; data: BoardUpdatedEvent } | { type: 'board-deleted'; data: BoardDeletedEvent }): void
}

export interface AppDeps {
  config: Config
  database: Database
  log: Logger
  /** Injected so tests control time. */
  now: () => Date
  /** Injected so tests stub Keycloak and GitHub; production passes globalThis.fetch. */
  fetch: typeof fetch
  /** An extra receiver of every board event, besides the event streams; tests use it to record them. */
  boardEvents?: BoardEventPublisher
  /** The open event streams; created by `createApp` when not given. */
  eventHub?: EventHub
  /** The Keycloak grants; created by `createApp` when not given, and passed by tests that inspect or drop them. */
  grants?: GrantStore
}

/** The configuration without TOKEN_ENCRYPTION_KEY: route code and middleware never see the key. */
export type PublicConfig = Omit<Config, 'tokenEncryptionKey'>

/** Per-process MCP state the admin routes act on. */
export interface McpRuntime {
  inflight: InflightRegistry
  snapshots: SnapshotProvider
  reader: Pick<GitHubReader, 'tokenState' | 'forget'>
  limits: CallLimiter
  endpoint: McpEndpoint
}

/** What every route factory receives: the dependencies plus per-process state. */
export interface AppContext extends Omit<AppDeps, 'boardEvents' | 'eventHub' | 'grants' | 'config'> {
  config: PublicConfig
  limits: RateLimiter
  hub: EventHub
  /** Publishes to the event streams and to `AppDeps.boardEvents`. */
  boardEvents: BoardEventPublisher
  /** Keycloak tokens of the signed-in sessions, in memory only. */
  grants: GrantStore
  /** The Keycloak client; null when Keycloak is not configured. */
  keycloak: Keycloak | null
  /** null when TOKEN_ENCRYPTION_KEY is not set. */
  githubTokenSealer: SecretSealer | null
  mcp: McpRuntime
}

const closers = new WeakMap<Hono<AppEnv>, () => Promise<void>>()

/** Closes what createApp opened that outlives requests (the MCP SDK handler). */
export async function closeApp(app: Hono<AppEnv>): Promise<void> {
  await closers.get(app)?.()
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  return createAppWithContext(deps).app
}

/** createApp, also returning the context the routes received. */
export function createAppWithContext(deps: AppDeps): { app: Hono<AppEnv>; ctx: AppContext } {
  const hub = deps.eventHub ?? createEventHub()
  const boardEvents: BoardEventPublisher = {
    publish(event) {
      // The client id comes from a request header and goes to every subscriber, so only a short plain id passes.
      const clean = { ...event, data: { ...event.data, clientId: normalizeClientId(event.data.clientId) } } as typeof event
      hub.publish(clean)
      deps.boardEvents?.publish(clean)
    },
  }
  const grants = deps.grants ?? new GrantStore()
  hub.onSessionEnd((sessionIdHash) => grants.delete(sessionIdHash))
  const keycloak =
    deps.config.keycloak !== null && deps.config.publicUrl !== null
      ? createKeycloak({ config: deps.config.keycloak, publicUrl: deps.config.publicUrl, fetch: deps.fetch, now: deps.now, log: deps.log, grants })
      : null
  const { tokenEncryptionKey, ...config } = deps.config
  const db = deps.database.db
  const box = tokenEncryptionKey ? createSecretBox(tokenEncryptionKey) : null
  const reader = createGitHubReader({ db, fetch: deps.fetch, now: deps.now, log: deps.log, opener: box?.opener ?? null })
  const snapshots = createSnapshotCache({ fetchSnapshot: reader.fetchSnapshot, now: deps.now })
  const inflight = createInflightRegistry()
  const callLimits = createCallLimiter(deps.now)
  const toolDeps: ToolDeps = {
    log: deps.log,
    now: deps.now,
    boards: { get: (key) => getBoard(db, key), summaries: (keys) => listBoardsByKeys(db, keys) },
    allowedRepos: async (userId) => new Set(await listIntegrationRepos(db, userId)),
    tokenState: (userId) => reader.tokenState(userId),
    tokenIsLive: (tokenId) => apiTokenIsLive(db, tokenId, deps.now()),
    snapshots,
    save: (request) => saveAndPublish({ db, now: deps.now, boardEvents }, request),
    locks: createRepoLocks(),
    limits: callLimits,
    inflight,
    runs: createRunStore(db),
    // Card activity goes to the open streams only: the extra receiver in AppDeps.boardEvents records board saves and deletions.
    publishCardActivity: (event) =>
      hub.publish({ type: 'card-activity', data: { ...event, clientId: normalizeClientId(event.clientId) } }),
  }
  const bearerFailures = new RateLimiter(deps.now)
  const endpoint = createMcpEndpoint({
    log: deps.log,
    verifyBearer: (token) => verifyBearer(db, token, deps.now()),
    failures: bearerFailures,
    clientIp: (c) => clientIp(c, config.trustProxy),
    originAllowed: (origin, host) => originAllowed(config, origin, host),
    registerTools: (server, call) => registerTools(server, call, toolDeps),
  })
  const ctx: AppContext = {
    ...deps,
    config,
    limits: new RateLimiter(deps.now),
    hub,
    boardEvents,
    grants,
    keycloak,
    githubTokenSealer: box?.sealer ?? null,
    mcp: { inflight, snapshots, reader, limits: callLimits, endpoint },
  }
  const app = new Hono<AppEnv>()
  closers.set(app, () => endpoint.close())

  app.use('*', securityHeaders())
  app.use('/api/*', requestLog(ctx.log))
  app.use('*', hostGuard(ctx))
  app.use('/api/*', loadSession(ctx))
  app.use('/api/*', csrfGuard(ctx))
  app.use('/api/*', requireUser)
  app.use('/api/*', limitBodies())

  app.route('/api', authRoutes(ctx))
  app.route('/api', usersRoutes(ctx))
  app.route('/api', invitesRoutes(ctx))
  app.route('/api', boardsRoutes(ctx))
  app.route('/api', eventsRoutes(ctx))
  app.route('/api', oidcRoutes(ctx))
  app.route('/api', githubRoutes(ctx))
  app.route('/api', settingsRoutes(ctx))
  app.route('/api', issuesRoutes(ctx))
  app.route('/api', integrationsRoutes(ctx))
  app.route('/', endpoint.routes)

  app.notFound((c) => {
    if (isJsonPath(c.req.path)) {
      return c.json({ error: 'not-found', message: 'There is nothing at this address.' }, 404)
    }
    return c.text('Not found', 404)
  })

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.code, message: error.message, ...error.extra }, error.status, error.headers)
    }
    // A database driver's message can quote the connection URL or values, so the agent endpoint logs the error name only.
    ctx.log.error('unhandled error', c.req.path === '/mcp' ? { name: error.name } : { name: error.name, message: error.message })
    return c.json({ error: 'server-error', message: 'Something went wrong on the server.' }, 500)
  })

  return { app, ctx }
}

/** Strings the logger must remove from every line: the database URL and its password, the Keycloak client secret and the token encryption key. */
export function serverSecrets(config: Config): string[] {
  return [
    ...urlSecrets(config.databaseUrl),
    ...(config.keycloak ? [config.keycloak.clientSecret] : []),
    ...(config.tokenEncryptionKey ? [config.tokenEncryptionKey.toString('base64')] : []),
  ]
}

const INVITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Deletes expired sessions, expired API tokens and invites that expired more than 30 days ago.
 * Given the grant store, it also drops the Keycloak grant of every session it deleted.
 */
export async function purgeExpired(
  database: Database,
  now: Date,
  grants?: GrantStore,
): Promise<{ sessions: number; invites: number; apiTokens: number }> {
  const expired = grants
    ? await database.db.selectFrom('sessions').select('id_hash').where('expires_at', '<=', now.toISOString()).execute()
    : []
  const sessions = await deleteExpiredSessions(database.db, now)
  for (const { id_hash: idHash } of expired) grants?.delete(idHash)
  const result = await database.db
    .deleteFrom('invites')
    .where('expires_at', '<', new Date(now.getTime() - INVITE_RETENTION_MS).toISOString())
    .executeTakeFirst()
  const apiTokens = await deleteExpiredApiTokens(database.db, now)
  return { sessions, invites: Number(result.numDeletedRows), apiTokens }
}
