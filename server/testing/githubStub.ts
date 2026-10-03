/** An in-memory GitHub REST stub for server tests: answers repository, issue and label reads and records every call. */
import type { GhIssue } from '../../src/github/api.ts'

export interface StubRepo {
  id: number
  private: boolean
  /** GitHub issue objects; a pull request is an item with a `pull_request` field. */
  items: GhIssue[]
}

export interface StubCall {
  method: string
  url: string
  headers: Headers
  redirect: string
}

export interface GitHubStub {
  fetch: typeof fetch
  /** Every request received, answered or not, in arrival order. */
  calls: StubCall[]
  /** Adds or replaces a repository; the name is matched case-insensitively. */
  setRepo(fullName: string, repo: StubRepo): void
}

const ORIGIN = 'https://api.github.com'
const DEFAULT_PER_PAGE = 30
const MAX_PER_PAGE = 100

/** An issue object with the fields the board reads; `overrides` replaces any of them. */
export function stubIssue(number: number, overrides: Partial<GhIssue> = {}): GhIssue {
  const created = new Date(Date.UTC(2026, 0, 1) + number * 60_000).toISOString()
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    assignees: [],
    user: null,
    milestone: null,
    comments: 0,
    created_at: created,
    updated_at: created,
    closed_at: null,
    ...overrides,
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

function notFound(): Response {
  return json({ message: 'Not Found' }, 404)
}

export function createGitHubStub(initial: Record<string, StubRepo> = {}): GitHubStub {
  const repos = new Map<string, { fullName: string; repo: StubRepo }>()
  const setRepo = (fullName: string, repo: StubRepo) => repos.set(fullName.toLowerCase(), { fullName, repo })
  for (const [fullName, repo] of Object.entries(initial)) setRepo(fullName, repo)
  const calls: StubCall[] = []

  const issuePage = (id: number, repo: StubRepo, rawQuery: string): Response => {
    const params = new URLSearchParams(rawQuery)
    const state = params.get('state') ?? 'open'
    const since = params.get('since')
    const perPage = Math.min(MAX_PER_PAGE, Number(params.get('per_page') ?? DEFAULT_PER_PAGE) || DEFAULT_PER_PAGE)
    const page = Math.max(1, Number(params.get('page') ?? 1) || 1)
    const matching = repo.items
      .filter((item) => item.state === state)
      .filter((item) => since === null || Date.parse(item.updated_at) >= Date.parse(since))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.number - a.number)
    const slice = matching.slice((page - 1) * perPage, page * perPage)
    const headers: Record<string, string> = {}
    if (page * perPage < matching.length) {
      const kept = rawQuery.split('&').filter((part) => part !== '' && !/^(after|page)(=|$)/.test(part))
      const cursor = encodeURIComponent(btoa(`cursor:${page + 1}`))
      const next = `${ORIGIN}/repositories/${id}/issues?${[...kept, `after=${cursor}`, `page=${page + 1}`].join('&')}`
      headers.link = `<${next}>; rel="next"`
    }
    return json(slice, 200, headers)
  }

  const answer = (method: string, url: URL): Response => {
    if (method !== 'GET' || url.origin !== ORIGIN) return notFound()
    const parts = url.pathname.split('/').filter(Boolean)
    const rawQuery = url.search.slice(1)
    if (parts[0] === 'repos' && parts.length >= 3) {
      const entry = repos.get(`${decodeURIComponent(parts[1])}/${decodeURIComponent(parts[2])}`.toLowerCase())
      if (!entry) return notFound()
      const { fullName, repo } = entry
      if (parts.length === 3) {
        return json({ id: repo.id, full_name: fullName, private: repo.private, description: null, html_url: `https://github.com/${fullName}` })
      }
      if (parts.length === 4 && parts[3] === 'issues') return issuePage(repo.id, repo, rawQuery)
      if (parts.length === 4 && parts[3] === 'labels') return json([])
      return notFound()
    }
    if (parts[0] === 'repositories' && parts.length === 3) {
      const entry = [...repos.values()].find(({ repo }) => String(repo.id) === parts[1])
      if (!entry) return notFound()
      if (parts[2] === 'issues') return issuePage(entry.repo.id, entry.repo, rawQuery)
      if (parts[2] === 'labels') return json([])
    }
    return notFound()
  }

  const stubFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    calls.push({ method: request.method, url: request.url, headers: request.headers, redirect: request.redirect })
    return answer(request.method, new URL(request.url))
  }

  return { fetch: stubFetch, calls, setRepo }
}
