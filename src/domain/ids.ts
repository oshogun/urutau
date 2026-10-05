/**
 * `byteCount` random bytes as lowercase hex (two characters per byte). Uses
 * crypto.getRandomValues, which browsers also provide on pages served over
 * plain HTTP; crypto.randomUUID exists only in secure contexts.
 */
export function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
