import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureBoard } from './fixtures.ts'
import { isUniqueViolation, type Database } from './index.ts'
import { migrateTo } from './migrations/index.ts'
import { createApiToken, deleteApiToken, deleteExpiredApiTokens, findLiveToken, listApiTokens, touchApiToken, apiTokenIsLive } from './apiTokens.ts'
import { createBoard, deleteBoard, getBoard, listBoards, listBoardsByKeys, saveBoard } from './boards.ts'
import { deleteGithubToken, getGithubToken, listGithubTokenInfo, putGithubToken, setGithubTokenStatus } from './githubTokens.ts'
import { createIntegration, deleteIntegration, isIntegration, listIntegrations, setIntegrationPermissions } from './integrations.ts'
import { listAllIntegrationRepos, listIntegrationRepos, setIntegrationRepos } from './integrationRepos.ts'
import { findUserByIdentity, linkIdentity } from './identities.ts'
import { createInvite, deleteInvite, getUsableInvite, listUsableInvites, markInviteUsed } from './invites.ts'
import { GITHUB_WRITE_KINDS } from '../../src/domain/api.ts'
import { getGithubWrites, setGithubWrite } from './settings.ts'
import { createRunStore } from '../runs/store.ts'
import type { RecordRunInput } from '../runs/types.ts'
import { createSession, deleteExpiredSessions, getSession, getSessionWithUser } from './sessions.ts'
import { createAccount, deleteUser, getUserById, getUserByUsername, isFirstRun, listUsers } from './users.ts'

const T0 = new Date('2026-01-01T00:00:00.000Z')
const later = (ms: number) => new Date(T0.getTime() + ms)

/** True for a foreign-key violation: SQLite errcode 787, PostgreSQL code 23503, MariaDB errno 1452 (ER_NO_REFERENCED_ROW_2). */
function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { code?: unknown; errno?: unknown; errcode?: unknown }
  return e.errcode === 787 || e.code === '23503' || e.errno === 1452
}

/**
 * Every application table except `meta`, children before parents. A new
 * migration's tables go here too, so resetData empties them and dropSchema
 * drops them.
 */
const TABLES = ['run_events', 'card_claims', 'card_runs', 'integration_repos', 'api_tokens', 'github_tokens', 'integrations', 'sessions', 'invites', 'identities', 'boards', 'instance_claim', 'users'] as const

/** Empties every application table except `meta`, children before parents, and turns every GitHub writes switch off. */
async function resetData(database: Database): Promise<void> {
  const { db } = database
  for (const table of TABLES) {
    await db.deleteFrom(table).execute()
  }
  for (const kind of GITHUB_WRITE_KINDS) {
    await setGithubWrite(db, kind, false)
  }
}

/**
 * Drops every table, including Kysely's own, so the next migration starts from
 * an empty database. Not in a transaction: MariaDB commits each DROP TABLE on
 * its own.
 */
async function dropSchema(database: Database): Promise<void> {
  for (const table of [...TABLES, 'meta', 'kysely_migration', 'kysely_migration_lock']) {
    await database.db.schema.dropTable(table).ifExists().execute()
  }
}

/**
 * The connector tests, run against whichever backend `open` returns. The same
 * suite runs on in-memory SQLite always, and on PostgreSQL or MariaDB when a
 * test database URL is supplied.
 */
export function connectorSuite(name: string, open: () => Promise<Database>): void {
  describe(`database connector (${name})`, () => {
    let database: Database

    // Leave a shared server database empty for whoever runs next.
    afterAll(async () => {
      const last = await open()
      try {
        await last.migrate()
        await resetData(last)
      } finally {
        await last.close()
      }
    })

    beforeEach(async () => {
      database = await open()
      await database.migrate()
      await resetData(database)
    })
    afterEach(async () => {
      await database.close()
    })

    async function account(username: string, options: { onlyIfFirst?: boolean } = {}) {
      return createAccount(database.db, { username, displayName: null, passwordHash: null, now: T0 }, options)
    }

    describe('migrations', () => {
      it('apply twice without error and keep the instance id', async () => {
        const read = async () =>
          (await database.db.selectFrom('meta').select('value').where('key', '=', 'instance_id').executeTakeFirstOrThrow()).value
        const before = await read()
        await database.migrate()
        await database.migrate()
        expect(await read()).toBe(before)
        expect(before).toMatch(/^[0-9a-f-]{36}$/)
      })

      it('run 0003_integrations again after its row was deleted, keeping the data', async () => {
        const admin = await seedAdmin()
        const made = await createIntegration(database.db, { username: 'planner-bot', createdBy: admin.id, now: T0 })
        // Kysely refuses a gap in the executed list, so the later migration's row goes too.
        await database.db.deleteFrom('kysely_migration' as never).where('name' as never, 'in', ['0003_integrations', '0004_card_runs', '0005_github_write_kinds', '0006_integration_permissions'] as never).execute()
        await database.migrate()
        expect(await isIntegration(database.db, made.id)).toBe(true)
      })

      // Each case builds the database at one older migration, writes rows with
      // the app's helpers, then upgrades to the latest. A new migration adds its
      // own case here, built at the migration before it.
      async function seedSession(userId: string) {
        await createSession(database.db, {
          idHash: 'h'.repeat(64), userId, authMethod: 'local', csrfToken: 'c'.repeat(43), now: T0, expiresAt: later(60_000),
        })
      }

      async function metaValue(key: string) {
        return (await database.db.selectFrom('meta').select('value').where('key', '=', key).executeTakeFirst())?.value
      }

      /** Sets the single switch of 0002–0004 by its raw row, as the app then did. */
      async function turnOldSwitchOn(value = '1') {
        await database.db.updateTable('meta').set({ value }).where('key', '=', 'github_writes').execute()
      }

      it('rows written at 0001_initial survive the upgrade to latest', async () => {
        await dropSchema(database)
        await migrateTo(database.db, database.backend, '0001_initial')
        expect(await database.db.selectFrom('meta').select('key').where('key', '=', 'github_writes').executeTakeFirst()).toBeUndefined()
        const admin = await seedAdmin()
        await seedSession(admin.id)
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: admin.id, now: T0 })

        await database.migrate()

        expect(await metaValue('github_writes_create_issues')).toBe('0')
        expect(await metaValue('github_writes_edit_issues')).toBe('0')
        expect(await metaValue('github_writes')).toBeUndefined()
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: false, editIssues: false })
        expect(await database.db.selectFrom('users').select('username').execute()).toEqual([{ username: admin.username }])
        expect(await database.db.selectFrom('sessions').select('id_hash').execute()).toHaveLength(1)
        expect(await database.db.selectFrom('boards').select('repo_key').execute()).toEqual([{ repo_key: 'acme/widgets' }])
      })

      it('rows written at 0002_github_writes survive the upgrade to latest and the new tables start empty', async () => {
        await dropSchema(database)
        await migrateTo(database.db, database.backend, '0002_github_writes')
        const admin = await seedAdmin()
        await seedSession(admin.id)
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: admin.id, now: T0 })
        await turnOldSwitchOn()

        await database.migrate()

        expect(await database.db.selectFrom('users').select('username').execute()).toEqual([{ username: admin.username }])
        expect(await database.db.selectFrom('sessions').select('id_hash').execute()).toHaveLength(1)
        expect(await database.db.selectFrom('boards').select(['repo_key', 'updated_by']).execute()).toEqual([
          { repo_key: 'acme/widgets', updated_by: admin.id },
        ])
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: true, editIssues: true })
        for (const table of ['integrations', 'api_tokens', 'github_tokens', 'integration_repos'] as const) {
          expect(await database.db.selectFrom(table).selectAll().execute()).toEqual([])
        }
      })

      it('rows written at 0003_integrations survive the upgrade to latest and the new tables start empty', async () => {
        await dropSchema(database)
        await migrateTo(database.db, database.backend, '0003_integrations')
        const admin = await seedAdmin()
        const bot = await createIntegration(database.db, { username: 'bot', createdBy: admin.id, now: T0 })
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: admin.id, now: T0 })
        await database.db
          .insertInto('api_tokens')
          .values({ id: 'tok-1', user_id: bot.id, token_hash: 'a'.repeat(64), label: 'ci', created_by: admin.id, created_at: T0.toISOString(), expires_at: null, last_used_at: null })
          .execute()
        await turnOldSwitchOn()

        await database.migrate()

        expect(await database.db.selectFrom('users').select('username').orderBy('username').execute()).toEqual([{ username: 'bot' }, { username: admin.username }])
        expect(await database.db.selectFrom('integrations').select('user_id').execute()).toEqual([{ user_id: bot.id }])
        expect(await database.db.selectFrom('api_tokens').select('id').execute()).toEqual([{ id: 'tok-1' }])
        const boards = await database.db.selectFrom('boards').select(['repo_key', 'version']).execute()
        expect(boards.map((b) => ({ repo_key: b.repo_key, version: Number(b.version) }))).toEqual([{ repo_key: 'acme/widgets', version: 1 }])
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: true, editIssues: true })
        for (const table of ['card_runs', 'card_claims', 'run_events'] as const) {
          expect(await database.db.selectFrom(table).selectAll().execute()).toEqual([])
        }
      })

      it('rows written at 0004_card_runs survive the upgrade to latest and the new tables start empty', async () => {
        await dropSchema(database)
        await migrateTo(database.db, database.backend, '0004_card_runs')
        const admin = await seedAdmin()
        const bot = await createIntegration(database.db, { username: 'bot', createdBy: admin.id, now: T0 })
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: admin.id, now: T0 })
        await database.db
          .insertInto('api_tokens')
          .values({ id: 'tok-1', user_id: bot.id, token_hash: 'a'.repeat(64), label: 'ci', created_by: admin.id, created_at: T0.toISOString(), expires_at: null, last_used_at: null })
          .execute()
        await database.db
          .insertInto('card_runs')
          .values({
            run_id: 'run-1', repo_key: 'acme/widgets', issue: 7, agent_user_id: bot.id, status: 'running', status_at: T0.toISOString(),
            triage_range: null, uncertainty_kind: null, unverified: '[]', merge_shas: '[]', files: '[]', files_omitted: 0, areas: '[]',
            observed_by: null, fix_rounds: 0, cost_usd: null, findings: null, started_at: T0.toISOString(), ended_at: null,
          })
          .execute()
        await database.db
          .insertInto('card_claims')
          .values({ repo_key: 'acme/widgets', issue: 7, run_id: 'run-1', holder: bot.id, lease_until: null, claimed_at: T0.toISOString() })
          .execute()
        await turnOldSwitchOn()

        await database.migrate()

        expect(await database.db.selectFrom('users').select('username').orderBy('username').execute()).toEqual([{ username: 'bot' }, { username: admin.username }])
        expect(await database.db.selectFrom('integrations').select('user_id').execute()).toEqual([{ user_id: bot.id }])
        expect(await database.db.selectFrom('api_tokens').select('id').execute()).toEqual([{ id: 'tok-1' }])
        const boards = await database.db.selectFrom('boards').select(['repo_key', 'version']).execute()
        expect(boards.map((b) => ({ repo_key: b.repo_key, version: Number(b.version) }))).toEqual([{ repo_key: 'acme/widgets', version: 1 }])
        expect(await database.db.selectFrom('card_runs').select('run_id').execute()).toEqual([{ run_id: 'run-1' }])
        expect(await database.db.selectFrom('card_claims').select('run_id').execute()).toEqual([{ run_id: 'run-1' }])
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: true, editIssues: true })
        for (const table of ['run_events'] as const) {
          expect(await database.db.selectFrom(table).selectAll().execute()).toEqual([])
        }
      })

      it.each([
        ['1', true],
        ['0', false],
      ])('rows written at 0004_card_runs survive the upgrade to latest, and github_writes %s carries over to both kinds', async (old, on) => {
        await dropSchema(database)
        await migrateTo(database.db, database.backend, '0004_card_runs')
        const admin = await seedAdmin()
        await seedSession(admin.id)
        const bot = await createIntegration(database.db, { username: 'bot', createdBy: admin.id, now: T0 })
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: admin.id, now: T0 })
        await database.db
          .insertInto('card_runs')
          .values({
            run_id: 'run-1', repo_key: 'acme/widgets', issue: 7, agent_user_id: bot.id, status: 'running', status_at: T0.toISOString(),
            triage_range: null, uncertainty_kind: null, unverified: '[]', merge_shas: '[]', files: '[]', files_omitted: 0, areas: '[]',
            observed_by: null, fix_rounds: 0, cost_usd: null, findings: null, started_at: T0.toISOString(), ended_at: null,
          })
          .execute()
        await database.db
          .insertInto('card_claims')
          .values({ repo_key: 'acme/widgets', issue: 7, run_id: 'run-1', holder: bot.id, lease_until: null, claimed_at: T0.toISOString() })
          .execute()
        await turnOldSwitchOn(old)

        await database.migrate()

        expect(await database.db.selectFrom('users').select('username').orderBy('username').execute()).toEqual([{ username: 'bot' }, { username: admin.username }])
        expect(await database.db.selectFrom('sessions').select('id_hash').execute()).toHaveLength(1)
        expect(await database.db.selectFrom('integrations').select('user_id').execute()).toEqual([{ user_id: bot.id }])
        expect(await database.db.selectFrom('boards').select('repo_key').execute()).toEqual([{ repo_key: 'acme/widgets' }])
        expect(await database.db.selectFrom('card_runs').select('run_id').execute()).toEqual([{ run_id: 'run-1' }])
        expect(await database.db.selectFrom('card_claims').select('run_id').execute()).toEqual([{ run_id: 'run-1' }])
        expect(await metaValue('github_writes_create_issues')).toBe(old)
        expect(await metaValue('github_writes_edit_issues')).toBe(old)
        expect(await metaValue('github_writes')).toBeUndefined()
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: on, editIssues: on })
      })

      it('rows written at 0005_github_write_kinds survive the upgrade to latest, and existing integrations keep moving cards', async () => {
        await dropSchema(database)
        await migrateTo(database.db, database.backend, '0005_github_write_kinds')
        const admin = await seedAdmin()
        const made = await createIntegration(database.db, { username: 'bot', createdBy: admin.id, now: T0 })
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: admin.id, now: T0 })
        await database.db
          .insertInto('api_tokens')
          .values({ id: 'tok-1', user_id: made.id, token_hash: 'b'.repeat(64), label: 'ci', created_by: admin.id, created_at: T0.toISOString(), expires_at: null, last_used_at: null })
          .execute()

        await database.migrate()

        expect(await database.db.selectFrom('users').select('username').orderBy('username').execute()).toEqual([{ username: 'bot' }, { username: admin.username }])
        expect(await database.db.selectFrom('api_tokens').select('id').execute()).toEqual([{ id: 'tok-1' }])
        expect(await database.db.selectFrom('boards').select('repo_key').execute()).toEqual([{ repo_key: 'acme/widgets' }])
        expect((await listIntegrations(database.db)).map((i) => [i.id, i.move_cards])).toEqual([[made.id, 1]])
        expect(await findLiveToken(database.db, 'b'.repeat(64), T0)).toEqual({ id: 'tok-1', user_id: made.id, username: 'bot', last_used_at: null, move_cards: 1 })

        // A re-run after its kysely_migration row was deleted finds the column and keeps the stored permission.
        await setIntegrationPermissions(database.db, made.id, { moveCards: false })
        await database.db.deleteFrom('kysely_migration' as never).where('name' as never, '=', '0006_integration_permissions' as never).execute()
        await database.migrate()
        expect((await listIntegrations(database.db)).map((i) => [i.id, i.move_cards])).toEqual([[made.id, 0]])
      })
    })

    describe('github writes switch', () => {
      it('is off for every kind after migrate, and each kind round-trips on its own', async () => {
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: false, editIssues: false })
        await setGithubWrite(database.db, 'createIssues', true)
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: true, editIssues: false })
        await database.migrate()
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: true, editIssues: false })
        await setGithubWrite(database.db, 'editIssues', true)
        await setGithubWrite(database.db, 'createIssues', false)
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: false, editIssues: true })
        await database.migrate()
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: false, editIssues: true })
        await setGithubWrite(database.db, 'editIssues', false)
        expect(await getGithubWrites(database.db)).toEqual({ createIssues: false, editIssues: false })
      })
    })

    describe('boards', () => {
      it('creates at version 1 and refuses a duplicate without raising', async () => {
        const board = fixtureBoard()
        expect(await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: board, userId: null, now: T0 })).toBe(true)
        expect(await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Other', config: board, userId: null, now: T0 })).toBe(false)
        const stored = await getBoard(database.db, 'acme/widgets')
        expect(stored).toMatchObject({ repoKey: 'acme/widgets', fullName: 'Acme/Widgets', version: 1, updatedAt: T0.toISOString(), updatedBy: null })
        expect(stored?.board).toEqual(board)
      })

      it('raises a foreign-key error, not a duplicate, for an author that does not exist', async () => {
        await expect(
          createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: 'no-such-user', now: T0 }),
        ).rejects.toThrow()
        expect(await getBoard(database.db, 'acme/widgets')).toBeNull()
      })

      it('saves with the current version and increments it', async () => {
        const user = await account('ana')
        if (!user.created) throw new Error('account not created')
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: null, now: T0 })
        const changed = fixtureBoard('Changed')
        const result = await saveBoard(database.db, {
          repoKey: 'acme/widgets', baseVersion: 1, fullName: 'acme/Widgets', config: changed, userId: user.user.id, now: later(1000),
        })
        expect(result).toEqual({ saved: true, version: 2 })
        const stored = await getBoard(database.db, 'acme/widgets')
        expect(stored).toMatchObject({
          version: 2, fullName: 'acme/Widgets', updatedAt: later(1000).toISOString(), updatedBy: { id: user.user.id, username: 'ana' },
        })
        expect(stored?.board).toEqual(changed)
      })

      it('refuses a save from an old version and leaves the row unchanged', async () => {
        const original = fixtureBoard()
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: original, userId: null, now: T0 })
        await saveBoard(database.db, { repoKey: 'acme/widgets', baseVersion: 1, fullName: 'Acme/Widgets', config: fixtureBoard('Second'), userId: null, now: later(1000) })
        const before = await getBoard(database.db, 'acme/widgets')

        const stale = await saveBoard(database.db, {
          repoKey: 'acme/widgets', baseVersion: 1, fullName: 'Stale/Name', config: fixtureBoard('Stale'), userId: null, now: later(2000),
        })
        expect(stale).toEqual({ saved: false })
        expect(await getBoard(database.db, 'acme/widgets')).toEqual(before)
        expect(before?.version).toBe(2)
      })

      it('lets exactly one of two concurrent saves from the same version win', async () => {
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: null, now: T0 })
        const attempt = (title: string) =>
          saveBoard(database.db, { repoKey: 'acme/widgets', baseVersion: 1, fullName: 'Acme/Widgets', config: fixtureBoard(title), userId: null, now: later(1000) })
        const results = await Promise.all([attempt('A'), attempt('B')])
        expect(results.filter((r) => r.saved)).toHaveLength(1)
        expect((await getBoard(database.db, 'acme/widgets'))?.version).toBe(2)
      })

      it('treats a base version beyond the integer column range as stale, not as a database error', async () => {
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: null, now: T0 })
        for (const baseVersion of [2 ** 31, 2 ** 53 - 1]) {
          expect(await saveBoard(database.db, { repoKey: 'acme/widgets', baseVersion, fullName: 'Acme/Widgets', config: fixtureBoard('X'), userId: null, now: T0 })).toEqual({ saved: false })
          expect(await deleteBoard(database.db, 'acme/widgets', baseVersion)).toBe(false)
        }
        expect((await getBoard(database.db, 'acme/widgets'))?.version).toBe(1)
      })

      it('refuses a save for a board that does not exist', async () => {
        expect(await saveBoard(database.db, { repoKey: 'nope/nope', baseVersion: 1, fullName: 'nope/nope', config: fixtureBoard(), userId: null, now: T0 })).toEqual({ saved: false })
      })

      it('deletes only at the current version', async () => {
        await createBoard(database.db, { repoKey: 'acme/widgets', fullName: 'Acme/Widgets', config: fixtureBoard(), userId: null, now: T0 })
        expect(await deleteBoard(database.db, 'acme/widgets', 7)).toBe(false)
        expect(await getBoard(database.db, 'acme/widgets')).not.toBeNull()
        expect(await deleteBoard(database.db, 'acme/widgets', 1)).toBe(true)
        expect(await getBoard(database.db, 'acme/widgets')).toBeNull()
      })

      it('lists newest first with the author, and clears the author when the user is removed', async () => {
        const user = await account('ana')
        if (!user.created) throw new Error('account not created')
        await createBoard(database.db, { repoKey: 'a/old', fullName: 'a/old', config: fixtureBoard(), userId: null, now: T0 })
        await createBoard(database.db, { repoKey: 'a/new', fullName: 'a/new', config: fixtureBoard(), userId: user.user.id, now: later(5000) })
        const listed = await listBoards(database.db)
        expect(listed.map((b) => b.repoKey)).toEqual(['a/new', 'a/old'])
        expect(listed[0]?.updatedBy).toEqual({ id: user.user.id, username: 'ana', kind: 'person' })
        expect(listed[1]?.updatedBy).toBeNull()

        await deleteUser(database.db, user.user.id)
        expect((await getBoard(database.db, 'a/new'))?.updatedBy).toBeNull()
      })
    })

    describe('accounts', () => {
      it('makes exactly one admin when first accounts are created concurrently', async () => {
        const results = await Promise.all(['ana', 'bea', 'cid', 'dan', 'eva', 'fay', 'gus', 'hal'].map((n) => account(n)))
        const created = results.flatMap((r) => (r.created ? [r.user] : []))
        expect(created).toHaveLength(8)
        expect(created.filter((u) => u.is_admin === 1)).toHaveLength(1)
        expect((await listUsers(database.db)).filter((u) => u.is_admin === 1)).toHaveLength(1)
      })

      it('creates nothing for the losers of a concurrent first-run claim', async () => {
        const results = await Promise.all([account('ana', { onlyIfFirst: true }), account('bea', { onlyIfFirst: true })])
        expect(results.filter((r) => r.created)).toHaveLength(1)
        expect(await listUsers(database.db)).toHaveLength(1)
        expect((await listUsers(database.db))[0]?.is_admin).toBe(1)
      })

      it('reports first run until the first account exists and never reopens it', async () => {
        expect(await isFirstRun(database.db)).toBe(true)
        const first = await account('ana')
        expect(await isFirstRun(database.db)).toBe(false)
        if (!first.created) throw new Error('account not created')
        await deleteUser(database.db, first.user.id)
        expect(await listUsers(database.db)).toEqual([])
        expect(await isFirstRun(database.db)).toBe(false)
        const next = await account('bea', { onlyIfFirst: true })
        expect(next).toEqual({ created: false })
      })

      it('refuses a username taken ignoring case with a unique violation and keeps the claim intact', async () => {
        await account('Ana')
        await expect(account('ANA')).rejects.toSatisfy(isUniqueViolation)
        expect(await listUsers(database.db)).toHaveLength(1)
        const second = await account('bea')
        expect(second.created && second.user.is_admin).toBe(0)
      })

      it('rolls the claim back when the first account fails on a taken username', async () => {
        const first = await account('ana')
        if (!first.created) throw new Error('account not created')
        await database.db.deleteFrom('instance_claim').execute()
        await expect(account('Ana')).rejects.toSatisfy(isUniqueViolation)
        expect(await isFirstRun(database.db)).toBe(true)
      })

      it('finds accounts by id and by username ignoring case', async () => {
        const made = await createAccount(database.db, { username: 'Ana', displayName: 'Ana B', passwordHash: 'h'.repeat(60), now: T0 })
        if (!made.created) throw new Error('account not created')
        expect(await getUserByUsername(database.db, 'aNA')).toEqual(made.user)
        expect(await getUserById(database.db, made.user.id)).toEqual(made.user)
        expect(await getUserByUsername(database.db, 'nobody')).toBeNull()
        expect(made.user).toMatchObject({ username: 'Ana', username_key: 'ana', display_name: 'Ana B', is_admin: 1, created_at: T0.toISOString() })
      })
    })

    describe('sessions', () => {
      it('returns a live session, hides an expired one and cascades on user removal', async () => {
        const made = await account('ana')
        if (!made.created) throw new Error('account not created')
        const base = { userId: made.user.id, authMethod: 'local' as const, csrfToken: 'c'.repeat(43), now: T0 }
        await createSession(database.db, { ...base, idHash: 'a'.repeat(64), expiresAt: later(60_000) })
        await createSession(database.db, { ...base, idHash: 'b'.repeat(64), expiresAt: later(-60_000) })
        expect(await getSession(database.db, 'a'.repeat(64), T0)).toMatchObject({ user_id: made.user.id, auth_method: 'local' })
        expect(await getSession(database.db, 'b'.repeat(64), T0)).toBeNull()
        expect(await deleteExpiredSessions(database.db, T0)).toBe(1)
        await deleteUser(database.db, made.user.id)
        expect(await database.db.selectFrom('sessions').select('id_hash').execute()).toEqual([])
      })
    })

    describe('invites', () => {
      it('is usable once, only before it expires, and can be revoked', async () => {
        const made = await account('ana')
        if (!made.created) throw new Error('account not created')
        const invite = await createInvite(database.db, { tokenHash: 't'.repeat(64), createdBy: made.user.id, now: T0, expiresAt: later(3_600_000) })
        expect((await getUsableInvite(database.db, 't'.repeat(64), later(1000)))?.id).toBe(invite.id)
        expect(await getUsableInvite(database.db, 't'.repeat(64), later(3_600_001))).toBeNull()
        expect(await listUsableInvites(database.db, later(1000))).toHaveLength(1)

        const results = await Promise.all([
          markInviteUsed(database.db, 't'.repeat(64), made.user.id, later(1000)),
          markInviteUsed(database.db, 't'.repeat(64), made.user.id, later(1000)),
        ])
        expect(results.filter(Boolean)).toHaveLength(1)
        expect(await getUsableInvite(database.db, 't'.repeat(64), later(2000))).toBeNull()
        expect(await listUsableInvites(database.db, later(2000))).toEqual([])
        expect(await deleteInvite(database.db, invite.id)).toBe(true)
        expect(await deleteInvite(database.db, invite.id)).toBe(false)
      })

      it('cannot be marked used after it expired', async () => {
        const invite = await createInvite(database.db, { tokenHash: 'e'.repeat(64), createdBy: (await seedAdmin()).id, now: T0, expiresAt: later(1000) })
        expect(await markInviteUsed(database.db, 'e'.repeat(64), invite.created_by as string, later(2000))).toBe(false)
      })
    })

    describe('accepting an invite on one transaction', () => {
      const acceptOn = (tokenHash: string, username: string, at: Date) =>
        database.db.transaction().execute(async (trx) => {
          const made = await createAccount(trx, { username, displayName: null, passwordHash: null, now: at })
          if (!made.created) throw new Error('not created')
          if (!(await markInviteUsed(trx, tokenHash, made.user.id, at))) throw new Error('invite-invalid')
          return made.user
        })

      it('marks the invite used by the new user', async () => {
        const admin = await seedAdmin()
        await createInvite(database.db, { tokenHash: 'i'.repeat(64), createdBy: admin.id, now: T0, expiresAt: later(3_600_000) })
        const user = await acceptOn('i'.repeat(64), 'newbie', later(1000))
        const row = await database.db.selectFrom('invites').selectAll().where('token_hash', '=', 'i'.repeat(64)).executeTakeFirstOrThrow()
        expect(row).toMatchObject({ used_by: user.id, used_at: later(1000).toISOString() })
        expect(user.is_admin).toBe(0)
      })

      it('rolls the new account back for a used or expired invite', async () => {
        const admin = await seedAdmin()
        await createInvite(database.db, { tokenHash: 'u'.repeat(64), createdBy: admin.id, now: T0, expiresAt: later(3_600_000) })
        await createInvite(database.db, { tokenHash: 'x'.repeat(64), createdBy: admin.id, now: T0, expiresAt: later(1000) })
        await acceptOn('u'.repeat(64), 'first', later(1000))
        await expect(acceptOn('u'.repeat(64), 'second', later(2000))).rejects.toThrow('invite-invalid')
        await expect(acceptOn('x'.repeat(64), 'third', later(2000))).rejects.toThrow('invite-invalid')
        expect(await getUserByUsername(database.db, 'second')).toBeNull()
        expect(await getUserByUsername(database.db, 'third')).toBeNull()
      })
    })

    describe('createAccount inside an outer transaction', () => {
      it('joins the transaction and commits with it', async () => {
        const result = await database.db.transaction().execute((trx) =>
          createAccount(trx, { username: 'ana', displayName: null, passwordHash: null, now: T0 }),
        )
        expect(result.created && result.user.is_admin).toBe(1)
        expect(await listUsers(database.db)).toHaveLength(1)
      })

      it('leaves no user and no instance claim when the outer transaction throws afterwards', async () => {
        await expect(
          database.db.transaction().execute(async (trx) => {
            await createAccount(trx, { username: 'ana', displayName: null, passwordHash: null, now: T0 })
            throw new Error('abort')
          }),
        ).rejects.toThrow('abort')
        expect(await listUsers(database.db)).toEqual([])
        expect(await isFirstRun(database.db)).toBe(true)
      })
    })

    describe('identities', () => {
      it('raises a foreign-key error, not a duplicate, when the user does not exist', async () => {
        await expect(
          linkIdentity(database.db, { issuer: 'https://sso.example/realms/u', subject: 'sub-9', userId: 'no-such-user', now: T0 }),
        ).rejects.toThrow()
        expect(await findUserByIdentity(database.db, 'https://sso.example/realms/u', 'sub-9')).toBeNull()
      })

      it('links once and finds the account; removing the user removes the link', async () => {
        const user = await seedAdmin()
        const link = { issuer: 'https://sso.example/realms/u', subject: 'sub-1', userId: user.id, now: T0 }
        expect(await linkIdentity(database.db, link)).toBe(true)
        expect(await linkIdentity(database.db, link)).toBe(false)
        expect((await findUserByIdentity(database.db, link.issuer, link.subject))?.id).toBe(user.id)
        expect(await findUserByIdentity(database.db, link.issuer, 'sub-2')).toBeNull()
        await deleteUser(database.db, user.id)
        expect(await findUserByIdentity(database.db, link.issuer, link.subject)).toBeNull()
      })
    })

    describe('integrations', () => {
      const HASH = 'a'.repeat(64)

      async function bot(username = 'planner-bot') {
        const admin = await seedAdmin()
        return { admin, bot: await createIntegration(database.db, { username, createdBy: admin.id, now: T0 }) }
      }

      it('creates a non-admin account without a password and refuses a taken name in any case', async () => {
        const { admin, bot: made } = await bot('Planner-Bot')
        expect(made).toMatchObject({ is_admin: 0, password_hash: null, display_name: null })
        expect(await isIntegration(database.db, made.id)).toBe(true)
        expect(await isIntegration(database.db, admin.id)).toBe(false)
        await expect(createIntegration(database.db, { username: 'PLANNER-bot', createdBy: made.id, now: T0 })).rejects.toSatisfy(isUniqueViolation)
        expect(await listIntegrations(database.db)).toEqual([
          { id: made.id, username: 'Planner-Bot', created_at: T0.toISOString(), created_by: expect.any(String), created_by_username: 'seed', move_cards: 1 },
        ])
      })

      it('creates an integration with or without the move permission and changes only the permissions given', async () => {
        const { admin, bot: mover } = await bot()
        const reader = await createIntegration(database.db, { username: 'reader-bot', createdBy: admin.id, now: T0, moveCards: false })
        // Both share created_at, so listIntegrations orders them by their random ids.
        const moves = async () => (await listIntegrations(database.db)).map((i) => [i.username, i.move_cards]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        expect(await moves()).toEqual([['planner-bot', 1], ['reader-bot', 0]])
        expect(await setIntegrationPermissions(database.db, mover.id, { moveCards: false })).toBe(true)
        expect(await setIntegrationPermissions(database.db, mover.id, { moveCards: false })).toBe(true)
        expect(await setIntegrationPermissions(database.db, reader.id, {})).toBe(true)
        expect(await moves()).toEqual([['planner-bot', 0], ['reader-bot', 0]])
        expect(await setIntegrationPermissions(database.db, reader.id, { moveCards: true })).toBe(true)
        expect(await moves()).toEqual([['planner-bot', 0], ['reader-bot', 1]])
        expect(await setIntegrationPermissions(database.db, admin.id, { moveCards: true })).toBe(false)
        expect(await setIntegrationPermissions(database.db, 'missing', {})).toBe(false)
      })

      it('leaves integrations out of the people list', async () => {
        const { admin } = await bot()
        expect((await listUsers(database.db)).map((u) => u.id)).toEqual([admin.id])
      })

      it('reports the editor kind on board summaries', async () => {
        const { admin, bot: made } = await bot()
        await createBoard(database.db, { repoKey: 'a/person', fullName: 'a/person', config: fixtureBoard(), userId: admin.id, now: later(1000) })
        await createBoard(database.db, { repoKey: 'a/agent', fullName: 'a/agent', config: fixtureBoard(), userId: made.id, now: later(2000) })
        await createBoard(database.db, { repoKey: 'a/none', fullName: 'a/none', config: fixtureBoard(), userId: null, now: later(3000) })
        expect((await getBoard(database.db, 'a/agent'))?.updatedBy).toEqual({ id: made.id, username: 'planner-bot', kind: 'integration' })
        expect((await getBoard(database.db, 'a/person'))?.updatedBy).toEqual({ id: admin.id, username: 'seed', kind: 'person' })
        expect((await listBoards(database.db)).map((b) => [b.repoKey, b.updatedBy?.kind ?? null])).toEqual([
          ['a/none', null], ['a/agent', 'integration'], ['a/person', 'person'],
        ])
        const some = await listBoardsByKeys(database.db, ['a/person', 'a/agent', 'x/missing'])
        expect(some.map((b) => b.repoKey)).toEqual(['a/agent', 'a/person'])
        expect(await listBoardsByKeys(database.db, [])).toEqual([])
      })

      it('reads a session with its user and whether the user is an integration', async () => {
        const { admin, bot: made } = await bot()
        const base = { authMethod: 'local' as const, csrfToken: 'c'.repeat(43), now: T0, expiresAt: later(60_000) }
        await createSession(database.db, { ...base, idHash: 'p'.repeat(64), userId: admin.id })
        await createSession(database.db, { ...base, idHash: 'q'.repeat(64), userId: made.id })
        await createSession(database.db, { ...base, idHash: 'x'.repeat(64), userId: admin.id, expiresAt: later(-1) })
        const person = await getSessionWithUser(database.db, 'p'.repeat(64), T0)
        expect(person).toMatchObject({ integration: false, session: { user_id: admin.id }, user: { id: admin.id, username: 'seed' } })
        expect((await getSessionWithUser(database.db, 'q'.repeat(64), T0))?.integration).toBe(true)
        expect(await getSessionWithUser(database.db, 'x'.repeat(64), T0)).toBeNull()
        expect(await getSessionWithUser(database.db, 'n'.repeat(64), T0)).toBeNull()
      })

      it('creates and finds a token; a duplicate hash is a unique violation; an unknown owner is a foreign-key error', async () => {
        const { admin, bot: made } = await bot()
        const row = await createApiToken(database.db, { userId: made.id, tokenHash: HASH, label: 'laptop', createdBy: admin.id, now: T0, expiresAt: later(1000) })
        expect(await findLiveToken(database.db, HASH, T0)).toEqual({ id: row.id, user_id: made.id, username: 'planner-bot', last_used_at: null, move_cards: 1 })
        expect(await findLiveToken(database.db, HASH, later(1000))).toBeNull()
        expect(await apiTokenIsLive(database.db, row.id, T0)).toBe(true)
        expect(await apiTokenIsLive(database.db, row.id, later(1000))).toBe(false)
        await expect(
          createApiToken(database.db, { userId: made.id, tokenHash: HASH, label: 'again', createdBy: admin.id, now: T0, expiresAt: null }),
        ).rejects.toSatisfy(isUniqueViolation)
        // A person is not an integration: the foreign key to integrations refuses the row.
        await expect(
          createApiToken(database.db, { userId: admin.id, tokenHash: 'b'.repeat(64), label: 'person', createdBy: admin.id, now: T0, expiresAt: null }),
        ).rejects.toSatisfy(isForeignKeyViolation)
        expect(await listApiTokens(database.db, admin.id, T0)).toEqual([])
        expect(await listApiTokens(database.db, null, T0)).toHaveLength(1)
      })

      it('lists live tokens newest first, touches last_used_at at most hourly, revokes and purges', async () => {
        const { admin, bot: made } = await bot()
        const make = (hash: string, label: string, now: Date, expiresAt: Date | null) =>
          createApiToken(database.db, { userId: made.id, tokenHash: hash.repeat(64), label, createdBy: admin.id, now, expiresAt })
        const old = await make('1', 'old', T0, later(5000))
        const fresh = await make('2', 'fresh', later(1000), null)
        expect((await listApiTokens(database.db, made.id, T0)).map((t) => t.label)).toEqual(['fresh', 'old'])
        expect((await listApiTokens(database.db, made.id, later(5000))).map((t) => t.label)).toEqual(['fresh'])
        expect(await listApiTokens(database.db, admin.id, T0)).toEqual([])
        expect(JSON.stringify(await listApiTokens(database.db, null, T0))).not.toContain('token_hash')

        await touchApiToken(database.db, fresh.id, later(2000))
        await touchApiToken(database.db, fresh.id, later(3000))
        expect((await listApiTokens(database.db, made.id, T0)).find((t) => t.id === fresh.id)?.last_used_at).toBe(later(2000).toISOString())
        await touchApiToken(database.db, fresh.id, later(2000 + 3_600_001))
        expect((await listApiTokens(database.db, made.id, T0)).find((t) => t.id === fresh.id)?.last_used_at).toBe(later(2000 + 3_600_001).toISOString())

        expect(await deleteExpiredApiTokens(database.db, later(5000))).toBe(1)
        expect(await deleteApiToken(database.db, made.id, old.id)).toBe(false)
        expect(await deleteApiToken(database.db, admin.id, fresh.id)).toBe(false)
        expect(await deleteApiToken(database.db, made.id, fresh.id)).toBe(true)
        expect(await listApiTokens(database.db, null, T0)).toEqual([])
      })

      it('round-trips a 1024-character sealed value and replaces it with status unchecked', async () => {
        const { admin, bot: made } = await bot()
        const sealed = 'v1.' + 'x'.repeat(1021)
        expect(sealed).toHaveLength(1024)
        await putGithubToken(database.db, { userId: made.id, sealed, keyId: 'abcd1234', setBy: admin.id, now: T0 })
        expect(await getGithubToken(database.db, made.id)).toEqual({ sealed, key_id: 'abcd1234', status: 'unchecked', updated_at: T0.toISOString() })
        expect(await setGithubTokenStatus(database.db, made.id, 'other', 'ok')).toBe(false)
        expect(await setGithubTokenStatus(database.db, made.id, sealed, 'rejected')).toBe(true)
        expect((await getGithubToken(database.db, made.id))?.status).toBe('rejected')
        const replacement = 'v1.' + 'y'.repeat(20)
        await putGithubToken(database.db, { userId: made.id, sealed: replacement, keyId: 'abcd1234', setBy: admin.id, now: later(1000) })
        expect(await getGithubToken(database.db, made.id)).toMatchObject({ sealed: replacement, status: 'unchecked' })
        expect([...(await listGithubTokenInfo(database.db)).keys()]).toEqual([made.id])
        expect(JSON.stringify([...(await listGithubTokenInfo(database.db)).values()])).not.toContain('sealed')
        expect(await deleteGithubToken(database.db, made.id)).toBe(true)
        expect(await deleteGithubToken(database.db, made.id)).toBe(false)
      })

      it('round-trips repository lists and returns exactly the keys a replacement removed', async () => {
        const { bot: made } = await bot()
        expect(await setIntegrationRepos(database.db, made.id, ['b/two', 'a/one'])).toEqual([])
        expect(await listIntegrationRepos(database.db, made.id)).toEqual(['a/one', 'b/two'])
        expect(await setIntegrationRepos(database.db, made.id, ['a/one', 'b/two', 'c/three'])).toEqual([])
        expect(await setIntegrationRepos(database.db, made.id, ['c/three', 'd/four'])).toEqual(['a/one', 'b/two'])
        expect(await listAllIntegrationRepos(database.db)).toEqual(new Map([[made.id, ['c/three', 'd/four']]]))
        expect(await setIntegrationRepos(database.db, made.id, [])).toEqual(['c/three', 'd/four'])
        expect(await listIntegrationRepos(database.db, made.id)).toEqual([])
      })

      it('deleting an integration removes its tokens, GitHub token and repositories, and keeps boards it saved', async () => {
        const { admin, bot: made } = await bot()
        const other = await createIntegration(database.db, { username: 'other-bot', createdBy: admin.id, now: T0 })
        await createApiToken(database.db, { userId: made.id, tokenHash: HASH, label: 'laptop', createdBy: admin.id, now: T0, expiresAt: null })
        await putGithubToken(database.db, { userId: made.id, sealed: 'v1.s', keyId: 'abcd1234', setBy: admin.id, now: T0 })
        await setIntegrationRepos(database.db, made.id, ['a/one'])
        await setIntegrationRepos(database.db, other.id, ['a/one'])
        await createBoard(database.db, { repoKey: 'a/one', fullName: 'a/one', config: fixtureBoard(), userId: made.id, now: T0 })

        expect(await deleteIntegration(database.db, admin.id)).toBe(false)
        expect(await deleteIntegration(database.db, made.id)).toBe(true)
        expect(await deleteIntegration(database.db, made.id)).toBe(false)
        for (const table of ['integrations', 'api_tokens', 'github_tokens', 'integration_repos'] as const) {
          const rows = await database.db.selectFrom(table).select('user_id').execute()
          expect(rows.every((row) => row.user_id !== made.id)).toBe(true)
        }
        expect(await listIntegrationRepos(database.db, other.id)).toEqual(['a/one'])
        expect(await getUserById(database.db, made.id)).toBeNull()
        expect((await getBoard(database.db, 'a/one'))?.updatedBy).toBeNull()
      })
    })

    describe('agent runs', () => {
      async function twoBots() {
        const admin = await seedAdmin()
        const a = await createIntegration(database.db, { username: 'bot-a', createdBy: admin.id, now: T0 })
        const b = await createIntegration(database.db, { username: 'bot-b', createdBy: admin.id, now: T0 })
        return { admin, a, b }
      }
      const call = (agentUserId: string, runId: string, issue: number, extra: Partial<RecordRunInput> = {}): RecordRunInput => ({
        repoKey: 'acme/widgets',
        issue,
        runId,
        agentUserId,
        status: 'running',
        ...extra,
      })

      it('gives exactly one claim to two concurrent claim attempts on one issue, and the loser leaves no run row', async () => {
        const { a, b } = await twoBots()
        const runs = createRunStore(database.db)
        const results = await Promise.allSettled([runs.recordRun(call(a.id, 'run-a', 7), T0), runs.recordRun(call(b.id, 'run-b', 7), T0)])
        const won = results.filter((r) => r.status === 'fulfilled')
        const lost = results.filter((r) => r.status === 'rejected')
        expect(won).toHaveLength(1)
        expect(lost).toHaveLength(1)
        expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'claimed-by-other-run' })
        const claims = await database.db.selectFrom('card_claims').select(['run_id', 'holder']).execute()
        expect(claims).toHaveLength(1)
        const runRows = await database.db.selectFrom('card_runs').select('run_id').execute()
        expect(runRows).toEqual([{ run_id: claims[0].run_id }])
      })

      it('lets two concurrent first calls of different runs on different issues both succeed', async () => {
        const { a, b } = await twoBots()
        const runs = createRunStore(database.db)
        const results = await Promise.all([runs.recordRun(call(a.id, 'run-a', 7), T0), runs.recordRun(call(b.id, 'run-b', 8), T0)])
        expect(results.map((r) => r.claim.held)).toEqual([true, true])
        expect(await database.db.selectFrom('card_claims').select('issue').orderBy('issue').execute()).toEqual([{ issue: 7 }, { issue: 8 }])
      })

      it('lets two concurrent first calls of one run both succeed with one run row and one claim', async () => {
        const { a } = await twoBots()
        const runs = createRunStore(database.db)
        const results = await Promise.all([runs.recordRun(call(a.id, 'run-a', 7), T0), runs.recordRun(call(a.id, 'run-a', 7), T0)])
        expect(results.filter((r) => r.created)).toHaveLength(1)
        expect(await database.db.selectFrom('card_runs').select('run_id').execute()).toEqual([{ run_id: 'run-a' }])
        expect(await database.db.selectFrom('card_claims').select('run_id').execute()).toEqual([{ run_id: 'run-a' }])
      })

      it('inserts nothing for a second resolution of one item', async () => {
        const { a } = await twoBots()
        const runs = createRunStore(database.db)
        const items = [{ id: 'U1', kind: 'external' as const, text: 'GitHub sends the header on 403.' }]
        const first = await runs.recordRun(call(a.id, 'run-a', 7, { unverified: items, probes: [{ item: 'U1', note: null }] }), T0)
        const second = await runs.recordRun(call(a.id, 'run-a', 7, { probes: [{ item: 'U1', note: 'again' }] }), later(1000))
        expect([first.probesApplied, second.probesApplied, second.probesSkipped]).toEqual([1, 0, 1])
        expect(await database.db.selectFrom('run_events').select(['kind', 'resolves']).execute()).toEqual([{ kind: 'probe', resolves: 'U1' }])
      })

      it('deletes the claim with its holder and keeps the run and event rows', async () => {
        const { a } = await twoBots()
        const runs = createRunStore(database.db)
        const items = [{ id: 'U1', kind: 'external' as const, text: 'GitHub sends the header on 403.' }]
        await runs.recordRun(call(a.id, 'run-a', 7, { unverified: items, probes: [{ item: 'U1', note: null }] }), T0)
        expect(await database.db.selectFrom('card_claims').select('run_id').execute()).toHaveLength(1)
        expect(await deleteIntegration(database.db, a.id)).toBe(true)
        expect(await database.db.selectFrom('card_claims').select('run_id').execute()).toEqual([])
        expect(await database.db.selectFrom('card_runs').select('run_id').execute()).toEqual([{ run_id: 'run-a' }])
        expect(await database.db.selectFrom('run_events').select('run_id').execute()).toEqual([{ run_id: 'run-a' }])
      })
    })

    async function seedAdmin() {
      const made = await account('seed')
      if (!made.created) throw new Error('account not created')
      return made.user
    }
  })
}
