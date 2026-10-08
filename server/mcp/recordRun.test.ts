import { afterEach, describe, expect, test } from 'vitest'
import type { StoredBoard } from '../../src/domain/api.ts'
import type { BoardConfig } from '../../src/domain/types.ts'
import { createGitHubStub, stubIssue } from '../testing/githubStub.ts'
import { createTestApp, setUpAgent, signInFirstAdmin, TEST_ENCRYPTION_KEY, type AgentSetup, type TestApp } from '../testing/harness.ts'
import type { GetBoardJson, McpToolErrorCode, RecordRunJson } from './contract.ts'
import { TOOL_ERROR_TEXT } from './contract.ts'

const REPO = 'acme/widgets'

let h: TestApp
afterEach(async () => {
  await h.close()
})

const board = (extra: Partial<BoardConfig> = {}): BoardConfig => ({
  version: 1,
  buckets: [
    { id: 'todo', title: 'To do', wipLimit: null, labelRules: [], collectsClosed: false },
    { id: 'done', title: 'Done', wipLimit: null, labelRules: [], collectsClosed: true },
  ],
  placements: {},
  order: {},
  closedWindowDays: 14,
  ...extra,
})

async function setUp(options: { board?: BoardConfig | null } = {}) {
  const stub = createGitHubStub({ [REPO]: { id: 1, private: false, items: [stubIssue(1), stubIssue(2), stubIssue(3)] } })
  h = await createTestApp({ config: { tokenEncryptionKey: TEST_ENCRYPTION_KEY }, fetch: stub.fetch })
  await signInFirstAdmin(h)
  const agent = await setUpAgent(h, { repos: [REPO] })
  if (options.board !== null) {
    const created = await h.put(`/api/boards/${REPO}`, { baseVersion: null, fullName: REPO, board: options.board ?? board() })
    expect(created.status).toBe(201)
  }
  const events: { type: string; data: unknown }[] = []
  h.hub.subscribe(REPO, 'viewer', { send: (event) => void events.push(event), close() {} })
  return { stub, agent, events }
}

const run = (agent: AgentSetup, args: Record<string, unknown>) =>
  agent.bearer.tool('record_run', { repo: REPO, issue: 2, runId: 'r-1', status: 'running', ...args })
const ok = async (agent: AgentSetup, args: Record<string, unknown> = {}) => {
  const reply = await run(agent, args)
  expect(reply.isError, reply.text).toBe(false)
  return reply.structured as unknown as RecordRunJson
}
const errorOf = async (agent: AgentSetup, args: Record<string, unknown>) => {
  const reply = await run(agent, args)
  expect(reply.isError).toBe(true)
  return JSON.parse(reply.text) as { error: McpToolErrorCode; message: string } & Record<string, unknown>
}
const storedBoard = async () => (await (await h.get(`/api/boards/${REPO}`)).json()) as StoredBoard
const rows = {
  runs: () => h.database.db.selectFrom('card_runs').selectAll().execute(),
  claims: () => h.database.db.selectFrom('card_claims').selectAll().execute(),
  events: () => h.database.db.selectFrom('run_events').selectAll().execute(),
}

describe('record_run', () => {
  test('claims the card, never touches the board version and publishes one card-activity event', async () => {
    const { agent, events, stub } = await setUp()
    const before = await storedBoard()
    const boardEvents = h.events.length
    const out = await ok(agent)
    expect(out).toMatchObject({
      repo: REPO,
      issue: 2,
      runId: 'r-1',
      status: 'running',
      created: true,
      statusChanged: true,
      claim: { held: true, leaseUntil: new Date(h.clock.now.getTime() + 1_800_000).toISOString() },
      unverifiedOpen: { external: 0, normative: 0, untested: 0 },
      notified: true,
    })
    expect(await storedBoard()).toEqual(before)
    expect(events).toEqual([{ type: 'card-activity', data: { repoKey: REPO, issue: 2, clientId: null } }])
    expect(h.events).toHaveLength(boardEvents)
    expect(stub.calls).toHaveLength(0)
  })

  test('a heartbeat that only renews the lease publishes nothing, a status change publishes one', async () => {
    const { agent, events } = await setUp()
    await ok(agent)
    events.length = 0
    h.clock.advance(600_000)
    const beat = await ok(agent, { files: ['src/a.ts'], costUsd: 0.1234567 })
    expect(beat).toMatchObject({ created: false, statusChanged: false, notified: false })
    expect(beat.claim.leaseUntil).toBe(new Date(h.clock.now.getTime() + 1_800_000).toISOString())
    expect(events).toEqual([])
    expect((await rows.runs())[0].cost_usd).toBe(0.123457)

    const paused = await ok(agent, { status: 'needs_human' })
    expect(paused).toMatchObject({ statusChanged: true, notified: true, claim: { held: true, leaseUntil: null } })
    expect(events).toHaveLength(1)
    expect((await storedBoard()).version).toBe(1)
  })

  test('a second running run on a claimed issue gets claimed-by-other-run and records nothing', async () => {
    const { agent, events } = await setUp()
    await ok(agent)
    const other = await setUpAgent(h, { username: 'other-bot', repos: [REPO], githubToken: false })
    events.length = 0
    const refused = await errorOf(other, { runId: 'r-2' })
    expect(refused).toEqual({ error: 'claimed-by-other-run', message: TOOL_ERROR_TEXT['claimed-by-other-run'] })
    expect(events).toEqual([])
    expect((await rows.runs()).map((r) => r.run_id)).toEqual(['r-1'])
    expect((await rows.claims())[0].run_id).toBe('r-1')
  })

  test('a call on an ended run gets run-finished with the status it ended with, and the claim is gone', async () => {
    const { agent } = await setUp()
    await ok(agent)
    const done = await ok(agent, { status: 'done' })
    expect(done).toMatchObject({ status: 'done', claim: { held: false, leaseUntil: null } })
    expect(await rows.claims()).toEqual([])
    const again = await errorOf(agent, { status: 'running' })
    expect(again).toEqual({ error: 'run-finished', message: TOOL_ERROR_TEXT['run-finished'], runStatus: 'done' })
  })

  test('refuses a runId used for another issue, and the store errors for items', async () => {
    const { agent } = await setUp()
    await ok(agent, { unverified: [{ id: 'U1', kind: 'external', text: 'GitHub sends it on 403.' }] })
    expect((await errorOf(agent, { issue: 3 })).error).toBe('run-id-taken')
    expect((await errorOf(agent, { unverified: [{ id: 'U1', kind: 'untested', text: 'GitHub sends it on 403.' }] })).error).toBe('item-changed')
    expect((await errorOf(agent, { probes: [{ item: 'U9' }] })).error).toBe('unknown-item')
    expect((await errorOf(agent, { withdrawn: ['U9'] })).error).toBe('unknown-item')
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `N${i}`, kind: 'untested', text: 'x' }))
    expect((await errorOf(agent, { unverified: many })).error).toBe('too-many-items')
  })

  test('checks duplicates and empty text before the database', async () => {
    const { agent } = await setUp()
    const item = { id: 'U1', kind: 'external', text: 'one' }
    expect((await errorOf(agent, { unverified: [item, item] })).error).toBe('duplicate-item')
    expect((await errorOf(agent, { probes: [{ item: 'U1' }, { item: 'U1' }] })).error).toBe('duplicate-item')
    expect((await errorOf(agent, { withdrawn: ['U1', 'U1'] })).error).toBe('duplicate-item')
    expect((await errorOf(agent, { probes: [{ item: 'U1' }], withdrawn: ['U1'] })).error).toBe('probed-and-withdrawn')
    expect((await errorOf(agent, { unverified: [{ ...item, text: '​ \u0007 ' }] })).error).toBe('invalid-text')
    expect((await errorOf(agent, { findings: '\u0007' })).error).toBe('invalid-text')
    expect((await errorOf(agent, { unverified: [item], probes: [{ item: 'U1', note: '​' }] })).error).toBe('invalid-text')
    expect(await rows.runs()).toEqual([])
  })

  test('probes close external and untested items, a withdrawal takes one back, and only a person closes a normative one', async () => {
    const { agent } = await setUp()
    const items = [
      { id: 'U1', kind: 'external', text: 'a' },
      { id: 'U2', kind: 'normative', text: 'b' },
      { id: 'U3', kind: 'untested', text: 'c' },
    ]
    const started = await ok(agent, { unverified: items })
    expect(started.unverifiedOpen).toEqual({ external: 1, normative: 1, untested: 1 })
    expect((await errorOf(agent, { probes: [{ item: 'U2' }] })).error).toBe('item-needs-a-person')
    expect((await errorOf(agent, { withdrawn: ['U2'] })).error).toBe('item-needs-a-person')
    const next = await ok(agent, { probes: [{ item: 'U1', note: 'checked' }], withdrawn: ['U3'] })
    expect(next).toMatchObject({ probesApplied: 1, withdrawnApplied: 1, unverifiedOpen: { external: 0, normative: 1, untested: 0 }, notified: true })
    expect((await rows.events()).map((e) => [e.kind, e.resolves, e.by])).toEqual([['probe', 'U1', (await h.database.db.selectFrom('users').select('id').where('username', '=', 'planner-bot').executeTakeFirstOrThrow()).id]])
  })

  test('refuses an accepted event and every unknown key, and no tool sets an estimate, releases a claim or accepts an item', async () => {
    const { agent } = await setUp()
    await ok(agent, { unverified: [{ id: 'U2', kind: 'normative', text: 'b' }] })
    for (const extra of [
      { probes: [{ item: 'U2', kind: 'accepted' }] },
      { kind: 'accepted' },
      { estimate: { size: 'S', confidence: 'sure' } },
      { release: true },
      { accept: ['U2'] },
    ]) {
      const reply = await run(agent, extra)
      expect(reply.isError).toBe(true)
      expect(reply.text).not.toContain('"error"')
    }
    const names = ((await agent.bearer.rpc('tools/list')).result.tools as { name: string }[]).map((tool) => tool.name).sort()
    expect(names).toEqual(['get_board', 'list_boards', 'move_card', 'record_run', 'reorder_bucket'])
    expect(await rows.events()).toEqual([])
    expect((await storedBoard()).board.estimates).toBeUndefined()
    expect(await rows.claims()).toHaveLength(1)
  })

  test('rejects an issue that is not a positive integer, and a repository off the integration list', async () => {
    const { agent } = await setUp()
    for (const issue of [0, -1, 1.5, 2147483648, '7']) expect((await run(agent, { issue })).isError).toBe(true)
    const off = await agent.bearer.tool('record_run', { repo: 'acme/other', issue: 1, runId: 'r-9', status: 'running' })
    expect(JSON.parse(off.text).error).toBe('repo-not-allowed')
    expect(await rows.runs()).toEqual([])
  })

  test('a holding status needs a board, a terminal status does not', async () => {
    const { agent } = await setUp({ board: null })
    expect((await errorOf(agent, { status: 'running' })).error).toBe('no-board')
    expect((await errorOf(agent, { status: 'needs_human' })).error).toBe('no-board')
    expect(await rows.runs()).toEqual([])
    expect(await ok(agent, { runId: 'r-7', status: 'plan_only' })).toMatchObject({ status: 'plan_only', claim: { held: false } })
  })

  test('needs neither a GitHub token nor a GitHub request', async () => {
    const { stub } = await setUp()
    const bare = await setUpAgent(h, { username: 'bare-bot', repos: [REPO], githubToken: false })
    expect(await ok(bare, { runId: 'r-bare', issue: 3 })).toMatchObject({ created: true })
    expect(stub.calls).toHaveLength(0)
  })

  test('answers the output schema and keeps the board version through a whole run', async () => {
    const { agent } = await setUp()
    await ok(agent)
    await ok(agent, { status: 'awaiting_approval' })
    await ok(agent, { status: 'running' })
    await ok(agent, { status: 'done', findings: 'All good.' })
    expect((await storedBoard()).version).toBe(1)
  })
})

describe('the event stream', () => {
  test('sends card-activity as an SSE event with the repository, issue and a null client id, and nothing for a heartbeat', async () => {
    const { agent } = await setUp()
    const cookie = [...h.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await h.app.request(`/api/events?repo=${REPO}`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read().catch(() => ({ value: undefined, done: true }))
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
    })()
    const count = () => text.match(/event: card-activity/g)?.length ?? 0
    const until = async (done: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(text)}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    await until(() => text.includes('event: hello'))
    await ok(agent)
    await until(() => count() === 1)
    expect(text).toContain('event: card-activity\ndata: {"repoKey":"acme/widgets","issue":2,"clientId":null}')
    await ok(agent, { fixRounds: 1 })
    await ok(agent, { status: 'done' })
    await until(() => count() === 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(count()).toBe(2)
    await reader.cancel()
    await pump
  })
})

describe('get_board with runs', () => {
  test('carries the estimate, last run and claim on cards, and the waiting list with the limit', async () => {
    const estimate = { size: 'S', confidence: 'unsure', by: 'ada', at: '2026-10-07T09:00:00.000Z' }
    const { agent } = await setUp({ board: board({ humanWaitLimit: 1, estimates: { 2: estimate as never } }) })
    await ok(agent, { unverified: [{ id: 'U1', kind: 'external', text: 'x' }], triageRange: 'M-L', status: 'needs_human' })
    const read = (await agent.bearer.tool('get_board', { repo: REPO })).structured as unknown as GetBoardJson
    const cards = read.buckets.flatMap((bucket) => bucket.cards)
    const card2 = cards.find((card) => card.number === 2)
    expect(card2).toMatchObject({
      estimate,
      lastRun: { runId: 'r-1', status: 'needs_human', triageRange: 'M-L', unverifiedOpen: { external: 1, normative: 0, untested: 0 } },
      claim: { runId: 'r-1', status: 'needs_human', since: h.clock.now.toISOString() },
    })
    expect(cards.find((card) => card.number === 1)).toMatchObject({ estimate: null, lastRun: null, claim: null })
    expect(read.humanWaitLimit).toBe(1)
    expect(read.waitingOnHuman).toEqual([{ issue: 2, runId: 'r-1', status: 'needs_human', since: h.clock.now.toISOString(), overLimit: false }])

    h.clock.advance(3_600_001)
    const later = (await agent.bearer.tool('get_board', { repo: REPO })).structured as unknown as GetBoardJson
    expect(later.waitingOnHuman[0].overLimit).toBe(true)
  })

  test('a claim whose lease passed is absent, and a finished run leaves a last run without a claim', async () => {
    const { agent } = await setUp()
    await ok(agent)
    h.clock.advance(1_800_000)
    const expired = (await agent.bearer.tool('get_board', { repo: REPO })).structured as unknown as GetBoardJson
    expect(expired.buckets.flatMap((b) => b.cards).find((c) => c.number === 2)).toMatchObject({ claim: null, lastRun: { status: 'running' } })
    await ok(agent, { runId: 'r-2', issue: 3, status: 'done' })
    const finished = (await agent.bearer.tool('get_board', { repo: REPO })).structured as unknown as GetBoardJson
    expect(finished.buckets.flatMap((b) => b.cards).find((c) => c.number === 3)).toMatchObject({ claim: null, lastRun: { runId: 'r-2', status: 'done' } })
  })

  test('move_card on a board with estimates and a limit saves both unchanged', async () => {
    const estimate = { size: 'M', confidence: 'sure', by: 'ada', at: '2026-10-07T09:00:00.000Z' }
    const config = board({ humanWaitLimit: 12, estimates: { 2: estimate as never } })
    const { agent } = await setUp({ board: config })
    const moved = await agent.bearer.tool('move_card', { repo: REPO, issue: 2, bucket: 'done', position: 'top' })
    expect(moved.isError, moved.text).toBe(false)
    const after = await storedBoard()
    expect(after.version).toBe(2)
    expect(after.board.estimates).toEqual({ 2: estimate })
    expect(after.board.humanWaitLimit).toBe(12)
    const reordered = await agent.bearer.tool('reorder_bucket', { repo: REPO, bucket: 'todo', order: [1, 3] })
    expect(reordered.isError, reordered.text).toBe(false)
    const last = await storedBoard()
    expect(last.board.estimates).toEqual({ 2: estimate })
    expect(last.board.humanWaitLimit).toBe(12)
  })
})
