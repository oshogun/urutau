import { afterEach, describe, expect, test } from 'vitest'
import type { GitHubAccessError } from '../../src/domain/api.ts'
import { createKeycloakApp, keycloakSignIn, type KeycloakTestApp } from '../oidc/support.ts'

const BROKERED = 'gho_brokered_token_value'
const OCTOCAT = { sub: 'kc-sub-octocat-0001', preferred_username: 'octocat', name: 'The Octocat' }
const REPO = '/api/github/repos/acme/widgets'
const ISSUES = `${REPO}/issues?state=open&per_page=100`

let t: KeycloakTestApp
afterEach(async () => {
  await t.h.close()
})

async function signedIn(options: Parameters<typeof createKeycloakApp>[0] = {}): Promise<void> {
  t = await createKeycloakApp(options)
  await keycloakSignIn(t.h, t.kc, OCTOCAT)
}

const githubRequests = () => t.kc.to('api.github.com')
const brokerRequests = () => t.kc.requests.filter((request) => request.url.includes('/broker/'))

describe('who may use the proxy', () => {
  test('a signed-out request is 401', async () => {
    t = await createKeycloakApp()
    const response = await t.h.get(ISSUES)
    expect(response.status).toBe(401)
    expect(githubRequests()).toEqual([])
  })

  test('a local account is 403 forbidden and nothing is sent to GitHub', async () => {
    t = await createKeycloakApp()
    expect((await t.h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })).status).toBe(201)
    const response = await t.h.get(ISSUES)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'forbidden' })
    expect(githubRequests()).toEqual([])
  })

  test('a Keycloak account with no GitHub identity provider configured is 403 forbidden', async () => {
    await signedIn({ keycloak: { githubIdpAlias: null } })
    expect((await t.h.get(ISSUES)).status).toBe(403)
    expect(githubRequests()).toEqual([])
  })

  test('only GET: other methods are 405 and nothing is sent', async () => {
    await signedIn()
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await t.h.send(method, REPO)
      expect({ method, status: response.status }).toEqual({ method, status: 405 })
    }
    expect(githubRequests()).toEqual([])
  })
})

describe('the allow-list', () => {
  const refused = [
    '/api/github/user',
    '/api/github/repos/acme/widgets/issues/1',
    '/api/github/repos/acme/widgets/contents/README.md',
    '/api/github/repos/acme/widgets/issues/1/comments',
    '/api/github/repos/acme/widgets/labels/bug',
    '/api/github/repos/acme/widgets?per_page=1',
    '/api/github/repos/acme/widgets/issues?state=all',
    '/api/github/repos/acme/widgets/issues?per_page=0',
    '/api/github/repos/acme/widgets/issues?per_page=101',
    '/api/github/repos/acme/widgets/issues?per_page=1&per_page=2',
    '/api/github/repos/acme/widgets/issues?sort=created',
    '/api/github/repos/acme/widgets/issues?since=yesterday',
    '/api/github/repos/acme/widgets/issues?state',
    '/api/github/repos/acme/widgets/labels?state=open',
    '/api/github/repos/acme/../../user',
    '/api/github/repos/acme/%2e%2e/issues',
    '/api/github/repos/acme%2Fwidgets/issues',
    '/api/github/repos/acme/widgets%2Fissues',
    '/api/github/repos/-bad/widgets/issues',
    '/api/github/repositories/0/issues',
    '/api/github/repositories/abc/issues',
    '/api/github/repositories/237159/issues/1',
    '/api/github/repos/acme/widgets/issues?%',
    '/api/github/',
    '/api/github/graphql',
    '/api/github/https://evil.example/x',
  ]

  test.each(refused)('%s is 404 github-path-not-allowed and nothing is sent to GitHub', async (path) => {
    await signedIn()
    const before = t.kc.requests.length
    const response = await t.h.get(path)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'github-path-not-allowed' })
    expect(t.kc.requests.length).toBe(before)
  })

  test.each([
    '/api/github/repos/acme/widgets',
    '/api/github/repos/acme/widgets/labels?per_page=100',
    '/api/github/repos/acme/widgets/labels?per_page=100&page=2',
    '/api/github/repos/acme/widgets/issues?state=closed&since=2026-01-02T03:04:05Z&per_page=100',
    '/api/github/repos/acme/widgets/issues?state=open&since=2026-01-02T03:04:05.123Z',
    '/api/github/repositories/237159/labels?per_page=2&page=2',
    '/api/github/repositories/237159/issues?state=open&per_page=2&after=Y3Vyc29yOnYy%2BAB%3D&page=2',
  ])('%s is forwarded', async (path) => {
    await signedIn()
    expect((await t.h.get(path)).status).toBe(200)
    expect(githubRequests()).toHaveLength(1)
  })
})

describe('the upstream request', () => {
  test('goes to api.github.com only, with the brokered token and GitHub headers', async () => {
    await signedIn()
    await t.h.get(ISSUES)
    const [request] = githubRequests()
    expect(request.url).toBe('https://api.github.com/repos/acme/widgets/issues?state=open&per_page=100')
    expect(request.method).toBe('GET')
    expect(request.headers).toMatchObject({
      authorization: `Bearer ${BROKERED}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'urutau',
    })
    // Every other request went to Keycloak, and none of those carried the GitHub token.
    const hosts = new Set(t.kc.requests.map((entry) => new URL(entry.url).host))
    expect([...hosts].sort()).toEqual(['api.github.com', 'keycloak.test'])
    for (const entry of t.kc.to('keycloak.test')) {
      expect(JSON.stringify(entry)).not.toContain(BROKERED)
    }
  })

  test('forwards the query string byte for byte, a plus sign in the cursor included', async () => {
    await signedIn()
    const query = 'state=open&per_page=2&after=Y3Vyc29yOnYy+AB%3D&page=2'
    await t.h.get(`/api/github/repositories/237159/issues?${query}`)
    expect(githubRequests()[0].url).toBe(`https://api.github.com/repositories/237159/issues?${query}`)
  })

  test('the client cannot choose the host, the token or the headers', async () => {
    await signedIn()
    await t.h.request(REPO, { headers: { Authorization: 'Bearer client-token', Host: 'localhost', 'X-Forwarded-Host': 'evil.example' } })
    const [request] = githubRequests()
    expect(request.url.startsWith('https://api.github.com/')).toBe(true)
    expect(request.headers.authorization).toBe(`Bearer ${BROKERED}`)
    expect(JSON.stringify(request)).not.toContain('client-token')
  })

  test('the cached token serves later reads: one broker call for many reads', async () => {
    await signedIn()
    for (let i = 0; i < 3; i += 1) await t.h.get(REPO)
    expect(githubRequests()).toHaveLength(3)
    expect(brokerRequests()).toHaveLength(1)
  })

  test('after five minutes the broker is asked again', async () => {
    await signedIn()
    await t.h.get(REPO)
    t.h.clock.advance(5 * 60 * 1000 + 1)
    await t.h.get(REPO)
    expect(brokerRequests()).toHaveLength(2)
  })

  test('concurrent reads on a cold cache share one broker call', async () => {
    await signedIn()
    // Drop the token the sign-in fetched so the next reads must ask the broker.
    t.h.clock.advance(5 * 60 * 1000 + 1)
    const before = brokerRequests().length
    const responses = await Promise.all([t.h.get(REPO), t.h.get(REPO), t.h.get(REPO)])
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect(brokerRequests().length - before).toBe(1)
  })
})

describe('broker API version 2', () => {
  test('asks with a POST whose form holds exactly the client id, secret and access token, and the secret goes nowhere else', async () => {
    t = await createKeycloakApp({ keycloak: { brokerApi: 'v2' } })
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect((await t.h.get(REPO)).status).toBe(200)
    const [request] = brokerRequests()
    expect(request.method).toBe('POST')
    expect(request.url).toBe(`${t.kc.issuer}/broker/github/token`)
    expect(request.url).not.toContain(t.kc.clientSecret)
    const form = new URLSearchParams(request.body)
    expect([...form.keys()].sort()).toEqual(['client_id', 'client_secret', 'token'])
    expect(form.get('client_id')).toBe(t.kc.clientId)
    expect(form.get('client_secret')).toBe(t.kc.clientSecret)
    expect(form.get('token')).toBe(t.kc.acceptedAccessToken())
    expect(request.headers.authorization).toBeUndefined()
    expect(t.h.logs.join('\n')).not.toContain(t.kc.clientSecret)
    expect(githubRequests()[0].headers.authorization).toBe(`Bearer ${BROKERED}`)
  })
})

describe('the response', () => {
  test('relays status, body and the rate limit headers, and nothing else of GitHub', async () => {
    await signedIn()
    t.kc.github = () =>
      new Response('[{"number":1}]', {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': '1790000000',
          'x-ratelimit-used': '1',
          'retry-after': '7',
          'set-cookie': 'tracker=1',
          etag: '"abc"',
          'x-github-request-id': 'ABCD',
          'access-control-allow-origin': '*',
        },
      })
    const response = await t.h.get(ISSUES)
    expect(await response.json()).toEqual([{ number: 1 }])
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    for (const [name, value] of [
      ['x-ratelimit-limit', '5000'],
      ['x-ratelimit-remaining', '4999'],
      ['x-ratelimit-reset', '1790000000'],
      ['x-ratelimit-used', '1'],
      ['retry-after', '7'],
    ]) {
      expect(response.headers.get(name)).toBe(value)
    }
    for (const name of ['set-cookie', 'etag', 'x-github-request-id', 'access-control-allow-origin']) {
      expect(response.headers.get(name)).toBeNull()
    }
  })

  test('relays GitHub error statuses and bodies as they are', async () => {
    await signedIn()
    for (const status of [403, 404, 422]) {
      t.kc.github = () => new Response(`{"message":"gh ${status}"}`, { status, headers: { 'content-type': 'application/json' } })
      const response = await t.h.get(REPO)
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ message: `gh ${status}` })
    }
  })

  test('rewrites Link headers to relative urls and drops other hosts', async () => {
    await signedIn()
    t.kc.github = () =>
      new Response('[]', {
        headers: {
          link:
            '<https://api.github.com/repositories/237159/issues?state=open&per_page=2&after=Y3Vyc29yOnYy%3D&page=2>; rel="next", ' +
            '<https://api.github.com/repositories/237159/issues?state=open&per_page=2&page=9>; rel="last", ' +
            '<https://evil.example/steal?token=1>; rel="prev"',
        },
      })
    const response = await t.h.get(ISSUES)
    expect(response.headers.get('link')).toBe(
      '<api/github/repositories/237159/issues?state=open&per_page=2&after=Y3Vyc29yOnYy%3D&page=2>; rel="next", ' +
        '<api/github/repositories/237159/issues?state=open&per_page=2&page=9>; rel="last"',
    )
  })

  test('a GitHub network failure is 503 unavailable', async () => {
    await signedIn()
    t.kc.github = () => {
      throw new TypeError('connect ECONNREFUSED')
    }
    const response = await t.h.get(REPO)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'unavailable' })
  })
})

describe('GitHub answering 401', () => {
  test('a rejected token is not sent again when the broker cannot supply a new one', async () => {
    await signedIn()
    t.kc.github = () => new Response('{"message":"Bad credentials"}', { status: 401 })
    t.kc.broker = { status: 503, body: '' }
    const first = await t.h.get(REPO)
    expect(first.status).toBe(424)
    expect(await first.json()).toMatchObject({ problem: 'unavailable' })
    expect(githubRequests()).toHaveLength(1)
    // The broker recovers: the next read fetches a token instead of reusing the rejected one.
    t.kc.broker = { status: 200, body: JSON.stringify({ access_token: 'gho_replacement' }) }
    t.kc.github = () => new Response('{"ok":true}')
    expect((await t.h.get(REPO)).status).toBe(200)
    expect(githubRequests().map((request) => request.headers.authorization)).toEqual([`Bearer ${BROKERED}`, 'Bearer gho_replacement'])
  })

  test('the cached token is dropped, a fresh one fetched and the request retried once', async () => {
    await signedIn()
    let calls = 0
    t.kc.github = () => (++calls === 1 ? new Response('{"message":"Bad credentials"}', { status: 401 }) : new Response('{"ok":true}'))
    t.kc.broker = { status: 200, body: JSON.stringify({ access_token: 'gho_second_token' }) }
    const response = await t.h.get(REPO)
    expect(response.status).toBe(200)
    expect(githubRequests().map((request) => request.headers.authorization)).toEqual([`Bearer ${BROKERED}`, 'Bearer gho_second_token'])
  })

  test('a second 401 is returned as it is, without a third attempt', async () => {
    await signedIn()
    t.kc.github = () => new Response('{"message":"Bad credentials"}', { status: 401 })
    const response = await t.h.get(REPO)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Bad credentials' })
    expect(githubRequests()).toHaveLength(2)
  })
})

describe('Keycloak problems', () => {
  async function problem(): Promise<GitHubAccessError> {
    const response = await t.h.get(REPO)
    expect(response.status).toBe(424)
    expect(githubRequests()).toEqual([])
    return (await response.json()) as GitHubAccessError
  }

  test('not-linked and refused are reported without asking Keycloak again', async () => {
    t = await createKeycloakApp()
    t.kc.broker = { status: 400, body: '{"errorMessage":"User [x] is not associated with identity provider [github]."}' }
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    const before = brokerRequests().length
    expect(await problem()).toMatchObject({ error: 'github-access', problem: 'not-linked' })
    expect(brokerRequests().length).toBe(before)
  })

  test('refused', async () => {
    t = await createKeycloakApp()
    t.kc.broker = { status: 403, body: '{"errorMessage":"nope"}' }
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect(await problem()).toMatchObject({ problem: 'refused' })
  })

  test('a lost grant (server restart) is signin-expired', async () => {
    await signedIn()
    const { id_hash: idHash } = await t.h.database.db.selectFrom('sessions').select('id_hash').executeTakeFirstOrThrow()
    t.h.grants.delete(idHash)
    expect(await problem()).toMatchObject({ problem: 'signin-expired' })
  })

  test('an unreachable broker is unavailable, and the grant survives for a retry', async () => {
    t = await createKeycloakApp()
    t.kc.broker = { status: 503, body: '' }
    await keycloakSignIn(t.h, t.kc, OCTOCAT)
    expect(await problem()).toMatchObject({ problem: 'unavailable' })
    t.kc.broker = { status: 200, body: JSON.stringify({ access_token: BROKERED }) }
    expect((await t.h.get(REPO)).status).toBe(200)
  })

  test('an expired access token is refreshed before the broker is called', async () => {
    await signedIn({ accessLifetime: 60 })
    // Past the access token's lifetime and the cached GitHub token's five minutes.
    t.h.clock.advance(5 * 60 * 1000 + 1)
    expect((await t.h.get(REPO)).status).toBe(200)
    expect(t.kc.tokenRequests('refresh_token')).toBe(1)
  })

  test('a broker that rejects the access token triggers one refresh and a retry', async () => {
    await signedIn()
    // Keycloak revoked the access token early: the broker says invalid until a refresh issues another.
    const { id_hash: idHash } = await t.h.database.db.selectFrom('sessions').select('id_hash').executeTakeFirstOrThrow()
    const stored = t.h.grants.get(idHash)!
    stored.accessToken = 'revoked-access-token'
    stored.github = null
    expect((await t.h.get(REPO)).status).toBe(200)
    expect(t.kc.tokenRequests('refresh_token')).toBe(1)
  })

  test('a refresh Keycloak refuses ends the grant: signin-expired from then on', async () => {
    await signedIn()
    const { id_hash: idHash } = await t.h.database.db.selectFrom('sessions').select('id_hash').executeTakeFirstOrThrow()
    t.h.grants.get(idHash)!.accessToken = 'revoked-access-token'
    t.h.grants.get(idHash)!.github = null
    t.kc.refreshFails = true
    const first = await t.h.get(REPO)
    expect(first.status).toBe(424)
    expect(await first.json()).toMatchObject({ problem: 'signin-expired' })
    expect(t.h.grants.get(idHash)).toBeUndefined()
    expect(await (await t.h.get('/api/session')).json()).toMatchObject({
      signedIn: true,
      session: { githubAccess: { mode: 'browser', problem: 'signin-expired' } },
    })
  })
})

describe('the GitHub token stays on the server', () => {
  test('it is not in a response body or header, a log line, a URL or the database', async () => {
    await signedIn()
    t.kc.github = () => new Response('[{"number":1}]', { headers: { 'content-type': 'application/json' } })
    const responses = [await t.h.get(ISSUES), await t.h.get(REPO), await t.h.get('/api/session'), await t.h.get('/api/config')]
    responses.push(await t.h.get('/api/github/user'), await t.h.post('/api/auth/sign-out'))
    for (const response of responses) {
      expect(JSON.stringify([...response.headers.entries()])).not.toContain(BROKERED)
      expect(await response.text()).not.toContain(BROKERED)
    }
    expect(t.h.logs.join('\n')).not.toContain(BROKERED)
    for (const entry of t.kc.requests) expect(entry.url).not.toContain(BROKERED)
    // The token appears once per upstream call, in the Authorization header and nowhere else of what the server sent.
    for (const entry of t.kc.requests) {
      const rest = { ...entry, headers: { ...entry.headers, authorization: '' } }
      expect(JSON.stringify(rest)).not.toContain(BROKERED)
    }
    const dump = JSON.stringify(
      await Promise.all(
        ['users', 'sessions', 'identities', 'invites', 'boards', 'meta', 'instance_claim'].map((table) =>
          t.h.database.db.selectFrom(table as 'users').selectAll().execute(),
        ),
      ),
    )
    expect(dump).not.toContain(BROKERED)
  })

  test('the logger redacts nothing it was never given: a failing GitHub call logs only the error name', async () => {
    await signedIn()
    t.kc.github = () => {
      throw new TypeError(`connect failed for Bearer ${BROKERED}`)
    }
    await t.h.get(REPO)
    expect(t.h.logs.join('\n')).toContain('github request failed')
    expect(t.h.logs.join('\n')).not.toContain(BROKERED)
  })
})
