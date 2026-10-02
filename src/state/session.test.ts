import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installApiStub } from '../test/apiStub'
import { navigation, onSessionChange, useSession } from './session'

beforeEach(() => {
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
})

describe('session store', () => {
  it('loads a signed-in session and the config', async () => {
    installApiStub()
    await useSession.getState().load()
    const state = useSession.getState()
    expect(state.status).toBe('signed-in')
    expect(state.session?.user.username).toBe('ada')
    expect(state.config?.instanceId).toBe('instance-test')
  })

  it('reports first run when no account exists, and creates the admin', async () => {
    installApiStub({ session: 'first-run' })
    await useSession.getState().load()
    expect(useSession.getState()).toMatchObject({ status: 'signed-out', firstRun: true })
    await useSession.getState().createAdmin('root', 'a long enough password')
    expect(useSession.getState()).toMatchObject({ status: 'signed-in', firstRun: false })
    expect(useSession.getState().session?.user.isAdmin).toBe(true)
  })

  it('signs in, sends the session CSRF token afterwards, and signs out', async () => {
    const stub = installApiStub({ session: 'signed-out' })
    await useSession.getState().load()
    expect(useSession.getState().status).toBe('signed-out')

    await expect(useSession.getState().signIn('ada', 'wrong')).rejects.toMatchObject({
      code: 'invalid-credentials',
    })
    await useSession.getState().signIn('ada', 'correct horse')
    expect(useSession.getState().status).toBe('signed-in')

    const csrfToken = useSession.getState().session?.csrfToken
    expect(csrfToken).toBeTruthy()
    await useSession.getState().signOut()
    expect(stub.requests('POST auth/sign-out')[0].headers['x-urutau-csrf']).toBe(csrfToken)
    expect(useSession.getState()).toMatchObject({ status: 'signed-out', session: null })
  })

  it('follows redirectTo after signing out of a Keycloak session', async () => {
    installApiStub({ signOutRedirectTo: 'https://sso.example/logout' })
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {})
    await useSession.getState().load()
    await useSession.getState().signOut()
    expect(assign).toHaveBeenCalledWith('https://sso.example/logout')
  })

  it('accepts an invite and takes the new session from the response', async () => {
    const stub = installApiStub()
    await useSession.getState().load()
    const { apiRequest } = await import('../api/client')
    const created = await apiRequest<{ token: string }>('invites', { method: 'POST', body: {} })
    await useSession.getState().signOut()
    await useSession.getState().acceptInvite(created.token, 'grace', 'another password')
    expect(useSession.getState().session?.user).toMatchObject({ username: 'grace', isAdmin: false })
    expect(stub.invites).toHaveLength(0)
  })

  it('notifies listeners on every change, and markSignedOut is idempotent', async () => {
    installApiStub()
    const listener = vi.fn()
    const off = onSessionChange(listener)
    await useSession.getState().load()
    expect(listener).toHaveBeenCalledTimes(1)
    useSession.getState().markSignedOut()
    useSession.getState().markSignedOut()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(useSession.getState().status).toBe('signed-out')
    off()
  })

  it('ends the session when any request answers signed-out', async () => {
    const stub = installApiStub()
    await useSession.getState().load()
    stub.failNext('GET boards', { status: 401, error: 'signed-out' })
    const { apiRequest } = await import('../api/client')
    await expect(apiRequest('boards')).rejects.toMatchObject({ code: 'signed-out' })
    expect(useSession.getState().status).toBe('signed-out')
  })

  it('records a load error when the server is unreachable', async () => {
    const stub = installApiStub()
    stub.failNext(() => true, 'network', 2)
    await useSession.getState().load()
    expect(useSession.getState().status).toBe('signed-out')
    expect(useSession.getState().loadError).toMatch(/could not reach/i)
  })

  it('refresh replaces the session without a session change when it is the same user', async () => {
    const stub = installApiStub()
    await useSession.getState().load()
    const listener = vi.fn()
    const off = onSessionChange(listener)
    stub.setGithubAccess({ mode: 'browser', problem: 'signin-expired' })
    await useSession.getState().refresh()
    expect(useSession.getState().session?.githubAccess).toEqual({ mode: 'browser', problem: 'signin-expired' })
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('refresh signs out when the session is gone', async () => {
    const stub = installApiStub()
    await useSession.getState().load()
    await useSession.getState().signOut()
    stub.failNext('GET session', { status: 200, body: { signedIn: false, firstRun: false } })
    useSession.setState({ status: 'signed-in' })
    await useSession.getState().refresh()
    expect(useSession.getState().status).toBe('signed-out')
  })
})
