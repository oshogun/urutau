import { afterEach, describe, expect, test, vi } from 'vitest'
import type { BoardListResponse, ImportBoardsResponse, StaleBoardResponse, StoredBoard } from '../../src/domain/api.ts'
import { sha256Hex } from '../auth/tokens.ts'
import { fixtureBoard } from '../db/fixtures.ts'
import { createTestApp, type TestApp, type TestClient } from '../testing/harness.ts'

const ADMIN = { username: 'admin', password: 'correct horse battery' }
const PATH = '/api/boards/acme/widgets'

let h: TestApp
afterEach(async () => {
  await h.close()
})

async function setUp(): Promise<void> {
  h = await createTestApp()
  expect((await h.post('/api/auth/first-run', ADMIN)).status).toBe(201)
}

/** A second browser signed in as the admin: a separate session. */
async function secondSession(): Promise<TestClient> {
  const browser = h.newClient()
  expect((await browser.post('/api/auth/sign-in', ADMIN)).status).toBe(200)
  return browser
}

function save(baseVersion: number | null, title = 'To do', fullName = 'acme/widgets') {
  return { baseVersion, fullName, board: fixtureBoard(title) }
}

describe('saving a board', () => {
  test('creates at version 1, then each save with the current version returns the next one', async () => {
    await setUp()
    const created = await h.put(PATH, save(null), { 'X-Urutau-Client': 'tab-1' })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ repoKey: 'acme/widgets', version: 1, updatedBy: { username: 'admin' } })

    const second = await h.put(PATH, save(1, 'Doing'))
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ version: 2 })
    const stored = (await (await h.get(PATH)).json()) as StoredBoard
    expect(stored.version).toBe(2)
    expect(stored.board.buckets[0].title).toBe('Doing')
    expect(h.events.map((event) => event.type)).toEqual(['board-updated', 'board-updated'])
    expect(h.events[0].data).toMatchObject({ repoKey: 'acme/widgets', version: 1, clientId: 'tab-1' })
    expect(h.events[1].data).toMatchObject({ version: 2, clientId: null })
  })

  test('a save from an old version gets 409 with the stored board, changes nothing and publishes nothing', async () => {
    await setUp()
    await h.put(PATH, save(null))
    await h.put(PATH, save(1, 'Doing'))
    h.events.length = 0

    const stale = await h.put(PATH, save(1, 'Overwrite attempt'))
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as StaleBoardResponse
    expect(body.error).toBe('stale-board')
    expect(body.current).toMatchObject({ version: 2, board: { buckets: [{ title: 'Doing' }] } })
    const stored = (await (await h.get(PATH)).json()) as StoredBoard
    expect(stored).toMatchObject({ version: 2, board: { buckets: [{ title: 'Doing' }] } })
    expect(h.events).toEqual([])
  })

  test('two interleaved saves from two sessions give one success and one 409', async () => {
    await setUp()
    await h.put(PATH, save(null))
    const other = await secondSession()
    const [a, b] = await Promise.all([h.put(PATH, save(1, 'From A')), other.put(PATH, save(1, 'From B'))])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const stored = (await (await h.get(PATH)).json()) as StoredBoard
    expect(stored.version).toBe(2)
    const winner = a.status === 200 ? 'From A' : 'From B'
    expect(stored.board.buckets[0].title).toBe(winner)
  })

  test('creating a board that exists, or saving one that does not, answers 409', async () => {
    await setUp()
    const missing = await h.put(PATH, save(3))
    expect(missing.status).toBe(409)
    expect(((await missing.json()) as StaleBoardResponse).current).toBeNull()

    await h.put(PATH, save(null))
    const duplicate = await h.put(PATH, save(null, 'Again'))
    expect(duplicate.status).toBe(409)
    expect(((await duplicate.json()) as StaleBoardResponse).current).toMatchObject({ version: 1 })
  })

  test('the path is case-insensitive and fullName keeps the GitHub spelling', async () => {
    await setUp()
    expect((await h.put('/api/boards/Acme/Widgets', save(null, 'To do', 'Acme/Widgets'))).status).toBe(201)
    const stored = (await (await h.get('/api/boards/ACME/widgets')).json()) as StoredBoard
    expect(stored).toMatchObject({ repoKey: 'acme/widgets', fullName: 'Acme/Widgets' })
  })

  test('rejects a bad path, fullName, baseVersion or board with 400', async () => {
    await setUp()
    expect((await h.put('/api/boards/acme/widgets.git', save(null))).status).toBe(400)
    expect((await h.put('/api/boards/-bad/widgets', save(null, 'To do', '-bad/widgets'))).status).toBe(400)
    expect((await h.put(PATH, save(null, 'To do', 'acme/other'))).status).toBe(400)
    expect((await h.put(PATH, save(null, 'To do', 'https://github.com/acme/widgets'))).status).toBe(400)
    expect((await h.put(PATH, save(0))).status).toBe(400)
    expect((await h.put(PATH, { ...save(null), baseVersion: '1' })).status).toBe(400)
    expect((await h.put(PATH, { ...save(null), board: { version: 1 } })).status).toBe(400)
    expect((await h.put(PATH, 'not json')).status).toBe(400)
    expect((await h.get('/api/boards/acme/widgets.git')).status).toBe(400)
    expect((await h.get(PATH)).status).toBe(404)
  })

  test('a body over 1 MiB answers 413', async () => {
    await setUp()
    const response = await h.put(PATH, save(null, 'x'.repeat(1024 * 1024 + 10)))
    expect(response.status).toBe(413)
  })
})

describe('listing boards', () => {
  test('every signed-in user sees every user\'s boards, newest first', async () => {
    await setUp()
    await h.put(PATH, save(null))
    h.clock.advance(1000)
    await h.put('/api/boards/acme/gadgets', save(null, 'To do', 'acme/gadgets'))

    const invite = (await (await h.post('/api/invites', {})).json()) as { token: string }
    const maria = h.newClient()
    expect((await maria.post('/api/invites/accept', { token: invite.token, username: 'maria', password: 'maria password' })).status).toBe(201)
    h.clock.advance(1000)
    await maria.put('/api/boards/zed/repo', save(null, 'To do', 'zed/repo'))

    const list = (await (await maria.get('/api/boards')).json()) as BoardListResponse
    expect(list.boards.map((board) => [board.repoKey, board.updatedBy?.username])).toEqual([
      ['zed/repo', 'maria'],
      ['acme/gadgets', 'admin'],
      ['acme/widgets', 'admin'],
    ])
    expect(JSON.stringify(list)).not.toContain('buckets')
  })

  test('signed-out requests get 401', async () => {
    await setUp()
    const stranger = h.newClient()
    expect((await stranger.get('/api/boards')).status).toBe(401)
    expect((await stranger.get(PATH)).status).toBe(401)
    expect((await stranger.put(PATH, save(null))).status).toBe(401)
    expect((await stranger.delete(`${PATH}?version=1`)).status).toBe(401)
    expect((await stranger.post('/api/boards/import', { boards: {} })).status).toBe(401)
  })
})

describe('deleting a board', () => {
  test('deletes at the current version and publishes board-deleted', async () => {
    await setUp()
    await h.put(PATH, save(null))
    h.events.length = 0
    expect((await h.delete(`${PATH}?version=1`, { 'X-Urutau-Client': 'tab-9' })).status).toBe(204)
    expect((await h.get(PATH)).status).toBe(404)
    expect(h.events).toEqual([{ type: 'board-deleted', data: { repoKey: 'acme/widgets', clientId: 'tab-9' } }])
  })

  test('a stale version gets 409 with the board; a missing board 404; a bad version 400', async () => {
    await setUp()
    await h.put(PATH, save(null))
    await h.put(PATH, save(1))
    h.events.length = 0
    const stale = await h.delete(`${PATH}?version=1`)
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as StaleBoardResponse).current).toMatchObject({ version: 2 })
    expect((await h.get(PATH)).status).toBe(200)
    expect(h.events).toEqual([])

    expect((await h.delete('/api/boards/acme/none?version=1')).status).toBe(404)
    expect((await h.delete(PATH)).status).toBe(400)
    expect((await h.delete(`${PATH}?version=abc`)).status).toBe(400)
    expect((await h.delete(`${PATH}?version=0`)).status).toBe(400)
  })
})

describe('importing version-1 boards', () => {
  const IMPORT = '/api/boards/import'

  test('stores boards once at version 1 and a second import of the same key does not overwrite', async () => {
    await setUp()
    const first = await h.post(IMPORT, { boards: { 'acme/widgets': fixtureBoard('Local one'), 'acme/gadgets': fixtureBoard('Local two') } })
    expect(first.status).toBe(200)
    const body = (await first.json()) as ImportBoardsResponse
    expect(body).toEqual({ imported: ['acme/widgets', 'acme/gadgets'], skipped: [], invalid: [] })
    const stored = (await (await h.get(PATH)).json()) as StoredBoard
    expect(stored).toMatchObject({ version: 1, fullName: 'acme/widgets', updatedBy: { username: 'admin' } })
    expect(h.events.map((event) => event.data)).toHaveLength(2)

    await h.put(PATH, save(1, 'Edited on the server'))
    h.events.length = 0
    const again = (await (await h.post(IMPORT, { boards: { 'acme/widgets': fixtureBoard('Different local'), 'acme/new': fixtureBoard() } })).json()) as ImportBoardsResponse
    expect(again).toEqual({ imported: ['acme/new'], skipped: ['acme/widgets'], invalid: [] })
    const kept = (await (await h.get(PATH)).json()) as StoredBoard
    expect(kept).toMatchObject({ version: 2, board: { buckets: [{ title: 'Edited on the server' }] } })
    expect(h.events).toHaveLength(1)
    expect(h.events[0].data).toMatchObject({ repoKey: 'acme/new', version: 1 })
  })

  test('keys that are not repository keys and values that are not boards go to invalid', async () => {
    await setUp()
    const response = await h.post(IMPORT, {
      boards: { 'Acme/Widgets': fixtureBoard(), 'not a repo': fixtureBoard(), 'acme/broken': { version: 1 }, 'acme/ok': fixtureBoard() },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ imported: ['acme/ok'], skipped: [], invalid: ['Acme/Widgets', 'not a repo', 'acme/broken'] })
    expect(((await (await h.get('/api/boards')).json()) as BoardListResponse).boards).toHaveLength(1)
  })

  test('malformed input answers 400 and stores nothing', async () => {
    await setUp()
    for (const body of ['not json', 'null', '[]', '{}', '{"boards":[]}', '{"boards":"x"}']) {
      expect({ body, status: (await h.post(IMPORT, body)).status }).toEqual({ body, status: 400 })
    }
    expect(((await (await h.get('/api/boards')).json()) as BoardListResponse).boards).toEqual([])
    expect(h.events).toEqual([])
  })

  test('accepts up to 5 MiB, unlike the 1 MiB of other routes', async () => {
    await setUp()
    const big = fixtureBoard('x'.repeat(2 * 1024 * 1024))
    const response = await h.post(IMPORT, { boards: { 'acme/big': big } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ imported: ['acme/big'] })
    expect((await h.post(IMPORT, { boards: { 'acme/huge': fixtureBoard('x'.repeat(5 * 1024 * 1024)) } })).status).toBe(413)
  })
})

describe('live updates', () => {
  type Stream = { text: () => string; waitFor: (needle: string) => Promise<void>; cancel: () => Promise<void>; response: Response }

  async function open(app: TestApp['app'], client: TestClient, repo = 'acme/widgets'): Promise<Stream> {
    const response = await app.request(`/api/events?repo=${repo}`, { headers: { cookie: cookieOf(client) } })
    let text = ''
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let pump: Promise<void> | null = null
    const waiters: Array<() => void> = []
    if (reader) {
      pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
          if (done) break
          text += decoder.decode(value, { stream: true })
          for (const waiter of waiters.splice(0)) waiter()
        }
      })()
    }
    return {
      response,
      text: () => text,
      async waitFor(needle) {
        const deadline = Date.now() + 1000
        while (!text.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; got ${JSON.stringify(text)}`)
          await new Promise<void>((resolve) => {
            waiters.push(resolve)
            setTimeout(resolve, 20)
          })
        }
      },
      async cancel() {
        await reader?.cancel().catch(() => {})
        await pump
      },
    }
  }

  function cookieOf(client: TestClient): string {
    return [...client.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  async function via(app: TestApp['app'], client: TestClient, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, {
      method,
      headers: { cookie: cookieOf(client), 'X-Urutau-CSRF': client.csrfToken ?? '1', 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async function setUpStreaming(pingMs = 25_000) {
    await setUp()
    h.hub.pingMs = pingMs
    const other = await secondSession()
    return { hub: h.hub, app: h.app, other }
  }

  test('a subscriber gets hello, then the event with repo key, version and client id, within a second of another session\'s save', async () => {
    const { app, other } = await setUpStreaming()
    await via(app, h, 'PUT', PATH, save(null))
    const stream = await open(app, h)
    expect(stream.response.status).toBe(200)
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream')
    expect(stream.response.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(stream.response.headers.get('x-accel-buffering')).toBe('no')
    await stream.waitFor('event: hello')
    expect(stream.text()).toMatch(/^retry: 5000\n\nevent: hello\ndata: \{"repoKey":"acme\/widgets","version":1\}/)

    const started = Date.now()
    expect((await via(app, other, 'PUT', PATH, save(1, 'Doing'), { 'X-Urutau-Client': 'tab-7' })).status).toBe(200)
    await stream.waitFor('event: board-updated')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(stream.text()).toContain('"repoKey":"acme/widgets","version":2')
    expect(stream.text()).toContain('"clientId":"tab-7"')
    expect(stream.text()).not.toContain('Doing')
    expect(stream.text()).not.toContain('id:')
    await stream.cancel()
  })

  test('hello carries a null version when the board does not exist; delete and import events arrive', async () => {
    const { app } = await setUpStreaming()
    const stream = await open(app, h)
    await stream.waitFor('event: hello')
    expect(stream.text()).toContain('"version":null')
    await via(app, h, 'POST', '/api/boards/import', { boards: { 'acme/widgets': fixtureBoard() } })
    await stream.waitFor('event: board-updated')
    await via(app, h, 'DELETE', `${PATH}?version=1`, undefined, { 'X-Urutau-Client': 'tab-2' })
    await stream.waitFor('event: board-deleted')
    expect(stream.text()).toContain('"clientId":"tab-2"')
    await stream.cancel()
  })

  test('a 409 save, and a save to another repository, publish nothing to the stream', async () => {
    const { app, other } = await setUpStreaming()
    await via(app, h, 'PUT', PATH, save(null))
    const stream = await open(app, h)
    await stream.waitFor('event: hello')
    expect((await via(app, other, 'PUT', PATH, save(7))).status).toBe(409)
    await via(app, other, 'PUT', '/api/boards/acme/gadgets', save(null, 'To do', 'acme/gadgets'))
    // A save that does publish, as a marker that earlier events would have arrived by now.
    await via(app, other, 'PUT', PATH, save(1, 'Marker'))
    await stream.waitFor('"version":2')
    expect(stream.text().match(/event: board-updated/g)).toHaveLength(1)
    await stream.cancel()
  })

  test('the stream needs a session and a repository key', async () => {
    const { app } = await setUpStreaming()
    expect((await app.request('/api/events?repo=acme/widgets')).status).toBe(401)
    expect((await via(app, h, 'GET', '/api/events')).status).toBe(400)
    expect((await via(app, h, 'GET', '/api/events?repo=not-a-repo')).status).toBe(400)
  })

  test('a closed connection is removed from the publisher', async () => {
    const { app, hub } = await setUpStreaming()
    const a = await open(app, h)
    const b = await open(app, h, 'acme/gadgets')
    await a.waitFor('event: hello')
    await b.waitFor('event: hello')
    expect(hub.size()).toBe(2)
    await a.cancel()
    await vi.waitFor(() => expect(hub.size()).toBe(1))
    await b.cancel()
    await vi.waitFor(() => expect(hub.size()).toBe(0))
  })

  test('the heartbeat is sent, and a signed-out session\'s stream ends at the next one', async () => {
    const { app, hub } = await setUpStreaming(30)
    const stream = await open(app, h)
    await stream.waitFor(': ping')
    expect((await h.post('/api/auth/sign-out')).status).toBe(200)
    await vi.waitFor(() => expect(hub.size()).toBe(0))
    await stream.cancel()
  })

  test('closeSession on the hub ends a session\'s stream', async () => {
    const { app, hub } = await setUpStreaming()
    const stream = await open(app, h)
    await stream.waitFor('event: hello')
    hub.closeSession(sha256Hex(h.cookies.get('urutau_session')!))
    await vi.waitFor(() => expect(hub.size()).toBe(0))
    await stream.cancel()
  })

  test('sign-out ends that session\'s stream at once, leaving the same user\'s other session open', async () => {
    const { app, hub, other } = await setUpStreaming()
    const mine = await open(app, h)
    const theirs = await open(app, other)
    await mine.waitFor('event: hello')
    await theirs.waitFor('event: hello')
    expect(hub.size()).toBe(2)
    expect((await h.post('/api/auth/sign-out')).status).toBe(200)
    await vi.waitFor(() => expect(hub.size()).toBe(1), { timeout: 500 })
    await mine.cancel()
    await theirs.cancel()
  })

  test('removing a user ends their streams at once and leaves another user\'s stream open', async () => {
    const { app, hub } = await setUpStreaming()
    const invite = (await (await h.post('/api/invites', {})).json()) as { token: string }
    const maria = h.newClient()
    const accepted = await maria.post('/api/invites/accept', { token: invite.token, username: 'maria', password: 'maria password' })
    const mariaId = ((await accepted.json()) as { user: { id: string } }).user.id
    const adminStream = await open(app, h)
    const mariaStream = await open(app, maria)
    await adminStream.waitFor('event: hello')
    await mariaStream.waitFor('event: hello')
    expect(hub.size()).toBe(2)

    expect((await h.delete(`/api/users/${mariaId}`)).status).toBe(204)
    await vi.waitFor(() => expect(hub.size()).toBe(1), { timeout: 500 })
    await mariaStream.cancel()
    await h.put(PATH, save(null))
    await adminStream.waitFor('event: board-updated')
    await adminStream.cancel()
  })

  test('a session deleted without closeSession (for example expired) ends its stream at the next heartbeat', async () => {
    const { app, hub } = await setUpStreaming(30)
    const stream = await open(app, h)
    await stream.waitFor('event: hello')
    await h.database.db.deleteFrom('sessions').execute()
    await vi.waitFor(() => expect(hub.size()).toBe(0), { timeout: 500 })
    await stream.cancel()
  })
})
