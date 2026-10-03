import type { Kysely } from 'kysely'
import { iso } from './helpers.ts'
import type { Tables } from './schema.ts'

const TOUCH_AFTER_MS = 60 * 60 * 1000

export interface NewApiToken {
  userId: string
  tokenHash: string
  label: string
  createdBy: string
  now: Date
  /** null: never expires. */
  expiresAt: Date | null
}

/** A token without its hash. */
export interface ApiTokenRow {
  id: string
  user_id: string
  label: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
}

/** A live token found by hash, with its integration's username. */
export interface LiveTokenRow {
  id: string
  user_id: string
  username: string
  last_used_at: string | null
}

const publicColumns = ['id', 'user_id', 'label', 'created_at', 'expires_at', 'last_used_at'] as const

/** Inserts the row; a duplicate hash throws a unique violation. */
export async function createApiToken(db: Kysely<Tables>, token: NewApiToken): Promise<ApiTokenRow> {
  const row = {
    id: crypto.randomUUID(),
    user_id: token.userId,
    token_hash: token.tokenHash,
    label: token.label,
    created_by: token.createdBy,
    created_at: iso(token.now),
    expires_at: token.expiresAt === null ? null : iso(token.expiresAt),
    last_used_at: null,
  }
  await db.insertInto('api_tokens').values(row).execute()
  return { id: row.id, user_id: row.user_id, label: row.label, created_at: row.created_at, expires_at: row.expires_at, last_used_at: null }
}

/** Live (unexpired) tokens of one integration, or of every integration when userId is null; newest first. */
export async function listApiTokens(db: Kysely<Tables>, userId: string | null, now: Date): Promise<ApiTokenRow[]> {
  let query = db
    .selectFrom('api_tokens')
    .select([...publicColumns])
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', iso(now))]))
  if (userId !== null) query = query.where('user_id', '=', userId)
  return query.orderBy('created_at', 'desc').orderBy('id', 'asc').execute()
}

/** The live token with this hash (joined to integrations and users), or null. */
export async function findLiveToken(db: Kysely<Tables>, tokenHash: string, now: Date): Promise<LiveTokenRow | null> {
  const row = await db
    .selectFrom('api_tokens')
    .innerJoin('integrations', 'integrations.user_id', 'api_tokens.user_id')
    .innerJoin('users', 'users.id', 'integrations.user_id')
    .select(['api_tokens.id as id', 'api_tokens.user_id as user_id', 'users.username as username', 'api_tokens.last_used_at as last_used_at'])
    .where('api_tokens.token_hash', '=', tokenHash)
    .where((eb) => eb.or([eb('api_tokens.expires_at', 'is', null), eb('api_tokens.expires_at', '>', iso(now))]))
    .executeTakeFirst()
  return row ?? null
}

/** Sets last_used_at to now when it is null or more than an hour old. */
export async function touchApiToken(db: Kysely<Tables>, tokenId: string, now: Date): Promise<void> {
  const cutoff = iso(new Date(now.getTime() - TOUCH_AFTER_MS))
  await db
    .updateTable('api_tokens')
    .set({ last_used_at: iso(now) })
    .where('id', '=', tokenId)
    .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', cutoff)]))
    .execute()
}

/** True while the row exists and has not expired. */
export async function apiTokenIsLive(db: Kysely<Tables>, tokenId: string, now: Date): Promise<boolean> {
  const row = await db
    .selectFrom('api_tokens')
    .select('id')
    .where('id', '=', tokenId)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', iso(now))]))
    .executeTakeFirst()
  return row !== undefined
}

/** Deletes one token of one integration; false when there is no such token. */
export async function deleteApiToken(db: Kysely<Tables>, userId: string, tokenId: string): Promise<boolean> {
  const result = await db.deleteFrom('api_tokens').where('id', '=', tokenId).where('user_id', '=', userId).executeTakeFirst()
  return result.numDeletedRows === 1n
}

/** Deletes tokens whose expires_at <= now; returns how many. */
export async function deleteExpiredApiTokens(db: Kysely<Tables>, now: Date): Promise<number> {
  const result = await db.deleteFrom('api_tokens').where('expires_at', '<=', iso(now)).executeTakeFirst()
  return Number(result.numDeletedRows)
}
