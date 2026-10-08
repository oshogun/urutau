import { Migrator } from 'kysely/migration'
import { afterEach, describe, expect, test } from 'vitest'
import { fixtureBoard } from '../fixtures.ts'
import { createBoard } from '../boards.ts'
import { openDatabase, type Database } from '../index.ts'
import { createSession } from '../sessions.ts'
import { getGithubWrites, setGithubWrites } from '../settings.ts'
import { createIntegration } from '../integrations.ts'
import { createAccount } from '../users.ts'
import { up as m0001 } from './0001_initial.ts'
import { up as m0002 } from './0002_github_writes.ts'
import { up as m0003 } from './0003_integrations.ts'

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
    // Kysely refuses a gap in the executed list, so the later migration's row goes too.
    await database.db.deleteFrom('kysely_migration' as never).where('name' as never, 'in', ['0002_github_writes', '0003_integrations', '0004_card_runs'] as never).execute()
    await database.migrate()
    expect(await getGithubWrites(database.db)).toBe(true)
  })
})

describe('migration 0003_integrations', () => {
  const tables = ['integrations', 'api_tokens', 'github_tokens', 'integration_repos'] as const

  test('rows written at 0002 survive and the new tables start empty', async () => {
    database = await openDatabase('sqlite::memory:')
    const upTo0002 = new Migrator({
      db: database.db,
      provider: {
        getMigrations: async () => ({
          '0001_initial': { up: (db) => m0001(db, 'sqlite') },
          '0002_github_writes': { up: (db) => m0002(db) },
        }),
      },
    })
    expect((await upTo0002.migrateToLatest()).error).toBeUndefined()
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
    await setGithubWrites(database.db, true)

    await database.migrate()

    expect(await database.db.selectFrom('users').select('username').execute()).toEqual([{ username: 'ada' }])
    expect(await database.db.selectFrom('sessions').select('id_hash').execute()).toHaveLength(1)
    expect(await database.db.selectFrom('boards').select(['repo_key', 'updated_by']).execute()).toEqual([
      { repo_key: 'acme/widgets', updated_by: created.user.id },
    ])
    expect(await getGithubWrites(database.db)).toBe(true)
    for (const table of tables) expect(await database.db.selectFrom(table).selectAll().execute()).toEqual([])
  })

  test('running again after its kysely_migration row was deleted succeeds and keeps the rows', async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    const admin = await createAccount(database.db, { username: 'ada', displayName: null, passwordHash: null, now: NOW })
    if (!admin.created) throw new Error('account not created')
    const bot = await createIntegration(database.db, { username: 'bot', createdBy: admin.user.id, now: NOW })
    // Kysely refuses a gap in the executed list, so the later migration's row goes too.
    await database.db.deleteFrom('kysely_migration' as never).where('name' as never, 'in', ['0003_integrations', '0004_card_runs'] as never).execute()
    await database.migrate()
    expect(await database.db.selectFrom('integrations').select('user_id').execute()).toEqual([{ user_id: bot.id }])
    expect(await database.db.selectFrom('kysely_migration' as never).select('name' as never).where('name' as never, '=', '0003_integrations' as never).execute()).toHaveLength(1)
  })
})

describe('migration 0004_card_runs', () => {
  const tables = ['card_runs', 'card_claims', 'run_events'] as const

  test('rows written by 0001 to 0003 survive and the new tables start empty', async () => {
    database = await openDatabase('sqlite::memory:')
    const upTo0003 = new Migrator({
      db: database.db,
      provider: {
        getMigrations: async () => ({
          '0001_initial': { up: (db) => m0001(db, 'sqlite') },
          '0002_github_writes': { up: (db) => m0002(db) },
          '0003_integrations': { up: (db) => m0003(db, 'sqlite') },
        }),
      },
    })
    expect((await upTo0003.migrateToLatest()).error).toBeUndefined()
    const admin = await createAccount(database.db, { username: 'ada', displayName: null, passwordHash: null, now: NOW })
    if (!admin.created) throw new Error('account not created')
    const bot = await createIntegration(database.db, { username: 'bot', createdBy: admin.user.id, now: NOW })
    await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: admin.user.id, now: NOW })
    await database.db
      .insertInto('api_tokens')
      .values({ id: 'tok-1', user_id: bot.id, token_hash: 'a'.repeat(64), label: 'ci', created_by: admin.user.id, created_at: NOW.toISOString(), expires_at: null, last_used_at: null })
      .execute()
    await setGithubWrites(database.db, true)

    await database.migrate()

    expect(await database.db.selectFrom('users').select('username').orderBy('username').execute()).toEqual([{ username: 'ada' }, { username: 'bot' }])
    expect(await database.db.selectFrom('integrations').select('user_id').execute()).toEqual([{ user_id: bot.id }])
    expect(await database.db.selectFrom('api_tokens').select('id').execute()).toEqual([{ id: 'tok-1' }])
    expect(await database.db.selectFrom('boards').select(['repo_key', 'version']).execute()).toEqual([{ repo_key: 'acme/widgets', version: 1 }])
    expect(await getGithubWrites(database.db)).toBe(true)
    for (const table of tables) expect(await database.db.selectFrom(table).selectAll().execute()).toEqual([])
  })

  test('running again after its kysely_migration row was deleted succeeds and keeps the rows', async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    const admin = await createAccount(database.db, { username: 'ada', displayName: null, passwordHash: null, now: NOW })
    if (!admin.created) throw new Error('account not created')
    const bot = await createIntegration(database.db, { username: 'bot', createdBy: admin.user.id, now: NOW })
    await database.db
      .insertInto('card_runs')
      .values({
        run_id: 'run-1', repo_key: 'acme/widgets', issue: 7, agent_user_id: bot.id, status: 'running', status_at: NOW.toISOString(),
        triage_range: null, uncertainty_kind: null, unverified: '[]', merge_shas: '[]', files: '[]', files_omitted: 0, areas: '[]',
        observed_by: null, fix_rounds: 0, cost_usd: null, findings: null, started_at: NOW.toISOString(), ended_at: null,
      })
      .execute()
    await database.db
      .insertInto('card_claims')
      .values({ repo_key: 'acme/widgets', issue: 7, run_id: 'run-1', holder: bot.id, lease_until: null, claimed_at: NOW.toISOString() })
      .execute()
    await database.db.deleteFrom('kysely_migration' as never).where('name' as never, '=', '0004_card_runs' as never).execute()
    await database.migrate()
    expect(await database.db.selectFrom('card_runs').select('run_id').execute()).toEqual([{ run_id: 'run-1' }])
    expect(await database.db.selectFrom('card_claims').select('run_id').execute()).toEqual([{ run_id: 'run-1' }])
  })
})
