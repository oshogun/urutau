import { describe, expect, it, vi } from 'vitest'
import { fetchRepoSnapshot, fetchRepoSnapshotDetailed } from './api'
import { browserTransport } from './client'
import type { GitHubTransport } from './paging'

const NOW = Date.parse('2026-10-02T12:00:00Z')

const ghIssue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  state_reason: null,
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  labels: [{ name: 'bug', color: 'd73a4a', description: null }],
  assignees: [{ login: 'octocat', avatar_url: 'https://avatars/octocat', html_url: 'https://github.com/octocat' }],
  user: { login: 'hubot', avatar_url: 'https://avatars/hubot', html_url: 'https://github.com/hubot' },
  milestone: { title: 'v1.0' },
  comments: 2,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-30T00:00:00Z',
  closed_at: null,
  ...extra,
})

function routeFetch(routes: Record<string, unknown>) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input))
    const key = `${url.pathname}?state=${url.searchParams.get('state') ?? ''}`
    const body = routes[key] ?? routes[url.pathname]
    if (body === undefined) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('fetchRepoSnapshot', () => {
  it('maps issues and labels, drops pull requests and old closed issues', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const fetchMock = routeFetch({
      '/repos/acme/widgets': {
        full_name: 'acme/widgets',
        description: 'Widgets!',
        html_url: 'https://github.com/acme/widgets',
        private: false,
      },
      '/repos/acme/widgets/labels': [
        { name: 'enhancement', color: 'a2eeef', description: 'New feature' },
        { name: 'bug', color: 'd73a4a', description: null },
      ],
      '/repos/acme/widgets/issues?state=open': [ghIssue(1), ghIssue(2, { pull_request: {} })],
      '/repos/acme/widgets/issues?state=closed': [
        ghIssue(3, { state: 'closed', closed_at: '2026-09-30T00:00:00Z' }),
        // Updated recently (so returned by `since`) but closed long ago.
        ghIssue(4, { state: 'closed', closed_at: '2025-01-01T00:00:00Z' }),
      ],
    })

    const snapshot = await fetchRepoSnapshot(
      { owner: 'acme', name: 'widgets' },
      { closedWindowDays: 14, transport: browserTransport({}) },
    )

    expect(snapshot.repository.fullName).toBe('acme/widgets')
    expect(snapshot.labels.map((label) => label.name)).toEqual(['bug', 'enhancement'])
    expect(snapshot.issues.map((issue) => issue.number)).toEqual([1, 3])
    expect(snapshot.issues[0]).toMatchObject({
      labels: ['bug'],
      milestone: 'v1.0',
      comments: 2,
      author: { login: 'hubot' },
      assignees: [{ login: 'octocat', avatarUrl: 'https://avatars/octocat' }],
    })
    expect(snapshot.truncated).toBe(false)

    const closedCall = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.searchParams.get('state') === 'closed')
    expect(closedCall?.searchParams.get('since')).toBe('2026-09-18T12:00:00.000Z')
  })

  it('skips the closed-issues request when the window is 0', async () => {
    const fetchMock = routeFetch({
      '/repos/acme/widgets': { full_name: 'acme/widgets', description: null, html_url: '', private: true },
      '/repos/acme/widgets/labels': [],
      '/repos/acme/widgets/issues?state=open': [],
    })
    await fetchRepoSnapshot({ owner: 'acme', name: 'widgets' }, {
      closedWindowDays: 0,
      transport: browserTransport({}),
    })
    const states = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('state'))
    expect(states).not.toContain('closed')
  })
})

const ROOT = 'https://api.github.com'
const REPO_BODY = { full_name: 'acme/widgets', description: null, html_url: 'https://github.com/acme/widgets', private: false }

/** A transport that records every request and answers by path; it refuses anything but GET by construction. */
function fakeTransport(routes: Record<string, (url: URL) => Response | undefined>) {
  const urls: string[] = []
  const transport: GitHubTransport = {
    root: ROOT,
    get: async (url) => {
      urls.push(url)
      const parsed = new URL(url)
      const answer = routes[parsed.pathname]?.(parsed)
      if (!answer) throw new Error(`unexpected request ${url}`)
      return answer
    },
  }
  return { transport, urls }
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers })

describe('fetchRepoSnapshotDetailed over a fake transport', () => {
  it('requests the repository first, then labels, open and closed issues, and uses the injected clock', async () => {
    const { transport, urls } = fakeTransport({
      '/repos/acme/widgets': () => ok(REPO_BODY),
      '/repos/acme/widgets/labels': () => ok([{ name: 'bug', color: 'd73a4a', description: null }]),
      '/repos/acme/widgets/issues': (url) =>
        ok(url.searchParams.get('state') === 'open' ? [ghIssue(1), ghIssue(7, { pull_request: {} })] : [
          ghIssue(9, { state: 'closed', closed_at: '2026-09-30T00:00:00Z' }),
          ghIssue(12, { state: 'closed', closed_at: '2025-01-01T00:00:00Z', pull_request: {} }),
        ]),
    })
    const result = await fetchRepoSnapshotDetailed(
      { owner: 'acme', name: 'widgets' },
      { closedWindowDays: 14, transport, now: () => NOW },
    )
    expect(urls[0]).toBe(`${ROOT}/repos/acme/widgets`)
    expect(urls.slice(1)).toEqual([
      `${ROOT}/repos/acme/widgets/labels?per_page=100`,
      `${ROOT}/repos/acme/widgets/issues?state=open&per_page=100`,
      `${ROOT}/repos/acme/widgets/issues?state=closed&since=2026-09-18T12%3A00%3A00.000Z&per_page=100`,
    ])
    expect(result.snapshot.issues.map((issue) => issue.number)).toEqual([1, 9])
    expect(result.snapshot.fetchedAt).toBe(NOW)
    expect(result.highestNumber).toBe(12)
    expect(result.pullRequests).toEqual([7, 12])
    expect(result.openTruncated).toBe(false)
    expect(result.closedTruncated).toBe(false)
  })

  it('skips the label pages when labels is false', async () => {
    const { transport, urls } = fakeTransport({
      '/repos/acme/widgets': () => ok(REPO_BODY),
      '/repos/acme/widgets/issues': () => ok([]),
    })
    const result = await fetchRepoSnapshotDetailed(
      { owner: 'acme', name: 'widgets' },
      { closedWindowDays: 0, transport, labels: false },
    )
    expect(result.snapshot.labels).toEqual([])
    expect(result.highestNumber).toBe(0)
    expect(urls).toEqual([`${ROOT}/repos/acme/widgets`, `${ROOT}/repos/acme/widgets/issues?state=open&per_page=100`])
  })

  it('reports which list was truncated', async () => {
    const { transport } = fakeTransport({
      '/repos/acme/widgets': () => ok(REPO_BODY),
      '/repos/acme/widgets/issues': (url) =>
        ok([ghIssue(1)], url.searchParams.get('state') === 'open' ? { link: '<https://elsewhere.test/x>; rel="next"' } : {}),
    })
    const result = await fetchRepoSnapshotDetailed(
      { owner: 'acme', name: 'widgets' },
      { closedWindowDays: 7, transport, labels: false, now: () => NOW },
    )
    expect(result.openTruncated).toBe(true)
    expect(result.closedTruncated).toBe(false)
    expect(result.snapshot.truncated).toBe(true)
  })
})

describe('import rules', () => {
  it('api.ts and paging.ts import only domain and paging modules', () => {
    const sources = import.meta.glob<string>(['./api.ts', './paging.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    expect(Object.keys(sources).sort()).toEqual(['./api.ts', './paging.ts'])
    let found = 0
    for (const source of Object.values(sources)) {
      const specifiers = [...source.matchAll(/^(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)].map((match) => match[1])
      found += specifiers.length
      for (const specifier of specifiers) expect(specifier).toMatch(/^(\.\.\/domain\/[\w.]+\.ts|\.\/paging\.ts)$/)
    }
    expect(found).toBeGreaterThan(0)
  })
})
