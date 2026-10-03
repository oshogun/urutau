import { Migrator } from 'kysely/migration'
import { afterEach, describe, expect, test } from 'vitest'
import { fixtureBoard } from '../fixtures.ts'
import { createBoard } from '../boards.ts'
import { openDatabase, type Database } from '../index.ts'
import { createSession } from '../sessions.ts'
import { getGithubWrites, setGithubWrites } from '../settings.ts'
import { createAccount } from '../users.ts'
import { up as m0001 } from './0001_initial.ts'

const NOW = new Date('2026-10-02T12:00:00.000Z')

let database: Database
afterEach(async () => {
  await database.close()
})

describe('migration 0002_github_writes', () => {
  test('a new database has the switch off', async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    expect(await getGithubWrites(database.db)).toBe(false)
  })

  test('a database at 0001 with rows keeps them and reads the switch off after upgrading', async () => {
    database = await openDatabase('sqlite::memory:')
    const only0001 = new Migrator({
      db: database.db,
      provider: { getMigrations: async () => ({ '0001_initial': { up: (db) => m0001(db, 'sqlite') } }) },
    })
    expect((await only0001.migrateToLatest()).error).toBeUndefined()
    expect(await database.db.selectFrom('meta').select('key').where('key', '=', 'github_writes').executeTakeFirst()).toBeUndefined()
    expect(await getGithubWrites(database.db)).toBe(false)

    const created = await createAccount(database.db, { username: 'ada', displayName: null, passwordHash: null, now: NOW })
    if (!created.created) throw new Error('account not created')
    await createSession(database.db, {
      idHash: 'h'.repeat(64),
      userId: created.user.id,
      authMethod: 'local',
      csrfToken: 'c'.repeat(43),
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    })
    await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: created.user.id, now: NOW })

    await database.migrate()

    expect(await getGithubWrites(database.db)).toBe(false)
    expect(await database.db.selectFrom('meta').select('value').where('key', '=', 'github_writes').executeTakeFirst()).toEqual({ value: '0' })
    expect(await database.db.selectFrom('users').select('username').execute()).toEqual([{ username: 'ada' }])
    expect(await database.db.selectFrom('sessions').select('id_hash').execute()).toHaveLength(1)
    expect(await database.db.selectFrom('boards').select('repo_key').execute()).toEqual([{ repo_key: 'acme/widgets' }])
  })

  test('a switch turned on stays on when migrate runs again', async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    await setGithubWrites(database.db, true)
    await database.migrate()
    expect(await getGithubWrites(database.db)).toBe(true)
  })

  test('the migration keeps an existing github_writes row', async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    await setGithubWrites(database.db, true)
    await database.db.deleteFrom('kysely_migration' as never).where('name' as never, '=', '0002_github_writes' as never).execute()
    await database.migrate()
    expect(await getGithubWrites(database.db)).toBe(true)
  })
})
