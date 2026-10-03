import { Hono } from 'hono'
import { afterEach, describe, expect, test } from 'vitest'
import type { AppContext } from '../app.ts'
import { createIntegration } from '../db/integrations.ts'
import { createSession } from '../db/sessions.ts'
import { createAccount } from '../db/users.ts'
import { HttpError } from '../http/errors.ts'
import { createTestApp, type TestApp } from '../testing/harness.ts'
import { GrantStore } from '../oidc/grants.ts'
import { SESSION_COOKIE, startSessionWithId } from './sessions.ts'
import { sha256Hex } from './tokens.ts'

const ADMIN = { username: 'admin', password: 'correct horse battery' }

let h: TestApp
afterEach(async () => {
  await h.close()
})

async function setUp() {
  h = await createTestApp()
  const admin = await createAccount(h.database.db, { username: 'admin', displayName: null, passwordHash: null, now: h.clock.now })
  if (!admin.created) throw new Error('admin not created')
  const bot = await createIntegration(h.database.db, { username: 'planner-bot', createdBy: admin.user.id, now: h.clock.now })
  return { admin: admin.user, bot }
}

describe('integration accounts and sessions', () => {
  test('startSessionWithId refuses an integration with the wrong-password answer and creates no session', async () => {
    const { bot } = await setUp()
    const ctx = { database: h.database, grants: new GrantStore(), config: h.deps.config, now: () => h.clock.now, keycloak: null } as unknown as AppContext
    const app = new Hono()
    app.get('/x', async (c) => {
      await startSessionWithId(ctx, c, bot, 'local')
      return c.text('started')
    })
    app.onError((error, c) => c.json({ status: error instanceof HttpError ? error.status : 500, code: error instanceof HttpError ? error.code : 'other', message: error.message }))
    const response = await app.request('/x')
    expect(await response.json()).toEqual({ status: 401, code: 'invalid-credentials', message: 'The username or password is wrong.' })
    expect(await h.database.db.selectFrom('sessions').select('id_hash').execute()).toEqual([])
  })

  test('loadSession drops a session planted for an integration and clears the cookie', async () => {
    const { bot } = await setUp()
    await createSession(h.database.db, {
      idHash: sha256Hex('planted'),
      userId: bot.id,
      authMethod: 'local',
      csrfToken: 'c'.repeat(43),
      now: h.clock.now,
      expiresAt: new Date(h.clock.now.getTime() + 60_000),
    })
    const response = await h.request('/api/session', { headers: { cookie: `${SESSION_COOKIE}=planted` } })
    expect(await response.json()).toEqual({ signedIn: false, firstRun: false })
    expect(response.headers.getSetCookie().join(';')).toMatch(new RegExp(`${SESSION_COOKIE}=;`))
  })

  test('a session planted for a person still loads', async () => {
    const { admin } = await setUp()
    await createSession(h.database.db, {
      idHash: sha256Hex('person'),
      userId: admin.id,
      authMethod: 'local',
      csrfToken: 'c'.repeat(43),
      now: h.clock.now,
      expiresAt: new Date(h.clock.now.getTime() + 60_000),
    })
    const response = await h.request('/api/session', { headers: { cookie: `${SESSION_COOKIE}=person` } })
    expect(await response.json()).toMatchObject({ signedIn: true, session: { user: { username: 'admin' } } })
  })

  test('password sign-in for an integration name answers invalid-credentials, like a wrong password', async () => {
    await setUp()
    const integration = await h.newClient().post('/api/auth/sign-in', { username: 'planner-bot', password: ADMIN.password })
    const wrong = await h.newClient().post('/api/auth/sign-in', { username: 'nobody', password: ADMIN.password })
    expect(integration.status).toBe(401)
    const body = await integration.json()
    expect(body).toMatchObject({ error: 'invalid-credentials' })
    expect(body).toEqual(await wrong.json())
    expect(await h.database.db.selectFrom('sessions').select('id_hash').execute()).toEqual([])
  })

  test('every integration is a non-admin with no password', async () => {
    const { bot } = await setUp()
    const row = await h.database.db.selectFrom('users').selectAll().where('id', '=', bot.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ is_admin: 0, password_hash: null, display_name: null })
  })
})
