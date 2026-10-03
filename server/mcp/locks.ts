/** In-process limits for the MCP tools: the per-repository save lock and the per-integration call caps. */
import { MCP_LIMITS, ToolFailure, type CallLimiter, type RepoLocks } from './contract.ts'

const WINDOW_MS = 60_000

/** Serialises tasks per repository key, in arrival order; a waiting task whose signal aborts never starts and rejects with ToolFailure('call-stopped'). */
export function createRepoLocks(): RepoLocks {
  const tails = new Map<string, Promise<void>>()

  return {
    async run<T>(repoKey: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
      if (signal.aborted) throw new ToolFailure('call-stopped')

      const previous = tails.get(repoKey) ?? Promise.resolve()
      let finish!: () => void
      const gate = new Promise<void>((resolve) => {
        finish = resolve
      })
      // Later tasks wait for every earlier one even when this one gives up early.
      const tail = previous.then(() => gate)
      tails.set(repoKey, tail)
      const release = () => {
        finish()
        void tail.then(() => {
          if (tails.get(repoKey) === tail) tails.delete(repoKey)
        })
      }

      let onAbort!: () => void
      const aborted = new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted')
        signal.addEventListener('abort', onAbort, { once: true })
      })
      const turn = await Promise.race([previous.then(() => 'turn' as const), aborted])
      signal.removeEventListener('abort', onAbort)
      if (turn === 'aborted' || signal.aborted) {
        release()
        throw new ToolFailure('call-stopped')
      }

      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}

/** Sliding 60-second windows per integration: MCP_LIMITS.callsPerMinute 'call' units and MCP_LIMITS.movesPerMinute 'move' units. */
export function createCallLimiter(now: () => Date): CallLimiter {
  const limits = { call: MCP_LIMITS.callsPerMinute, move: MCP_LIMITS.movesPerMinute }
  const windows = new Map<string, number[]>()

  return {
    take(userId, kind) {
      const key = `${kind}:${userId}`
      const at = now().getTime()
      const stamps = (windows.get(key) ?? []).filter((stamp) => stamp > at - WINDOW_MS)
      if (stamps.length >= limits[kind]) {
        windows.set(key, stamps)
        return Math.max(1, Math.ceil((stamps[0] + WINDOW_MS - at) / 1000))
      }
      stamps.push(at)
      windows.set(key, stamps)
      return null
    },
    forget(userId) {
      windows.delete(`call:${userId}`)
      windows.delete(`move:${userId}`)
    },
  }
}
