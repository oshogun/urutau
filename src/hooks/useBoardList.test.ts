import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installApiStub } from '../test/apiStub'
import { makeBoard, makeBucket } from '../test/fixtures'
import { useBoards } from '../state/boardStore'
import { useSession } from '../state/session'
import { bindQueryClient, useBoardList } from './useBoardList'
import { useBoard } from './useBoard'
import { useV1Import } from './useV1Import'

const board = makeBoard([makeBucket('todo')])

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return { queryClient, wrapper }
}

beforeEach(() => {
  useBoards.setState({ entries: {} })
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
})

describe('useBoardList', () => {
  it("returns the server's list, newest first, and refetches after a create", async () => {
    const stub = installApiStub()
    stub.putBoard('acme/old', board)
    stub.putBoard('acme/new', board)
    await useSession.getState().load()
    const { queryClient, wrapper } = setup()
    const unbind = bindQueryClient(queryClient)

    const { result } = renderHook(() => useBoardList(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.map((b) => b.repoKey)).toEqual(['acme/new', 'acme/old'])

    await act(() => useBoards.getState().create('acme/fresh', 'acme/fresh', board))
    await waitFor(() => expect(result.current.data?.[0].repoKey).toBe('acme/fresh'))
    unbind()
  })

  it('clears the query cache when the session changes', async () => {
    installApiStub()
    await useSession.getState().load()
    const { queryClient, wrapper } = setup()
    const unbind = bindQueryClient(queryClient)
    const { result } = renderHook(() => useBoardList(), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual([]))
    act(() => useSession.getState().markSignedOut())
    expect(queryClient.getQueryData(['boards'])).toBeUndefined()
    unbind()
  })

  it('settles a query that is in flight when the session changes', async () => {
    installApiStub()
    await useSession.getState().load()
    const { queryClient, wrapper } = setup()
    const unbind = bindQueryClient(queryClient)
    const { result } = renderHook(() => useBoardList(), { wrapper })
    expect(result.current.isLoading).toBe(true)
    act(() => useSession.getState().markSignedOut())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    unbind()
  })
})

describe('useBoard', () => {
  it('loads, creates and edits through the store', async () => {
    const stub = installApiStub()
    await useSession.getState().load()
    const { result } = renderHook(() => useBoard({ owner: 'Acme', name: 'Widgets' }), {
      wrapper: setup().wrapper,
    })
    expect(result.current.status).toBe('loading')
    await act(() => result.current.load())
    expect(result.current.status).toBe('missing')
    await act(() => result.current.create(board))
    expect(result.current).toMatchObject({ status: 'ready', key: 'acme/widgets' })
    expect(stub.board('acme/widgets')?.fullName).toBe('Acme/Widgets')
    await act(async () => result.current.update((b) => ({ ...b, closedWindowDays: 30 })))
    await waitFor(() => expect(stub.board('acme/widgets')?.board.closedWindowDays).toBe(30))
  })
})

describe('useV1Import', () => {
  it('offers the import, imports on request and then stops asking', async () => {
    installApiStub()
    localStorage.setItem('urutau:boards', JSON.stringify({ state: { boards: { 'acme/widgets': board } }, version: 1 }))
    await useSession.getState().load()
    const { result } = renderHook(() => useV1Import(), { wrapper: setup().wrapper })
    expect(result.current.pending).toBe(true)
    await act(() => result.current.importNow())
    expect(result.current.result?.imported).toEqual(['acme/widgets'])
    expect(result.current.pending).toBe(false)
    expect(localStorage.getItem('urutau:boards')).not.toBeNull()
  })

  it('keeps asking after a failed import and hides on "Not now" without writing', async () => {
    const stub = installApiStub()
    localStorage.setItem('urutau:boards', JSON.stringify({ state: { boards: { 'acme/widgets': board } }, version: 1 }))
    await useSession.getState().load()
    stub.failNext('POST boards/import', { status: 500, error: 'server-error', message: 'Boom.' })
    const { result } = renderHook(() => useV1Import(), { wrapper: setup().wrapper })
    await act(() => result.current.importNow())
    expect(result.current).toMatchObject({ pending: true, error: 'Boom.' })
    act(() => result.current.notNow())
    expect(result.current.pending).toBe(false)
    expect(localStorage.getItem('urutau:boards-import')).toBeNull()
  })
})
