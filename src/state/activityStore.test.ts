import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import type { ApiStub } from '../test/apiStub'
import { installApiStub } from '../test/apiStub'
import { makeClaim, makeRunDetail } from '../test/fixtures'
import { useActivity } from './activityStore'
import { useSession } from './session'

const KEY = 'acme/widgets'
const activity = () => useActivity.getState()
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const normative = (resolution: null | { note: string | null } = null) => ({
  id: 'N1',
  kind: 'normative' as const,
  text: 'Spec says X',
  runId: 'r-1',
  withdrawnAt: null,
  resolution: resolution ? { kind: 'accepted' as const, note: resolution.note, by: null, at: '2026-10-08T12:00:00.000Z' } : null,
})

let stub: ApiStub
beforeEach(async () => {
  useActivity.setState({ boards: {}, issues: {} })
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
  stub = installApiStub()
  await useSession.getState().load()
})

describe('load', () => {
  it('replaces the cards with the server list and shares a load already in flight', async () => {
    stub.setActivity(KEY, 3, { claim: makeClaim('r-1'), runs: [makeRunDetail('r-1')] })
    stub.setActivity(KEY, 8, { runs: [makeRunDetail('r-9', { status: 'done' })] })
    await Promise.all([activity().load(KEY), activity().load(KEY)])
    expect(stub.requests('GET boards/acme/widgets/activity')).toHaveLength(1)
    expect(activity().boards[KEY].status).toBe('ready')
    expect(Object.keys(activity().boards[KEY].cards)).toEqual(['3', '8'])
    expect(activity().boards[KEY].cards[3]).toMatchObject({ claim: { runId: 'r-1' }, lastRun: { runId: 'r-1' } })

    stub.setActivity(KEY, 3, { claim: null, runs: [] })
    await activity().load(KEY)
    expect(Object.keys(activity().boards[KEY].cards)).toEqual(['8'])
  })

  it('keeps the cards shown and marks the board as errored when a reload fails', async () => {
    stub.setActivity(KEY, 3, { claim: makeClaim('r-1'), runs: [makeRunDetail('r-1')] })
    await activity().load(KEY)
    stub.failNext('GET boards/acme/widgets/activity', { status: 500 })
    await activity().load(KEY)
    expect(activity().boards[KEY].status).toBe('error')
    expect(activity().boards[KEY].cards[3]).toBeDefined()
  })

  it('drops the answer when the session changes', async () => {
    const gate = stub.hold('GET boards/acme/widgets/activity')
    const loading = activity().load(KEY)
    await settle()
    await useSession.getState().markSignedOut()
    gate.release()
    await loading
    expect(activity().boards).toEqual({})
  })
})

describe('refreshIssue', () => {
  it('updates the detail and the card, and removes a card that has no claim and no runs', async () => {
    stub.setActivity(KEY, 3, { claim: makeClaim('r-1'), runs: [makeRunDetail('r-1')] })
    await activity().load(KEY)
    stub.setActivity(KEY, 3, { claim: null, runs: [makeRunDetail('r-1', { status: 'done' })] })
    await activity().refreshIssue(KEY, 3)
    expect(activity().issues[`${KEY}#3`].runs[0].status).toBe('done')
    expect(activity().boards[KEY].cards[3]).toMatchObject({ claim: null, lastRun: { status: 'done' } })
    stub.setActivity(KEY, 3, { claim: null, runs: [] })
    await activity().refreshIssue(KEY, 3)
    expect(activity().boards[KEY].cards[3]).toBeUndefined()
  })

  it('runs one more request when a call arrives during one, and no more than one', async () => {
    const gate = stub.hold('GET boards/acme/widgets/activity/3')
    const calls = [activity().refreshIssue(KEY, 3), activity().refreshIssue(KEY, 3), activity().refreshIssue(KEY, 3)]
    await settle()
    stub.setActivity(KEY, 3, { runs: [makeRunDetail('r-2')] })
    gate.release()
    await Promise.all(calls)
    expect(stub.requests('GET boards/acme/widgets/activity/3')).toHaveLength(2)
    expect(activity().issues[`${KEY}#3`].runs[0].runId).toBe('r-2')
  })
})

describe('release', () => {
  it('releases the claim and refreshes the issue', async () => {
    stub.setActivity(KEY, 3, { claim: makeClaim('r-1', { status: 'needs_human', leaseUntil: null }), runs: [makeRunDetail('r-1', { status: 'needs_human' })] })
    await activity().load(KEY)
    await activity().release(KEY, 3, 'r-1')
    expect(stub.requests('DELETE boards/acme/widgets/claims/3?runId=r-1')).toHaveLength(1)
    expect(activity().boards[KEY].cards[3].claim).toBeNull()
    expect(activity().issues[`${KEY}#3`].claim).toBeNull()
  })

  it('refreshes and rethrows when another run holds the claim now', async () => {
    stub.setActivity(KEY, 3, { claim: makeClaim('r-2'), runs: [makeRunDetail('r-2')] })
    const error = await activity().release(KEY, 3, 'r-1').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('claim-changed')
    expect(activity().issues[`${KEY}#3`].claim?.runId).toBe('r-2')
  })
})

describe('accept', () => {
  it('accepts a normative item and shows the resolution', async () => {
    stub.setActivity(KEY, 3, { runs: [makeRunDetail('r-1', { status: 'done', items: [normative()], unverifiedOpen: { external: 0, normative: 1, untested: 0 } })] })
    await activity().accept(KEY, 3, 'r-1', 'N1')
    const run = activity().issues[`${KEY}#3`].runs[0]
    expect(run.items[0].resolution).toMatchObject({ kind: 'accepted' })
    expect(run.unverifiedOpen.normative).toBe(0)
  })

  it('refreshes and rethrows when the item was already closed', async () => {
    stub.setActivity(KEY, 3, { runs: [makeRunDetail('r-1', { status: 'done', items: [normative({ note: 'first' })] })] })
    const error = await activity().accept(KEY, 3, 'r-1', 'N1').then(() => null, (e: unknown) => e)
    expect((error as ApiError).code).toBe('item-resolved')
    expect(activity().issues[`${KEY}#3`].runs[0].items[0].resolution).toMatchObject({ note: 'first' })
  })
})
