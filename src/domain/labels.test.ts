import { describe, expect, it } from 'vitest'
import { tagTypeForColor } from './labels.ts'

describe('tagTypeForColor', () => {
  // GitHub's default label set.
  it.each([
    ['d73a4a', 'red'], // bug
    ['0075ca', 'cyan'], // documentation
    ['a2eeef', 'teal'], // enhancement
    ['7057ff', 'purple'], // good first issue
    ['008672', 'teal'], // help wanted
    ['e4e669', 'warm-gray'], // invalid
    ['d876e3', 'purple'], // question
    ['cfd3d7', 'gray'], // duplicate
    ['ffffff', 'gray'], // wontfix
  ])('#%s → %s', (hex, expected) => {
    expect(tagTypeForColor(hex)).toBe(expected)
  })

  it.each([
    ['0e8a16', 'green'],
    ['1d76db', 'blue'],
    ['e99695', 'red'],
    ['fbca04', 'warm-gray'],
    ['c2185b', 'magenta'],
  ])('#%s → %s', (hex, expected) => {
    expect(tagTypeForColor(hex)).toBe(expected)
  })

  it('accepts a leading # and falls back to gray for invalid colors', () => {
    expect(tagTypeForColor('#d73a4a')).toBe('red')
    expect(tagTypeForColor('nope')).toBe('gray')
    expect(tagTypeForColor('')).toBe('gray')
  })
})
