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
