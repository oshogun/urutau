import type { Kysely, Selectable } from 'kysely'
import { iso } from './helpers.ts'
import type { SessionsTable, Tables } from './schema.ts'
import type { UserRow } from './users.ts'

export type SessionRow = Selectable<SessionsTable>

export interface NewSession {
  idHash: string
  userId: string
  authMethod: SessionRow['auth_method']
  csrfToken: string
  now: Date
  expiresAt: Date
}

export async function createSession(db: Kysely<Tables>, session: NewSession): Promise<void> {
  await db
    .insertInto('sessions')
    .values({
      id_hash: session.idHash,
      user_id: session.userId,
      auth_method: session.authMethod,
      csrf_token: session.csrfToken,
      created_at: iso(session.now),
      last_seen_at: iso(session.now),
      expires_at: iso(session.expiresAt),
    })
    .execute()
}

/** Returns the session unless it has expired at `now`. */
export async function getSession(db: Kysely<Tables>, idHash: string, now: Date): Promise<SessionRow | null> {
  const row = await db
    .selectFrom('sessions')
    .selectAll()
    .where('id_hash', '=', idHash)
    .where('expires_at', '>', iso(now))
    .executeTakeFirst()
  return row ?? null
}

/** The unexpired session with its user, and whether that user is an integration; one query. */
export async function getSessionWithUser(
  db: Kysely<Tables>,
  idHash: string,
  now: Date,
): Promise<{ session: SessionRow; user: UserRow; integration: boolean } | null> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .leftJoin('integrations', 'integrations.user_id', 'users.id')
    .select([
      'sessions.id_hash as s_id_hash',
      'sessions.user_id as s_user_id',
      'sessions.auth_method as s_auth_method',
      'sessions.csrf_token as s_csrf_token',
      'sessions.created_at as s_created_at',
      'sessions.last_seen_at as s_last_seen_at',
      'sessions.expires_at as s_expires_at',
      'users.id as u_id',
      'users.username as u_username',
      'users.username_key as u_username_key',
      'users.display_name as u_display_name',
      'users.password_hash as u_password_hash',
      'users.is_admin as u_is_admin',
      'users.created_at as u_created_at',
      'integrations.user_id as integration_id',
    ])
    .where('sessions.id_hash', '=', idHash)
    .where('sessions.expires_at', '>', iso(now))
    .executeTakeFirst()
  if (!row) return null
  return {
    session: {
      id_hash: row.s_id_hash,
      user_id: row.s_user_id,
      auth_method: row.s_auth_method,
      csrf_token: row.s_csrf_token,
      created_at: row.s_created_at,
      last_seen_at: row.s_last_seen_at,
      expires_at: row.s_expires_at,
    },
    user: {
      id: row.u_id,
      username: row.u_username,
      username_key: row.u_username_key,
      display_name: row.u_display_name,
      password_hash: row.u_password_hash,
      is_admin: row.u_is_admin,
      created_at: row.u_created_at,
    },
    integration: row.integration_id !== null,
  }
}

export async function touchSession(db: Kysely<Tables>, idHash: string, now: Date, expiresAt: Date): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ last_seen_at: iso(now), expires_at: iso(expiresAt) })
    .where('id_hash', '=', idHash)
    .execute()
}

export async function deleteSession(db: Kysely<Tables>, idHash: string): Promise<void> {
  await db.deleteFrom('sessions').where('id_hash', '=', idHash).execute()
}

export async function deleteSessionsForUser(db: Kysely<Tables>, userId: string): Promise<void> {
  await db.deleteFrom('sessions').where('user_id', '=', userId).execute()
}

/** Removes sessions that expired before `now`; returns how many. */
export async function deleteExpiredSessions(db: Kysely<Tables>, now: Date): Promise<number> {
  const result = await db.deleteFrom('sessions').where('expires_at', '<=', iso(now)).executeTakeFirst()
  return Number(result.numDeletedRows)
}
