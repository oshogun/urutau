import { afterEach, describe, expect, test } from 'vitest'
import type { CreateInviteResponse, InviteListResponse, Session, UserListResponse } from '../../src/domain/api.ts'
import { createTestApp, setUpAgent, type TestApp, type TestClient } from '../testing/harness.ts'

const ADMIN = { username: 'admin', password: 'correct horse battery' }
const HOUR = 60 * 60 * 1000

let h: TestApp
afterEach(async () => {
  await h.close()
})

async function setUp(): Promise<void> {
  h = await createTestApp()
  expect((await h.post('/api/auth/first-run', ADMIN)).status).toBe(201)
}

async function createInvite(body: unknown = {}): Promise<CreateInviteResponse> {
  const response = await h.post('/api/invites', body)
  expect(response.status).toBe(201)
  return (await response.json()) as CreateInviteResponse
}

/** Accepts an invite as a new browser and returns it with the response. */
async function accept(token: string, username = 'maria', password = 'maria is signed in') {
  const browser = h.newClient()
  const response = await browser.post('/api/invites/accept', { token, username, password })
  return { browser, response }
}

describe('invites', () => {
  test('an invite link works exactly once and signs the invitee in with their own credentials', async () => {
    await setUp()
    const { token, invite } = await createInvite()
    expect(invite.createdBy).toMatchObject({ username: 'admin' })

    const check = await h.newClient().post('/api/invites/check', { token })
    expect(check.status).toBe(200)
    expect(await check.json()).toEqual({ expiresAt: invite.expiresAt })

    const { browser, response } = await accept(token)
    expect(response.status).toBe(201)
    const session = (await response.json()) as Session
    expect(session.user).toMatchObject({ username: 'maria', isAdmin: false, authMethod: 'local' })
    expect(await (await browser.get('/api/session')).json()).toMatchObject({ signedIn: true, session: { user: { username: 'maria' } } })

    const second = await accept(token, 'someone-else', 'another long password')
    expect(second.response.status).toBe(404)
    expect(await second.response.json()).toMatchObject({ error: 'invite-invalid' })
    expect((await h.newClient().post('/api/invites/check', { token })).status).toBe(404)
    expect(await h.database.db.selectFrom('users').select('username').execute()).toHaveLength(2)

    const again = h.newClient()
    expect((await again.post('/api/auth/sign-in', { username: 'maria', password: 'maria is signed in' })).status).toBe(200)
    const used = await h.database.db.selectFrom('invites').selectAll().executeTakeFirstOrThrow()
    expect(used.used_by).toBe(session.user.id)
  })

  test('the token is stored only as a hash, and expires after the requested hours', async () => {
    await setUp()
    const { token, invite } = await createInvite({ expiresInHours: 2 })
    const row = await h.database.db.selectFrom('invites').selectAll().executeTakeFirstOrThrow()
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.token_hash).not.toContain(token)
    expect(invite.expiresAt).toBe(new Date(h.clock.now.getTime() + 2 * HOUR).toISOString())
    expect((await createInvite()).invite.expiresAt).toBe(new Date(h.clock.now.getTime() + 168 * HOUR).toISOString())
  })

  test('an expired invite is refused by check and accept', async () => {
    await setUp()
    const { token } = await createInvite({ expiresInHours: 1 })
    h.clock.advance(HOUR + 1000)
    expect((await h.newClient().post('/api/invites/check', { token })).status).toBe(404)
    const { response } = await accept(token)
    expect(response.status).toBe(404)
    expect(await h.database.db.selectFrom('users').select('id').execute()).toHaveLength(1)
  })

  test('an unknown token is refused', async () => {
    await setUp()
    expect((await h.newClient().post('/api/invites/check', { token: 'nope' })).status).toBe(404)
    expect((await accept('nope')).response.status).toBe(404)
    expect((await h.newClient().post('/api/invites/check', {})).status).toBe(400)
  })

  test('a taken username answers 409 and leaves the invite usable', async () => {
    await setUp()
    const { token } = await createInvite()
    const taken = await accept(token, 'ADMIN')
    expect(taken.response.status).toBe(409)
    expect(await taken.response.json()).toMatchObject({ error: 'username-taken' })
    expect((await accept(token)).response.status).toBe(201)
  })

  test('an invalid username or password is rejected without using the invite', async () => {
    await setUp()
    const { token } = await createInvite()
    expect((await accept(token, 'x')).response.status).toBe(400)
    expect((await accept(token, 'maria', 'short')).response.status).toBe(400)
    expect((await accept(token)).response.status).toBe(201)
  })

  test('two simultaneous accepts of one invite create one account', async () => {
    await setUp()
    const { token } = await createInvite()
    const [a, b] = await Promise.all([accept(token, 'first-user', 'first user password'), accept(token, 'second-user', 'second user password')])
    expect([a.response.status, b.response.status].sort()).toEqual([201, 404])
    expect(await h.database.db.selectFrom('users').select('id').execute()).toHaveLength(2)
  })

  test('the admin lists pending invites and can revoke one', async () => {
    await setUp()
    const first = await createInvite()
    const second = await createInvite()
    await accept(second.token)
    const list = (await (await h.get('/api/invites')).json()) as InviteListResponse
    expect(list.invites.map((invite) => invite.id)).toEqual([first.invite.id])

    expect((await h.delete(`/api/invites/${first.invite.id}`)).status).toBe(204)
    expect((await h.newClient().post('/api/invites/check', { token: first.token })).status).toBe(404)
    expect((await h.delete(`/api/invites/${first.invite.id}`)).status).toBe(404)
    expect((await h.post('/api/invites', { expiresInHours: 0 })).status).toBe(400)
    expect((await h.post('/api/invites', { expiresInHours: 721 })).status).toBe(400)
    expect((await h.post('/api/invites', { expiresInHours: 1.5 })).status).toBe(400)
  })

  test('the invite token never appears in a log line', async () => {
    await setUp()
    const { token } = await createInvite()
    await accept(token, 'maria', 'a password to hide')
    await h.newClient().post('/api/invites/check', { token })
    const output = h.logs.join('\n')
    expect(output).not.toContain(token)
    expect(output).not.toContain('a password to hide')
  })
})

describe('admin-only routes', () => {
  async function invitee(): Promise<{ browser: TestClient; id: string }> {
    const { token } = await createInvite()
    const { browser, response } = await accept(token)
    return { browser, id: ((await response.json()) as Session).user.id }
  }

  test('a regular user gets 403 on every admin route, including creating an invite', async () => {
    await setUp()
    const { browser } = await invitee()
    const admin = ((await (await h.get('/api/users')).json()) as UserListResponse).users[0]
    const refused = [
      await browser.get('/api/users'),
      await browser.delete(`/api/users/${admin.id}`),
      await browser.get('/api/invites'),
      await browser.post('/api/invites', {}),
      await browser.delete('/api/invites/anything'),
    ]
    for (const response of refused) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'forbidden' })
    }
    expect(await h.database.db.selectFrom('invites').select('id').execute()).toHaveLength(1)
  })

  test('the admin lists users oldest first', async () => {
    await setUp()
    h.clock.advance(1000)
    await invitee()
    const list = (await (await h.get('/api/users')).json()) as UserListResponse
    expect(list.users.map((user) => [user.username, user.isAdmin, user.authMethod])).toEqual([
      ['admin', true, 'local'],
      ['maria', false, 'local'],
    ])
    expect(JSON.stringify(list)).not.toContain('$2')
  })

  test('removing a user ends their sessions; the admin cannot be removed; an unknown id is 404', async () => {
    await setUp()
    const { browser, id } = await invitee()
    expect((await browser.get('/api/boards')).status).toBe(200)

    expect((await h.delete(`/api/users/${id}`)).status).toBe(204)
    expect((await browser.get('/api/boards')).status).toBe(401)
    expect(await h.database.db.selectFrom('sessions').select('user_id').execute()).toHaveLength(1)
    expect((await h.delete(`/api/users/${id}`)).status).toBe(404)

    const admin = ((await (await h.get('/api/users')).json()) as UserListResponse).users[0]
    const refused = await h.delete(`/api/users/${admin.id}`)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'cannot-remove-admin' })
  })

  test('integrations are left out of the list and cannot be removed here', async () => {
    await setUp()
    const agent = await setUpAgent(h, { githubToken: false })
    h.clock.advance(1000)
    await invitee()
    const list = (await (await h.get('/api/users')).json()) as UserListResponse
    expect(list.users.map((user) => user.username)).toEqual(['admin', 'maria'])

    const refused = await h.delete(`/api/users/${agent.id}`)
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({ error: 'not-found', message: 'There is no user with this id.' })
    expect(await h.database.db.selectFrom('integrations').select('user_id').execute()).toHaveLength(1)
    expect((await h.delete(`/api/integrations/${agent.id}`)).status).toBe(204)
  })
})
