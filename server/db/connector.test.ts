import { writeSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectorSuite } from './connector.suite.ts'
import { openDatabase } from './index.ts'

connectorSuite('sqlite in memory', () => openDatabase('sqlite::memory:'))

// Set by the PostgreSQL and MariaDB test scripts; the same suite then runs against that server.
// The suite deletes every row of the application tables, so it only runs against a local database.
const externalUrl = process.env.URUTAU_TEST_DATABASE_URL
if (externalUrl) {
  const host = new URL(externalUrl.replace(/^mariadb:/, 'mysql:')).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('URUTAU_TEST_DATABASE_URL must point at 127.0.0.1 or localhost')
  }
  connectorSuite('URUTAU_TEST_DATABASE_URL', () => openDatabase(externalUrl))
} else {
  // Written straight to stderr: the default reporter hides console output of passing tests.
  writeSync(2, '\nPostgreSQL and MariaDB suites skipped: URUTAU_TEST_DATABASE_URL is not set (npm run test:db:postgres, npm run test:db:mariadb)\n')
  describe('external database suite', () => {
    it('is not configured, so only SQLite ran', () => {
      expect(externalUrl).toBeUndefined()
    })
  })
}

describe('sqlite file database', () => {
  it('creates the parent directory, enables foreign keys and persists across opens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'urutau-db-'))
    try {
      const url = `sqlite:${join(dir, 'nested', 'urutau.db')}`
      const first = await openDatabase(url)
      await first.migrate()
      const id = (await first.db.selectFrom('meta').select('value').where('key', '=', 'instance_id').executeTakeFirstOrThrow()).value
      await expect(
        first.db.insertInto('sessions').values({
          id_hash: 'x', user_id: 'missing', auth_method: 'local', csrf_token: 'c', created_at: 'a', last_seen_at: 'a', expires_at: 'b',
        }).execute(),
      ).rejects.toThrow()
      await first.close()
      const second = await openDatabase(url)
      await second.migrate()
      const again = (await second.db.selectFrom('meta').select('value').where('key', '=', 'instance_id').executeTakeFirstOrThrow()).value
      await second.close()
      expect(again).toBe(id)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
