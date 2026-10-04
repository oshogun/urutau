import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CreateIssueResponse, GitHubRejectedError, IssueUpdateRejectedError } from '../../src/domain/api.ts'
import type { Keycloak } from '../oidc/keycloak.ts'
import { issuesPathFor } from '../github/newIssue.ts'
import { createFakeKeycloak } from '../oidc/fakeKeycloak.ts'
import { createKeycloakApp, keycloakSignIn, PUBLIC_URL, type KeycloakTestApp } from '../oidc/support.ts'
import { createTestApp } from '../testing/harness.ts'

const held = vi.hoisted(() => ({ keycloak: null as unknown }))
vi.mock('../oidc/keycloak.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../oidc/keycloak.ts')>()
  return {
    ...original,
    createKeycloak: (deps: Parameters<typeof original.createKeycloak>[0]) => {
      held.keycloak = original.createKeycloak(deps)
      return held.keycloak
    },
  }
})

const BROKERED = 'gho_brokered_token_value'
const OCTOCAT = { sub: 'kc-sub-octocat-0001', preferred_username: 'octocat', name: 'The Octocat' }
const PATH = '/api/issues/acme/widgets'
const CREATED = { number: 19, title: 'Crash on save', body: 'Steps', state: 'open', html_url: 'https://github.com/acme/widgets/issues/19' }
const ADMIN = { username: 'admin', password: 'correct horse battery' }

let t: KeycloakTestApp
afterEach(async () => {
  vi.restoreAllMocks()
  await t.h.close()
})

async function signedIn(on = true): Promise<void> {
  t = await createKeycloakApp()
  // The first account is the admin; sign in through Keycloak as a second one and turn the switch on from a local admin client.
  const admin = t.h.newClient()
  expect((await admin.post('/api/auth/first-run', ADMIN)).status).toBe(201)
  await keycloakSignIn(t.h, t.kc, OCTOCAT)
  if (on) expect((await admin.send('PATCH', '/api/settings', { githubWrites: true })).status).toBe(200)
  t.kc.github = () => new Response(JSON.stringify(CREATED), { status: 201, headers: { 'content-type': 'application/json' } })
}

const githubRequests = () => t.kc.to('api.github.com')
const brokerRequests = () => t.kc.requests.filter((request) => request.url.includes('/broker/'))
const keycloak = () => held.keycloak as Keycloak
const create = (body: unknown = { title: 'Crash on save', body: 'Steps' }, path = PATH) => t.h.post(path, body)
const json = (response: Response) => response.json() as Promise<Record<string, unknown>>

describe('who may create', () => {
  test('a signed-out request is 401', async () => {
    await signedIn()
    const response = await t.h.newClient().post(PATH, { title: 'x' })
    expect(response.status).toBe(401)
    expect(githubRequests()).toEqual([])
  })

  test('a request without the CSRF token is 403 csrf-rejected', async () => {
    await signedIn()
    const response = await t.h.post(PATH, { title: 'x' }, { 'X-Urutau-CSRF': 'wrong' })
    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({ error: 'csrf-rejected' })
    expect(githubRequests()).toEqual([])
  })

  test('a local account is 403 forbidden', async () => {
    t = await createKeycloakApp()
    expect((await t.h.post('/api/auth/first-run', ADMIN)).status).toBe(201)
    expect((await t.h.send('PATCH', '/api/settings', { githubWrites: true })).status).toBe(200)
    const response = await create()
    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({ error: 'forbidden' })
    expect(githubRequests()).toEqual([])
  })

  test('with the switch off it is 403 github-writes-off and nothing is sent', async () => {
    await signedIn(false)
    const before = brokerRequests().length
    const response = await create()
    expect(response.status).toBe(403)
    expect(await json(response)).toMatchObject({ error: 'github-writes-off', message: 'The admin has not turned on creating issues on GitHub.' })
    expect(githubRequests()).toEqual([])
    expect(brokerRequests()).toHaveLength(before)
  })

  test('GET and HEAD on the path are 404', async () => {
    await signedIn()
    expect((await t.h.get(PATH)).status).toBe(404)
    expect((await t.h.send('HEAD', PATH)).status).toBe(404)
    expect(githubRequests()).toEqual([])
  })
})

describe('the fields', () => {
  const emoji = (count: number) => '\u{1F600}'.repeat(count)
  const invalid: [string, unknown][] = [
    ['no title', {}],
    ['a blank title', { title: '   ' }],
    ['a title that is not text', { title: 4 }],
    ['a title of 257 code points', { title: 'a'.repeat(257) }],
    ['a body of 65537 code points', { title: 'ok', body: 'a'.repeat(65_537) }],
    ['a body that is not text', { title: 'ok', body: 4 }],
    ['a labels key', { title: 'ok', labels: ['bug'] }],
    ['an assignees key', { title: 'ok', assignees: ['ada'] }],
    ['an array', ['title']],
    ['a string', '"title"'],
    ['text that is not JSON', 'not json'],
  ]
  test.each(invalid)('%s is 400 and nothing is sent', async (_name, body) => {
    await signedIn()
    const response = await create(body)
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: 'invalid-request' })
    expect(githubRequests()).toEqual([])
  })

  test('the error message never quotes the content', async () => {
    await signedIn()
    const response = await create({ title: 'secret-title', labels: ['secret-label'] })
    expect(JSON.stringify(await json(response))).not.toContain('secret')
  })

  test.each([
    ['a name of .. (the URL is normalised before routing)', '/api/issues/acme/..', 404],
    ['a name of . (the URL is normalised before routing)', '/api/issues/acme/.', 404],
    ['an owner with an encoded slash', '/api/issues/acme%2Fx/widgets', 400],
    ['an owner with a leading dash', '/api/issues/-bad/widgets', 400],
  ])('%s gives %i and nothing is sent', async (_name, path, status) => {
    await signedIn()
    const response = await create({ title: 'ok' }, path)
    expect(response.status).toBe(status)
    expect(githubRequests()).toEqual([])
  })

  test('issuesPathFor refuses dot names and an owner with a slash, and accepts a repository', () => {
    expect(issuesPathFor('acme', '..')).toBeNull()
    expect(issuesPathFor('acme', '.')).toBeNull()
    expect(issuesPathFor('acme/x', 'widgets')).toBeNull()
    expect(issuesPathFor('acme', 'widgets')).toBe('repos/acme/widgets/issues')
  })

  test('a title of 256 emoji and a body of 65536 emoji pass', async () => {
    await signedIn()
    const response = await create({ title: emoji(256), body: emoji(65_536) })
    expect(response.status).toBe(201)
    expect(JSON.parse(githubRequests()[0].body)).toEqual({ title: emoji(256), body: emoji(65_536) })
  })
})

describe('the request to GitHub', () => {
  test('is exactly one POST to api.github.com with only the title and the body', async () => {
    await signedIn()
    const response = await create({ title: '  Crash on save  ', body: '  Steps\n' })
    expect(response.status).toBe(201)
    expect(await json(response)).toEqual({ issue: CREATED } satisfies CreateIssueResponse)
    expect(githubRequests()).toHaveLength(1)
    const [request] = githubRequests()
    expect(request.url).toBe('https://api.github.com/repos/acme/widgets/issues')
    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({
      authorization: `Bearer ${BROKERED}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'urutau',
      'content-type': 'application/json',
    })
    expect(JSON.parse(request.body)).toEqual({ title: 'Crash on save', body: '  Steps\n' })
  })

  test('a blank body is left out', async () => {
    await signedIn()
    await create({ title: 'Only a title', body: '  \n ' })
    expect(JSON.parse(githubRequests()[0].body)).toEqual({ title: 'Only a title' })
  })

  test('uses redirect error and a timeout signal', async () => {
    const kc = createFakeKeycloak()
    const calls: RequestInit[] = []
    const wrapped = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://api.github.com/')) calls.push(init ?? {})
      return kc.fetch(input, init)
    }) as typeof fetch
    const keycloakConfig = { issuer: kc.issuer, clientId: kc.clientId, clientSecret: kc.clientSecret, githubIdpAlias: 'github', brokerApi: 'v1' as const, allowHttp: false }
    const h = await createTestApp({ config: { publicUrl: PUBLIC_URL, keycloak: keycloakConfig }, fetch: wrapped })
    t = { h, kc }
    expect((await h.post('/api/auth/first-run', ADMIN)).status).toBe(201)
    expect((await h.send('PATCH', '/api/settings', { githubWrites: true })).status).toBe(200)
    await keycloakSignIn(h, kc, OCTOCAT)
    kc.github = () => new Response(JSON.stringify(CREATED), { status: 201 })
    expect((await create()).status).toBe(201)
    expect(calls).toHaveLength(1)
    expect(calls[0].redirect).toBe('error')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  test('a 2xx that is not JSON gives 201 with a null issue', async () => {
    await signedIn()
    t.kc.github = () => new Response('created', { status: 201 })
    const response = await create()
    expect(response.status).toBe(201)
    expect(await json(response)).toEqual({ issue: null })
  })
})

describe('GitHub answering 401', () => {
  test('one fresh token and one resend, then the answer', async () => {
    await signedIn()
    let calls = 0
    t.kc.github = () => (++calls === 1 ? new Response('{"message":"Bad credentials"}', { status: 401 }) : new Response(JSON.stringify(CREATED), { status: 201 }))
    t.kc.broker = { status: 200, body: JSON.stringify({ access_token: 'gho_second_token' }) }
    const fresh = vi.spyOn(keycloak(), 'githubToken')
    const response = await create()
    expect(response.status).toBe(201)
    expect(githubRequests().map((request) => request.headers.authorization)).toEqual([`Bearer ${BROKERED}`, 'Bearer gho_second_token'])
    expect(fresh.mock.calls.filter(([, options]) => options?.fresh === true)).toHaveLength(1)
  })

  test('a 401 whose body stream errored still gets the fresh-token resend', async () => {
    await signedIn()
    let calls = 0
    t.kc.github = () =>
      ++calls === 1
        ? new Response(new ReadableStream({ start: (controller) => controller.error(new Error('stream broke')) }), { status: 401 })
        : new Response(JSON.stringify(CREATED), { status: 201 })
    const response = await create()
    expect(response.status).toBe(201)
    expect(githubRequests()).toHaveLength(2)
  })

  test('a second 401 is 502 github-rejected with status 401 and no third call', async () => {
    await signedIn()
    t.kc.github = () => new Response('{"message":"Bad credentials"}', { status: 401 })
    const response = await create()
    expect(response.status).toBe(502)
    const body = (await response.json()) as GitHubRejectedError
    expect(body).toMatchObject({ error: 'github-rejected', message: 'GitHub refused the request.' })
    expect(body.github.status).toBe(401)
    expect(githubRequests()).toHaveLength(2)
  })

  test('a broker problem while fetching the fresh token is 424 after one request', async () => {
    await signedIn()
    t.kc.github = () => new Response('{}', { status: 401 })
    t.kc.broker = { status: 503, body: '' }
    const response = await create()
    expect(response.status).toBe(424)
    expect(githubRequests()).toHaveLength(1)
  })
})

describe('failures', () => {
  test('a 403 with retry-after is 502 with retryAfter', async () => {
    await signedIn()
    t.kc.github = () =>
      new Response('{"message":"You have exceeded a secondary rate limit."}', {
        status: 403,
        headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': 'soon' },
      })
    const response = await create()
    expect(response.status).toBe(502)
    expect(((await response.json()) as GitHubRejectedError).github).toEqual({
      status: 403,
      message: 'You have exceeded a secondary rate limit.',
      errors: [],
      retryAfter: 60,
      rateLimitRemaining: 4990,
      rateLimitReset: null,
    })
  })

  test('a 422 carries the first five errors, cut', async () => {
    await signedIn()
    const errors = Array.from({ length: 7 }, (_, i) => ({ resource: 'Issue', field: 'title', code: 'invalid', message: 'm'.repeat(300) + i }))
    t.kc.github = () => new Response(JSON.stringify({ message: 'Validation Failed', errors }), { status: 422 })
    const { github } = (await (await create()).json()) as GitHubRejectedError
    expect(github.status).toBe(422)
    expect(github.errors).toHaveLength(5)
    expect(github.errors[0]).toEqual({ resource: 'Issue', field: 'title', code: 'invalid', message: 'm'.repeat(200) })
  })

  test('an unreadable non-2xx body gives a null message and no errors', async () => {
    await signedIn()
    t.kc.github = () => new Response('<html>', { status: 500 })
    const { github } = (await (await create()).json()) as GitHubRejectedError
    expect(github).toMatchObject({ status: 500, message: null, errors: [] })
  })

  test('a timeout is 504 github-no-answer after exactly one call', async () => {
    await signedIn()
    t.kc.github = () => {
      throw new DOMException('timed out', 'TimeoutError')
    }
    const response = await create()
    expect(response.status).toBe(504)
    expect(await json(response)).toEqual({ error: 'github-no-answer', message: 'GitHub did not answer. The issue may have been created.' })
    expect(githubRequests()).toHaveLength(1)
    expect(t.h.logs.some((line) => line.includes('"msg":"github create failed"') && line.includes('"name":"TimeoutError"'))).toBe(true)
  })

  test('a connection failure after the 401 resend is 504', async () => {
    await signedIn()
    let calls = 0
    t.kc.github = () => {
      if (++calls === 1) return new Response('{}', { status: 401 })
      throw new TypeError('connect ECONNREFUSED')
    }
    expect((await create()).status).toBe(504)
    expect(githubRequests()).toHaveLength(2)
  })

  test('no grant is 424 github-access', async () => {
    await signedIn()
    t.h.grants.delete((await t.h.database.db.selectFrom('sessions').select('id_hash').where('auth_method', '=', 'keycloak').executeTakeFirstOrThrow()).id_hash)
    const response = await create()
    expect(response.status).toBe(424)
    expect(await json(response)).toMatchObject({ error: 'github-access', problem: 'signin-expired' })
    expect(githubRequests()).toEqual([])
  })

  test('githubToken throwing before the first request is 503 with zero calls', async () => {
    await signedIn()
    vi.spyOn(keycloak(), 'githubToken').mockRejectedValue(new Error('boom'))
    const response = await create()
    expect(response.status).toBe(503)
    expect(await json(response)).toMatchObject({ error: 'unavailable', message: 'The server could not get your GitHub token. Nothing was created on GitHub.' })
    expect(githubRequests()).toEqual([])
  })

  test('githubToken throwing for the fresh token is 503 after exactly one call', async () => {
    await signedIn()
    const real = keycloak().githubToken.bind(keycloak())
    vi.spyOn(keycloak(), 'githubToken').mockImplementation((id, options) => (options?.fresh ? Promise.reject(new Error('boom')) : real(id, options)))
    t.kc.github = () => new Response('{}', { status: 401 })
    expect((await create()).status).toBe(503)
    expect(githubRequests()).toHaveLength(1)
  })
})

describe('the proxy is unchanged', () => {
  test.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s on /api/github/repos/acme/widgets/issues is 405 and nothing is sent', async (method) => {
    await signedIn()
    const response = await t.h.send(method, '/api/github/repos/acme/widgets/issues', { title: 'x' })
    expect(response.status).toBe(405)
    expect(githubRequests()).toEqual([])
  })
})

describe('logs', () => {
  test('no line holds the token, a title or a body', async () => {
    await signedIn()
    expect((await create({ title: 'unique-title-4412', body: 'unique-body-9931' })).status).toBe(201)
    t.kc.github = () => new Response('{"message":"unique-gh-message-7781"}', { status: 422 })
    await create({ title: 'unique-title-4412', body: 'unique-body-9931' })
    t.kc.github = () => {
      throw new TypeError('unique-title-4412')
    }
    await create({ title: 'unique-title-4412', body: 'unique-body-9931' })
    const logs = t.h.logs.join('\n')
    expect(logs).toContain('issue created')
    for (const secret of [BROKERED, 'unique-title-4412', 'unique-body-9931', 'unique-gh-message-7781']) expect(logs).not.toContain(secret)
  })
})

describe('changing an issue', () => {
  const ISSUE_PATH = '/api/issues/acme/widgets/7'
  const STARTED = '2026-01-01T00:00:00Z'
  const REQUEST = { expectedUpdatedAt: STARTED, fields: { title: 'Renamed' } }
  const issue = (overrides: Record<string, unknown> = {}) => ({
    number: 7,
    title: 'Old title',
    state: 'open',
    html_url: 'https://github.com/acme/widgets/issues/7',
    labels: [],
    created_at: '2025-12-01T00:00:00Z',
    updated_at: STARTED,
    ...overrides,
  })
  const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const patch = (body: unknown = REQUEST, path = ISSUE_PATH) => t.h.send('PATCH', path, body)
  const sent = () => githubRequests().map((request) => request.method)

  /** GitHub answers the check with `check` and the write with `write`, each a response or a function of the call count. */
  function github(check: () => Response, write: () => Response) {
    t.kc.github = (request) => (request.method === 'GET' ? check() : write())
  }
  async function ready(on = true) {
    await signedIn(on)
    github(() => jsonResponse(issue()), () => jsonResponse(issue({ title: 'Renamed', updated_at: '2026-01-02T00:00:00Z' })))
  }

  describe('who may change', () => {
    test('a signed-out request is 401', async () => {
      await ready()
      const response = await t.h.newClient().send('PATCH', ISSUE_PATH, REQUEST)
      expect(response.status).toBe(401)
      expect(githubRequests()).toEqual([])
    })

    test('a request without the CSRF token is 403 csrf-rejected', async () => {
      await ready()
      const response = await t.h.send('PATCH', ISSUE_PATH, REQUEST, { 'X-Urutau-CSRF': 'wrong' })
      expect(response.status).toBe(403)
      expect(await json(response)).toMatchObject({ error: 'csrf-rejected' })
      expect(githubRequests()).toEqual([])
    })

    test('a local account is 403 forbidden', async () => {
      t = await createKeycloakApp()
      expect((await t.h.post('/api/auth/first-run', ADMIN)).status).toBe(201)
      expect((await t.h.send('PATCH', '/api/settings', { githubWrites: true })).status).toBe(200)
      const response = await patch()
      expect(response.status).toBe(403)
      expect(await json(response)).toMatchObject({ error: 'forbidden', message: 'This account changes issues from the browser.' })
      expect(githubRequests()).toEqual([])
    })

    test('with the switch off it is 403 github-writes-off and nothing is fetched', async () => {
      await ready(false)
      const before = brokerRequests().length
      const response = await patch()
      expect(response.status).toBe(403)
      expect(await json(response)).toMatchObject({ error: 'github-writes-off', message: 'The admin has not turned on changing issues on GitHub.' })
      expect(githubRequests()).toEqual([])
      expect(brokerRequests()).toHaveLength(before)
    })
  })

  describe('the request body and path', () => {
    const invalid: [string, unknown][] = [
      ['no fields key', { expectedUpdatedAt: STARTED }],
      ['no expectedUpdatedAt', { fields: { title: 'x' } }],
      ['an extra key', { ...REQUEST, extra: 1 }],
      ['a time that is not a time', { ...REQUEST, expectedUpdatedAt: 'yesterday' }],
      ['empty fields', { expectedUpdatedAt: STARTED, fields: {} }],
      ['a labels key', { expectedUpdatedAt: STARTED, fields: { title: 'x', labels: ['bug'] } }],
      ['a blank title', { expectedUpdatedAt: STARTED, fields: { title: '  ' } }],
      ['state without a reason', { expectedUpdatedAt: STARTED, fields: { state: 'closed' } }],
      ['a reason that does not fit', { expectedUpdatedAt: STARTED, fields: { state: 'open', state_reason: 'completed' } }],
      ['a body of 65537 code points', { expectedUpdatedAt: STARTED, fields: { body: 'a'.repeat(65_537) } }],
      ['an array', []],
      ['text that is not JSON', 'not json'],
    ]
    test.each(invalid)('%s is 400 and nothing is sent', async (_name, body) => {
      await ready()
      const before = brokerRequests().length
      const response = await patch(body)
      expect(response.status).toBe(400)
      expect(await json(response)).toMatchObject({ error: 'invalid-request' })
      expect(githubRequests()).toEqual([])
      expect(brokerRequests()).toHaveLength(before)
    })

    test('the error message never quotes the content', async () => {
      await ready()
      const response = await patch({ expectedUpdatedAt: STARTED, fields: { title: 'secret-title', labels: ['secret-label'] } })
      expect(JSON.stringify(await json(response))).not.toContain('secret')
    })

    test.each([
      ['an owner with an encoded slash', '/api/issues/acme%2Fx/widgets/7', 400],
      ['an owner with a leading dash', '/api/issues/-bad/widgets/7', 400],
      ['number zero', '/api/issues/acme/widgets/0', 400],
      ['a number with a leading zero', '/api/issues/acme/widgets/07', 400],
      ['a number that is not digits', '/api/issues/acme/widgets/7x', 400],
      ['a number above 2147483647', '/api/issues/acme/widgets/2147483648', 400],
      ['an extra path segment', '/api/issues/acme/widgets/7/comments', 404],
    ])('%s gives %i and nothing is sent', async (_name, path, status) => {
      await ready()
      const response = await patch(REQUEST, path)
      expect(response.status).toBe(status)
      expect(githubRequests()).toEqual([])
    })

    test('the largest number passes, and a body of 65536 emoji passes', async () => {
      await ready()
      const emoji = '\u{1F600}'.repeat(65_536)
      expect((await patch({ expectedUpdatedAt: STARTED, fields: { body: emoji } }, '/api/issues/acme/widgets/2147483647')).status).toBe(200)
      expect(githubRequests()[1].url).toBe('https://api.github.com/repos/acme/widgets/issues/2147483647')
      expect(JSON.parse(githubRequests()[1].body)).toEqual({ body: emoji })
    })
  })

  describe('the requests to GitHub', () => {
    test('a check and then a write, with the brokered token, only the changed fields and the answer returned', async () => {
      await ready()
      const response = await patch({ expectedUpdatedAt: STARTED, fields: { title: '  Renamed  ', state: 'closed', state_reason: 'not_planned' } })
      expect(response.status).toBe(200)
      expect(await json(response)).toEqual({ issue: issue({ title: 'Renamed', updated_at: '2026-01-02T00:00:00Z' }) })
      expect(sent()).toEqual(['GET', 'PATCH'])
      for (const request of githubRequests()) {
        expect(request.url).toBe('https://api.github.com/repos/acme/widgets/issues/7')
        expect(request.headers).toMatchObject({
          authorization: `Bearer ${BROKERED}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'urutau',
        })
      }
      expect(githubRequests()[0].body).toBe('')
      expect(githubRequests()[1].headers['content-type']).toBe('application/json')
      expect(JSON.parse(githubRequests()[1].body)).toEqual({ title: 'Renamed', state: 'closed', state_reason: 'not_planned' })
    })

    test('the same instant written two ways passes the check', async () => {
      await ready()
      github(() => jsonResponse(issue({ updated_at: '2026-01-01T00:00:00.000Z' })), () => jsonResponse(issue()))
      expect((await patch()).status).toBe(200)
      expect(sent()).toEqual(['GET', 'PATCH'])
    })

    test('both requests use redirect manual and a timeout signal', async () => {
      const kc = createFakeKeycloak()
      const calls: RequestInit[] = []
      const wrapped = ((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith('https://api.github.com/')) calls.push(init ?? {})
        return kc.fetch(input, init)
      }) as typeof fetch
      const keycloakConfig = { issuer: kc.issuer, clientId: kc.clientId, clientSecret: kc.clientSecret, githubIdpAlias: 'github', brokerApi: 'v1' as const, allowHttp: false }
      const h = await createTestApp({ config: { publicUrl: PUBLIC_URL, keycloak: keycloakConfig }, fetch: wrapped })
      t = { h, kc }
      expect((await h.post('/api/auth/first-run', ADMIN)).status).toBe(201)
      expect((await h.send('PATCH', '/api/settings', { githubWrites: true })).status).toBe(200)
      await keycloakSignIn(h, kc, OCTOCAT)
      github(() => jsonResponse(issue()), () => jsonResponse(issue()))
      expect((await patch()).status).toBe(200)
      expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH'])
      for (const call of calls) {
        expect(call.redirect).toBe('manual')
        expect(call.signal).toBeInstanceOf(AbortSignal)
      }
    })

    test('a write answer that is not JSON gives 200 with a null issue', async () => {
      await ready()
      github(() => jsonResponse(issue()), () => new Response('ok', { status: 200 }))
      const response = await patch()
      expect(response.status).toBe(200)
      expect(await json(response)).toEqual({ issue: null })
    })
  })

  describe('the stale check', () => {
    test('a newer updated_at is 409 stale-issue with GitHub issue and no PATCH', async () => {
      await ready()
      const theirs = issue({ title: 'Theirs', updated_at: '2026-01-03T00:00:00Z' })
      github(() => jsonResponse(theirs), () => jsonResponse(issue()))
      const response = await patch()
      expect(response.status).toBe(409)
      expect(await json(response)).toEqual({
        error: 'stale-issue',
        message: 'The issue changed on GitHub since this change started. Nothing was sent.',
        current: theirs,
      })
      expect(sent()).toEqual(['GET'])
    })

    test('an older updated_at is stale too', async () => {
      await ready()
      github(() => jsonResponse(issue({ updated_at: '2025-12-31T00:00:00Z' })), () => jsonResponse(issue()))
      expect((await patch()).status).toBe(409)
      expect(sent()).toEqual(['GET'])
    })

    test('a pull request is 400 and an unreadable answer is 503, with no PATCH', async () => {
      await ready()
      github(() => jsonResponse({ ...issue(), pull_request: {} }), () => jsonResponse(issue()))
      const pull = await patch()
      expect(pull.status).toBe(400)
      expect(await json(pull)).toMatchObject({ error: 'invalid-request', message: 'That number is a pull request, not an issue.' })

      for (const unreadable of [new Response('<html>', { status: 200 }), jsonResponse({ title: 'no time' }), jsonResponse([])]) {
        github(() => unreadable.clone(), () => jsonResponse(issue()))
        const response = await patch()
        expect(response.status).toBe(503)
        expect(await json(response)).toMatchObject({ error: 'unavailable', message: "GitHub's answer about the issue could not be read. Nothing was changed." })
      }
      expect(sent().filter((method) => method === 'PATCH')).toEqual([])
    })
  })

  describe('GitHub refusing', () => {
    const rejection = async (response: Response) => (await response.json()) as IssueUpdateRejectedError

    test.each([403, 404, 410, 500])('a %i on the check is 502 with step check and no PATCH', async (status) => {
      await ready()
      github(() => jsonResponse({ message: 'nope' }, status), () => jsonResponse(issue()))
      const response = await patch()
      expect(response.status).toBe(502)
      const body = await rejection(response)
      expect(body).toMatchObject({ error: 'github-rejected', step: 'check', github: { status, message: 'nope' } })
      expect(sent()).toEqual(['GET'])
    })

    test('a redirect on the check is 502 with step check and the redirect is not followed', async () => {
      await ready()
      github(() => new Response('', { status: 301, headers: { location: 'https://api.github.com/elsewhere' } }), () => jsonResponse(issue()))
      const response = await patch()
      expect(response.status).toBe(502)
      expect(await rejection(response)).toMatchObject({ step: 'check', github: { status: 301 } })
      expect(sent()).toEqual(['GET'])
    })

    test.each([403, 404, 410, 422, 500])('a %i on the write is 502 with step write after one check and one PATCH', async (status) => {
      await ready()
      github(() => jsonResponse(issue()), () => jsonResponse({ message: 'nope' }, status))
      const response = await patch()
      expect(response.status).toBe(502)
      expect(await rejection(response)).toMatchObject({ error: 'github-rejected', step: 'write', github: { status, message: 'nope' } })
      expect(sent()).toEqual(['GET', 'PATCH'])
    })

    test('a redirect on the write is 502 with step write', async () => {
      await ready()
      github(() => jsonResponse(issue()), () => new Response('', { status: 308, headers: { location: 'https://api.github.com/elsewhere' } }))
      expect(await rejection(await patch())).toMatchObject({ step: 'write', github: { status: 308 } })
    })

    test('a rate limit carries the headers, cut and numeric', async () => {
      await ready()
      github(() => jsonResponse(issue()), () => jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000', 'retry-after': 'soon' }))
      expect((await rejection(await patch())).github).toEqual({
        status: 403,
        message: 'API rate limit exceeded',
        errors: [],
        retryAfter: null,
        rateLimitRemaining: 0,
        rateLimitReset: 1_790_000_000,
      })
    })

    test('a 422 carries the first five errors, cut', async () => {
      await ready()
      const errors = Array.from({ length: 7 }, (_, i) => ({ resource: 'Issue', field: 'title', code: 'invalid', message: 'm'.repeat(300) + i }))
      github(() => jsonResponse(issue()), () => jsonResponse({ message: 'Validation Failed', errors }, 422))
      const { github: detail } = await rejection(await patch())
      expect(detail.errors).toHaveLength(5)
      expect(detail.errors[0]).toEqual({ resource: 'Issue', field: 'title', code: 'invalid', message: 'm'.repeat(200) })
    })
  })

  describe('no answer from GitHub', () => {
    const timeout = () => {
      throw new DOMException('timed out', 'TimeoutError')
    }

    test('a timeout on the check is 503 after one request and nothing is sent', async () => {
      await ready()
      github(timeout, () => jsonResponse(issue()))
      const response = await patch()
      expect(response.status).toBe(503)
      expect(await json(response)).toMatchObject({ error: 'unavailable', message: 'GitHub did not answer the check. Nothing was changed.' })
      expect(sent()).toEqual(['GET'])
      expect(t.h.logs.some((line) => line.includes('"msg":"github update failed"') && line.includes('"name":"TimeoutError"'))).toBe(true)
    })

    test('a timeout on the write is 504 github-no-answer and is not retried', async () => {
      await ready()
      github(() => jsonResponse(issue()), timeout)
      const response = await patch()
      expect(response.status).toBe(504)
      expect(await json(response)).toEqual({ error: 'github-no-answer', message: 'GitHub did not answer. The change may have been applied.' })
      expect(sent()).toEqual(['GET', 'PATCH'])
    })
  })

  describe('GitHub answering 401', () => {
    const bad = () => jsonResponse({ message: 'Bad credentials' }, 401)
    const tokens = () => githubRequests().map((request) => request.headers.authorization)
    const fresh = () => vi.spyOn(keycloak(), 'githubToken')
    const freshCalls = (spy: ReturnType<typeof fresh>) => spy.mock.calls.filter(([, options]) => options?.fresh === true).length

    test('a 401 on the check: one fresh token, the check again with it, then the write', async () => {
      await ready()
      let checks = 0
      github(() => (++checks === 1 ? bad() : jsonResponse(issue())), () => jsonResponse(issue({ title: 'Renamed' })))
      t.kc.broker = { status: 200, body: JSON.stringify({ access_token: 'gho_second_token' }) }
      const spy = fresh()
      const response = await patch()
      expect(response.status).toBe(200)
      expect(sent()).toEqual(['GET', 'GET', 'PATCH'])
      expect(tokens()).toEqual([`Bearer ${BROKERED}`, 'Bearer gho_second_token', 'Bearer gho_second_token'])
      expect(freshCalls(spy)).toBe(1)
    })

    test('a 401 on the write: a fresh token, the check again with it, then the write again', async () => {
      await ready()
      let writes = 0
      github(() => jsonResponse(issue()), () => (++writes === 1 ? bad() : jsonResponse(issue({ title: 'Renamed' }))))
      t.kc.broker = { status: 200, body: JSON.stringify({ access_token: 'gho_second_token' }) }
      const spy = fresh()
      const response = await patch()
      expect(response.status).toBe(200)
      expect(sent()).toEqual(['GET', 'PATCH', 'GET', 'PATCH'])
      expect(tokens()).toEqual([`Bearer ${BROKERED}`, `Bearer ${BROKERED}`, 'Bearer gho_second_token', 'Bearer gho_second_token'])
      expect(freshCalls(spy)).toBe(1)
    })

    test('a change on GitHub during the fresh-token fetch is 409 and the second write is never sent', async () => {
      await ready()
      let checks = 0
      let writes = 0
      github(
        () => (++checks === 1 ? jsonResponse(issue()) : jsonResponse(issue({ updated_at: '2026-01-04T00:00:00Z' }))),
        () => (++writes === 1 ? bad() : jsonResponse(issue())),
      )
      t.kc.broker = { status: 200, body: JSON.stringify({ access_token: 'gho_second_token' }) }
      const response = await patch()
      expect(response.status).toBe(409)
      expect(sent()).toEqual(['GET', 'PATCH', 'GET'])
    })

    test('a second 401 on the check is 502 step check with status 401, and no further request', async () => {
      await ready()
      github(bad, () => jsonResponse(issue()))
      const response = await patch()
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ step: 'check', github: { status: 401 } })
      expect(sent()).toEqual(['GET', 'GET'])
    })

    test('a second 401 on the write is 502 step write with status 401 and at most four requests', async () => {
      await ready()
      github(() => jsonResponse(issue()), bad)
      const spy = fresh()
      const response = await patch()
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ step: 'write', github: { status: 401 } })
      expect(sent()).toEqual(['GET', 'PATCH', 'GET', 'PATCH'])
      expect(freshCalls(spy)).toBe(1)
    })

    test('a 401 on the check, then a 401 on the write with the fresh token, takes no second fresh token', async () => {
      await ready()
      let checks = 0
      github(() => (++checks === 1 ? bad() : jsonResponse(issue())), bad)
      const spy = fresh()
      const response = await patch()
      expect(response.status).toBe(502)
      expect(sent()).toEqual(['GET', 'GET', 'PATCH'])
      expect(freshCalls(spy)).toBe(1)
    })

    test('a broker problem while fetching the fresh token is 424 and the write is not resent', async () => {
      await ready()
      github(() => jsonResponse(issue()), bad)
      t.kc.broker = { status: 503, body: '' }
      const response = await patch()
      expect(response.status).toBe(424)
      expect(sent()).toEqual(['GET', 'PATCH'])
    })

    test('a fresh token that throws is 503', async () => {
      await ready()
      const real = keycloak().githubToken.bind(keycloak())
      vi.spyOn(keycloak(), 'githubToken').mockImplementation((id, options) => (options?.fresh ? Promise.reject(new Error('boom')) : real(id, options)))
      github(bad, () => jsonResponse(issue()))
      const response = await patch()
      expect(response.status).toBe(503)
      expect(await json(response)).toMatchObject({ error: 'unavailable', message: 'The server could not get your GitHub token. Nothing was changed on GitHub.' })
      expect(sent()).toEqual(['GET'])
    })
  })

  describe('the token', () => {
    test('no grant is 424 github-access with nothing sent', async () => {
      await ready()
      t.h.grants.delete((await t.h.database.db.selectFrom('sessions').select('id_hash').where('auth_method', '=', 'keycloak').executeTakeFirstOrThrow()).id_hash)
      const response = await patch()
      expect(response.status).toBe(424)
      expect(await json(response)).toMatchObject({ error: 'github-access', problem: 'signin-expired' })
      expect(githubRequests()).toEqual([])
    })

    test('githubToken throwing is 503 with zero calls to GitHub', async () => {
      await ready()
      vi.spyOn(keycloak(), 'githubToken').mockRejectedValue(new Error('boom'))
      const response = await patch()
      expect(response.status).toBe(503)
      expect(githubRequests()).toEqual([])
    })

    test('no response body and no log line holds the token, a title or a GitHub message', async () => {
      await ready()
      const bodies: string[] = []
      const run = async (check: () => Response, write: () => Response, body: unknown = { expectedUpdatedAt: STARTED, fields: { title: 'unique-title-4412', body: 'unique-body-9931' } }) => {
        github(check, write)
        bodies.push(await (await patch(body)).text())
      }
      await run(() => jsonResponse(issue()), () => jsonResponse(issue({ title: 'unique-title-4412' })))
      await run(() => jsonResponse(issue()), () => jsonResponse({ message: 'unique-gh-message-7781' }, 422))
      await run(() => jsonResponse({ message: 'unique-gh-message-7781' }, 403), () => jsonResponse(issue()))
      await run(() => jsonResponse(issue({ updated_at: '2026-01-04T00:00:00Z' })), () => jsonResponse(issue()))
      await run(() => jsonResponse(issue()), () => {
        throw new TypeError('unique-title-4412')
      })
      const logs = t.h.logs.join('\n')
      expect(logs).toContain('issue updated')
      for (const secret of [BROKERED, 'unique-title-4412', 'unique-body-9931', 'unique-gh-message-7781']) expect(logs).not.toContain(secret)
      for (const text of bodies) expect(text).not.toContain(BROKERED)
      expect(t.h.logs.join('\n')).toContain('"fields":"title,body"')
    })
  })

  describe('the proxy is unchanged', () => {
    test('PATCH on /api/github/repos/acme/widgets/issues/7 is 405 and nothing is sent', async () => {
      await ready()
      const response = await t.h.send('PATCH', '/api/github/repos/acme/widgets/issues/7', { title: 'x' })
      expect(response.status).toBe(405)
      expect(githubRequests()).toEqual([])
    })
  })
})
