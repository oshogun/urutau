import { describe, expect, test } from 'vitest'
import { checkedIssue, issuePathFor } from './updateIssue.ts'

describe('issuePathFor', () => {
  test('builds the upstream path of an issue', () => {
    expect(issuePathFor('acme', 'widgets', '7')).toBe('repos/acme/widgets/issues/7')
    expect(issuePathFor('acme', 'widgets', '2147483647')).toBe('repos/acme/widgets/issues/2147483647')
  })

  test('refuses dot names, an owner with a slash and numbers that are not 1 to 2147483647 without leading zeros', () => {
    expect(issuePathFor('acme', '..', '7')).toBeNull()
    expect(issuePathFor('acme', '.', '7')).toBeNull()
    expect(issuePathFor('acme/x', 'widgets', '7')).toBeNull()
    expect(issuePathFor('acme', 'widgets', '0')).toBeNull()
    expect(issuePathFor('acme', 'widgets', '07')).toBeNull()
    expect(issuePathFor('acme', 'widgets', '7x')).toBeNull()
    expect(issuePathFor('acme', 'widgets', '')).toBeNull()
    expect(issuePathFor('acme', 'widgets', '2147483648')).toBeNull()
    expect(issuePathFor('acme', 'widgets', '12345678901')).toBeNull()
  })
})

describe('checkedIssue', () => {
  test('reads updated_at and whether the answer is a pull request', () => {
    expect(checkedIssue({ updated_at: '2026-01-01T00:00:00Z' })).toEqual({ updatedAt: '2026-01-01T00:00:00Z', pullRequest: false })
    expect(checkedIssue({ updated_at: '2026-01-01T00:00:00Z', pull_request: {} })).toEqual({
      updatedAt: '2026-01-01T00:00:00Z',
      pullRequest: true,
    })
  })

  test('is null for anything that is not an object with a text updated_at', () => {
    expect(checkedIssue({ updated_at: 5 })).toBeNull()
    expect(checkedIssue({})).toBeNull()
    expect(checkedIssue(null)).toBeNull()
    expect(checkedIssue([])).toBeNull()
    expect(checkedIssue('text')).toBeNull()
  })
})
