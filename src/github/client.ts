import type { GitHubAccessProblem } from '../domain/api'
import { useSession } from '../state/session'
import { fetchAllPages, fetchJson, parseNextLink, type GitHubTransport, type PagedResult } from './paging'

const API_ROOT = 'https://api.github.com'
/** Where the Urutau server proxies GitHub reads for users whose session says `mode: 'server'`. */
const SERVER_ROOT = 'api/github'

export type GitHubErrorKind =
  | 'unauthorized'
  | 'rate-limited'
  | 'not-found'
  | 'forbidden'
  | 'issues-disabled'
  | 'server-access'
  | 'network'
  | 'unknown'

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  readonly status: number
  /** When the rate limit resets, if GitHub told us. */
  readonly resetAt: Date | null
  /** For `server-access`: why the server could not read GitHub for this user. */
  readonly problem: GitHubAccessProblem | 'unavailable' | null

  constructor(
    kind: GitHubErrorKind,
    status: number,
    message: string,
    resetAt: Date | null = null,
    problem: GitHubAccessProblem | 'unavailable' | null = null,
  ) {
    super(message)
    this.problem = problem
    this.name = 'GitHubError'
    this.kind = kind
    this.status = status
    this.resetAt = resetAt
  }

  /** Errors that a better (or any) token would fix. */
  get needsToken(): boolean {
    return this.kind === 'unauthorized' || this.kind === 'forbidden' || this.kind === 'not-found'
  }

  get retryable(): boolean {
    return (
      this.kind === 'network' ||
      (this.kind === 'unknown' && this.status >= 500) ||
      (this.kind === 'server-access' && this.problem === 'unavailable')
    )
  }
}

export interface RequestOptions {
  /** The pasted token. Used only on the browser path, and sent only to api.github.com. */
  token?: string
  signal?: AbortSignal
  /** `browser` (default): api.github.com directly. `server`: through the Urutau server's proxy, never with a token. */
  via?: 'browser' | 'server'
}

const SERVER_MESSAGES: Record<string, string> = {
  'signin-expired': 'Sign in with Keycloak again to read issues through your GitHub link.',
  'not-linked': 'Your Keycloak account has no linked GitHub account.',
  refused: 'Keycloak did not hand out your GitHub token.',
  unavailable: 'Keycloak could not be reached.',
}

async function request(url: string, { token, signal, via }: RequestOptions): Promise<Response> {
  const server = via === 'server'
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token && !server) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    // GitHub sends `max-age=60` on issue lists. On the browser path, `no-cache` makes the browser ask GitHub
    // every time (with its stored ETag) instead of answering from its HTTP cache.
    response = await fetch(
      url,
      server ? { headers, signal, credentials: 'same-origin' } : { headers, signal, cache: 'no-cache' },
    )
  } catch (error) {
    if (signal?.aborted) throw error
    throw new GitHubError('network', 0, 'Could not reach GitHub. Check your connection and try again.')
  }
  if (!response.ok) throw await toGitHubError(response, Boolean(token), server)
  return response
}

function notFoundMessage(server: boolean, hasToken: boolean): string {
  if (server) return 'Repository not found, or your GitHub account cannot access it.'
  return hasToken
    ? 'Repository not found, or your token cannot access it.'
    : 'Repository not found. If it is private, add a personal access token in Settings.'
}

async function toGitHubError(response: Response, hasToken: boolean, server = false): Promise<GitHubError> {
  const { status, headers } = response
  let apiMessage = ''
  let body: { message?: string; error?: string; problem?: string } = {}
  try {
    body = (await response.json()) as typeof body
    apiMessage = body.message ?? ''
  } catch {
    // Not every error response has a JSON body.
  }

  if (server) {
    if (status === 424 && body.error === 'github-access') {
      const problem = body.problem && Object.hasOwn(SERVER_MESSAGES, body.problem) ? body.problem : 'unavailable'
      return new GitHubError(
        'server-access',
        status,
        SERVER_MESSAGES[problem],
        null,
        problem as GitHubAccessProblem | 'unavailable',
      )
    }
    if (status === 401 && body.error === 'signed-out') {
      useSession.getState().markSignedOut()
      return new GitHubError('unknown', status, 'Your session ended. Sign in again.')
    }
  }

  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  const retryAfter = headers.get('retry-after')
  if ((status === 403 || status === 429) && (remaining === '0' || retryAfter)) {
    const resetAt = reset
      ? new Date(Number(reset) * 1000)
      : retryAfter
        ? new Date(Date.now() + Number(retryAfter) * 1000)
        : null
    const when = resetAt
      ? ` It resets at ${resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
      : ''
    if (server) {
      return new GitHubError(
        'rate-limited',
        status,
        `The rate limit for your GitHub account was reached.${when}`,
        resetAt,
      )
    }
    const hint = hasToken ? '' : ' Add a personal access token in Settings for a much higher limit.'
    return new GitHubError('rate-limited', status, `GitHub's API rate limit was reached.${when}${hint}`, resetAt)
  }

  switch (status) {
    case 401:
      if (server) {
        return new GitHubError(
          'unauthorized',
          status,
          'GitHub rejected the token Keycloak holds for you. Sign in with Keycloak again.',
        )
      }
      return new GitHubError(
        'unauthorized',
        status,
        'GitHub rejected the access token. It may be expired or revoked; update it in Settings.',
      )
    case 403:
      return new GitHubError(
        'forbidden',
        status,
        `${server ? "Your GitHub account can't" : "Your token can't"} access this repository${apiMessage ? ` (${apiMessage})` : ''}.`,
      )
    case 404:
      return new GitHubError(
        'not-found',
        status,
        notFoundMessage(server, hasToken),
      )
    case 410:
      return new GitHubError('issues-disabled', status, 'Issues are disabled for this repository.')
    default:
      return new GitHubError(
        'unknown',
        status,
        `GitHub returned an error (${status}${apiMessage ? `: ${apiMessage}` : ''}).`,
      )
  }
}

/** The browser's transport: api.github.com with the pasted token, or the server's api/github proxy without it. */
export function browserTransport(options: RequestOptions): GitHubTransport {
  return {
    root: options.via === 'server' ? SERVER_ROOT : API_ROOT,
    get: (url, signal) => request(url, { ...options, signal: signal ?? options.signal }),
  }
}

export function getJson<T>(path: string, options: RequestOptions): Promise<T> {
  return fetchJson<T>(browserTransport(options), path, options.signal)
}

export { parseNextLink }

export function getAllPages<T>(
  path: string,
  options: RequestOptions & { maxPages: number },
): Promise<PagedResult<T>> {
  return fetchAllPages<T>(browserTransport(options), path, { maxPages: options.maxPages, signal: options.signal })
}
