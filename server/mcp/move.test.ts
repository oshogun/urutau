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
import { moveCard, saveWithRetries, type MoveInput } from './move.ts'

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

function input(overrides: Partial<MoveInput> = {}): MoveInput {
  return {
    repoKey: 'acme/widgets',
    issue: 4,
    bucket: null,
    position: 'bottom',
    anchor: null,
    expectedVersion: null,
    ...overrides,
  }
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
  const stored = w.current.value as StoredBoard
  return bucketNumbers(resolveBuckets(list, stored.board), bucket)
}

describe('moveCard', () => {
  it('moves a card to the top of another bucket, saves once, and reports where it went', async () => {
    const w = world()
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 4, bucket: 'todo', position: 'top' }))
    expect(result).toEqual({
      repo: 'acme/widgets',
      version: 2,
      issue: 4,
      from: 'backlog',
      to: 'todo',
      index: 0,
      bucketSize: 4,
      attempts: 1,
    })
    expect(w.saves).toHaveLength(1)
    expect(w.saves[0]).toMatchObject({
      repoKey: 'acme/widgets',
      baseVersion: 1,
      fullName: 'Acme/Widgets',
      clientId: null,
      editor: { id: 'int-1', username: 'planner-bot', kind: 'integration' },
    })
    expect(displayed(w, 'todo')).toEqual([4, 1, 2, 3])
  })

  it('counts positions with the moving card removed first', async () => {
    const w = world()
    await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 1, bucket: 'todo', position: 'after', anchor: 3 }))
    expect(displayed(w, 'todo')).toEqual([2, 3, 1])
  })

  it('keeps the card in its own bucket when none is named', async () => {
    const w = world()
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 3, position: 'top' }))
    expect(result).toMatchObject({ from: 'todo', to: 'todo', index: 0, bucketSize: 3 })
    expect(displayed(w, 'todo')).toEqual([3, 1, 2])
  })

  it('answers no-change and saves nothing when the board would look the same', async () => {
    const w = world()
    const failure = await failureOf(moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 2, position: 'after', anchor: 1 })))
    expect(failure.code).toBe('no-change')
    expect(w.saves).toHaveLength(0)
    expect(w.deps.save).not.toHaveBeenCalled()
  })

  it('names a bucket by its alias when its stored id is not plain', async () => {
    const odd = 'Em andamento!'
    const config = board({ buckets: [...board().buckets, makeBucket(odd, { labelRules: ['odd'] })] })
    const w = world(config)
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 4, bucket: bucketAlias(odd), position: 'top' }))
    expect(result.to).toBe(bucketAlias(odd))
    expect((w.current.value as StoredBoard).board.placements[4]).toBe(odd)
  })

  it('fails with the specific code for each unusable input', async () => {
    const w = world()
    w.snapshot.value = snapshotOf(issues(), { pullRequests: new Set([9]), highestNumber: 20 })
    const code = async (overrides: Partial<MoveInput>) =>
      (await failureOf(moveCard(w.deps, PRINCIPAL, signal(), input(overrides)))).code
    expect(await code({ bucket: 'nope' })).toBe('bucket-not-found')
    expect(await code({ bucket: 'bad id!' })).toBe('bucket-not-found')
    expect(await code({ issue: 9 })).toBe('is-pull-request')
    expect(await code({ issue: 15 })).toBe('issue-not-on-board')
    expect(await code({ issue: 6 })).toBe('issue-closed')
    expect(await code({ issue: 4, bucket: 'todo', position: 'before', anchor: 5 })).toBe('anchor-not-in-bucket')
    expect(await code({ issue: 1, position: 'before', anchor: 1 })).toBe('anchor-not-in-bucket')
    expect(w.saves).toHaveLength(0)
    expect(w.deps.snapshots.refresh).not.toHaveBeenCalled()
  })

  it('fails with no-board, board-invalid and board-deleted', async () => {
    const none = world()
    none.current.value = null
    expect((await failureOf(moveCard(none.deps, PRINCIPAL, signal(), input()))).code).toBe('no-board')
    expect(none.deps.snapshots.get).not.toHaveBeenCalled()

    const bad = world()
    ;(bad.current.value as StoredBoard).board.placements = { 4: 7 } as never
    expect((await failureOf(moveCard(bad.deps, PRINCIPAL, signal(), input()))).code).toBe('board-invalid')

    const gone = world()
    gone.beforeSave.value = () => {
      gone.current.value = null
    }
    expect((await failureOf(moveCard(gone.deps, PRINCIPAL, signal(), input({ bucket: 'todo' })))).code).toBe('board-deleted')
  })

  it('refreshes once for an issue newer than the snapshot and plans on the refreshed one', async () => {
    const w = world()
    w.refreshed.value = snapshotOf([...issues(), makeIssue(30)])
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 30, bucket: 'todo', position: 'top' }))
    expect(result).toMatchObject({ issue: 30, from: 'backlog', to: 'todo', index: 0, bucketSize: 4 })
    expect(w.deps.snapshots.refresh).toHaveBeenCalledTimes(1)
    expect(w.deps.snapshots.get).toHaveBeenCalledTimes(1)
  })

  it('refreshes a closed issue only when the snapshot is older than 10 seconds', async () => {
    const young = world()
    expect((await failureOf(moveCard(young.deps, PRINCIPAL, signal(), input({ issue: 6 })))).code).toBe('issue-closed')
    expect(young.deps.snapshots.refresh).not.toHaveBeenCalled()

    const old = world()
    old.snapshot.value = snapshotOf(issues(), { fetchedAt: NOW - 11_000 })
    old.refreshed.value = snapshotOf([...issues().slice(0, 5), makeIssue(6)])
    const result = await moveCard(old.deps, PRINCIPAL, signal(), input({ issue: 6, bucket: 'todo', position: 'top' }))
    expect(old.deps.snapshots.refresh).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ issue: 6, to: 'todo' })
    expect((old.current.value as StoredBoard).board.placements[6]).toBe('todo')
  })

  it('writes one audit line with ids and numbers only', async () => {
    const w = world()
    await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 4, bucket: 'todo', position: 'top' }))
    const lines = w.logs.filter((line) => line.message === 'mcp move')
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'mcp move',
        fields: { integration: 'int-1', tokenId: 'tok-1', repo: 'acme/widgets', issue: 4, from: 'backlog', to: 'todo', version: 2 },
      },
    ])
    expect(JSON.stringify(w.logs)).not.toContain('Issue 4')
    expect(JSON.stringify(w.logs)).not.toContain('planner-bot')
  })
})

describe('the save loop', () => {
  it('applies the change again after a version conflict and counts the attempts', async () => {
    const w = world()
    w.beforeSave.value = (n) => {
      if (n <= 2) w.current.value = { ...(w.current.value as StoredBoard), version: (w.current.value as StoredBoard).version + 1 }
    }
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 4, bucket: 'todo', position: 'top' }))
    expect(result).toMatchObject({ attempts: 3, version: 4 })
    expect(w.saves.map((save) => save.baseVersion)).toEqual([1, 2, 3])
    expect(w.deps.snapshots.get).toHaveBeenCalledTimes(1)
  })

  it('answers board-busy after the third conflict and saves nothing', async () => {
    const w = world()
    w.beforeSave.value = () => {
      w.current.value = { ...(w.current.value as StoredBoard), version: (w.current.value as StoredBoard).version + 1 }
    }
    const failure = await failureOf(moveCard(w.deps, PRINCIPAL, signal(), input({ bucket: 'todo' })))
    expect(failure.code).toBe('board-busy')
    expect(w.saves).toHaveLength(3)
    expect((w.current.value as StoredBoard).board).toEqual(board())
  })

  it('fetches a new snapshot only when the closed-issue window changed between attempts', async () => {
    const w = world()
    w.beforeSave.value = (n) => {
      if (n === 1) {
        const now = w.current.value as StoredBoard
        w.current.value = { ...now, version: now.version + 1, board: { ...now.board, closedWindowDays: 30 } }
      }
    }
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ bucket: 'todo' }))
    expect(result.attempts).toBe(2)
    expect(w.deps.snapshots.get).toHaveBeenCalledTimes(2)
    expect(vi.mocked(w.deps.snapshots.get).mock.calls[1][0].closedWindowDays).toBe(30)
  })

  it('answers stale-board with the current version when expectedVersion no longer matches', async () => {
    const w = world()
    const failure = await failureOf(moveCard(w.deps, PRINCIPAL, signal(), input({ bucket: 'todo', expectedVersion: 5 })))
    expect(failure).toMatchObject({ code: 'stale-board', extra: { currentVersion: 1, cardMoved: false } })
    expect(w.saves).toHaveLength(0)
    expect(w.deps.snapshots.get).not.toHaveBeenCalled()
  })

  it('does not re-apply when expectedVersion was given and the save lost a race', async () => {
    const w = world()
    w.beforeSave.value = () => {
      w.current.value = { ...(w.current.value as StoredBoard), version: 2 }
    }
    const failure = await failureOf(moveCard(w.deps, PRINCIPAL, signal(), input({ bucket: 'todo', expectedVersion: 1 })))
    expect(failure).toMatchObject({ code: 'stale-board', extra: { currentVersion: 2, cardMoved: false } })
    expect(w.saves).toHaveLength(1)
  })

  it('answers stale-board with cardMoved when a person moved the card to another bucket between attempts', async () => {
    const w = world()
    w.beforeSave.value = () => {
      const now = w.current.value as StoredBoard
      w.current.value = { ...now, version: now.version + 1, board: { ...now.board, placements: { 5: 'todo' } } }
    }
    const failure = await failureOf(moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 5, position: 'top' })))
    expect(failure).toMatchObject({ code: 'stale-board', extra: { currentVersion: 2, cardMoved: true } })
    expect(w.saves).toHaveLength(1)
  })

  it('five concurrent moves all succeed, in arrival order, without conflicts', async () => {
    const w = world()
    const moves = [1, 2, 3, 4, 5].map((issue) =>
      moveCard(w.deps, PRINCIPAL, signal(), input({ issue, bucket: 'done', position: 'top' })),
    )
    const results = await Promise.all(moves)
    expect(results.map((result) => result.attempts)).toEqual([1, 1, 1, 1, 1])
    expect(results.map((result) => result.version)).toEqual([2, 3, 4, 5, 6])
    expect(w.saves.map((save) => save.baseVersion)).toEqual([1, 2, 3, 4, 5])
    const stored = w.current.value as StoredBoard
    expect(stored.board.order.done).toEqual([5, 4, 3, 2, 1, 6])
  })

  it('keeps the stored order of cards the snapshot did not contain', async () => {
    const config = board({ order: { todo: [7, 500, 3] } })
    const w = world(config, [makeIssue(3, { labels: ['todo'] }), makeIssue(7, { labels: ['todo'] })])
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 3, position: 'top' }))
    expect(result).toMatchObject({ index: 0, bucketSize: 2 })
    expect((w.current.value as StoredBoard).board.order.todo).toEqual([3, 7, 500])
  })

  it('stops with call-stopped, saving nothing, when the signal aborted or the token row is gone', async () => {
    const aborted = world()
    const controller = new AbortController()
    controller.abort()
    expect((await failureOf(moveCard(aborted.deps, PRINCIPAL, controller.signal, input()))).code).toBe('call-stopped')
    expect(aborted.saves).toHaveLength(0)

    const revoked = world()
    revoked.live.value = false
    expect((await failureOf(moveCard(revoked.deps, PRINCIPAL, signal(), input({ bucket: 'todo' })))).code).toBe('call-stopped')
    expect(revoked.saves).toHaveLength(0)
  })

  it('refuses to save when the plan does not produce the order it promised', async () => {
    const w = world()
    const failure = await failureOf(
      saveWithRetries(w.deps, PRINCIPAL, signal(), 'acme/widgets', null, async (stored, snapshot) => ({
        config: stored.board,
        bucketId: 'todo',
        expected: [99],
        changed: true,
        snapshot,
        moved: [99],
        unseenBeforeMoved: false,
        result: () => 'unreachable',
      })),
    )
    expect(failure.code).toBe('server-error')
    expect(w.saves).toHaveLength(0)
    expect(w.logs).toEqual([
      { level: 'error', message: 'mcp move postcondition failed', fields: { integration: 'int-1', repo: 'acme/widgets' } },
    ])
  })

  it('propagates a ToolFailure from the snapshot provider unchanged', async () => {
    const w = world()
    vi.mocked(w.deps.snapshots.get).mockRejectedValueOnce(new ToolFailure('github-busy', { retryAfterSeconds: 5 }))
    const failure = await failureOf(moveCard(w.deps, PRINCIPAL, signal(), input({ bucket: 'todo' })))
    expect(failure).toMatchObject({ code: 'github-busy', extra: { retryAfterSeconds: 5 } })
  })
})

describe('moveCard after a refresh', () => {
  it('puts card 3 at the bottom of doing and keeps the unseen card 500 above it', async () => {
    const { w, open } = refreshWorld()
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 3, bucket: 'doing', position: 'bottom' }))
    expect(result).toMatchObject({ attempts: 1, to: 'doing' })
    const stored = (w.current.value as StoredBoard).board
    expect(stored.order.doing).toEqual([500, 3])
    expect(stored.placements).toEqual({ 3: 'doing' })
    expect(displayed(w, 'doing', open)).toEqual([3])
    expect(w.deps.snapshots.get).toHaveBeenCalledTimes(1)
    expect(w.deps.snapshots.refresh).toHaveBeenCalledTimes(1)
  })

  it('moves card 3 to the bottom of its own bucket, todo', async () => {
    const { w, open } = refreshWorld()
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 3, position: 'bottom' }))
    expect(result).toMatchObject({ to: 'todo' })
    expect(displayed(w, 'todo', open)).toEqual([2, 1, 3])
  })

  it('puts card 2 at the top of doing, above the unseen card 500', async () => {
    const { w, open } = refreshWorld()
    await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 2, bucket: 'doing', position: 'top' }))
    expect(displayed(w, 'doing', open)).toEqual([2])
    expect((w.current.value as StoredBoard).board.order.doing).toEqual([2, 500])
  })

  it('moves card 2, closed in the old snapshot, to the top of todo without pinning it to done', async () => {
    const { w, open } = refreshWorld()
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 2, position: 'top' }))
    expect(result).toMatchObject({ to: 'todo' })
    expect(displayed(w, 'todo', open)).toEqual([2, 3, 1])
    expect((w.current.value as StoredBoard).board.placements).toEqual({})
  })

  it('re-applies after a 409 without asking the provider again', async () => {
    const { w } = refreshWorld()
    w.beforeSave.value = (n) => {
      if (n === 1) w.current.value = { ...(w.current.value as StoredBoard), version: 2 }
    }
    const result = await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 3, bucket: 'doing', position: 'bottom' }))
    expect(result.attempts).toBe(2)
    expect(w.saves).toHaveLength(2)
    expect(w.deps.snapshots.get).toHaveBeenCalledTimes(1)
    expect(w.deps.snapshots.refresh).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown bucket without refreshing', async () => {
    const { w } = refreshWorld()
    const failure = await failureOf(moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 3, bucket: 'nope' })))
    expect(failure.code).toBe('bucket-not-found')
    expect(w.deps.snapshots.refresh).not.toHaveBeenCalled()
  })

  it('moves card 1, which the old snapshot holds, with no refresh', async () => {
    const { w, open } = refreshWorld()
    await moveCard(w.deps, PRINCIPAL, signal(), input({ issue: 1, bucket: 'doing', position: 'top' }))
    expect(w.deps.snapshots.refresh).not.toHaveBeenCalled()
    expect(displayed(w, 'doing', open)).toEqual([1])
  })

  it('stops with call-stopped and no save when the call is aborted while the snapshot loads', async () => {
    const w = world()
    const controller = new AbortController()
    let release!: () => void
    vi.mocked(w.deps.snapshots.get).mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(w.snapshot.value))),
    )
    const pending = failureOf(moveCard(w.deps, PRINCIPAL, controller.signal, input({ issue: 4, bucket: 'todo' })))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    controller.abort()
    release()
    expect((await pending).code).toBe('call-stopped')
    expect(w.saves).toHaveLength(0)
  })
})
