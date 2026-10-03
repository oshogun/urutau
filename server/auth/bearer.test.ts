import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApiToken, deleteApiToken } from '../db/apiTokens.ts'
import { openDatabase, type Database } from '../db/index.ts'
import { createIntegration } from '../db/integrations.ts'
import { createAccount } from '../db/users.ts'
import { BEARER_PATTERN, BEARER_PREFIX, bearerFromHeader, newBearerToken, verifyBearer } from './bearer.ts'
import { sha256Hex } from './tokens.ts'

const T0 = new Date('2026-10-03T12:00:00.000Z')
const later = (ms: number) => new Date(T0.getTime() + ms)

let database: Database
let adminId: string
let botId: string
beforeEach(async () => {
  database = await openDatabase('sqlite::memory:')
  await database.migrate()
  const admin = await createAccount(database.db, { username: 'admin', displayName: null, passwordHash: null, now: T0 })
  if (!admin.created) throw new Error('admin not created')
  adminId = admin.user.id
  botId = (await createIntegration(database.db, { username: 'planner-bot', createdBy: adminId, now: T0 })).id
})
afterEach(async () => {
  await database.close()
})

async function issue(expiresAt: Date | null = null) {
  const { secret, hash } = newBearerToken()
  const row = await createApiToken(database.db, { userId: botId, tokenHash: hash, label: 'laptop', createdBy: adminId, now: T0, expiresAt })
  return { secret, hash, row }
}

const lastUsed = async (id: string) =>
  (await database.db.selectFrom('api_tokens').select('last_used_at').where('id', '=', id).executeTakeFirstOrThrow()).last_used_at

describe('newBearerToken', () => {
  test('has the prefix and 54 characters, and returns the SHA-256 of the secret', () => {
    const { secret, hash } = newBearerToken()
    expect(secret.startsWith(BEARER_PREFIX)).toBe(true)
    expect(secret).toHaveLength(54)
    expect(BEARER_PATTERN.test(secret)).toBe(true)
    expect(hash).toBe(sha256Hex(secret))
    expect(newBearerToken().secret).not.toBe(secret)
  })

  test('the plain token is never stored, only its hash', async () => {
    const { secret, hash } = await issue()
    const rows = await database.db.selectFrom('api_tokens').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(hash)
    expect(JSON.stringify(rows)).not.toContain(secret)
    expect(JSON.stringify(rows)).not.toContain(secret.slice(BEARER_PREFIX.length))
  })
})

describe('bearerFromHeader', () => {
  const token = 'urutau_mcp_' + 'A'.repeat(43)

  test('accepts Bearer and a 54-character token, any scheme case, several spaces', () => {
    expect(bearerFromHeader(`Bearer ${token}`)).toBe(token)
    expect(bearerFromHeader(`bearer   ${token}`)).toBe(token)
    expect(bearerFromHeader(`BEARER ${token}`)).toBe(token)
  })

  test.each([
    ['no header', undefined],
    ['empty', ''],
    ['another scheme', 'Basic ' + 'urutau_mcp_' + 'A'.repeat(43)],
    ['no scheme', 'urutau_mcp_' + 'A'.repeat(43)],
    ['too short', 'Bearer urutau_mcp_' + 'A'.repeat(42)],
    ['too long', 'Bearer urutau_mcp_' + 'A'.repeat(44)],
    ['wrong prefix', 'Bearer urutau_xyz_' + 'A'.repeat(43)],
    ['bad character', 'Bearer urutau_mcp_' + 'A'.repeat(42) + '+'],
    ['trailing text', 'Bearer urutau_mcp_' + 'A'.repeat(43) + ' extra'],
    ['a GitHub-shaped token', 'Bearer ' + 'f'.repeat(40)],
  ])('refuses %s', (_name, header) => {
    expect(bearerFromHeader(header)).toBeNull()
  })
})

describe('verifyBearer', () => {
  test('a live token gives its principal', async () => {
    const { secret, row } = await issue()
    expect(await verifyBearer(database.db, secret, later(1000))).toEqual({ userId: botId, username: 'planner-bot', tokenId: row.id })
  })

  test('unknown, malformed, revoked and expired tokens give null', async () => {
    expect(await verifyBearer(database.db, 'urutau_mcp_' + 'A'.repeat(43), T0)).toBeNull()
    expect(await verifyBearer(database.db, 'nonsense', T0)).toBeNull()

    const revoked = await issue()
    expect(await deleteApiToken(database.db, botId, revoked.row.id)).toBe(true)
    expect(await verifyBearer(database.db, revoked.secret, T0)).toBeNull()

    const expiring = await issue(later(60_000))
    expect(await verifyBearer(database.db, expiring.secret, later(59_999))).not.toBeNull()
    expect(await verifyBearer(database.db, expiring.secret, later(60_000))).toBeNull()
    expect(await verifyBearer(database.db, expiring.secret, later(60_001))).toBeNull()
  })

  test('a token whose integration was removed gives null', async () => {
    const { secret } = await issue()
    await database.db.deleteFrom('users').where('id', '=', botId).execute()
    expect(await verifyBearer(database.db, secret, T0)).toBeNull()
  })

  test('last_used_at is written at most once an hour', async () => {
    const { secret, row } = await issue()
    expect(await lastUsed(row.id)).toBeNull()
    await verifyBearer(database.db, secret, later(1000))
    expect(await lastUsed(row.id)).toBe(later(1000).toISOString())
    await verifyBearer(database.db, secret, later(30 * 60_000))
    expect(await lastUsed(row.id)).toBe(later(1000).toISOString())
    await verifyBearer(database.db, secret, later(1000 + 60 * 60_000 + 1))
    expect(await lastUsed(row.id)).toBe(later(1000 + 60 * 60_000 + 1).toISOString())
  })
})
