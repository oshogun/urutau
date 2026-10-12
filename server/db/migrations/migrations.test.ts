import { afterEach, describe, expect, test } from 'vitest'
import { openDatabase, type Database } from '../index.ts'
import { getGithubWrites, setGithubWrites } from '../settings.ts'
import { createIntegration } from '../integrations.ts'
import { createAccount } from '../users.ts'

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
