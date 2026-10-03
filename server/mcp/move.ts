/** move_card, and the save loop both move tools share. */
import type { StoredBoard } from '../../src/domain/api.ts'
import {
  bucketNumbers,
  findBucketOf,
  keepUnseenOrder,
  moveIssueTo,
  resolveBuckets,
  type MovePosition,
} from '../../src/domain/board.ts'
import { parseRepoInput } from '../../src/domain/repoRef.ts'
import type { BoardConfig, RepoRef } from '../../src/domain/types.ts'
import { readableBoard } from './boardJson.ts'
import { bucketIds } from './clean.ts'
import {
  MCP_LIMITS,
  ToolFailure,
  type BoardSnapshot,
  type McpPrincipal,
  type MoveCardJson,
  type MoveDeps,
} from './contract.ts'

export interface MoveInput {
  repoKey: string
  issue: number
  /** As the client sent it (plain id or alias); null keeps the card's bucket. */
  bucket: string | null
  position: MovePosition
  anchor: number | null
  expectedVersion: number | null
}

/** One planned change, ready for keepUnseenOrder and the postcondition. */
export interface PlannedChange<R> {
  config: BoardConfig
  /** Stored id of the bucket whose order changed. */
  bucketId: string
  /** That bucket's display order the change must produce. */
  expected: number[]
  changed: boolean
  /**
   * The snapshot the plan was computed against: the one the planner was given, or the one
   * its single refresh returned. keepUnseenOrder, the postcondition and every later attempt
   * of the save loop read this snapshot.
   */
  snapshot: BoardSnapshot
  /** The numbers of the cards the change placed: [issue] for move_card, the listed order for reorder_bucket. */
  moved: number[]
  /** True for move_card with bottom or before; false for top, after and reorder_bucket. Passed to keepUnseenOrder. */
  unseenBeforeMoved: boolean
  /** Builds the tool's result once saved. */
  result(saved: StoredBoard, attempts: number): R
}

/**
 * Plans one attempt against `snapshot`. May call snapshots.refresh at most once in the
 * attempt, and returns the snapshot it planned against in PlannedChange.snapshot.
 */
export type Planner<R> = (stored: StoredBoard, snapshot: BoardSnapshot, attempt: number) => Promise<PlannedChange<R>>

const sameNumbers = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((number, index) => number === b[index])

/** The repository as GitHub spells it, from the stored name; the save path only stores names that parse. */
function repoOf(stored: StoredBoard): RepoRef {
  const repo = parseRepoInput(stored.fullName)
  if (!repo) throw new ToolFailure('board-invalid')
  return repo
}

/**
 * Reads, plans, checks and saves under the repository lock, applying the change again after a
 * version conflict: 3 attempts in total, the first try and up to 2 re-applies; rejects with
 * ToolFailure.
 */
export async function saveWithRetries<R>(
  deps: MoveDeps,
  principal: McpPrincipal,
  signal: AbortSignal,
  repoKey: string,
  expectedVersion: number | null,
  plan: Planner<R>,
): Promise<R> {
  return deps.locks.run(repoKey, signal, async () => {
    let stored: StoredBoard | null = null
    let snapshot: BoardSnapshot | null = null
    let window: number | null = null

    for (let attempt = 1; attempt <= MCP_LIMITS.saveAttempts; attempt++) {
      if (signal.aborted) throw new ToolFailure('call-stopped')

      if (attempt === 1) stored = await deps.boards.get(repoKey)
      if (!stored) throw new ToolFailure(attempt === 1 ? 'no-board' : 'board-deleted')
      if (expectedVersion !== null && stored.version !== expectedVersion) {
        throw new ToolFailure('stale-board', { currentVersion: stored.version, cardMoved: false })
      }
      if (!readableBoard(stored.board)) throw new ToolFailure('board-invalid')

      if (snapshot === null || window !== stored.board.closedWindowDays) {
        window = stored.board.closedWindowDays
        snapshot = await deps.snapshots.get({
          userId: principal.userId,
          repo: repoOf(stored),
          repoKey,
          closedWindowDays: window,
          signal,
        })
      }

      const planned = await plan(stored, snapshot, attempt)
      snapshot = planned.snapshot
      if (!planned.changed) throw new ToolFailure('no-change')

      const final = keepUnseenOrder(stored.board, planned.config, planned.bucketId, planned.snapshot.seen, {
        truncated: planned.snapshot.truncated,
        highestNumber: planned.snapshot.highestNumber,
        moved: new Set(planned.moved),
        unseenBeforeMoved: planned.unseenBeforeMoved,
      })
      const shown = bucketNumbers(resolveBuckets(planned.snapshot.issues, final), planned.bucketId)
      if (!sameNumbers(shown, planned.expected)) {
        deps.log.error('mcp move postcondition failed', { integration: principal.userId, repo: repoKey })
        throw new ToolFailure('server-error')
      }

      if (signal.aborted || !(await deps.tokenIsLive(principal.tokenId))) {
        throw new ToolFailure('call-stopped')
      }

      const outcome = await deps.save({
        repoKey,
        baseVersion: stored.version,
        fullName: stored.fullName,
        board: final,
        editor: { id: principal.userId, username: principal.username, kind: 'integration' },
        clientId: null,
      })
      if (outcome.saved) return planned.result(outcome.stored, attempt)
      if (expectedVersion !== null) {
        throw new ToolFailure('stale-board', { currentVersion: outcome.current?.version ?? null, cardMoved: false })
      }
      stored = outcome.current
    }
    throw new ToolFailure('board-busy')
  })
}

/**
 * Finds an open issue in the snapshot, refreshing at most once (through `refresh`) when the number
 * may be newer than the snapshot or the snapshot shows it closed and is older than 10 seconds.
 * Returns the snapshot the answer is based on.
 */
export async function findOpenIssue(
  deps: Pick<MoveDeps, 'now'>,
  number: number,
  snapshot: BoardSnapshot,
  refresh: () => Promise<BoardSnapshot>,
): Promise<BoardSnapshot> {
  let snap = snapshot
  let refreshed = false
  for (;;) {
    const issue = snap.issues.find((candidate) => candidate.number === number)
    if (!issue) {
      if (snap.pullRequests.has(number)) throw new ToolFailure('is-pull-request')
      if (number <= snap.highestNumber || refreshed) throw new ToolFailure('issue-not-on-board')
    } else if (issue.state === 'closed') {
      const stale = deps.now().getTime() - snap.fetchedAt > MCP_LIMITS.closedRefetchAgeMs
      if (!stale || refreshed) throw new ToolFailure('issue-closed')
    } else {
      return snap
    }
    snap = await refresh()
    refreshed = true
  }
}

/** A function that fetches a new snapshot at most once per planner call and remembers it. */
export function onceRefresh(
  deps: Pick<MoveDeps, 'snapshots'>,
  principal: McpPrincipal,
  signal: AbortSignal,
  stored: StoredBoard,
  current: () => BoardSnapshot,
  replace: (snapshot: BoardSnapshot) => void,
): () => Promise<BoardSnapshot> {
  let used = false
  return async () => {
    if (used) return current()
    used = true
    const fresh = await deps.snapshots.refresh({
      userId: principal.userId,
      repo: repoOf(stored),
      repoKey: stored.repoKey,
      closedWindowDays: stored.board.closedWindowDays,
      signal,
    })
    replace(fresh)
    return fresh
  }
}

export async function moveCard(
  deps: MoveDeps,
  principal: McpPrincipal,
  signal: AbortSignal,
  input: MoveInput,
): Promise<MoveCardJson> {
  let target: string | null = null

  const planner: Planner<MoveCardJson> = async (stored, given, attempt) => {
    const ids = bucketIds(stored.board.buckets)
    let snap = given

    let explicit: string | null = null
    if (input.bucket !== null) {
      explicit = ids.fromInput(input.bucket)
      if (explicit === null) throw new ToolFailure('bucket-not-found')
    }

    const refresh = onceRefresh(deps, principal, signal, stored, () => snap, (fresh) => (snap = fresh))
    snap = await findOpenIssue(deps, input.issue, snap, refresh)

    const contents = resolveBuckets(snap.issues, stored.board)
    if (explicit !== null) {
      target = explicit
    } else {
      const current = findBucketOf(contents, input.issue)
      if (attempt === 1) {
        if (current === undefined) throw new ToolFailure('bucket-not-found')
        target = current
      } else if (current !== target) {
        throw new ToolFailure('stale-board', { currentVersion: stored.version, cardMoved: true })
      }
    }
    const bucketId = target as string

    if (input.position === 'before' || input.position === 'after') {
      const list = bucketNumbers(contents, bucketId)
      if (input.anchor === null || input.anchor === input.issue || !list.includes(input.anchor)) {
        throw new ToolFailure('anchor-not-in-bucket')
      }
    }

    const move = moveIssueTo(stored.board, snap.issues, input.issue, bucketId, input.position, input.anchor)
    if (move.index < 0) throw new Error('move precondition failed')
    const from = ids.toOutput(move.from)
    const to = ids.toOutput(bucketId)
    return {
      config: move.config,
      bucketId,
      expected: move.expected,
      changed: move.changed,
      snapshot: snap,
      moved: [input.issue],
      unseenBeforeMoved: input.position === 'bottom' || input.position === 'before',
      result: (saved, attempts) => ({
        repo: saved.repoKey,
        version: saved.version,
        issue: input.issue,
        from,
        to,
        index: move.index,
        bucketSize: move.expected.length,
        attempts,
      }),
    }
  }

  const result = await saveWithRetries(deps, principal, signal, input.repoKey, input.expectedVersion, planner)
  deps.log.info('mcp move', {
    integration: principal.userId,
    tokenId: principal.tokenId,
    repo: result.repo,
    issue: result.issue,
    from: result.from,
    to: result.to,
    version: result.version,
  })
  return result
}
