import { afterEach, describe, expect, test } from 'vitest'
import type {
  AcceptItemResponse,
  BoardActivityResponse,
  ClaimChangedResponse,
  IssueActivityResponse,
  ItemResolvedResponse,
  StoredBoard,
} from '../../src/domain/api.ts'
import { boardFromExport, toBoardExport } from '../../src/domain/board.ts'
import { ESTIMATES_MAX } from '../../src/domain/estimates.ts'
import { sha256Hex } from '../auth/tokens.ts'
import { SESSION_COOKIE } from '../auth/sessions.ts'
import { fixtureBoard } from '../db/fixtures.ts'
import { createIntegration } from '../db/integrations.ts'
import { createSession } from '../db/sessions.ts'
import { createAccount } from '../db/users.ts'
import { createTestApp, type TestApp } from '../testing/harness.ts'
import type { RecordRunInput } from '../runs/types.ts'

const ADMIN = { username: 'admin', password: 'correct horse battery' }
const BOARD = '/api/boards/acme/widgets'
const REPO = 'acme/widgets'

let h: TestApp
let botId: string
afterEach(async () => {
  await h.close()
})

async function setUp(): Promise<void> {
  h = await createTestApp()
  expect((await h.post('/api/auth/first-run', ADMIN)).status).toBe(201)
  const admin = await h.database.db.selectFrom('users').select('id').where('username', '=', 'admin').executeTakeFirstOrThrow()
  botId = (await createIntegration(h.database.db, { username: 'carcara', createdBy: admin.id, now: h.clock.now })).id
  expect((await h.put(BOARD, { baseVersion: null, fullName: REPO, board: fixtureBoard() })).status).toBe(201)
  h.events.length = 0
}

const run = (runId: string, extra: Partial<RecordRunInput> = {}): RecordRunInput => ({
  repoKey: REPO,
  issue: 3,
  runId,
  agentUserId: botId,
  status: 'running',
  ...extra,
})
const storedBoard = async () => (await (await h.get(BOARD)).json()) as StoredBoard
const claimRows = () => h.database.db.selectFrom('card_claims').selectAll().execute()
const runRows = () => h.database.db.selectFrom('card_runs').selectAll().execute()
const eventRows = () => h.database.db.selectFrom('run_events').selectAll().execute()
const ACCEPT = (runId: string, itemId: string) => `${BOARD}/runs/${runId}/items/${itemId}/accept`

/** Requests carrying the cookie and CSRF token of a session row planted for the account. */
async function asUser(userId: string, method: string, path: string, body?: unknown): Promise<Response> {
  await createSession(h.database.db, {
    idHash: sha256Hex('planted-bot'),
    userId,
    authMethod: 'local',
    csrfToken: 'c'.repeat(43),
    now: h.clock.now,
    expiresAt: new Date(h.clock.now.getTime() + 60_000),
  })
  return h.newClient().request(path, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=planted-bot`, 'X-Urutau-CSRF': 'c'.repeat(43), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const WRITES: { name: string; method: string; path: string; body?: unknown }[] = [
  { name: 'set estimate', method: 'PUT', path: `${BOARD}/estimates/3`, body: { size: 'M', confidence: 'sure' } },
  { name: 'clear estimate', method: 'DELETE', path: `${BOARD}/estimates/3` },
  { name: 'release claim', method: 'DELETE', path: `${BOARD}/claims/3?runId=r-1` },
  { name: 'accept item', method: 'POST', path: ACCEPT('r-1', 'N1'), body: {} },
]

describe('who may call the people-only routes', () => {
  test.each(WRITES)('$name: no session is 401, an integration session is 401, and nothing changes', async ({ method, path, body }) => {
    await setUp()
    await h.ctx.runs.recordRun(run('r-1', { unverified: [{ id: 'N1', kind: 'normative', text: 'Spec says X' }] }), h.clock.now)
    const before = { board: await storedBoard(), claims: await claimRows(), events: await eventRows() }
    h.events.length = 0

    const anonymous = await h.newClient().send(method, path, body)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ error: 'signed-out' })
    const bot = await asUser(botId, method, path, body)
    expect(bot.status).toBe(401)

    expect(await storedBoard()).toEqual(before.board)
    expect(await claimRows()).toEqual(before.claims)
    expect(await eventRows()).toEqual(before.events)
    expect(h.events).toEqual([])
  })

  test('the reads are 401 without a session', async () => {
    await setUp()
    expect((await h.newClient().get(`${BOARD}/activity`)).status).toBe(401)
    expect((await h.newClient().get(`${BOARD}/activity/3`)).status).toBe(401)
  })

  test('a bearer token on /api is ignored', async () => {
    await setUp()
    const response = await h.newClient().send('DELETE', `${BOARD}/claims/3?runId=r-1`, undefined, { authorization: 'Bearer urutau_mcp_not_a_real_token' })
    expect(response.status).toBe(401)
  })
})

describe('estimates', () => {
  test('a person sets one: the server stamps by and at, the version goes up and one board-updated is published', async () => {
    await setUp()
    const response = await h.put(`${BOARD}/estimates/3`, { size: 'M', confidence: 'unsure', by: 'someone-else', at: '2000-01-01T00:00:00.000Z' }, { 'X-Urutau-Client': 'tab-1' })
    expect(response.status).toBe(200)
    const stored = (await response.json()) as StoredBoard
    expect(stored.version).toBe(2)
    expect(stored.board.estimates).toEqual({ 3: { size: 'M', confidence: 'unsure', by: 'admin', at: h.clock.now.toISOString() } })
    expect(h.events).toEqual([
      { type: 'board-updated', data: expect.objectContaining({ repoKey: REPO, version: 2, clientId: 'tab-1' }) },
    ])
    expect(await storedBoard()).toEqual(stored)
  })

  test('no-idea needs a null size, the other confidences need S, M or L', async () => {
    await setUp()
    for (const body of [
      { size: 'M', confidence: 'no-idea' },
      { size: null, confidence: 'sure' },
      { size: 'XL', confidence: 'sure' },
      { size: 'S', confidence: 'maybe' },
      { size: 'S' },
      [],
    ]) {
      expect({ body, status: (await h.put(`${BOARD}/estimates/3`, body)).status }).toEqual({ body, status: 400 })
    }
    expect((await h.put(`${BOARD}/estimates/3`, { size: null, confidence: 'no-idea' })).status).toBe(200)
    expect((await h.put(`${BOARD}/estimates/0`, { size: 'S', confidence: 'sure' })).status).toBe(400)
    expect((await h.put(`${BOARD}/estimates/2147483648`, { size: 'S', confidence: 'sure' })).status).toBe(400)
    expect((await storedBoard()).version).toBe(2)
  })

  test('an unchanged estimate saves nothing; a missing board is 404', async () => {
    await setUp()
    await h.put(`${BOARD}/estimates/3`, { size: 'L', confidence: 'sure' })
    h.clock.advance(60_000)
    h.events.length = 0
    const again = await h.put(`${BOARD}/estimates/3`, { size: 'L', confidence: 'sure' })
    expect(again.status).toBe(200)
    expect(((await again.json()) as StoredBoard).version).toBe(2)
    expect(h.events).toEqual([])
    expect((await h.put('/api/boards/acme/none/estimates/3', { size: 'L', confidence: 'sure' })).status).toBe(404)
    expect((await h.delete('/api/boards/acme/none/estimates/3')).status).toBe(404)
  })

  test('clearing removes it and drops the field with the last one; clearing a missing estimate saves nothing', async () => {
    await setUp()
    await h.put(`${BOARD}/estimates/3`, { size: 'L', confidence: 'sure' })
    const cleared = await h.delete(`${BOARD}/estimates/3`)
    expect(cleared.status).toBe(200)
    const stored = (await cleared.json()) as StoredBoard
    expect(stored.version).toBe(3)
    expect('estimates' in stored.board).toBe(false)
    h.events.length = 0
    expect(((await (await h.delete(`${BOARD}/estimates/3`)).json()) as StoredBoard).version).toBe(3)
    expect(h.events).toEqual([])
  })

  test('a board with 2000 estimates takes no new one but accepts a change to an existing one', async () => {
    await setUp()
    const estimates = Object.fromEntries(
      Array.from({ length: ESTIMATES_MAX }, (_, i) => [i + 1, { size: 'S', confidence: 'sure', by: 'admin', at: h.clock.now.toISOString() }]),
    )
    expect((await h.put(BOARD, { baseVersion: 1, fullName: REPO, board: { ...fixtureBoard(), estimates } })).status).toBe(200)
    const refused = await h.put(`${BOARD}/estimates/${ESTIMATES_MAX + 1}`, { size: 'S', confidence: 'sure' })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ message: 'This board already has 2000 estimates.' })
    expect((await h.put(`${BOARD}/estimates/5`, { size: 'L', confidence: 'sure' })).status).toBe(200)
  })

  test('survives a board export and import', async () => {
    await setUp()
    await h.put(`${BOARD}/estimates/3`, { size: 'M', confidence: 'sure' })
    await h.put(`${BOARD}/estimates/4`, { size: null, confidence: 'no-idea' })
    const before = await storedBoard()
    const file = JSON.parse(JSON.stringify(toBoardExport(before.board, REPO))) as unknown
    const imported = boardFromExport(file, REPO)
    expect(imported).toEqual(before.board)
    expect((await h.delete(BOARD + '?version=' + before.version)).status).toBe(204)
    const result = await h.post('/api/boards/import', { boards: { [REPO]: imported } })
    expect(await result.json()).toMatchObject({ imported: [REPO] })
    const after = await storedBoard()
    expect(after.board).toEqual(before.board)
    expect(after.board.estimates?.[3]).toMatchObject({ size: 'M', by: 'admin' })
  })

  test('humanWaitLimit saves and reads back through the board save', async () => {
    await setUp()
    expect((await h.put(BOARD, { baseVersion: 1, fullName: REPO, board: { ...fixtureBoard(), humanWaitLimit: 24 } })).status).toBe(200)
    expect((await storedBoard()).board.humanWaitLimit).toBe(24)
    expect((await h.put(BOARD, { baseVersion: 2, fullName: REPO, board: { ...fixtureBoard(), humanWaitLimit: 0 } })).status).toBe(400)
  })
})

describe('releasing a claim', () => {
  test('deletes the claim, keeps the run row and the board version, and publishes card-activity with the client id', async () => {
    await setUp()
    await h.ctx.runs.recordRun(run('r-1', { status: 'needs_human' }), h.clock.now)
    const runsBefore = await runRows()
    const response = await h.delete(`${BOARD}/claims/3?runId=r-1`, { 'X-Urutau-Client': 'tab-2' })
    expect(response.status).toBe(204)
    expect(await claimRows()).toEqual([])
    expect(await runRows()).toEqual(runsBefore)
    expect((await storedBoard()).version).toBe(1)
    expect(h.events).toEqual([{ type: 'card-activity', data: { repoKey: REPO, issue: 3, clientId: 'tab-2' } }])
    expect(h.logs.join('\n')).toContain('claim released')
  })

  test('is 404 without a claim, and 409 claim-changed with the current one when another run holds the issue', async () => {
    await setUp()
    expect((await h.delete(`${BOARD}/claims/3?runId=r-1`)).status).toBe(404)
    await h.ctx.runs.recordRun(run('r-2'), h.clock.now)
    h.events.length = 0
    const conflict = await h.delete(`${BOARD}/claims/3?runId=r-1`)
    expect(conflict.status).toBe(409)
    const body = (await conflict.json()) as ClaimChangedResponse
    expect(body).toMatchObject({ error: 'claim-changed', current: { runId: 'r-2', status: 'running', holder: { username: 'carcara', kind: 'integration' } } })
    expect(await claimRows()).toHaveLength(1)
    expect(h.events).toEqual([])
  })

  test('rejects a missing or malformed run id, and a bad issue number', async () => {
    await setUp()
    for (const path of [`${BOARD}/claims/3`, `${BOARD}/claims/3?runId=`, `${BOARD}/claims/3?runId=a%20b`, `${BOARD}/claims/0?runId=r-1`, `${BOARD}/claims/x?runId=r-1`]) {
      expect({ path, status: (await h.delete(path)).status }).toEqual({ path, status: 400 })
    }
  })
})

describe('accepting an item', () => {
  const seed = () =>
    h.ctx.runs.recordRun(
      run('r-1', {
        status: 'done',
        unverified: [
          { id: 'N1', kind: 'normative', text: 'Spec says X' },
          { id: 'E1', kind: 'external', text: 'Server returns 200' },
        ],
      }),
      h.clock.now,
    )

  test('appends an accepted event with the note and leaves the run row and the board version unchanged', async () => {
    await setUp()
    await seed()
    const runsBefore = await runRows()
    const response = await h.post(ACCEPT('r-1', 'N1'), { note: '  agreed\n in review ' }, { 'X-Urutau-Client': 'tab-3' })
    expect(response.status).toBe(201)
    const body = (await response.json()) as AcceptItemResponse
    expect(body.item).toMatchObject({ id: 'N1', kind: 'normative', runId: 'r-1', resolution: { kind: 'accepted', note: 'agreed in review', by: { username: 'admin', kind: 'person' } } })
    expect(await eventRows()).toMatchObject([{ run_id: 'r-1', kind: 'accepted', resolves: 'N1' }])
    expect(await runRows()).toEqual(runsBefore)
    expect((await storedBoard()).version).toBe(1)
    expect(h.events).toEqual([{ type: 'card-activity', data: { repoKey: REPO, issue: 3, clientId: 'tab-3' } }])
    const activity = (await (await h.get(`${BOARD}/activity/3`)).json()) as IssueActivityResponse
    expect(activity.runs[0].items.find((item) => item.id === 'N1')?.resolution).toMatchObject({ kind: 'accepted' })
    expect(activity.runs[0].unverifiedOpen).toEqual({ external: 1, normative: 0, untested: 0 })
  })

  test('works without a body', async () => {
    await setUp()
    await seed()
    const response = await h.post(ACCEPT('r-1', 'N1'))
    expect(response.status).toBe(201)
    expect(((await response.json()) as AcceptItemResponse).item.resolution).toMatchObject({ note: null })
  })

  test('a second accept is 409 item-resolved with the stored resolution and adds no event', async () => {
    await setUp()
    await seed()
    await h.post(ACCEPT('r-1', 'N1'), { note: 'first' })
    h.events.length = 0
    const again = await h.post(ACCEPT('r-1', 'N1'), { note: 'second' })
    expect(again.status).toBe(409)
    expect(((await again.json()) as ItemResolvedResponse)).toMatchObject({ error: 'item-resolved', item: { resolution: { note: 'first' } } })
    expect(await eventRows()).toHaveLength(1)
    expect(h.events).toEqual([])
  })

  test('refuses a non-normative item, an unknown item or run, and a note over 1000 characters', async () => {
    await setUp()
    await seed()
    const external = await h.post(ACCEPT('r-1', 'E1'), {})
    expect(external.status).toBe(400)
    expect(await external.json()).toMatchObject({ message: 'Only normative items are accepted by a person; a probe closes the others.' })
    expect((await h.post(ACCEPT('r-1', 'N9'), {})).status).toBe(404)
    expect((await h.post(ACCEPT('r-9', 'N1'), {})).status).toBe(404)
    expect((await h.post('/api/boards/other/repo/runs/r-1/items/N1/accept', {})).status).toBe(404)
    expect((await h.post(ACCEPT('r-1', 'N1'), { note: 'x'.repeat(1001) })).status).toBe(400)
    expect((await h.post(ACCEPT('r-1', 'N1'), { note: 5 })).status).toBe(400)
    expect(await eventRows()).toEqual([])
  })

  test('an item of a run on another repository path is 404, with no event row and nothing published', async () => {
    await setUp()
    await seed()
    h.events.length = 0
    const response = await h.post('/api/boards/acme/other/runs/r-1/items/N1/accept', {})
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'not-found' })
    expect(await eventRows()).toEqual([])
    expect(h.events).toEqual([])
  })

  test('a person other than the admin may accept', async () => {
    await setUp()
    await seed()
    const bea = await createAccount(h.database.db, { username: 'bea', displayName: null, passwordHash: null, now: h.clock.now })
    if (!bea.created) throw new Error('account not created')
    expect((await asUser(bea.user.id, 'POST', ACCEPT('r-1', 'N1'), {})).status).toBe(201)
    expect(await eventRows()).toMatchObject([{ by: bea.user.id }])
  })
})

describe('reading activity', () => {
  test('lists cards with claims and last runs, and an issue with its runs, for any signed-in person', async () => {
    await setUp()
    await h.ctx.runs.recordRun(run('r-1', { status: 'awaiting_approval', triageRange: 'M' }), h.clock.now)
    const board = (await (await h.get(`${BOARD}/activity`)).json()) as BoardActivityResponse
    expect(board).toMatchObject({ repoKey: REPO, cards: [{ issue: 3, claim: { runId: 'r-1', status: 'awaiting_approval', leaseUntil: null }, lastRun: { runId: 'r-1', triageRange: 'M' } }] })
    const issue = (await (await h.get(`${BOARD}/activity/3`)).json()) as IssueActivityResponse
    expect(issue).toMatchObject({ repoKey: REPO, issue: 3, moreRuns: false, runs: [{ runId: 'r-1', agent: { username: 'carcara', kind: 'integration' } }] })
    expect(JSON.stringify(issue)).not.toMatch(/costUsd|fixRounds|mergeShas/)
    expect(await (await h.get(`${BOARD}/activity/4`)).json()).toMatchObject({ claim: null, runs: [] })
    expect((await h.get(`${BOARD}/activity/abc`)).status).toBe(400)
    expect((await h.get('/api/boards/acme/none/activity')).status).toBe(200)
  })
})
