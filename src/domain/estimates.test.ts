import { describe, expect, it } from 'vitest'
import { makeBoard, makeBucket } from '../test/fixtures.ts'
import { isBoardConfig } from './board.ts'
import {
  clearEstimate,
  ESTIMATES_MAX,
  estimateLabel,
  isEstimate,
  keepEstimates,
  setEstimate,
  validOptionalBoardFields,
} from './estimates.ts'
import type { Estimate } from './types.ts'

const at = '2026-10-08T12:00:00.000Z'
const sure: Estimate = { size: 'M', confidence: 'sure', by: 'ana', at }
const unsure: Estimate = { size: 'M', confidence: 'unsure', by: 'ana', at }
const noIdea: Estimate = { size: null, confidence: 'no-idea', by: 'ana', at }

describe('estimateLabel', () => {
  it('writes the size, the size with a question mark, or a lone question mark', () => {
    expect(estimateLabel(sure)).toBe('M')
    expect(estimateLabel(unsure)).toBe('M?')
    expect(estimateLabel(noIdea)).toBe('?')
  })
})

describe('isEstimate', () => {
  it('requires a size unless the confidence is no-idea', () => {
    expect(isEstimate(sure)).toBe(true)
    expect(isEstimate(noIdea)).toBe(true)
    expect(isEstimate({ ...sure, size: null })).toBe(false)
    expect(isEstimate({ ...noIdea, size: 'S' })).toBe(false)
    expect(isEstimate({ ...sure, size: 'XL' })).toBe(false)
    expect(isEstimate({ ...sure, confidence: 'certain' })).toBe(false)
  })

  it('checks the author length in code points and the timestamp shape', () => {
    expect(isEstimate({ ...sure, by: '' })).toBe(false)
    expect(isEstimate({ ...sure, by: '😀'.repeat(64) })).toBe(true)
    expect(isEstimate({ ...sure, by: '😀'.repeat(65) })).toBe(false)
    expect(isEstimate({ ...sure, at: '2026-10-08' })).toBe(false)
    expect(isEstimate({ ...sure, at: '2026-10-08T12:00:00Z' })).toBe(true)
    expect(isEstimate(null)).toBe(false)
    expect(isEstimate([])).toBe(false)
  })
})

describe('validOptionalBoardFields', () => {
  it('accepts a config with neither field', () => {
    expect(validOptionalBoardFields({})).toBe(true)
  })

  it('checks the keys and the count of estimates', () => {
    expect(validOptionalBoardFields({ estimates: { 7: sure } })).toBe(true)
    expect(validOptionalBoardFields({ estimates: { 0: sure } })).toBe(false)
    expect(validOptionalBoardFields({ estimates: { '07': sure } })).toBe(false)
    expect(validOptionalBoardFields({ estimates: { 2147483648: sure } })).toBe(false)
    expect(validOptionalBoardFields({ estimates: { 2147483647: sure } })).toBe(true)
    expect(validOptionalBoardFields({ estimates: [sure] })).toBe(false)
    expect(validOptionalBoardFields({ estimates: null })).toBe(false)
    const many = Object.fromEntries(Array.from({ length: ESTIMATES_MAX + 1 }, (_, i) => [i + 1, sure]))
    expect(validOptionalBoardFields({ estimates: many })).toBe(false)
  })

  it('accepts a whole number of hours from 1 to 720, or null', () => {
    for (const ok of [null, 1, 24, 720]) expect(validOptionalBoardFields({ humanWaitLimit: ok })).toBe(true)
    for (const bad of [0, 721, 1.5, '24', -1, NaN]) expect(validOptionalBoardFields({ humanWaitLimit: bad })).toBe(false)
  })

  it('makes isBoardConfig refuse a config whose present fields are invalid', () => {
    const base = makeBoard([makeBucket('todo')])
    expect(isBoardConfig(base)).toBe(true)
    expect(isBoardConfig({ ...base, estimates: { 3: unsure }, humanWaitLimit: 48 })).toBe(true)
    expect(isBoardConfig({ ...base, estimates: { 3: { ...unsure, size: null } } })).toBe(false)
    expect(isBoardConfig({ ...base, humanWaitLimit: 0 })).toBe(false)
  })
})

describe('setEstimate, clearEstimate and keepEstimates', () => {
  const base = makeBoard([makeBucket('todo')])

  it('sets and replaces an estimate without touching the rest', () => {
    const one = setEstimate(base, 4, unsure)
    expect(one.estimates).toEqual({ 4: unsure })
    expect(one.buckets).toBe(base.buckets)
    expect(setEstimate(one, 4, sure).estimates).toEqual({ 4: sure })
    expect(setEstimate(one, 5, noIdea).estimates).toEqual({ 4: unsure, 5: noIdea })
  })

  it('clears one estimate, returns the same config when there is none, and drops the empty map', () => {
    const two = setEstimate(setEstimate(base, 4, sure), 5, unsure)
    expect(clearEstimate(two, 4).estimates).toEqual({ 5: unsure })
    expect(clearEstimate(base, 4)).toBe(base)
    expect(clearEstimate(two, 9)).toBe(two)
    expect('estimates' in clearEstimate(setEstimate(base, 4, sure), 4)).toBe(false)
  })

  it('carries the estimates of the previous config onto a reset board', () => {
    const previous = { ...setEstimate(base, 4, sure), humanWaitLimit: 24 }
    const reset = keepEstimates(makeBoard([makeBucket('fresh')]), previous)
    expect(reset.estimates).toEqual({ 4: sure })
    expect(reset.humanWaitLimit).toBeUndefined()
    const bare = makeBoard([makeBucket('fresh')])
    expect(keepEstimates(bare, base)).toBe(bare)
  })
})
