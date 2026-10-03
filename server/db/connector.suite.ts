import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureBoard } from './fixtures.ts'
import { isUniqueViolation, type Database } from './index.ts'
import { createApiToken, deleteApiToken, deleteExpiredApiTokens, findLiveToken, listApiTokens, touchApiToken, apiTokenIsLive } from './apiTokens.ts'
import { createBoard, deleteBoard, getBoard, listBoards, listBoardsByKeys, saveBoard } from './boards.ts'
import { deleteGithubToken, getGithubToken, listGithubTokenInfo, putGithubToken, setGithubTokenStatus } from './githubTokens.ts'
import { createIntegration, deleteIntegration, isIntegration, listIntegrations } from './integrations.ts'
import { listAllIntegrationRepos, listIntegrationRepos, setIntegrationRepos } from './integrationRepos.ts'
import { findUserByIdentity, linkIdentity } from './identities.ts'
import { createInvite, deleteInvite, getUsableInvite, listUsableInvites, markInviteUsed } from './invites.ts'
import { getGithubWrites, setGithubWrites } from './settings.ts'
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

/** Empties every application table except `meta`, children before parents, and turns the GitHub writes switch off. */
async function resetData(database: Database): Promise<void> {
  const { db } = database
  for (const table of ['integration_repos', 'api_tokens', 'github_tokens', 'integrations', 'sessions', 'invites', 'identities', 'boards', 'instance_claim', 'users'] as const) {
    await db.deleteFrom(table).execute()
  }
  await setGithubWrites(db, false)
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
        await database.db.deleteFrom('kysely_migration' as never).where('name' as never, '=', '0003_integrations' as never).execute()
        await database.migrate()
        expect(await isIntegration(database.db, made.id)).toBe(true)
      })
    })

    describe('github writes switch', () => {
      it('is off after migrate and round-trips', async () => {
        const row = await database.db.selectFrom('meta').select('value').where('key', '=', 'github_writes').executeTakeFirstOrThrow()
        expect(row.value).toBe('0')
        expect(await getGithubWrites(database.db)).toBe(false)
        await setGithubWrites(database.db, true)
        expect(await getGithubWrites(database.db)).toBe(true)
        await database.migrate()
        expect(await getGithubWrites(database.db)).toBe(true)
        await setGithubWrites(database.db, false)
        expect(await getGithubWrites(database.db)).toBe(false)
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
          { id: made.id, username: 'Planner-Bot', created_at: T0.toISOString(), created_by: expect.any(String), created_by_username: 'seed' },
        ])
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
        expect(await findLiveToken(database.db, HASH, T0)).toEqual({ id: row.id, user_id: made.id, username: 'planner-bot', last_used_at: null })
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

    async function seedAdmin() {
      const made = await account('seed')
      if (!made.created) throw new Error('account not created')
      return made.user
    }
  })
}
