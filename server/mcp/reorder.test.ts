import { describe, expect, it, vi } from 'vitest'
import type { StoredBoard } from '../../src/domain/api.ts'
import { bucketNumbers, resolveBuckets } from '../../src/domain/board.ts'
import type { BoardConfig, Bucket, Issue } from '../../src/domain/types.ts'
import { bucketAlias } from './clean.ts'
import {
  ToolFailure,
  type BoardSnapshot,
  type McpPrincipal,
  type MoveDeps,
  type SaveRequest,
} from './contract.ts'
import { createRepoLocks } from './locks.ts'
import { reorderBucketTool, type ReorderInput } from './reorder.ts'

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const PRINCIPAL: McpPrincipal = { userId: 'int-1', username: 'planner-bot', tokenId: 'tok-1' }

function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    stateReason: null,
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    assignees: [],
    author: null,
    milestone: null,
    comments: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    ...overrides,
  }
}

function makeBucket(id: string, overrides: Partial<Bucket> = {}): Bucket {
  return { id, title: id, wipLimit: null, labelRules: [], collectsClosed: false, ...overrides }
}

/** backlog [4, 5], todo [1, 2, 3] (label rule + hand order), done collects closed issues. */
function board(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    version: 1,
    buckets: [makeBucket('backlog'), makeBucket('todo', { labelRules: ['todo'] }), makeBucket('done', { collectsClosed: true })],
    placements: {},
    order: { todo: [1, 2, 3], backlog: [4, 5] },
    closedWindowDays: 14,
    ...overrides,
  }
}

function issues(): Issue[] {
  return [
    makeIssue(1, { labels: ['todo'] }),
    makeIssue(2, { labels: ['todo'] }),
    makeIssue(3, { labels: ['todo'] }),
    makeIssue(4),
    makeIssue(5),
    makeIssue(6, { state: 'closed', closedAt: '2026-01-02T00:00:00Z' }),
  ]
}

function snapshotOf(list: Issue[], overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    issues: list,
    seen: new Set(list.map((issue) => issue.number)),
    highestNumber: Math.max(0, ...list.map((issue) => issue.number)),
    pullRequests: new Set(),
    truncated: false,
    isPrivate: false,
    fetchedAt: NOW,
    ...overrides,
  }
}

function storedOf(config: BoardConfig, version = 1): StoredBoard {
  return {
    repoKey: 'acme/widgets',
    fullName: 'Acme/Widgets',
    version,
    updatedAt: '2026-10-03T11:00:00.000Z',
    updatedBy: { id: 'u1', username: 'ada', kind: 'person' },
    board: config,
  }
}

interface World {
  deps: MoveDeps
  /** The board as stored now; a test may replace it to play another editor's save. */
  current: { value: StoredBoard | null }
  saves: SaveRequest[]
  logs: { level: string; message: string; fields?: unknown }[]
  snapshot: { value: BoardSnapshot }
  refreshed: { value: BoardSnapshot | null }
  /** Runs before each save is applied, with the number of the save (1-based). */
  beforeSave: { value: ((n: number) => void) | null }
  live: { value: boolean }
}

function world(config: BoardConfig = board(), list: Issue[] = issues()): World {
  const current: World['current'] = { value: storedOf(config) }
  const saves: SaveRequest[] = []
  const logs: World['logs'] = []
  const snapshot = { value: snapshotOf(list) }
  const refreshed: World['refreshed'] = { value: null }
  const beforeSave: World['beforeSave'] = { value: null }
  const live = { value: true }
  const record = (level: string) => (message: string, fields?: unknown) => {
    logs.push({ level, message, fields })
  }
  const deps: MoveDeps = {
    log: { info: record('info'), warn: record('warn'), error: record('error') },
    now: () => new Date(NOW),
    boards: {
      get: async () => (current.value ? structuredClone(current.value) : null),
      summaries: async () => [],
    },
    snapshots: {
      get: vi.fn(async () => snapshot.value),
      refresh: vi.fn(async () => {
        if (refreshed.value) snapshot.value = refreshed.value
        return snapshot.value
      }),
      invalidate: vi.fn(),
    },
    save: vi.fn(async (request: SaveRequest) => {
      saves.push(request)
      await new Promise((resolve) => setTimeout(resolve, 1))
      beforeSave.value?.(saves.length)
      const now = current.value
      if (!now || request.baseVersion !== now.version) return { saved: false as const, current: now && structuredClone(now) }
      current.value = { ...now, version: now.version + 1, board: request.board, updatedBy: { ...request.editor } }
      return { saved: true as const, stored: structuredClone(current.value) }
    }),
    locks: createRepoLocks(),
    tokenIsLive: async () => live.value,
  }
  return { deps, current, saves, logs, snapshot, refreshed, beforeSave, live }
}

function input(overrides: Partial<ReorderInput> = {}): ReorderInput {
  return { repoKey: 'acme/widgets', bucket: 'todo', order: [3, 1], expectedVersion: null, ...overrides }
}

/** Buckets todo, doing, done (done collects closed); the stored order mentions card 500, which no snapshot holds. */
function refreshWorld() {
  const config = board({
    buckets: [makeBucket('todo'), makeBucket('doing'), makeBucket('done', { collectsClosed: true })],
    order: { doing: [500] },
  })
  const created = (number: number) => ({ createdAt: `2026-09-0${number}T00:00:00Z` })
  const open = [1, 2, 3].map((number) => makeIssue(number, created(number)))
  const stale = [
    open[0],
    makeIssue(2, { ...created(2), state: 'closed', closedAt: '2026-09-30T00:00:00Z' }),
  ]
  const w = world(config, stale)
  w.snapshot.value = snapshotOf(stale, { fetchedAt: NOW - 30_000, highestNumber: 2 })
  w.refreshed.value = snapshotOf(open, { highestNumber: 3 })
  return { w, open }
}

const signal = () => new AbortController().signal

async function failureOf(promise: Promise<unknown>): Promise<ToolFailure> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ToolFailure)
    return error as ToolFailure
  }
  throw new Error('expected a ToolFailure')
}

function displayed(w: World, bucket: string, list: Issue[] = issues()): number[] {
  return bucketNumbers(resolveBuckets(list, (w.current.value as StoredBoard).board), bucket)
}

describe('reorderBucketTool', () => {
  it('puts the listed cards first, keeps the others after them, and saves once', async () => {
    const w = world(board({ order: { todo: [1, 2, 3, 4] } }), [...issues().slice(0, 3), makeIssue(4, { labels: ['todo'] })])
    const result = await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [3, 1] }))
    expect(result).toEqual({ repo: 'acme/widgets', version: 2, bucket: 'todo', order: [3, 1, 2, 4], attempts: 1 })
    expect(w.saves).toHaveLength(1)
    expect(w.saves[0].editor).toEqual({ id: 'int-1', username: 'planner-bot', kind: 'integration' })
    expect(w.saves[0].clientId).toBeNull()
    expect((w.current.value as StoredBoard).board.order.todo).toEqual([3, 1, 2, 4])
  })

  it('answers no-change and saves nothing for an order the bucket already has', async () => {
    const w = world()
    expect((await failureOf(reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [1, 2] })))).code).toBe('no-change')
    expect(w.saves).toHaveLength(0)
  })

  it('names the failure for a card that is not in the bucket, a pull request, a closed card or an unknown bucket', async () => {
    const w = world()
    w.snapshot.value = snapshotOf(issues(), { pullRequests: new Set([9]), highestNumber: 20 })
    const code = async (overrides: Partial<ReorderInput>) =>
      (await failureOf(reorderBucketTool(w.deps, PRINCIPAL, signal(), input(overrides)))).code
    expect(await code({ order: [4] })).toBe('card-not-in-bucket')
    expect(await code({ order: [1, 15] })).toBe('card-not-in-bucket')
    expect(await code({ order: [9] })).toBe('is-pull-request')
    expect(await code({ bucket: 'done', order: [6] })).toBe('issue-closed')
    expect(await code({ bucket: 'nope' })).toBe('bucket-not-found')
    expect(w.saves).toHaveLength(0)
    expect(w.deps.snapshots.refresh).not.toHaveBeenCalled()
  })

  it('refreshes once for several listed cards newer than the snapshot', async () => {
    const w = world()
    w.refreshed.value = snapshotOf([...issues(), makeIssue(30, { labels: ['todo'] }), makeIssue(31, { labels: ['todo'] })])
    const result = await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [31, 30] }))
    expect(w.deps.snapshots.refresh).toHaveBeenCalledTimes(1)
    expect(result.order.slice(0, 2)).toEqual([31, 30])
    expect(w.saves).toHaveLength(1)
  })

  it('refreshes once when a listed card is closed in a snapshot older than 10 seconds', async () => {
    const w = world(board({ order: { todo: [1, 2, 3], done: [6] } }))
    w.snapshot.value = snapshotOf(issues(), { fetchedAt: NOW - 11_000 })
    w.refreshed.value = snapshotOf([...issues().slice(0, 5), makeIssue(6, { labels: ['todo'] })])
    const result = await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [6] }))
    expect(w.deps.snapshots.refresh).toHaveBeenCalledTimes(1)
    expect(result.order).toEqual([6, 1, 2, 3])
  })

  it('keeps the stored order of cards the snapshot did not contain, after the listed cards', async () => {
    const w = world(board({ order: { todo: [7, 500, 3] } }), [makeIssue(3, { labels: ['todo'] }), makeIssue(7, { labels: ['todo'] })])
    const result = await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [3] }))
    expect(result.order).toEqual([3, 7])
    expect((w.current.value as StoredBoard).board.order.todo).toEqual([3, 7, 500])
    expect(displayed(w, 'todo', [makeIssue(3, { labels: ['todo'] }), makeIssue(7, { labels: ['todo'] })])).toEqual([3, 7])
  })

  it('applies the change again after a version conflict, still with one save per attempt', async () => {
    const w = world()
    w.beforeSave.value = (n) => {
      if (n === 1) w.current.value = { ...(w.current.value as StoredBoard), version: 2 }
    }
    const result = await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [3] }))
    expect(result).toMatchObject({ attempts: 2, version: 3 })
    expect(w.saves).toHaveLength(2)
  })

  it('answers stale-board for a changed version and no-board for a missing board', async () => {
    const w = world()
    const failure = await failureOf(reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ expectedVersion: 9 })))
    expect(failure).toMatchObject({ code: 'stale-board', extra: { currentVersion: 1, cardMoved: false } })
    w.current.value = null
    expect((await failureOf(reorderBucketTool(w.deps, PRINCIPAL, signal(), input()))).code).toBe('no-board')
  })

  it('writes one audit line with ids and numbers only', async () => {
    const w = world()
    await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [3, 1] }))
    expect(w.logs).toEqual([
      {
        level: 'info',
        message: 'mcp reorder',
        fields: { integration: 'int-1', tokenId: 'tok-1', repo: 'acme/widgets', bucket: 'todo', count: 2, version: 2 },
      },
    ])
  })

  it('prints a non-plain bucket id as its alias in the result', async () => {
    const odd = 'Em andamento!'
    const config = board({ buckets: [...board().buckets, makeBucket(odd, { labelRules: ['odd'] })], order: { [odd]: [8, 9] } })
    const w = world(config, [...issues(), makeIssue(8, { labels: ['odd'] }), makeIssue(9, { labels: ['odd'] })])
    const result = await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ bucket: bucketAlias(odd), order: [9] }))
    expect(result).toMatchObject({ bucket: bucketAlias(odd), order: [9, 8] })
  })
})

describe('reorderBucketTool after a refresh', () => {
  it('orders todo as [3, 1, 2] after refreshing to find card 3', async () => {
    const { w } = refreshWorld()
    const result = await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [3, 1] }))
    expect(result.order).toEqual([3, 1, 2])
    expect((w.current.value as StoredBoard).board.order.todo).toEqual([3, 1, 2])
  })

  it('refreshes once to find card 2, which the old snapshot shows closed', async () => {
    const { w } = refreshWorld()
    const result = await reorderBucketTool(w.deps, PRINCIPAL, signal(), input({ order: [2, 1] }))
    expect(result.order).toEqual([2, 1, 3])
    expect(w.deps.snapshots.get).toHaveBeenCalledTimes(1)
    expect(w.deps.snapshots.refresh).toHaveBeenCalledTimes(1)
  })
})
