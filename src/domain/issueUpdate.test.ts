import { describe, expect, it } from 'vitest'
import { makeIssue } from '../test/fixtures.ts'
import {
  conflictingFields,
  describeChanges,
  editFields,
  normalizeIssueUpdate,
  parseUpdateIssueRequest,
  rebaseDraft,
  sameUpdatedAt,
  startDraft,
  stateActionPending,
  stateFields,
  textareaValue,
} from './issueUpdate.ts'

const message = (input: unknown) => {
  const result = normalizeIssueUpdate(input)
  return result.ok ? null : result.message
}

describe('normalizeIssueUpdate', () => {
  it('checks the rules in order and names the first failure', () => {
    expect(message(null)).toBe('The fields must be a JSON object.')
    expect(message([])).toBe('The fields must be a JSON object.')
    expect(message({ labels: ['x'] })).toBe('Only title, body, state and state_reason can be changed.')
    expect(message({})).toBe('Nothing to change.')
    expect(message({ title: undefined })).toBe('Nothing to change.')
    expect(message({ title: 3 })).toBe('title must be text.')
    expect(message({ title: '   ' })).toBe('title is required.')
    expect(message({ title: 'a'.repeat(257) })).toBe('title must be at most 256 characters.')
    expect(message({ body: 3 })).toBe('body must be text.')
    expect(message({ body: 'a'.repeat(65_537) })).toBe('body must be at most 65,536 characters.')
    expect(message({ state: 'merged', state_reason: 'completed' })).toBe('state must be open or closed.')
    expect(message({ state: 'closed' })).toBe('state and state_reason go together.')
    expect(message({ state_reason: 'completed' })).toBe('state and state_reason go together.')
    expect(message({ state: 'closed', state_reason: 'reopened' })).toBe('state_reason does not fit state.')
    expect(message({ state: 'open', state_reason: 'completed' })).toBe('state_reason does not fit state.')
    expect(message({ state: 'closed', state_reason: 'duplicate' })).toBe('state_reason does not fit state.')
  })

  it('counts code points, trims the title and keeps the body as typed', () => {
    expect(message({ title: '😀'.repeat(256) })).toBeNull()
    expect(message({ title: '😀'.repeat(257) })).toBe('title must be at most 256 characters.')
    expect(message({ body: '😀'.repeat(65_536) })).toBeNull()
    expect(normalizeIssueUpdate({ body: '', title: '  Hi  ' })).toEqual({ ok: true, value: { title: 'Hi', body: '' } })
  })

  it('returns a new object with keys in a fixed order', () => {
    const input = { state_reason: 'not_planned', state: 'closed', body: ' b ', title: 't' }
    const result = normalizeIssueUpdate(input)
    expect(result.ok && Object.keys(result.value)).toEqual(['title', 'body', 'state', 'state_reason'])
    expect(result.ok && result.value).not.toBe(input)
    expect(result.ok && result.value.body).toBe(' b ')
  })
})

describe('parseUpdateIssueRequest', () => {
  const fields = { title: 'New' }
  it('accepts exactly expectedUpdatedAt and fields', () => {
    expect(parseUpdateIssueRequest({ expectedUpdatedAt: '2026-01-02T00:00:00Z', fields })).toEqual({
      ok: true,
      value: { expectedUpdatedAt: '2026-01-02T00:00:00Z', fields },
    })
  })

  it('refuses other shapes, a bad time and bad fields', () => {
    const shape = 'The request body must have expectedUpdatedAt and fields only.'
    expect(parseUpdateIssueRequest(null)).toEqual({ ok: false, message: shape })
    expect(parseUpdateIssueRequest({ fields })).toEqual({ ok: false, message: shape })
    expect(parseUpdateIssueRequest({ expectedUpdatedAt: 'x', fields, extra: 1 })).toEqual({ ok: false, message: shape })
    expect(parseUpdateIssueRequest({ expectedUpdatedAt: 'yesterday', fields })).toEqual({
      ok: false,
      message: 'expectedUpdatedAt must be a time.',
    })
    expect(parseUpdateIssueRequest({ expectedUpdatedAt: 5, fields })).toEqual({
      ok: false,
      message: 'expectedUpdatedAt must be a time.',
    })
    expect(parseUpdateIssueRequest({ expectedUpdatedAt: '2026-01-02T00:00:00Z', fields: {} })).toEqual({
      ok: false,
      message: 'Nothing to change.',
    })
  })
})

describe('sameUpdatedAt', () => {
  it('compares instants, not spellings, and never matches an unparseable time', () => {
    expect(sameUpdatedAt('2026-01-02T00:00:21Z', '2026-01-02T00:00:21.000Z')).toBe(true)
    expect(sameUpdatedAt('2026-01-02T00:00:21Z', '2026-01-02T00:00:22Z')).toBe(false)
    expect(sameUpdatedAt('nope', 'nope')).toBe(false)
  })
})

describe('edit fields', () => {
  const base = makeIssue(1, { title: 'Old', body: 'line 1\r\nline 2' })

  it('reads a CRLF description as the textarea holds it', () => {
    expect(textareaValue('a\r\nb\rc\n')).toBe('a\nb\nc\n')
    expect(startDraft(base)).toEqual({ title: 'Old', body: 'line 1\nline 2' })
    expect(startDraft(makeIssue(2))).toEqual({ title: 'Issue 2', body: '' })
  })

  it('sends only what the person changed', () => {
    expect(editFields(base, startDraft(base))).toEqual({})
    expect(editFields(base, { title: ' Old ', body: 'line 1\nline 2' })).toEqual({})
    expect(editFields(base, { title: ' New ', body: 'line 1\nline 2' })).toEqual({ title: 'New' })
    expect(editFields(base, { title: 'Old', body: '' })).toEqual({ body: '' })
  })
})

describe('state fields', () => {
  it('maps each action to GitHub names', () => {
    expect(stateFields('close-completed')).toEqual({ state: 'closed', state_reason: 'completed' })
    expect(stateFields('close-not-planned')).toEqual({ state: 'closed', state_reason: 'not_planned' })
    expect(stateFields('reopen')).toEqual({ state: 'open', state_reason: 'reopened' })
  })

  it('is pending only while the state would change', () => {
    const open = makeIssue(1)
    const closed = makeIssue(2, { state: 'closed', stateReason: 'completed' })
    expect(stateActionPending('close-completed', open)).toBe(true)
    expect(stateActionPending('close-not-planned', closed)).toBe(false)
    expect(stateActionPending('reopen', closed)).toBe(true)
    expect(stateActionPending('reopen', open)).toBe(false)
  })
})

describe('describeChanges, rebaseDraft and conflictingFields', () => {
  const base = makeIssue(1, { title: 'Old', body: 'text' })

  it('lists title, description and state, or other', () => {
    expect(describeChanges(base, { ...base })).toEqual(['other'])
    expect(describeChanges(base, { ...base, updatedAt: 'later' })).toEqual(['other'])
    expect(describeChanges(base, { ...base, title: 'T', body: 'x\r\ny', state: 'closed', stateReason: 'completed' })).toEqual([
      'title',
      'body',
      'state',
    ])
    expect(describeChanges({ ...base, body: 'a\r\nb' }, { ...base, body: 'a\nb' })).toEqual(['other'])
    const closed = { ...base, state: 'closed' as const, stateReason: 'completed' }
    expect(describeChanges(closed, { ...closed, stateReason: 'not_planned' })).toEqual(['state'])
  })

  it('keeps what the person changed and takes GitHub text for the rest', () => {
    const current = { ...base, title: 'Theirs', body: 'their text' }
    expect(rebaseDraft(base, { title: 'Old', body: 'mine' }, current)).toEqual({ title: 'Theirs', body: 'mine' })
    expect(rebaseDraft(base, { title: 'Mine', body: 'text' }, current)).toEqual({ title: 'Mine', body: 'their text' })
  })

  it('names the fields both sides changed', () => {
    const current = { ...base, title: 'Theirs', body: 'their text' }
    expect(conflictingFields(base, { title: 'Mine', body: 'mine' }, current)).toEqual(['title', 'body'])
    expect(conflictingFields(base, { title: 'Old', body: 'mine' }, current)).toEqual(['body'])
    expect(conflictingFields(base, { title: 'Mine', body: 'text' }, { ...base, body: 'x' })).toEqual([])
  })
})
