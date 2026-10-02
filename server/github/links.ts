const API_ORIGIN = 'https://api.github.com/'

/**
 * Rewrites a GitHub `Link` header for the proxy: URLs on api.github.com become
 * relative `api/github/…` URLs the browser resolves against the page, and any
 * other URL is dropped. Only the `rel` of each link is kept. Returns null when
 * nothing is left.
 */
export function rewriteLinkHeader(header: string): string | null {
  const links: string[] = []
  for (const match of header.matchAll(/<([^>]*)>([^,<]*)/g)) {
    const [, url, params] = match
    if (!url.startsWith(API_ORIGIN)) continue
    const rel = /rel="([a-z]+)"/.exec(params)
    if (!rel) continue
    links.push(`<api/github/${url.slice(API_ORIGIN.length)}>; rel="${rel[1]}"`)
  }
  return links.length === 0 ? null : links.join(', ')
}
