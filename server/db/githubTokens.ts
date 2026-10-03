import type { Kysely } from 'kysely'
import { iso } from './helpers.ts'
import type { GithubTokenRowStatus, Tables } from './schema.ts'

export interface GithubTokenRow {
  sealed: string
  key_id: string
  status: GithubTokenRowStatus
  updated_at: string
}

/** Without the sealed value: what the admin list needs. */
export interface GithubTokenInfo {
  user_id: string
  key_id: string
  status: GithubTokenRowStatus
  updated_at: string
}

export async function getGithubToken(db: Kysely<Tables>, userId: string): Promise<GithubTokenRow | null> {
  const row = await db
    .selectFrom('github_tokens')
    .select(['sealed', 'key_id', 'status', 'updated_at'])
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return row ?? null
}

/** Every stored token's metadata, keyed by user id. */
export async function listGithubTokenInfo(db: Kysely<Tables>): Promise<Map<string, GithubTokenInfo>> {
  const rows = await db.selectFrom('github_tokens').select(['user_id', 'key_id', 'status', 'updated_at']).execute()
  return new Map(rows.map((row) => [row.user_id, row]))
}

/** Replaces the account's row in one transaction, with status 'unchecked'. */
export async function putGithubToken(
  db: Kysely<Tables>,
  token: { userId: string; sealed: string; keyId: string; setBy: string; now: Date },
): Promise<void> {
  const run = async (trx: Kysely<Tables>): Promise<void> => {
    await trx.deleteFrom('github_tokens').where('user_id', '=', token.userId).execute()
    await trx
      .insertInto('github_tokens')
      .values({
        user_id: token.userId,
        sealed: token.sealed,
        key_id: token.keyId,
        status: 'unchecked',
        set_by: token.setBy,
        updated_at: iso(token.now),
      })
      .execute()
  }
  await (db.isTransaction ? run(db) : db.transaction().execute(run))
}

/** False when there was no row. */
export async function deleteGithubToken(db: Kysely<Tables>, userId: string): Promise<boolean> {
  const result = await db.deleteFrom('github_tokens').where('user_id', '=', userId).executeTakeFirst()
  return result.numDeletedRows === 1n
}

/** Sets the status only if the row still holds this sealed value; returns whether it did. */
export async function setGithubTokenStatus(
  db: Kysely<Tables>,
  userId: string,
  sealed: string,
  status: GithubTokenRowStatus,
): Promise<boolean> {
  const result = await db
    .updateTable('github_tokens')
    .set({ status })
    .where('user_id', '=', userId)
    .where('sealed', '=', sealed)
    .executeTakeFirst()
  return result.numUpdatedRows === 1n
}
