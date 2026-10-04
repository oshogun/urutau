import { describe, expect, it } from 'vitest'
import { ApiError, apiRequest } from '../api/client'
import { useSession } from '../state/session'
import { installApiStub } from './apiStub'

async function failure(call: Promise<unknown>): Promise<ApiError> {
  const error = await call.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('the api stub refuses a username an agent integration has', () => {
  it('on invite accept, in any letter case, with the real server code and message', async () => {
    const stub = installApiStub({ integrations: [{ username: 'planner-bot' }] })
    await useSession.getState().load()
    const { token } = await apiRequest<{ token: string }>('invites', { method: 'POST', body: { expiresInHours: 24 } })

    const error = await failure(
      apiRequest('invites/accept', { method: 'POST', body: { token, username: 'Planner-Bot', password: 'a long password' } }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('username-taken')
    expect(error.message).toBe('That username is already taken.')
    expect(stub.users.map((user) => user.username)).toEqual(['ada'])
    expect(stub.invites).toHaveLength(1)
  })

  it('on first run', async () => {
    const stub = installApiStub({ session: 'first-run', integrations: [{ username: 'planner-bot' }] })
    await useSession.getState().load()

    const error = await failure(
      apiRequest('auth/first-run', { method: 'POST', body: { username: 'PLANNER-BOT', password: 'a long password' } }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('username-taken')
    expect(error.message).toBe('That username is already taken.')
    expect(stub.users).toEqual([])

    await apiRequest('auth/first-run', { method: 'POST', body: { username: 'admin', password: 'a long password' } })
    expect(stub.users.map((user) => user.username)).toEqual(['admin'])
  })
})

describe('the api stub answers PATCH api/issues like the server', () => {
  const fields = { title: 'Renamed' }
  const body = { expectedUpdatedAt: '2026-01-01T00:00:00Z', fields }

  it('answers 200 with an updated issue for a Keycloak-style session when the switch is on', async () => {
    const stub = installApiStub({ githubAccess: { mode: 'server' }, githubWrites: true })
    await useSession.getState().load()
    const answer = await apiRequest<{ issue: Record<string, unknown> }>('issues/acme/widgets/7', { method: 'PATCH', body })
    expect(answer.issue).toMatchObject({ number: 7, title: 'Renamed', state: 'open' })
    expect(stub.requests('PATCH issues/acme/widgets/7')).toHaveLength(1)
  })

  it('refuses in the server order: browser mode, switch off, bad path, bad body', async () => {
    installApiStub({ githubWrites: true })
    await useSession.getState().load()
    expect((await failure(apiRequest('issues/acme/widgets/7', { method: 'PATCH', body }))).code).toBe('forbidden')

    const off = installApiStub({ githubAccess: { mode: 'server' } })
    await useSession.getState().load()
    expect((await failure(apiRequest('issues/acme/widgets/7', { method: 'PATCH', body }))).code).toBe('github-writes-off')
    off.setGithubWrites(true)
    expect((await failure(apiRequest('issues/acme/widgets/0', { method: 'PATCH', body }))).status).toBe(400)
    expect((await failure(apiRequest('issues/acme/widgets/7', { method: 'PATCH', body: { fields } }))).status).toBe(400)
  })

  it('lets a handler answer, and a signed-out session gets 401', async () => {
    installApiStub({
      githubAccess: { mode: 'server' },
      githubWrites: true,
      updateIssue: ({ number }) => new Response(JSON.stringify({ error: 'stale-issue', message: String(number) }), { status: 409 }),
    })
    await useSession.getState().load()
    const error = await failure(apiRequest('issues/acme/widgets/7', { method: 'PATCH', body }))
    expect(error.status).toBe(409)
    expect(error.code).toBe('stale-issue')

    installApiStub({ session: 'signed-out' })
    await useSession.getState().load()
    expect((await failure(apiRequest('issues/acme/widgets/7', { method: 'PATCH', body }))).code).toBe('signed-out')
  })
})
