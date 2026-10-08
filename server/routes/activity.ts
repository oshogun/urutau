import { Hono } from 'hono'
import {
  CLIENT_ID_HEADER,
  type AcceptItemResponse,
  type BoardActivityResponse,
  type ClaimChangedResponse,
  type IssueActivityResponse,
  type ItemResolvedResponse,
  type StaleBoardResponse,
  type StoredBoard,
} from '../../src/domain/api.ts'
import { clearEstimate, ESTIMATES_MAX, isEstimate, setEstimate } from '../../src/domain/estimates.ts'
import type { Estimate, EstimateConfidence, EstimateSize } from '../../src/domain/types.ts'
import type { AppContext } from '../app.ts'
import { saveAndPublish } from '../boards/save.ts'
import { repoKeyOf } from '../boards/validate.ts'
import { getBoard } from '../db/boards.ts'
import { isRecord, readJson, readOptionalJson } from '../http/body.ts'
import { HttpError, invalidRequest } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'
import { cleanText } from '../mcp/clean.ts'
import { RUN_LIMITS } from '../runs/types.ts'

const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/
const MAX_ISSUE_NUMBER = 2_147_483_647
const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/
const ITEM_ID = new RegExp(RUN_LIMITS.itemIdPattern)
const NOTE_INPUT_MAX = 1_000
const NOTE_MAX = 280
const ESTIMATE_ATTEMPTS = 3
const SIZES: readonly string[] = ['S', 'M', 'L']
const CONFIDENCES: readonly string[] = ['sure', 'unsure', 'no-idea']

function pathKey(owner: string, name: string): string {
  const key = repoKeyOf(`${owner}/${name}`)
  if (key === null) throw invalidRequest('The path must be a repository as owner/name.')
  return key
}

function pathIssue(text: string): number {
  if (!ISSUE_NUMBER.test(text) || Number(text) > MAX_ISSUE_NUMBER) throw invalidRequest('The issue number must be a whole number from 1.')
  return Number(text)
}

function pathRunId(text: string): string {
  if (!RUN_ID.test(text)) throw invalidRequest('The run id must be 1 to 64 letters, digits, dots, dashes or underscores.')
  return text
}

function parseEstimate(body: unknown): { size: EstimateSize | null; confidence: EstimateConfidence } {
  if (!isRecord(body)) throw invalidRequest('The request body must be an object.')
  const { size, confidence } = body
  if (typeof confidence !== 'string' || !CONFIDENCES.includes(confidence)) {
    throw invalidRequest('confidence must be sure, unsure or no-idea.')
  }
  if (confidence === 'no-idea') {
    if (size !== null) throw invalidRequest('size must be null when confidence is no-idea.')
  } else if (typeof size !== 'string' || !SIZES.includes(size)) {
    throw invalidRequest('size must be S, M or L unless confidence is no-idea.')
  }
  return { size: size as EstimateSize | null, confidence: confidence as EstimateConfidence }
}

/** Routes for what runs and claims show on cards, and for the people-only changes to them: estimates, releasing a claim, accepting a normative item. */
export function activityRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()
  const db = ctx.database.db

  function clientId(c: { req: { header(name: string): string | undefined } }): string | null {
    return c.req.header(CLIENT_ID_HEADER) ?? null
  }

  routes.get('/boards/:owner/:name/activity', async (c) => {
    const key = pathKey(c.req.param('owner'), c.req.param('name'))
    const body: BoardActivityResponse = await ctx.runs.boardActivity(key, ctx.now())
    return c.json(body)
  })

  routes.get('/boards/:owner/:name/activity/:number', async (c) => {
    const key = pathKey(c.req.param('owner'), c.req.param('name'))
    const issue = pathIssue(c.req.param('number'))
    const body: IssueActivityResponse = await ctx.runs.issueActivity(key, issue, ctx.now())
    return c.json(body)
  })

  /** Saves the board with `change` applied to the stored one, retrying on a stale version; `change` returns null when nothing needs saving. */
  async function changeBoard(
    c: { req: { header(name: string): string | undefined } },
    key: string,
    user: { id: string; username: string },
    change: (stored: StoredBoard) => StoredBoard['board'] | null,
  ): Promise<StoredBoard> {
    let current: StoredBoard | null = null
    for (let attempt = 0; attempt < ESTIMATE_ATTEMPTS; attempt += 1) {
      const stored = await getBoard(db, key)
      if (!stored) throw new HttpError(404, 'not-found', 'There is no board for this repository.')
      const next = change(stored)
      if (next === null) return stored
      const outcome = await saveAndPublish({ db, now: ctx.now, boardEvents: ctx.boardEvents }, {
        repoKey: key,
        baseVersion: stored.version,
        fullName: stored.fullName,
        board: next,
        editor: { id: user.id, username: user.username, kind: 'person' },
        clientId: clientId(c),
      })
      if (outcome.saved) return outcome.stored
      current = outcome.current
    }
    const body: Omit<StaleBoardResponse, 'error' | 'message'> = { current }
    throw new HttpError(409, 'stale-board', 'The board changed since you loaded it.', { extra: body })
  }

  routes.put('/boards/:owner/:name/estimates/:number', async (c) => {
    const key = pathKey(c.req.param('owner'), c.req.param('name'))
    const issue = pathIssue(c.req.param('number'))
    const { size, confidence } = parseEstimate(await readJson(c))
    const user = c.get('auth')!.user
    const at = ctx.now().toISOString()
    const estimate: Estimate = { size, confidence, by: user.username, at }
    if (!isEstimate(estimate)) throw invalidRequest('The estimate could not be stored.')
    const stored = await changeBoard(c, key, user, (board) => {
      const prior = board.board.estimates?.[issue]
      if (prior && prior.size === size && prior.confidence === confidence) return null
      if (!prior && Object.keys(board.board.estimates ?? {}).length >= ESTIMATES_MAX) {
        throw invalidRequest(`This board already has ${ESTIMATES_MAX} estimates.`)
      }
      return setEstimate(board.board, issue, estimate)
    })
    return c.json(stored)
  })

  routes.delete('/boards/:owner/:name/estimates/:number', async (c) => {
    const key = pathKey(c.req.param('owner'), c.req.param('name'))
    const issue = pathIssue(c.req.param('number'))
    const user = c.get('auth')!.user
    const stored = await changeBoard(c, key, user, (board) => {
      const next = clearEstimate(board.board, issue)
      return next === board.board ? null : next
    })
    return c.json(stored)
  })

  routes.delete('/boards/:owner/:name/claims/:number', async (c) => {
    const key = pathKey(c.req.param('owner'), c.req.param('name'))
    const issue = pathIssue(c.req.param('number'))
    const runId = pathRunId(c.req.query('runId') ?? '')
    const outcome = await ctx.runs.releaseClaim(key, issue, runId)
    if (!outcome.released) {
      if (outcome.current === null) throw new HttpError(404, 'not-found', 'There is no claim on this issue.')
      const body: Omit<ClaimChangedResponse, 'error' | 'message'> = { current: outcome.current }
      throw new HttpError(409, 'claim-changed', 'Another run now holds this issue.', { extra: body })
    }
    ctx.log.info('claim released', { user: c.get('auth')!.user.id, repo: key, issue, runId })
    ctx.boardEvents.publish({ type: 'card-activity', data: { repoKey: key, issue, clientId: clientId(c) } })
    return c.body(null, 204)
  })

  routes.post('/boards/:owner/:name/runs/:runId/items/:itemId/accept', async (c) => {
    const key = pathKey(c.req.param('owner'), c.req.param('name'))
    const runId = pathRunId(c.req.param('runId'))
    const itemId = c.req.param('itemId')
    if (!ITEM_ID.test(itemId)) throw invalidRequest('The item id must be 1 to 32 letters, digits, dots, dashes or underscores.')
    const body = await readOptionalJson(c)
    if (!isRecord(body)) throw invalidRequest('The request body must be an object.')
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > NOTE_INPUT_MAX)) {
      throw invalidRequest(`note must be text of at most ${NOTE_INPUT_MAX} characters.`)
    }
    const note = typeof body.note === 'string' ? cleanText(body.note, NOTE_MAX) || null : null
    const user = c.get('auth')!.user
    const outcome = await ctx.runs.acceptItem({ repoKey: key, runId, itemId, userId: user.id, note }, ctx.now())
    if (outcome.kind === 'not-found') throw new HttpError(404, 'not-found', 'There is no such item on this run.')
    if (outcome.kind === 'not-normative') {
      throw invalidRequest('Only normative items are accepted by a person; a probe closes the others.')
    }
    if (outcome.kind === 'resolved') {
      const conflict: Omit<ItemResolvedResponse, 'error' | 'message'> = { item: outcome.item }
      throw new HttpError(409, 'item-resolved', 'This item was already closed.', { extra: conflict })
    }
    const issue = await issueOfRun(runId)
    if (issue !== null) ctx.boardEvents.publish({ type: 'card-activity', data: { repoKey: key, issue, clientId: clientId(c) } })
    const response: AcceptItemResponse = { item: outcome.item }
    return c.json(response, 201)
  })

  async function issueOfRun(runId: string): Promise<number | null> {
    const row = await db.selectFrom('card_runs').select('issue').where('run_id', '=', runId).executeTakeFirst()
    return row ? row.issue : null
  }

  return routes
}
