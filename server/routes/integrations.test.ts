import { afterEach, describe, expect, test } from 'vitest'
import type {
  CreateApiTokenResponse,
  CreateIntegrationResponse,
  IntegrationListResponse,
  SetGitHubTokenResponse,
  SetIntegrationReposResponse,
} from '../../src/domain/api.ts'
import { sha256Hex } from '../auth/tokens.ts'
import {
  ADMIN_CREDENTIALS,
  createTestApp,
  FIXTURE_GITHUB_TOKEN,
  setUpAgent,
  signInFirstAdmin,
  TEST_ENCRYPTION_KEY,
  type TestApp,
  type TestClient,
} from '../testing/harness.ts'

let h: TestApp
afterEach(async () => {
  await h.close()
})

async function setUp(withKey = true): Promise<void> {
  h = await createTestApp(withKey ? { config: { tokenEncryptionKey: TEST_ENCRYPTION_KEY } } : {})
  await signInFirstAdmin(h)
}

async function member(): Promise<TestClient> {
  const invite = (await (await h.post('/api/invites', {})).json()) as { token: string }
  const browser = h.newClient()
  expect((await browser.post('/api/invites/accept', { token: invite.token, username: 'maria', password: 'maria is signed in' })).status).toBe(201)
  return browser
}

async function list(): Promise<IntegrationListResponse> {
  return (await (await h.get('/api/integrations')).json()) as IntegrationListResponse
}

const ID = '00000000-0000-0000-0000-000000000000'

describe('who may use the integration routes', () => {
  test('exactly eight routes exist, each 403 forbidden for a member and each mutating one 403 csrf-rejected without the header', async () => {
    await setUp()
    const agent = await setUpAgent(h)
    const browser = await member()
    // Each route is listed once per handler (requireAdmin and the route's own), so the walk uses distinct method and path pairs.
    const distinct = new Map(h.app.routes.filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/integrations')).map((route) => [`${route.method} ${route.path}`, route]))
    const routes = [...distinct.values()]
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/integrations/:id',
      'DELETE /api/integrations/:id/github-token',
      'DELETE /api/integrations/:id/tokens/:tokenId',
      'GET /api/integrations',
      'POST /api/integrations',
      'POST /api/integrations/:id/tokens',
      'PUT /api/integrations/:id/github-token',
      'PUT /api/integrations/:id/repos',
    ])
    for (const route of routes) {
      const path = route.path.replace(':id', agent.id).replace(':tokenId', agent.tokenId)
      const response = await browser.send(route.method, path, route.method === 'GET' || route.method === 'DELETE' ? undefined : {})
      expect({ route: `${route.method} ${route.path}`, status: response.status }).toEqual({ route: `${route.method} ${route.path}`, status: 403 })
      expect(await response.json()).toMatchObject({ error: 'forbidden' })
      if (route.method === 'GET') continue
      const noHeader = await h.request(path, { method: route.method, headers: { 'content-type': 'application/json' }, body: route.method === 'DELETE' ? undefined : '{}' })
      expect({ route: `${route.method} ${route.path}`, status: noHeader.status }).toEqual({ route: `${route.method} ${route.path}`, status: 403 })
      expect(await noHeader.json()).toMatchObject({ error: 'csrf-rejected' })
    }
    expect((await list()).integrations).toHaveLength(1)
  })

  test('a visitor gets 401 signed-out', async () => {
    await setUp()
    const visitor = h.newClient()
    const response = await visitor.get('/api/integrations')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'signed-out' })
  })

  test('an integration id that does not exist is 404 on every route that takes one', async () => {
    await setUp()
    const calls: [string, string, unknown?][] = [
      ['DELETE', `/api/integrations/${ID}`],
      ['POST', `/api/integrations/${ID}/tokens`, { label: 'x', expiresInDays: 30 }],
      ['DELETE', `/api/integrations/${ID}/tokens/${ID}`],
      ['PUT', `/api/integrations/${ID}/github-token`, { token: FIXTURE_GITHUB_TOKEN }],
      ['DELETE', `/api/integrations/${ID}/github-token`],
      ['PUT', `/api/integrations/${ID}/repos`, { repos: [] }],
    ]
    for (const [method, path, body] of calls) {
      const response = await h.send(method, path, body)
      expect({ path, status: response.status }).toEqual({ path, status: 404 })
      expect(await response.json()).toEqual({ error: 'not-found', message: 'There is no agent integration with this id.' })
    }
    const person = await h.get('/api/users')
    const admin = ((await person.json()) as { users: { id: string }[] }).users[0]
    expect((await h.delete(`/api/integrations/${admin.id}`)).status).toBe(404)
  })
})

describe('creating and removing integrations', () => {
  test('create answers 201 with an empty integration; the name is unique in any case', async () => {
    await setUp()
    const created = await h.post('/api/integrations', { username: 'Planner-Bot' })
    expect(created.status).toBe(201)
    const body = (await created.json()) as CreateIntegrationResponse
    expect(body.integration).toMatchObject({
      username: 'Planner-Bot',
      tokens: [],
      repos: [],
      githubToken: { set: false, readable: false, status: null, updatedAt: null },
      createdBy: { username: 'admin' },
    })
    const taken = await h.post('/api/integrations', { username: 'planner-bot' })
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'username-taken', message: 'That username is already taken.' })
    expect((await h.post('/api/integrations', { username: 'admin' })).status).toBe(409)
    const row = await h.database.db.selectFrom('users').select(['is_admin', 'password_hash']).where('username_key', '=', 'planner-bot').executeTakeFirstOrThrow()
    expect(row).toEqual({ is_admin: 0, password_hash: null })
  })

  test('create refuses a missing or invalid username with invalid-request', async () => {
    await setUp()
    for (const body of [{}, { username: 5 }, { username: 'a' }, { username: 'has space' }, [] as unknown]) {
      const response = await h.post('/api/integrations', body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid-request' })
    }
    expect((await h.post('/api/integrations', { })).status).toBe(400)
    expect(((await (await h.post('/api/integrations', {})).json()) as { message: string }).message).toBe('A username is required.')
  })

  test('the list is oldest first and carries tokens, the GitHub token state and repositories', async () => {
    await setUp()
    const first = await setUpAgent(h, { username: 'first-bot', repos: ['Acme/Widgets', 'acme/gears'] })
    h.clock.advance(1000)
    await setUpAgent(h, { username: 'second-bot', githubToken: false })
    const body = await list()
    expect(body.githubTokenStorage).toBe(true)
    expect(body.integrations.map((integration) => integration.username)).toEqual(['first-bot', 'second-bot'])
    expect(body.integrations[0]).toMatchObject({
      id: first.id,
      repos: ['acme/gears', 'acme/widgets'],
      githubToken: { set: true, readable: true, status: 'unchecked' },
      tokens: [{ id: first.tokenId, label: 'laptop', lastUsedAt: null }],
    })
    expect(body.integrations[1].githubToken).toEqual({ set: false, readable: false, status: null, updatedAt: null })
  })

  test('removing an integration deletes it with its tokens, GitHub token and repositories', async () => {
    await setUp()
    const agent = await setUpAgent(h, { repos: ['acme/widgets'] })
    expect((await h.delete(`/api/integrations/${agent.id}`)).status).toBe(204)
    expect((await list()).integrations).toEqual([])
    for (const table of ['integrations', 'api_tokens', 'github_tokens', 'integration_repos'] as const) {
      expect(await h.database.db.selectFrom(table).selectAll().execute()).toEqual([])
    }
    expect((await agent.bearer.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
    expect((await h.delete(`/api/integrations/${agent.id}`)).status).toBe(404)
    expect(h.logs.some((line) => line.includes('"msg":"integration removed"'))).toBe(true)
  })
})

describe('bearer tokens', () => {
  test('the plain token is in the create response once and the database keeps only its SHA-256', async () => {
    await setUp()
    const agent = await setUpAgent(h, { githubToken: false })
    const rows = await h.database.db.selectFrom('api_tokens').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(sha256Hex(agent.secret))
    expect(JSON.stringify(rows)).not.toContain(agent.secret)

    const second = await h.post(`/api/integrations/${agent.id}/tokens`, { label: '  desk  ', expiresInDays: null })
    const created = (await second.json()) as CreateApiTokenResponse
    expect(second.status).toBe(201)
    expect(created.secret).toMatch(/^urutau_mcp_[A-Za-z0-9_-]{43}$/)
    expect(created.secret).not.toBe(agent.secret)
    expect(created.token).toMatchObject({ label: 'desk', expiresAt: null, lastUsedAt: null })

    for (const response of [await h.get('/api/integrations'), await h.get('/api/users'), await h.get('/api/session')]) {
      const text = await response.text()
      expect(text).not.toContain(agent.secret)
      expect(text).not.toContain(created.secret)
    }
    const stored = await h.database.db.selectFrom('api_tokens').select('token_hash').execute()
    for (const row of stored) {
      for (const response of [await h.get('/api/integrations')]) expect(await response.text()).not.toContain(row.token_hash)
    }
  })

  test('expiry is 30, 90, 365 days or never; list leaves out an expired token', async () => {
    await setUp()
    const agent = await setUpAgent(h, { githubToken: false })
    const day = 24 * 60 * 60 * 1000
    for (const days of [30, 90, 365]) {
      const response = await h.post(`/api/integrations/${agent.id}/tokens`, { label: `t${days}`, expiresInDays: days })
      const { token } = (await response.json()) as CreateApiTokenResponse
      expect(token.expiresAt).toBe(new Date(h.clock.now.getTime() + days * day).toISOString())
    }
    h.clock.advance(31 * day)
    expect((await h.post('/api/auth/sign-in', ADMIN_CREDENTIALS)).status).toBe(200)
    const labels = (await list()).integrations[0].tokens.map((token) => token.label).sort()
    expect(labels).toEqual(['laptop', 't365', 't90'])
  })

  test('label and expiry are validated with their fixed texts', async () => {
    await setUp()
    const agent = await setUpAgent(h, { githubToken: false })
    const path = `/api/integrations/${agent.id}/tokens`
    for (const body of [{ expiresInDays: 30 }, { label: '   ', expiresInDays: 30 }, { label: 'x'.repeat(65), expiresInDays: 30 }, { label: 5, expiresInDays: 30 }]) {
      const response = await h.post(path, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid-request', message: 'label must be 1 to 64 characters.' })
    }
    for (const expiresInDays of [undefined, 7, '30', 0, -1]) {
      const response = await h.post(path, { label: 'ok', expiresInDays })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid-request', message: 'expiresInDays must be 30, 90, 365 or null.' })
    }
    expect((await h.post(path, { label: 'x'.repeat(64), expiresInDays: 30 })).status).toBe(201)
  })

  test('revoking deletes the token, the agent is refused at once, and an unknown token id is 404', async () => {
    await setUp()
    const agent = await setUpAgent(h, { githubToken: false })
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await agent.bearer.mcp(rpc)).status).toBe(200)
    const missing = await h.delete(`/api/integrations/${agent.id}/tokens/${ID}`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not-found', message: 'There is no such token for this integration.' })
    expect((await h.delete(`/api/integrations/${agent.id}/tokens/${agent.tokenId}`)).status).toBe(204)
    expect((await agent.bearer.mcp(rpc)).status).toBe(401)
    expect((await h.delete(`/api/integrations/${agent.id}/tokens/${agent.tokenId}`)).status).toBe(404)
    const other = await setUpAgent(h, { username: 'other-bot', githubToken: false })
    expect((await h.delete(`/api/integrations/${agent.id}/tokens/${other.tokenId}`)).status).toBe(404)
    expect((await other.bearer.mcp(rpc)).status).toBe(200)
  })
})

describe('the stored GitHub token', () => {
  test('setting it answers a status without the token and stores only a sealed value', async () => {
    await setUp()
    const agent = await setUpAgent(h, { githubToken: false })
    const response = await h.put(`/api/integrations/${agent.id}/github-token`, { token: `  ${FIXTURE_GITHUB_TOKEN}  ` })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain(FIXTURE_GITHUB_TOKEN)
    expect((JSON.parse(text) as SetGitHubTokenResponse).githubToken).toEqual({ set: true, readable: true, status: 'unchecked', updatedAt: h.clock.now.toISOString() })
    const row = await h.database.db.selectFrom('github_tokens').selectAll().executeTakeFirstOrThrow()
    expect(row.sealed).toMatch(/^v1\./)
    expect(JSON.stringify(row)).not.toContain(FIXTURE_GITHUB_TOKEN)
    expect(JSON.stringify(row)).not.toContain('fixture_not_a_real')

    // A second set replaces the row.
    await h.put(`/api/integrations/${agent.id}/github-token`, { token: `${FIXTURE_GITHUB_TOKEN}_2` })
    expect(await h.database.db.selectFrom('github_tokens').select('user_id').execute()).toHaveLength(1)
  })

  test('without TOKEN_ENCRYPTION_KEY it answers encryption-key-missing and stores nothing; the list says storage is off', async () => {
    await setUp(false)
    const agent = await setUpAgent(h, { githubToken: false })
    const response = await h.put(`/api/integrations/${agent.id}/github-token`, { token: FIXTURE_GITHUB_TOKEN })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'encryption-key-missing',
      message: 'The server has no TOKEN_ENCRYPTION_KEY, so it cannot store a GitHub token.',
    })
    expect(await h.database.db.selectFrom('github_tokens').selectAll().execute()).toEqual([])
    expect((await list()).githubTokenStorage).toBe(false)
  })

  test('the value is checked: length first, then the key, then the format', async () => {
    await setUp()
    const agent = await setUpAgent(h, { githubToken: false })
    const path = `/api/integrations/${agent.id}/github-token`
    const long = await h.put(path, { token: 'x'.repeat(301) })
    expect(await long.json()).toEqual({ error: 'invalid-request', message: 'token must be text of at most 300 characters.' })
    expect(long.status).toBe(400)
    for (const body of [{}, { token: 5 }]) expect((await h.put(path, body)).status).toBe(400)

    const mcp = await h.put(path, { token: 'urutau_mcp_' + 'A'.repeat(43) })
    expect(mcp.status).toBe(400)
    expect(await mcp.json()).toEqual({ error: 'not-a-github-token', message: 'This is an Urutau MCP token, not a GitHub token.' })
    for (const token of ['gho_' + 'F'.repeat(36), 'ghs_' + 'F'.repeat(36), 'f'.repeat(40), '', 'ghp_short']) {
      const response = await h.put(path, { token })
      expect({ token: token.slice(0, 5), status: response.status }).toEqual({ token: token.slice(0, 5), status: 400 })
      expect(await response.json()).toEqual({
        error: 'unsupported-token-format',
        message: 'Use a fine-grained token (github_pat_…) or a classic token (ghp_…).',
      })
    }
    expect((await h.put(path, { token: 'ghp_' + 'F'.repeat(36) })).status).toBe(200)
    expect(h.logs.join('\n')).not.toContain('F'.repeat(36))
  })

  test('with the key unset the length check still comes first, and the format error is not reached', async () => {
    await setUp(false)
    const agent = await setUpAgent(h, { githubToken: false })
    const path = `/api/integrations/${agent.id}/github-token`
    expect((await h.put(path, { token: 'x'.repeat(301) })).status).toBe(400)
    expect((await h.put(path, { token: 'f'.repeat(40) })).status).toBe(409)
  })

  test('a token sealed under another key is listed as set but not readable', async () => {
    await setUp()
    const agent = await setUpAgent(h)
    await h.database.db.updateTable('github_tokens').set({ key_id: 'deadbeef' }).where('user_id', '=', agent.id).execute()
    expect((await list()).integrations[0].githubToken).toMatchObject({ set: true, readable: false })
  })

  test('clearing deletes the row, also when none was set', async () => {
    await setUp()
    const agent = await setUpAgent(h)
    expect((await h.delete(`/api/integrations/${agent.id}/github-token`)).status).toBe(204)
    expect(await h.database.db.selectFrom('github_tokens').selectAll().execute()).toEqual([])
    expect((await h.delete(`/api/integrations/${agent.id}/github-token`)).status).toBe(204)
    expect((await list()).integrations[0].githubToken.set).toBe(false)
  })
})

describe('the repository list', () => {
  test('replaces the list: trimmed, lower-cased, de-duplicated and sorted', async () => {
    await setUp()
    const agent = await setUpAgent(h)
    const path = `/api/integrations/${agent.id}/repos`
    const response = await h.put(path, { repos: ['  Acme/Widgets ', 'acme/widgets', 'acme/Gears'] })
    expect(response.status).toBe(200)
    expect(((await response.json()) as SetIntegrationReposResponse).repos).toEqual(['acme/gears', 'acme/widgets'])
    expect(((await (await h.put(path, { repos: [] })).json()) as SetIntegrationReposResponse).repos).toEqual([])
  })

  test('refuses a list that is too long, not a list, or holds an entry that is not owner/name', async () => {
    await setUp()
    const agent = await setUpAgent(h)
    const path = `/api/integrations/${agent.id}/repos`
    const tooMany = Array.from({ length: 201 }, (_, i) => `acme/r${i}`)
    for (const body of [{}, { repos: 'acme/widgets' }, { repos: [5] }, { repos: tooMany }]) {
      const response = await h.put(path, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid-request', message: 'repos must be a list of at most 200 repositories.' })
    }
    expect((await h.put(path, { repos: tooMany.slice(0, 200) })).status).toBe(200)
    const bad = await h.put(path, { repos: ['acme/widgets', 'https://github.com/acme/widgets'] })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid-request', message: 'Entry 2 is not a repository as owner/name.' })
    expect((await list()).integrations[0].repos).toHaveLength(200)
  })
})

describe('audit lines', () => {
  test('each admin action writes one info line with ids only', async () => {
    await setUp()
    h.logs.length = 0
    const agent = await setUpAgent(h, { repos: ['acme/widgets', 'acme/gears'] })
    await h.delete(`/api/integrations/${agent.id}/tokens/${agent.tokenId}`)
    await h.delete(`/api/integrations/${agent.id}/github-token`)
    await h.delete(`/api/integrations/${agent.id}`)
    const audit = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg !== 'request')
    const admin = ((await (await h.get('/api/session')).json()) as { session: { user: { id: string } } }).session.user.id
    expect(audit.map((line) => line.msg)).toEqual([
      'integration created',
      'api token created',
      'integration repos changed',
      'github token set',
      'api token revoked',
      'github token cleared',
      'integration removed',
    ])
    expect(audit.every((line) => line.level === 'info' && line.user === admin && line.integration === agent.id)).toBe(true)
    expect(audit[1]).toMatchObject({ tokenId: agent.tokenId, expiresAt: expect.any(String) })
    expect(audit[2]).toMatchObject({ count: 2 })
    const text = h.logs.join('\n')
    for (const word of ['planner-bot', 'laptop', 'acme/widgets', agent.secret, FIXTURE_GITHUB_TOKEN]) expect(text).not.toContain(word)
  })

  test('a database error answers 500 server-error and the log line has the error name only', async () => {
    await setUp()
    const failing = new Error('postgres://u:pw@h/x')
    failing.name = 'DriverError'
    const db = h.database.db
    const selectFrom = db.selectFrom.bind(db) as (table: string) => unknown
    ;(db as unknown as { selectFrom: (table: string) => unknown }).selectFrom = (table) => {
      if (table === 'integrations') throw failing
      return selectFrom(table)
    }
    const response = await h.get('/api/integrations')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'server-error', message: 'Something went wrong on the server.' })
    const text = h.logs.join('\n')
    expect(text).toContain('DriverError')
    expect(text).not.toContain('postgres://u:pw@h/x')
  })
})
