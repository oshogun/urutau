import type { Kysely, Selectable } from 'kysely'
import { iso } from './helpers.ts'
import type { InvitesTable, Tables } from './schema.ts'

export type InviteRow = Selectable<InvitesTable>

export interface NewInvite {
  tokenHash: string
  createdBy: string
  now: Date
  expiresAt: Date
}

export async function createInvite(db: Kysely<Tables>, invite: NewInvite): Promise<InviteRow> {
  const row: InviteRow = {
    id: crypto.randomUUID(),
    token_hash: invite.tokenHash,
    created_by: invite.createdBy,
    created_at: iso(invite.now),
    expires_at: iso(invite.expiresAt),
    used_at: null,
    used_by: null,
  }
  await db.insertInto('invites').values(row).execute()
  return row
}

/** Returns the invite only while it is unused and unexpired at `now`. */
export async function getUsableInvite(db: Kysely<Tables>, tokenHash: string, now: Date): Promise<InviteRow | null> {
  const row = await db
    .selectFrom('invites')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .where('used_at', 'is', null)
    .where('expires_at', '>', iso(now))
    .executeTakeFirst()
  return row ?? null
}

/** Unused, unexpired invites, newest first. */
export async function listUsableInvites(db: Kysely<Tables>, now: Date): Promise<InviteRow[]> {
  return db
    .selectFrom('invites')
    .selectAll()
    .where('used_at', 'is', null)
    .where('expires_at', '>', iso(now))
    .orderBy('created_at', 'desc')
    .orderBy('id', 'asc')
    .execute()
}

/**
 * Marks the invite with this token hash used by `userId` in one conditional
 * UPDATE, so two accepts of the same token cannot both succeed. Run it after
 * the account exists (used_by references users) and inside the same
 * transaction; when it returns false the caller throws so the account rolls back.
 */
export async function markInviteUsed(db: Kysely<Tables>, tokenHash: string, userId: string, now: Date): Promise<boolean> {
  const result = await db
    .updateTable('invites')
    .set({ used_at: iso(now), used_by: userId })
    .where('token_hash', '=', tokenHash)
    .where('used_at', 'is', null)
    .where('expires_at', '>', iso(now))
    .executeTakeFirst()
  return result.numUpdatedRows === 1n
}

/** Deletes the invite (revoking it). Returns whether a row was removed. */
export async function deleteInvite(db: Kysely<Tables>, id: string): Promise<boolean> {
  const result = await db.deleteFrom('invites').where('id', '=', id).executeTakeFirst()
  return result.numDeletedRows === 1n
}
