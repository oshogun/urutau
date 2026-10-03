/** Cleaning and capping of untrusted display text, and bucket-id aliases. */
import { createHash } from 'node:crypto'

const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g
const REMOVED =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu
const WHITE_SPACE_RUN = /\p{White_Space}+/gu
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/
const ALIAS = /^~[0-9a-f]{16}$/

/**
 * The text with control, format, private-use, unassigned, surrogate, line and
 * paragraph separator code points and default-ignorable code points removed,
 * white space runs folded to one space, trimmed, and cut to `max` code points
 * (the last one replaced by U+2026 when cut). A non-string gives ''.
 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(LINE_BREAKS, ' ')
    .replace(REMOVED, '')
    .replace(WHITE_SPACE_RUN, ' ')
    .trim()
  const points = Array.from(text)
  if (points.length <= max) return text
  return points.slice(0, Math.max(0, max - 1)).join('') + '\u2026'
}

/** True for an id matching ^[A-Za-z0-9_-]{1,64}$. */
export function isPlainBucketId(id: string): boolean {
  return PLAIN_ID.test(id)
}

/** '~' and the first 16 hex digits of SHA-256 of the id's UTF-8 bytes. */
export function bucketAlias(id: string): string {
  return '~' + createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)
}

export interface BucketIds {
  /** The id to print for a stored bucket id: itself when plain, else its alias. */
  toOutput(storedId: string): string
  /** The stored id a client's id names, or null when it names no bucket of the board. */
  fromInput(id: string): string | null
}

/** The id mapping for one board's buckets, in board order. */
export function bucketIds(buckets: readonly { id: string }[]): BucketIds {
  const stored = new Set(buckets.map((bucket) => bucket.id))
  const byAlias = new Map<string, string>()
  for (const { id } of buckets) {
    if (isPlainBucketId(id)) continue
    const alias = bucketAlias(id)
    if (!byAlias.has(alias)) byAlias.set(alias, id)
  }
  return {
    toOutput: (storedId) => (isPlainBucketId(storedId) ? storedId : bucketAlias(storedId)),
    fromInput: (id) => {
      if (isPlainBucketId(id)) return stored.has(id) ? id : null
      if (ALIAS.test(id)) return byAlias.get(id) ?? null
      return null
    },
  }
}
