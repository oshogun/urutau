import { describe, expect, it, vi } from 'vitest'
import type { Issue, RepoRef } from '../../src/domain/types.ts'
import { MCP_LIMITS, ToolFailure, type FetchSnapshotFn, type ReaderSnapshot, type SnapshotRequest } from './contract.ts'
import { createSnapshotCache } from './snapshots.ts'

const REPO: RepoRef = { owner: 'acme', name: 'widgets' }

function issue(number: number): Issue {
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
  }
}

function read(numbers: number[], extra: Partial<ReaderSnapshot> = {}): ReaderSnapshot {
  return {
    snapshot: {
      repository: { fullName: 'acme/widgets', description: null, url: '', isPrivate: true },
      labels: [],
      issues: numbers.map(issue),
      truncated: false,
      fetchedAt: 1000,
    },
    highestNumber: Math.max(0, ...numbers),
    pullRequests: [],
    openTruncated: false,
    closedTruncated: false,
    ...extra,
  }
}

function setUp(fetchSnapshot?: FetchSnapshotFn) {
  const clock = { ms: Date.UTC(2026, 5, 1) }
  const calls: Array<{ userId: string; days: number; signal: AbortSignal }> = []
  const fetcher: FetchSnapshotFn = fetchSnapshot ?? (async () => read([1, 2, 3]))
  const recording: FetchSnapshotFn = async (userId, repo, days, signal) => {
    calls.push({ userId, days, signal })
    return fetcher(userId, repo, days, signal)
  }
  const cache = createSnapshotCache({ fetchSnapshot: recording, now: () => new Date(clock.ms) })
  const request = (over: Partial<SnapshotRequest> = {}): SnapshotRequest => ({
    userId: 'bot-1',
    repo: REPO,
    repoKey: 'acme/widgets',
    closedWindowDays: 14,
    signal: new AbortController().signal,
    ...over,
  })
  return { cache, clock, calls, request }
}

describe('snapshot cache', () => {
  it('builds the board snapshot from the reader result', async () => {
    const { cache, request } = setUp(async () => read([5, 9], { highestNumber: 12, pullRequests: [12], closedTruncated: true }))
    const snapshot = await cache.get(request())
    expect([...snapshot.seen]).toEqual([5, 9])
    expect(snapshot.highestNumber).toBe(12)
    expect([...snapshot.pullRequests]).toEqual([12])
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.isPrivate).toBe(true)
    expect(snapshot.fetchedAt).toBe(1000)
  })

  it('does not keep a failed entry when fetchSnapshot throws synchronously', async () => {
    let first = true
    const { cache, calls, request } = setUp((() => {
      if (first) {
        first = false
        throw new ToolFailure('github-unavailable')
      }
      return Promise.resolve(read([1]))
    }) as FetchSnapshotFn)
    await expect(cache.get(request())).rejects.toMatchObject({ code: 'github-unavailable' })
    await expect(cache.get(request())).resolves.toMatchObject({ highestNumber: 1 })
    expect(calls).toHaveLength(2)
  })

  it('makes zero fetches while the cache is warm and fetches again after 60 seconds', async () => {
    const { cache, clock, calls, request } = setUp()
    await cache.get(request())
    clock.ms += MCP_LIMITS.snapshotTtlMs - 1
    await cache.get(request())
    expect(calls).toHaveLength(1)
    clock.ms += 1
    await cache.get(request())
    expect(calls).toHaveLength(2)
  })

  it('keys the cache by account, repository and closed window', async () => {
    const { cache, calls, request } = setUp()
    await cache.get(request())
    await cache.get(request({ userId: 'bot-2' }))
    await cache.get(request({ repoKey: 'acme/other' }))
    await cache.get(request({ closedWindowDays: 0 }))
    expect(calls.map((call) => call.userId)).toEqual(['bot-1', 'bot-2', 'bot-1', 'bot-1'])
    expect(calls.map((call) => call.days)).toEqual([14, 14, 14, 0])
  })

  it('shares one fetch between overlapping gets', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let count = 0
    const { cache, request } = setUp(async () => {
      count++
      await gate
      return read([1])
    })
    const both = Promise.all([cache.get(request()), cache.get(request())])
    release()
    const [a, b] = await both
    expect(count).toBe(1)
    expect(a).toBe(b)
  })

  it('refresh starts a new fetch, then behaves as get for 15 seconds', async () => {
    const { cache, clock, calls, request } = setUp()
    await cache.get(request())
    expect(calls).toHaveLength(1)
    clock.ms += 1000
    await cache.refresh(request())
    expect(calls).toHaveLength(1)
    clock.ms = clock.ms - 1000 + MCP_LIMITS.refetchThrottleMs
    await cache.refresh(request())
    expect(calls).toHaveLength(2)
    await cache.refresh(request())
    expect(calls).toHaveLength(2)
  })

  it('refetches once for a number above highestNumber, then the throttle holds', async () => {
    let round = 0
    const { cache, clock, calls, request } = setUp(async () => (round++ === 0 ? read([1, 2]) : read([1, 2, 3])))
    const first = await cache.get(request())
    expect(first.seen.has(3)).toBe(false)
    expect(3 > first.highestNumber).toBe(true)
    clock.ms += 20_000
    const second = await cache.refresh(request())
    expect(second.seen.has(3)).toBe(true)
    clock.ms += 5000
    await cache.refresh(request())
    expect(calls).toHaveLength(2)
  })

  it('counts a cold fetch as a start for the throttle', async () => {
    const { cache, clock, calls, request } = setUp()
    await cache.get(request())
    clock.ms += MCP_LIMITS.refetchThrottleMs - 1
    await cache.refresh(request())
    expect(calls).toHaveLength(1)
  })

  it('does not fill the cache with a fetch that finishes after invalidate', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let count = 0
    const { cache, request } = setUp(async () => {
      count++
      if (count === 1) await gate
      return read([count])
    })
    const stale = cache.get(request())
    cache.invalidate('bot-1')
    release()
    expect([...(await stale).seen]).toEqual([1])
    const fresh = await cache.get(request())
    expect(count).toBe(2)
    expect([...fresh.seen]).toEqual([2])
  })

  it('does not let a get after invalidate join a fetch of the older generation', async () => {
    const gates: Array<() => void> = []
    let count = 0
    const { cache, request } = setUp(async () => {
      const n = ++count
      await new Promise<void>((resolve) => gates.push(resolve))
      return read([n])
    })
    const old = cache.get(request())
    cache.invalidate('bot-1')
    const next = cache.get(request())
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates.forEach((open) => open())
    expect([...(await old).seen]).toEqual([1])
    expect([...(await next).seen]).toEqual([2])
    expect(count).toBe(2)
  })

  it('drops the account entries on invalidate and leaves other accounts alone', async () => {
    const { cache, calls, request } = setUp()
    await cache.get(request())
    await cache.get(request({ userId: 'bot-2' }))
    cache.invalidate('bot-1')
    await cache.get(request())
    await cache.get(request({ userId: 'bot-2' }))
    expect(calls.map((call) => call.userId)).toEqual(['bot-1', 'bot-2', 'bot-1'])
  })

  it('invalidates the account when a fetch fails with github-token-rejected', async () => {
    let count = 0
    const { cache, calls, request } = setUp(async () => {
      count++
      if (count === 2) throw new ToolFailure('github-token-rejected')
      return read([count])
    })
    await cache.get(request({ closedWindowDays: 7 }))
    await expect(cache.get(request())).rejects.toMatchObject({ code: 'github-token-rejected' })
    await cache.get(request({ closedWindowDays: 7 }))
    expect(calls).toHaveLength(3)
  })

  it('keeps at most 20 entries and evicts the least recently used', async () => {
    const { cache, calls, request } = setUp()
    for (let n = 0; n < 20; n++) await cache.get(request({ repoKey: `acme/r${n}` }))
    await cache.get(request({ repoKey: 'acme/r0' }))
    await cache.get(request({ repoKey: 'acme/r20' }))
    expect(calls).toHaveLength(21)
    await cache.get(request({ repoKey: 'acme/r0' }))
    expect(calls).toHaveLength(21)
    await cache.get(request({ repoKey: 'acme/r1' }))
    expect(calls).toHaveLength(22)
  })

  it('raises no unhandled rejection for a rejected shared fetch nobody waits on', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      const { cache, request } = setUp(async () => {
        throw new ToolFailure('github-unavailable')
      })
      const controller = new AbortController()
      const waiting = cache.get(request({ signal: controller.signal }))
      controller.abort()
      await expect(waiting).rejects.toMatchObject({ code: 'call-stopped' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('rejects with call-stopped for a signal that is already aborted', async () => {
    const { cache, calls, request } = setUp()
    const controller = new AbortController()
    controller.abort()
    await expect(cache.get(request({ signal: controller.signal }))).rejects.toMatchObject({ code: 'call-stopped' })
    expect(calls).toHaveLength(0)
  })

  it("one waiter's abort does not stop the shared fetch", async () => {
    let fetchSignal: AbortSignal | undefined
    let resolveFetch!: (value: ReaderSnapshot) => void
    let count = 0
    const { cache, request } = setUp(
      (_userId, _repo, _days, signal) =>
        new Promise<ReaderSnapshot>((resolve) => {
          count++
          fetchSignal = signal
          resolveFetch = resolve
        }),
    )
    const first = new AbortController()
    const firstGet = cache.get(request({ signal: first.signal }))
    const secondGet = cache.get(request())
    first.abort()
    await expect(firstGet).rejects.toMatchObject({ name: 'ToolFailure', code: 'call-stopped' })
    expect(fetchSignal).toBeDefined()
    expect(fetchSignal?.aborted).toBe(false)
    resolveFetch(read([1, 2]))
    expect([...(await secondGet).seen]).toEqual([1, 2])
    await cache.get(request())
    expect(count).toBe(1)
  })
})
