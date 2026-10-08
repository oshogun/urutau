import { describe, expect, it } from 'vitest'
import {
  ageText,
  claimIsLive,
  humanWaitState,
  isOverWaitLimit,
  isTerminalStatus,
  isWaitingClaim,
  isWaitingStatus,
  statusLabel,
  triageFlagText,
  unverifiedFlagText,
} from './activity.ts'
import type { Estimate, RunStatus } from './types.ts'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
const estimate = (size: Estimate['size'], confidence: Estimate['confidence'] = 'sure'): Estimate => ({
  size,
  confidence,
  by: 'ana',
  at: '2026-10-08T00:00:00.000Z',
})

describe('unverifiedFlagText', () => {
  it('is null with nothing open', () => {
    expect(unverifiedFlagText({ external: 0, normative: 0, untested: 0 })).toBeNull()
  })
  it('counts and lists the kinds in a fixed order', () => {
    expect(unverifiedFlagText({ external: 1, normative: 0, untested: 0 })).toBe('1 unverified (external)')
    expect(unverifiedFlagText({ external: 2, normative: 1, untested: 0 })).toBe('3 unverified (external, normative)')
    expect(unverifiedFlagText({ external: 1, normative: 1, untested: 1 })).toBe('3 unverified (external, normative, untested)')
    expect(unverifiedFlagText({ external: 0, normative: 0, untested: 4 })).toBe('4 unverified (untested)')
  })
})

describe('triageFlagText', () => {
  it('is null without an estimate, a size or a range', () => {
    expect(triageFlagText(null, 'M')).toBeNull()
    expect(triageFlagText(estimate(null, 'no-idea'), 'M')).toBeNull()
    expect(triageFlagText(estimate('S'), null)).toBeNull()
  })
  it('is null when the size is inside the range, bounds included', () => {
    expect(triageFlagText(estimate('M'), 'M')).toBeNull()
    expect(triageFlagText(estimate('S'), 'S-M')).toBeNull()
    expect(triageFlagText(estimate('M'), 'S-L')).toBeNull()
    expect(triageFlagText(estimate('L'), 'M-L')).toBeNull()
  })
  it('names the range when the size is outside it', () => {
    expect(triageFlagText(estimate('S', 'unsure'), 'M-L')).toBe('triage: M–L')
    expect(triageFlagText(estimate('L'), 'S')).toBe('triage: S')
    expect(triageFlagText(estimate('L'), 'S-M')).toBe('triage: S–M')
  })
})

describe('status helpers', () => {
  it('labels every status', () => {
    expect(statusLabel('plan_only')).toBe('Question answered')
    expect(statusLabel('needs_human')).toBe('Needs a human')
    expect(statusLabel('running')).toBe('Running')
  })
  it('splits the statuses into waiting and terminal', () => {
    const all: RunStatus[] = ['running', 'awaiting_approval', 'needs_human', 'budget_exceeded', 'done', 'failed', 'rejected', 'plan_only']
    expect(all.filter(isWaitingStatus)).toEqual(['awaiting_approval', 'needs_human', 'budget_exceeded'])
    expect(all.filter(isTerminalStatus)).toEqual(['done', 'failed', 'rejected', 'plan_only'])
  })
})

describe('ageText', () => {
  it('rounds down to the largest unit', () => {
    expect(ageText(new Date(NOW - 59_000).toISOString(), NOW)).toBe('just now')
    expect(ageText(new Date(NOW - 60_000).toISOString(), NOW)).toBe('1 min')
    expect(ageText(hoursAgo(0.99), NOW)).toBe('59 min')
    expect(ageText(hoursAgo(1), NOW)).toBe('1 h')
    expect(ageText(hoursAgo(47.9), NOW)).toBe('47 h')
    expect(ageText(hoursAgo(48), NOW)).toBe('2 d')
    expect(ageText(hoursAgo(-1), NOW)).toBe('just now')
  })
})

describe('claims and the wait limit', () => {
  const waiting = (hours: number) => ({ status: 'needs_human' as const, leaseUntil: null, since: hoursAgo(hours) })

  it('treats a claim without a lease as live and one past its lease as gone', () => {
    expect(claimIsLive({ leaseUntil: null }, NOW)).toBe(true)
    expect(claimIsLive({ leaseUntil: new Date(NOW + 1).toISOString() }, NOW)).toBe(true)
    expect(claimIsLive({ leaseUntil: new Date(NOW).toISOString() }, NOW)).toBe(false)
  })

  it('counts only live claims in a waiting status as waiting', () => {
    expect(isWaitingClaim(waiting(1), NOW)).toBe(true)
    expect(isWaitingClaim(null, NOW)).toBe(false)
    expect(isWaitingClaim({ status: 'running', leaseUntil: new Date(NOW + 1000).toISOString() }, NOW)).toBe(false)
    expect(isWaitingClaim({ status: 'needs_human', leaseUntil: hoursAgo(1) }, NOW)).toBe(false)
  })

  it('is over the limit only when strictly older than it', () => {
    expect(isOverWaitLimit(waiting(24), 24, NOW)).toBe(false)
    expect(isOverWaitLimit({ ...waiting(0), since: new Date(NOW - 24 * 3_600_000 - 1).toISOString() }, 24, NOW)).toBe(true)
    expect(isOverWaitLimit(waiting(100), null, NOW)).toBe(false)
    expect(isOverWaitLimit(null, 24, NOW)).toBe(false)
  })

  it('counts waiting and over-limit cards', () => {
    const cards = [{ claim: waiting(30) }, { claim: waiting(2) }, { claim: null }]
    expect(humanWaitState(cards, 24, NOW)).toEqual({ waiting: 2, over: 1, limitHours: 24 })
    expect(humanWaitState(cards, null, NOW)).toEqual({ waiting: 2, over: 0, limitHours: null })
  })
})
