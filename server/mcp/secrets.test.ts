import { afterEach, expect, test } from 'vitest'
import { sha256Hex } from '../auth/tokens.ts'
import type { BoardConfig } from '../../src/domain/types.ts'
import { createGitHubStub, stubIssue } from '../testing/githubStub.ts'
import {
  createTestApp,
  FIXTURE_GITHUB_TOKEN,
  setUpAgent,
  signInFirstAdmin,
  TEST_ENCRYPTION_KEY,
  type TestApp,
} from '../testing/harness.ts'

let h: TestApp
afterEach(async () => {
  await h.close()
})

const BOARD: BoardConfig = {
  version: 1,
  buckets: [
    { id: 'todo', title: 'To do', wipLimit: null, labelRules: [], collectsClosed: false },
    { id: 'doing', title: 'Doing', wipLimit: null, labelRules: [], collectsClosed: false },
  ],
  placements: {},
  order: {},
  closedWindowDays: 14,
}

test('no secret reaches the logs, the admin API, the session, the event stream or an MCP result; every admin action is logged', async () => {
  const stub = createGitHubStub({ 'acme/widgets': { id: 1, private: false, items: [stubIssue(1), stubIssue(2)] } })
  // The harness logger has no redaction, so this finds anything the code itself writes.
  h = await createTestApp({ config: { tokenEncryptionKey: TEST_ENCRYPTION_KEY }, fetch: stub.fetch })
  await signInFirstAdmin(h)
  const streamed: string[] = []
  h.hub.subscribe('acme/widgets', 'viewer', { send: (event) => void streamed.push(JSON.stringify(event)), close() {} })

  const agent = await setUpAgent(h, { repos: ['acme/widgets'] })
  expect((await h.put('/api/boards/acme/widgets', { baseVersion: null, fullName: 'acme/widgets', board: BOARD })).status).toBe(201)

  const results: string[] = []
  for (const [name, args] of [
    ['list_boards', {}],
    ['get_board', { repo: 'acme/widgets' }],
    ['move_card', { repo: 'acme/widgets', issue: 1, bucket: 'doing' }],
    ['move_card', { repo: 'acme/widgets', issue: 999, bucket: 'doing' }],
    ['get_board', { repo: 'other/place' }],
  ] as const) {
    const response = await agent.bearer.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    results.push(await response.text())
  }
  results.push(await (await agent.bearer.mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })).text())
  results.push(await (await agent.bearer.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).text())
  results.push(await (await agent.bearer.request('/mcp', { method: 'GET' })).text())
  results.push(await (await h.bearerClient('urutau_mcp_' + 'B'.repeat(43)).mcp({})).text())

  const apiBodies = [
    await (await h.get('/api/integrations')).text(),
    await (await h.get('/api/users')).text(),
    await (await h.get('/api/session')).text(),
    await (await h.get('/api/boards')).text(),
    await (await h.get('/api/boards/acme/widgets')).text(),
  ]
  const row = await h.database.db.selectFrom('github_tokens').select(['sealed', 'key_id']).executeTakeFirstOrThrow()
  const tokenHash = sha256Hex(agent.secret)
  const needles = {
    bearer: agent.secret,
    githubToken: FIXTURE_GITHUB_TOKEN,
    tokenHash,
    sealed: row.sealed,
    keyBase64: TEST_ENCRYPTION_KEY.toString('base64'),
  }

  expect((await h.put(`/api/integrations/${agent.id}/github-token`, { token: 'f'.repeat(40) })).status).toBe(400)
  expect((await h.delete(`/api/integrations/${agent.id}/tokens/${agent.tokenId}`)).status).toBe(204)
  expect((await h.delete(`/api/integrations/${agent.id}/github-token`)).status).toBe(204)
  expect((await h.delete(`/api/integrations/${agent.id}`)).status).toBe(204)

  const surfaces: Record<string, string> = {
    logs: h.logs.join('\n'),
    'recorded events': JSON.stringify(h.events),
    'event stream': streamed.join('\n'),
    'mcp results': results.join('\n'),
    'api bodies': apiBodies.join('\n'),
  }
  // The person creating the board and the agent moving a card.
  expect(streamed).toHaveLength(2)
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const [name, needle] of Object.entries(needles)) {
      expect({ surface, name, found: text.includes(needle) }).toEqual({ surface, name, found: false })
    }
  }
  // The key id is a public fingerprint, not the key; the sealed value is still never in a body.
  expect(row.key_id).not.toBe(needles.keyBase64)

  const audit = h.logs.map((line) => JSON.parse(line) as { msg: string }).map((line) => line.msg)
  for (const message of [
    'integration created',
    'api token created',
    'integration repos changed',
    'github token set',
    'api token revoked',
    'github token cleared',
    'integration removed',
  ]) {
    expect(audit.filter((entry) => entry === message)).toHaveLength(1)
  }
  expect(results[0]).toContain('boards')
})
