import { describe, expect, it } from 'vitest'
import { MCP_LIMITS, ToolFailure } from './contract.ts'
import { createCallLimiter, createRepoLocks } from './locks.ts'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('repo locks', () => {
  it('runs five concurrent tasks on one key one at a time, in arrival order', async () => {
    const locks = createRepoLocks()
    const signal = new AbortController().signal
    const events: string[] = []
    let running = 0
    let peak = 0
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((n) =>
        locks.run('acme/widgets', signal, async () => {
          running++
          peak = Math.max(peak, running)
          events.push(`start ${n}`)
          await new Promise((resolve) => setTimeout(resolve, 5 - n))
          events.push(`end ${n}`)
          running--
          return n
        }),
      ),
    )
    expect(results).toEqual([0, 1, 2, 3, 4])
    expect(peak).toBe(1)
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3', 'start 4', 'end 4'])
  })

  it('does not make different keys wait for each other', async () => {
    const locks = createRepoLocks()
    const signal = new AbortController().signal
    let release!: () => void
    const held = locks.run('a/a', signal, () => new Promise<void>((resolve) => (release = resolve)))
    await tick()
    await expect(locks.run('b/b', signal, async () => 'ok')).resolves.toBe('ok')
    release()
    await held
  })

  it('lets the next task run after one fails', async () => {
    const locks = createRepoLocks()
    const signal = new AbortController().signal
    const failing = locks.run('a/a', signal, async () => {
      throw new Error('boom')
    })
    const next = locks.run('a/a', signal, async () => 'after')
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('after')
  })

  it('never starts a waiting task whose signal aborts, and keeps the queue moving', async () => {
    const locks = createRepoLocks()
    const live = new AbortController().signal
    const stop = new AbortController()
    let release!: () => void
    const first = locks.run('a/a', live, () => new Promise<void>((resolve) => (release = resolve)))
    let started = false
    const waiting = locks.run('a/a', stop.signal, async () => {
      started = true
    })
    const third = locks.run('a/a', live, async () => 'third')
    await tick()
    stop.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'ToolFailure', code: 'call-stopped' })
    release()
    await first
    await expect(third).resolves.toBe('third')
    expect(started).toBe(false)
  })

  it('rejects at once when the signal is already aborted', async () => {
    const locks = createRepoLocks()
    const stop = new AbortController()
    stop.abort()
    await expect(locks.run('a/a', stop.signal, async () => 1)).rejects.toBeInstanceOf(ToolFailure)
  })
})

describe('call limiter', () => {
  it('allows the per-minute calls and then says how long to wait', () => {
    let at = 1_000_000
    const limiter = createCallLimiter(() => new Date(at))
    for (let i = 0; i < MCP_LIMITS.callsPerMinute; i++) {
      expect(limiter.take('u1', 'call')).toBeNull()
      at += 10
    }
    const wait = limiter.take('u1', 'call')
    expect(wait).toBe(Math.ceil((1_000_000 + 60_000 - at) / 1000))
    expect(limiter.take('u2', 'call')).toBeNull()
    at = 1_000_000 + 60_001
    expect(limiter.take('u1', 'call')).toBeNull()
  })

  it('counts moves separately and never answers less than one second', () => {
    let at = 5_000_000
    const limiter = createCallLimiter(() => new Date(at))
    for (let i = 0; i < MCP_LIMITS.movesPerMinute; i++) expect(limiter.take('u1', 'move')).toBeNull()
    at += 59_900
    expect(limiter.take('u1', 'move')).toBe(1)
    expect(limiter.take('u1', 'call')).toBeNull()
  })

  it('forgets an account', () => {
    const limiter = createCallLimiter(() => new Date(0))
    for (let i = 0; i < MCP_LIMITS.movesPerMinute; i++) limiter.take('u1', 'move')
    expect(limiter.take('u1', 'move')).not.toBeNull()
    limiter.forget('u1')
    expect(limiter.take('u1', 'move')).toBeNull()
  })
})
