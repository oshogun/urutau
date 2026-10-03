import { describe, expect, test } from 'vitest'
import { openDatabase } from '../db/index.ts'
import { createIntegration } from '../db/integrations.ts'
import { createAccount } from '../db/users.ts'
import { baseUsername, findOrCreateKeycloakUser, usernameCandidates } from './accounts.ts'

const sub = '8f14e45f-ceea-4b3a-9c1d-aaaaaaaaaaaa'

describe('baseUsername', () => {
  test.each([
    ['Octocat', 'octocat'],
    ['Jane Doe', 'jane-doe'],
    ['jane@example.com', 'jane-example.com'],
    ['__under', 'under'],
    ['ÅÄÖ-user', 'user'],
    ['a'.repeat(40), 'a'.repeat(32)],
  ])('%s becomes %s', (preferred, expected) => {
    expect(baseUsername({ preferredUsername: preferred, subject: sub })).toBe(expected)
  })

  test('uses the subject when there is no preferred username', () => {
    expect(baseUsername({ preferredUsername: null, subject: sub })).toBe(sub.slice(0, 32))
  })

  test('falls back to kc- and the start of the subject under three characters', () => {
    expect(baseUsername({ preferredUsername: 'ab', subject: sub })).toBe('kc-8f14e45f')
    expect(baseUsername({ preferredUsername: '!!!', subject: sub })).toBe('kc-8f14e45f')
  })
})

describe('usernameCandidates', () => {
  test('base, -2 to -99 within 32 characters, then kc- and 12 of the subject', () => {
    const all = [...usernameCandidates({ preferredUsername: 'a'.repeat(40), subject: sub })]
    expect(all).toHaveLength(1 + 98 + 1)
    expect(all[0]).toBe('a'.repeat(32))
    expect(all[1]).toBe('a'.repeat(30) + '-2')
    expect(all[98]).toBe('a'.repeat(29) + '-99')
    expect(all[99]).toBe('kc-8f14e45f-cee')
    expect(all.every((name) => name.length <= 32 && /^[a-z0-9][a-z0-9._-]{2,31}$/.test(name))).toBe(true)
  })
})

describe('findOrCreateKeycloakUser and integration accounts', () => {
  test('a person whose preferred username equals an integration name gets name-2 and is not the integration', async () => {
    const database = await openDatabase('sqlite::memory:')
    try {
      await database.migrate()
      const now = new Date('2026-10-03T12:00:00.000Z')
      const admin = await createAccount(database.db, { username: 'admin', displayName: null, passwordHash: null, now })
      if (!admin.created) throw new Error('admin not created')
      const bot = await createIntegration(database.db, { username: 'planner-bot', createdBy: admin.user.id, now })
      const person = await findOrCreateKeycloakUser(
        database.db,
        { issuer: 'https://sso.example/realms/u', subject: sub, preferredUsername: 'Planner-Bot', name: null },
        now,
      )
      expect(person.username).toBe('planner-bot-2')
      expect(person.id).not.toBe(bot.id)
      expect(person.is_admin).toBe(0)
    } finally {
      await database.close()
    }
  })
})
