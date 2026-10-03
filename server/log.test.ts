import { describe, expect, it } from 'vitest'
import { createLogger } from './log.ts'

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
})
