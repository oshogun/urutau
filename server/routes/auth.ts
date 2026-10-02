import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { sql } from 'kysely'
import type { AppConfigResponse, CredentialsRequest, SessionResponse, SignOutResponse } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { hashPassword, validatePassword, validateUsername, verifyPassword } from '../auth/password.ts'
import { clearSessionCookie, githubAccessFor, SESSION_COOKIE, startSession, toSession } from '../auth/sessions.ts'
import { sha256Hex } from '../auth/tokens.ts'
import { deleteSession } from '../db/sessions.ts'
import { createAccount, getUserByUsername, isFirstRun } from '../db/users.ts'
import { HttpError, invalidRequest } from '../http/errors.ts'
import { isRecord, readJson } from '../http/body.ts'
import { clientIp } from '../http/ip.ts'
import type { AppEnv } from '../http/types.ts'

const MAX_FIELD = 1000

export function parseCredentials(body: unknown): CredentialsRequest {
  if (!isRecord(body) || typeof body.username !== 'string' || typeof body.password !== 'string') {
    throw invalidRequest('A username and a password are required.')
  }
  if (body.username.length > MAX_FIELD || body.password.length > MAX_FIELD) throw invalidRequest('The username or password is too long.')
  return { username: body.username, password: body.password }
}

export function tooManyAttempts(retryAfter: number): HttpError {
  return new HttpError(429, 'too-many-attempts', 'Too many attempts. Try again later.', {
    headers: { 'Retry-After': String(retryAfter) },
  })
}

/** Throws 429 when this IP (or this IP and username) is over its failure limit. */
export function guardAttempts(ctx: AppContext, ip: string, key?: string): void {
  const retryAfter = ctx.limits.retryAfter(ip, key)
  if (retryAfter !== null) throw tooManyAttempts(retryAfter)
}

export function authRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()

  routes.get('/health', async (c) => {
    try {
      await sql`select 1`.execute(ctx.database.db)
      return c.json({ ok: true })
    } catch {
      return c.json({ ok: false }, 503)
    }
  })

  routes.get('/config', async (c) => {
    const row = await ctx.database.db.selectFrom('meta').select('value').where('key', '=', 'instance_id').executeTakeFirst()
    const body: AppConfigResponse = { keycloak: { enabled: ctx.config.keycloak !== null }, instanceId: row?.value ?? '' }
    return c.json(body)
  })

  routes.get('/session', async (c) => {
    const auth = c.get('auth')
    const body: SessionResponse = auth
      ? {
          signedIn: true,
          session: toSession(
            auth.user,
            auth.session.auth_method,
            auth.session.csrf_token,
            githubAccessFor(ctx, auth.session.auth_method, auth.session.id_hash),
          ),
        }
      : { signedIn: false, firstRun: await isFirstRun(ctx.database.db) }
    return c.json(body)
  })

  routes.post('/auth/first-run', async (c) => {
    const ip = clientIp(c, ctx.config.trustProxy)
    guardAttempts(ctx, ip)
    const { username, password } = parseCredentials(await readJson(c))
    validateUsername(username)
    validatePassword(password)
    const passwordHash = await hashPassword(password)
    const result = await createAccount(
      ctx.database.db,
      { username, displayName: null, passwordHash, now: ctx.now() },
      { onlyIfFirst: true },
    )
    if (!result.created) {
      ctx.limits.recordFailure(ip)
      throw new HttpError(409, 'already-set-up', 'This instance already has an admin account.')
    }
    return c.json(await startSession(ctx, c, result.user, 'local'), 201)
  })

  routes.post('/auth/sign-in', async (c) => {
    const ip = clientIp(c, ctx.config.trustProxy)
    const { username, password } = parseCredentials(await readJson(c))
    const key = `${ip}|${username.toLowerCase()}`
    guardAttempts(ctx, ip, key)
    const user = await getUserByUsername(ctx.database.db, username)
    if (!(await verifyPassword(password, user?.password_hash ?? null)) || !user) {
      ctx.limits.recordFailure(ip, key)
      throw new HttpError(401, 'invalid-credentials', 'The username or password is wrong.')
    }
    ctx.limits.recordSuccess(key)
    return c.json(await startSession(ctx, c, user, 'local'))
  })

  routes.post('/auth/sign-out', async (c) => {
    const id = getCookie(c, SESSION_COOKIE)
    let redirectTo: string | null = null
    if (id) {
      const idHash = sha256Hex(id)
      const auth = c.get('auth')
      // The id token is needed for the Keycloak end-session URL, so read it before the grant is dropped.
      const idToken = ctx.grants.get(idHash)?.idToken ?? null
      await deleteSession(ctx.database.db, idHash)
      ctx.hub.closeSession(idHash)
      clearSessionCookie(ctx, c)
      if (auth?.session.auth_method === 'keycloak' && ctx.keycloak) redirectTo = await ctx.keycloak.endSessionUrl(idToken)
    }
    const body: SignOutResponse = { redirectTo }
    return c.json(body)
  })

  return routes
}
