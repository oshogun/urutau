import { describe, expect, it } from 'vitest'
import { createSecretBox, keyIdOf } from './secretBox.ts'

const key = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 8)
const token = 'github_pat_urutau_fixture_not_a_real_token'

describe('secret box', () => {
  const { sealer, opener } = createSecretBox(key)

  it('derives the documented key id', () => {
    expect(keyIdOf(key)).toBe('e8ccbd77')
    expect(sealer.keyId).toBe('e8ccbd77')
    expect(opener.keyId).toBe('e8ccbd77')
  })

  it('round-trips and uses the documented format', () => {
    const sealed = sealer.seal(token, 'user-1')
    const parts = sealed.split('.')
    expect(parts).toHaveLength(5)
    expect(parts[0]).toBe('v1')
    expect(parts[1]).toBe('e8ccbd77')
    expect(parts[2]).toHaveLength(16)
    expect(parts[4]).toHaveLength(22)
    expect(sealed).not.toContain(token)
    expect(opener.open(sealed, 'user-1')).toBe(token)
  })

  it('round-trips non-ASCII text and uses a new iv each time', () => {
    const a = sealer.seal('çã✓', 'user-1')
    expect(opener.open(a, 'user-1')).toBe('çã✓')
    expect(sealer.seal('çã✓', 'user-1')).not.toBe(a)
  })

  it('does not open for another account id', () => {
    expect(opener.open(sealer.seal(token, 'user-1'), 'user-2')).toBeNull()
  })

  it('does not open a value sealed with another key (kid mismatch)', () => {
    const other = createSecretBox(otherKey)
    const sealed = other.sealer.seal(token, 'user-1')
    expect(other.sealer.keyId).not.toBe(sealer.keyId)
    expect(opener.open(sealed, 'user-1')).toBeNull()
  })

  it('does not open when only the kid is rewritten to match', () => {
    const other = createSecretBox(otherKey)
    const parts = other.sealer.seal(token, 'user-1').split('.')
    parts[1] = sealer.keyId
    expect(opener.open(parts.join('.'), 'user-1')).toBeNull()
  })

  it('reads a tag cut to 4 bytes as unreadable', () => {
    const parts = sealer.seal(token, 'user-1').split('.')
    parts[4] = Buffer.from(parts[4], 'base64url').subarray(0, 4).toString('base64url')
    expect(opener.open(parts.join('.'), 'user-1')).toBeNull()
  })

  it('does not open changed ciphertext, iv or tag', () => {
    const parts = sealer.seal(token, 'user-1').split('.')
    const flip = (index: number) => {
      const bytes = Buffer.from(parts[index], 'base64url')
      bytes[0] ^= 1
      const copy = [...parts]
      copy[index] = bytes.toString('base64url')
      return copy.join('.')
    }
    for (const index of [2, 3, 4]) expect(opener.open(flip(index), 'user-1')).toBeNull()
  })

  it('returns null, without throwing, for malformed values', () => {
    const good = sealer.seal(token, 'user-1')
    const parts = good.split('.')
    const malformed = [
      '',
      'v1',
      'not a sealed value',
      good + '.extra',
      ['v2', ...parts.slice(1)].join('.'),
      [parts[0], parts[1], 'AAAA', parts[3], parts[4]].join('.'),
      [parts[0], parts[1], parts[2], parts[3], ''].join('.'),
      [parts[0], parts[1], '!!!', parts[3], parts[4]].join('.'),
    ]
    for (const value of malformed) expect(() => opener.open(value, 'user-1')).not.toThrow()
    for (const value of malformed) expect(opener.open(value, 'user-1')).toBeNull()
    expect(opener.open(undefined as unknown as string, 'user-1')).toBeNull()
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() => createSecretBox(Buffer.alloc(31))).toThrow()
  })
})
