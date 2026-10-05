import { ApiError } from '../api/client'
import { createIssueOnServer } from '../api/issues'
import {
  NEW_ISSUE_BODY_MAX,
  NEW_ISSUE_TITLE_MAX,
  type CreateIssueRequest,
  type GitHubAccessProblem,
  type GitHubFailureDetail,
  type GitHubValidationError,
} from '../domain/api'
import type { Issue } from '../domain/types'
import { toIssue } from './api'
import {
  API_ROOT,
  githubHeaders,
  isFailureDetail,
  isRecord,
  serverAccessOutcome,
  startTimedRequest,
  timeOf,
  validationDetail,
} from './issueWrite'

const BROWSER_TIMEOUT_MS = 30_000
const SERVER_TIMEOUT_MS = 60_000

export type CreateIssueFailure =
  | 'invalid' // fields refused locally, by the Urutau server (400) or by GitHub (400, 422)
  | 'no-token' // browser path with no pasted token; nothing was sent
  | 'writes-off' // the switch is off (pre-check, or 403 github-writes-off)
  | 'signed-out' // the Urutau session ended
  | 'unreachable' // nothing reached GitHub: pre-check failed, browser offline, or server 503 before the call
  | 'token-rejected' // GitHub 401
  | 'no-permission' // GitHub 403 that is not a rate limit
  | 'not-found' // GitHub 404: repository gone or renamed, or the token cannot write to it
  | 'issues-disabled' // GitHub 410
  | 'rate-limited' // primary rate limit
  | 'secondary-rate-limited' // GitHub's secondary limit (content creation, concurrency)
  | 'server-access' // 424: the server could not get the Keycloak-brokered token
  | 'refused' // Urutau 403 csrf-rejected or forbidden
  | 'outcome-unknown' // no answer, timeout, connection failure or a 5xx after the request left
  | 'stopped' // the user stopped waiting; not-created before the request left, unknown after
  | 'created-unreadable' // GitHub created the issue but its answer could not be read
  | 'unknown' // any other 4xx

/** Whether GitHub holds the issue after the failure. */
export type CreateIssueOutcome = 'not-created' | 'unknown' | 'created'

/** The one extra button the dialog shows next to the message. */
export type CreateIssueAction = 'open-settings' | 'sign-in-keycloak' | 'refresh' | null

export interface CreateIssueErrorInit {
  kind: CreateIssueFailure
  message: string
  outcome?: CreateIssueOutcome
  action?: CreateIssueAction
  status?: number
  resetAt?: Date | null
  problem?: GitHubAccessProblem | 'unavailable' | null
}

/**
 * Every failure of a create. A class separate from GitHubError: that one's `retryable` and
 * `needsToken` describe reads, and a retried write can create the issue twice.
 */
export class CreateIssueError extends Error {
  readonly kind: CreateIssueFailure
  readonly outcome: CreateIssueOutcome
  readonly action: CreateIssueAction
  /** HTTP status of the answer that failed (GitHub's on the browser path and in github-rejected); 0 when none. */
  readonly status: number
  /** For the two rate-limit kinds: when a new attempt may succeed. */
  readonly resetAt: Date | null
  /** For `server-access`. */
  readonly problem: GitHubAccessProblem | 'unavailable' | null

  constructor(init: CreateIssueErrorInit) {
    super(init.message)
    this.name = 'CreateIssueError'
    this.kind = init.kind
    this.outcome = init.outcome ?? 'not-created'
    this.action = init.action ?? null
    this.status = init.status ?? 0
    this.resetAt = init.resetAt ?? null
    this.problem = init.problem ?? null
  }
}

const LOOK_FIRST = 'Refresh the board and look for it before creating it again.'

/** Failures that happen before a request is sent; the hook throws these. */
export const createIssueFailures = {
  noToken: () =>
    new CreateIssueError({
      kind: 'no-token',
      action: 'open-settings',
      message:
        'Creating issues needs a GitHub personal access token with Issues read and write permission. Add one in Settings.',
    }),
  writesOff: () =>
    new CreateIssueError({
      kind: 'writes-off',
      message: 'The admin has turned off creating issues on GitHub for this server.',
    }),
  signedOut: () => new CreateIssueError({ kind: 'signed-out', message: 'Your session ended. Sign in again.' }),
  settingsUnreachable: () =>
    new CreateIssueError({
      kind: 'unreachable',
      message:
        'Urutau could not check whether creating issues is turned on. Nothing was sent to GitHub. Try again.',
    }),
  stoppedBeforeSend: () =>
    new CreateIssueError({
      kind: 'stopped',
      message: 'You stopped before anything was sent to GitHub. Nothing was created.',
    }),
  invalid: (message: string) => new CreateIssueError({ kind: 'invalid', message }),
}

const length = (text: string) => [...text].length

/** The field rules of the create dialog and of both paths: the title is trimmed, a blank body is left out. */
export function normalizeIssueFields(
  fields: { title: unknown; body?: unknown },
): { ok: true; value: CreateIssueRequest } | { ok: false; message: string } {
  if (typeof fields.title !== 'string') return { ok: false, message: 'title must be text.' }
  const title = fields.title.trim()
  if (title === '') return { ok: false, message: 'title is required.' }
  if (length(title) > NEW_ISSUE_TITLE_MAX) {
    return { ok: false, message: `title must be at most ${NEW_ISSUE_TITLE_MAX} characters.` }
  }
  const { body } = fields
  if (body !== undefined && typeof body !== 'string') return { ok: false, message: 'body must be text.' }
  if (typeof body === 'string' && length(body) > NEW_ISSUE_BODY_MAX) {
    return { ok: false, message: `body must be at most ${NEW_ISSUE_BODY_MAX.toLocaleString('en-US')} characters.` }
  }
  const value: CreateIssueRequest = { title }
  if (typeof body === 'string' && body.trim() !== '') value.body = body
  return { ok: true, value }
}

// ---------------------------------------------------------------- reading GitHub's answers

const cut = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? [...value].slice(0, max).join('') : null
const whole = (value: string | null): number | null => (value !== null && /^\d+$/.test(value) ? Number(value) : null)

/** Reads GitHub's non-2xx browser-path answer into the shape the server sends in a github-rejected body. */
export async function failureDetailOf(response: Response): Promise<GitHubFailureDetail> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // An empty or non-JSON body leaves the message and errors empty.
  }
  const json = isRecord(body) ? body : {}
  const errors: GitHubValidationError[] = (Array.isArray(json.errors) ? json.errors : []).slice(0, 5).map((entry) => {
    const item = isRecord(entry) ? entry : {}
    return {
      resource: cut(item.resource, 200),
      field: cut(item.field, 200),
      code: cut(item.code, 200),
      message: cut(item.message, 200),
    }
  })
  return {
    status: response.status,
    message: cut(json.message, 500),
    errors,
    retryAfter: whole(response.headers.get('retry-after')),
    rateLimitRemaining: whole(response.headers.get('x-ratelimit-remaining')),
    rateLimitReset: whole(response.headers.get('x-ratelimit-reset')),
  }
}

/**
 * A 2xx body mapped to an Issue with the existing mapping, or null when it lacks `number`, `title`,
 * `state`, `html_url`, `labels`, `created_at` or `updated_at`, or describes a pull request.
 */
export function parseCreatedIssue(body: unknown): Issue | null {
  if (!isRecord(body) || 'pull_request' in body) return null
  const { number, title, state, html_url, labels, created_at, updated_at } = body
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null
  if (typeof title !== 'string' || typeof html_url !== 'string') return null
  if (state !== 'open' && state !== 'closed') return null
  if (!Array.isArray(labels)) return null
  if (typeof created_at !== 'string' || typeof updated_at !== 'string') return null
  return toIssue(body as unknown as Parameters<typeof toIssue>[0])
}

// ---------------------------------------------------------------- classification

/** Turns GitHub's failure, read on either path, into a CreateIssueError with the message for that path. */
export function classifyGitHubFailure(
  detail: GitHubFailureDetail,
  via: 'browser' | 'server',
  fullName: string,
  now: Date,
): CreateIssueError {
  const server = via === 'server'
  const { status } = detail
  const gh = detail.message === null ? '' : ` (${detail.message})`
  const limited = status === 403 || status === 429

  if (limited && detail.rateLimitRemaining === 0) {
    const resetAt = detail.rateLimitReset === null ? null : new Date(detail.rateLimitReset * 1000)
    const base = server
      ? 'The rate limit for your GitHub account was reached.'
      : "GitHub's rate limit for your token was reached."
    return new CreateIssueError({
      kind: 'rate-limited',
      status,
      resetAt,
      message: resetAt ? `${base} It resets at ${timeOf(resetAt)}.` : base,
    })
  }
  if (
    limited &&
    (detail.retryAfter !== null || status === 429 || /secondary rate limit|abuse detection/i.test(detail.message ?? ''))
  ) {
    const seconds = detail.retryAfter ?? 60
    return new CreateIssueError({
      kind: 'secondary-rate-limited',
      status,
      resetAt: new Date(now.getTime() + seconds * 1000),
      message: `GitHub is limiting how fast issues can be created. Wait ${
        seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`
      } and try again.`,
    })
  }
  if (status === 401) {
    return new CreateIssueError({
      kind: 'token-rejected',
      status,
      action: server ? 'sign-in-keycloak' : 'open-settings',
      message: server
        ? 'GitHub rejected the token Keycloak holds for you. Sign in with Keycloak again.'
        : 'GitHub rejected the access token. It may be expired or revoked; update it in Settings.',
    })
  }
  if (status === 403) {
    return new CreateIssueError({
      kind: 'no-permission',
      status,
      action: server ? null : 'open-settings',
      message: server
        ? `Your GitHub account, through its Keycloak link, can't create issues in ${fullName}${gh}. The link needs write access to issues; ask the admin.`
        : `Your token can't create issues in ${fullName}${gh}. Give it Issues read and write permission for this repository on GitHub, then try again.`,
    })
  }
  if (status === 404) {
    return new CreateIssueError({
      kind: 'not-found',
      status,
      action: server ? null : 'open-settings',
      message: server
        ? `GitHub answered “not found”: ${fullName} may have been renamed or deleted, or your Keycloak GitHub link can't write to it. Refresh the board; if it happens again, ask the admin to check the link's access.`
        : `GitHub answered “not found”: ${fullName} may have been renamed or deleted, or your token can't write to it. Refresh the board, and check that the token has Issues read and write permission for this repository.`,
    })
  }
  if (status === 410) {
    return new CreateIssueError({ kind: 'issues-disabled', status, message: `Issues are turned off for ${fullName} on GitHub.` })
  }
  if (status === 400 || status === 422) {
    return new CreateIssueError({
      kind: 'invalid',
      status,
      message: `GitHub did not accept the issue${validationDetail(detail)}. Change the title or description and try again.`,
    })
  }
  if (status >= 500) {
    return new CreateIssueError({
      kind: 'outcome-unknown',
      outcome: 'unknown',
      action: 'refresh',
      status,
      message: `GitHub had a problem (${status}), so the issue may have been created. ${LOOK_FIRST}`,
    })
  }
  return new CreateIssueError({
    kind: 'unknown',
    status,
    message: `GitHub returned an error (${status}${detail.message === null ? '' : `: ${detail.message}`}).`,
  })
}

const STOPPED_AFTER_SEND =
  "You stopped waiting, so Urutau doesn't know whether the issue was created. Refresh the board and look for it before creating it again; if it was created, the bucket rules place it."

const CREATED_UNREADABLE =
  'GitHub created the issue, but its answer could not be read. Refresh the board to see it; it will be placed by the bucket rules, not in this bucket.'

const unknownOutcome = (message: string, status = 0) =>
  new CreateIssueError({ kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh', status, message })

const createdUnreadable = () =>
  new CreateIssueError({ kind: 'created-unreadable', outcome: 'created', action: 'refresh', message: CREATED_UNREADABLE })

const stoppedAfterSend = () =>
  new CreateIssueError({ kind: 'stopped', outcome: 'unknown', action: 'refresh', message: STOPPED_AFTER_SEND })

function classifyServerError(error: ApiError, fullName: string, now: Date): CreateIssueError {
  // The route answers 2xx only after GitHub created the issue, so a 2xx whose body could not be read still means it exists.
  if (error.status >= 200 && error.status < 300) return createdUnreadable()
  const body = isRecord(error.body) ? error.body : {}
  if (error.code === 'github-rejected' && isFailureDetail(body.github)) {
    return classifyGitHubFailure(body.github, 'server', fullName, now)
  }
  if (error.code === 'github-no-answer') {
    return unknownOutcome(
      `The Urutau server got no answer from GitHub, so the issue may have been created. ${LOOK_FIRST}`,
      error.status,
    )
  }
  if (error.code === 'github-writes-off') return createIssueFailures.writesOff()
  if (error.code === 'github-access') {
    return new CreateIssueError({ kind: 'server-access', status: error.status, ...serverAccessOutcome(body, 'create') })
  }
  if (error.code === 'signed-out') return createIssueFailures.signedOut()
  if (error.code === 'csrf-rejected' || error.code === 'forbidden') {
    return new CreateIssueError({
      kind: 'refused',
      status: error.status,
      message: 'The Urutau server refused the request. Reload the page and try again.',
    })
  }
  if (error.code === 'invalid-request') {
    return new CreateIssueError({
      kind: 'invalid',
      status: error.status,
      message: `Urutau refused the issue: ${error.message}`,
    })
  }
  if (error.status === 503) {
    return new CreateIssueError({
      kind: 'unreachable',
      status: 503,
      message: 'The Urutau server could not complete the request, and nothing was created on GitHub. Try again shortly.',
    })
  }
  if (error.status === 0) {
    return unknownOutcome('No answer came from the Urutau server, so the issue may have been created. ' + LOOK_FIRST)
  }
  if (error.status >= 500) {
    return unknownOutcome(
      `The Urutau server had a problem (${error.status}), so the issue may have been created. ${LOOK_FIRST}`,
      error.status,
    )
  }
  return new CreateIssueError({
    kind: 'unknown',
    status: error.status,
    message: `The Urutau server answered ${error.status}.`,
  })
}

// ---------------------------------------------------------------- the request

export interface CreateIssueCall {
  /** `owner/name` exactly as `snapshot.repository.fullName` spells it (GitHub's current name). */
  fullName: string
  /** Already normalized: title trimmed, body left out when blank. */
  fields: CreateIssueRequest
  /** 'server' when the session's githubAccess.mode is 'server'. */
  via: 'browser' | 'server'
  /** The pasted token, browser path only; must be non-empty there. */
  token?: string
  /** The dialog's stop signal. Aborting it ends the wait with kind 'stopped'. */
  signal?: AbortSignal
}

/**
 * Creates the issue with one request and no automatic retry: a retry after an unanswered
 * request could create it twice. The browser path posts to api.github.com with the pasted token
 * in the Authorization header only; the server path posts to the Urutau server, which holds the
 * token. The request has its own AbortController, aborted when `signal` aborts (a stop) or when
 * a timer runs out (30 s on the browser path, 60 s on the server path).
 */
export async function createIssue(call: CreateIssueCall): Promise<Issue> {
  const { fullName, fields, via, token, signal } = call
  if (signal?.aborted) throw createIssueFailures.stoppedBeforeSend()
  const server = via === 'server'
  const [owner = '', name = ''] = fullName.split('/')

  const { controller, wasStopped, release } = startTimedRequest(signal, server ? SERVER_TIMEOUT_MS : BROWSER_TIMEOUT_MS)

  try {
    if (server) {
      let created
      try {
        created = await createIssueOnServer({ owner, name }, fields, controller.signal)
      } catch (error) {
        if (wasStopped()) throw stoppedAfterSend()
        if (error instanceof ApiError) throw classifyServerError(error, fullName, new Date())
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw unknownOutcome(`No answer came from the Urutau server, so the issue may have been created. ${LOOK_FIRST}`)
        }
        throw error
      }
      if (wasStopped()) throw stoppedAfterSend()
      const issue = parseCreatedIssue(isRecord(created) ? created.issue : null)
      if (!issue) throw createdUnreadable()
      return issue
    }

    let response: Response
    try {
      response = await fetch(`${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`, {
        method: 'POST',
        headers: { ...githubHeaders(token ?? ''), 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      if (wasStopped()) throw stoppedAfterSend()
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new CreateIssueError({
          kind: 'unreachable',
          message: 'You are offline. Nothing was sent to GitHub. Try again when you are connected.',
        })
      }
      throw unknownOutcome(`Urutau got no answer from GitHub, so the issue may have been created. ${LOOK_FIRST}`)
    }

    if (!response.ok) throw classifyGitHubFailure(await failureDetailOf(response), 'browser', fullName, new Date())
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // The issue exists on GitHub; only its answer is unreadable.
    }
    const issue = parseCreatedIssue(body)
    if (!issue) throw createdUnreadable()
    return issue
  } finally {
    release()
  }
}
