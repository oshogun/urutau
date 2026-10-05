import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomHex } from './ids.ts'

afterEach(() => vi.unstubAllGlobals())

describe('randomHex', () => {
  it('returns two lowercase hex characters per byte', () => {
    expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/)
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('differs between calls', () => {
    expect(randomHex(16)).not.toBe(randomHex(16))
  })

  it('works when crypto.randomUUID is unavailable, as on plain HTTP pages', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/)
  })
})
