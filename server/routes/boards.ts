import { Hono } from 'hono'
import {
  CLIENT_ID_HEADER,
  type BoardListResponse,
  type ImportBoardsResponse,
  type SaveBoardRequest,
  type StaleBoardResponse,
  type StoredBoard,
} from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { asBoardConfig, isBoardVersion, repoKeyOf } from '../boards/validate.ts'
import { createBoard, deleteBoard, getBoard, listBoards, saveBoard } from '../db/boards.ts'
import { isRecord, readJson } from '../http/body.ts'
import { HttpError, invalidRequest } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'

function pathKey(owner: string, name: string): string {
  const key = repoKeyOf(`${owner}/${name}`)
  if (key === null) throw invalidRequest('The path must be a repository as owner/name.')
  return key
}

function parseSave(body: unknown, key: string): SaveBoardRequest {
  if (!isRecord(body)) throw invalidRequest('The request body must be an object.')
  const { baseVersion, fullName, board } = body
  if (baseVersion !== null && !isBoardVersion(baseVersion)) {
    throw invalidRequest('baseVersion must be null or a whole number from 1.')
  }
  if (typeof fullName !== 'string' || repoKeyOf(fullName) !== key) {
    throw invalidRequest('fullName must be the repository in the path, in any letter case.')
  }
  const config = asBoardConfig(board)
  if (!config) throw invalidRequest('board is not a valid board configuration.')
  return { baseVersion: baseVersion as number | null, fullName, board: config }
}

export function boardsRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()
  const db = ctx.database.db

  function clientId(c: { req: { header(name: string): string | undefined } }): string | null {
    return c.req.header(CLIENT_ID_HEADER) ?? null
  }

  async function stale(key: string): Promise<HttpError> {
    const body: Omit<StaleBoardResponse, 'error' | 'message'> = { current: await getBoard(db, key) }
    return new HttpError(409, 'stale-board', 'The board changed since you loaded it.', { extra: body })
  }

  routes.get('/boards', async (c) => {
    const body: BoardListResponse = { boards: await listBoards(db) }
    return c.json(body)
  })

  routes.post('/boards/import', async (c) => {
    const body = await readJson(c)
    if (!isRecord(body) || !isRecord(body.boards)) throw invalidRequest('The request body must be { boards: { … } }.')
    const user = c.get('auth')!.user
    const now = ctx.now()
    const result: ImportBoardsResponse = { imported: [], skipped: [], invalid: [] }
    for (const [key, value] of Object.entries(body.boards)) {
      const config = asBoardConfig(value)
      if (config === null || repoKeyOf(key) !== key) {
        result.invalid.push(key)
        continue
      }
      const created = await createBoard(db, { repoKey: key, fullName: key, config, userId: user.id, now })
      ;(created ? result.imported : result.skipped).push(key)
    }
    for (const key of result.imported) {
      ctx.boardEvents.publish({
        type: 'board-updated',
        data: {
          repoKey: key,
          version: 1,
          updatedAt: now.toISOString(),
          updatedBy: { id: user.id, username: user.username },
          clientId: clientId(c),
        },
      })
    }
    return c.json(result)
  })

  routes.get('/boards/:owner/:name', async (c) => {
    const board = await getBoard(db, pathKey(c.req.param('owner'), c.req.param('name')))
    if (!board) throw new HttpError(404, 'not-found', 'There is no board for this repository.')
    return c.json(board)
  })

  routes.put('/boards/:owner/:name', async (c) => {
    const key = pathKey(c.req.param('owner'), c.req.param('name'))
    const request = parseSave(await readJson(c), key)
    const user = c.get('auth')!.user
    const now = ctx.now()
    let version: number
    if (request.baseVersion === null) {
      const created = await createBoard(db, { repoKey: key, fullName: request.fullName, config: request.board, userId: user.id, now })
      if (!created) throw await stale(key)
      version = 1
    } else {
      const result = await saveBoard(db, {
        repoKey: key,
        baseVersion: request.baseVersion,
        fullName: request.fullName,
        config: request.board,
        userId: user.id,
        now,
      })
      if (!result.saved) throw await stale(key)
      version = result.version
    }
    const stored: StoredBoard = {
      repoKey: key,
      fullName: request.fullName,
      version,
      updatedAt: now.toISOString(),
      updatedBy: { id: user.id, username: user.username },
      board: request.board,
    }
    ctx.boardEvents.publish({
      type: 'board-updated',
      data: { repoKey: key, version, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy, clientId: clientId(c) },
    })
    return c.json(stored, request.baseVersion === null ? 201 : 200)
  })

  routes.delete('/boards/:owner/:name', async (c) => {
    const key = pathKey(c.req.param('owner'), c.req.param('name'))
    const raw = c.req.query('version')
    const version = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(version) || version < 1) throw invalidRequest('The version query parameter must be a whole number from 1.')
    if (!(await deleteBoard(db, key, version))) {
      const error = await stale(key)
      if (error.extra.current === null) throw new HttpError(404, 'not-found', 'There is no board for this repository.')
      throw error
    }
    ctx.boardEvents.publish({ type: 'board-deleted', data: { repoKey: key, clientId: clientId(c) } })
    return c.body(null, 204)
  })

  return routes
}
