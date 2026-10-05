import type { GitHubAccessProblem, GitHubFailureDetail } from '../domain/api'

export const API_ROOT = 'https://api.github.com'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const timeOf = (date: Date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** GitHub's validation message and first error reason, as the text that follows a sentence. */
export function validationDetail(detail: GitHubFailureDetail): string {
  if (detail.message === null) return ''
  const [first] = detail.errors
  const reason = first ? (first.message ?? [first.field, first.code].filter(Boolean).join(' ')) : ''
  return reason ? ` (${detail.message}: ${reason})` : ` (${detail.message})`
}

export function isFailureDetail(value: unknown): value is GitHubFailureDetail {
  return isRecord(value) && typeof value.status === 'number' && Array.isArray(value.errors)
}

/** The headers of a browser-path request to api.github.com; the token goes nowhere else. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  }
}

/** What a 424 `github-access` answer from the Urutau server becomes: the problem, the button and the message. */
export function serverAccessOutcome(
  body: Record<string, unknown>,
  verb: 'create' | 'change',
): { problem: GitHubAccessProblem | 'unavailable'; action: 'sign-in-keycloak' | null; message: string } {
  const messages: Record<GitHubAccessProblem | 'unavailable', string> = {
    'signin-expired': `Sign in with Keycloak again to ${verb} issues through your GitHub link.`,
    'not-linked': `Your Keycloak account has no linked GitHub account, so the server can't ${verb} issues for you.`,
    refused: `Keycloak did not hand out your GitHub token, so the server can't ${verb} issues for you.`,
    unavailable: 'Keycloak could not be reached. Nothing was sent to GitHub. Try again shortly.',
  }
  const problem =
    typeof body.problem === 'string' && Object.hasOwn(messages, body.problem)
      ? (body.problem as GitHubAccessProblem | 'unavailable')
      : 'unavailable'
  return { problem, action: problem === 'signin-expired' ? 'sign-in-keycloak' : null, message: messages[problem] }
}

export interface TimedRequest {
  controller: AbortController
  /** Whether the person stopped the request, as opposed to the time limit running out. */
  wasStopped: () => boolean
  /** Clears the timer and the stop listener; call it in a `finally`. */
  release: () => void
}

/** An AbortController aborted when `signal` aborts (a stop) or when `timeoutMs` pass. */
export function startTimedRequest(signal: AbortSignal | undefined, timeoutMs: number): TimedRequest {
  const controller = new AbortController()
  let stopped = false
  const onStop = () => {
    stopped = true
    controller.abort()
  }
  signal?.addEventListener('abort', onStop, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    controller,
    wasStopped: () => stopped,
    release: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onStop)
    },
  }
}
