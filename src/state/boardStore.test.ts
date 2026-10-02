import { beforeEach, describe, expect, it } from 'vitest'
import { createDefaultBoard, saveBucket } from '../domain/board'
import type { StoredBoard } from '../domain/api'
import type { BoardConfig } from '../domain/types'
import { installApiStub } from '../test/apiStub'
import { makeBoard, makeBucket } from '../test/fixtures'
import { useBoards } from './boardStore'
import { useSession } from './session'

const KEY = 'acme/widgets'
const base = makeBoard([makeBucket('todo'), makeBucket('done')])
const renamed = (board: BoardConfig, title: string): BoardConfig =>
  saveBucket(board, { ...board.buckets[0], title })

const stored = (version: number, board: BoardConfig, username = 'grace'): StoredBoard => ({
  repoKey: KEY,
  fullName: 'acme/widgets',
  version,
  updatedAt: '2026-10-02T12:00:00.000Z',
  updatedBy: { id: 'u2', username },
  board,
})

const entry = () => useBoards.getState().entries[KEY]
const edit = (title: string) =>
  useBoards.getState().update(KEY, 'acme/widgets', (board) => renamed(board, title))
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  useBoards.setState({ entries: {} })
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
})

async function signedIn(boards: StoredBoard[] = []) {
  const stub = installApiStub({ boards })
  await useSession.getState().load()
  return stub
}

describe('load', () => {
  it('stores the server board as ready', async () => {
    await signedIn([stored(3, base)])
    await useBoards.getState().load(KEY)
    expect(entry()).toMatchObject({ status: 'ready', board: base })
    expect(entry().stored?.version).toBe(3)
  })

  it('marks a repository without a board as missing', async () => {
    await signedIn()
    await useBoards.getState().load(KEY)
    expect(entry()).toMatchObject({ status: 'missing', board: null, stored: null })
  })

  it('reports a load failure as an error', async () => {
    const stub = await signedIn()
    stub.failNext('GET boards/acme/widgets', { status: 500, error: 'server-error', message: 'Boom.' })
    await useBoards.getState().load(KEY)
    expect(entry()).toMatchObject({ status: 'error', loadError: 'Boom.' })
  })
})

describe('create', () => {
  it('saves with a null base version and lists the board', async () => {
    const stub = await signedIn()
    await useBoards.getState().load(KEY)
    await useBoards.getState().create(KEY, 'Acme/Widgets', base)
    expect(stub.requests('PUT boards/acme/widgets')[0].body).toMatchObject({ baseVersion: null, fullName: 'Acme/Widgets' })
    expect(entry()).toMatchObject({ status: 'ready', saving: false, conflict: null })
    expect(entry().stored?.version).toBe(1)
  })

  it('adopts the server board without a notice when someone else created it first', async () => {
    const stub = await signedIn()
    await useBoards.getState().load(KEY)
    stub.putBoard('acme/widgets', renamed(base, 'Theirs'))
    await useBoards.getState().create(KEY, 'acme/widgets', base)
    expect(entry().conflict).toBeNull()
    expect(entry().board?.buckets[0].title).toBe('Theirs')
    expect(entry().stored?.version).toBe(1)
  })
})

describe('create conflicts with user edits', () => {
  it('sets the notice when the first create failed, the user edited, and the retry gets a 409', async () => {
    const stub = await signedIn()
    await useBoards.getState().load(KEY)
    stub.failNext('PUT boards/acme/widgets', { status: 500, error: 'server-error', message: 'Boom.' })
    await useBoards.getState().create(KEY, 'acme/widgets', base)
    expect(entry().saveError).toBe('Boom.')
    stub.putBoard('acme/widgets', renamed(base, 'Theirs'), { id: 'u2', username: 'grace' })
    edit('Mine')
    await settle()
    expect(entry().conflict).toEqual({ kind: 'stale', by: 'grace' })
    expect(entry().board?.buckets[0].title).toBe('Theirs')
  })

  it('sets the notice when the user edits while the create is in flight and it gets a 409', async () => {
    const stub = await signedIn()
    await useBoards.getState().load(KEY)
    const gate = stub.hold('PUT boards/acme/widgets')
    const created = useBoards.getState().create(KEY, 'acme/widgets', base)
    await settle()
    edit('Mine')
    stub.putBoard('acme/widgets', renamed(base, 'Theirs'), { id: 'u2', username: 'grace' })
    gate.release()
    await created
    await settle()
    expect(entry().conflict).toEqual({ kind: 'stale', by: 'grace' })
    expect(entry().board?.buckets[0].title).toBe('Theirs')
  })
})

describe('save queue', () => {
  it('replaces the board with the server one and sets the notice on a stale version', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    stub.putBoard('acme/widgets', renamed(base, 'Theirs'), { id: 'u2', username: 'grace' })
    edit('Mine')
    await settle()
    expect(entry().conflict).toEqual({ kind: 'stale', by: 'grace' })
    expect(entry().board?.buckets[0].title).toBe('Theirs')
    expect(entry()).toMatchObject({ saving: false, dirty: false })
    expect(entry().stored?.version).toBe(2)
  })

  it('reports a deleted board when the 409 carries no current board', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    stub.externalDelete(KEY)
    edit('Mine')
    await settle()
    expect(entry()).toMatchObject({ status: 'missing', board: null, conflict: { kind: 'deleted', by: null } })
  })

  it('keeps one request in flight and one queued, latest edit wins', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    const gate = stub.hold('PUT boards/acme/widgets')

    edit('first')
    edit('second')
    edit('third')
    await settle()
    expect(stub.requests('PUT boards/acme/widgets')).toHaveLength(1)
    expect(entry()).toMatchObject({ saving: true, dirty: true })
    expect(entry().board?.buckets[0].title).toBe('third')

    gate.release()
    await settle()
    await settle()
    const puts = stub.requests('PUT boards/acme/widgets')
    expect(puts).toHaveLength(2)
    expect((puts[0].body as { baseVersion: number; board: BoardConfig }).board.buckets[0].title).toBe('first')
    expect(puts[0].body).toMatchObject({ baseVersion: 1 })
    expect(puts[1].body).toMatchObject({ baseVersion: 2 })
    expect((puts[1].body as { board: BoardConfig }).board.buckets[0].title).toBe('third')
    expect(entry()).toMatchObject({ saving: false, dirty: false })
    expect(entry().stored?.version).toBe(3)
    expect(entry().board?.buckets[0].title).toBe('third')
  })

  it('never overwrites edits made while a save was in flight with its response', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    const gate = stub.hold('PUT boards/acme/widgets')
    edit('first')
    await settle()
    edit('second')
    gate.release()
    await settle()
    expect(entry().board?.buckets[0].title).toBe('second')
  })

  it('keeps the edit and offers a retry after another failure', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    stub.failNext('PUT boards/acme/widgets', { status: 500, error: 'server-error', message: 'Boom.' })
    edit('Mine')
    await settle()
    expect(entry()).toMatchObject({ saving: false, dirty: true, saveError: 'Boom.' })
    expect(entry().board?.buckets[0].title).toBe('Mine')
    expect(stub.requests('PUT boards/acme/widgets')).toHaveLength(1)

    useBoards.getState().retrySave(KEY)
    await settle()
    expect(stub.requests('PUT boards/acme/widgets')).toHaveLength(2)
    expect(entry()).toMatchObject({ dirty: false, saveError: null })
    expect(stub.board(KEY)?.board.buckets[0].title).toBe('Mine')
  })

  it('ignores an edit that returns the same board', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    useBoards.getState().update(KEY, 'acme/widgets', (board) => board)
    await settle()
    expect(stub.requests('PUT')).toHaveLength(0)
  })

  it('drops the answer to a save that finished after the session changed', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    const gate = stub.hold('PUT boards/acme/widgets')
    edit('Mine')
    await settle()
    useSession.getState().markSignedOut()
    expect(useBoards.getState().entries).toEqual({})
    gate.release()
    await settle()
    expect(useBoards.getState().entries).toEqual({})
  })
})

describe('load after a delete', () => {
  it('clears a deleted notice when the board was recreated', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    stub.externalDelete(KEY)
    await useBoards.getState().reloadIfIdle(KEY)
    expect(entry().conflict).toMatchObject({ kind: 'deleted' })
    stub.putBoard('acme/widgets', renamed(base, 'Recreated'))
    await useBoards.getState().load(KEY)
    expect(entry()).toMatchObject({ status: 'ready', conflict: null })
  })
})

describe('reloadIfIdle', () => {
  it('clears an old deleted notice when the board was recreated', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    stub.externalDelete(KEY)
    await useBoards.getState().reloadIfIdle(KEY)
    expect(entry()).toMatchObject({ status: 'missing', conflict: { kind: 'deleted' } })
    stub.putBoard('acme/widgets', renamed(base, 'Recreated'))
    await useBoards.getState().reloadIfIdle(KEY)
    expect(entry()).toMatchObject({ status: 'ready', conflict: null })
    expect(entry().board?.buckets[0].title).toBe('Recreated')
  })

  it('adopts a newer version when nothing is pending', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    stub.putBoard('acme/widgets', renamed(base, 'Theirs'))
    await useBoards.getState().reloadIfIdle(KEY)
    expect(entry().board?.buckets[0].title).toBe('Theirs')
    expect(entry().conflict).toBeNull()
  })

  it('leaves the board alone while an edit is pending', async () => {
    const stub = await signedIn([stored(1, base)])
    await useBoards.getState().load(KEY)
    stub.hold('PUT boards/acme/widgets')
    edit('Mine')
    await settle()
    const gets = stub.requests('GET boards/acme/widgets').length
    await useBoards.getState().reloadIfIdle(KEY)
    expect(stub.requests('GET boards/acme/widgets')).toHaveLength(gets)
  })
})

it('dismissConflict clears the notice', async () => {
  const stub = await signedIn([stored(1, base)])
  await useBoards.getState().load(KEY)
  stub.putBoard('acme/widgets', base)
  edit('Mine')
  await settle()
  useBoards.getState().dismissConflict(KEY)
  expect(entry().conflict).toBeNull()
})

it('defaults come from createDefaultBoard for a first save', async () => {
  const stub = await signedIn()
  await useBoards.getState().load(KEY)
  const board = createDefaultBoard([])
  await useBoards.getState().create(KEY, 'acme/widgets', board)
  expect(stub.board(KEY)?.board).toEqual(board)
})
