import { ApiError } from '../api/client'
import { SERVER_UPDATE_TIMEOUT_MS, updateIssueOnServer } from '../api/issues'
import type { GitHubAccessProblem, GitHubFailureDetail, IssueUpdateFields } from '../domain/api'
import { sameUpdatedAt } from '../domain/issueUpdate'
import type { Issue } from '../domain/types'
import { failureDetailOf, parseCreatedIssue } from './createIssue'
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

const CHECK_TIMEOUT_MS = 20_000
const WRITE_TIMEOUT_MS = 30_000

export type UpdateIssueFailure =
  | 'stale' // GitHub's updated_at differs from the change's start; nothing was sent; `current` is GitHub's issue
  | 'invalid' // fields refused locally, by the Urutau server (400) or by GitHub (400, 422 on the write)
  | 'no-token' // browser path with no pasted token; nothing was sent
  | 'writes-off' // the switch is off (pre-check, or 403 github-writes-off)
  | 'signed-out' // the Urutau session ended
  | 'unreachable' // nothing was changed: the check got no usable answer (offline included), settings pre-check failed, or server 503
  | 'token-rejected' // GitHub 401
  | 'no-permission' // GitHub 403 that is not a rate limit (message depends on the step)
  | 'not-found' // GitHub 404 (message depends on the step)
  | 'moved' // GitHub answered a redirect: the issue was transferred
  | 'gone' // GitHub 410: the issue was deleted, or issues are turned off
  | 'rate-limited' // primary rate limit
  | 'secondary-rate-limited' // GitHub's secondary limit
  | 'server-access' // 424: the server could not get the Keycloak-brokered token
  | 'refused' // Urutau 403 csrf-rejected or forbidden
  | 'outcome-unknown' // the write may have left: no answer, a timeout, a 5xx, or the connection dropped while it was being sent
  | 'stopped' // the person stopped waiting; not-applied before the write left, unknown after
  | 'applied-unreadable' // GitHub applied the change but its answer could not be read
  | 'unknown' // any other status

/** Whether GitHub holds the change after the failure. */
export type UpdateIssueOutcome = 'not-applied' | 'unknown' | 'applied'

/** The one extra button the notice shows. */
export type UpdateIssueAction = 'open-settings' | 'sign-in-keycloak' | 'refresh' | null

export interface UpdateIssueErrorInit {
  kind: UpdateIssueFailure
  message: string
  outcome?: UpdateIssueOutcome
  action?: UpdateIssueAction
  status?: number
  resetAt?: Date | null
  problem?: GitHubAccessProblem | 'unavailable' | null
  current?: Issue | null
}

/**
 * Every failure of a change. A class separate from GitHubError: that one's `retryable` and
 * `needsToken` describe reads, and a write that may have been applied must not be retried blindly.
 */
export class UpdateIssueError extends Error {
  readonly kind: UpdateIssueFailure
  /** Default 'not-applied'. */
  readonly outcome: UpdateIssueOutcome
  readonly action: UpdateIssueAction
  /** HTTP status of the answer that failed (GitHub's on the browser path and in github-rejected); 0 when none. */
  readonly status: number
  /** For the two rate-limit kinds: when a new attempt may succeed. */
  readonly resetAt: Date | null
  /** For `server-access`. */
  readonly problem: GitHubAccessProblem | 'unavailable' | null
  /** For 'stale': GitHub's issue now; null when its answer could not be read. */
  readonly current: Issue | null

  constructor(init: UpdateIssueErrorInit) {
    super(init.message)
    this.name = 'UpdateIssueError'
    this.kind = init.kind
    this.outcome = init.outcome ?? 'not-applied'
    this.action = init.action ?? null
    this.status = init.status ?? 0
    this.resetAt = init.resetAt ?? null
    this.problem = init.problem ?? null
    this.current = init.current ?? null
  }
}

/** Failures that happen before anything is sent to GitHub; the hook throws these. */
export const updateIssueFailures = {
  noToken: () =>
    new UpdateIssueError({
      kind: 'no-token',
      action: 'open-settings',
      message:
        'Changing issues needs a GitHub personal access token with Issues read and write permission. Add one in Settings.',
    }),
  writesOff: () =>
    new UpdateIssueError({
      kind: 'writes-off',
      message: 'The admin has turned off changing issues on GitHub for this server.',
    }),
  signedOut: () => new UpdateIssueError({ kind: 'signed-out', message: 'Your session ended. Sign in again.' }),
  settingsUnreachable: () =>
    new UpdateIssueError({
      kind: 'unreachable',
      message:
        'Urutau could not check whether changing issues is turned on. Nothing was sent to GitHub. Try again.',
    }),
  stoppedBeforeSend: () =>
    new UpdateIssueError({
      kind: 'stopped',
      message: 'You stopped before anything was sent to GitHub. Nothing was changed.',
    }),
  invalid: (message: string) => new UpdateIssueError({ kind: 'invalid', message }),
}

const NOT_CHANGED = 'Nothing was changed.'
const REFRESH_TO_SEE = 'Refresh the board to see the issue as GitHub has it.'

/**
 * Turns GitHub's failure, read on either path, into an UpdateIssueError with the message for that
 * path. Rules in this order, first match wins: primary rate limit, secondary rate limit, redirect,
 * 401, 403 by step, 404 by step, 410, 400 or 422 on the write, 5xx by step, anything else. A 403
 * with x-ratelimit-remaining 0 is a rate limit, never a missing permission.
 */
export function classifyUpdateFailure(
  detail: GitHubFailureDetail,
  step: 'check' | 'write',
  via: 'browser' | 'server',
  fullName: string,
  number: number,
  now: Date,
): UpdateIssueError {
  const server = via === 'server'
  const { status } = detail
  const gh = detail.message === null ? '' : ` (${detail.message})`
  const limited = status === 403 || status === 429
  const issue = `${fullName} #${number}`
  const access = server ? 'your Keycloak GitHub link' : 'your token'

  if (limited && detail.rateLimitRemaining === 0) {
    const resetAt = detail.rateLimitReset === null ? null : new Date(detail.rateLimitReset * 1000)
    const base = server
      ? 'The rate limit for your GitHub account was reached.'
      : "GitHub's rate limit for your token was reached."
    return new UpdateIssueError({
      kind: 'rate-limited',
      status,
      resetAt,
      message: `${base}${resetAt ? ` It resets at ${timeOf(resetAt)}.` : ''} ${NOT_CHANGED}`,
    })
  }
  if (
    limited &&
    (detail.retryAfter !== null || status === 429 || /secondary rate limit|abuse detection/i.test(detail.message ?? ''))
  ) {
    const seconds = detail.retryAfter ?? 60
    return new UpdateIssueError({
      kind: 'secondary-rate-limited',
      status,
      resetAt: new Date(now.getTime() + seconds * 1000),
      message: `GitHub is limiting how fast issues can be changed. Wait ${
        seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`
      } and try again.`,
    })
  }
  if (status >= 300 && status < 400) {
    return new UpdateIssueError({
      kind: 'moved',
      status,
      action: 'refresh',
      message: `GitHub says ${issue} was moved to another repository. ${NOT_CHANGED} Refresh the board.`,
    })
  }
  if (status === 401) {
    return new UpdateIssueError({
      kind: 'token-rejected',
      status,
      action: server ? 'sign-in-keycloak' : 'open-settings',
      message: server
        ? 'GitHub rejected the token Keycloak holds for you. Sign in with Keycloak again.'
        : 'GitHub rejected the access token. It may be expired or revoked; update it in Settings.',
    })
  }
  if (status === 403) {
    if (step === 'check') {
      return new UpdateIssueError({
        kind: 'no-permission',
        status,
        action: server ? null : 'open-settings',
        message: server
          ? `Your GitHub account, through its Keycloak link, can't read ${fullName}${gh}. ${NOT_CHANGED}`
          : `Your token can't read ${fullName}${gh}. ${NOT_CHANGED}`,
      })
    }
    return new UpdateIssueError({
      kind: 'no-permission',
      status,
      action: server ? null : 'open-settings',
      message: server
        ? `GitHub refused to change ${issue}${gh}. ${NOT_CHANGED} If your GitHub account, through its Keycloak link, lacks write access to issues in this repository, ask the admin.`
        : `GitHub refused to change ${issue}${gh}. ${NOT_CHANGED} If your token lacks Issues read and write permission for this repository, give it that permission on GitHub or add a token that has it in Settings, then try again.`,
    })
  }
  if (status === 404) {
    if (step === 'check') {
      return new UpdateIssueError({
        kind: 'not-found',
        status,
        action: 'refresh',
        message: `GitHub answered “not found” for ${issue}: the issue or the repository may have been deleted, moved or renamed, or ${access} can't read it. ${NOT_CHANGED} Refresh the board.`,
      })
    }
    return new UpdateIssueError({
      kind: 'not-found',
      status,
      action: server ? null : 'open-settings',
      message: server
        ? `GitHub answered “not found”: your Keycloak GitHub link may not be allowed to change issues in ${fullName}. Ask the admin to check the link's access.`
        : `GitHub answered “not found”: your token may not be allowed to change issues in ${fullName}. Check that it has Issues read and write permission for this repository.`,
    })
  }
  if (status === 410) {
    return new UpdateIssueError({
      kind: 'gone',
      status,
      action: 'refresh',
      message: `GitHub says ${issue} is gone: it was deleted, or issues are turned off for ${fullName}. ${NOT_CHANGED} Refresh the board.`,
    })
  }
  if ((status === 400 || status === 422) && step === 'write') {
    return new UpdateIssueError({
      kind: 'invalid',
      status,
      message: `GitHub did not accept the change${validationDetail(detail)}. ${NOT_CHANGED}`,
    })
  }
  if (status >= 500) {
    if (step === 'check') {
      return new UpdateIssueError({
        kind: 'unreachable',
        status,
        message: `GitHub had a problem (${status}) answering the check. Nothing was sent. Try again.`,
      })
    }
    return new UpdateIssueError({
      kind: 'outcome-unknown',
      outcome: 'unknown',
      action: 'refresh',
      status,
      message: `GitHub had a problem (${status}), so the change may have been applied. ${REFRESH_TO_SEE}`,
    })
  }
  return new UpdateIssueError({
    kind: 'unknown',
    status,
    message: `GitHub returned an error (${status}${detail.message === null ? '' : `: ${detail.message}`}). ${NOT_CHANGED}`,
  })
}

const stale = (current: Issue | null) =>
  new UpdateIssueError({
    kind: 'stale',
    status: 409,
    current,
    action: current === null ? 'refresh' : null,
    message: `The issue changed on GitHub since this change started. Nothing was sent.${
      current === null ? ' Refresh the board to see it.' : ''
    }`,
  })

const unknownOutcome = (message: string, status = 0) =>
  new UpdateIssueError({ kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh', status, message })

const stoppedAfterSend = () =>
  new UpdateIssueError({
    kind: 'stopped',
    outcome: 'unknown',
    action: 'refresh',
    message: `You stopped waiting, so Urutau doesn't know whether GitHub applied the change. ${REFRESH_TO_SEE}`,
  })

const appliedUnreadable = () =>
  new UpdateIssueError({
    kind: 'applied-unreadable',
    outcome: 'applied',
    action: 'refresh',
    message: "GitHub saved the change, but its answer could not be read. Refresh the board to see it.",
  })

const checkUnreadable = () =>
  new UpdateIssueError({
    kind: 'unreachable',
    message: "GitHub's answer about the issue could not be read. Nothing was sent. Try again.",
  })

function classifyServerError(error: ApiError, fullName: string, number: number, now: Date): UpdateIssueError {
  // The route answers 2xx only after GitHub accepted the change, so a 2xx whose body could not be read still means it was applied.
  if (error.status >= 200 && error.status < 300) return appliedUnreadable()
  const body = isRecord(error.body) ? error.body : {}
  if (error.code === 'github-rejected' && isFailureDetail(body.github)) {
    const step = body.step === 'check' ? 'check' : 'write'
    return classifyUpdateFailure(body.github, step, 'server', fullName, number, now)
  }
  if (error.code === 'stale-issue') return stale(parseCreatedIssue(body.current))
  if (error.code === 'github-no-answer') {
    return unknownOutcome(
      `The Urutau server got no answer from GitHub, so the change may have been applied. ${REFRESH_TO_SEE}`,
      error.status,
    )
  }
  if (error.code === 'github-writes-off') return updateIssueFailures.writesOff()
  if (error.code === 'github-access') {
    return new UpdateIssueError({ kind: 'server-access', status: error.status, ...serverAccessOutcome(body, 'change') })
  }
  if (error.code === 'signed-out') return updateIssueFailures.signedOut()
  if (error.code === 'csrf-rejected' || error.code === 'forbidden') {
    return new UpdateIssueError({
      kind: 'refused',
      status: error.status,
      message: 'The Urutau server refused the request. Reload the page and try again.',
    })
  }
  if (error.code === 'invalid-request') {
    return new UpdateIssueError({
      kind: 'invalid',
      status: error.status,
      message: `Urutau refused the change: ${error.message}`,
    })
  }
  if (error.status === 503) {
    return new UpdateIssueError({
      kind: 'unreachable',
      status: 503,
      message: 'The Urutau server could not complete the request, and nothing was changed on GitHub. Try again shortly.',
    })
  }
  if (error.status === 0) {
    return unknownOutcome(`No answer came from the Urutau server, so the change may have been applied. ${REFRESH_TO_SEE}`)
  }
  if (error.status >= 500) {
    return unknownOutcome(
      `The Urutau server had a problem (${error.status}), so the change may have been applied. ${REFRESH_TO_SEE}`,
      error.status,
    )
  }
  return new UpdateIssueError({ kind: 'unknown', status: error.status, message: `The Urutau server answered ${error.status}.` })
}

// ---------------------------------------------------------------- the requests

export interface UpdateIssueCall {
  /** `owner/name` exactly as `snapshot.repository.fullName` spells it (GitHub's current name). */
  fullName: string
  number: number
  /** The issue's updatedAt when the change started. */
  expectedUpdatedAt: string
  /** Already normalized. */
  fields: IssueUpdateFields
  /** 'server' when the session's githubAccess.mode is 'server'. */
  via: 'browser' | 'server'
  /** The pasted token, browser path only; must be non-empty there. */
  token?: string
  /** Aborting it ends the wait with kind 'stopped'. */
  signal?: AbortSignal
}

/**
 * Changes the issue. Browser path: reads the issue from GitHub with the pasted token (no HTTP
 * cache, no redirects followed), refuses with kind 'stale' and sends nothing when its updated_at
 * differs from `expectedUpdatedAt`, then sends the change; there is no automatic retry. Server
 * path: one request to the Urutau server, which runs the same two steps with the token it holds.
 * Each request has its own AbortController, aborted when `signal` aborts or a timer runs out.
 * Resolves with GitHub's issue; rejects with an UpdateIssueError.
 */
export async function updateIssue(call: UpdateIssueCall): Promise<Issue> {
  const { fullName, number, expectedUpdatedAt, fields, via, token, signal } = call
  if (signal?.aborted) throw updateIssueFailures.stoppedBeforeSend()
  const [owner = '', name = ''] = fullName.split('/')

  if (via === 'server') {
    const { controller, wasStopped, release } = startTimedRequest(signal, SERVER_UPDATE_TIMEOUT_MS)
    try {
      let answer
      try {
        answer = await updateIssueOnServer({ owner, name }, number, { expectedUpdatedAt, fields }, controller.signal)
      } catch (error) {
        if (wasStopped()) throw stoppedAfterSend()
        if (error instanceof ApiError) throw classifyServerError(error, fullName, number, new Date())
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw unknownOutcome(`No answer came from the Urutau server, so the change may have been applied. ${REFRESH_TO_SEE}`)
        }
        throw error
      }
      // Resolving means the route answered 2xx, so the change was applied even when a stop or the time limit cut its body off.
      const issue = parseCreatedIssue(isRecord(answer) ? answer.issue : null)
      if (!issue) throw appliedUnreadable()
      return issue
    } finally {
      release()
    }
  }

  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`
  const headers = githubHeaders(token ?? '')

  /**
   * One request's answer, with its body already read: a refused answer carries its detail, an accepted one its JSON.
   * `cutOff` is set when a 2xx's headers arrived but a stop or the time limit ended its body.
   */
  type Sent =
    | { failed: 'stopped' | 'no-answer'; cutOff?: true }
    | { refused: GitHubFailureDetail }
    | { accepted: unknown }

  /**
   * Sends one request and reads its body before the timer and the stop listener are released, so a
   * stop or a time limit also ends a body that never finishes.
   */
  async function send(init: RequestInit, timeoutMs: number): Promise<Sent> {
    const { controller, wasStopped, release } = startTimedRequest(signal, timeoutMs)
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal })
      if (response.type === 'opaqueredirect') {
        return { refused: { status: 301, message: null, errors: [], retryAfter: null, rateLimitRemaining: null, rateLimitReset: null } }
      }
      if (!response.ok) {
        const detail = await failureDetailOf(response)
        return controller.signal.aborted ? { failed: wasStopped() ? 'stopped' : 'no-answer' } : { refused: detail }
      }
      let body: unknown = null
      try {
        body = await response.json()
      } catch {
        // An unreadable body is reported by the caller; an aborted read is detected below.
      }
      return controller.signal.aborted ? { failed: wasStopped() ? 'stopped' : 'no-answer', cutOff: true } : { accepted: body }
    } catch {
      return { failed: wasStopped() ? 'stopped' : 'no-answer' }
    } finally {
      release()
    }
  }

  const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false
  const check = await send({ method: 'GET', headers, cache: 'no-store' }, CHECK_TIMEOUT_MS)
  if ('failed' in check) {
    if (check.failed === 'stopped') throw updateIssueFailures.stoppedBeforeSend()
    throw new UpdateIssueError({
      kind: 'unreachable',
      message: offline()
        ? 'You are offline. Nothing was sent to GitHub. Try again when you are connected.'
        : 'Urutau got no answer from GitHub while checking the issue. Nothing was sent. Try again.',
    })
  }
  if ('refused' in check) {
    throw classifyUpdateFailure(check.refused, 'check', 'browser', fullName, number, new Date())
  }
  const checked = parseCreatedIssue(check.accepted)
  if (!checked) throw checkUnreadable()
  if (!sameUpdatedAt(checked.updatedAt, expectedUpdatedAt)) throw stale(checked)
  if (signal?.aborted) throw updateIssueFailures.stoppedBeforeSend()

  const write = await send(
    { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(fields) },
    WRITE_TIMEOUT_MS,
  )
  if ('failed' in write) {
    // A 2xx means GitHub applied the change, even if its body was cut off.
    if (write.cutOff) throw appliedUnreadable()
    if (write.failed === 'stopped') throw stoppedAfterSend()
    throw unknownOutcome(
      offline()
        ? `The connection was lost while the change was being sent, so it may have been applied. When you are connected, refresh the board to see the issue as GitHub has it.`
        : `Urutau got no answer from GitHub, so the change may have been applied. ${REFRESH_TO_SEE}`,
    )
  }
  if ('refused' in write) {
    throw classifyUpdateFailure(write.refused, 'write', 'browser', fullName, number, new Date())
  }
  const issue = parseCreatedIssue(write.accepted)
  if (!issue) throw appliedUnreadable()
  return issue
}
