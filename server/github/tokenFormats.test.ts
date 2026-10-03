import { describe, expect, it } from 'vitest'
import { BEARER_PATTERN } from '../auth/bearer.ts'
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

  describe('adjacent tokens', () => {
    it('redacts bearers holding an inner gh token near the start of the body', () => {
      const m = 'urutau_mcp_AAAAAghp_abc-' + 'B'.repeat(30)
      const m19 = 'urutau_mcp_' + 'A'.repeat(19) + 'ghs_' + 'C'.repeat(20)
      const p1 = 'urutau_mcp_' + 'ghp_' + 'A'.repeat(10) + '-' + 'A'.repeat(29)
      expect(BEARER_PATTERN.test(m)).toBe(true)
      expect(BEARER_PATTERN.test(m19)).toBe(true)
      for (const v of [m, m19, p1]) expect(redactPatterns(v)).toBe('[redacted]')
    })

    const body = (c: string) => c.repeat(36)
    const kinds: Record<string, string> = {
      ghp: 'ghp_' + body('A'),
      gho: 'gho_' + body('B'),
      ghu: 'ghu_' + body('C'),
      ghs: 'ghs_' + body('D'),
      ghr: 'ghr_' + body('E'),
      pat: 'github_pat_' + body('F'),
      mcp: 'urutau_mcp_' + body('G'),
    }
    for (const [a, x] of Object.entries(kinds)) {
      for (const [b, y] of Object.entries(kinds)) {
        it(`redacts ${a} followed by ${b} as one run`, () => {
          expect(redactPatterns(x + y)).toBe('[redacted]')
        })
      }
    }

    it('redacts all 343 triples without leaving a body character', () => {
      const all = Object.values(kinds)
      for (const x of all) {
        for (const y of all) {
          for (const z of all) expect(redactPatterns(x + y + z)).toBe('[redacted]')
        }
      }
    })

    it('keeps the text between and around tokens that is not token characters', () => {
      expect(redactPatterns(`token=${classic} next ${bearer}, done`)).toBe('token=[redacted] next [redacted], done')
      expect(redactPatterns(`Bearer ${bearer}, done`)).toBe('Bearer [redacted], done')
    })

    it('removes a short gh[pousr]_ tail inside a github_pat_ body', () => {
      expect(redactPatterns('github_pat_' + 'A'.repeat(25) + 'ghp_ABC')).toBe('[redacted]')
    })

    it('redacts a bearer with a ghp_ prefix near the start of its body', () => {
      const a = 'urutau_mcp_' + 'A'.repeat(10) + 'ghp_' + 'B'.repeat(5) + '-' + 'C'.repeat(23)
      const b = 'urutau_mcp_' + 'A'.repeat(19) + 'ghp_BBB_' + 'C'.repeat(16)
      expect(redactPatterns(a)).toBe('[redacted]')
      expect(redactPatterns(b)).toBe('[redacted]')
    })

    it('redacts a bearer with an inner ghs_ token', () => {
      expect(redactPatterns('urutau_mcp_QQQQQghs_AAA_' + 'A'.repeat(30))).toBe('[redacted]')
      expect(redactPatterns('Bearer urutau_mcp_QQQQQghs_AAA_' + 'A'.repeat(30))).toBe('Bearer [redacted]')
    })

    it('redacts a github_pat_ value with a ghp_ prefix inside its first 20 characters', () => {
      expect(redactPatterns('github_pat_' + 'A'.repeat(5) + 'ghp_' + 'B'.repeat(10) + '_' + 'C'.repeat(60))).toBe('[redacted]')
      expect(redactPatterns('github_pat_' + 'A'.repeat(19) + 'ghp_' + 'C'.repeat(59))).toBe('[redacted]')
    })

    it('redacts a bearer with gh[pousr]_ followed by - or _ at every early body index', () => {
      for (let i = 0; i < 38; i++) {
        const body = ('A'.repeat(i) + 'ghp_' + 'a-').padEnd(43, 'B')
        expect(redactPatterns(`before urutau_mcp_${body} after`)).toBe('before [redacted] after')
      }
    })

    it('redacts an accepted github_pat_ value holding an inner gh?_ token followed by an underscore', () => {
      const values = [
        'github_pat_' + 'A'.repeat(20) + 'ghp_' + 'B'.repeat(20) + '_' + 'C'.repeat(30),
        'github_pat_' + 'A'.repeat(22) + '_' + 'D'.repeat(10) + 'gho_' + 'B'.repeat(20) + '_' + 'C'.repeat(20),
        'github_pat_trAsaop0papBgor00p0_p_ptsBigBhshgghu_ssaiBsAg0AprsBstgBrBoaha_goigsur0i',
        ...['p', 'o', 'u', 's', 'r'].map((l) => 'github_pat_' + 'A'.repeat(30) + `gh${l}_` + 'B'.repeat(25) + '_x' + 'C'.repeat(10)),
      ]
      for (const value of values) {
        expect(checkGitHubToken(value).ok).toBe(true)
        expect(redactPatterns(value)).toBe('[redacted]')
      }
    })

    it('redacts a github_pat_ value followed by a ghp_ token and a second github_pat_ value', () => {
      const pat = 'github_pat_' + 'A'.repeat(30)
      expect(redactPatterns(pat + classic + pat).replace(/\[redacted\]/g, '')).toBe('')
    })
  })
})
