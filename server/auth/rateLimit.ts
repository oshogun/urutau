const WINDOW_MS = 15 * 60 * 1000
const KEY_LIMIT = 5
const IP_LIMIT = 50
const SWEEP_EVERY_MS = 60 * 1000

/**
 * In-memory failure counters for the public POST routes. A key is
 * `ip|username`; each IP also has its own counter across all keys. State is
 * lost on restart.
 */
export class RateLimiter {
  private readonly now: () => Date
  private readonly byKey = new Map<string, number[]>()
  private readonly byIp = new Map<string, number[]>()
  private lastSweep = 0

  constructor(now: () => Date) {
    this.now = now
  }

  /** Seconds until another attempt is allowed, or null when it is allowed now. Run before any password work. */
  retryAfter(ip: string, key?: string): number | null {
    const at = this.now().getTime()
    this.sweep(at)
    const waits = [this.wait(this.byIp, ip, IP_LIMIT, at)]
    if (key !== undefined) waits.push(this.wait(this.byKey, key, KEY_LIMIT, at))
    const longest = Math.max(...waits.filter((wait): wait is number => wait !== null), -1)
    return longest < 0 ? null : Math.max(1, Math.ceil(longest / 1000))
  }

  recordFailure(ip: string, key?: string): void {
    const at = this.now().getTime()
    this.push(this.byIp, ip, at)
    if (key !== undefined) this.push(this.byKey, key, at)
  }

  /** A successful sign-in clears its key's failures; the IP's counter keeps running. */
  recordSuccess(key: string): void {
    this.byKey.delete(key)
  }

  private push(map: Map<string, number[]>, id: string, at: number): void {
    const failures = (map.get(id) ?? []).filter((time) => at - time < WINDOW_MS)
    failures.push(at)
    map.set(id, failures)
  }

  /** Milliseconds until the failure that keeps the id over its limit leaves the window; null when the id is under it. */
  private wait(map: Map<string, number[]>, id: string, limit: number, at: number): number | null {
    const failures = (map.get(id) ?? []).filter((time) => at - time < WINDOW_MS)
    if (failures.length === 0) map.delete(id)
    else map.set(id, failures)
    if (failures.length < limit) return null
    return failures[failures.length - limit] + WINDOW_MS - at
  }

  private sweep(at: number): void {
    if (at - this.lastSweep < SWEEP_EVERY_MS) return
    this.lastSweep = at
    for (const map of [this.byKey, this.byIp]) {
      for (const [id, failures] of map) {
        if (failures.every((time) => at - time >= WINDOW_MS)) map.delete(id)
      }
    }
  }
}
