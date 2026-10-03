/** Urutau MCP tokens: format, creation and lookup. */
import type { Kysely } from 'kysely'
import { findLiveToken, touchApiToken } from '../db/apiTokens.ts'
import type { Tables } from '../db/schema.ts'
import { randomToken, sha256Hex } from './tokens.ts'

export const BEARER_PREFIX = 'urutau_mcp_' as const
/** A prefix and 43 base64url characters (32 random bytes): 54 characters in all. */
export const BEARER_PATTERN = /^urutau_mcp_[A-Za-z0-9_-]{43}$/

/** A new token and the hex SHA-256 to store. */
export function newBearerToken(): { secret: string; hash: string } {
  const secret = `${BEARER_PREFIX}${randomToken()}`
  return { secret, hash: sha256Hex(secret) }
}

/** The token of an `Authorization: Bearer <token>` header when it matches BEARER_PATTERN; null otherwise. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^bearer +(\S+)$/i.exec(header)
  const token = match?.[1]
  return token !== undefined && BEARER_PATTERN.test(token) ? token : null
}

/** Structurally the same as McpPrincipal in server/mcp/contract.ts. */
export interface BearerPrincipal {
  userId: string
  username: string
  tokenId: string
}

/** Looks the token's hash up (live tokens of integrations only) and updates last_used_at at most once an hour. */
export async function verifyBearer(db: Kysely<Tables>, token: string, now: Date): Promise<BearerPrincipal | null> {
  if (!BEARER_PATTERN.test(token)) return null
  const found = await findLiveToken(db, sha256Hex(token), now)
  if (!found) return null
  const stale = found.last_used_at === null || Date.parse(found.last_used_at) < now.getTime() - 60 * 60 * 1000
  if (stale) await touchApiToken(db, found.id, now)
  return { userId: found.user_id, username: found.username, tokenId: found.id }
}
