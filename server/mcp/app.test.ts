import { afterEach, describe, expect, test, vi } from 'vitest'
import { bucketNumbers, resolveBuckets } from '../../src/domain/board.ts'
import type { BoardUpdatedEvent, StoredBoard } from '../../src/domain/api.ts'
import { fetchRepoSnapshot } from '../../src/github/api.ts'
import type { BoardConfig } from '../../src/domain/types.ts'
import * as bearer from '../auth/bearer.ts'
import { getBoard } from '../db/boards.ts'
import { PUBLIC_ROUTES } from '../http/publicRoutes.ts'
import { createGitHubStub, stubIssue, type GitHubStub } from '../testing/githubStub.ts'
import {
  ADMIN_CREDENTIALS,
  createTestApp,
  FIXTURE_GITHUB_TOKEN,
  setUpAgent,
  signInFirstAdmin,
  TEST_ENCRYPTION_KEY,
  type TestApp,
  type TestOverrides,
} from '../testing/harness.ts'
import type { GetBoardJson, MoveCardJson } from './contract.ts'

vi.mock('../auth/bearer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/bearer.ts')>()
  return { ...actual, verifyBearer: vi.fn(actual.verifyBearer) }
})

const REPO = 'acme/widgets'

let h: TestApp
afterEach(async () => {
  vi.mocked(bearer.verifyBearer).mockClear()
  await h.close()
})

function threeBuckets(): BoardConfig {
  return {
    version: 1,
    buckets: [
      { id: 'todo', title: 'To do', wipLimit: null, labelRules: [], collectsClosed: false },
      { id: 'doing', title: 'Doing', wipLimit: null, labelRules: [], collectsClosed: false },
      { id: 'done', title: 'Done', wipLimit: null, labelRules: [], collectsClosed: true },
    ],
    placements: {},
    order: {},
    closedWindowDays: 14,
  }
}

async function setUp(options: { fetch?: TestOverrides['fetch']; stub?: GitHubStub; board?: BoardConfig; repos?: string[] } = {}) {
  const stub = options.stub ?? createGitHubStub({ [REPO]: { id: 1, private: false, items: [stubIssue(1), stubIssue(2), stubIssue(3)] } })
  h = await createTestApp({ config: { tokenEncryptionKey: TEST_ENCRYPTION_KEY }, fetch: options.fetch ?? stub.fetch })
  await signInFirstAdmin(h)
  const agent = await setUpAgent(h, { repos: options.repos ?? [REPO] })
  const created = await h.put(`/api/boards/${REPO}`, { baseVersion: null, fullName: REPO, board: options.board ?? threeBuckets() })
  expect(created.status).toBe(201)
  return { stub, agent }
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T
}

describe('a bearer token and the /api routes', () => {
  test('a bearer token on /api/session and on every /api route outside the public list gives signed-out', async () => {
    await setUp()
    const [row] = await h.database.db.selectFrom('integrations').select('user_id').execute()
    const { secret } = (await (await h.post(`/api/integrations/${row.user_id}/tokens`, { label: 'second', expiresInDays: 30 })).json()) as { secret: string }
    const bot = h.bearerClient(secret)
    expect((await bot.rpc('tools/list')).result.tools.length).toBe(4)

    const session = await bot.request('/api/session')
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ signedIn: false })

    const checked = new Set<string>()
    for (const route of h.app.routes) {
      if (route.method === 'ALL' || !route.path.startsWith('/api/')) continue
      const key = `${route.method} ${route.path}`
      if (PUBLIC_ROUTES.includes(key) || checked.has(key)) continue
      checked.add(key)
      const response = await bot.request(route.path.replace(/:\w+/g, 'x'), { method: route.method, headers: { 'X-Urutau-CSRF': '1' } })
      expect({ route: key, status: response.status }).toEqual({ route: key, status: 401 })
      expect(await response.json()).toMatchObject({ error: 'signed-out' })
    }
    expect(checked.size).toBeGreaterThan(20)
    expect(checked).toContain('GET /api/integrations')
    expect(checked).toContain('GET /api/boards')
  })

  test('a cookie never authenticates /mcp', async () => {
    await setUp()
    const response = await h.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'invalid-token' })
  })

  test('bearer failures are counted apart from sign-in attempts and do not block cookie sign-in', async () => {
    await setUp()
    const visitor = h.newClient()
    const bad = h.bearerClient('urutau_mcp_' + 'A'.repeat(43))
    const statuses: number[] = []
    for (let i = 0; i < 52; i++) statuses.push((await bad.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status)
    expect(statuses.slice(0, 50).every((status) => status === 401)).toBe(true)
    expect(statuses.slice(50)).toEqual([429, 429])

    expect((await visitor.post('/api/auth/sign-in', ADMIN_CREDENTIALS)).status).toBe(200)
    const [row] = await h.database.db.selectFrom('integrations').select('user_id').execute()
    const issued = await h.post(`/api/integrations/${row.user_id}/tokens`, { label: 'late', expiresInDays: null })
    const { secret } = (await issued.json()) as { secret: string }
    expect((await h.bearerClient(secret).rpc('tools/list')).result.tools).toHaveLength(4)
  })

  test('failed sign-ins do not block the bearer: a live token still passes', async () => {
    const { agent } = await setUp()
    const visitor = h.newClient()
    for (let i = 0; i < 51; i++) await visitor.post('/api/auth/sign-in', { username: 'admin', password: 'wrong password here' })
    expect((await visitor.post('/api/auth/sign-in', ADMIN_CREDENTIALS)).status).toBe(429)
    expect((await agent.bearer.rpc('tools/list')).result.tools).toHaveLength(4)
  })

  test('a database error during the bearer lookup answers a JSON 500 and logs the error name only', async () => {
    await setUp()
    const failure = new Error('postgres://u:pw@h/x')
    failure.name = 'DriverError'
    vi.mocked(bearer.verifyBearer).mockRejectedValueOnce(failure)
    const response = await h.bearerClient('urutau_mcp_' + 'A'.repeat(43)).mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'server-error', message: 'Something went wrong on the server.' })
    const line = h.logs.map((entry) => JSON.parse(entry) as Record<string, unknown>).find((entry) => entry.msg === 'unhandled error')
    expect(line).toEqual(expect.objectContaining({ level: 'error', name: 'DriverError' }))
    expect(h.logs.join('\n')).not.toContain('postgres://u:pw@h/x')
    expect(h.logs.join('\n')).not.toContain('"message"')
  })
})

describe('end to end', () => {
  test('initialize, tools/list and move_card change the board and publish one board-updated for the integration', async () => {
    const { agent, stub } = await setUp()
    const received: { type: string; data: BoardUpdatedEvent }[] = []
    h.hub.subscribe(REPO, 'viewer-session', { send: (event) => void received.push(event as never), close() {} })
    const eventsBefore = h.events.length

    const init = await agent.bearer.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.result.serverInfo).toMatchObject({ name: 'urutau' })
    const listed = await agent.bearer.rpc('tools/list')
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['get_board', 'list_boards', 'move_card', 'reorder_bucket'])

    const before = parse<StoredBoard>(await (await h.get(`/api/boards/${REPO}`)).text())
    expect(before.version).toBe(1)
    const moved = await agent.bearer.tool('move_card', { repo: REPO, issue: 2, bucket: 'doing', position: 'top' })
    expect(moved.isError).toBe(false)
    expect(moved.structured as unknown as MoveCardJson).toMatchObject({ repo: REPO, version: 2, issue: 2, from: 'todo', to: 'doing', index: 0, attempts: 1 })

    const after = parse<StoredBoard>(await (await h.get(`/api/boards/${REPO}`)).text())
    expect(after.version).toBe(2)
    expect(after.board.placements).toMatchObject({ 2: 'doing' })
    expect(after.updatedBy).toMatchObject({ username: 'planner-bot', kind: 'integration' })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('board-updated')
    expect(received[0].data).toMatchObject({ repoKey: REPO, version: 2, clientId: null, updatedBy: { username: 'planner-bot', kind: 'integration' } })
    expect(h.events.slice(eventsBefore)).toHaveLength(1)

    const read = await agent.bearer.tool('get_board', { repo: REPO })
    const board = read.structured as unknown as GetBoardJson
    expect(board.version).toBe(2)
    expect(board.buckets.find((bucket) => bucket.id === 'doing')?.cards.map((card) => card.number)).toEqual([2])
    expect(board.updatedBy).toEqual({ username: 'planner-bot', kind: 'integration' })

    // Every GitHub request the server made was a GET to api.github.com with the stored token.
    expect(stub.calls.length).toBeGreaterThan(0)
    for (const call of stub.calls) {
      expect(call.method).toBe('GET')
      expect(call.url.startsWith('https://api.github.com/')).toBe(true)
      expect(call.headers.get('authorization')).toBe(`Bearer ${FIXTURE_GITHUB_TOKEN}`)
      expect(call.redirect).toBe('manual')
    }
    const last = await h.database.db.selectFrom('api_tokens').select('last_used_at').executeTakeFirstOrThrow()
    expect(last.last_used_at).toBe(h.clock.now.toISOString())
  })

  test('list_boards reports the listed repositories with and without a board', async () => {
    const { agent } = await setUp({ repos: [REPO, 'acme/other'] })
    const result = await agent.bearer.tool('list_boards')
    expect(result.structured).toMatchObject({ boards: [{ repo: REPO, version: 1 }], reposWithoutBoard: ['acme/other'] })
  })

  test('a repository off the list, and an account without a stored GitHub token, get tool errors', async () => {
    const { agent } = await setUp({ repos: ['acme/other'] })
    const refused = await agent.bearer.tool('get_board', { repo: REPO })
    expect(refused.isError).toBe(true)
    expect(parse<{ error: string }>(refused.text).error).toBe('repo-not-allowed')

    const bare = await setUpAgent(h, { username: 'bare-bot', repos: [REPO], githubToken: false })
    const missing = await bare.bearer.tool('get_board', { repo: REPO })
    expect(parse<{ error: string }>(missing.text).error).toBe('github-token-missing')
  })

  test('a revoked token stops the agent at once', async () => {
    const { agent } = await setUp()
    expect((await agent.bearer.tool('list_boards')).isError).toBe(false)
    expect((await h.delete(`/api/integrations/${agent.id}/tokens/${agent.tokenId}`)).status).toBe(204)
    const response = await agent.bearer.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(response.status).toBe(401)
    expect(h.ctx.mcp.inflight.size()).toBe(0)
  })

  test('a removed integration stops the agent at once', async () => {
    const { agent } = await setUp()
    expect((await agent.bearer.tool('list_boards')).isError).toBe(false)
    expect((await h.delete(`/api/integrations/${agent.id}`)).status).toBe(204)
    const response = await agent.bearer.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(response.status).toBe(401)
    expect(h.ctx.mcp.inflight.size()).toBe(0)
  })
})

describe('get_board over the GitHub stub', () => {
  test('1,050 open issues, a pull request and closed issues: cards are a prefix of what the browser path resolves', async () => {
    const day = 24 * 60 * 60 * 1000
    const now = new Date('2026-10-02T12:00:00.000Z')
    const iso = (offset: number) => new Date(now.getTime() - offset).toISOString()
    const items = [
      ...Array.from({ length: 1050 }, (_, i) => stubIssue(i + 1)),
      stubIssue(2000, { pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/2000' } }),
      stubIssue(2001, { state: 'closed', closed_at: iso(day), updated_at: iso(day) }),
      stubIssue(2002, { state: 'closed', closed_at: iso(30 * day), updated_at: iso(day) }),
    ]
    const data = { id: 7, private: false, items }
    const board: BoardConfig = {
      version: 1,
      buckets: [
        { id: 'done', title: 'Done', wipLimit: null, labelRules: [], collectsClosed: true },
        { id: 'backlog', title: 'Backlog', wipLimit: null, labelRules: [], collectsClosed: false },
      ],
      placements: {},
      order: {},
      closedWindowDays: 14,
    }
    const { agent } = await setUp({ stub: createGitHubStub({ [REPO]: data }), board })

    const result = await agent.bearer.tool('get_board', { repo: REPO, includeClosed: true, limitPerBucket: 300 })
    expect(result.isError).toBe(false)
    const answer = result.structured as unknown as GetBoardJson
    expect(answer.truncated).toBe(true)
    expect(answer.cardBudgetReached).toBe(true)

    const comparison = createGitHubStub({ [REPO]: data })
    const snapshot = await fetchRepoSnapshot(
      { owner: 'acme', name: 'widgets' },
      {
        closedWindowDays: 14,
        now: () => h.clock.now.getTime(),
        transport: { root: 'https://api.github.com', get: (url, signal) => comparison.fetch(url, { signal }) },
      },
    )
    const contents = resolveBuckets(snapshot.issues, board)
    let shown = 0
    for (const bucket of answer.buckets) {
      const expected = bucketNumbers(contents, bucket.id)
      const numbers = bucket.cards.map((card) => card.number)
      expect(numbers).toEqual(expected.slice(0, numbers.length))
      expect(bucket.total).toBe(expected.length)
      shown += numbers.length
      for (const number of numbers) expect([2000, 2002]).not.toContain(number)
    }
    expect(shown).toBe(300)
    expect(answer.buckets.find((bucket) => bucket.id === 'done')?.cards.map((card) => card.number)).toEqual([2001])
    expect(answer.buckets.find((bucket) => bucket.id === 'backlog')?.cards).toHaveLength(299)
  })
})

describe('changing the repository list during a call', () => {
  function held() {
    const deferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      return { promise, resolve }
    }
    const gate = deferred()
    const reached = deferred()
    const stub = createGitHubStub({ [REPO]: { id: 1, private: false, items: [stubIssue(1), stubIssue(2), stubIssue(3)] } })
    const wrapped: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (request.method === 'GET' && url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPO}/issues`) {
        reached.resolve()
        const signal = request.signal
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          void gate.promise.then(resolve)
        })
      }
      return stub.fetch(input, init)
    }
    return { fetch: wrapped, gate, reached }
  }

  test('a PUT that removes the repository stops the held move_card with call-stopped and nothing is saved', async () => {
    const hold = held()
    const { agent } = await setUp({ fetch: hold.fetch })
    const before = (await getBoard(h.database.db, REPO))!.version
    const eventsBefore = h.events.length
    try {
      const call = agent.bearer.tool('move_card', { repo: REPO, issue: 1, bucket: 'doing' })
      await hold.reached.promise
      const put = await h.put(`/api/integrations/${agent.id}/repos`, { repos: ['acme/other'] })
      expect(put.status).toBe(200)
      const result = await call
      expect(result.isError).toBe(true)
      expect(parse<{ error: string }>(result.text).error).toBe('call-stopped')
      expect((await getBoard(h.database.db, REPO))!.version).toBe(before)
      expect(h.events.slice(eventsBefore).filter((event) => event.type === 'board-updated')).toEqual([])
    } finally {
      hold.gate.resolve()
    }
    expect((await h.put(`/api/integrations/${agent.id}/repos`, { repos: [REPO] })).status).toBe(200)
    await agent.bearer.tool('get_board', { repo: REPO })
  })

  test('a PUT that only adds a repository stops nothing: the move saves and the version goes up by one', async () => {
    const hold = held()
    const { agent } = await setUp({ fetch: hold.fetch })
    const before = (await getBoard(h.database.db, REPO))!.version
    const eventsBefore = h.events.length
    let result
    try {
      const call = agent.bearer.tool('move_card', { repo: REPO, issue: 1, bucket: 'doing' })
      await hold.reached.promise
      const put = await h.put(`/api/integrations/${agent.id}/repos`, { repos: [REPO, 'acme/other'] })
      expect(put.status).toBe(200)
      hold.gate.resolve()
      result = await call
    } finally {
      hold.gate.resolve()
    }
    expect(result.isError).toBe(false)
    expect(result.structured as unknown as MoveCardJson).toMatchObject({ attempts: 1, version: before + 1 })
    expect((await getBoard(h.database.db, REPO))!.version).toBe(before + 1)
    const published = h.events.slice(eventsBefore).filter((event) => event.type === 'board-updated')
    expect(published).toHaveLength(1)
    expect(published[0].data).toMatchObject({ repoKey: REPO, version: before + 1 })
  })
})
