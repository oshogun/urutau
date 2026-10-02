import type { Kysely, Selectable } from 'kysely'
import { iso } from './helpers.ts'
import type { SessionsTable, Tables } from './schema.ts'

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
