import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SERVER_SETTINGS_QUERY_KEY } from '../api/settings'
import { UpdateIssueError } from '../github/updateIssue'
import { useBoards } from '../state/boardStore'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { installApiStub, stubCreatedIssue, stubUpdatedIssue, type ApiStub } from '../test/apiStub'
import { makeBoard, makeBucket, makeIssue } from '../test/fixtures'
import { useRepoSnapshot } from './useRepoSnapshot'
import { useUpdateIssue, withUpdatedIssue } from './useUpdateIssue'

const REPO = { owner: 'acme', name: 'widgets' }
const KEY = 'acme/widgets'
const TOKEN = 'github_pat_urutau_fixture_not_a_real_token'
const BOARD = makeBoard([makeBucket('backlog'), makeBucket('done', { collectsClosed: true })])
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const UPDATED_AT = '2026-01-01T00:00:00Z'

const repository = {
  full_name: 'acme/widgets',
  description: null,
  html_url: 'https://github.com/acme/widgets',
  private: false,
}
const existing = { ...stubCreatedIssue(KEY, 1, 'Existing'), created_at: UPDATED_AT, updated_at: UPDATED_AT }

let githubCalls: { method: string; path: string }[] = []
let githubNow: Record<string, unknown> = existing

/** What api.github.com (and the server's proxy) answers; every call is recorded. */
function githubAnswer(method: string, path: string): Response {
  if (method === 'PATCH') return json({ ...githubNow, title: 'Renamed', updated_at: '2026-02-02T00:00:00Z' })
  if (/\/issues\/\d+$/.test(path)) return json(githubNow)
  if (path.endsWith('/labels')) return json([])
  if (path.includes('/issues')) return json([existing])
  return json(repository)
}

beforeEach(() => {
  githubCalls = []
  githubNow = existing
  useBoards.setState({ entries: {} })
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
  useSettings.setState({ token: TOKEN })
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const { pathname } = new URL(String(url))
      githubCalls.push({ method: init?.method ?? 'GET', path: pathname })
      return githubAnswer(init?.method ?? 'GET', pathname)
    }),
  )
})

async function start(options: Parameters<typeof installApiStub>[0] = {}): Promise<ApiStub> {
  const stub = installApiStub({ githubWrites: true, boards: [], ...options })
  stub.putBoard(KEY, BOARD)
  await useSession.getState().load()
  await useBoards.getState().load(KEY)
  return stub
}

function render(closedDays = 0) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
  const view = renderHook(() => ({ snapshot: useRepoSnapshot(REPO, 0), wide: useRepoSnapshot(REPO, closedDays), update: useUpdateIssue(REPO) }), { wrapper })
  return { ...view, queryClient }
}

const input = () => ({ fullName: KEY, number: 1, expectedUpdatedAt: UPDATED_AT, fields: { title: 'Renamed' } })

describe('withUpdatedIssue', () => {
  const snapshot = { repository: { fullName: KEY } as never, labels: [], issues: [makeIssue(1), makeIssue(2)], truncated: true, fetchedAt: 5 }

  it('replaces the issue in place and keeps everything else', () => {
    const next = withUpdatedIssue(snapshot, makeIssue(2, { title: 'New' }))
    expect(next.issues.map((issue) => issue.title)).toEqual(['Issue 1', 'New'])
    expect(next).toMatchObject({ truncated: true, fetchedAt: 5, labels: [] })
  })

  it('appends an open issue it does not have, and returns the same snapshot for a closed one', () => {
    expect(withUpdatedIssue(snapshot, makeIssue(3)).issues.map((issue) => issue.number)).toEqual([1, 2, 3])
    expect(withUpdatedIssue(snapshot, makeIssue(3, { state: 'closed' }))).toBe(snapshot)
  })
})

describe('useUpdateIssue', () => {
  it('browser path: checks, patches, and replaces the cached issue without writing the board', async () => {
    const stub = await start()
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const readsBefore = githubCalls.length
    const boardWrites = stub.requests('PUT boards').length

    let updated: Awaited<ReturnType<typeof result.current.update>> | undefined
    await act(async () => {
      updated = await result.current.update(input())
    })

    expect(updated).toMatchObject({ number: 1, title: 'Renamed', updatedAt: '2026-02-02T00:00:00Z' })
    await waitFor(() => expect(result.current.snapshot.data?.issues).toEqual([updated]))
    expect(githubCalls.slice(readsBefore)).toEqual([
      { method: 'GET', path: '/repos/acme/widgets/issues/1' },
      { method: 'PATCH', path: '/repos/acme/widgets/issues/1' },
    ])
    expect(stub.requests('PUT boards')).toHaveLength(boardWrites)
    expect(stub.board(KEY)?.board).toEqual(BOARD)
  })

  it('replaces the issue in every cached snapshot, whatever its closed window', async () => {
    await start()
    const { result } = render(30)
    await waitFor(() => {
      expect(result.current.snapshot.data).toBeDefined()
      expect(result.current.wide.data).toBeDefined()
    })
    let updated: Awaited<ReturnType<typeof result.current.update>> | undefined
    await act(async () => {
      updated = await result.current.update(input())
    })
    await waitFor(() => {
      expect(result.current.snapshot.data?.issues).toEqual([updated])
      expect(result.current.wide.data?.issues).toEqual([updated])
    })
  })

  it('an empty settings answer is reported as unreachable, not a TypeError', async () => {
    await start()
    const { result, queryClient } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    queryClient.removeQueries({ queryKey: SERVER_SETTINGS_QUERY_KEY })
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(url), 'http://localhost').pathname.endsWith('/api/settings') ? Promise.resolve(new Response('', { status: 200 })) : inner(url, init),
    )
    const before = githubCalls.length
    await expect(result.current.update(input())).rejects.toMatchObject({ kind: 'unreachable' })
    expect(githubCalls).toHaveLength(before)
  })

  it('a stale refusal sends no PATCH, puts GitHub current issue in the cache and rethrows', async () => {
    const stub = await start()
    githubNow = { ...existing, title: 'Changed on GitHub', updated_at: '2026-01-05T00:00:00Z' }
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const readsBefore = githubCalls.length
    const error = await act(async () => result.current.update(input()).catch((reason: unknown) => reason))
    expect(error).toBeInstanceOf(UpdateIssueError)
    expect(error).toMatchObject({ kind: 'stale', outcome: 'not-applied' })
    expect(githubCalls.slice(readsBefore).map((call) => call.method)).toEqual(['GET'])
    await waitFor(() =>
      expect(result.current.snapshot.data?.issues[0]).toMatchObject({ title: 'Changed on GitHub', updatedAt: '2026-01-05T00:00:00Z' }),
    )
    expect(stub.requests('PUT boards')).toHaveLength(0)
  })

  it('a failed change leaves the snapshot as it was', async () => {
    await start()
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH' ? Promise.resolve(json({ message: 'Bad credentials' }, 401)) : inner(url, init),
    )
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    await expect(result.current.update(input())).rejects.toMatchObject({ kind: 'token-rejected' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(result.current.snapshot.data?.issues[0].title).toBe('Existing')
  })

  it('server path: patches api/issues and makes no request to GitHub', async () => {
    const stub = await start({
      githubAccess: { mode: 'server' },
      github: ({ path }) => githubAnswer('GET', `/${path}`),
      updateIssue: ({ number }) =>
        new Response(JSON.stringify({ issue: { ...stubUpdatedIssue(KEY, number, { title: 'Renamed' }), updated_at: '2026-02-02T00:00:00Z' } }), { status: 200 }),
    })
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const githubBefore = githubCalls.length
    await act(async () => {
      await result.current.update(input())
    })
    await waitFor(() => expect(result.current.snapshot.data?.issues[0]).toMatchObject({ number: 1, title: 'Renamed' }))
    expect(stub.requests('PATCH issues/acme/widgets/1')).toHaveLength(1)
    expect(stub.requests('PATCH issues/acme/widgets/1')[0].body).toEqual({ expectedUpdatedAt: UPDATED_AT, fields: { title: 'Renamed' } })
    expect(githubCalls).toHaveLength(githubBefore)
  })

  it('sends nothing to GitHub when the switch is off', async () => {
    await start({ githubWrites: false })
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const before = githubCalls.length
    await expect(result.current.update(input())).rejects.toMatchObject({ kind: 'writes-off' })
    expect(githubCalls).toHaveLength(before)
  })

  it('a server 403 github-writes-off turns the cached switch off', async () => {
    const stub = await start({ githubAccess: { mode: 'server' }, github: ({ path }) => githubAnswer('GET', `/${path}`) })
    const { result, queryClient } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    stub.failNext('PATCH issues', { status: 403, error: 'github-writes-off' })
    await expect(result.current.update(input())).rejects.toMatchObject({ kind: 'writes-off' })
    expect(queryClient.getQueryData(SERVER_SETTINGS_QUERY_KEY)).toEqual({ githubWrites: false })
  })

  it('without a pasted token nothing is sent; invalid fields are refused before any request', async () => {
    const stub = await start()
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const apiBefore = stub.calls.length
    await expect(result.current.update({ ...input(), fields: {} })).rejects.toMatchObject({ kind: 'invalid', message: 'Nothing to change.' })
    useSettings.setState({ token: ' ' })
    await expect(result.current.update(input())).rejects.toMatchObject({ kind: 'no-token', action: 'open-settings' })
    expect(stub.calls).toHaveLength(apiBefore)
  })

  it('a stop while the switch is being read sends nothing to GitHub', async () => {
    const stub = await start()
    const { result, queryClient } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    queryClient.removeQueries({ queryKey: SERVER_SETTINGS_QUERY_KEY })
    const gate = stub.hold('GET settings')
    const stop = new AbortController()
    const before = githubCalls.length
    const pending = result.current.update({ ...input(), signal: stop.signal })
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    stop.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'stopped', outcome: 'not-applied' })
    gate.release()
    expect(githubCalls).toHaveLength(before)
  })
})
