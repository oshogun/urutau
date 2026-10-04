import { describe, expect, it } from 'vitest'
import { BODY_RENDER_LIMIT, RUN_TEXT_MAX, cutBody, splitTextRuns } from './bodyTree'

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff

// Repeats `unit` to `length` code units, dropping a last unit that would leave half a surrogate pair.
function fit(unit: string, length: number): string {
  const text = unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
  return isHigh(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text
}

describe('cutBody', () => {
  it('keeps a body of 131,071 and of 131,072 units whole', () => {
    for (const length of [BODY_RENDER_LIMIT - 1, BODY_RENDER_LIMIT]) {
      const body = 'a'.repeat(length)
      expect(cutBody(body)).toEqual({ text: body, cut: false })
    }
  })

  it('cuts a body of 131,073 units to 131,072', () => {
    const { text, cut } = cutBody('a'.repeat(BODY_RENDER_LIMIT + 1))
    expect(cut).toBe(true)
    expect(text.length).toBe(BODY_RENDER_LIMIT)
  })

  it('drops one more unit when the cut would leave a high surrogate last', () => {
    const body = 'a'.repeat(BODY_RENDER_LIMIT - 1) + '\u{1F600}' + 'b'
    const { text, cut } = cutBody(body)
    expect(cut).toBe(true)
    expect(text.length).toBe(BODY_RENDER_LIMIT - 1)
    expect(isHigh(text.charCodeAt(text.length - 1))).toBe(false)
  })

  it('keeps a whole pair that ends exactly at the limit', () => {
    const body = 'a'.repeat(BODY_RENDER_LIMIT - 2) + '\u{1F600}' + 'b'
    expect(cutBody(body).text.length).toBe(BODY_RENDER_LIMIT)
  })
})

describe('splitTextRuns', () => {
  const texts: Record<string, string> = {
    'bidi text with no spaces': fit('abאב', 131_072),
    'surrogate pairs only': fit('\u{1F600}', 131_071),
    'short lines': fit('a\n', 131_072),
    'only newlines': '\n'.repeat(5000),
    'a short line then a long one': 'x\n' + 'y'.repeat(5000),
    'lines of text': fit('line of text\n', 50_000),
    empty: '',
    short: 'short',
  }

  for (const [name, text] of Object.entries(texts)) {
    it(`splits ${name} into runs that join back to it`, () => {
      const parts = splitTextRuns(text, RUN_TEXT_MAX)
      expect(parts.every((part) => part.length <= RUN_TEXT_MAX)).toBe(true)
      expect(parts.join('')).toBe(text)
      expect(parts.slice(0, -1).every((part) => !isHigh(part.charCodeAt(part.length - 1)))).toBe(true)
      expect(parts.length).toBeLessThanOrEqual(2 * Math.ceil(text.length / RUN_TEXT_MAX) + 1)
    })
  }

  it("returns [''] for an empty text", () => {
    expect(splitTextRuns('', RUN_TEXT_MAX)).toEqual([''])
  })

  it('ends a window that holds a newline just after its last newline', () => {
    const text = 'a'.repeat(10) + '\n' + 'b'.repeat(10) + '\n' + 'c'.repeat(30)
    const parts = splitTextRuns(text, 25)
    expect(parts[0]).toBe('a'.repeat(10) + '\n' + 'b'.repeat(10) + '\n')
    expect(parts.join('')).toBe(text)
  })

  it('cuts at max when a window has no newline, one unit earlier before a split pair', () => {
    expect(splitTextRuns('a'.repeat(30), 25)).toEqual(['a'.repeat(25), 'a'.repeat(5)])
    const parts = splitTextRuns('a'.repeat(24) + '\u{1F600}' + 'bb', 25)
    expect(parts).toEqual(['a'.repeat(24), '\u{1F600}bb'])
  })
})
