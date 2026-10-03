/** GitHub REST paging over an injected transport, so the browser and the server share it. Types only from src/domain. */

export interface GitHubTransport {
  /** What a path starting with '/' is appended to: 'https://api.github.com' or 'api/github'. */
  readonly root: string
  /** One GET; resolves only with a 2xx response, rejects with the transport's own error otherwise. */
  get(url: string, signal?: AbortSignal): Promise<Response>
}

export interface PagedResult<T> {
  items: T[]
  /** A next page was left unread: its link was foreign or maxPages was reached. */
  truncated: boolean
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

export async function fetchJson<T>(transport: GitHubTransport, path: string, signal?: AbortSignal): Promise<T> {
  const response = await transport.get(transport.root + path, signal)
  return (await response.json()) as T
}

/**
 * Follows `Link` pagination, stopping after `maxPages` so that a huge
 * repository cannot use up the rate limit. A next-page URL is followed
 * only if it stays under the transport's root. `truncated` reports whether
 * pages were left unread.
 */
export async function fetchAllPages<T>(
  transport: GitHubTransport,
  path: string,
  { maxPages, signal }: { maxPages: number; signal?: AbortSignal },
): Promise<PagedResult<T>> {
  const items: T[] = []
  let url: string | null = transport.root + path
  let pages = 0
  while (url && pages < maxPages && url.startsWith(`${transport.root}/`)) {
    const response = await transport.get(url, signal)
    items.push(...((await response.json()) as T[]))
    url = parseNextLink(response.headers.get('link'))
    pages += 1
  }
  return { items, truncated: url !== null }
}
