import { afterEach, describe, expect, test } from 'vitest'
import type { Session } from '../../src/domain/api.ts'
import { purgeExpired } from '../app.ts'
import { sha256Hex } from '../auth/tokens.ts'
import { createKeycloakApp, keycloakSignIn, PUBLIC_URL, type KeycloakTestApp } from '../oidc/support.ts'

let t: KeycloakTestApp
afterEach(async () => {
  await t.h.close()
})

async function session(browser: { get(path: string): Promise<Response> }): Promise<Session> {
  const body = (await (await browser.get('/api/session')).json()) as { signedIn: boolean; session?: Session }
  if (!body.signedIn || !body.session) throw new Error('not signed in')
  return body.session
}

const OCTOCAT = { sub: 'kc-sub-octocat-0001', preferred_username: 'octocat', name: 'The Octocat' }

describe('without Keycloak configured', () => {
  test('/api/config reports it off and both routes answer 404', async () => {
    t = await createKeycloakApp({ withKeycloak: false })
    expect(await (await t.h.get('/api/config')).json()).toMatchObject({ keycloak: { enabled: false } })
    for (const path of ['/api/auth/keycloak/start', '/api/auth/keycloak/callback?code=x&state=y']) {
      const response = await t.h.get(path)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: 'keycloak-disabled' })
    }
    expect(t.kc.requests).toEqual([])
  })
})

describe('the sign-in start', () => {
  test('/api/config reports Keycloak on', async () => {
    t = await createKeycloakApp()
    expect(await (await t.h.get('/api/config')).json()).toMatchObject({ keycloak: { enabled: true } })
  })

  test('redirects to Keycloak with PKCE S256, state and nonce, and sets the login cookie', async () => {
    t = await createKeycloakApp()
    const response = await t.h.get('/api/auth/keycloak/start')
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin + location.pathname).toBe(`${t.kc.issuer}/protocol/openid-connect/auth`)
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'urutau',
      redirect_uri: `${PUBLIC_URL}/api/auth/keycloak/callback`,
      scope: 'openid profile email',
      code_challenge_method: 'S256',
    })
    for (const name of ['code_challenge', 'state', 'nonce']) expect(location.searchParams.get(name)).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(location.searchParams.has('code_verifier')).toBe(false)
    expect(location.search).not.toContain(t.kc.clientSecret)

    const cookie = response.headers.getSetCookie().find((line) => line.startsWith('urutau_oidc='))!
    expect(cookie).toMatch(/Path=\/api\/auth\/keycloak/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Max-Age=600/)
  })

  test('each start uses a fresh state, nonce and challenge', async () => {
    t = await createKeycloakApp()
    const a = new URL((await t.h.get('/api/auth/keycloak/start')).headers.get('location')!)
    const b = new URL((await t.h.get('/api/auth/keycloak/start')).headers.get('location')!)
    for (const name of ['state', 'nonce', 'code_challenge']) expect(a.searchParams.get(name)).not.toBe(b.searchParams.get(name))
  })

  test('sends the browser home with keycloak-unavailable when discovery fails, and retries discovery next time', async () => {
    t = await createKeycloakApp()
    t.kc.discoveryDown = true
    const failed = await t.h.get('/api/auth/keycloak/start')
    expect(failed.status).toBe(302)
    expect(failed.headers.get('location')).toBe(`${PUBLIC_URL}/?signin-error=keycloak-unavailable`)
    t.kc.discoveryDown = false
    expect((await t.h.get('/api/auth/keycloak/start')).headers.get('location')).toContain('/protocol/openid-connect/auth')
  })
})

describe('the callback refuses', () => {
  async function started() {
    t = await createKeycloakApp()
    const start = await t.h.get('/api/auth/keycloak/start')
    return start.headers.get('location')!
  }

  async function expectNoAccount(error: string, response: Response) {
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${PUBLIC_URL}/?signin-error=${error}`)
    expect(t.h.cookies.has('urutau_session')).toBe(false)
    expect(await t.h.database.db.selectFrom('users').selectAll().execute()).toEqual([])
    expect(await t.h.database.db.selectFrom('sessions').selectAll().execute()).toEqual([])
  }

  test('a wrong state, without exchanging the code', async () => {
    const location = await started()
    const query = t.kc.authorize(location, OCTOCAT, { state: 'not-the-state' })
    await expectNoAccount('keycloak-failed', await t.h.get(`/api/auth/keycloak/callback${query}`))
    expect(t.kc.tokenRequests('authorization_code')).toBe(0)
  })

  test('a missing state', async () => {
    const location = await started()
    const code = new URLSearchParams(t.kc.authorize(location, OCTOCAT)).get('code')!
    await expectNoAccount('keycloak-failed', await t.h.get(`/api/auth/keycloak/callback?code=${code}`))
  })

  test('an id token with a different nonce', async () => {
    const location = await started()
    t.kc.wrongNonce = true
    await expectNoAccount('keycloak-failed', await t.h.get(`/api/auth/keycloak/callback${t.kc.authorize(location, OCTOCAT)}`))
  })

  test('a request without the login cookie', async () => {
    const location = await started()
    const query = t.kc.authorize(location, OCTOCAT)
    await expectNoAccount('keycloak-expired', await t.h.newClient().get(`/api/auth/keycloak/callback${query}`))
  })

  test('a login older than ten minutes', async () => {
    const location = await started()
    const query = t.kc.authorize(location, OCTOCAT)
    t.h.clock.advance(10 * 60 * 1000 + 1)
    await expectNoAccount('keycloak-expired', await t.h.get(`/api/auth/keycloak/callback${query}`))
  })

  test('an error from Keycloak', async () => {
    await started()
    await expectNoAccount('keycloak-denied', await t.h.get('/api/auth/keycloak/callback?error=access_denied&state=x'))
  })

  test('a second use of the same callback', async () => {
    const location = await started()
    const query = t.kc.authorize(location, OCTOCAT)
    const cookie = t.h.cookies.get('urutau_oidc')!
    expect((await t.h.get(`/api/auth/keycloak/callback${query}`)).headers.get('location')).toBe(`${PUBLIC_URL}/`)
    const replay = await t.h.newClient().request(`/api/auth/keycloak/callback${query}`, { headers: { cookie: `urutau_oidc=${cookie}` } })
    expect(replay.headers.get('location')).toBe(`${PUBLIC_URL}/?signin-error=keycloak-expired`)
    expect(await t.h.database.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
  })
})

describe('signing in creates the account', () => {
  test('the first account overall is the admin; a later Keycloak account is not', async () => {
    t = await createKeycloakApp()
    const done = await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe(`${PUBLIC_URL}/`)
    expect(t.h.cookies.has('urutau_oidc')).toBe(false)
    const first = await session(t.h)
    expect(first.user).toMatchObject({ username: 'octocat', displayName: 'The Octocat', isAdmin: true, authMethod: 'keycloak' })
    expect(first.csrfToken).toBeTruthy()
    // PKCE: the verifier goes to the token endpoint only, and Keycloak checked it against the challenge sent at the start.
    const exchange = t.kc.requests.find((request) => request.url.endsWith('/protocol/openid-connect/token'))!
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(new URLSearchParams(exchange.body).get('redirect_uri')).toBe(`${PUBLIC_URL}/api/auth/keycloak/callback`)

    const other = t.h.newClient()
    await keycloakSignIn(other, t.kc, { sub: 'kc-sub-hubot-0002', preferred_username: 'hubot', name: 'Hubot' })
    expect((await session(other)).user).toMatchObject({ username: 'hubot', isAdmin: false, authMethod: 'keycloak' })

    const users = await t.h.database.db.selectFrom('users').selectAll().orderBy('created_at').execute()
    expect(users.map((user) => [user.username, user.password_hash])).toEqual([
      ['octocat', null],
      ['hubot', null],
    ])
    expect(await t.h.database.db.selectFrom('identities').select(['issuer', 'subject']).execute()).toEqual(
      expect.arrayContaining([{ issuer: t.kc.issuer, subject: 'kc-sub-octocat-0001' }]),
    )
  })

  test('a Keycloak account is not the admin when a local admin exists', async () => {
    t = await createKeycloakApp()
    expect((await t.h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })).status).toBe(201)
    const other = t.h.newClient()
    await keycloakSignIn(other, t.kc, OCTOCAT)
    expect((await session(other)).user.isAdmin).toBe(false)
    // Only the first account can sign up through first-run, so the instance cannot gain a second admin that way either.
    expect((await t.h.newClient().post('/api/auth/first-run', { username: 'another', password: 'correct horse battery' })).status).toBe(409)
  })

  test('the same identity signing in again finds its account, even after a username change claim', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    const again = t.h.newClient()
    await keycloakSignIn(again, t.kc, { ...OCTOCAT, preferred_username: 'renamed' })
    expect((await session(again)).user.username).toBe('octocat')
    expect(await t.h.database.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
  })

  test('a username already taken (even by a local account) gets a numeric suffix, never the other account', async () => {
    t = await createKeycloakApp()
    expect((await t.h.post('/api/auth/first-run', { username: 'Octocat', password: 'correct horse battery' })).status).toBe(201)
    const other = t.h.newClient()
    await keycloakSignIn(other, t.kc, OCTOCAT)
    expect((await session(other)).user).toMatchObject({ username: 'octocat-2', isAdmin: false })
    const local = await t.h.database.db.selectFrom('users').select(['username', 'password_hash']).where('username', '=', 'Octocat').executeTakeFirstOrThrow()
    expect(local.password_hash).not.toBeNull()
  })

  test('a session cookie from before is replaced by the new session', async () => {
    t = await createKeycloakApp()
    expect((await t.h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })).status).toBe(201)
    const before = t.h.cookies.get('urutau_session')!
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect(t.h.cookies.get('urutau_session')).not.toBe(before)
    expect(await t.h.database.db.selectFrom('sessions').select('id_hash').where('id_hash', '=', sha256Hex(before)).execute()).toEqual([])
  })

  test('no token or secret is stored: the database holds no Keycloak token', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    const dump = JSON.stringify({
      users: await t.h.database.db.selectFrom('users').selectAll().execute(),
      sessions: await t.h.database.db.selectFrom('sessions').selectAll().execute(),
      identities: await t.h.database.db.selectFrom('identities').selectAll().execute(),
      meta: await t.h.database.db.selectFrom('meta').selectAll().execute(),
    })
    for (const secret of [t.kc.acceptedAccessToken()!, 'refresh-token', 'gho_brokered_token_value', t.kc.clientSecret]) {
      expect(dump).not.toContain(secret)
    }
  })
})

describe('the GitHub access a session reports', () => {
  test('server when the broker hands over a token', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect((await session(t.h)).githubAccess).toEqual({ mode: 'server' })
    expect(t.kc.to('keycloak.test').filter((request) => request.url.includes('/broker/github/token'))).toHaveLength(1)
  })

  test.each([
    ['not-linked', 400, '{"errorMessage":"User [x] is not associated with identity provider [github]."}'],
    ['not-linked', 404, '{"errorMessage":"No token stored"}'],
    ['refused', 403, '{"errorMessage":"Client [urutau] not authorized to retrieve tokens from identity provider [github]."}'],
  ] as const)('browser with %s when the broker answers %i', async (problem, status, body) => {
    t = await createKeycloakApp()
    t.kc.broker = { status, body }
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect((await session(t.h)).githubAccess).toEqual({ mode: 'browser', problem })
  })

  test('browser with no problem when no GitHub identity provider is configured, and the broker is never called', async () => {
    t = await createKeycloakApp({ keycloak: { githubIdpAlias: null } })
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect((await session(t.h)).githubAccess).toEqual({ mode: 'browser', problem: null })
    expect(t.kc.requests.some((request) => request.url.includes('/broker/'))).toBe(false)
  })

  test('server stays the mode when the broker is unreachable at sign-in, and the first proxied read reports it', async () => {
    t = await createKeycloakApp()
    t.kc.broker = { status: 503, body: '' }
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect((await session(t.h)).githubAccess).toEqual({ mode: 'server' })
  })

  test('a local account reads GitHub from the browser', async () => {
    t = await createKeycloakApp()
    expect((await t.h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })).status).toBe(201)
    expect((await session(t.h)).githubAccess).toEqual({ mode: 'browser', problem: null })
  })

  test('a server restart loses the grant: still signed in, with signin-expired', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    // A restarted server has the sessions (database) but no grants (memory).
    const idHash = sha256Hex(t.h.cookies.get('urutau_session')!)
    t.h.grants.delete(idHash)
    expect((await session(t.h)).githubAccess).toEqual({ mode: 'browser', problem: 'signin-expired' })
  })
})

describe('signing out and removal', () => {
  test('sign-out returns the Keycloak end-session URL and drops the grant', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    const idHash = sha256Hex(t.h.cookies.get('urutau_session')!)
    expect(t.h.grants.get(idHash)).toBeDefined()
    const response = await t.h.post('/api/auth/sign-out')
    const { redirectTo } = (await response.json()) as { redirectTo: string }
    const url = new URL(redirectTo)
    expect(url.origin + url.pathname).toBe(`${t.kc.issuer}/protocol/openid-connect/logout`)
    expect(url.searchParams.get('client_id')).toBe('urutau')
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_URL}/`)
    expect(url.searchParams.get('id_token_hint')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(t.h.grants.get(idHash)).toBeUndefined()
  })

  test('sign-out of a local session still returns null', async () => {
    t = await createKeycloakApp()
    expect((await t.h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })).status).toBe(201)
    expect(await (await t.h.post('/api/auth/sign-out')).json()).toEqual({ redirectTo: null })
  })

  test('the admin removing a Keycloak user drops their grant', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    const other = t.h.newClient()
    await keycloakSignIn(other, t.kc, { sub: 'kc-sub-hubot-0002', preferred_username: 'hubot' })
    const hubot = sha256Hex(other.cookies.get('urutau_session')!)
    expect(t.h.grants.get(hubot)).toBeDefined()
    const users = (await (await t.h.get('/api/users')).json()) as { users: Array<{ id: string; username: string }> }
    const id = users.users.find((user) => user.username === 'hubot')!.id
    expect((await t.h.delete(`/api/users/${id}`)).status).toBe(204)
    expect(t.h.grants.get(hubot)).toBeUndefined()
  })

  test('purging expired sessions drops their grants and keeps the others', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    const old = sha256Hex(t.h.cookies.get('urutau_session')!)
    // Without a refresh expiry the only thing that can drop this grant is the purge.
    t.h.grants.get(old)!.refreshExpiresAt = null
    t.h.clock.advance(20 * 24 * 60 * 60 * 1000)
    const recent = t.h.newClient()
    await keycloakSignIn(recent, t.kc, { sub: 'kc-sub-hubot-0002', preferred_username: 'hubot' })
    const kept = sha256Hex(recent.cookies.get('urutau_session')!)
    t.h.clock.advance(11 * 24 * 60 * 60 * 1000)
    expect(await purgeExpired(t.h.database, t.h.clock.now, t.h.grants)).toMatchObject({ sessions: 1 })
    expect(t.h.grants.get(old)).toBeUndefined()
    expect(t.h.grants.get(kept)).toBeDefined()
  })

  test('a grant whose session expired is dropped when the stale cookie is next seen', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    const idHash = sha256Hex(t.h.cookies.get('urutau_session')!)
    t.h.clock.advance(31 * 24 * 60 * 60 * 1000)
    expect(await (await t.h.get('/api/session')).json()).toMatchObject({ signedIn: false })
    expect(t.h.grants.get(idHash)).toBeUndefined()
  })
})

describe('logs', () => {
  test('no log line holds a token, the client secret, a code or a verifier', async () => {
    t = await createKeycloakApp()
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    t.kc.broker = { status: 403, body: '{"errorMessage":"no"}' }
    await t.h.post('/api/auth/sign-out')
    const logs = t.h.logs.join('\n')
    for (const secret of [t.kc.clientSecret, 'access-token-', 'refresh-token-', 'gho_brokered_token_value']) expect(logs).not.toContain(secret)
    expect(logs).not.toContain('code=')
    expect(logs).not.toContain('state=')
  })
})
