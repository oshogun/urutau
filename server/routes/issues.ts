import { Hono, type Context } from 'hono'
import type {
  CreateIssueResponse,
  GitHubRejectedError,
  IssueUpdateRejectedError,
  StaleIssueResponse,
  UpdateIssueResponse,
} from '../../src/domain/api.ts'
import { parseUpdateIssueRequest, sameUpdatedAt } from '../../src/domain/issueUpdate.ts'
import type { AppContext } from '../app.ts'
import { getGithubWrites } from '../db/settings.ts'
import { accessError } from '../github/accessError.ts'
import { failureDetail, issuesPathFor, parseCreateIssue } from '../github/newIssue.ts'
import { checkedIssue, issuePathFor } from '../github/updateIssue.ts'
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

/** The words that differ between creating an issue and changing one, in the messages and log lines the two routes share. */
interface WriteWording {
  doing: string
  gerund: string
  past: string
  logLine: string
}
const CREATE_WORDING: WriteWording = { doing: 'creates', gerund: 'creating', past: 'created', logLine: 'github create failed' }
const UPDATE_WORDING: WriteWording = { doing: 'changes', gerund: 'changing', past: 'changed', logLine: 'github update failed' }

/** The headers of a request to GitHub made with the signed-in user's token. */
function githubHeaders(bearer: string, json: boolean): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${bearer}`,
    'User-Agent': 'urutau',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

export function issuesRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()

  /**
   * The checks both write routes start with: the user is signed in with a Keycloak account whose
   * realm brokers GitHub, and the admin has turned GitHub writes on. Returns what the route needs next.
   */
  async function requireWriter(c: Context<AppEnv>, wording: WriteWording) {
    const auth = c.get('auth')
    if (!auth) throw new HttpError(401, 'signed-out', 'Sign in to continue.')
    const keycloak = ctx.keycloak
    if (auth.session.auth_method !== 'keycloak' || !keycloak?.brokersGitHub) {
      throw new HttpError(403, 'forbidden', `This account ${wording.doing} issues from the browser.`)
    }
    let on: boolean
    try {
      on = await getGithubWrites(ctx.database.db)
    } catch {
      throw new HttpError(503, 'unavailable', 'The server could not read its settings.')
    }
    if (!on) throw new HttpError(403, 'github-writes-off', `The admin has not turned on ${wording.gerund} issues on GitHub.`)
    return { auth, keycloak, idHash: auth.session.id_hash }
  }

  /**
   * Returns a function that gets a token for the next request. Nothing that could write to GitHub
   * is out yet when it throws, so a failure is a 503.
   */
  function tokenSource(keycloak: NonNullable<AppContext['keycloak']>, idHash: string, wording: WriteWording) {
    return async (fresh: boolean): Promise<string> => {
      let result
      try {
        result = await keycloak.githubToken(idHash, fresh ? { fresh: true } : undefined)
      } catch (error) {
        ctx.log.warn(wording.logLine, { name: errorName(error) })
        throw new HttpError(503, 'unavailable', `The server could not get your GitHub token. Nothing was ${wording.past} on GitHub.`)
      }
      if (!result.ok) throw accessError(result.problem)
      return result.token
    }
  }

  /** The 502 answer for a GitHub response that refused the request; `step` is set by the route that has two steps. */
  async function githubRejected(c: Context<AppEnv>, response: Response, step?: 'check' | 'write') {
    const detail = failureDetail(response.status, response.headers, await readBody(response))
    const body: GitHubRejectedError | IssueUpdateRejectedError = {
      error: 'github-rejected',
      message: 'GitHub refused the request.',
      github: detail,
      ...(step ? { step } : {}),
    }
    return c.json(body, 502)
  }

  routes.post('/issues/:owner/:name', async (c) => {
    const { auth, keycloak, idHash } = await requireWriter(c, CREATE_WORDING)

    const path = issuesPathFor(c.req.param('owner'), c.req.param('name'))
    if (path === null) throw invalidRequest('The path must be a repository as owner/name.')
    const parsed = parseCreateIssue(await readJson(c))
    if (!parsed.ok) throw invalidRequest(parsed.message)
    const payload = JSON.stringify(parsed.value)

    const token = tokenSource(keycloak, idHash, CREATE_WORDING)
    async function send(bearer: string): Promise<Response> {
      try {
        return await ctx.fetch(`${UPSTREAM}${path}`, {
          method: 'POST',
          headers: githubHeaders(bearer, true),
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
    return githubRejected(c, response)
  })

  routes.patch('/issues/:owner/:name/:number', async (c) => {
    const { auth, keycloak, idHash } = await requireWriter(c, UPDATE_WORDING)

    const path = issuePathFor(c.req.param('owner'), c.req.param('name'), c.req.param('number'))
    if (path === null) throw invalidRequest('The path must be a repository as owner/name and an issue number.')
    const parsed = parseUpdateIssueRequest(await readJson(c))
    if (!parsed.ok) throw invalidRequest(parsed.message)
    const { expectedUpdatedAt, fields } = parsed.value
    const payload = JSON.stringify(fields)

    const token = tokenSource(keycloak, idHash, UPDATE_WORDING)
    function request(method: 'GET' | 'PATCH', bearer: string): Promise<Response> {
      return ctx.fetch(`${UPSTREAM}${path}`, {
        method,
        headers: githubHeaders(bearer, method === 'PATCH'),
        ...(method === 'PATCH' ? { body: payload } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      })
    }
    const isOk = (response: Response) => response.status >= 200 && response.status < 300

    let bearer = await token(false)
    let freshToken = false
    for (;;) {
      let check: Response
      try {
        check = await request('GET', bearer)
      } catch (error) {
        ctx.log.warn('github update failed', { name: errorName(error) })
        throw new HttpError(503, 'unavailable', 'GitHub did not answer the check. Nothing was changed.')
      }
      if (check.status === 401 && !freshToken) {
        // GitHub refused the credentials and read nothing, so the check can be sent again with a fresh token.
        await check.body?.cancel().catch(() => undefined)
        freshToken = true
        bearer = await token(true)
        continue
      }
      if (!isOk(check)) return githubRejected(c, check, 'check')
      const current = await readBody(check)
      const checked = checkedIssue(current)
      if (checked === null) {
        throw new HttpError(503, 'unavailable', "GitHub's answer about the issue could not be read. Nothing was changed.")
      }
      if (checked.pullRequest) throw invalidRequest('That number is a pull request, not an issue.')
      if (!sameUpdatedAt(checked.updatedAt, expectedUpdatedAt)) {
        const body: StaleIssueResponse = {
          error: 'stale-issue',
          message: 'The issue changed on GitHub since this change started. Nothing was sent.',
          current,
        }
        return c.json(body, 409)
      }

      let write: Response
      try {
        write = await request('PATCH', bearer)
      } catch (error) {
        ctx.log.warn('github update failed', { name: errorName(error) })
        throw new HttpError(504, 'github-no-answer', 'GitHub did not answer. The change may have been applied.')
      }
      if (write.status === 401 && !freshToken) {
        // A 401 means GitHub applied nothing. The check runs again with the fresh token so it directly precedes the write it guards.
        await write.body?.cancel().catch(() => undefined)
        freshToken = true
        bearer = await token(true)
        continue
      }
      if (!isOk(write)) return githubRejected(c, write, 'write')
      const issue = await readBody(write)
      ctx.log.info('issue updated', {
        repo: `${c.req.param('owner')}/${c.req.param('name')}`,
        number: Number(c.req.param('number')),
        user: auth.user.id,
        fields: Object.keys(fields).join(','),
      })
      const body: UpdateIssueResponse = { issue }
      return c.json(body, 200)
    }
  })

  return routes
}
