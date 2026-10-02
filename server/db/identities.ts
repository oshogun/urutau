import type { Kysely } from 'kysely'
import { insertIgnoringDuplicate, iso } from './helpers.ts'
import type { Tables } from './schema.ts'
import { getUserById, type UserRow } from './users.ts'

/** The account linked to a Keycloak (issuer, subject) pair, if any. */
export async function findUserByIdentity(db: Kysely<Tables>, issuer: string, subject: string): Promise<UserRow | null> {
  const link = await db
    .selectFrom('identities')
    .select('user_id')
    .where('issuer', '=', issuer)
    .where('subject', '=', subject)
    .executeTakeFirst()
  return link ? getUserById(db, link.user_id) : null
}

/** Links an identity to an account; returns false when the pair is already linked. */
export async function linkIdentity(
  db: Kysely<Tables>,
  identity: { issuer: string; subject: string; userId: string; now: Date },
): Promise<boolean> {
  return insertIgnoringDuplicate(db, 'identities', {
    issuer: identity.issuer,
    subject: identity.subject,
    user_id: identity.userId,
    created_at: iso(identity.now),
  })
}
