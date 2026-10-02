import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureBoard } from './fixtures.ts'
import { isUniqueViolation, type Database } from './index.ts'
import { createBoard, deleteBoard, getBoard, listBoards, saveBoard } from './boards.ts'
import { findUserByIdentity, linkIdentity } from './identities.ts'
import { createInvite, deleteInvite, getUsableInvite, listUsableInvites, markInviteUsed } from './invites.ts'
import { createSession, deleteExpiredSessions, getSession } from './sessions.ts'
import { createAccount, deleteUser, getUserById, getUserByUsername, isFirstRun, listUsers } from './users.ts'

const T0 = new Date('2026-01-01T00:00:00.000Z')
const later = (ms: number) => new Date(T0.getTime() + ms)

/** Empties every application table except `meta`, children before parents. */
async function resetData(database: Database): Promise<void> {
  const { db } = database
  for (const table of ['sessions', 'invites', 'identities', 'boards', 'instance_claim', 'users'] as const) {
    await db.deleteFrom(table).execute()
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
        expect(listed[0]?.updatedBy).toEqual({ id: user.user.id, username: 'ana' })
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

    async function seedAdmin() {
      const made = await account('seed')
      if (!made.created) throw new Error('account not created')
      return made.user
    }
  })
}
