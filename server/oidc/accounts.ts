import type { Kysely } from 'kysely'
import { findUserByIdentity, linkIdentity } from '../db/identities.ts'
import { isUniqueViolation } from '../db/index.ts'
import type { Tables } from '../db/schema.ts'
import { createAccount, getUserByUsername, type UserRow } from '../db/users.ts'
import type { KeycloakClaims } from './keycloak.ts'

const MAX_USERNAME = 32
const MAX_DISPLAY_NAME = 128

function sanitize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '')
}

/** The username an account gets before any collision: the preferred username (else the subject) cleaned up, or `kc-` and the start of the subject. */
export function baseUsername(claims: Pick<KeycloakClaims, 'preferredUsername' | 'subject'>): string {
  const candidate = sanitize(claims.preferredUsername ?? claims.subject).slice(0, MAX_USERNAME)
  if (candidate.length >= 3) return candidate
  return `kc-${sanitize(claims.subject).slice(0, 8)}`.slice(0, MAX_USERNAME)
}

/** The base, then `-2` … `-99` (the base cut so the total stays within 32 characters), then `kc-` and the start of the subject. */
export function* usernameCandidates(claims: Pick<KeycloakClaims, 'preferredUsername' | 'subject'>): Generator<string> {
  const base = baseUsername(claims)
  yield base
  for (let n = 2; n <= 99; n += 1) {
    const suffix = `-${n}`
    yield base.slice(0, MAX_USERNAME - suffix.length) + suffix
  }
  yield `kc-${sanitize(claims.subject).slice(0, 12)}`.slice(0, MAX_USERNAME)
}

class IdentityRaced extends Error {}

async function createLinked(db: Kysely<Tables>, claims: KeycloakClaims, now: Date): Promise<UserRow> {
  return db.transaction().execute(async (trx) => {
    let username: string | null = null
    for (const candidate of usernameCandidates(claims)) {
      if (!(await getUserByUsername(trx, candidate))) {
        username = candidate
        break
      }
    }
    if (username === null) throw new Error('no free username')
    const result = await createAccount(trx, {
      username,
      displayName: claims.name === null ? null : claims.name.slice(0, MAX_DISPLAY_NAME),
      passwordHash: null,
      now,
    })
    if (!result.created) throw new Error('account was not created')
    const linked = await linkIdentity(trx, { issuer: claims.issuer, subject: claims.subject, userId: result.user.id, now })
    // The same identity signed in at the same moment and won: roll this one back and use theirs.
    if (!linked) throw new IdentityRaced()
    return result.user
  })
}

/**
 * The account for a Keycloak identity, created on first sign-in. Matches on
 * (issuer, subject) only, never on username or e-mail. The account, its
 * identity link and the first-account admin claim are one transaction; a
 * username taken by a concurrent sign-in retries once.
 */
export async function findOrCreateKeycloakUser(db: Kysely<Tables>, claims: KeycloakClaims, now: Date): Promise<UserRow> {
  const existing = await findUserByIdentity(db, claims.issuer, claims.subject)
  if (existing) return existing
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await createLinked(db, claims, now)
    } catch (error) {
      if (error instanceof IdentityRaced) {
        const winner = await findUserByIdentity(db, claims.issuer, claims.subject)
        if (winner) return winner
      }
      if (attempt === 0 && (error instanceof IdentityRaced || isUniqueViolation(error))) continue
      throw error
    }
  }
}
