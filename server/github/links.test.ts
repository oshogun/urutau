import { describe, expect, test } from 'vitest'
import { rewriteLinkHeader } from './links.ts'

describe('rewriteLinkHeader', () => {
  test('makes api.github.com links relative and keeps their rel', () => {
    expect(
      rewriteLinkHeader('<https://api.github.com/repositories/1/labels?per_page=2&page=2>; rel="next", <https://api.github.com/repositories/1/labels?per_page=2&page=5>; rel="last"'),
    ).toBe('<api/github/repositories/1/labels?per_page=2&page=2>; rel="next", <api/github/repositories/1/labels?per_page=2&page=5>; rel="last"')
  })

  test('drops links to other hosts, look-alike hosts and links without a rel', () => {
    expect(rewriteLinkHeader('<https://evil.example/x>; rel="next"')).toBeNull()
    expect(rewriteLinkHeader('<https://api.github.com.evil.example/x>; rel="next"')).toBeNull()
    expect(rewriteLinkHeader('<http://api.github.com/x>; rel="next"')).toBeNull()
    expect(rewriteLinkHeader('<https://api.github.com/x>')).toBeNull()
    expect(rewriteLinkHeader('')).toBeNull()
  })
})
