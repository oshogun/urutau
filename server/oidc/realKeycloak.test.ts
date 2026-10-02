/**
 * Opt-in suite against a real Keycloak (compose.keycloak.yaml). Skipped unless
 * URUTAU_TEST_KEYCLOAK_URL names a running instance; `npm run test:keycloak`
 * sets it. Keycloak is real here, GitHub is stubbed: the stub answers requests
 * to api.github.com and records them, everything else goes over the network.
 */
import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest'
import type { Browser } from 'playwright'
import type { Session } from '../../src/domain/api.ts'
import { createTestApp, type TestApp } from '../testing/harness.ts'

const KEYCLOAK_URL = process.env.URUTAU_TEST_KEYCLOAK_URL
const PUBLIC_URL = 'http://127.0.0.1:8788'
const REAL_KEYCLOAK_TIMEOUT = 60_000

if (!KEYCLOAK_URL) {
  console.info('server/oidc/realKeycloak.test.ts skipped: set URUTAU_TEST_KEYCLOAK_URL to a running compose.keycloak.yaml instance (npm run test:keycloak)')
}

const suite = KEYCLOAK_URL ? describe : describe.skip

suite('real Keycloak', () => {
  let browser: Browser
  let h: TestApp
  let githubSeen: Array<{ url: string; authorization: string | null }>

  beforeAll(async () => {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ args: ['--no-sandbox'] })
  }, REAL_KEYCLOAK_TIMEOUT)
  afterAll(async () => {
    await browser?.close()
  })

  async function setUp(): Promise<void> {
    githubSeen = []
    const stubbed: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url).host === 'api.github.com') {
        githubSeen.push({ url, authorization: new Headers(init?.headers).get('authorization') })
        return new Response(JSON.stringify([{ number: 7, title: 'From the stub' }]), {
          headers: { 'content-type': 'application/json', link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"' },
        })
      }
      return fetch(input, init)
    }
    h = await createTestApp({
      config: {
        publicUrl: PUBLIC_URL,
        keycloak: {
          issuer: `${KEYCLOAK_URL}/realms/urutau`,
          clientId: 'urutau',
          clientSecret: 'urutau-dev-secret',
          githubIdpAlias: 'github',
          brokerApi: 'v1',
          allowHttp: true,
        },
      },
      fetch: stubbed,
    })
  }

  afterEach(async () => {
    await h?.close()
  })

  /** Runs the start route, logs in at Keycloak as a browser would, and plays the callback into the app. */
  async function signIn(username: string, password: string, idpHint: string | null): Promise<Response> {
    const start = await h.get('/api/auth/keycloak/start')
    expect(start.status).toBe(302)
    const authorize = new URL(start.headers.get('location')!)
    if (idpHint) authorize.searchParams.set('kc_idp_hint', idpHint)
    const context = await browser.newContext()
    let callback = ''
    try {
      const page = await context.newPage()
      // Redirected navigations skip route handlers, so read the callback URL from the request event.
      page.on('request', (request) => {
        if (request.url().startsWith(`${PUBLIC_URL}/api/auth/keycloak/callback`)) callback = request.url()
      })
      await page.goto(authorize.href)
      await page.fill('#username', username)
      await page.fill('#password', password)
      await page.click('#kc-login')
      for (let i = 0; i < 150 && !callback; i += 1) await page.waitForTimeout(200)
    } finally {
      await context.close()
    }
    expect(callback).not.toBe('')
    const url = new URL(callback)
    const response = await h.get(url.pathname + url.search)
    await h.send('GET', '/api/session')
    return response
  }

  async function session(): Promise<Session> {
    const body = (await (await h.get('/api/session')).json()) as { signedIn: boolean; session?: Session }
    expect(body.signedIn).toBe(true)
    return body.session!
  }

  test(
    'signs octocat in through the broker, creates the first account as admin, and proxies GitHub with the brokered token',
    async () => {
      await setUp()
      const response = await signIn('octocat', 'octocat-dev-password', 'github')
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${PUBLIC_URL}/`)

      const signedIn = await session()
      expect(signedIn.user).toMatchObject({ authMethod: 'keycloak', isAdmin: true })
      expect(signedIn.githubAccess).toEqual({ mode: 'server' })

      const proxied = await h.get('/api/github/repos/acme/widgets/issues?state=open&per_page=100')
      expect(proxied.status).toBe(200)
      expect(proxied.headers.get('link')).toBe('<api/github/repositories/1/issues?page=2>; rel="next"')
      expect(await proxied.json()).toEqual([{ number: 7, title: 'From the stub' }])

      expect(githubSeen).toHaveLength(1)
      expect(githubSeen[0].url).toBe('https://api.github.com/repos/acme/widgets/issues?state=open&per_page=100')
      const token = githubSeen[0].authorization?.replace(/^Bearer /, '') ?? ''
      // The token must be the one fakegithub issued (stored by the broker), not urutau's own access token.
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { iss: string }
      expect(payload.iss.endsWith('/realms/fakegithub')).toBe(true)

      const dump = JSON.stringify(
        await Promise.all(['users', 'sessions', 'identities', 'meta'].map((table) => h.database.db.selectFrom(table as 'users').selectAll().execute())),
      )
      expect(dump).not.toContain(token)
      expect(h.logs.join('\n')).not.toContain(token)
      expect(JSON.stringify(await (await h.get('/api/session')).json())).not.toContain(token)
    },
    REAL_KEYCLOAK_TIMEOUT,
  )

  test(
    'a Keycloak user without the broker role is refused: GitHub is read from the browser and the proxy answers 424',
    async () => {
      await setUp()
      const response = await signIn('localonly', 'localonly-dev-password', null)
      expect(response.headers.get('location')).toBe(`${PUBLIC_URL}/`)
      expect((await session()).githubAccess).toEqual({ mode: 'browser', problem: 'refused' })
      const proxied = await h.get('/api/github/repos/acme/widgets')
      expect(proxied.status).toBe(424)
      expect(await proxied.json()).toMatchObject({ error: 'github-access', problem: 'refused' })
      expect(githubSeen).toEqual([])
    },
    REAL_KEYCLOAK_TIMEOUT,
  )

  test(
    'signing out returns the end-session URL, and Keycloak accepts it and sends the browser back',
    async () => {
      await setUp()
      await signIn('octocat', 'octocat-dev-password', 'github')
      const { redirectTo } = (await (await h.post('/api/auth/sign-out')).json()) as { redirectTo: string }
      expect(redirectTo).toContain('/protocol/openid-connect/logout')
      expect(new URL(redirectTo).searchParams.get('id_token_hint')).toBeTruthy()
      const logout = await fetch(redirectTo, { redirect: 'manual' })
      expect(logout.status).toBe(302)
      expect(logout.headers.get('location')?.startsWith(`${PUBLIC_URL}/`)).toBe(true)
      expect((await (await h.get('/api/session')).json()) as { signedIn: boolean }).toMatchObject({ signedIn: false })
    },
    REAL_KEYCLOAK_TIMEOUT,
  )
})
