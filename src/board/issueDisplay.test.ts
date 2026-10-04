import { describe, expect, it } from 'vitest'
import { avatarSrc, issueStateTag } from './issueDisplay'

describe('issueStateTag', () => {
  it.each([
    ['open', null, 'green', 'Open', 'Open'],
    ['open', 'reopened', 'green', 'Open', 'Open'],
    ['open', 'completed', 'green', 'Open', 'Open'],
    ['closed', 'completed', 'purple', 'Closed', 'Closed as completed'],
    ['closed', 'not_planned', 'gray', 'Not planned', 'Closed as not planned'],
    ['closed', 'duplicate', 'purple', 'Closed', 'Closed as duplicate'],
    ['closed', null, 'purple', 'Closed', 'Closed'],
    ['closed', 'something_new', 'purple', 'Closed', 'Closed'],
  ] as const)('%s with reason %s', (state, reason, type, short, long) => {
    expect(issueStateTag(state, reason)).toEqual({ type, short, long })
  })
})

describe('avatarSrc', () => {
  it('adds the size with ? or &', () => {
    expect(avatarSrc('https://a/b')).toBe('https://a/b?s=40')
    expect(avatarSrc('https://a/b?v=4')).toBe('https://a/b?v=4&s=40')
  })
})
