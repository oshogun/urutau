import { describe, expect, it } from 'vitest'
import type { McpPrincipal } from './contract.ts'
import { createInflightRegistry } from './inflight.ts'

const principal = (userId: string, tokenId: string): McpPrincipal => ({ userId, username: userId, tokenId })

describe('inflight registry', () => {
  it('aborts every registered call of a revoked token only', () => {
    const registry = createInflightRegistry()
    const a = registry.begin(principal('u1', 't1'))
    const b = registry.begin(principal('u1', 't1'))
    const c = registry.begin(principal('u1', 't2'))
    expect(registry.size()).toBe(3)
    expect(registry.abortToken('t1')).toBe(2)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(c.signal.aborted).toBe(false)
  })

  it('aborts every call of a removed integration', () => {
    const registry = createInflightRegistry()
    const a = registry.begin(principal('u1', 't1'))
    const b = registry.begin(principal('u1', 't2'))
    const other = registry.begin(principal('u2', 't3'))
    expect(registry.abortIntegration('u1')).toBe(2)
    expect(a.signal.aborted && b.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
  })

  it('forgets ended calls', () => {
    const registry = createInflightRegistry()
    const call = registry.begin(principal('u1', 't1'))
    call.end()
    call.end()
    expect(registry.size()).toBe(0)
    expect(registry.abortToken('t1')).toBe(0)
    expect(call.signal.aborted).toBe(false)
  })

  it('follows the parent signal, including one already aborted', () => {
    const registry = createInflightRegistry()
    const parent = new AbortController()
    const call = registry.begin(principal('u1', 't1'), parent.signal)
    expect(call.signal.aborted).toBe(false)
    parent.abort()
    expect(call.signal.aborted).toBe(true)

    const done = new AbortController()
    done.abort()
    expect(registry.begin(principal('u1', 't1'), done.signal).signal.aborted).toBe(true)
  })
})
