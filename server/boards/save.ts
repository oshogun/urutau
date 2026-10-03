import type { Kysely } from 'kysely'
import type { BoardUpdatedEvent, BoardDeletedEvent, StoredBoard } from '../../src/domain/api.ts'
import { createBoard, getBoard, saveBoard } from '../db/boards.ts'
import type { SaveOutcome, SaveRequest } from '../mcp/contract.ts'
import type { Tables } from '../db/schema.ts'
import { asBoardConfig, repoKeyOf } from './validate.ts'

export interface SaveDeps {
  db: Kysely<Tables>
  now: () => Date
  boardEvents: {
    publish(event: { type: 'board-updated'; data: BoardUpdatedEvent } | { type: 'board-deleted'; data: BoardDeletedEvent }): void
  }
}

/** The request breaks a rule the callers check first, so reaching this is a server bug. */
export class InvalidBoardSave extends Error {
  constructor() {
    super('invalid board save')
    this.name = 'InvalidBoardSave'
  }
}

/**
 * The one place a save writes the boards table and announces it: validates,
 * creates (baseVersion null) or saves over baseVersion, and on success
 * publishes exactly one board-updated event. A stale version or an existing
 * board writes nothing and publishes nothing.
 */
export async function saveAndPublish(deps: SaveDeps, request: SaveRequest): Promise<SaveOutcome> {
  if (asBoardConfig(request.board) === null || repoKeyOf(request.fullName) !== request.repoKey) throw new InvalidBoardSave()
  const { db } = deps
  const now = deps.now()
  const write = { repoKey: request.repoKey, fullName: request.fullName, config: request.board, userId: request.editor.id, now }
  let version: number
  if (request.baseVersion === null) {
    if (!(await createBoard(db, write))) return { saved: false, current: await getBoard(db, request.repoKey) }
    version = 1
  } else {
    const result = await saveBoard(db, { ...write, baseVersion: request.baseVersion })
    if (!result.saved) return { saved: false, current: await getBoard(db, request.repoKey) }
    version = result.version
  }
  const stored: StoredBoard = {
    repoKey: request.repoKey,
    fullName: request.fullName,
    version,
    updatedAt: now.toISOString(),
    updatedBy: { id: request.editor.id, username: request.editor.username, kind: request.editor.kind },
    board: request.board,
  }
  deps.boardEvents.publish({
    type: 'board-updated',
    data: { repoKey: stored.repoKey, version, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy, clientId: request.clientId },
  })
  return { saved: true, stored }
}
