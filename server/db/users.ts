import type { Selectable, Kysely } from 'kysely'
import { insertIgnoringDuplicate, iso } from './helpers.ts'
import type { Tables, UsersTable } from './schema.ts'

export type UserRow = Selectable<UsersTable>

export interface NewAccount {
  username: string
  displayName: string | null
  passwordHash: string | null
  now: Date
}

export type CreateAccountResult =
  | { created: true; user: UserRow }
  /** `onlyIfFirst` was set and the instance already has its first account. */
  | { created: false }

/** First run is true exactly when no account has ever been created; deleting users does not reopen it. */
export async function isFirstRun(db: Kysely<Tables>): Promise<boolean> {
  const row = await db.selectFrom('instance_claim').select('id').where('id', '=', 1).limit(1).executeTakeFirst()
  return row === undefined
}

/**
 * Creates an account in one transaction (or inside the one `db` already is). The account that claims the instance
 * (the insert of instance_claim row 1 succeeds) becomes the admin; every later
 * one is a regular user. With `onlyIfFirst`, a call that did not claim the
 * instance creates nothing. A taken username raises a unique violation and the
 * transaction rolls back, claim included; the caller maps it with
 * `isUniqueViolation`.
 */
export async function createAccount(
  db: Kysely<Tables>,
  account: NewAccount,
  options: { onlyIfFirst?: boolean } = {},
): Promise<CreateAccountResult> {
  const run = async (trx: Kysely<Tables>): Promise<CreateAccountResult> => {
    const id = crypto.randomUUID()
    const createdAt = iso(account.now)
    const claimed = await insertIgnoringDuplicate(trx, 'instance_claim', { id: 1, user_id: id, claimed_at: createdAt })
    if (options.onlyIfFirst && !claimed) return { created: false } as const
    const user: UserRow = {
      id,
      username: account.username,
      username_key: account.username.toLowerCase(),
      display_name: account.displayName,
      password_hash: account.passwordHash,
      is_admin: claimed ? 1 : 0,
      created_at: createdAt,
    }
    await trx.insertInto('users').values(user).execute()
    return { created: true, user } as const
  }
  // Inside the caller's transaction, join it: Kysely cannot nest one.
  return db.isTransaction ? run(db) : db.transaction().execute(run)
}

export async function getUserById(db: Kysely<Tables>, id: string): Promise<UserRow | null> {
  return (await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()) ?? null
}

/** Looks an account up by username, ignoring case. */
export async function getUserByUsername(db: Kysely<Tables>, username: string): Promise<UserRow | null> {
  const row = await db.selectFrom('users').selectAll().where('username_key', '=', username.toLowerCase()).executeTakeFirst()
  return row ?? null
}

export async function listUsers(db: Kysely<Tables>): Promise<UserRow[]> {
  return db.selectFrom('users').selectAll().orderBy('created_at', 'asc').orderBy('id', 'asc').execute()
}

/** Deletes the account; its sessions and identities go with it. Returns whether a row was removed. */
export async function deleteUser(db: Kysely<Tables>, id: string): Promise<boolean> {
  const result = await db.deleteFrom('users').where('id', '=', id).executeTakeFirst()
  return result.numDeletedRows === 1n
}
