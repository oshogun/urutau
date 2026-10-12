import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSecretBox, keyIdOf, legacyKeyIdOf } from './secretBox.ts'

const key = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 8)
const token = 'github_pat_urutau_fixture_not_a_real_token'
const V2_KEY_ID = '4a66719d'
const V1_KEY_ID = 'e8ccbd77'

/** The v1 format as shipped: raw key, v1 AAD, HMAC key id. */
function sealV1(rawKey: Buffer, plain: string, userId: string, kid = legacyKeyIdOf(rawKey)): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', rawKey, iv, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(`urutau:github-token:v1:${userId}`, 'utf8'))
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', kid, iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

function flip(sealed: string, index: number): string {
  const parts = sealed.split('.')
  const bytes = Buffer.from(parts[index], 'base64url')
  bytes[0] ^= 1
  parts[index] = bytes.toString('base64url')
  return parts.join('.')
}

describe('secret box', () => {
  const { sealer, opener } = createSecretBox(key)

  it('derives the documented key ids', () => {
    expect(legacyKeyIdOf(key)).toBe(V1_KEY_ID)
    expect(keyIdOf(key)).toBe(V2_KEY_ID)
    expect(keyIdOf(key)).not.toBe(legacyKeyIdOf(key))
    expect(sealer.keyId).toBe(V2_KEY_ID)
    expect(opener.keyId).toBe(V2_KEY_ID)
  })

  it('round-trips and uses the documented format', () => {
    const sealed = sealer.seal(token, 'user-1')
    const parts = sealed.split('.')
    expect(parts).toHaveLength(5)
    expect(parts[0]).toBe('v2')
    expect(parts[1]).toBe(V2_KEY_ID)
    expect(parts[2]).toHaveLength(16)
    expect(parts[4]).toHaveLength(22)
    expect(sealed).not.toContain(token)
    expect(opener.open(sealed, 'user-1')).toBe(token)
  })

  it('does not use the raw key as the AES key for v2', () => {
    const [, , ivText, ctText, tagText] = sealer.seal(token, 'user-1').split('.')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'), { authTagLength: 16 })
    decipher.setAAD(Buffer.from('urutau:github-token:v2:user-1', 'utf8'))
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
    expect(() => Buffer.concat([decipher.update(Buffer.from(ctText, 'base64url')), decipher.final()])).toThrow()
    expect(Buffer.from(hkdfSync('sha256', key, 'urutau', 'urutau:github-token:aes-256-gcm:v2', 32)).equals(key)).toBe(false)
  })

  it('recognizes its own v2 and v1 key ids and nothing else', () => {
    for (const box of [sealer, opener]) {
      expect(box.recognizesKeyId(V2_KEY_ID)).toBe(true)
      expect(box.recognizesKeyId(V1_KEY_ID)).toBe(true)
      expect(box.recognizesKeyId('deadbeef')).toBe(false)
      expect(box.recognizesKeyId(keyIdOf(otherKey))).toBe(false)
      expect(box.recognizesKeyId(legacyKeyIdOf(otherKey))).toBe(false)
    }
  })

  it('opens a v1 value stored by an older version', () => {
    expect(opener.open(sealV1(key, token, 'user-1'), 'user-1')).toBe(token)
  })

  it('does not open a v1 value for another account, after tampering, with the v2 kid or from another key', () => {
    const sealed = sealV1(key, token, 'user-1')
    expect(opener.open(sealed, 'user-2')).toBeNull()
    for (const index of [2, 3, 4]) expect(opener.open(flip(sealed, index), 'user-1')).toBeNull()
    expect(opener.open(sealV1(key, token, 'user-1', V2_KEY_ID), 'user-1')).toBeNull()
    expect(opener.open(sealV1(otherKey, token, 'user-1'), 'user-1')).toBeNull()
    expect(opener.open(sealV1(otherKey, token, 'user-1', V1_KEY_ID), 'user-1')).toBeNull()
  })

  it('does not open a value whose version is relabelled', () => {
    const v2 = sealer.seal(token, 'user-1').split('.')
    expect(opener.open(['v1', ...v2.slice(1)].join('.'), 'user-1')).toBeNull()
    expect(opener.open(['v1', V1_KEY_ID, ...v2.slice(2)].join('.'), 'user-1')).toBeNull()
    const v1 = sealV1(key, token, 'user-1').split('.')
    expect(opener.open(['v2', ...v1.slice(1)].join('.'), 'user-1')).toBeNull()
    expect(opener.open(['v2', V2_KEY_ID, ...v1.slice(2)].join('.'), 'user-1')).toBeNull()
  })

  it('refuses a value whose key id names another key, even when the rest is intact', () => {
    const parts = sealer.seal(token, 'user-1').split('.')
    parts[1] = keyIdOf(otherKey)
    expect(opener.open(parts.join('.'), 'user-1')).toBeNull()
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
    const sealed = sealer.seal(token, 'user-1')
    for (const index of [2, 3, 4]) expect(opener.open(flip(sealed, index), 'user-1')).toBeNull()
  })

  it('returns null, without throwing, for malformed values', () => {
    const good = sealer.seal(token, 'user-1')
    const parts = good.split('.')
    const malformed = [
      '',
      'v2',
      'not a sealed value',
      good + '.extra',
      ['v3', ...parts.slice(1)].join('.'),
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
