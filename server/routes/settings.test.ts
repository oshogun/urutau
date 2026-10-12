import { afterEach, describe, expect, test } from 'vitest'
import type { CreateInviteResponse, ServerSettings } from '../../src/domain/api.ts'
import { createTestApp, type TestApp, type TestClient } from '../testing/harness.ts'

const ADMIN = { username: 'admin', password: 'correct horse battery' }
const ALL_OFF: ServerSettings = { githubWrites: { createIssues: false, editIssues: false } }
const ALL_ON: ServerSettings = { githubWrites: { createIssues: true, editIssues: true } }

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
  test('a fresh database reads every kind off for the admin and for a member', async () => {
    const member = await setUp()
    expect(await read(h)).toEqual(ALL_OFF)
    expect(await read(member)).toEqual(ALL_OFF)
  })

  test('a signed-out request is 401', async () => {
    await setUp()
    expect((await h.newClient().get('/api/settings')).status).toBe(401)
  })

  test('a member cannot change it, the admin can, and the member then reads it on', async () => {
    const member = await setUp()
    const refused = await member.send('PATCH', '/api/settings', { githubWrites: { createIssues: true } })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'forbidden' })
    expect(await read(h)).toEqual(ALL_OFF)

    const changed = await h.send('PATCH', '/api/settings', { githubWrites: { createIssues: true, editIssues: true } })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual(ALL_ON)
    expect(await read(member)).toEqual(ALL_ON)
    const logged = (kind: string) =>
      h.logs.some((line) => line.includes('"msg":"github writes changed"') && line.includes(`"kind":"${kind}"`) && line.includes('"on":true'))
    expect(logged('createIssues')).toBe(true)
    expect(logged('editIssues')).toBe(true)

    expect((await h.send('PATCH', '/api/settings', { githubWrites: { createIssues: false, editIssues: false } })).status).toBe(200)
    expect(await read(member)).toEqual(ALL_OFF)
  })

  test('a change to one kind leaves the other as it was', async () => {
    await setUp()
    const changed = await h.send('PATCH', '/api/settings', { githubWrites: { editIssues: true } })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ githubWrites: { createIssues: false, editIssues: true } })

    expect((await h.send('PATCH', '/api/settings', { githubWrites: { createIssues: true } })).status).toBe(200)
    expect(await read(h)).toEqual(ALL_ON)

    expect((await h.send('PATCH', '/api/settings', { githubWrites: { editIssues: false } })).status).toBe(200)
    expect(await read(h)).toEqual({ githubWrites: { createIssues: true, editIssues: false } })
  })

  test('a change needs the CSRF token and a session', async () => {
    await setUp()
    const body = { githubWrites: { createIssues: true } }
    const noCsrf = await h.send('PATCH', '/api/settings', body, { 'X-Urutau-CSRF': 'wrong' })
    expect(noCsrf.status).toBe(403)
    expect(await noCsrf.json()).toMatchObject({ error: 'csrf-rejected' })
    expect((await h.newClient().send('PATCH', '/api/settings', body)).status).toBe(401)
    expect(await read(h)).toEqual(ALL_OFF)
  })

  test.each([
    [{}],
    [[]],
    [{ githubWrites: 'yes' }],
    [{ githubWrites: true }],
    [{ githubWrites: {} }],
    [{ githubWrites: { comments: true } }],
    [{ githubWrites: { createIssues: true, comments: true } }],
    [{ githubWrites: { createIssues: 'yes' } }],
    [{ githubWrites: { createIssues: true }, x: 1 }],
    ['not json'],
  ])('the body %j is 400 and changes nothing', async (body) => {
    await setUp()
    const response = await h.send('PATCH', '/api/settings', body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid-request' })
    expect(await read(h)).toEqual(ALL_OFF)
  })

  test('an unknown kind is named in the message', async () => {
    await setUp()
    const response = await h.send('PATCH', '/api/settings', { githubWrites: { comments: true } })
    expect(await response.json()).toMatchObject({ error: 'invalid-request', message: 'Unknown kind of GitHub write: comments.' })
  })
})
