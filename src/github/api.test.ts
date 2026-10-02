import { describe, expect, it, vi } from 'vitest'
import { fetchRepoSnapshot } from './api'

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
      { closedWindowDays: 14 },
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
    await fetchRepoSnapshot({ owner: 'acme', name: 'widgets' }, { closedWindowDays: 0 })
    const states = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('state'))
    expect(states).not.toContain('closed')
  })
})
