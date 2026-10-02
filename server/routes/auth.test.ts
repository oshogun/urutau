import { afterEach, describe, expect, test } from 'vitest'
import { PUBLIC_ROUTES } from '../http/publicRoutes.ts'
import { createTestApp, type TestApp } from '../testing/harness.ts'

const ADMIN = { username: 'admin', password: 'correct horse battery' }

let h: TestApp
afterEach(async () => {
  await h.close()
})

async function firstRun(): Promise<void> {
  const response = await h.post('/api/auth/first-run', ADMIN)
  expect(response.status).toBe(201)
}

describe('first run', () => {
  test('creates the admin once, then answers 409', async () => {
    h = await createTestApp()
    expect(await (await h.get('/api/session')).json()).toEqual({ signedIn: false, firstRun: true })

    const created = await h.post('/api/auth/first-run', ADMIN)
    expect(created.status).toBe(201)
    const session = (await created.json()) as { user: { isAdmin: boolean; username: string }; csrfToken: string }
    expect(session.user).toMatchObject({ username: 'admin', isAdmin: true, authMethod: 'local' })
    expect(h.cookies.get('urutau_session')).toBeTruthy()

    const again = await h.newClient().post('/api/auth/first-run', { username: 'other', password: 'another long one' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'already-set-up' })
    expect(await (await h.newClient().get('/api/session')).json()).toEqual({ signedIn: false, firstRun: false })
  })

  test('stores a bcrypt hash, never the password', async () => {
    h = await createTestApp()
    await firstRun()
    const row = await h.database.db.selectFrom('users').selectAll().executeTakeFirstOrThrow()
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/)
    expect(row.password_hash).not.toContain(ADMIN.password)
  })

  test('two simultaneous requests create exactly one admin', async () => {
    h = await createTestApp()
    const [a, b] = await Promise.all([
      h.newClient().post('/api/auth/first-run', { username: 'first', password: 'password one' }),
      h.newClient().post('/api/auth/first-run', { username: 'second', password: 'password two' }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const users = await h.database.db.selectFrom('users').selectAll().execute()
    expect(users).toHaveLength(1)
    expect(users[0].is_admin).toBe(1)
  })

  test('validates the username and password', async () => {
    h = await createTestApp()
    expect((await h.post('/api/auth/first-run', { username: 'ab', password: 'long enough password' })).status).toBe(400)
    expect((await h.post('/api/auth/first-run', { username: 'admin', password: 'short' })).status).toBe(400)
    const tooLong = await h.post('/api/auth/first-run', { username: 'admin', password: 'x'.repeat(73) })
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toMatchObject({ error: 'password-too-long' })
    // 25 characters of 3 bytes each is 75 bytes.
    expect((await h.post('/api/auth/first-run', { username: 'admin', password: '€'.repeat(25) })).status).toBe(400)
    expect((await h.post('/api/auth/first-run', 'not json')).status).toBe(400)
    expect((await h.post('/api/auth/first-run', { username: 1 })).status).toBe(400)
    expect(await h.database.db.selectFrom('users').selectAll().execute()).toHaveLength(0)
  })
})

describe('sign-in and sign-out', () => {
  test('a wrong password and an unknown user both give 401; the right one signs in', async () => {
    h = await createTestApp()
    await firstRun()
    const browser = h.newClient()
    const wrong = await browser.post('/api/auth/sign-in', { username: 'admin', password: 'not the password' })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({ error: 'invalid-credentials' })
    expect((await browser.post('/api/auth/sign-in', { username: 'nobody', password: 'not the password' })).status).toBe(401)

    const ok = await browser.post('/api/auth/sign-in', { username: 'ADMIN', password: ADMIN.password })
    expect(ok.status).toBe(200)
    expect(await (await browser.get('/api/session')).json()).toMatchObject({ signedIn: true, session: { user: { username: 'admin' } } })
  })

  test('the session cookie is HttpOnly, SameSite=Lax and has no Secure flag over http', async () => {
    h = await createTestApp()
    const response = await h.post('/api/auth/first-run', ADMIN)
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('urutau_session='))!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=2592000')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Secure')
  })

  test('the cookie is Secure with an https PUBLIC_URL', async () => {
    h = await createTestApp({ config: { publicUrl: 'https://urutau.example.com', secureCookies: true } })
    const response = await h.post('/api/auth/first-run', ADMIN, { origin: 'https://urutau.example.com' })
    expect(response.headers.getSetCookie().find((value) => value.startsWith('urutau_session='))).toContain('Secure')
  })

  test('the database holds the hash of the session id, not the id', async () => {
    h = await createTestApp()
    await firstRun()
    const id = h.cookies.get('urutau_session')!
    expect(id).toHaveLength(43)
    const rows = await h.database.db.selectFrom('sessions').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].id_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].id_hash).not.toContain(id)
  })

  test('sign-out deletes the session and clears the cookie', async () => {
    h = await createTestApp()
    await firstRun()
    const response = await h.post('/api/auth/sign-out')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ redirectTo: null })
    expect(h.cookies.has('urutau_session')).toBe(false)
    expect(await h.database.db.selectFrom('sessions').selectAll().execute()).toHaveLength(0)
    expect((await h.get('/api/boards')).status).toBe(401)
  })

  test('signing in while holding a session deletes the old one', async () => {
    h = await createTestApp()
    await firstRun()
    const first = h.cookies.get('urutau_session')!
    await h.post('/api/auth/sign-in', ADMIN)
    expect(h.cookies.get('urutau_session')).not.toBe(first)
    expect(await h.database.db.selectFrom('sessions').selectAll().execute()).toHaveLength(1)
  })

  test('a session expires after 30 days and is refreshed when seen after an hour', async () => {
    h = await createTestApp()
    await firstRun()
    h.clock.advance(2 * 60 * 60 * 1000)
    const refreshed = await h.get('/api/session')
    expect(refreshed.headers.getSetCookie().some((value) => value.startsWith('urutau_session='))).toBe(true)
    const row = await h.database.db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()
    expect(row.last_seen_at).toBe(h.clock.now.toISOString())
    expect(row.expires_at).toBe(new Date(h.clock.now.getTime() + 30 * 24 * 3600 * 1000).toISOString())

    h.clock.advance(31 * 24 * 3600 * 1000)
    const expired = await h.get('/api/boards')
    expect(expired.status).toBe(401)
    expect(expired.headers.getSetCookie().some((value) => value.startsWith('urutau_session=;'))).toBe(true)
  })
})

describe('signed-out requests', () => {
  test('every registered route outside the public list answers 401', async () => {
    h = await createTestApp()
    const checked: string[] = []
    for (const route of h.app.routes) {
      if (route.method === 'ALL') continue
      const key = `${route.method} ${route.path}`
      if (PUBLIC_ROUTES.includes(key)) continue
      const path = route.path.replace(/:\w+/g, 'x')
      const response = await h.request(path, { method: route.method, headers: { 'X-Urutau-CSRF': '1' } })
      expect({ route: key, status: response.status }).toEqual({ route: key, status: 401 })
      expect(await response.json()).toMatchObject({ error: 'signed-out' })
      checked.push(key)
    }
    expect(checked).toContain('GET /api/boards')
    expect(checked).toContain('GET /api/users')
    expect(checked).toContain('POST /api/invites')
  })

  test('the public routes answer without a session', async () => {
    h = await createTestApp()
    expect((await h.get('/api/health')).status).toBe(200)
    const config = (await (await h.get('/api/config')).json()) as { keycloak: { enabled: boolean }; instanceId: string }
    expect(config.keycloak.enabled).toBe(false)
    expect(config.instanceId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await h.get('/api/session')).status).toBe(200)
  })

  test('an unknown /api path answers 404 JSON once signed in, and every response carries the security headers', async () => {
    h = await createTestApp()
    await firstRun()
    const response = await h.get('/api/nothing-here')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'not-found' })
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  test('an oversized body answers 413', async () => {
    h = await createTestApp()
    const response = await h.post('/api/auth/sign-in', 'x'.repeat(1024 * 1024 + 1))
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: 'too-large' })
  })
})

describe('CSRF protection', () => {
  test('a state-changing request without the token is refused, with the wrong token too', async () => {
    h = await createTestApp()
    await firstRun()
    const without = await h.request('/api/invites', { method: 'POST' })
    expect(without.status).toBe(403)
    expect(await without.json()).toMatchObject({ error: 'csrf-rejected' })
    expect((await h.post('/api/invites', {}, { 'X-Urutau-CSRF': 'wrong' })).status).toBe(403)
    expect((await h.post('/api/invites', {})).status).toBe(201)
  })

  test('a sign-in without the header is refused; any value is accepted before a session exists', async () => {
    h = await createTestApp()
    await firstRun()
    const browser = h.newClient()
    const missing = await browser.request('/api/auth/sign-in', {
      method: 'POST',
      body: JSON.stringify(ADMIN),
      headers: { 'content-type': 'application/json' },
    })
    expect(missing.status).toBe(403)
    expect((await browser.post('/api/auth/sign-in', ADMIN, { 'X-Urutau-CSRF': 'anything' })).status).toBe(200)
  })

  test('the Origin must be this host, or the PUBLIC_URL origin when set', async () => {
    h = await createTestApp()
    await firstRun()
    expect((await h.post('/api/invites', {}, { origin: 'http://evil.example', host: 'localhost:8787' })).status).toBe(403)
    expect((await h.post('/api/invites', {}, { origin: 'http://localhost:8787', host: 'localhost:8787' })).status).toBe(201)
    expect((await h.post('/api/invites', {}, { origin: 'not a url', host: 'localhost:8787' })).status).toBe(403)
    await h.close()

    h = await createTestApp({ config: { publicUrl: 'https://urutau.example.com/app' } })
    expect((await h.post('/api/auth/first-run', ADMIN, { origin: 'https://urutau.example.com', host: 'localhost:8080' })).status).toBe(201)
    expect((await h.post('/api/invites', {}, { origin: 'http://localhost:8080', host: 'localhost:8080' })).status).toBe(403)
  })

  test('Sec-Fetch-Site must be same-origin when there is no Origin', async () => {
    h = await createTestApp()
    await firstRun()
    expect((await h.post('/api/invites', {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await h.post('/api/invites', {}, { 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await h.post('/api/invites', {}, { 'sec-fetch-site': 'same-origin' })).status).toBe(201)
  })
})

describe('sign-in rate limiting', () => {
  test('the sixth attempt for one username gets 429 with Retry-After, even with the right password', async () => {
    h = await createTestApp()
    await firstRun()
    const browser = h.newClient()
    for (let i = 0; i < 5; i += 1) {
      expect((await browser.post('/api/auth/sign-in', { username: 'admin', password: 'wrong password' })).status).toBe(401)
    }
    const blocked = await browser.post('/api/auth/sign-in', ADMIN)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'too-many-attempts' })
    expect(blocked.headers.get('retry-after')).toBe('900')

    h.clock.advance(10 * 60 * 1000)
    expect((await browser.post('/api/auth/sign-in', ADMIN)).headers.get('retry-after')).toBe('300')

    h.clock.advance(5 * 60 * 1000 + 1)
    expect((await browser.post('/api/auth/sign-in', ADMIN)).status).toBe(200)
  })

  test('50 failures from one IP block its public POSTs; another IP is unaffected', async () => {
    h = await createTestApp({ config: { trustProxy: true } })
    await firstRun()
    const browser = h.newClient()
    const from = (ip: string) => ({ 'x-forwarded-for': `10.9.9.9, ${ip}` })
    for (let i = 0; i < 50; i += 1) {
      expect((await browser.post('/api/invites/check', { token: `unknown-${i}` }, from('203.0.113.9'))).status).toBe(404)
    }
    expect((await browser.post('/api/invites/check', { token: 'x' }, from('203.0.113.9'))).status).toBe(429)
    expect((await browser.post('/api/auth/sign-in', ADMIN, from('203.0.113.9'))).status).toBe(429)
    expect((await browser.post('/api/invites/check', { token: 'x' }, from('198.51.100.2'))).status).toBe(404)
    h.clock.advance(15 * 60 * 1000 + 1)
    expect((await browser.post('/api/invites/check', { token: 'x' }, from('203.0.113.9'))).status).toBe(404)
  })

  test('X-Forwarded-For is ignored unless TRUST_PROXY is set', async () => {
    h = await createTestApp()
    const browser = h.newClient()
    for (let i = 0; i < 50; i += 1) await browser.post('/api/invites/check', { token: 'x' }, { 'x-forwarded-for': `10.0.0.${i}` })
    expect((await browser.post('/api/invites/check', { token: 'x' }, { 'x-forwarded-for': '10.0.0.99' })).status).toBe(429)
  })
})

describe('logging', () => {
  test('no password, hash, session id or CSRF token appears in a log line', async () => {
    h = await createTestApp()
    await h.post('/api/auth/first-run', ADMIN)
    const sessionId = h.cookies.get('urutau_session')!
    const csrf = h.csrfToken!
    await h.post('/api/auth/sign-in', { username: 'admin', password: 'wrong password!' })
    await h.get('/api/boards?token=secret-in-query')
    await h.post('/api/auth/sign-in', 'not json at all')
    const row = await h.database.db.selectFrom('users').select('password_hash').executeTakeFirstOrThrow()
    const sessionRow = await h.database.db.selectFrom('sessions').select('id_hash').executeTakeFirstOrThrow()

    const output = h.logs.join('\n')
    expect(h.logs.length).toBeGreaterThan(3)
    for (const secret of [ADMIN.password, 'wrong password!', row.password_hash!, sessionId, sessionRow.id_hash, csrf, 'secret-in-query']) {
      expect(output).not.toContain(secret)
    }
    expect(JSON.parse(h.logs[0])).toMatchObject({ level: 'info', msg: 'request', method: 'POST', path: '/api/auth/first-run', status: 201 })
  })
})

describe('ordering of checks', () => {
  const BIG = JSON.stringify({ x: 'x'.repeat(1024 * 1024 + 10) })

  test('a signed-out oversized request gets 401, while an oversized sign-in gets 413', async () => {
    h = await createTestApp()
    const put = await h.put('/api/boards/acme/widgets', BIG)
    expect(put.status).toBe(401)
    const sign = await h.post('/api/auth/sign-in', BIG)
    expect(sign.status).toBe(413)
  })

  test('HEAD on a public GET route is not 401', async () => {
    h = await createTestApp()
    expect((await h.request('/api/health', { method: 'HEAD' })).status).toBe(200)
    expect((await h.request('/api/boards', { method: 'HEAD' })).status).toBe(401)
  })
})
