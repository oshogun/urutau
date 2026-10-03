import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import {
  clearGitHubToken,
  createApiToken,
  createIntegration,
  INTEGRATIONS_QUERY_KEY,
  listIntegrations,
  removeIntegration,
  revokeApiToken,
  setGitHubToken,
  setIntegrationRepos,
} from './admin'
import { installApiStub } from '../test/apiStub'
import type { ApiStub } from '../test/apiStub'
import { useSession } from '../state/session'

const GITHUB_TOKEN = 'github_pat_urutau_fixture_not_a_real_token'

function fakeFetch(status = 200, body: unknown = {}) {
  const mock = vi.fn<typeof fetch>(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

const seen = (mock: ReturnType<typeof fakeFetch>) => {
  const [url, init] = mock.mock.calls[0]
  return { url, method: init?.method ?? 'GET', body: init?.body }
}

describe('admin client: integrations', () => {
  it('keys the query by integrations', () => {
    expect(INTEGRATIONS_QUERY_KEY).toEqual(['integrations'])
  })

  it('GET integrations', async () => {
    const mock = fakeFetch(200, { integrations: [], githubTokenStorage: true })
    await expect(listIntegrations()).resolves.toEqual({ integrations: [], githubTokenStorage: true })
    expect(seen(mock)).toEqual({ url: 'api/integrations', method: 'GET', body: undefined })
  })

  it('POST integrations', async () => {
    const mock = fakeFetch(201, { integration: {} })
    await createIntegration({ username: 'planner-bot' })
    expect(seen(mock)).toEqual({ url: 'api/integrations', method: 'POST', body: '{"username":"planner-bot"}' })
  })

  it('DELETE integrations/:id', async () => {
    const mock = fakeFetch(204)
    await removeIntegration('a/b')
    expect(seen(mock)).toEqual({ url: 'api/integrations/a%2Fb', method: 'DELETE', body: undefined })
  })

  it('POST integrations/:id/tokens', async () => {
    const mock = fakeFetch(201, { token: {}, secret: 's' })
    await createApiToken('i1', { label: 'laptop', expiresInDays: null })
    expect(seen(mock)).toEqual({
      url: 'api/integrations/i1/tokens',
      method: 'POST',
      body: '{"label":"laptop","expiresInDays":null}',
    })
  })

  it('DELETE integrations/:id/tokens/:tokenId', async () => {
    const mock = fakeFetch(204)
    await revokeApiToken('i1', 't1')
    expect(seen(mock)).toEqual({ url: 'api/integrations/i1/tokens/t1', method: 'DELETE', body: undefined })
  })

  it('PUT integrations/:id/github-token', async () => {
    const mock = fakeFetch(200, { githubToken: {} })
    await setGitHubToken('i1', { token: GITHUB_TOKEN })
    expect(seen(mock)).toEqual({
      url: 'api/integrations/i1/github-token',
      method: 'PUT',
      body: JSON.stringify({ token: GITHUB_TOKEN }),
    })
  })

  it('DELETE integrations/:id/github-token', async () => {
    const mock = fakeFetch(204)
    await clearGitHubToken('i1')
    expect(seen(mock)).toEqual({ url: 'api/integrations/i1/github-token', method: 'DELETE', body: undefined })
  })

  it('PUT integrations/:id/repos', async () => {
    const mock = fakeFetch(200, { repos: [] })
    await setIntegrationRepos('i1', { repos: ['Acme/Widgets'] })
    expect(seen(mock)).toEqual({
      url: 'api/integrations/i1/repos',
      method: 'PUT',
      body: '{"repos":["Acme/Widgets"]}',
    })
  })

  it('throws an ApiError carrying the new error codes', async () => {
    fakeFetch(409, { error: 'encryption-key-missing', message: 'No key.' })
    const error = await setGitHubToken('i1', { token: GITHUB_TOKEN }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'encryption-key-missing' })
  })
})

describe('apiStub: integration routes', () => {
  let stub: ApiStub

  async function start(options: Parameters<typeof installApiStub>[0] = {}) {
    stub = installApiStub(options)
    await useSession.getState().load()
  }

  afterEach(() => stub.restore())

  it('lists the starting integrations and creates one', async () => {
    await start({ integrations: [{ username: 'bot-one', repos: ['Acme/Widgets', 'acme/widgets'], githubToken: true }] })
    const first = await listIntegrations()
    expect(first.githubTokenStorage).toBe(true)
    expect(first.integrations[0]).toMatchObject({
      username: 'bot-one',
      repos: ['acme/widgets'],
      githubToken: { set: true, status: 'unchecked' },
    })
    const { integration } = await createIntegration({ username: 'bot-two' })
    expect(integration).toMatchObject({ tokens: [], repos: [], githubToken: { set: false, status: null } })
    expect(stub.integrations.map((i) => i.username)).toEqual(['bot-one', 'bot-two'])
    await expect(createIntegration({ username: 'BOT-TWO' })).rejects.toMatchObject({ code: 'username-taken' })
    await expect(createIntegration({ username: 'x' })).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('answers non-admins 403 and unknown ids 404', async () => {
    await start({ user: { isAdmin: false } })
    await expect(listIntegrations()).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    stub.restore()
    await start({})
    await expect(removeIntegration('nope')).rejects.toMatchObject({ status: 404, code: 'not-found' })
    await expect(createApiToken('nope', { label: 'x', expiresInDays: null })).rejects.toMatchObject({ status: 404 })
  })

  it('validates and revokes tokens, with distinct secrets', async () => {
    await start({ integrations: [{ username: 'bot-one' }] })
    const id = stub.integrations[0].id
    await expect(createApiToken(id, { label: '  ', expiresInDays: null })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(createApiToken(id, { label: 'a', expiresInDays: 7 as 30 })).rejects.toMatchObject({ code: 'invalid-request' })
    const one = await createApiToken(id, { label: 'one', expiresInDays: 30 })
    const two = await createApiToken(id, { label: 'two', expiresInDays: null })
    expect(one.secret).toMatch(/^urutau_mcp_[A-Za-z0-9]{43}$/)
    expect(two.secret).not.toBe(one.secret)
    expect(two.token.expiresAt).toBeNull()
    expect(stub.integrations[0].tokens.map((t) => t.label)).toEqual(['two', 'one'])
    await revokeApiToken(id, one.token.id)
    await expect(revokeApiToken(id, one.token.id)).rejects.toMatchObject({ status: 404 })
    expect(stub.integrations[0].tokens).toHaveLength(1)
  })

  it('checks the GitHub token in the server order and keeps it write-only', async () => {
    await start({ integrations: [{ username: 'bot-one' }] })
    const id = stub.integrations[0].id
    await expect(setGitHubToken(id, { token: 5 as unknown as string })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(setGitHubToken(id, { token: `urutau_mcp_${'A'.repeat(43)}` })).rejects.toMatchObject({ code: 'not-a-github-token' })
    await expect(setGitHubToken(id, { token: 'f'.repeat(40) })).rejects.toMatchObject({ code: 'unsupported-token-format' })
    const { githubToken } = await setGitHubToken(id, { token: ` ${GITHUB_TOKEN} ` })
    expect(githubToken).toMatchObject({ set: true, readable: true, status: 'unchecked' })
    await clearGitHubToken(id)
    expect(stub.integrations[0].githubToken).toMatchObject({ set: false, status: null })
    await expect(clearGitHubToken(id)).resolves.toBeUndefined()
  })

  it('answers 409 encryption-key-missing and reports no storage when the key is unset', async () => {
    await start({ githubTokenStorage: false, integrations: [{ username: 'bot-one' }] })
    expect((await listIntegrations()).githubTokenStorage).toBe(false)
    await expect(setGitHubToken(stub.integrations[0].id, { token: GITHUB_TOKEN })).rejects.toMatchObject({
      status: 409,
      code: 'encryption-key-missing',
    })
  })

  it('replaces the repository list with lower-case sorted keys', async () => {
    await start({ integrations: [{ username: 'bot-one' }] })
    const id = stub.integrations[0].id
    await expect(setIntegrationRepos(id, { repos: ['acme/widgets', 'nope'] })).rejects.toMatchObject({
      message: 'Entry 2 is not a repository as owner/name.',
    })
    await expect(setIntegrationRepos(id, { repos: 'x' as unknown as string[] })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(setIntegrationRepos(id, { repos: [' Acme/Widgets ', 'acme/empty', 'ACME/empty'] })).resolves.toEqual({
      repos: ['acme/empty', 'acme/widgets'],
    })
  })

  it('removes an integration', async () => {
    await start({ integrations: [{ username: 'bot-one' }] })
    await removeIntegration(stub.integrations[0].id)
    expect(stub.integrations).toEqual([])
  })

  it('rejects mutations without the CSRF header', async () => {
    await start({ integrations: [{ username: 'bot-one' }] })
    const response = await fetch('api/integrations', { method: 'POST', body: '{"username":"abc"}' })
    expect(response.status).toBe(403)
  })

  it('never returns the MCP secret or the GitHub token after creation', async () => {
    await start({ integrations: [{ username: 'bot-one' }] })
    const id = stub.integrations[0].id
    const { secret } = await createApiToken(id, { label: 'laptop', expiresInDays: 90 })
    await setGitHubToken(id, { token: GITHUB_TOKEN })
    const later = [
      await fetch('api/integrations').then((r) => r.text()),
      JSON.stringify(await createIntegration({ username: 'bot-two' })),
      JSON.stringify(await setIntegrationRepos(id, { repos: ['acme/widgets'] })),
      JSON.stringify(stub.integrations),
    ].join('\n')
    expect(later).not.toContain(secret)
    expect(later).not.toContain('urutau_mcp_')
    expect(later).not.toContain(GITHUB_TOKEN)
    expect(later).not.toContain('github_pat_')
  })
})
