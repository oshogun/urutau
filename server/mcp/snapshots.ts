/** Per-account snapshot cache with generations and the refetch throttle. */
import {
  MCP_LIMITS,
  ToolFailure,
  type BoardSnapshot,
  type FetchSnapshotFn,
  type ReaderSnapshot,
  type SnapshotProvider,
  type SnapshotRequest,
} from './contract.ts'

export interface SnapshotCacheDeps {
  fetchSnapshot: FetchSnapshotFn
  now: () => Date
}

interface Entry {
  userId: string
  value: BoardSnapshot
  generation: number
  storedAt: number
}

interface Running {
  promise: Promise<BoardSnapshot>
  generation: number
}

function toBoardSnapshot(read: ReaderSnapshot): BoardSnapshot {
  const { snapshot } = read
  return {
    issues: snapshot.issues,
    seen: new Set(snapshot.issues.map((issue) => issue.number)),
    highestNumber: read.highestNumber,
    pullRequests: new Set(read.pullRequests),
    truncated: read.openTruncated || read.closedTruncated,
    isPrivate: snapshot.repository.isPrivate,
    fetchedAt: snapshot.fetchedAt,
  }
}

/** Waits for the shared fetch together with the caller's own signal; the caller's abort leaves the fetch running. */
async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ToolFailure('call-stopped')
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ToolFailure('call-stopped'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function createSnapshotCache(deps: SnapshotCacheDeps): SnapshotProvider {
  const entries = new Map<string, Entry>()
  const running = new Map<string, Running>()
  const lastStart = new Map<string, number>()
  const generations = new Map<string, number>()
  const nowMs = () => deps.now().getTime()
  const generationOf = (userId: string) => generations.get(userId) ?? 0
  const keyOf = (request: SnapshotRequest) => JSON.stringify([request.userId, request.repoKey, request.closedWindowDays])

  const invalidate = (userId: string): void => {
    generations.set(userId, generationOf(userId) + 1)
    for (const [key, entry] of entries) if (entry.userId === userId) entries.delete(key)
  }

  const store = (key: string, entry: Entry): void => {
    entries.delete(key)
    entries.set(key, entry)
    while (entries.size > MCP_LIMITS.snapshotCacheEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  const start = (key: string, request: SnapshotRequest): Running => {
    const generation = generationOf(request.userId)
    const startedAt = nowMs()
    lastStart.set(key, startedAt)
    for (const [other, time] of lastStart) {
      if (startedAt - time >= MCP_LIMITS.refetchThrottleMs) lastStart.delete(other)
    }
    // The fetch gets its own signal: a caller that stops waiting must not cancel it for the callers sharing it.
    const own = new AbortController()
    const entry = { promise: undefined as unknown as Promise<BoardSnapshot>, generation }
    const promise = Promise.resolve().then(async (): Promise<BoardSnapshot> => {
      try {
        const value = toBoardSnapshot(await deps.fetchSnapshot(request.userId, request.repo, request.closedWindowDays, own.signal))
        if (generationOf(request.userId) === generation) {
          store(key, { userId: request.userId, value, generation, storedAt: nowMs() })
        }
        return value
      } catch (error) {
        if (error instanceof ToolFailure && error.code === 'github-token-rejected') invalidate(request.userId)
        throw error
      } finally {
        // The body starts in a later microtask, so the entry is already registered here even if fetchSnapshot throws at once.
        if (running.get(key) === entry) running.delete(key)
      }
    })
    // A failure nobody is waiting on any more is not an unhandled rejection.
    promise.catch(() => undefined)
    entry.promise = promise
    running.set(key, entry)
    return entry
  }

  const get = (request: SnapshotRequest): Promise<BoardSnapshot> => {
    if (request.signal.aborted) return Promise.reject(new ToolFailure('call-stopped'))
    const key = keyOf(request)
    const generation = generationOf(request.userId)
    const cached = entries.get(key)
    if (cached && cached.generation === generation && nowMs() - cached.storedAt < MCP_LIMITS.snapshotTtlMs) {
      entries.delete(key)
      entries.set(key, cached)
      return waitFor(Promise.resolve(cached.value), request.signal)
    }
    const shared = running.get(key)
    const fetching = shared && shared.generation === generation ? shared : start(key, request)
    return waitFor(fetching.promise, request.signal)
  }

  const refresh = (request: SnapshotRequest): Promise<BoardSnapshot> => {
    if (request.signal.aborted) return Promise.reject(new ToolFailure('call-stopped'))
    const key = keyOf(request)
    const startedAt = lastStart.get(key)
    if (startedAt !== undefined && nowMs() - startedAt < MCP_LIMITS.refetchThrottleMs) return get(request)
    return waitFor(start(key, request).promise, request.signal)
  }

  return { get, refresh, invalidate }
}
