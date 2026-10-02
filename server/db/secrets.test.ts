import { describe, expect, it, vi } from 'vitest'
import { createLogger, redact, urlSecrets } from '../log.ts'
import { openDatabase } from './index.ts'

// A pool that cannot connect and puts its connection string into the failure, as a driver might.
vi.mock('pg', () => {
  class Pool {
    connectionString: string
    constructor(options: { connectionString: string }) {
      this.connectionString = options.connectionString
    }
    async connect(): Promise<never> {
      throw new Error(`connection to ${this.connectionString} failed`)
    }
    async end(): Promise<void> {}
  }
  return { default: { Pool } }
})

const PASSWORD = 'hunter2-s3cret'
const URL_WITH_PASSWORD = `postgres://urutau:${PASSWORD}@db.internal:5432/urutau`

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected a rejection')
}

describe('secrets stay out of errors and logs', () => {
  it('keeps the URL and password out of a failure raised while migrating', async () => {
    const database = await openDatabase(URL_WITH_PASSWORD)
    const message = await messageOf(() => database.migrate())
    expect(message).toContain('connection to')
    expect(message).not.toContain(PASSWORD)
    expect(message).not.toContain(URL_WITH_PASSWORD)
    expect(message).not.toContain('db.internal')
  })

  it('keeps the URL out of the unsupported-scheme error', async () => {
    const url = `ftp://urutau:${PASSWORD}@db.internal/urutau`
    const message = await messageOf(() => openDatabase(url))
    expect(message).not.toContain(PASSWORD)
    expect(message).not.toContain('db.internal')
  })

  it('redacts the URL, the password and its percent-encoded form from log lines', () => {
    const url = 'mysql://urutau:p%40ss%2Fword@db.internal/urutau'
    const lines: string[] = []
    const log = createLogger({ write: (line) => lines.push(line), secrets: urlSecrets(url) })
    log.error(`cannot reach ${url} with p%40ss%2Fword and p@ss/word`, { detail: 'password p@ss/word', status: 500 })
    expect(lines).toHaveLength(1)
    const line = lines[0] as string
    expect(line).not.toContain('p%40ss%2Fword')
    expect(line).not.toContain('p@ss/word')
    expect(line).not.toContain('db.internal')
    expect(JSON.parse(line)).toMatchObject({ level: 'error', status: 500 })
  })

  it('redacts a password with a percent sign that is not an escape', () => {
    const secrets = urlSecrets('postgres://urutau:100%off@db.internal/x')
    expect(redact('login failed for 100%off', secrets)).not.toContain('100%off')
  })

  it('redact ignores empty secrets', () => {
    expect(redact('abc', ['', 'b'])).toBe('a[redacted]c')
  })
})
