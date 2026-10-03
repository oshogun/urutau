import { afterEach, describe, expect, test } from 'vitest'
import type { CreateInviteResponse, ServerSettings } from '../../src/domain/api.ts'
import { createTestApp, type TestApp, type TestClient } from '../testing/harness.ts'

const ADMIN = { username: 'admin', password: 'correct horse battery' }

let h: TestApp
afterEach(async () => {
  await h.close()
})

async function setUp(): Promise<TestClient> {
  h = await createTestApp()
  expect((await h.post('/api/auth/first-run', ADMIN)).status).toBe(201)
  const { token } = (await (await h.post('/api/invites', {})).json()) as CreateInviteResponse
  const member = h.newClient()
  expect((await member.post('/api/invites/accept', { token, username: 'maria', password: 'maria is signed in' })).status).toBe(201)
  return member
}

const read = async (client: TestClient) => (await (await client.get('/api/settings')).json()) as ServerSettings

describe('GET and PATCH /api/settings', () => {
  test('a fresh database reads off for the admin and for a member', async () => {
    const member = await setUp()
    expect(await read(h)).toEqual({ githubWrites: false })
    expect(await read(member)).toEqual({ githubWrites: false })
  })

  test('a signed-out request is 401', async () => {
    await setUp()
    expect((await h.newClient().get('/api/settings')).status).toBe(401)
  })

  test('a member cannot change it, the admin can, and the member then reads it on', async () => {
    const member = await setUp()
    const refused = await member.send('PATCH', '/api/settings', { githubWrites: true })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'forbidden' })
    expect(await read(h)).toEqual({ githubWrites: false })

    const changed = await h.send('PATCH', '/api/settings', { githubWrites: true })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ githubWrites: true })
    expect(await read(member)).toEqual({ githubWrites: true })
    expect(h.logs.some((line) => line.includes('"msg":"github writes changed"') && line.includes('"on":true'))).toBe(true)

    expect((await h.send('PATCH', '/api/settings', { githubWrites: false })).status).toBe(200)
    expect(await read(member)).toEqual({ githubWrites: false })
  })

  test('a change needs the CSRF token and a session', async () => {
    await setUp()
    const noCsrf = await h.send('PATCH', '/api/settings', { githubWrites: true }, { 'X-Urutau-CSRF': 'wrong' })
    expect(noCsrf.status).toBe(403)
    expect(await noCsrf.json()).toMatchObject({ error: 'csrf-rejected' })
    expect((await h.newClient().send('PATCH', '/api/settings', { githubWrites: true })).status).toBe(401)
    expect(await read(h)).toEqual({ githubWrites: false })
  })

  test.each([[{}], [[]], [{ githubWrites: 'yes' }], [{ githubWrites: true, x: 1 }], ['not json']])('the body %j is 400', async (body) => {
    await setUp()
    const response = await h.send('PATCH', '/api/settings', body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid-request' })
    expect(await read(h)).toEqual({ githubWrites: false })
  })
})
