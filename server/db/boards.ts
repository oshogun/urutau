import { sql, type Kysely } from 'kysely'
import type { BoardSummary, StoredBoard } from '../../src/domain/api.ts'
import type { BoardConfig } from '../../src/domain/types.ts'
import { insertIgnoringDuplicate, iso } from './helpers.ts'
import type { Tables } from './schema.ts'

const LIST_LIMIT = 500

export interface NewBoard {
  repoKey: string
  fullName: string
  config: BoardConfig
  userId: string | null
  now: Date
}

export interface BoardSave {
  repoKey: string
  baseVersion: number
  fullName: string
  config: BoardConfig
  userId: string | null
  now: Date
}

export type SaveBoardResult =
  | { saved: true; version: number }
  /** The stored version is not `baseVersion` (or the board is gone); the caller reads the current row. */
  | { saved: false }

interface BoardRow {
  repo_key: string
  full_name: string
  version: number
  updated_at: string
  updated_by: string | null
  username: string | null
}

function summary(row: BoardRow): BoardSummary {
  return {
    repoKey: row.repo_key,
    fullName: row.full_name,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by !== null && row.username !== null ? { id: row.updated_by, username: row.username } : null,
  }
}

function boardQuery(db: Kysely<Tables>) {
  return db
    .selectFrom('boards')
    .leftJoin('users', 'users.id', 'boards.updated_by')
    .select([
      'boards.repo_key',
      'boards.full_name',
      'boards.version',
      'boards.updated_at',
      'boards.updated_by',
      'users.username as username',
    ])
}

/** Inserts a board at version 1; returns false when the repository already has one. */
export async function createBoard(db: Kysely<Tables>, board: NewBoard): Promise<boolean> {
  const at = iso(board.now)
  return insertIgnoringDuplicate(db, 'boards', {
    repo_key: board.repoKey,
    full_name: board.fullName,
    config: JSON.stringify(board.config),
    version: 1,
    created_at: at,
    updated_at: at,
    updated_by: board.userId,
  })
}

/**
 * One UPDATE guarded by the version the edit started from; the affected-row
 * count says whether it applied. Never read-then-write, so two saves from the
 * same version cannot both succeed.
 */
export async function saveBoard(db: Kysely<Tables>, save: BoardSave): Promise<SaveBoardResult> {
  const result = await db
    .updateTable('boards')
    .set({
      config: JSON.stringify(save.config),
      full_name: save.fullName,
      version: sql<number>`version + 1`,
      updated_at: iso(save.now),
      updated_by: save.userId,
    })
    .where('repo_key', '=', save.repoKey)
    .where('version', '=', save.baseVersion)
    .executeTakeFirst()
  return result.numUpdatedRows === 1n ? { saved: true, version: save.baseVersion + 1 } : { saved: false }
}

/** Deletes the board only if it is still at `version`; returns whether a row was removed. */
export async function deleteBoard(db: Kysely<Tables>, repoKey: string, version: number): Promise<boolean> {
  const result = await db
    .deleteFrom('boards')
    .where('repo_key', '=', repoKey)
    .where('version', '=', version)
    .executeTakeFirst()
  return result.numDeletedRows === 1n
}

export async function getBoard(db: Kysely<Tables>, repoKey: string): Promise<StoredBoard | null> {
  const row = await boardQuery(db).select('boards.config').where('boards.repo_key', '=', repoKey).executeTakeFirst()
  if (!row) return null
  return { ...summary(row), board: JSON.parse(row.config) as BoardConfig }
}

/** Every board, most recently updated first, at most 500. */
export async function listBoards(db: Kysely<Tables>): Promise<BoardSummary[]> {
  const rows = await boardQuery(db)
    .orderBy('boards.updated_at', 'desc')
    .orderBy('boards.repo_key', 'asc')
    .limit(LIST_LIMIT)
    .execute()
  return rows.map(summary)
}
