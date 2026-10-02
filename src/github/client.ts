const API_ROOT = 'https://api.github.com'

export type GitHubErrorKind =
  | 'unauthorized'
  | 'rate-limited'
  | 'not-found'
  | 'forbidden'
  | 'issues-disabled'
  | 'network'
  | 'unknown'

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  readonly status: number
  /** When the rate limit resets, if GitHub told us. */
  readonly resetAt: Date | null

  constructor(kind: GitHubErrorKind, status: number, message: string, resetAt: Date | null = null) {
    super(message)
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
    return this.kind === 'network' || (this.kind === 'unknown' && this.status >= 500)
  }
}

export interface RequestOptions {
  token?: string
  signal?: AbortSignal
}

async function request(url: string, { token, signal }: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(url, { headers, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new GitHubError('network', 0, 'Could not reach GitHub. Check your connection and try again.')
  }
  if (!response.ok) throw await toGitHubError(response, Boolean(token))
  return response
}

async function toGitHubError(response: Response, hasToken: boolean): Promise<GitHubError> {
  const { status, headers } = response
  let apiMessage = ''
  try {
    apiMessage = ((await response.json()) as { message?: string }).message ?? ''
  } catch {
    // Not every error response has a JSON body.
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
    const hint = hasToken ? '' : ' Add a personal access token in Settings for a much higher limit.'
    return new GitHubError('rate-limited', status, `GitHub's API rate limit was reached.${when}${hint}`, resetAt)
  }

  switch (status) {
    case 401:
      return new GitHubError(
        'unauthorized',
        status,
        'GitHub rejected the access token. It may be expired or revoked; update it in Settings.',
      )
    case 403:
      return new GitHubError(
        'forbidden',
        status,
        `Your token can't access this repository${apiMessage ? ` (${apiMessage})` : ''}.`,
      )
    case 404:
      return new GitHubError(
        'not-found',
        status,
        hasToken
          ? 'Repository not found, or your token cannot access it.'
          : 'Repository not found. If it is private, add a personal access token in Settings.',
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

export async function getJson<T>(path: string, options: RequestOptions): Promise<T> {
  const response = await request(`${API_ROOT}${path}`, options)
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
  let url: string | null = `${API_ROOT}${path}`
  let pages = 0
  while (url && pages < options.maxPages) {
    const response = await request(url, options)
    items.push(...((await response.json()) as T[]))
    url = parseNextLink(response.headers.get('link'))
    pages += 1
  }
  return { items, truncated: url !== null }
}
