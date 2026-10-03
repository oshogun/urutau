import { describe, expect, it } from 'vitest'
import { SECRET_PATTERNS, checkGitHubToken, redactPatterns } from './tokenFormats.ts'

const classic = 'ghp_' + 'F'.repeat(36)
const bearer = 'urutau_mcp_' + 'A'.repeat(43)

describe('checkGitHubToken', () => {
  it('accepts a fine-grained token', () => {
    expect(checkGitHubToken('github_pat_urutau_fixture_not_a_real_token')).toEqual({ ok: true, kind: 'fine-grained' })
    expect(checkGitHubToken('github_pat_' + 'a'.repeat(20))).toEqual({ ok: true, kind: 'fine-grained' })
    expect(checkGitHubToken('github_pat_' + 'a'.repeat(255))).toEqual({ ok: true, kind: 'fine-grained' })
  })

  it('rejects fine-grained tokens of the wrong length or alphabet', () => {
    const bad = { ok: false, code: 'unsupported-token-format' }
    expect(checkGitHubToken('github_pat_' + 'a'.repeat(19))).toEqual(bad)
    expect(checkGitHubToken('github_pat_' + 'a'.repeat(256))).toEqual(bad)
    expect(checkGitHubToken('github_pat_' + 'a'.repeat(19) + '-')).toEqual(bad)
  })

  it('accepts a classic token of exactly 36 characters', () => {
    expect(checkGitHubToken(classic)).toEqual({ ok: true, kind: 'classic' })
    expect(checkGitHubToken(classic + 'F')).toEqual({ ok: false, code: 'unsupported-token-format' })
    expect(checkGitHubToken(classic.slice(0, -1))).toEqual({ ok: false, code: 'unsupported-token-format' })
    expect(checkGitHubToken('ghp_' + 'F'.repeat(35) + '_')).toEqual({ ok: false, code: 'unsupported-token-format' })
  })

  it('names an Urutau bearer token as not a GitHub token, with or without a matching body', () => {
    const named = { ok: false, code: 'not-a-github-token' }
    expect(checkGitHubToken(bearer)).toEqual(named)
    expect(checkGitHubToken('urutau_mcp_' + 'a_b-'.repeat(10))).toEqual(named)
  })

  it('names other prefixes and bare hex as an unsupported format', () => {
    const unsupported = { ok: false, code: 'unsupported-token-format' }
    for (const prefix of ['gho_', 'ghu_', 'ghs_', 'ghr_']) {
      expect(checkGitHubToken(prefix + 'F'.repeat(36))).toEqual(unsupported)
    }
    expect(checkGitHubToken('f'.repeat(40))).toEqual(unsupported)
    expect(checkGitHubToken('')).toEqual(unsupported)
    expect(checkGitHubToken(' ' + classic)).toEqual(unsupported)
  })
})

describe('SECRET_PATTERNS', () => {
  const samples: Record<string, string> = {
    urutau_mcp_: bearer,
    github_pat_: 'github_pat_urutau_fixture_not_a_real_token',
    ghp_: classic,
    gho_: 'gho_' + 'F'.repeat(36),
    ghu_: 'ghu_' + 'F'.repeat(36),
    ghs_: 'ghs_' + 'F'.repeat(36),
    ghr_: 'ghr_' + 'F'.repeat(36),
  }

  it('are global so every match is replaced', () => {
    for (const pattern of SECRET_PATTERNS) expect(pattern.global).toBe(true)
  })

  it.each(Object.entries(samples))('removes a %s value', (_prefix, value) => {
    expect(redactPatterns(`before ${value} after`)).toBe('before [redacted] after')
  })

  it('removes every occurrence and leaves short look-alikes alone', () => {
    expect(redactPatterns(`${classic} and ${bearer}`)).toBe('[redacted] and [redacted]')
    expect(redactPatterns('ghp_short urutau_mcp_ github_pat_abc')).toBe('ghp_short urutau_mcp_ github_pat_abc')
  })

  it('removes a value right after a letter, underscore or URL escape', () => {
    expect(redactPatterns('Authorization:%20Bearer%20' + bearer)).toBe('Authorization:%20Bearer%20[redacted]')
    expect(redactPatterns('token%3D' + classic)).toBe('token%3D[redacted]')
    expect(redactPatterns('x_' + bearer)).toBe('x_[redacted]')
  })
})
