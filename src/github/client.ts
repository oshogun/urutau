import type { GitHubAccessProblem } from '../domain/api'
import { useSession } from '../state/session'

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
    response = await fetch(url, server ? { headers, signal, credentials: 'same-origin' } : { headers, signal })
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

/** Where a GitHub API path (starting with `/`) is requested for the chosen route. */
function urlFor(path: string, options: RequestOptions): string {
  return options.via === 'server' ? `${SERVER_ROOT}${path}` : `${API_ROOT}${path}`
}

/** A next-page URL is followed only if it stays on the host this request may talk to. */
function isOwnUrl(url: string, options: RequestOptions): boolean {
  return url.startsWith(options.via === 'server' ? `${SERVER_ROOT}/` : `${API_ROOT}/`)
}

export async function getJson<T>(path: string, options: RequestOptions): Promise<T> {
  const response = await request(urlFor(path, options), options)
  return (await response.json()) as T
}

/** Extracts the `rel="next"` URL from a GitHub `Link` header. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part)
    if (match && match[2].split(/\s+/).includes('next')) return match[1]
  }
  return null
}

/**
 * Follows `Link` pagination, stopping after `maxPages` so that a huge
 * repository cannot burn through the rate limit. `truncated` reports whether
 * pages were left unread.
 */
export async function getAllPages<T>(
  path: string,
  options: RequestOptions & { maxPages: number },
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let url: string | null = urlFor(path, options)
  let pages = 0
  while (url && pages < options.maxPages && isOwnUrl(url, options)) {
    const response = await request(url, options)
    items.push(...((await response.json()) as T[]))
    url = parseNextLink(response.headers.get('link'))
    pages += 1
  }
  return { items, truncated: url !== null }
}
