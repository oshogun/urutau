import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportBoardsResponse } from '../domain/api'
import { installApiStub } from '../test/apiStub'
import { makeBoard, makeBucket } from '../test/fixtures'
import { useSession } from './session'
import {
  declineV1Import,
  importV1Boards,
  isV1ImportPending,
  readImportMarker,
  readV1Board,
  v1BoardExport,
} from './v1Import'

const board = makeBoard([makeBucket('todo'), makeBucket('done')])
const other = makeBoard([makeBucket('a')])

function storeV1(boards: Record<string, unknown>) {
  const raw = JSON.stringify({ state: { boards }, version: 1 })
  localStorage.setItem('urutau:boards', raw)
  return raw
}

async function signedIn(boards = []) {
  const stub = installApiStub({ boards })
  await useSession.getState().load()
  return stub
}

beforeEach(() => {
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
})

describe('v1 import', () => {
  it('is pending only with v1 boards and no marker for this instance', async () => {
    await signedIn()
    expect(isV1ImportPending()).toBe(false)
    storeV1({ 'acme/widgets': board })
    expect(isV1ImportPending()).toBe(true)
    localStorage.setItem(
      'urutau:boards-import',
      JSON.stringify({ instanceId: 'another-instance', outcome: 'declined', at: '2026-10-02T00:00:00Z' }),
    )
    expect(isV1ImportPending()).toBe(true)
    localStorage.setItem('urutau:boards-import', 'not json')
    expect(readImportMarker()).toBeNull()
    expect(isV1ImportPending()).toBe(true)
  })

  it('posts every board once, writes the marker, and leaves urutau:boards as it was', async () => {
    const stub = await signedIn()
    const raw = storeV1({ 'acme/widgets': board, 'acme/other': other, 'not a key': board })
    const result = await importV1Boards()
    expect(stub.requests('POST boards/import')).toHaveLength(1)
    expect(Object.keys((stub.requests('POST boards/import')[0].body as { boards: object }).boards)).toEqual([
      'acme/widgets',
      'acme/other',
      'not a key',
    ])
    expect(result).toEqual<ImportBoardsResponse>({
      imported: ['acme/widgets', 'acme/other'],
      skipped: [],
      invalid: ['not a key'],
    })
    expect(readImportMarker()).toMatchObject({ instanceId: 'instance-test', outcome: 'imported' })
    expect(localStorage.getItem('urutau:boards')).toBe(raw)
    expect(isV1ImportPending()).toBe(false)
  })

  it('leaves localStorage untouched and writes no marker when the request fails', async () => {
    const stub = await signedIn()
    const raw = storeV1({ 'acme/widgets': board })
    stub.failNext('POST boards/import', { status: 500, error: 'server-error', message: 'Boom.' })
    await expect(importV1Boards()).rejects.toMatchObject({ message: 'Boom.' })
    expect(localStorage.getItem('urutau:boards')).toBe(raw)
    expect(localStorage.getItem('urutau:boards-import')).toBeNull()
    expect(isV1ImportPending()).toBe(true)
  })

  it('reports a board the server already has as skipped and offers its local copy', async () => {
    const stub = await signedIn()
    stub.putBoard('acme/widgets', other)
    storeV1({ 'acme/widgets': board })
    const result = await importV1Boards()
    expect(result.skipped).toEqual(['acme/widgets'])
    expect(stub.board('acme/widgets')?.board).toEqual(other)
    expect(v1BoardExport('acme/widgets')).toMatchObject({
      app: 'urutau',
      repository: 'acme/widgets',
      board,
    })
  })

  it('"Don\'t ask again" writes a declined marker and keeps the boards', async () => {
    await signedIn()
    const raw = storeV1({ 'acme/widgets': board })
    declineV1Import()
    expect(readImportMarker()).toMatchObject({ outcome: 'declined' })
    expect(localStorage.getItem('urutau:boards')).toBe(raw)
    expect(isV1ImportPending()).toBe(false)
  })

  it('readV1Board returns the board until the user has answered', async () => {
    await signedIn()
    storeV1({ 'acme/widgets': board, 'acme/broken': { version: 1 } })
    expect(readV1Board('acme/widgets')).toEqual(board)
    expect(readV1Board('acme/broken')).toBeNull()
    expect(readV1Board('acme/missing')).toBeNull()
    declineV1Import()
    expect(readV1Board('acme/widgets')).toBeNull()
    expect(v1BoardExport('acme/widgets')?.board).toEqual(board)
  })

  it('readV1Board returns null when the instance id is unknown, so a declined marker cannot be missed', async () => {
    await signedIn()
    storeV1({ 'acme/widgets': board })
    declineV1Import()
    useSession.setState({ config: null })
    expect(readV1Board('acme/widgets')).toBeNull()
  })

  it('treats unreadable stored data as no boards', async () => {
    await signedIn()
    localStorage.setItem('urutau:boards', '{oops')
    expect(isV1ImportPending()).toBe(false)
    localStorage.setItem('urutau:boards', JSON.stringify({ state: { boards: [1] }, version: 1 }))
    expect(isV1ImportPending()).toBe(false)
  })
})
