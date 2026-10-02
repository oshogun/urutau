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
import { authRoutes } from './routes/auth.ts'
import { boardsRoutes } from './routes/boards.ts'
import { invitesRoutes } from './routes/invites.ts'
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
  /** Receives one event per successful board write; a no-op until live updates are wired. */
  boardEvents: BoardEventPublisher
}

/** What every route factory receives: the dependencies plus per-process state. */
export interface AppContext extends AppDeps {
  limits: RateLimiter
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const ctx: AppContext = { ...deps, limits: new RateLimiter(deps.now) }
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
  // Registration point for the Keycloak sign-in routes (public per the route list in http/publicRoutes.ts).
  // Registration point for the GitHub proxy and the board event stream.

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

/** Deletes expired sessions and invites that expired more than 30 days ago. */
export async function purgeExpired(database: Database, now: Date): Promise<{ sessions: number; invites: number }> {
  const sessions = await deleteExpiredSessions(database.db, now)
  const result = await database.db
    .deleteFrom('invites')
    .where('expires_at', '<', new Date(now.getTime() - INVITE_RETENTION_MS).toISOString())
    .executeTakeFirst()
  return { sessions, invites: Number(result.numDeletedRows) }
}
