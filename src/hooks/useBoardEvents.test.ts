import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_ID } from '../api/client'
import type { BoardUpdatedEvent } from '../domain/api'
import { saveBucket } from '../domain/board'
import { useBoards } from '../state/boardStore'
import { useSession } from '../state/session'
import { installApiStub } from '../test/apiStub'
import type { ApiStub } from '../test/apiStub'
import { makeBoard, makeBucket } from '../test/fixtures'
import { reopenDelay, useBoardEvents } from './useBoardEvents'

const REPO = { owner: 'acme', name: 'widgets' }
const KEY = 'acme/widgets'
const base = makeBoard([makeBucket('todo'), makeBucket('done')])
const renamed = (title: string) => saveBucket(base, { ...base.buckets[0], title })
const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
const gets = (stub: ApiStub) => stub.requests('GET boards/acme/widgets').length

let stub: ApiStub

beforeEach(async () => {
  useBoards.setState({ entries: {} })
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
  stub = installApiStub()
  stub.putBoard('acme/widgets', base)
  await useSession.getState().load()
  await useBoards.getState().load(KEY)
})

afterEach(() => {
  vi.useRealTimers()
})

async function mount(enabled = true) {
  const hook = renderHook(() => useBoardEvents(REPO, enabled))
  await tick()
  return hook
}

const updated = (version: number, clientId: string | null, repoKey = KEY): BoardUpdatedEvent => ({
  repoKey,
  version,
  updatedAt: '2026-10-02T12:00:00.000Z',
  updatedBy: { id: 'u2', username: 'grace' },
  clientId,
})

describe('useBoardEvents', () => {
  it('is live after hello and does not reload when the version matches', async () => {
    const { result } = await mount()
    expect(result.current.connection).toBe('live')
    expect(stub.openStreams()).toBe(1)
    expect(gets(stub)).toBe(1)
  })

  it('reloads once on a newer version and reports who changed it', async () => {
    const { result } = await mount()
    const saved = stub.externalSave('acme/widgets', renamed('Theirs'))
    await tick()
    expect(gets(stub)).toBe(2)
    expect(useBoards.getState().entries[KEY].board?.buckets[0].title).toBe('Theirs')
    expect(result.current.lastRemoteChange).toEqual({ by: 'grace', kind: 'person', at: saved.updatedAt, version: 2 })
  })

  it('reports an integration account as the kind of the change', async () => {
    const { result } = await mount()
    stub.externalSave('acme/widgets', renamed('Agent'), { id: 'int-1', username: 'planner-bot', kind: 'integration' })
    await tick()
    expect(result.current.lastRemoteChange).toMatchObject({ by: 'planner-bot', kind: 'integration' })
  })

  it('reads a missing kind as a person', async () => {
    const { result } = await mount()
    stub.externalSave('acme/widgets', renamed('Old'), { id: 'u3', username: 'linus' })
    await tick()
    expect(result.current.lastRemoteChange).toMatchObject({ by: 'linus', kind: 'person' })
  })

  it('ignores the event for its own save', async () => {
    await mount()
    stub.putBoard('acme/widgets', renamed('Mine'))
    stub.emitBoardEvent(KEY, 'board-updated', updated(2, CLIENT_ID))
    await tick()
    expect(gets(stub)).toBe(1)
  })

  it('ignores an event for another repository', async () => {
    await mount()
    stub.emitBoardEvent(KEY, 'board-updated', updated(5, null, 'acme/other'))
    await tick()
    expect(gets(stub)).toBe(1)
  })

  it('does not overwrite a pending edit with a remote version', async () => {
    await mount()
    const gate = stub.hold('PUT boards/acme/widgets')
    useBoards.getState().update(KEY, 'acme/widgets', () => renamed('Mine'))
    await tick()
    stub.externalSave('acme/widgets', renamed('Theirs'))
    await tick()
    expect(gets(stub)).toBe(1)
    expect(useBoards.getState().entries[KEY].board?.buckets[0].title).toBe('Mine')
    gate.release()
    await tick()
    expect(useBoards.getState().entries[KEY].conflict).toMatchObject({ kind: 'stale', by: 'grace' })
  })

  it('marks the board missing with a deleted notice on board-deleted', async () => {
    await mount()
    stub.externalDelete(KEY)
    await tick()
    expect(useBoards.getState().entries[KEY]).toMatchObject({
      status: 'missing',
      board: null,
      conflict: { kind: 'deleted' },
    })
    expect(stub.requests('POST boards')).toHaveLength(0)
    expect(stub.requests('PUT')).toHaveLength(0)
  })

  it('ignores board-deleted while a save is in flight', async () => {
    await mount()
    const gate = stub.hold('PUT boards/acme/widgets')
    useBoards.getState().update(KEY, 'acme/widgets', () => renamed('Mine'))
    await tick()
    expect(useBoards.getState().entries[KEY].saving).toBe(true)
    stub.externalDelete(KEY)
    await tick()
    expect(useBoards.getState().entries[KEY]).toMatchObject({ status: 'ready', conflict: null })
    expect(useBoards.getState().entries[KEY].board?.buckets[0].title).toBe('Mine')
    gate.release()
  })

  it('ignores board-deleted while an unsaved edit is pending', async () => {
    await mount()
    stub.failNext('PUT boards/acme/widgets', { status: 500, error: 'server-error', message: 'Boom.' })
    useBoards.getState().update(KEY, 'acme/widgets', () => renamed('Mine'))
    await tick()
    expect(useBoards.getState().entries[KEY]).toMatchObject({ dirty: true, saving: false })
    stub.externalDelete(KEY)
    await tick()
    expect(useBoards.getState().entries[KEY]).toMatchObject({ status: 'ready', conflict: null, dirty: true })
    expect(useBoards.getState().entries[KEY].board?.buckets[0].title).toBe('Mine')
  })

  it('closes the stream on unmount', async () => {
    const { unmount } = await mount()
    expect(stub.openStreams()).toBe(1)
    unmount()
    expect(stub.openStreams()).toBe(0)
  })

  it('opens no stream while disabled', async () => {
    const { result } = await mount(false)
    expect(stub.openStreams()).toBe(0)
    expect(result.current.connection).toBe('offline')
  })

  it('closes while the document is hidden and reopens when visible', async () => {
    await mount()
    const state = vi.spyOn(document, 'visibilityState', 'get')
    state.mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(stub.openStreams()).toBe(0)
    state.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await tick()
    expect(stub.openStreams()).toBe(1)
  })

  it('refetches on reconnect when a change was missed', async () => {
    const { result } = await mount()
    stub.putBoard('acme/widgets', renamed('Missed'))
    act(() => stub.failStreams('reconnect'))
    expect(result.current.connection).toBe('reconnecting')
    await tick()
    expect(result.current.connection).toBe('live')
    expect(gets(stub)).toBe(2)
    expect(useBoards.getState().entries[KEY].board?.buckets[0].title).toBe('Missed')
    expect(result.current.lastRemoteChange).toBeNull()
  })

  it('reopens a closed stream after the backoff delay', async () => {
    const { result } = await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stub.failStreams('closed')
    await act(async () => {})
    expect(stub.requests('GET session').length).toBeGreaterThan(0)
    expect(result.current.connection).toBe('offline')
    expect(stub.openStreams()).toBe(0)
    await act(async () => vi.advanceTimersByTime(999))
    expect(stub.openStreams()).toBe(0)
    await act(async () => vi.advanceTimersByTime(1))
    await act(async () => {})
    expect(stub.openStreams()).toBe(1)
  })

  it('goes to the signed-out state when the session ended', async () => {
    await mount()
    stub.failNext('GET session', { status: 200, body: { signedIn: false, firstRun: false } })
    stub.failStreams('closed')
    await waitFor(() => expect(useSession.getState().status).toBe('signed-out'))
    expect(stub.openStreams()).toBe(0)
  })
})

it('reopenDelay doubles from one second up to thirty', () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(reopenDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
})
