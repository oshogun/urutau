import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../db/index.ts'
import { createIntegration } from '../db/integrations.ts'
import { createAccount } from '../db/users.ts'
import { createRunStore, insertRunEvent, isRetryableTransactionError } from './store.ts'
import { RunStoreError, RUN_LIMITS, type RecordRunInput, type RunStore } from './types.ts'

const T0 = new Date('2026-10-08T12:00:00.000Z')
const later = (ms: number) => new Date(T0.getTime() + ms)
const REPO = 'acme/widgets'

let database: Database
let runs: RunStore
let a: string
let b: string
let person: string

beforeEach(async () => {
  database = await openDatabase('sqlite::memory:')
  await database.migrate()
  const admin = await createAccount(database.db, { username: 'ada', displayName: null, passwordHash: null, now: T0 })
  if (!admin.created) throw new Error('account not created')
  person = admin.user.id
  a = (await createIntegration(database.db, { username: 'carcara', createdBy: person, now: T0 })).id
  b = (await createIntegration(database.db, { username: 'other-bot', createdBy: person, now: T0 })).id
  runs = createRunStore(database.db)
})
afterEach(async () => {
  await database.close()
})

const call = (runId: string, extra: Partial<RecordRunInput> = {}, agent = a, issue = 7): RecordRunInput => ({
  repoKey: REPO,
  issue,
  runId,
  agentUserId: agent,
  status: 'running',
  ...extra,
})
const item = (id: string, kind: 'external' | 'normative' | 'untested', text = `claim ${id}`) => ({ id, kind, text })
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(RunStoreError)
  return error as RunStoreError
}
const claimRows = () => database.db.selectFrom('card_claims').selectAll().execute()
const runRows = () => database.db.selectFrom('card_runs').selectAll().execute()
const eventRows = () => database.db.selectFrom('run_events').selectAll().execute()

describe('claims', () => {
  it('lets two concurrent claim attempts on one issue produce exactly one winner', async () => {
    const results = await Promise.allSettled([runs.recordRun(call('run-a'), T0), runs.recordRun(call('run-b', {}, b), T0)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((lost.reason as RunStoreError).code).toBe('claimed-by-other-run')
    expect(await claimRows()).toHaveLength(1)
    expect((await runRows()).map((r) => r.run_id)).toEqual([(await claimRows())[0].run_id])
  })

  it('takes a claim with a 30-minute lease for running and none for a waiting status', async () => {
    const first = await runs.recordRun(call('run-a'), T0)
    expect(first).toMatchObject({ created: true, statusChanged: true, claim: { held: true, leaseUntil: later(RUN_LIMITS.leaseMs).toISOString() }, notify: true })
    const waiting = await runs.recordRun(call('run-a', { status: 'needs_human' }), later(60_000))
    expect(waiting).toMatchObject({ created: false, statusChanged: true, claim: { held: true, leaseUntil: null } })
    expect(await claimRows()).toEqual([
      { repo_key: REPO, issue: 7, run_id: 'run-a', holder: a, lease_until: null, claimed_at: T0.toISOString() },
    ])
  })

  it('renews the lease on a running call without a new claim and says nothing needs publishing', async () => {
    await runs.recordRun(call('run-a'), T0)
    const renewed = await runs.recordRun(call('run-a', { files: ['src/a.ts'], fixRounds: 1 }), later(600_000))
    expect(renewed).toMatchObject({ created: false, statusChanged: false, notify: false })
    expect((await claimRows())[0]).toMatchObject({ lease_until: later(600_000 + RUN_LIMITS.leaseMs).toISOString(), claimed_at: T0.toISOString() })
  })

  it('counts the same run taking its claim again after the lease ran out as a change to publish', async () => {
    await runs.recordRun(call('run-a'), T0)
    const again = await runs.recordRun(call('run-a'), later(RUN_LIMITS.leaseMs))
    expect(again).toMatchObject({ created: false, statusChanged: false, notify: true })
    expect(await claimRows()).toMatchObject([{ run_id: 'run-a', lease_until: later(2 * RUN_LIMITS.leaseMs).toISOString() }])
  })

  it('refuses a second run on a live claim and leaves the first untouched', async () => {
    await runs.recordRun(call('run-a'), T0)
    expect((await refusal(runs.recordRun(call('run-b', {}, b), later(1000)))).code).toBe('claimed-by-other-run')
    expect((await runRows()).map((r) => r.run_id)).toEqual(['run-a'])
    expect((await claimRows())[0].run_id).toBe('run-a')
  })

  it('lets a new run take a claim whose lease has passed', async () => {
    await runs.recordRun(call('run-a'), T0)
    const took = await runs.recordRun(call('run-b', {}, b), later(RUN_LIMITS.leaseMs))
    expect(took.notify).toBe(true)
    expect(await claimRows()).toMatchObject([{ run_id: 'run-b', holder: b }])
    expect((await runRows()).find((r) => r.run_id === 'run-a')?.status).toBe('running')
  })

  it('never expires a claim that waits on a human', async () => {
    await runs.recordRun(call('run-a', { status: 'awaiting_approval' }), T0)
    expect((await refusal(runs.recordRun(call('run-b', {}, b), later(30 * 24 * 3_600_000)))).code).toBe('claimed-by-other-run')
  })

  it('deletes the run own claim on a terminal status and leaves another run claim alone', async () => {
    await runs.recordRun(call('run-a'), T0)
    const done = await runs.recordRun(call('run-a', { status: 'done' }), later(1000))
    expect(done).toMatchObject({ status: 'done', claim: { held: false, leaseUntil: null }, statusChanged: true, notify: true })
    expect(await claimRows()).toEqual([])
    expect((await runRows())[0]).toMatchObject({ status: 'done', ended_at: later(1000).toISOString() })

    await runs.recordRun(call('run-b', {}, b), later(2000))
    await runs.recordRun(call('run-c', { status: 'failed' }, a), later(3000))
    expect(await claimRows()).toMatchObject([{ run_id: 'run-b' }])
  })

  it('records a terminal run on an issue another run holds, without a claim error', async () => {
    await runs.recordRun(call('run-b', {}, b), T0)
    const out = await runs.recordRun(call('run-a', { status: 'plan_only' }), later(1000))
    expect(out.claim.held).toBe(false)
    expect(await claimRows()).toMatchObject([{ run_id: 'run-b' }])
  })

  it('resumes a paused run after its claim was released, or refuses when another run took it', async () => {
    await runs.recordRun(call('run-a', { status: 'needs_human' }), T0)
    expect(await runs.releaseClaim(REPO, 7, 'run-a')).toEqual({ released: true })
    const resumed = await runs.recordRun(call('run-a'), later(1000))
    expect(resumed.notify).toBe(true)
    expect((await claimRows())[0].claimed_at).toBe(later(1000).toISOString())

    await runs.recordRun(call('run-a', { status: 'needs_human' }), later(2000))
    await runs.releaseClaim(REPO, 7, 'run-a')
    await runs.recordRun(call('run-b', {}, b), later(3000))
    expect((await refusal(runs.recordRun(call('run-a'), later(4000)))).code).toBe('claimed-by-other-run')
    expect((await runRows()).find((r) => r.run_id === 'run-a')?.status).toBe('needs_human')
  })
})

describe('the run row', () => {
  it('refuses a call on a finished run with the status it ended with', async () => {
    await runs.recordRun(call('run-a', { status: 'rejected' }), T0)
    const error = await refusal(runs.recordRun(call('run-a'), later(1000)))
    expect([error.code, error.runStatus]).toEqual(['run-finished', 'rejected'])
    expect(await claimRows()).toEqual([])
  })

  it('refuses a run id used for another issue, repository or integration', async () => {
    await runs.recordRun(call('run-a'), T0)
    expect((await refusal(runs.recordRun(call('run-a', {}, a, 8), later(1)))).code).toBe('run-id-taken')
    expect((await refusal(runs.recordRun(call('run-a', {}, b), later(1)))).code).toBe('run-id-taken')
    expect((await refusal(runs.recordRun({ ...call('run-a'), repoKey: 'acme/other' }, later(1)))).code).toBe('run-id-taken')
  })

  it('keeps omitted fields, replaces given ones and moves status_at only when the status changes', async () => {
    await runs.recordRun(call('run-a', { triageRange: 'S-M', files: ['a.ts'], mergeShas: ['a'.repeat(40)], costUsd: 0.5, observedBy: 'carcara/1', findings: 'first' }), T0)
    await runs.recordRun(call('run-a', { files: ['b.ts', 'c.ts'], fixRounds: 2 }), later(1000))
    expect((await runRows())[0]).toMatchObject({
      triage_range: 'S-M',
      files: '["b.ts","c.ts"]',
      merge_shas: `["${'a'.repeat(40)}"]`,
      cost_usd: 0.5,
      observed_by: 'carcara/1',
      findings: 'first',
      fix_rounds: 2,
      files_omitted: 0,
      areas: '[]',
      status_at: T0.toISOString(),
      started_at: T0.toISOString(),
      ended_at: null,
    })
    await runs.recordRun(call('run-a', { status: 'needs_human' }), later(2000))
    await runs.recordRun(call('run-a', { status: 'needs_human' }), later(3000))
    expect((await runRows())[0].status_at).toBe(later(2000).toISOString())
  })

  it('notifies when the triage range or the findings change', async () => {
    await runs.recordRun(call('run-a', { triageRange: 'M', findings: 'one' }), T0)
    expect((await runs.recordRun(call('run-a', { triageRange: 'M', findings: 'one' }), later(1))).notify).toBe(false)
    expect((await runs.recordRun(call('run-a', { triageRange: 'M-L' }), later(2))).notify).toBe(true)
    expect((await runs.recordRun(call('run-a', { findings: 'two' }), later(3))).notify).toBe(true)
  })
})

describe('unverified items', () => {
  it('merges by id, keeps the stored order and appends new ids', async () => {
    await runs.recordRun(call('run-a', { unverified: [item('U1', 'external'), item('U2', 'normative')] }), T0)
    const out = await runs.recordRun(call('run-a', { unverified: [item('U3', 'untested'), item('U1', 'external')] }), later(1))
    expect(out.unverifiedOpen).toEqual({ external: 1, normative: 1, untested: 1 })
    expect(out.notify).toBe(true)
    const stored = JSON.parse((await runRows())[0].unverified) as { id: string }[]
    expect(stored.map((i) => i.id)).toEqual(['U1', 'U2', 'U3'])
    expect((await runs.recordRun(call('run-a', { unverified: [item('U1', 'external')] }), later(2))).notify).toBe(false)
  })

  it('refuses a reused id with another kind or text and more than 20 items, writing nothing', async () => {
    await runs.recordRun(call('run-a', { unverified: [item('U1', 'external')] }), T0)
    expect((await refusal(runs.recordRun(call('run-a', { unverified: [item('U1', 'untested')] }), later(1)))).code).toBe('item-changed')
    expect((await refusal(runs.recordRun(call('run-a', { unverified: [item('U1', 'external', 'other')] }), later(1)))).code).toBe('item-changed')
    const many = Array.from({ length: 20 }, (_, i) => item(`N${i}`, 'untested'))
    expect((await refusal(runs.recordRun(call('run-a', { unverified: many }), later(1)))).code).toBe('too-many-items')
    expect(JSON.parse((await runRows())[0].unverified)).toHaveLength(1)
  })

  it('leaves no run row when a first call is refused for its items', async () => {
    const many = Array.from({ length: 21 }, (_, i) => item(`N${i}`, 'untested'))
    expect((await refusal(runs.recordRun(call('run-a', { unverified: many }), T0))).code).toBe('too-many-items')
    expect(await runRows()).toEqual([])
    expect(await claimRows()).toEqual([])
  })
})

describe('probes and withdrawals', () => {
  const start = (extra: Partial<RecordRunInput> = {}) =>
    runs.recordRun(call('run-a', { unverified: [item('U1', 'external'), item('U2', 'normative'), item('U3', 'untested')], ...extra }), T0)

  it('closes an external or untested item with a probe and counts the rest as open', async () => {
    const out = await start({ probes: [{ item: 'U1', note: 'checked' }, { item: 'U3', note: null }] })
    expect(out).toMatchObject({ probesApplied: 2, probesSkipped: 0, unverifiedOpen: { external: 0, normative: 1, untested: 0 } })
    expect(await eventRows()).toMatchObject([
      { run_id: 'run-a', kind: 'probe', resolves: 'U1', detail: '{"note":"checked"}', by: a, surfaced_at: T0.toISOString(), at: T0.toISOString() },
      { run_id: 'run-a', kind: 'probe', resolves: 'U3', detail: '{"note":null}' },
    ])
  })

  it('skips a probe on an item already resolved or withdrawn, so a replay does not fail', async () => {
    await start({ probes: [{ item: 'U1', note: null }], withdrawn: ['U3'] })
    const replay = await runs.recordRun(call('run-a', { probes: [{ item: 'U1', note: null }, { item: 'U3', note: null }], withdrawn: [] }), later(1))
    expect(replay).toMatchObject({ probesApplied: 0, probesSkipped: 2, notify: false })
    expect(await eventRows()).toHaveLength(1)
  })

  it('refuses a probe or withdrawal of an unknown item or a normative one, writing nothing', async () => {
    await start()
    expect((await refusal(runs.recordRun(call('run-a', { probes: [{ item: 'U9', note: null }] }), later(1)))).code).toBe('unknown-item')
    expect((await refusal(runs.recordRun(call('run-a', { withdrawn: ['U9'] }), later(1)))).code).toBe('unknown-item')
    expect((await refusal(runs.recordRun(call('run-a', { probes: [{ item: 'U2', note: null }] }), later(1)))).code).toBe('item-needs-a-person')
    expect((await refusal(runs.recordRun(call('run-a', { withdrawn: ['U2'] }), later(1)))).code).toBe('item-needs-a-person')
    expect(await eventRows()).toEqual([])
    expect(JSON.parse((await runRows())[0].unverified).some((i: { withdrawnAt?: string }) => i.withdrawnAt)).toBe(false)
  })

  it('withdraws an item as state on the item, not as an event, and stops counting it', async () => {
    const out = await start({ withdrawn: ['U1'] })
    expect(out).toMatchObject({ withdrawnApplied: 1, withdrawnSkipped: 0, unverifiedOpen: { external: 0, normative: 1, untested: 1 } })
    expect(await eventRows()).toEqual([])
    expect(JSON.parse((await runRows())[0].unverified)[0]).toEqual({ id: 'U1', kind: 'external', text: 'claim U1', withdrawnAt: T0.toISOString() })
    const again = await runs.recordRun(call('run-a', { withdrawn: ['U1'], unverified: [item('U1', 'external')] }), later(5))
    expect(again).toMatchObject({ withdrawnApplied: 0, withdrawnSkipped: 1, notify: false })
    expect(JSON.parse((await runRows())[0].unverified)[0].withdrawnAt).toBe(T0.toISOString())
  })

  it('probes and withdraws an item that this same call adds', async () => {
    await runs.recordRun(call('run-a', { unverified: [item('N1', 'untested'), item('N2', 'external')], probes: [{ item: 'N1', note: null }], withdrawn: ['N2'] }), T0)
    expect(await eventRows()).toMatchObject([{ resolves: 'N1' }])
  })

  it('writes probe events only, through an insert that refuses every other kind', async () => {
    await start({ probes: [{ item: 'U1', note: null }] })
    for (const kind of ['released', 'aftermath', '']) {
      await expect(insertRunEvent(database.db, { runId: 'run-a', kind, resolves: null, note: null, by: a, now: T0 })).rejects.toThrow('run event kind not allowed')
    }
    expect((await eventRows()).map((e) => e.kind)).toEqual(['probe'])
    await expect(insertRunEvent(database.db, { runId: 'run-a', kind: 'accepted', resolves: 'U2', note: null, by: person, now: T0 })).resolves.toBe(true)
  })

  it('probes an item while closing the run in the same call', async () => {
    await start()
    const out = await runs.recordRun(call('run-a', { status: 'done', probes: [{ item: 'U1', note: null }] }), later(10))
    expect(out).toMatchObject({ probesApplied: 1, claim: { held: false } })
    expect(await claimRows()).toEqual([])
  })
})

describe('accepting an item', () => {
  const accept = (itemId: string, note: string | null = null, runId = 'run-a', repoKey = REPO) =>
    runs.acceptItem({ repoKey, runId, itemId, userId: person, note }, later(5000))

  beforeEach(async () => {
    await runs.recordRun(call('run-a', { unverified: [item('U1', 'external'), item('U2', 'normative')], status: 'done' }), T0)
  })

  it('records an accepted event on a normative item of a finished run and reports it resolved the second time', async () => {
    const first = await accept('U2', 'fine by me')
    expect(first).toMatchObject({
      kind: 'accepted',
      item: { id: 'U2', runId: 'run-a', withdrawnAt: null, resolution: { kind: 'accepted', note: 'fine by me', by: { username: 'ada', kind: 'person' }, at: later(5000).toISOString() } },
    })
    expect(await accept('U2')).toMatchObject({ kind: 'resolved', item: { resolution: { kind: 'accepted', note: 'fine by me' } } })
    expect(await eventRows()).toHaveLength(1)
    expect((await runRows())[0].status).toBe('done')
  })

  it('refuses a non-normative item, an unknown item, an unknown run and another repository', async () => {
    expect(await accept('U1')).toEqual({ kind: 'not-normative' })
    expect(await accept('U9')).toEqual({ kind: 'not-found' })
    expect(await accept('U2', null, 'run-zzz')).toEqual({ kind: 'not-found' })
    expect(await accept('U2', null, 'run-a', 'acme/other')).toEqual({ kind: 'not-found' })
    expect(await eventRows()).toEqual([])
  })
})

describe('releasing a claim', () => {
  it('deletes the named run claim, an expired one included, and changes no run row', async () => {
    await runs.recordRun(call('run-a'), T0)
    expect(await runs.releaseClaim(REPO, 7, 'run-a')).toEqual({ released: true })
    expect(await claimRows()).toEqual([])
    expect((await runRows())[0].status).toBe('running')
    expect(await eventRows()).toEqual([])
  })

  it('reports no claim, or the claim another run now holds', async () => {
    expect(await runs.releaseClaim(REPO, 7, 'run-a')).toEqual({ released: false, current: null })
    await runs.recordRun(call('run-b', {}, b), T0)
    const result = await runs.releaseClaim(REPO, 7, 'run-a')
    expect(result).toEqual({
      released: false,
      current: { runId: 'run-b', status: 'running', since: T0.toISOString(), claimedAt: T0.toISOString(), leaseUntil: later(RUN_LIMITS.leaseMs).toISOString(), holder: { username: 'other-bot', kind: 'integration' } },
    })
    expect(await claimRows()).toHaveLength(1)
  })
})

describe('reading activity', () => {
  it('treats an expired claim as absent in every read', async () => {
    await runs.recordRun(call('run-a'), T0)
    const after = later(RUN_LIMITS.leaseMs)
    expect((await runs.activityFor(REPO, [7], after)).claims.size).toBe(0)
    expect((await runs.boardActivity(REPO, after)).cards[0]).toMatchObject({ issue: 7, claim: null, lastRun: { runId: 'run-a' } })
    expect((await runs.issueActivity(REPO, 7, after)).claim).toBeNull()
    expect(await runs.waitingClaims(REPO, after)).toEqual([])
    expect((await runs.activityFor(REPO, [7], later(RUN_LIMITS.leaseMs - 1))).claims.get(7)).toMatchObject({ runId: 'run-a' })
  })

  it('picks the last run of an issue by status_at, then run id, and counts only open items', async () => {
    await runs.recordRun(call('run-a', { status: 'done', triageRange: 'S', unverified: [item('U1', 'external')] }), T0)
    await runs.recordRun(call('run-b', { status: 'done', triageRange: 'M', unverified: [item('U1', 'external'), item('U2', 'normative')], withdrawn: ['U1'] }), later(1000))
    await runs.recordRun(call('run-c', { status: 'done', triageRange: 'L' }), later(1000))
    const found = await runs.activityFor(REPO, [7, 8], later(2000))
    expect(found.lastRuns.get(7)).toEqual({ runId: 'run-c', status: 'done', triageRange: 'L', unverifiedOpen: { external: 0, normative: 0, untested: 0 } })
    expect(found.lastRuns.has(8)).toBe(false)
    await runs.recordRun(call('run-a2', { status: 'done', unverified: [item('X', 'untested')] }), later(500))
    expect((await runs.activityFor(REPO, [7], later(2000))).lastRuns.get(7)?.runId).toBe('run-c')
    expect((await runs.issueActivity(REPO, 7, later(2000))).runs.map((r) => r.runId)).toEqual(['run-c', 'run-b', 'run-a2', 'run-a'])
  })

  it('orders runs that changed status in the same millisecond by run id in code-unit order', async () => {
    // Under a locale collation 'a-1' sorts before 'B-1'; in code-unit order 'B-1' sorts before 'a-1'.
    await runs.recordRun(call('B-1', { status: 'done' }), T0)
    await runs.recordRun(call('a-1', { status: 'done' }, b, 7), T0)
    expect((await runs.issueActivity(REPO, 7, later(10))).runs.map((r) => r.runId)).toEqual(['a-1', 'B-1'])
    expect((await runs.activityFor(REPO, [7], later(10))).lastRuns.get(7)?.runId).toBe('a-1')
    expect((await runs.boardActivity(REPO, later(10))).cards[0].lastRun?.runId).toBe('a-1')
  })

  it('makes a resumed run the last run again', async () => {
    await runs.recordRun(call('run-a', { status: 'needs_human' }), T0)
    await runs.recordRun(call('run-b', { status: 'done' }, b, 8), later(10))
    await runs.releaseClaim(REPO, 7, 'run-a')
    await runs.recordRun(call('run-c', { status: 'done' }), later(20))
    await runs.recordRun(call('run-a'), later(30))
    expect((await runs.activityFor(REPO, [7], later(40))).lastRuns.get(7)?.runId).toBe('run-a')
  })

  it('lists waiting claims oldest first, leaving running and finished runs out', async () => {
    await runs.recordRun(call('run-a', { status: 'needs_human' }, a, 9), T0)
    await runs.recordRun(call('run-b', { status: 'awaiting_approval' }, b, 3), T0)
    await runs.recordRun(call('run-c', { status: 'budget_exceeded' }, a, 5), later(-1000))
    await runs.recordRun(call('run-d', {}, a, 4), T0)
    await runs.recordRun(call('run-e', { status: 'done' }, a, 6), T0)
    expect(await runs.waitingClaims(REPO, later(1000))).toEqual([
      { issue: 5, runId: 'run-c', status: 'budget_exceeded', since: later(-1000).toISOString() },
      { issue: 3, runId: 'run-b', status: 'awaiting_approval', since: T0.toISOString() },
      { issue: 9, runId: 'run-a', status: 'needs_human', since: T0.toISOString() },
    ])
    expect(await runs.waitingClaims('acme/other', later(1000))).toEqual([])
  })

  it('shows items with their resolutions and withdrawals, the agent, and a removed integration as null', async () => {
    await runs.recordRun(
      call('run-a', {
        status: 'done',
        observedBy: 'carcara/1',
        uncertaintyKind: 'external',
        findings: 'a finding',
        unverified: [item('U1', 'external'), item('U2', 'normative'), item('U3', 'untested')],
        probes: [{ item: 'U1', note: 'checked' }],
        withdrawn: ['U3'],
      }),
      T0,
    )
    await runs.acceptItem({ repoKey: REPO, runId: 'run-a', itemId: 'U2', userId: person, note: null }, later(100))
    const view = await runs.issueActivity(REPO, 7, later(200))
    expect(view).toMatchObject({ repoKey: REPO, issue: 7, claim: null, moreRuns: false })
    const run = view.runs[0]
    expect(run).toMatchObject({
      agent: { username: 'carcara', kind: 'integration' },
      observedBy: 'carcara/1',
      uncertaintyKind: 'external',
      findings: 'a finding',
      unverifiedOpen: { external: 0, normative: 0, untested: 0 },
    })
    expect(run.items).toEqual([
      { id: 'U1', kind: 'external', text: 'claim U1', runId: 'run-a', withdrawnAt: null, resolution: { kind: 'probe', note: 'checked', by: { username: 'carcara', kind: 'integration' }, at: T0.toISOString() } },
      { id: 'U2', kind: 'normative', text: 'claim U2', runId: 'run-a', withdrawnAt: null, resolution: { kind: 'accepted', note: null, by: { username: 'ada', kind: 'person' }, at: later(100).toISOString() } },
      { id: 'U3', kind: 'untested', text: 'claim U3', runId: 'run-a', withdrawnAt: T0.toISOString(), resolution: null },
    ])
    await database.db.deleteFrom('integrations').where('user_id', '=', a).execute()
    await database.db.deleteFrom('users').where('id', '=', a).execute()
    expect((await runs.issueActivity(REPO, 7, later(200))).runs[0].agent).toBeNull()
  })

  it('caps the runs of one issue at 20 and says there are more', async () => {
    for (let i = 0; i < 22; i += 1) await runs.recordRun(call(`run-${String(i).padStart(2, '0')}`, { status: 'done' }), later(i))
    const view = await runs.issueActivity(REPO, 7, later(100))
    expect(view.runs).toHaveLength(20)
    expect(view.moreRuns).toBe(true)
    expect(view.runs[0].runId).toBe('run-21')
  })

  it('lists the cards of the board activity by issue, claimed issues included, with only live claims', async () => {
    await runs.recordRun(call('run-a', { status: 'done' }, a, 12), T0)
    await runs.recordRun(call('run-b', {}, b, 4), later(10))
    const board = await runs.boardActivity(REPO, later(20))
    expect(board.cards.map((c) => [c.issue, c.claim?.runId ?? null, c.lastRun?.runId])).toEqual([
      [4, 'run-b', 'run-b'],
      [12, null, 'run-a'],
    ])
    expect((await runs.boardActivity('acme/other', later(20))).cards).toEqual([])
  })
})

describe('isRetryableTransactionError', () => {
  it('accepts the deadlock and busy errors of each backend and nothing else', () => {
    for (const error of [{ errno: 1213 }, { errno: 1205 }, { code: '40P01' }, { code: '40001' }, { errcode: 5 }, { errcode: 6 }]) {
      expect(isRetryableTransactionError(error)).toBe(true)
    }
    for (const error of [{ errno: 1062 }, { code: '23505' }, { errcode: 2067 }, new Error('x'), null, 'busy']) {
      expect(isRetryableTransactionError(error)).toBe(false)
    }
  })
})
