import { describe, expect, it } from 'vitest'
import { isBoardVersion } from './validate.ts'

describe('isBoardVersion', () => {
  it('accepts whole numbers a database integer column can hold and increment', () => {
    for (const value of [1, 2, 1000, 2 ** 31 - 2]) expect(isBoardVersion(value)).toBe(true)
  })

  it('rejects everything else', () => {
    for (const value of [0, -1, 1.5, 2 ** 31 - 1, 2 ** 31, 2 ** 53, 1e300, NaN, Infinity, '1', null, undefined]) {
      expect(isBoardVersion(value)).toBe(false)
    }
  })
})
