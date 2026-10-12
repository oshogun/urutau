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
    off.setGithubWrites({ createIssues: true })
    expect((await failure(apiRequest('issues/acme/widgets/7', { method: 'PATCH', body }))).code).toBe('github-writes-off')
    off.setGithubWrites({ editIssues: true })
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

describe('the api stub keeps one GitHub write switch per kind like the server', () => {
  it('takes a boolean for every kind or an object for some, and setGithubWrites merges', () => {
    expect(installApiStub().githubWrites).toEqual({ createIssues: false, editIssues: false })
    expect(installApiStub({ githubWrites: true }).githubWrites).toEqual({ createIssues: true, editIssues: true })
    const stub = installApiStub({ githubWrites: { editIssues: true } })
    expect(stub.githubWrites).toEqual({ createIssues: false, editIssues: true })
    stub.setGithubWrites({ createIssues: true })
    expect(stub.githubWrites).toEqual({ createIssues: true, editIssues: true })
    stub.setGithubWrites(false)
    expect(stub.githubWrites).toEqual({ createIssues: false, editIssues: false })
  })

  it('PATCH api/settings changes only the kinds given and refuses what the server refuses', async () => {
    const stub = installApiStub()
    await useSession.getState().load()
    const answer = await apiRequest('settings', { method: 'PATCH', body: { githubWrites: { editIssues: true } } })
    expect(answer).toEqual({ githubWrites: { createIssues: false, editIssues: true } })
    expect(await apiRequest('settings')).toEqual({ githubWrites: { createIssues: false, editIssues: true } })
    for (const bad of [
      {},
      { githubWrites: true },
      { githubWrites: {} },
      { githubWrites: { comments: true } },
      { githubWrites: { createIssues: 'yes' } },
      { githubWrites: { createIssues: true }, other: 1 },
    ]) {
      expect((await failure(apiRequest('settings', { method: 'PATCH', body: bad }))).status).toBe(400)
    }
    expect(stub.githubWrites).toEqual({ createIssues: false, editIssues: true })
  })

  it('POST api/issues needs createIssues, whatever editIssues says', async () => {
    const stub = installApiStub({ githubAccess: { mode: 'server' }, githubWrites: { editIssues: true } })
    await useSession.getState().load()
    const create = () => apiRequest('issues/acme/widgets', { method: 'POST', body: { title: 'New' } })
    const error = await failure(create())
    expect(error.code).toBe('github-writes-off')
    expect(error.message).toBe('The admin has not turned on creating issues on GitHub.')
    stub.setGithubWrites({ createIssues: true, editIssues: false })
    await expect(create()).resolves.toMatchObject({ issue: { title: 'New' } })
    const edit = await failure(
      apiRequest('issues/acme/widgets/7', { method: 'PATCH', body: { expectedUpdatedAt: '2026-01-01T00:00:00Z', fields: { title: 'X' } } }),
    )
    expect(edit.message).toBe('The admin has not turned on editing, closing and reopening issues on GitHub.')
  })
})
