import { describe, expect, it } from 'vitest'
import { makeClaim, makeRunDetail } from '../test/fixtures'
import { triageAgentName, triageTagTitle } from './runDisplay'

describe('triageAgentName', () => {
  it('prefers the agent of the cached run detail', () => {
    const detail = makeRunDetail('r-1', { agent: { username: 'sizer', kind: 'integration' } })
    expect(triageAgentName(makeClaim('r-1'), detail, 'r-1')).toBe('sizer')
  })
  it('falls back to the holder of a live claim for the same run', () => {
    expect(triageAgentName(makeClaim('r-1'), null, 'r-1')).toBe('carcara')
  })
  it('ignores a claim for another run', () => {
    expect(triageAgentName(makeClaim('r-2'), null, 'r-1')).toBeNull()
  })
  it('is null for a removed agent', () => {
    expect(triageAgentName(null, makeRunDetail('r-1', { agent: null }), 'r-1')).toBeNull()
    expect(triageAgentName(makeClaim('r-1', { holder: null }), null, 'r-1')).toBeNull()
  })
})

describe('triageTagTitle', () => {
  it('leaves out the parts that are unknown', () => {
    expect(triageTagTitle('S-M', 'carcara', 'external')).toBe('Triage range S–M from carcara · uncertainty: external')
    expect(triageTagTitle('S-M', null, 'none')).toBe('Triage range S–M · uncertainty: none')
    expect(triageTagTitle('M', 'carcara', null)).toBe('Triage range M from carcara')
    expect(triageTagTitle('M', null, null)).toBe('Triage range M')
  })
})
