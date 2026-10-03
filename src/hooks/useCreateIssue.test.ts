import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SERVER_SETTINGS_QUERY_KEY } from '../api/settings'
import { CreateIssueError } from '../github/createIssue'
import { useBoards } from '../state/boardStore'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { installApiStub, stubCreatedIssue, type ApiStub } from '../test/apiStub'
import { makeBoard, makeBucket } from '../test/fixtures'
import { useBoard } from './useBoard'
import { useCreateIssue, withCreatedIssue } from './useCreateIssue'
import { useRepoSnapshot } from './useRepoSnapshot'

const REPO = { owner: 'acme', name: 'widgets' }
const KEY = 'acme/widgets'
const TOKEN = 'ghp_pasted_secret'
const BOARD = makeBoard([makeBucket('backlog'), makeBucket('doing', { labelRules: ['in progress'] }), makeBucket('done', { collectsClosed: true })])
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const repository = {
  full_name: 'acme/widgets',
  description: null,
  html_url: 'https://github.com/acme/widgets',
  private: false,
}
const existing = {
  ...stubCreatedIssue(KEY, 1, 'Existing'),
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

let githubCalls: { method: string; path: string; init?: RequestInit }[] = []
let snapshotGate: Promise<void> | null = null

/** What api.github.com (and the server's proxy) answers; every call is recorded. */
function githubAnswer(method: string, path: string): Response {
  if (method === 'POST') return json(stubCreatedIssue(KEY, 19, 'From GitHub', 'Steps'), 201)
  if (path.endsWith('/labels') || path.includes('/issues')) return json(path.includes('/issues') ? [existing] : [])
  return json(repository)
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
  return { queryClient, wrapper }
}

beforeEach(() => {
  githubCalls = []
  snapshotGate = null
  useBoards.setState({ entries: {} })
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
  useSettings.setState({ token: TOKEN })
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const { pathname } = new URL(String(url))
      githubCalls.push({ method: init?.method ?? 'GET', path: pathname, init })
      if (snapshotGate && (init?.method ?? 'GET') === 'GET') {
        await Promise.race([
          snapshotGate,
          new Promise<never>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          ),
        ])
      }
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

function render() {
  const { queryClient, wrapper } = setup()
  const view = renderHook(
    () => ({ snapshot: useRepoSnapshot(REPO, 0), create: useCreateIssue(REPO), board: useBoard(REPO) }),
    { wrapper },
  )
  return { ...view, queryClient }
}

const input = (bucketId = 'backlog') => ({ fullName: KEY, bucketId, fields: { title: 'From GitHub', body: 'Steps' } })
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

describe('withCreatedIssue', () => {
  it('appends the issue and keeps everything else, replacing one with the same number', () => {
    const snapshot = { repository: { fullName: KEY } as never, labels: [], issues: [], truncated: true, fetchedAt: 5 }
    const issue = { number: 3 } as never
    const added = withCreatedIssue(snapshot, issue)
    expect(added).toEqual({ ...snapshot, issues: [issue] })
    const replaced = withCreatedIssue(added, { number: 3, title: 'new' } as never)
    expect(replaced.issues).toEqual([{ number: 3, title: 'new' }])
  })
})

describe('useCreateIssue', () => {
  it('browser path: adds the card to the snapshot with no further reads and saves the placement', async () => {
    const stub = await start()
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const readsBefore = githubCalls.length

    let created: Awaited<ReturnType<typeof result.current.create>> | undefined
    await act(async () => {
      created = await result.current.create(input('doing'))
    })

    expect(created).toMatchObject({ number: 19, title: 'From GitHub' })
    expect(result.current.snapshot.data?.issues.map((issue) => issue.number)).toEqual([1, 19])
    expect(githubCalls.slice(readsBefore)).toEqual([expect.objectContaining({ method: 'POST', path: '/repos/acme/widgets/issues' })])
    expect(githubCalls.slice(readsBefore)[0].init?.body).toBe(JSON.stringify({ title: 'From GitHub', body: 'Steps' }))
    await settle()
    const saved = stub.requests('PUT boards/acme/widgets').at(-1)?.body as { board: typeof BOARD }
    expect(saved.board.placements[19]).toBe('doing')
    expect(saved.board.order.doing).toEqual([19])
    expect(stub.board(KEY)?.board.placements[19]).toBe('doing')
  })

  it('server path: posts to api/issues and still makes no read of GitHub', async () => {
    const stub = await start({ githubAccess: { mode: 'server' }, github: ({ path }) => githubAnswer('GET', `/${path}`) })
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const apiCallsBefore = stub.calls.length
    await act(async () => {
      await result.current.create(input())
    })
    expect(result.current.snapshot.data?.issues).toHaveLength(2)
    expect(stub.requests('POST issues/acme/widgets')).toHaveLength(1)
    expect(githubCalls.filter((call) => call.path.includes('/repos/') && call.method === 'POST')).toEqual([])
    expect(stub.calls.slice(apiCallsBefore).filter((call) => call.path.startsWith('github/'))).toEqual([])
  })

  it('sends nothing to GitHub when the switch is off, and the pre-check reads it again', async () => {
    const stub = await start({ githubWrites: false })
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const before = githubCalls.length
    const error = await act(async () => result.current.create(input()).catch((reason: unknown) => reason))
    expect(error).toBeInstanceOf(CreateIssueError)
    expect(error).toMatchObject({ kind: 'writes-off', outcome: 'not-created' })
    expect(githubCalls).toHaveLength(before)
    expect(stub.requests('GET settings')).toHaveLength(1)
  })

  it('notices a switch turned off after the board loaded', async () => {
    const stub = await start()
    const { result, queryClient } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    queryClient.setQueryData(SERVER_SETTINGS_QUERY_KEY, { githubWrites: true })
    stub.setGithubWrites(false)
    await expect(result.current.create(input())).rejects.toMatchObject({ kind: 'writes-off' })
    expect(queryClient.getQueryData(SERVER_SETTINGS_QUERY_KEY)).toEqual({ githubWrites: false })
  })

  it('a server 403 github-writes-off turns the cached switch off', async () => {
    const stub = await start({ githubAccess: { mode: 'server' }, github: ({ path }) => githubAnswer('GET', `/${path}`) })
    const { result, queryClient } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    stub.failNext('POST issues', { status: 403, error: 'github-writes-off' })
    await expect(result.current.create(input())).rejects.toMatchObject({ kind: 'writes-off' })
    expect(queryClient.getQueryData(SERVER_SETTINGS_QUERY_KEY)).toEqual({ githubWrites: false })
    expect(result.current.snapshot.data?.issues).toHaveLength(1)
  })

  it('reloads the session after a server-access failure other than unavailable', async () => {
    const stub = await start({ githubAccess: { mode: 'server' }, github: ({ path }) => githubAnswer('GET', `/${path}`) })
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const sessionReads = stub.requests('GET session').length
    stub.failNext('POST issues', { status: 424, error: 'github-access', body: { error: 'github-access', message: 'x', problem: 'not-linked' } })
    await expect(result.current.create(input())).rejects.toMatchObject({ kind: 'server-access', problem: 'not-linked' })
    await waitFor(() => expect(stub.requests('GET session').length).toBe(sessionReads + 1))
    stub.failNext('POST issues', { status: 424, error: 'github-access', body: { error: 'github-access', message: 'x', problem: 'unavailable' } })
    await expect(result.current.create(input())).rejects.toMatchObject({ problem: 'unavailable' })
    await settle()
    expect(stub.requests('GET session').length).toBe(sessionReads + 1)
  })

  it('without a pasted token on the browser path nothing is sent at all', async () => {
    const stub = await start()
    useSettings.setState({ token: '  ' })
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const before = githubCalls.length
    const apiBefore = stub.calls.length
    await expect(result.current.create(input())).rejects.toMatchObject({ kind: 'no-token', action: 'open-settings' })
    expect(githubCalls).toHaveLength(before)
    expect(stub.calls).toHaveLength(apiBefore)
  })

  it('refuses invalid fields before any request', async () => {
    const stub = await start()
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const apiBefore = stub.calls.length
    await expect(result.current.create({ ...input(), fields: { title: '   ' } })).rejects.toMatchObject({ kind: 'invalid' })
    expect(stub.calls).toHaveLength(apiBefore)
  })

  it('a stop during the pre-check sends nothing to GitHub and is not-created', async () => {
    const stub = await start()
    const { result, queryClient } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    queryClient.removeQueries({ queryKey: SERVER_SETTINGS_QUERY_KEY })
    const gate = stub.hold('GET settings')
    const stop = new AbortController()
    const before = githubCalls.length
    const pending = result.current.create({ ...input(), signal: stop.signal })
    await settle()
    stop.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'stopped', outcome: 'not-created' })
    gate.release()
    expect(githubCalls).toHaveLength(before)
  })

  it('a pre-check that fails is unreachable and nothing is sent to GitHub', async () => {
    const stub = await start()
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const before = githubCalls.length
    stub.failNext('GET settings', { status: 500, error: 'server-error' })
    await expect(result.current.create(input())).rejects.toMatchObject({ kind: 'unreachable', outcome: 'not-created' })
    stub.failNext('GET settings', { status: 401, error: 'signed-out' })
    await expect(result.current.create(input())).rejects.toMatchObject({ kind: 'signed-out' })
    expect(githubCalls).toHaveLength(before)
  })

  it('a failed create leaves the snapshot and the board as they were', async () => {
    const stub = await start()
    githubAnswerOverride(() => json({ message: 'Bad credentials' }, 401))
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const puts = stub.requests('PUT boards').length
    await expect(result.current.create(input())).rejects.toMatchObject({ kind: 'token-rejected' })
    expect(result.current.snapshot.data?.issues).toHaveLength(1)
    await settle()
    expect(stub.requests('PUT boards')).toHaveLength(puts)
  })

  it('a 409 on the placement save adopts the stored board like a card move, and the card stays', async () => {
    const stub = await start()
    const { result } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    const theirs = { ...BOARD, buckets: BOARD.buckets.map((bucket) => (bucket.id === 'backlog' ? { ...bucket, title: 'Theirs' } : bucket)) }
    stub.putBoard(KEY, theirs, { id: 'u2', username: 'grace' })
    await act(async () => {
      await result.current.create(input('doing'))
    })
    await settle()
    expect(result.current.board.conflict).toEqual({ kind: 'stale', by: 'grace' })
    expect(result.current.board.board?.buckets[0].title).toBe('Theirs')
    expect(result.current.snapshot.data?.issues.map((issue) => issue.number)).toContain(19)
  })

  it('cancels a snapshot fetch in flight so the new card is not overwritten, and does not restart it', async () => {
    await start()
    const { result, queryClient } = render()
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined())
    let release = () => {}
    snapshotGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reads = githubCalls.length
    await act(async () => {
      void result.current.snapshot.refetch()
    })
    await waitFor(() => expect(queryClient.isFetching({ queryKey: ['snapshot'] })).toBe(1))
    await act(async () => {
      await result.current.create(input())
    })
    release()
    await settle()
    expect(result.current.snapshot.isFetching).toBe(false)
    expect(result.current.snapshot.data?.issues.map((issue) => issue.number)).toEqual([1, 19])
    // One read started for the refetch and was cancelled, then the POST; no read was started again.
    expect(githubCalls.slice(reads).filter((call) => call.method === 'GET').length).toBe(1)
    expect(githubCalls.slice(reads).filter((call) => call.method === 'POST')).toHaveLength(1)
  })
})

/** Replaces the POST answer for the next test body only; the beforeEach stub restores the default. */
function githubAnswerOverride(answer: () => Response) {
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) =>
    (init?.method ?? 'GET') === 'POST' && String(url).startsWith('https://api.github.com/') ? Promise.resolve(answer()) : inner(url, init),
  )
}
