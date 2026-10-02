import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../state/session'
import { installApiStub } from '../test/apiStub'
import { fetchRepoSnapshot } from './api'
import { GitHubError, getAllPages, getJson } from './client'

const REPO = { owner: 'acme', name: 'widgets' }
const TOKEN = 'ghp_pasted_secret'

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init })

const ghIssue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  labels: [],
  assignees: [],
  user: null,
  milestone: null,
  comments: 0,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  closed_at: null,
})

function githubAnswer(path: string, query: string): Response | undefined {
  if (path === 'repos/acme/widgets') {
    return json({ full_name: 'acme/widgets', description: null, html_url: 'https://github.com/acme/widgets', private: false })
  }
  if (path === 'repos/acme/widgets/labels') return json([{ name: 'bug', color: 'd73a4a', description: null }])
  if (path === 'repos/acme/widgets/issues') {
    return query.includes('page=2')
      ? json([ghIssue(2)])
      : json([ghIssue(1)], {
          headers: { link: '<api/github/repos/acme/widgets/issues?state=open&per_page=100&page=2>; rel="next"' },
        })
  }
  return undefined
}

beforeEach(() => {
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
})

describe('server path', () => {
  it('requests only api/github URLs, with no Authorization header and no token, and follows relative Link pages', async () => {
    const stub = installApiStub({
      githubAccess: { mode: 'server' },
      github: ({ path, query }) => githubAnswer(path, query),
    })
    await useSession.getState().load()
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()

    const snapshot = await fetchRepoSnapshot(REPO, { via: 'server', token: TOKEN, closedWindowDays: 0 })

    expect(snapshot.issues.map((issue) => issue.number)).toEqual([1, 2])
    expect(snapshot.repository.fullName).toBe('acme/widgets')
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^api\/github\//)
      expect(String(url)).not.toContain(TOKEN)
      const headers = Object.keys((init?.headers ?? {}) as object).map((name) => name.toLowerCase())
      expect(headers).not.toContain('authorization')
    }
    expect(stub.requests((call) => call.path.startsWith('github/')).length).toBe(fetchMock.mock.calls.length)
  })

  it('does not follow a next link that leaves api/github', async () => {
    installApiStub({
      githubAccess: { mode: 'server' },
      github: () => json([1], { headers: { link: '<https://evil.example/x?page=2>; rel="next"' } }),
    })
    await useSession.getState().load()
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    const result = await getAllPages<number>('/items', { via: 'server', maxPages: 10 })
    expect(result).toEqual({ items: [1], truncated: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the 10-page cap', async () => {
    installApiStub({
      githubAccess: { mode: 'server' },
      github: () => json([1], { headers: { link: '<api/github/items?page=2>; rel="next"' } }),
    })
    await useSession.getState().load()
    const result = await getAllPages<number>('/items', { via: 'server', maxPages: 10 })
    expect(result.items).toHaveLength(10)
    expect(result.truncated).toBe(true)
  })

  it.each([
    ['signin-expired', 'Sign in with Keycloak again to read issues through your GitHub link.', false],
    ['not-linked', 'Your Keycloak account has no linked GitHub account.', false],
    ['refused', 'Keycloak did not hand out your GitHub token.', false],
    ['unavailable', 'Keycloak could not be reached.', true],
  ])('maps a 424 %s to a server-access error', async (problem, message, retryable) => {
    installApiStub({
      githubAccess: { mode: 'server' },
      github: () =>
        new Response(JSON.stringify({ error: 'github-access', message: 'x', problem }), { status: 424 }),
    })
    await useSession.getState().load()
    const error = await getJson('/repos/acme/widgets', { via: 'server' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitHubError)
    expect(error).toMatchObject({ kind: 'server-access', status: 424, message, problem, needsToken: false, retryable })
  })

  it('uses the generic message for a 424 problem that is only an inherited object key', async () => {
    installApiStub({
      githubAccess: { mode: 'server' },
      github: () =>
        new Response(JSON.stringify({ error: 'github-access', message: 'x', problem: 'toString' }), { status: 424 }),
    })
    await useSession.getState().load()
    const error = await getJson('/repos/acme/widgets', { via: 'server' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'server-access', problem: 'unavailable', message: 'Keycloak could not be reached.' })
  })

  it('says once that the GitHub account hit its rate limit, with the reset time', async () => {
    installApiStub({
      githubAccess: { mode: 'server' },
      github: () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' },
        }),
    })
    await useSession.getState().load()
    const error = await getJson('/repos/acme/widgets', { via: 'server' }).catch((e: unknown) => e)
    const time = new Date(1_900_000_000_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(error).toMatchObject({
      kind: 'rate-limited',
      message: `The rate limit for your GitHub account was reached. It resets at ${time}.`,
    })
  })

  it('words GitHub 401, 403 and 404 for the account instead of a token', async () => {
    const answers = [
      [401, "GitHub rejected the token Keycloak holds for you. Sign in with Keycloak again."],
      [403, "Your GitHub account can't access this repository."],
      [404, 'Repository not found, or your GitHub account cannot access it.'],
    ] as const
    for (const [status, message] of answers) {
      installApiStub({
        githubAccess: { mode: 'server' },
        github: () => new Response(JSON.stringify({ message: 'Nope' }), { status }),
      })
      await useSession.getState().load()
      const error = await getJson('/repos/acme/widgets', { via: 'server' }).catch((e: unknown) => e)
      expect((error as GitHubError).message).toContain(message.replace(/\.$/, ''))
    }
  })

  it('maps a signed-out answer to a signed-out session', async () => {
    const stub = installApiStub({ githubAccess: { mode: 'server' }, github: () => undefined })
    await useSession.getState().load()
    stub.failNext('GET github/', { status: 401, error: 'signed-out' })
    await expect(getJson('/repos/acme/widgets', { via: 'server' })).rejects.toBeInstanceOf(GitHubError)
    expect(useSession.getState().status).toBe('signed-out')
  })
})

describe('browser path', () => {
  it('sends the pasted token only to api.github.com and never follows a link to another host', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('page=2')
        ? json([2])
        : json([1], { headers: { link: '<https://evil.example/items?page=2>; rel="next"' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const first = await getAllPages<number>('/items', { token: TOKEN, maxPages: 10 })
    expect(first).toEqual({ items: [1], truncated: true })

    await getJson('/repos/acme/widgets', { token: TOKEN })
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.github\.com\//)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    }
    expect(fetchMock.mock.calls.every(([url]) => !String(url).startsWith('api/'))).toBe(true)
  })
})
