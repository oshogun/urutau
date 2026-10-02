import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthMethod, GitHubAccess, Session } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { createSession, deleteSession, getSession, touchSession } from '../db/sessions.ts'
import { getUserById, type UserRow } from '../db/users.ts'
import { HttpError } from '../http/errors.ts'
import { isPublicRoute } from '../http/publicRoutes.ts'
import type { AppEnv } from '../http/types.ts'
import type { Grant } from '../oidc/grants.ts'
import { randomToken, sha256Hex } from './tokens.ts'

export const SESSION_COOKIE = 'urutau_session'
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const REFRESH_AFTER_MS = 60 * 60 * 1000

function writeCookie(ctx: AppContext, c: Context, id: string): void {
  setCookie(c, SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: ctx.config.secureCookies,
    maxAge: LIFETIME_MS / 1000,
  })
}

export function clearSessionCookie(ctx: AppContext, c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: ctx.config.secureCookies })
}

/**
 * How the browser should read GitHub. A Keycloak user whose broker answered (or
 * has not been asked yet) goes through the server; one whose grant is gone or
 * whose broker refused falls back to the browser with the reason. Local users,
 * and Keycloak users when no GitHub identity provider is configured, read
 * GitHub from the browser with nothing to report.
 */
export function githubAccessFor(ctx: AppContext, authMethod: AuthMethod, sessionIdHash: string): GitHubAccess {
  if (authMethod !== 'keycloak' || !ctx.keycloak?.brokersGitHub) return { mode: 'browser', problem: null }
  const grant = ctx.grants.get(sessionIdHash)
  if (!grant) return { mode: 'browser', problem: 'signin-expired' }
  if (grant.broker === 'not-linked' || grant.broker === 'refused') return { mode: 'browser', problem: grant.broker }
  return { mode: 'server' }
}

/** The response body for a signed-in session. */
export function toSession(user: UserRow, authMethod: AuthMethod, csrfToken: string, githubAccess: GitHubAccess): Session {
  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      isAdmin: user.is_admin === 1,
      authMethod,
    },
    csrfToken,
    githubAccess,
  }
}

/**
 * Starts a session for the user and sets its cookie. A session cookie the
 * request already carried is deleted first, so signing in never leaves the
 * previous session usable. A Keycloak sign-in passes its grant, kept in memory
 * under the new session.
 */
export async function startSession(
  ctx: AppContext,
  c: Context,
  user: UserRow,
  authMethod: AuthMethod,
  grant?: Grant,
): Promise<Session> {
  return (await startSessionWithId(ctx, c, user, authMethod, grant)).session
}

/** Like `startSession`, and also returns the hash of the new session id, the key of its Keycloak grant. */
export async function startSessionWithId(
  ctx: AppContext,
  c: Context,
  user: UserRow,
  authMethod: AuthMethod,
  grant?: Grant,
): Promise<{ session: Session; idHash: string }> {
  const previous = getCookie(c, SESSION_COOKIE)
  if (previous) {
    await deleteSession(ctx.database.db, sha256Hex(previous))
    ctx.grants.delete(sha256Hex(previous))
  }
  const id = randomToken()
  const csrfToken = randomToken()
  const now = ctx.now()
  await createSession(ctx.database.db, {
    idHash: sha256Hex(id),
    userId: user.id,
    authMethod,
    csrfToken,
    now,
    expiresAt: new Date(now.getTime() + LIFETIME_MS),
  })
  if (grant) ctx.grants.set(sha256Hex(id), grant, now.getTime())
  writeCookie(ctx, c, id)
  const idHash = sha256Hex(id)
  return { session: toSession(user, authMethod, csrfToken, githubAccessFor(ctx, authMethod, idHash)), idHash }
}

/**
 * Looks the session cookie up and puts `auth` on the context (null when there
 * is none or it is no longer valid, in which case the cookie is cleared). A
 * session not seen for an hour gets its expiry pushed out and its cookie re-sent.
 */
export function loadSession(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = getCookie(c, SESSION_COOKIE)
    let auth: AppEnv['Variables']['auth'] = null
    if (id) {
      const db = ctx.database.db
      const idHash = sha256Hex(id)
      const now = ctx.now()
      const session = await getSession(db, idHash, now)
      const user = session ? await getUserById(db, session.user_id) : null
      if (session && user) {
        auth = { user, session }
        if (now.getTime() - Date.parse(session.last_seen_at) > REFRESH_AFTER_MS) {
          await touchSession(db, idHash, now, new Date(now.getTime() + LIFETIME_MS))
          writeCookie(ctx, c, id)
        }
      } else {
        ctx.grants.delete(idHash)
        clearSessionCookie(ctx, c)
      }
    }
    c.set('auth', auth)
    await next()
  }
}

/** 401 `signed-out` for every route not on the public list. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('auth') && !isPublicRoute(c.req.method, c.req.path)) {
    throw new HttpError(401, 'signed-out', 'Sign in to continue.')
  }
  await next()
}

/** 403 `forbidden` unless the signed-in user is the admin. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth')
  if (!auth) throw new HttpError(401, 'signed-out', 'Sign in to continue.')
  if (auth.user.is_admin !== 1) throw new HttpError(403, 'forbidden', 'Only the admin can do this.')
  await next()
}
