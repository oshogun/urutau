import { afterEach, describe, expect, test } from 'vitest'
import type { Kysely } from 'kysely'
import { openDatabase, type Database } from '../index.ts'
import { migrateTo } from './index.ts'
import { getGithubWrites, setGithubWrite } from '../settings.ts'
import { createIntegration } from '../integrations.ts'
import { createAccount } from '../users.ts'

const NOW = new Date('2026-10-02T12:00:00.000Z')

async function metaValue(key: string) {
  return (await database.db.selectFrom('meta').select('value').where('key', '=', key).executeTakeFirst())?.value
}

/** Forgets the named migrations so the next migrate runs them again. Kysely refuses a gap in the executed list, so later migrations go too. */
async function forget(names: string[]) {
  await database.db.deleteFrom('kysely_migration' as never).where('name' as never, 'in', names as never).execute()
}

let database: Database
afterEach(async () => {
  await database.close()
})

describe('migration 0002_github_writes', () => {
  // 0005 replaces the row 0002 adds, so these read and write it at 0002's own stage.
  test('adds the switch off', async () => {
    database = await openDatabase('sqlite::memory:')
    await migrateTo(database.db, database.backend, '0002_github_writes')
    expect(await metaValue('github_writes')).toBe('0')
  })

  test('keeps an existing github_writes row when it runs again', async () => {
    database = await openDatabase('sqlite::memory:')
    await migrateTo(database.db, database.backend, '0002_github_writes')
    await database.db.updateTable('meta').set({ value: '1' }).where('key', '=', 'github_writes').execute()
    await forget(['0002_github_writes'])
    await migrateTo(database.db, database.backend, '0002_github_writes')
    expect(await metaValue('github_writes')).toBe('1')
  })
})

describe('migration 0003_integrations', () => {
  test('running again after its kysely_migration row was deleted succeeds and keeps the rows', async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    const admin = await createAccount(database.db, { username: 'ada', displayName: null, passwordHash: null, now: NOW })
    if (!admin.created) throw new Error('account not created')
    const bot = await createIntegration(database.db, { username: 'bot', createdBy: admin.user.id, now: NOW })
    await forget(['0003_integrations', '0004_card_runs', '0005_github_write_kinds', '0006_integration_permissions'])
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
    await forget(['0004_card_runs', '0005_github_write_kinds', '0006_integration_permissions'])
    await database.migrate()
    expect(await database.db.selectFrom('card_runs').select('run_id').execute()).toEqual([{ run_id: 'run-1' }])
    expect(await database.db.selectFrom('card_claims').select('run_id').execute()).toEqual([{ run_id: 'run-1' }])
  })
})

describe('migration 0005_github_write_kinds', () => {
  test.each([
    ['1', { createIssues: true, editIssues: true }],
    ['0', { createIssues: false, editIssues: false }],
    [undefined, { createIssues: false, editIssues: false }],
  ])('carries github_writes %s over to both kinds and removes it', async (old, expected) => {
    database = await openDatabase('sqlite::memory:')
    await migrateTo(database.db, database.backend, '0004_card_runs')
    if (old === undefined) await database.db.deleteFrom('meta').where('key', '=', 'github_writes').execute()
    else await database.db.updateTable('meta').set({ value: old }).where('key', '=', 'github_writes').execute()
    await database.migrate()
    expect(await getGithubWrites(database.db)).toEqual(expected)
    expect(await metaValue('github_writes')).toBeUndefined()
  })

  test('running again after its kysely_migration row was deleted keeps each kind\'s value', async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    await setGithubWrite(database.db, 'createIssues', true)
    await forget(['0005_github_write_kinds', '0006_integration_permissions'])
    await database.migrate()
    expect(await getGithubWrites(database.db)).toEqual({ createIssues: true, editIssues: false })
    expect(await metaValue('github_writes')).toBeUndefined()
  })
})

describe('migration 0006_integration_permissions', () => {
  test('lets existing integrations move cards', async () => {
    database = await openDatabase('sqlite::memory:')
    await migrateTo(database.db, database.backend, '0005_github_write_kinds')
    const db = database.db as Kysely<any>
    await db.insertInto('users').values({ id: 'u-bot', username: 'bot', username_key: 'bot', display_name: null, password_hash: null, is_admin: 0, created_at: NOW.toISOString() }).execute()
    await db.insertInto('integrations').values({ user_id: 'u-bot', created_by: null, created_at: NOW.toISOString() }).execute()
    await database.migrate()
    expect(await database.db.selectFrom('integrations').select(['user_id', 'move_cards']).execute()).toEqual([{ user_id: 'u-bot', move_cards: 1 }])
  })

  test('running again after its kysely_migration row was deleted succeeds and adds no second column', async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    await forget(['0006_integration_permissions'])
    await database.migrate()
    const tables = await database.db.introspection.getTables()
    const columns = tables.find((t) => t.name === 'integrations')?.columns.filter((c) => c.name === 'move_cards')
    expect(columns).toHaveLength(1)
  })
})
