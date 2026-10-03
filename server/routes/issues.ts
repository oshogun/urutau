import { Hono } from 'hono'
import type { CreateIssueResponse, GitHubRejectedError } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { getGithubWrites } from '../db/settings.ts'
import { accessError } from '../github/accessError.ts'
import { failureDetail, issuesPathFor, parseCreateIssue } from '../github/newIssue.ts'
import { readJson } from '../http/body.ts'
import { HttpError, invalidRequest } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'

const UPSTREAM = 'https://api.github.com/'

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'Error')

/** The body of a response as JSON, or null when it is empty, not JSON or cannot be read. */
async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function issuesRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()

  routes.post('/issues/:owner/:name', async (c) => {
    const auth = c.get('auth')
    if (!auth) throw new HttpError(401, 'signed-out', 'Sign in to continue.')
    if (auth.session.auth_method !== 'keycloak' || !ctx.keycloak?.brokersGitHub) {
      throw new HttpError(403, 'forbidden', 'This account creates issues from the browser.')
    }
    let on: boolean
    try {
      on = await getGithubWrites(ctx.database.db)
    } catch {
      throw new HttpError(503, 'unavailable', 'The server could not read its settings.')
    }
    if (!on) throw new HttpError(403, 'github-writes-off', 'The admin has not turned on creating issues on GitHub.')

    const path = issuesPathFor(c.req.param('owner'), c.req.param('name'))
    if (path === null) throw invalidRequest('The path must be a repository as owner/name.')
    const parsed = parseCreateIssue(await readJson(c))
    if (!parsed.ok) throw invalidRequest(parsed.message)
    const payload = JSON.stringify(parsed.value)

    const keycloak = ctx.keycloak
    const idHash = auth.session.id_hash
    /** A token for the next request. Nothing that could create the issue is out yet, so a throw is a 503. */
    async function token(fresh: boolean): Promise<string> {
      let result
      try {
        result = await keycloak.githubToken(idHash, fresh ? { fresh: true } : undefined)
      } catch (error) {
        ctx.log.warn('github create failed', { name: errorName(error) })
        throw new HttpError(503, 'unavailable', 'The server could not get your GitHub token. Nothing was created on GitHub.')
      }
      if (!result.ok) throw accessError(result.problem)
      return result.token
    }
    async function send(bearer: string): Promise<Response> {
      try {
        return await ctx.fetch(`${UPSTREAM}${path}`, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${bearer}`,
            'User-Agent': 'urutau',
            'Content-Type': 'application/json',
          },
          body: payload,
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        })
      } catch (error) {
        ctx.log.warn('github create failed', { name: errorName(error) })
        throw new HttpError(504, 'github-no-answer', 'GitHub did not answer. The issue may have been created.')
      }
    }

    let response = await send(await token(false))
    if (response.status === 401) {
      // GitHub refused the credentials and created nothing, so one resend with a fresh token cannot duplicate the issue.
      await response.body?.cancel().catch(() => undefined)
      response = await send(await token(true))
    }

    if (response.status >= 200 && response.status < 300) {
      const issue = await readBody(response)
      const number = typeof issue === 'object' && issue !== null && typeof (issue as { number?: unknown }).number === 'number' ? (issue as { number: number }).number : null
      ctx.log.info('issue created', { repo: `${c.req.param('owner')}/${c.req.param('name')}`, number, user: auth.user.id })
      const body: CreateIssueResponse = { issue }
      return c.json(body, 201)
    }
    const detail = failureDetail(response.status, response.headers, await readBody(response))
    const body: GitHubRejectedError = { error: 'github-rejected', message: 'GitHub refused the request.', github: detail }
    return c.json(body, 502)
  })

  return routes
}
