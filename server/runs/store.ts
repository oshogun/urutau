import { SqliteAdapter, type Kysely } from 'kysely'
import type {
  ActorView,
  CardActivity,
  ClaimView,
  IssueActivityResponse,
  ItemResolutionView,
  RunDetailView,
  RunSummaryView,
  UnverifiedItemView,
} from '../../src/domain/api.ts'
import { isTerminalStatus, WAITING_STATUSES } from '../../src/domain/activity.ts'
import type {
  HoldingStatus,
  RunStatus,
  TriageRange,
  UncertaintyKind,
  UnverifiedCounts,
  UnverifiedItem,
  WaitingStatus,
} from '../../src/domain/types.ts'
import { insertIgnoringDuplicate, iso } from '../db/helpers.ts'
import type { Tables } from '../db/schema.ts'
import {
  RUN_LIMITS,
  RunStoreError,
  type AcceptInput,
  type AcceptOutcome,
  type ActivityForCards,
  type BoardActivity,
  type IssueActivity,
  type RecordRunInput,
  type RecordRunOutcome,
  type ReleaseOutcome,
  type RunStore,
  type WaitingClaim,
} from './types.ts'

/** Rows per IN (...) list: SQLite allows 32766 parameters, but the lists stay short on every backend. */
const CHUNK = 500
/** Runs read to find the newest 1000 issues' last runs. */
const BOARD_RUNS_READ = 5_000
const HOLDING_STATUSES: readonly RunStatus[] = ['running', ...WAITING_STATUSES]

/** Thrown inside a transaction attempt to roll it back and begin a new one (counts toward the attempts). */
class Restart extends Error {}

/**
 * True for a deadlock or busy error that a new transaction attempt can pass:
 * MariaDB errno 1213 (ER_LOCK_DEADLOCK) or 1205 (ER_LOCK_WAIT_TIMEOUT),
 * PostgreSQL code 40P01 or 40001, SQLite errcode 5 (SQLITE_BUSY) or 6.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { code?: unknown; errno?: unknown; errcode?: unknown }
  return e.errno === 1213 || e.errno === 1205 || e.code === '40P01' || e.code === '40001' || e.errcode === 5 || e.errcode === 6
}

/**
 * The only function that inserts a run_events row. Phase-1 events are probe
 * and accepted; any other kind throws and inserts nothing. Returns false when
 * the item already has a resolution (the unique (run_id, resolves) pair).
 */
export async function insertRunEvent(
  db: Kysely<Tables>,
  event: { runId: string; kind: string; resolves: string | null; note: string | null; by: string; now: Date },
): Promise<boolean> {
  if (event.kind !== 'probe' && event.kind !== 'accepted') throw new Error('run event kind not allowed')
  const at = iso(event.now)
  return insertIgnoringDuplicate(db, 'run_events', {
    id: crypto.randomUUID(),
    run_id: event.runId,
    kind: event.kind,
    resolves: event.resolves,
    surfaced_at: at,
    detail: JSON.stringify({ note: event.note }),
    by: event.by,
    at,
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseItems(text: string): UnverifiedItem[] {
  const value = parseJson(text)
  return Array.isArray(value) ? (value as UnverifiedItem[]) : []
}

function parseNote(detail: string): string | null {
  const value = parseJson(detail)
  const note = value !== null && typeof value === 'object' ? (value as { note?: unknown }).note : null
  return typeof note === 'string' ? note : null
}

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}

/** Items that are neither withdrawn nor resolved, counted per kind. */
function openCounts(items: readonly UnverifiedItem[], resolved: ReadonlySet<string>): UnverifiedCounts {
  const counts: UnverifiedCounts = { external: 0, normative: 0, untested: 0 }
  for (const item of items) {
    if (item.withdrawnAt === undefined && !resolved.has(item.id)) counts[item.kind] += 1
  }
  return counts
}

function actor(username: string | null, integrationId: string | null): ActorView | null {
  return username === null ? null : { username, kind: integrationId === null ? 'person' : 'integration' }
}

interface ClaimRow {
  repo_key: string
  issue: number
  run_id: string
  status: RunStatus
  status_at: string
  claimed_at: string
  lease_until: string | null
  username: string | null
  integration_id: string | null
}

function claimView(row: ClaimRow): ClaimView {
  return {
    runId: row.run_id,
    status: row.status as HoldingStatus,
    since: row.status_at,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    holder: actor(row.username, row.integration_id),
  }
}

function claimsQuery(db: Kysely<Tables>) {
  return db
    .selectFrom('card_claims')
    .innerJoin('card_runs', 'card_runs.run_id', 'card_claims.run_id')
    .leftJoin('users', 'users.id', 'card_claims.holder')
    .leftJoin('integrations', 'integrations.user_id', 'card_claims.holder')
    .select([
      'card_claims.repo_key as repo_key',
      'card_claims.issue as issue',
      'card_claims.run_id as run_id',
      'card_runs.status as status',
      'card_runs.status_at as status_at',
      'card_claims.claimed_at as claimed_at',
      'card_claims.lease_until as lease_until',
      'users.username as username',
      'integrations.user_id as integration_id',
    ])
}

/** Claims of the repository that have not expired, ordered by issue. */
async function liveClaims(db: Kysely<Tables>, repoKey: string, now: Date): Promise<ClaimRow[]> {
  const nowIso = iso(now)
  return claimsQuery(db)
    .where('card_claims.repo_key', '=', repoKey)
    .where((eb) => eb.or([eb('card_claims.lease_until', 'is', null), eb('card_claims.lease_until', '>', nowIso)]))
    .orderBy('card_claims.issue')
    .execute()
}

interface RunRow {
  run_id: string
  issue: number
  status: RunStatus
  status_at: string
  triage_range: TriageRange | null
  unverified: string
  started_at: string
  ended_at: string | null
}

const RUN_COLUMNS = ['run_id', 'issue', 'status', 'status_at', 'triage_range', 'unverified', 'started_at', 'ended_at'] as const

/** Run ids to the item ids that have a resolution. */
async function resolvedItemIds(db: Kysely<Tables>, runIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  for (const chunk of chunks(runIds)) {
    const rows = await db
      .selectFrom('run_events')
      .select(['run_id', 'resolves'])
      .where('run_id', 'in', chunk)
      .where('resolves', 'is not', null)
      .execute()
    for (const row of rows) {
      if (row.resolves === null) continue
      const set = out.get(row.run_id) ?? new Set<string>()
      set.add(row.resolves)
      out.set(row.run_id, set)
    }
  }
  return out
}

function summaryView(row: RunRow, resolved: ReadonlySet<string> | undefined): RunSummaryView {
  return {
    runId: row.run_id,
    status: row.status,
    statusAt: row.status_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    triageRange: row.triage_range,
    unverifiedOpen: openCounts(parseItems(row.unverified), resolved ?? new Set()),
  }
}

/**
 * Newest status change first; ties broken by the greater run id in code-unit order.
 * Sorting here instead of in SQL gives the same order on every database: PostgreSQL
 * and MariaDB sort run_id by the column's collation, which differs from code-unit order.
 */
function newestFirst<T extends { run_id: string; status_at: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    if (a.status_at !== b.status_at) return a.status_at < b.status_at ? 1 : -1
    return a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0
  })
}

/**
 * The newest `limit` rows after newestFirst. The database cuts the list by status_at alone,
 * so rows that share the cut-off's status_at are read in full and the cut is made here.
 */
async function newestRows<T extends { run_id: string; status_at: string }>(
  limit: number,
  firstRows: () => Promise<T[]>,
  sameStatusAt: (statusAt: string) => Promise<T[]>,
): Promise<T[]> {
  const rows = await firstRows()
  if (rows.length >= limit) {
    const known = new Set(rows.map((row) => row.run_id))
    for (const row of await sameStatusAt(rows[rows.length - 1].status_at)) if (!known.has(row.run_id)) rows.push(row)
  }
  return newestFirst(rows).slice(0, limit)
}

/** The first run per issue of rows already ordered newest first within each issue. */
function firstPerIssue(rows: readonly RunRow[]): Map<number, RunRow> {
  const out = new Map<number, RunRow>()
  for (const row of rows) if (!out.has(row.issue)) out.set(row.issue, row)
  return out
}

/** Every run of the issues, newest status change first; ties broken by the greater run id. */
async function runsOfIssues(db: Kysely<Tables>, repoKey: string, issues: readonly number[]): Promise<RunRow[]> {
  const rows: RunRow[] = []
  for (const chunk of chunks(issues)) {
    rows.push(
      ...(await db
        .selectFrom('card_runs')
        .select(RUN_COLUMNS)
        .where('repo_key', '=', repoKey)
        .where('issue', 'in', chunk)
        .execute()),
    )
  }
  return newestFirst(rows)
}

type ResolutionRow = {
  run_id: string
  kind: 'probe' | 'accepted'
  resolves: string | null
  detail: string
  at: string
  username: string | null
  integration_id: string | null
}

function resolutionView(row: ResolutionRow): ItemResolutionView {
  return { kind: row.kind, note: parseNote(row.detail), by: actor(row.username, row.integration_id), at: row.at }
}

async function resolutionsOf(db: Kysely<Tables>, runIds: readonly string[]): Promise<Map<string, Map<string, ItemResolutionView>>> {
  const out = new Map<string, Map<string, ItemResolutionView>>()
  for (const chunk of chunks(runIds)) {
    const rows = await db
      .selectFrom('run_events')
      .leftJoin('users', 'users.id', 'run_events.by')
      .leftJoin('integrations', 'integrations.user_id', 'run_events.by')
      .select([
        'run_events.run_id as run_id',
        'run_events.kind as kind',
        'run_events.resolves as resolves',
        'run_events.detail as detail',
        'run_events.at as at',
        'users.username as username',
        'integrations.user_id as integration_id',
      ])
      .where('run_events.run_id', 'in', chunk)
      .where('run_events.resolves', 'is not', null)
      .execute()
    for (const row of rows) {
      if (row.resolves === null) continue
      const map = out.get(row.run_id) ?? new Map<string, ItemResolutionView>()
      map.set(row.resolves, resolutionView(row))
      out.set(row.run_id, map)
    }
  }
  return out
}

function itemView(runId: string, item: UnverifiedItem, resolution: ItemResolutionView | undefined): UnverifiedItemView {
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    runId,
    withdrawnAt: item.withdrawnAt ?? null,
    resolution: item.withdrawnAt === undefined ? (resolution ?? null) : null,
  }
}

async function actorById(db: Kysely<Tables>, userId: string): Promise<ActorView | null> {
  const row = await db
    .selectFrom('users')
    .leftJoin('integrations', 'integrations.user_id', 'users.id')
    .select(['users.username as username', 'integrations.user_id as integration_id'])
    .where('users.id', '=', userId)
    .executeTakeFirst()
  return row ? actor(row.username, row.integration_id) : null
}

/** The store over `db`. Everything it writes happens in a transaction, retried on a deadlock or busy error. */
export function createRunStore(db: Kysely<Tables>): RunStore {
  async function transact<T>(work: (trx: Kysely<Tables>) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await db.transaction().execute(work)
      } catch (error) {
        const retry = error instanceof Restart || isRetryableTransactionError(error)
        if (!retry) throw error
        if (attempt >= RUN_LIMITS.transactionAttempts) {
          throw error instanceof Restart ? new Error('run store: too many concurrent attempts') : error
        }
      }
    }
  }

  /** Inserts the claim, or renews it when this run holds it. Returns true when a row was inserted or an expired claim of this run was taken again. */
  async function takeOrRenewClaim(
    trx: Kysely<Tables>,
    claim: { repoKey: string; issue: number; runId: string; holder: string; leaseUntil: string | null; now: Date },
  ): Promise<boolean> {
    const nowIso = iso(claim.now)
    // SQLite rejects FOR UPDATE; its transactions never interleave on the one connection.
    const locking = !(trx.getExecutor().adapter instanceof SqliteAdapter)
    for (let pass = 0; pass < 3; pass += 1) {
      const inserted = await insertIgnoringDuplicate(trx, 'card_claims', {
        repo_key: claim.repoKey,
        issue: claim.issue,
        run_id: claim.runId,
        holder: claim.holder,
        lease_until: claim.leaseUntil,
        claimed_at: nowIso,
      })
      if (inserted) return true
      let read = trx.selectFrom('card_claims').selectAll().where('repo_key', '=', claim.repoKey).where('issue', '=', claim.issue)
      if (locking) read = read.forUpdate()
      const row = await read.executeTakeFirst()
      if (!row) continue
      if (row.run_id === claim.runId) {
        // The same run taking its claim again after the lease ran out is a change open boards have not seen.
        const lapsed = row.lease_until !== null && row.lease_until <= nowIso
        await trx
          .updateTable('card_claims')
          .set({ lease_until: claim.leaseUntil })
          .where('repo_key', '=', claim.repoKey)
          .where('issue', '=', claim.issue)
          .where('run_id', '=', claim.runId)
          .execute()
        return lapsed
      }
      if (row.lease_until !== null && row.lease_until <= nowIso) {
        await trx
          .deleteFrom('card_claims')
          .where('repo_key', '=', claim.repoKey)
          .where('issue', '=', claim.issue)
          .where('run_id', '=', row.run_id)
          .where('lease_until', '=', row.lease_until)
          .execute()
        continue
      }
      throw new RunStoreError('claimed-by-other-run')
    }
    throw new Error('run store: the claim kept changing')
  }

  async function recordOnce(trx: Kysely<Tables>, input: RecordRunInput, now: Date): Promise<RecordRunOutcome> {
    const nowIso = iso(now)
    const existing = await trx.selectFrom('card_runs').selectAll().where('run_id', '=', input.runId).executeTakeFirst()
    if (existing) {
      if (existing.repo_key !== input.repoKey || existing.issue !== input.issue || existing.agent_user_id !== input.agentUserId) {
        throw new RunStoreError('run-id-taken')
      }
      if (isTerminalStatus(existing.status)) throw new RunStoreError('run-finished', existing.status)
    }

    // Merge the reported items into the stored ones.
    const items = existing ? parseItems(existing.unverified) : []
    const byId = new Map(items.map((item) => [item.id, item]))
    let itemsAdded = false
    for (const given of input.unverified ?? []) {
      const prior = byId.get(given.id)
      if (prior) {
        if (prior.kind !== given.kind || prior.text !== given.text) throw new RunStoreError('item-changed')
        continue
      }
      const item: UnverifiedItem = { id: given.id, kind: given.kind, text: given.text }
      items.push(item)
      byId.set(item.id, item)
      itemsAdded = true
    }
    if (items.length > RUN_LIMITS.itemsPerRun) throw new RunStoreError('too-many-items')

    const resolved = existing ? ((await resolvedItemIds(trx, [existing.run_id])).get(existing.run_id) ?? new Set<string>()) : new Set<string>()

    const toProbe: { item: string; note: string | null }[] = []
    let probesSkipped = 0
    for (const probe of input.probes ?? []) {
      const item = byId.get(probe.item)
      if (!item) throw new RunStoreError('unknown-item')
      if (item.kind === 'normative') throw new RunStoreError('item-needs-a-person')
      if (resolved.has(item.id) || item.withdrawnAt !== undefined) probesSkipped += 1
      else toProbe.push(probe)
    }
    const toWithdraw = new Set<string>()
    let withdrawnSkipped = 0
    for (const id of input.withdrawn ?? []) {
      const item = byId.get(id)
      if (!item) throw new RunStoreError('unknown-item')
      if (item.kind === 'normative') throw new RunStoreError('item-needs-a-person')
      if (resolved.has(id) || item.withdrawnAt !== undefined) withdrawnSkipped += 1
      else toWithdraw.add(id)
    }
    const finalItems = items.map((item) => (toWithdraw.has(item.id) ? { ...item, withdrawnAt: nowIso } : item))

    const statusChanged = !existing || existing.status !== input.status
    const terminal = isTerminalStatus(input.status)
    const values = {
      status: input.status,
      status_at: statusChanged ? nowIso : (existing?.status_at ?? nowIso),
      triage_range: input.triageRange ?? existing?.triage_range ?? null,
      uncertainty_kind: (input.uncertaintyKind ?? existing?.uncertainty_kind ?? null) as UncertaintyKind | null,
      unverified: JSON.stringify(finalItems),
      merge_shas: input.mergeShas !== undefined ? JSON.stringify(input.mergeShas) : (existing?.merge_shas ?? '[]'),
      files: input.files !== undefined ? JSON.stringify(input.files) : (existing?.files ?? '[]'),
      files_omitted: input.filesOmitted ?? existing?.files_omitted ?? 0,
      areas: input.areas !== undefined ? JSON.stringify(input.areas) : (existing?.areas ?? '[]'),
      observed_by: input.observedBy ?? existing?.observed_by ?? null,
      fix_rounds: input.fixRounds ?? existing?.fix_rounds ?? 0,
      cost_usd: input.costUsd ?? existing?.cost_usd ?? null,
      findings: input.findings ?? existing?.findings ?? null,
      ended_at: terminal ? nowIso : null,
    }

    if (!existing) {
      const inserted = await insertIgnoringDuplicate(trx, 'card_runs', {
        run_id: input.runId,
        repo_key: input.repoKey,
        issue: input.issue,
        agent_user_id: input.agentUserId,
        started_at: nowIso,
        ...values,
      })
      if (!inserted) throw new Restart()
    } else {
      const updated = await trx
        .updateTable('card_runs')
        .set(values)
        .where('run_id', '=', input.runId)
        .where('status', 'in', HOLDING_STATUSES)
        .executeTakeFirst()
      if (Number(updated.numUpdatedRows) === 0) {
        const again = await trx.selectFrom('card_runs').select('status').where('run_id', '=', input.runId).executeTakeFirst()
        if (again && isTerminalStatus(again.status)) throw new RunStoreError('run-finished', again.status)
        throw new Restart()
      }
    }

    let claimTaken = false
    let leaseUntil: string | null = null
    if (terminal) {
      await trx
        .deleteFrom('card_claims')
        .where('repo_key', '=', input.repoKey)
        .where('issue', '=', input.issue)
        .where('run_id', '=', input.runId)
        .execute()
    } else {
      leaseUntil = input.status === 'running' ? iso(new Date(now.getTime() + RUN_LIMITS.leaseMs)) : null
      claimTaken = await takeOrRenewClaim(trx, {
        repoKey: input.repoKey,
        issue: input.issue,
        runId: input.runId,
        holder: input.agentUserId,
        leaseUntil,
        now,
      })
    }

    let probesApplied = 0
    const nowResolved = new Set(resolved)
    for (const probe of toProbe) {
      const inserted = await insertRunEvent(trx, {
        runId: input.runId,
        kind: 'probe',
        resolves: probe.item,
        note: probe.note,
        by: input.agentUserId,
        now,
      })
      if (inserted) {
        probesApplied += 1
        nowResolved.add(probe.item)
      } else {
        probesSkipped += 1
      }
    }

    const notify =
      !existing ||
      statusChanged ||
      claimTaken ||
      itemsAdded ||
      probesApplied > 0 ||
      toWithdraw.size > 0 ||
      (input.triageRange !== undefined && input.triageRange !== existing.triage_range) ||
      (input.findings !== undefined && input.findings !== existing.findings)

    return {
      status: input.status,
      created: !existing,
      statusChanged,
      claim: { held: !terminal, leaseUntil },
      unverifiedOpen: openCounts(finalItems, nowResolved),
      probesApplied,
      probesSkipped,
      withdrawnApplied: toWithdraw.size,
      withdrawnSkipped,
      notify,
    }
  }

  return {
    recordRun: (input, now) => transact((trx) => recordOnce(trx, input, now)),

    async boardActivity(repoKey: string, now: Date): Promise<BoardActivity> {
      const claims = await liveClaims(db, repoKey, now)
      const repoRuns = () => db.selectFrom('card_runs').select(RUN_COLUMNS).where('repo_key', '=', repoKey)
      const rows = await newestRows(
        BOARD_RUNS_READ,
        () => repoRuns().orderBy('status_at', 'desc').limit(BOARD_RUNS_READ).execute(),
        (statusAt) => repoRuns().where('status_at', '=', statusAt).execute(),
      )
      const lastRuns = new Map<number, RunRow>()
      for (const [issue, row] of firstPerIssue(rows)) {
        if (lastRuns.size >= RUN_LIMITS.activityCardsMax) break
        lastRuns.set(issue, row)
      }
      // A claimed issue is always listed, whatever its last run's age.
      const missing = claims.map((claim) => claim.issue).filter((issue) => !lastRuns.has(issue))
      for (const [issue, row] of firstPerIssue(await runsOfIssues(db, repoKey, missing))) lastRuns.set(issue, row)

      const resolved = await resolvedItemIds(db, [...lastRuns.values()].map((row) => row.run_id))
      const claimByIssue = new Map(claims.map((claim) => [claim.issue, claim]))
      const issues = [...new Set([...lastRuns.keys(), ...claimByIssue.keys()])].sort((a, b) => a - b)
      const cards: CardActivity[] = issues.map((issue) => {
        const claim = claimByIssue.get(issue)
        const last = lastRuns.get(issue)
        return {
          issue,
          claim: claim ? claimView(claim) : null,
          lastRun: last ? summaryView(last, resolved.get(last.run_id)) : null,
        }
      })
      return { repoKey, cards }
    },

    async issueActivity(repoKey: string, issue: number, now: Date): Promise<IssueActivity> {
      const claim = (await liveClaims(db, repoKey, now)).find((row) => row.issue === issue)
      const issueRuns = () => db
        .selectFrom('card_runs')
        .leftJoin('users', 'users.id', 'card_runs.agent_user_id')
        .leftJoin('integrations', 'integrations.user_id', 'card_runs.agent_user_id')
        .select([
          'card_runs.run_id as run_id',
          'card_runs.issue as issue',
          'card_runs.status as status',
          'card_runs.status_at as status_at',
          'card_runs.triage_range as triage_range',
          'card_runs.unverified as unverified',
          'card_runs.started_at as started_at',
          'card_runs.ended_at as ended_at',
          'card_runs.observed_by as observed_by',
          'card_runs.uncertainty_kind as uncertainty_kind',
          'card_runs.findings as findings',
          'users.username as username',
          'integrations.user_id as integration_id',
        ])
        .where('card_runs.repo_key', '=', repoKey)
        .where('card_runs.issue', '=', issue)
      const rows = await newestRows(
        RUN_LIMITS.runsPerIssueView + 1,
        () => issueRuns().orderBy('card_runs.status_at', 'desc').limit(RUN_LIMITS.runsPerIssueView + 1).execute(),
        (statusAt) => issueRuns().where('card_runs.status_at', '=', statusAt).execute(),
      )
      const shown = rows.slice(0, RUN_LIMITS.runsPerIssueView)
      const resolutions = await resolutionsOf(db, shown.map((row) => row.run_id))
      const runs: RunDetailView[] = shown.map((row) => {
        const byItem = resolutions.get(row.run_id) ?? new Map<string, ItemResolutionView>()
        const items = parseItems(row.unverified)
        return {
          ...summaryView(row, new Set(byItem.keys())),
          agent: actor(row.username, row.integration_id),
          observedBy: row.observed_by,
          uncertaintyKind: row.uncertainty_kind as UncertaintyKind | null,
          findings: row.findings,
          items: items.map((item) => itemView(row.run_id, item, byItem.get(item.id))),
        }
      })
      const response: IssueActivityResponse = {
        repoKey,
        issue,
        claim: claim ? claimView(claim) : null,
        runs,
        moreRuns: rows.length > RUN_LIMITS.runsPerIssueView,
      }
      return response
    },

    async activityFor(repoKey: string, issues: readonly number[], now: Date): Promise<ActivityForCards> {
      const claims = new Map<number, { runId: string; status: HoldingStatus; since: string }>()
      for (const row of await liveClaims(db, repoKey, now)) {
        claims.set(row.issue, { runId: row.run_id, status: row.status as HoldingStatus, since: row.status_at })
      }
      const last = firstPerIssue(await runsOfIssues(db, repoKey, [...new Set(issues)]))
      const resolved = await resolvedItemIds(db, [...last.values()].map((row) => row.run_id))
      const lastRuns: ActivityForCards['lastRuns'] = new Map()
      for (const [issue, row] of last) {
        lastRuns.set(issue, {
          runId: row.run_id,
          status: row.status,
          triageRange: row.triage_range,
          unverifiedOpen: openCounts(parseItems(row.unverified), resolved.get(row.run_id) ?? new Set()),
        })
      }
      return { claims, lastRuns }
    },

    async waitingClaims(repoKey: string, now: Date): Promise<WaitingClaim[]> {
      return (await liveClaims(db, repoKey, now))
        .filter((row) => (WAITING_STATUSES as readonly string[]).includes(row.status))
        .map((row) => ({ issue: row.issue, runId: row.run_id, status: row.status as WaitingStatus, since: row.status_at }))
        .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.issue - b.issue))
    },

    releaseClaim(repoKey: string, issue: number, runId: string): Promise<ReleaseOutcome> {
      return transact(async (trx) => {
        const deleted = await trx
          .deleteFrom('card_claims')
          .where('repo_key', '=', repoKey)
          .where('issue', '=', issue)
          .where('run_id', '=', runId)
          .executeTakeFirst()
        if (Number(deleted.numDeletedRows) > 0) return { released: true }
        const row = await claimsQuery(trx).where('card_claims.repo_key', '=', repoKey).where('card_claims.issue', '=', issue).executeTakeFirst()
        return { released: false, current: row ? claimView(row) : null }
      })
    },

    acceptItem(input: AcceptInput, now: Date): Promise<AcceptOutcome> {
      return transact(async (trx) => {
        const run = await trx.selectFrom('card_runs').select(['repo_key', 'unverified']).where('run_id', '=', input.runId).executeTakeFirst()
        if (!run || run.repo_key !== input.repoKey) return { kind: 'not-found' }
        const item = parseItems(run.unverified).find((candidate) => candidate.id === input.itemId)
        if (!item) return { kind: 'not-found' }
        if (item.kind !== 'normative') return { kind: 'not-normative' }
        const inserted = await insertRunEvent(trx, {
          runId: input.runId,
          kind: 'accepted',
          resolves: input.itemId,
          note: input.note,
          by: input.userId,
          now,
        })
        if (inserted) {
          const resolution: ItemResolutionView = {
            kind: 'accepted',
            note: input.note,
            by: await actorById(trx, input.userId),
            at: iso(now),
          }
          return { kind: 'accepted', item: itemView(input.runId, item, resolution) }
        }
        const existing = (await resolutionsOf(trx, [input.runId])).get(input.runId)?.get(input.itemId)
        return { kind: 'resolved', item: itemView(input.runId, item, existing) }
      })
    },
  }
}
