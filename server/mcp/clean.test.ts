import { describe, expect, it } from 'vitest'
import { bucketAlias, bucketIds, cleanText, isPlainBucketId } from './clean.ts'

describe('cleanText', () => {
  it('removes invisible and directional code points', () => {
    const hostile = [
      '\u061C',
      '\uFE0F',
      '\u{E0100}',
      '\u180E',
      '\u3164',
      '\u202E',
      '\u2066',
      '\u200B',
      '\u200D',
      '\uFEFF',
      '\u00AD',
      '\u{E0041}',
      '\u{E000}',
      '\uD800',
      '\u0000',
      '\u007F',
      '\u009F',
      '\u0378',
    ]
    expect(cleanText(`A${hostile.join('B')}C`, 100)).toBe('A' + 'B'.repeat(hostile.length - 1) + 'C')
    expect(cleanText(hostile.join(''), 100)).toBe('')
  })

  it('folds line breaks and white space runs to one space and trims', () => {
    expect(cleanText('  a\r\nb\u2028c\u0085d \t\u00A0 e  ', 100)).toBe('a b c d e')
  })

  it('leaves ordinary text alone', () => {
    expect(cleanText('Café 日本語 São Paulo', 100)).toBe('Café 日本語 São Paulo')
  })

  it('turns a non-string into an empty string', () => {
    expect(cleanText(42, 10)).toBe('')
    expect(cleanText(null, 10)).toBe('')
  })

  it('caps by code points and marks the cut', () => {
    expect(cleanText('abcdefghijklmnop', 10)).toBe('abcdefghi\u2026')
    expect(cleanText('abcdefghij', 10)).toBe('abcdefghij')
    const astral = '\u{1F600}'.repeat(20)
    expect(Array.from(cleanText(astral, 5))).toEqual([...'\u{1F600}'.repeat(4), '\u2026'])
  })
})

describe('bucket ids', () => {
  const hostile = 'Todo\u202E \u{1F600}'
  const buckets = [{ id: 'backlog' }, { id: hostile }, { id: 'bucket-ab12CD34' }, { id: 'x'.repeat(65) }]
  const ids = bucketIds(buckets)

  it('prints organic ids unchanged', () => {
    expect(ids.toOutput('backlog')).toBe('backlog')
    expect(ids.toOutput('bucket-ab12CD34')).toBe('bucket-ab12CD34')
    expect(isPlainBucketId('a_b-C9')).toBe(true)
  })

  it('prints other ids as a stable alias that round-trips', () => {
    const alias = ids.toOutput(hostile)
    expect(alias).toMatch(/^~[0-9a-f]{16}$/)
    expect(alias).toBe(bucketAlias(hostile))
    expect(bucketIds(buckets).toOutput(hostile)).toBe(alias)
    expect(ids.fromInput(alias)).toBe(hostile)
    expect(ids.fromInput(ids.toOutput('x'.repeat(65)))).toBe('x'.repeat(65))
  })

  it('maps plain input to the exact stored id only', () => {
    expect(ids.fromInput('backlog')).toBe('backlog')
    expect(ids.fromInput('missing')).toBeNull()
    expect(ids.fromInput('~0000000000000000')).toBeNull()
    expect(ids.fromInput(hostile)).toBeNull()
    expect(ids.fromInput('')).toBeNull()
  })

  it('does not let a plain id be reached through an alias', () => {
    expect(ids.fromInput(bucketAlias('backlog'))).toBeNull()
  })
})
