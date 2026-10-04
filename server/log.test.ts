import { describe, expect, it } from 'vitest'
import { SECRET_PATTERNS } from './github/tokenFormats.ts'
import { createLogger, urlSecrets } from './log.ts'

const values = [
  'urutau_mcp_' + 'A'.repeat(43),
  'github_pat_urutau_fixture_not_a_real_token',
  'ghp_' + 'F'.repeat(36),
  'gho_' + 'F'.repeat(36),
  'ghu_' + 'F'.repeat(36),
  'ghs_' + 'F'.repeat(36),
  'ghr_' + 'F'.repeat(36),
]

function capture(patterns?: boolean, secrets?: string[]) {
  const lines: Array<Record<string, unknown>> = []
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)), patterns, secrets, now: () => new Date(0) })
  return { lines, logger }
}

describe('createLogger patterns', () => {
  it('redacts every token prefix in the message and in fields when on', () => {
    const { lines, logger } = capture(true)
    for (const value of values) logger.info(`got ${value}`, { detail: `x ${value} y`, count: 3 })
    expect(lines).toHaveLength(values.length)
    for (const line of lines) {
      expect(line.msg).toBe('got [redacted]')
      expect(line.detail).toBe('x [redacted] y')
      expect(line.count).toBe(3)
    }
  })

  it('leaves values untouched by default so tests can see leaks', () => {
    const { lines, logger } = capture()
    for (const value of values) logger.warn(value, { detail: value })
    values.forEach((value, index) => {
      expect(lines[index].msg).toBe(value)
      expect(lines[index].detail).toBe(value)
    })
  })

  it('redacts two tokens written back to back as one run', () => {
    const { lines, logger } = capture(true)
    for (const first of values) {
      for (const second of values) logger.warn(first + second, { detail: `${first}${second}` })
    }
    expect(lines).toHaveLength(values.length * values.length)
    for (const line of lines) {
      expect(line.msg).toBe('[redacted]')
      expect(line.detail).toBe('[redacted]')
    }
  })

  it('redacts tokens written after a URL escape or an underscore', () => {
    const { lines, logger } = capture(true)
    for (const text of [
      'Authorization:%20Bearer%20' + 'urutau_mcp_' + 'A'.repeat(43),
      'token%3D' + 'ghp_' + 'F'.repeat(36),
      'x_' + 'urutau_mcp_' + 'A'.repeat(43),
    ]) {
      logger.error(text, { field: text })
    }
    expect(lines.map((line) => line.msg)).toEqual(['Authorization:%20Bearer%20[redacted]', 'token%3D[redacted]', 'x_[redacted]'])
    expect(lines.map((line) => line.field)).toEqual(['Authorization:%20Bearer%20[redacted]', 'token%3D[redacted]', 'x_[redacted]'])
  })

  it('redacts a bearer holding an inner ghs_ token', () => {
    const { lines, logger } = capture(true)
    logger.warn('probe', { detail: 'Bearer urutau_mcp_QQQQQghs_AAA_' + 'A'.repeat(30) })
    expect(lines[0].detail).toBe('Bearer [redacted]')
  })

  it('still removes literal secrets with patterns on', () => {
    const { lines, logger } = capture(true, ['hunter2'])
    logger.info('password hunter2', { f: 'hunter2' })
    expect(lines[0].msg).toBe('password [redacted]')
    expect(lines[0].f).toBe('[redacted]')
  })

  it('still removes literal secrets with patterns off', () => {
    const { lines, logger } = capture(false, ['hunter2'])
    logger.info('password hunter2', { f: 'hunter2' })
    expect(lines[0].msg).toBe('password [redacted]')
    expect(lines[0].f).toBe('[redacted]')
  })
})

describe('createLogger redaction order', () => {
  const secret = 'urutau'
  const body = 'Qk7Zp3Xw9Lm2Vb8Nc4Rt6Yh1Jd5Fg0SaEiOuKqWxMnBvCz'
  const prefixes = ['urutau_mcp_', 'github_pat_', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']

  function survivingRun(text: string, tokenBody: string): string | undefined {
    for (let i = 0; i + 8 <= tokenBody.length; i++) {
      const run = tokenBody.slice(i, i + 8)
      if (text.includes(run)) return run
    }
    return undefined
  }

  it('leaves no part of the issue reproduction token in the line', () => {
    const tokenBody = 'Ab3dEf6hIj9lMnUrutauPq2sTv5xYz8BcDe'.padEnd(43, 'Z')
    const token = 'urutau_mcp_' + tokenBody
    const lines: string[] = []
    const logger = createLogger({
      write: (line) => lines.push(line),
      secrets: urlSecrets('postgres://urutau:urutau@db:5432/urutau'),
      patterns: true,
    })
    logger.info('request', { Authorization: `Bearer ${token}` })
    expect(lines).toHaveLength(1)
    expect(survivingRun(lines[0], tokenBody)).toBeUndefined()
    expect(JSON.parse(lines[0]).Authorization).toBe('Bearer [redacted]')
  })

  for (const prefix of prefixes) {
    it(`leaves no part of a ${prefix} token that contains a configured secret`, () => {
      const tokenBody = body.slice(0, 20) + secret + body.slice(20)
      const token = prefix + tokenBody
      const { lines, logger } = capture(true, [secret])
      logger.warn(`got ${token}`, { detail: `x ${token} y` })
      const raw = JSON.stringify(lines[0])
      expect(survivingRun(raw, tokenBody)).toBeUndefined()
      expect(lines[0].msg).toBe('got [redacted]')
      expect(lines[0].detail).toBe('x [redacted] y')
    })
  }

  describe('a configured secret that contains a token-shaped run', () => {
    const urls = [
      'postgres://urutau:blue_weighs_seven_tons_at_high_noon@db:5432/urutau',
      'postgres://urutau:Xk9%23mQ2%24vL7%26ghp_aaaaaaaaaaaaaaaaaaaa@db:5432/urutau',
      'postgres://admin:S3cret@db.internal:5432/ghs_production_database_01',
    ]
    for (const url of urls) {
      it(`redacts the whole secret of ${url.split('@')[1]}`, () => {
        const secrets = urlSecrets(url)
        const password = decodeURIComponent(new URL(url).password)
        for (const text of [`auth failed for password ${password}`, `connect ${url}`]) {
          const { lines, logger } = capture(true, secrets)
          logger.error(text, { message: text })
          const raw = JSON.stringify(lines[0])
          expect(raw).not.toContain(password)
          expect(raw).not.toContain('db.internal')
          expect(raw).not.toContain('Xk9')
          expect(lines[0].msg).toBe(lines[0].message)
          expect(lines[0].msg).not.toMatch(/blue_|S3cret|ghs_prod/)
        }
      })
    }
  })

  describe('overlapping copies of a secret and a shared pattern state', () => {
    it('joins overlapping occurrences into one span with patterns off', () => {
      let c = capture(false, ['Za', 'aXa'])
      c.logger.info('ZaXaXa')
      expect(c.lines[0].msg).toBe('[redacted]')
      c = capture(false, ['aXa'])
      c.logger.info('aXaXa')
      expect(c.lines[0].msg).toBe('[redacted]')
    })

    it('joins overlapping occurrences into one span with patterns on', () => {
      let c = capture(true, ['pass1pass'])
      c.logger.info('pw pass1pass1pass')
      expect(c.lines[0].msg).toBe('pw [redacted]')
      c = capture(true, ['Qa', 'aba'])
      c.logger.info('Qababa')
      expect(c.lines[0].msg).toBe('[redacted]')
    })

    it('ignores a lastIndex left on the shared token pattern', () => {
      const { lines, logger } = capture(true)
      SECRET_PATTERNS[0].lastIndex = 43
      try {
        logger.info('Bearer ghp_' + 'A'.repeat(36))
      } finally {
        SECRET_PATTERNS[0].lastIndex = 0
      }
      expect(lines[0].msg).toBe('Bearer [redacted]')
    })
  })
})
