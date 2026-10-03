import type { Kysely } from 'kysely'
import { iso } from './helpers.ts'
import type { Tables } from './schema.ts'
import type { UserRow } from './users.ts'

export interface NewIntegration {
  username: string
  /** The admin's user id. */
  createdBy: string
  now: Date
}

export interface IntegrationRow {
  id: string
  username: string
  created_at: string
  created_by: string | null
  /** The creator's username; null when that account was removed. */
  created_by_username: string | null
}

/**
 * Inserts the users row (no password, never admin) and the integrations row in
 * one transaction, or inside the one `db` already is. A taken username throws a
 * unique violation and nothing is kept.
 */
export async function createIntegration(db: Kysely<Tables>, integration: NewIntegration): Promise<UserRow> {
  const run = async (trx: Kysely<Tables>): Promise<UserRow> => {
    const createdAt = iso(integration.now)
    const user: UserRow = {
      id: crypto.randomUUID(),
      username: integration.username,
      username_key: integration.username.toLowerCase(),
      display_name: null,
      password_hash: null,
      is_admin: 0,
      created_at: createdAt,
    }
    await trx.insertInto('users').values(user).execute()
    await trx.insertInto('integrations').values({ user_id: user.id, created_by: integration.createdBy, created_at: createdAt }).execute()
    return user
  }
  return db.isTransaction ? run(db) : db.transaction().execute(run)
}

export async function isIntegration(db: Kysely<Tables>, userId: string): Promise<boolean> {
  const row = await db.selectFrom('integrations').select('user_id').where('user_id', '=', userId).executeTakeFirst()
  return row !== undefined
}

/** Every integration, ordered by created_at then id. */
export async function listIntegrations(db: Kysely<Tables>): Promise<IntegrationRow[]> {
  return db
    .selectFrom('integrations')
    .innerJoin('users', 'users.id', 'integrations.user_id')
    .leftJoin('users as creator', 'creator.id', 'integrations.created_by')
    .select([
      'integrations.user_id as id',
      'users.username as username',
      'integrations.created_at as created_at',
      'integrations.created_by as created_by',
      'creator.username as created_by_username',
    ])
    .orderBy('integrations.created_at', 'asc')
    .orderBy('integrations.user_id', 'asc')
    .execute()
}

/** Deletes the integration's users row (cascades to its tokens, GitHub token and repositories); false when the id is not an integration. */
export async function deleteIntegration(db: Kysely<Tables>, userId: string): Promise<boolean> {
  const run = async (trx: Kysely<Tables>): Promise<boolean> => {
    if (!(await isIntegration(trx, userId))) return false
    const result = await trx.deleteFrom('users').where('id', '=', userId).executeTakeFirst()
    return result.numDeletedRows === 1n
  }
  return db.isTransaction ? run(db) : db.transaction().execute(run)
}
