import { Hono } from 'hono'
import type { BoardDeletedEvent, BoardUpdatedEvent } from '../src/domain/api.ts'
import { csrfGuard } from './auth/csrf.ts'
import { RateLimiter } from './auth/rateLimit.ts'
import { loadSession, requireUser } from './auth/sessions.ts'
import type { Config } from './config.ts'
import type { Database } from './db/index.ts'
import { deleteExpiredSessions } from './db/sessions.ts'
import { limitBodies } from './http/body.ts'
import { HttpError } from './http/errors.ts'
import { hostGuard } from './http/hostGuard.ts'
import { requestLog, securityHeaders } from './http/middleware.ts'
import type { AppEnv } from './http/types.ts'
import { urlSecrets, type Logger } from './log.ts'
import { createEventHub, normalizeClientId, type EventHub } from './events/publisher.ts'
import { GrantStore } from './oidc/grants.ts'
import { createKeycloak, type Keycloak } from './oidc/keycloak.ts'
import { authRoutes } from './routes/auth.ts'
import { boardsRoutes } from './routes/boards.ts'
import { eventsRoutes } from './routes/events.ts'
import { githubRoutes } from './routes/github.ts'
import { invitesRoutes } from './routes/invites.ts'
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

/** What every route factory receives: the dependencies plus per-process state. */
export interface AppContext extends Omit<AppDeps, 'boardEvents' | 'eventHub' | 'grants'> {
  limits: RateLimiter
  hub: EventHub
  /** Publishes to the event streams and to `AppDeps.boardEvents`. */
  boardEvents: BoardEventPublisher
  /** Keycloak tokens of the signed-in sessions, in memory only. */
  grants: GrantStore
  /** The Keycloak client; null when Keycloak is not configured. */
  keycloak: Keycloak | null
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
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
  const ctx: AppContext = { ...deps, limits: new RateLimiter(deps.now), hub, boardEvents, grants, keycloak }
  const app = new Hono<AppEnv>()

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

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/') || c.req.path === '/api') {
      return c.json({ error: 'not-found', message: 'There is nothing at this address.' }, 404)
    }
    return c.text('Not found', 404)
  })

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.code, message: error.message, ...error.extra }, error.status, error.headers)
    }
    ctx.log.error('unhandled error', { name: error.name, message: error.message })
    return c.json({ error: 'server-error', message: 'Something went wrong on the server.' }, 500)
  })

  return app
}

/** Strings the logger must remove from every line: the database URL and its password, and the Keycloak client secret. */
export function serverSecrets(config: Config): string[] {
  return [...urlSecrets(config.databaseUrl), ...(config.keycloak ? [config.keycloak.clientSecret] : [])]
}

const INVITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Deletes expired sessions and invites that expired more than 30 days ago.
 * Given the grant store, it also drops the Keycloak grant of every session it deleted.
 */
export async function purgeExpired(
  database: Database,
  now: Date,
  grants?: GrantStore,
): Promise<{ sessions: number; invites: number }> {
  const expired = grants
    ? await database.db.selectFrom('sessions').select('id_hash').where('expires_at', '<=', now.toISOString()).execute()
    : []
  const sessions = await deleteExpiredSessions(database.db, now)
  for (const { id_hash: idHash } of expired) grants?.delete(idHash)
  const result = await database.db
    .deleteFrom('invites')
    .where('expires_at', '<', new Date(now.getTime() - INVITE_RETENTION_MS).toISOString())
    .executeTakeFirst()
  return { sessions, invites: Number(result.numDeletedRows) }
}
