import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppContext } from '../app.ts'
import { startSessionWithId } from '../auth/sessions.ts'
import { HttpError } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'
import { findOrCreateKeycloakUser } from '../oidc/accounts.ts'
import { LOGIN_COOKIE, LOGIN_COOKIE_MAX_AGE_S, LOGIN_COOKIE_PATH, type SignInError } from '../oidc/keycloak.ts'

function disabled(): HttpError {
  return new HttpError(404, 'keycloak-disabled', 'Keycloak sign-in is not set up on this server.')
}

export function oidcRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()
  const home = `${ctx.config.publicUrl ?? ''}/`
  const failure = (error: SignInError) => `${ctx.config.publicUrl ?? ''}/?signin-error=${error}`

  routes.get('/auth/keycloak/start', async (c) => {
    if (!ctx.keycloak) throw disabled()
    const login = await ctx.keycloak.beginLogin()
    if (login === null) return c.redirect(failure('keycloak-unavailable'), 302)
    setCookie(c, LOGIN_COOKIE, login.loginId, {
      path: LOGIN_COOKIE_PATH,
      httpOnly: true,
      sameSite: 'Lax',
      secure: ctx.config.secureCookies,
      maxAge: LOGIN_COOKIE_MAX_AGE_S,
    })
    return c.redirect(login.location, 302)
  })

  routes.get('/auth/keycloak/callback', async (c) => {
    if (!ctx.keycloak) throw disabled()
    const loginId = getCookie(c, LOGIN_COOKIE)
    deleteCookie(c, LOGIN_COOKIE, { path: LOGIN_COOKIE_PATH, secure: ctx.config.secureCookies })
    const rawUrl = c.req.url
    const queryStart = rawUrl.indexOf('?')
    const search = queryStart === -1 ? '' : rawUrl.slice(queryStart)
    const finished = await ctx.keycloak.finishLogin(loginId, search)
    if (!finished.ok) return c.redirect(failure(finished.error), 302)

    let idHash: string
    try {
      const user = await findOrCreateKeycloakUser(ctx.database.db, finished.claims, ctx.now())
      idHash = (await startSessionWithId(ctx, c, user, 'keycloak', finished.grant)).idHash
    } catch (error) {
      ctx.log.error('keycloak account creation failed', { name: error instanceof Error ? error.name : 'Error' })
      return c.redirect(failure('keycloak-failed'), 302)
    }
    // Ask the broker once now so the session starts with the right GitHub access recorded.
    if (ctx.keycloak.brokersGitHub) await ctx.keycloak.githubToken(idHash)
    return c.redirect(home, 302)
  })

  return routes
}
