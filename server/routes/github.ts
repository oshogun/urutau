import { Hono, type Context } from 'hono'
import type { AppContext } from '../app.ts'
import { accessError } from '../github/accessError.ts'
import { allowedGitHubPath } from '../github/allowlist.ts'
import { rewriteLinkHeader } from '../github/links.ts'
import { HttpError } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'

const UPSTREAM = 'https://api.github.com/'
const PREFIX = '/api/github/'
const COPIED_HEADERS = ['content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-used', 'retry-after']

/** The path and raw query string of a request URL, exactly as sent. */
function splitTarget(url: string): { path: string; query: string } {
  const afterOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
  const hash = afterOrigin.indexOf('#')
  const target = hash === -1 ? afterOrigin : afterOrigin.slice(0, hash)
  const queryStart = target.indexOf('?')
  return queryStart === -1 ? { path: target, query: '' } : { path: target.slice(0, queryStart), query: target.slice(queryStart + 1) }
}

export function githubRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()

  async function upstream(token: string, path: string, query: string): Promise<Response> {
    return ctx.fetch(`${UPSTREAM}${path}${query === '' ? '' : `?${query}`}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'urutau',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
  }

  const notGet = (c: Context<AppEnv>) =>
    c.json({ error: 'not-found', message: 'Only GET requests are answered here.' }, 405, { Allow: 'GET' })

  routes.get('/github/*', async (c) => {
    // Hono runs the GET handler for HEAD too; GitHub would answer a HEAD with the brokered token attached, so refuse it here.
    if (c.req.method !== 'GET') return notGet(c)
    const auth = c.get('auth')
    if (!auth) throw new HttpError(401, 'signed-out', 'Sign in to continue.')
    if (auth.session.auth_method !== 'keycloak' || !ctx.keycloak?.brokersGitHub) {
      throw new HttpError(403, 'forbidden', 'This account reads GitHub from the browser.')
    }
    const target = splitTarget(c.req.url)
    const rawPath = target.path.startsWith(PREFIX) ? target.path.slice(PREFIX.length) : ''
    const path = allowedGitHubPath(rawPath, target.query)
    if (path === null) throw new HttpError(404, 'github-path-not-allowed', 'This GitHub address is not available through the server.')

    const idHash = auth.session.id_hash
    let token = await ctx.keycloak.githubToken(idHash)
    if (!token.ok) throw accessError(token.problem)
    let response: Response
    try {
      response = await upstream(token.token, path, target.query)
      if (response.status === 401) {
        await response.body?.cancel()
        token = await ctx.keycloak.githubToken(idHash, { fresh: true })
        if (!token.ok) throw accessError(token.problem)
        response = await upstream(token.token, path, target.query)
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      ctx.log.warn('github request failed', { name: error instanceof Error ? error.name : 'Error' })
      throw new HttpError(503, 'unavailable', 'GitHub could not be reached.')
    }

    const headers = new Headers()
    for (const name of COPIED_HEADERS) {
      const value = response.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    const link = response.headers.get('link')
    const rewritten = link === null ? null : rewriteLinkHeader(link)
    if (rewritten !== null) headers.set('link', rewritten)
    return new Response(response.body, { status: response.status, headers })
  })

  routes.all('/github/*', notGet)

  return routes
}
