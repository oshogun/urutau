/** AES-256-GCM sealing of stored GitHub tokens. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export interface SecretSealer {
  /** First 8 hex characters of HMAC-SHA256(key, 'urutau key id'). */
  readonly keyId: string
  /** v1.<kid>.<iv>.<ct>.<tag>, bound to the account id. */
  seal(plain: string, userId: string): string
}

export interface SecretOpener {
  readonly keyId: string
  /** The plain value, or null when the value cannot be opened with this key for this account. Never throws. */
  open(sealed: string, userId: string): string | null
}

const IV_BYTES = 12
const TAG_BYTES = 16

export function keyIdOf(key: Buffer): string {
  return createHmac('sha256', key).update('urutau key id').digest('hex').slice(0, 8)
}

function aad(userId: string): Buffer {
  return Buffer.from(`urutau:github-token:v1:${userId}`, 'utf8')
}

/** Builds both from a 32-byte key; createApp calls it once and gives the opener only to the GitHub reader. */
export function createSecretBox(key: Buffer): { sealer: SecretSealer; opener: SecretOpener } {
  if (key.length !== 32) throw new Error('The secret box key must be 32 bytes')
  const keyId = keyIdOf(key)
  const sealer: SecretSealer = {
    keyId,
    seal(plain, userId) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(aad(userId))
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return ['v1', keyId, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.')
    },
  }
  const opener: SecretOpener = {
    keyId,
    open(sealed, userId) {
      try {
        const parts = typeof sealed === 'string' ? sealed.split('.') : []
        if (parts.length !== 5) return null
        const [version, kid, ivText, ctText, tagText] = parts
        if (version !== 'v1' || kid !== keyId) return null
        const iv = Buffer.from(ivText, 'base64url')
        const tag = Buffer.from(tagText, 'base64url')
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
        decipher.setAAD(aad(userId))
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
