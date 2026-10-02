import { expect, test } from 'vitest'
import { RateLimiter } from './rateLimit.ts'

function limiter() {
  const clock = { now: new Date('2026-10-02T12:00:00Z') }
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms)
  }
  return { limits: new RateLimiter(() => clock.now), advance }
}

test('allows four failures for a key and blocks from the fifth', () => {
  const { limits } = limiter()
  for (let i = 0; i < 4; i += 1) limits.recordFailure('1.1.1.1', '1.1.1.1|ann')
  expect(limits.retryAfter('1.1.1.1', '1.1.1.1|ann')).toBeNull()
  limits.recordFailure('1.1.1.1', '1.1.1.1|ann')
  expect(limits.retryAfter('1.1.1.1', '1.1.1.1|ann')).toBe(900)
  expect(limits.retryAfter('1.1.1.1', '1.1.1.1|bob')).toBeNull()
})

test('reports the time until the oldest failure leaves the window', () => {
  const { limits, advance } = limiter()
  for (let i = 0; i < 5; i += 1) {
    limits.recordFailure('ip', 'ip|ann')
    advance(60_000)
  }
  expect(limits.retryAfter('ip', 'ip|ann')).toBe(600)
  advance(10 * 60_000)
  expect(limits.retryAfter('ip', 'ip|ann')).toBeNull()
})

test('a success clears the key but not the IP counter', () => {
  const { limits } = limiter()
  for (let i = 0; i < 4; i += 1) limits.recordFailure('ip', 'ip|ann')
  limits.recordSuccess('ip|ann')
  limits.recordFailure('ip', 'ip|ann')
  expect(limits.retryAfter('ip', 'ip|ann')).toBeNull()
  for (let i = 0; i < 45; i += 1) limits.recordFailure('ip')
  expect(limits.retryAfter('ip', 'ip|ann')).toBe(900)
})

test('the IP limit is 50 failures across all keys', () => {
  const { limits } = limiter()
  for (let i = 0; i < 49; i += 1) limits.recordFailure('ip', `ip|user${i}`)
  expect(limits.retryAfter('ip')).toBeNull()
  limits.recordFailure('ip', 'ip|last')
  expect(limits.retryAfter('ip')).toBe(900)
  expect(limits.retryAfter('other')).toBeNull()
})
