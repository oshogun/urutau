import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes as base64url (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hex SHA-256: what the database stores in place of a session id or invite token. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
