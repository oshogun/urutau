/**
 * AES-256-GCM sealing of stored GitHub tokens.
 *
 * Format v2 (written): the AES key and the key id come from TOKEN_ENCRYPTION_KEY through HKDF-SHA256,
 * each with its own info label, so the raw key is never used directly.
 * Format v1 (read only): the raw key was the AES key and the HMAC key for the key id. Stored v1 values
 * still open; the next admin write of the token stores it as v2.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'

export interface SecretSealer {
  /** The v2 key id, stored next to each value: first 8 hex characters of an HKDF-SHA256 output. */
  readonly keyId: string
  /** True for this key's v2 id and for its v1 id, so rows stored by older versions count as readable. */
  recognizesKeyId(id: string): boolean
  /** v2.<kid>.<iv>.<ct>.<tag>, bound to the account id. */
  seal(plain: string, userId: string): string
}

export interface SecretOpener {
  readonly keyId: string
  recognizesKeyId(id: string): boolean
  /** The plain value (v1 or v2), or null when the value cannot be opened with this key for this account. Never throws. */
  open(sealed: string, userId: string): string | null
}

const IV_BYTES = 12
const TAG_BYTES = 16

// Stored format: changing any of these makes existing v2 values unreadable.
const HKDF_SALT = 'urutau'
const KEY_ID_INFO = 'urutau:key-id:v2'
const AES_KEY_INFO = 'urutau:github-token:aes-256-gcm:v2'

/** The v2 key id. */
export function keyIdOf(key: Buffer): string {
  return Buffer.from(hkdfSync('sha256', key, HKDF_SALT, KEY_ID_INFO, 4)).toString('hex')
}

/** The v1 key id: first 8 hex characters of HMAC-SHA256(key, 'urutau key id'). */
export function legacyKeyIdOf(key: Buffer): string {
  return createHmac('sha256', key).update('urutau key id').digest('hex').slice(0, 8)
}

function aadV1(userId: string): Buffer {
  return Buffer.from(`urutau:github-token:v1:${userId}`, 'utf8')
}

function aadV2(userId: string): Buffer {
  return Buffer.from(`urutau:github-token:v2:${userId}`, 'utf8')
}

/** Builds both from a 32-byte key; createApp calls it once and gives the opener only to the GitHub reader. */
export function createSecretBox(key: Buffer): { sealer: SecretSealer; opener: SecretOpener } {
  if (key.length !== 32) throw new Error('The secret box key must be 32 bytes')
  const keyId = keyIdOf(key)
  const legacyKeyId = legacyKeyIdOf(key)
  const aesKey = Buffer.from(hkdfSync('sha256', key, HKDF_SALT, AES_KEY_INFO, 32))
  const recognizesKeyId = (id: string) => id === keyId || id === legacyKeyId
  const sealer: SecretSealer = {
    keyId,
    recognizesKeyId,
    seal(plain, userId) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', aesKey, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(aadV2(userId))
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return ['v2', keyId, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.')
    },
  }
  const opener: SecretOpener = {
    keyId,
    recognizesKeyId,
    open(sealed, userId) {
      try {
        const parts = typeof sealed === 'string' ? sealed.split('.') : []
        if (parts.length !== 5) return null
        const [version, kid, ivText, ctText, tagText] = parts
        let cipherKey: Buffer
        let aad: Buffer
        if (version === 'v2' && kid === keyId) {
          cipherKey = aesKey
          aad = aadV2(userId)
        } else if (version === 'v1' && kid === legacyKeyId) {
          cipherKey = key
          aad = aadV1(userId)
        } else {
          return null
        }
        const iv = Buffer.from(ivText, 'base64url')
        const tag = Buffer.from(tagText, 'base64url')
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null
        const decipher = createDecipheriv('aes-256-gcm', cipherKey, iv, { authTagLength: TAG_BYTES })
        decipher.setAAD(aad)
        decipher.setAuthTag(tag)
        const plain = Buffer.concat([decipher.update(Buffer.from(ctText, 'base64url')), decipher.final()])
        return plain.toString('utf8')
      } catch {
        return null
      }
    },
  }
  return { sealer, opener }
}
