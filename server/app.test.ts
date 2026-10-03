import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { purgeExpired, serverSecrets } from './app.ts'
import { newBearerToken } from './auth/bearer.ts'
import { loadConfig } from './config.ts'
import { createApiToken } from './db/apiTokens.ts'
import { openDatabase } from './db/index.ts'
import { createIntegration } from './db/integrations.ts'
import { createLogger } from './log.ts'
import { start } from './main.ts'
import { registerStatic } from './static.ts'
import { createTestApp, type TestApp } from './testing/harness.ts'

describe('server secrets', () => {
  test('a log line never contains the database password or the Keycloak client secret', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://urutau:db-p%40ss-w0rd@db.internal:5432/urutau',
      PUBLIC_URL: 'https://urutau.example.com',
      KEYCLOAK_ISSUER: 'https://sso.example.com/realms/urutau',
      KEYCLOAK_CLIENT_ID: 'urutau',
      KEYCLOAK_CLIENT_SECRET: 'kc-client-secret-value',
    })
    const lines: string[] = []
    const log = createLogger({ write: (line) => void lines.push(line), secrets: serverSecrets(config) })
    log.info(`connecting to ${config.databaseUrl}`, { detail: 'password db-p@ss-w0rd and db-p%40ss-w0rd' })
    log.error('token request failed', { message: `client_secret=${config.keycloak!.clientSecret}` })

    const output = lines.join('\n')
    for (const secret of ['db-p@ss-w0rd', 'db-p%40ss-w0rd', 'kc-client-secret-value', config.databaseUrl]) {
      expect(output).not.toContain(secret)
    }
    expect(output).toContain('[redacted]')
  })

  test('the token encryption key is listed in base64 and redacted from a log line', () => {
    const key = Buffer.alloc(32, 7)
    const config = loadConfig({ DATABASE_URL: 'sqlite:data/x.db', TOKEN_ENCRYPTION_KEY: key.toString('base64') })
    expect(serverSecrets(config)).toEqual(['sqlite:data/x.db', key.toString('base64')])
    const lines: string[] = []
    createLogger({ write: (line) => void lines.push(line), secrets: serverSecrets(config) }).info(`key ${key.toString('base64')}`)
    expect(lines.join('')).not.toContain(key.toString('base64'))
  })

  test('without Keycloak only the database URL is listed', () => {
    const secrets = serverSecrets(loadConfig({ DATABASE_URL: 'sqlite:data/x.db' }))
    expect(secrets).toEqual(['sqlite:data/x.db'])
  })
})

describe('purgeExpired', () => {
  test('removes expired sessions and invites expired over 30 days ago, and keeps the rest', async () => {
    const h = await createTestApp()
    try {
      await h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })
      const day = 24 * 60 * 60 * 1000
      await h.post('/api/invites', { expiresInHours: 1 })
      await h.post('/api/invites', { expiresInHours: 720 })
      expect(await purgeExpired(h.database, h.clock.now)).toEqual({ sessions: 0, invites: 0, apiTokens: 0 })

      h.clock.advance(31 * day)
      expect(await purgeExpired(h.database, h.clock.now)).toEqual({ sessions: 1, invites: 1, apiTokens: 0 })
      expect(await h.database.db.selectFrom('invites').select('id').execute()).toHaveLength(1)
      h.clock.advance(31 * day)
      expect(await purgeExpired(h.database, h.clock.now)).toEqual({ sessions: 0, invites: 1, apiTokens: 0 })
    } finally {
      await h.close()
    }
  })
})

describe('purgeExpired and API tokens', () => {
  test('deletes tokens whose expiry has passed, counts them, and keeps live and never-expiring ones', async () => {
    const h = await createTestApp()
    try {
      await h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })
      const admin = (await h.database.db.selectFrom('users').select('id').executeTakeFirstOrThrow()).id
      const bot = await createIntegration(h.database.db, { username: 'planner-bot', createdBy: admin, now: h.clock.now })
      const day = 24 * 60 * 60 * 1000
      const add = (label: string, expiresAt: Date | null) =>
        createApiToken(h.database.db, { userId: bot.id, tokenHash: newBearerToken().hash, label, createdBy: admin, now: h.clock.now, expiresAt })
      await add('short', new Date(h.clock.now.getTime() + day))
      await add('long', new Date(h.clock.now.getTime() + 90 * day))
      await add('forever', null)
      expect(await purgeExpired(h.database, h.clock.now)).toMatchObject({ apiTokens: 0 })

      h.clock.advance(2 * day)
      expect(await purgeExpired(h.database, h.clock.now)).toMatchObject({ apiTokens: 1 })
      const left = await h.database.db.selectFrom('api_tokens').select('label').orderBy('label').execute()
      expect(left.map((row) => row.label)).toEqual(['forever', 'long'])
    } finally {
      await h.close()
    }
  })
})

describe('the server starts with no configuration', () => {
  test('the default config opens SQLite and migrates', async () => {
    const config = loadConfig({})
    expect(config.databaseUrl).toBe('sqlite:data/urutau.db')
    const database = await openDatabase('sqlite::memory:')
    await database.migrate()
    await database.close()
  })
})

describe('static serving', () => {
  let h: TestApp
  let dist: string
  beforeEach(async () => {
    h = await createTestApp()
    dist = await mkdtemp(join(tmpdir(), 'urutau-dist-'))
  })
  afterEach(async () => {
    await h.close()
    await rm(dist, { recursive: true, force: true })
  })

  async function build(): Promise<void> {
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>urutau</title>')
    await writeFile(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)')
    await writeFile(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  }

  test('serves index.html at / and for unknown paths, without caching it', async () => {
    await build()
    registerStatic(h.app, dist)
    for (const path of ['/', '/boards/acme/widgets', '/index.html']) {
      const response = await h.get(path)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<title>urutau</title>')
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  test('serves files, with hashed assets cached for a year', async () => {
    await build()
    registerStatic(h.app, dist)
    const asset = await h.get('/assets/index-abc123.js')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('console.log(1)')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect((await h.get('/favicon.svg')).headers.get('cache-control')).toBe('no-cache')
  })

  test('unknown /api paths stay JSON 404s and the API still answers', async () => {
    await build()
    registerStatic(h.app, dist)
    const missing = await h.get('/api/nothing')
    expect(missing.status).toBe(401)
    await h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })
    const signedIn = await h.get('/api/nothing')
    expect(signedIn.status).toBe(404)
    expect(await signedIn.json()).toMatchObject({ error: 'not-found' })
    expect((await h.get('/api/health')).status).toBe(200)
  })

  test('a missing /assets file gets the index with no-cache, not an immutable header', async () => {
    await build()
    registerStatic(h.app, dist)
    const response = await h.get('/assets/missing-chunk.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
  })

  test('only GET and HEAD get the app; other methods outside /api are 404', async () => {
    await build()
    registerStatic(h.app, dist)
    expect((await h.request('/', { method: 'POST' })).status).toBe(404)
    expect((await h.request('/', { method: 'HEAD' })).status).toBe(200)
  })

  test('a missing build answers 503 with a plain explanation', async () => {
    registerStatic(h.app, dist)
    const response = await h.get('/')
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('The app is not built. Run npm run build.')
  })
})

describe('JSON paths', () => {
  test('/mcp, discovery and OAuth paths answer JSON, also with the app served', async () => {
    const h = await createTestApp()
    const dist = await mkdtemp(join(tmpdir(), 'urutau-dist-'))
    try {
      await writeFile(join(dist, 'index.html'), '<!doctype html><title>urutau</title>')
      registerStatic(h.app, dist)
      for (const path of ['/mcp/', '/mcp/x', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/register', '/authorize', '/token']) {
        for (const method of ['GET', 'POST']) {
          const response = await h.request(path, { method })
          expect({ path, method, type: response.headers.get('content-type') }).toEqual({ path, method, type: expect.stringContaining('application/json') })
          expect(await response.json()).toMatchObject({ error: 'not-found' })
        }
      }
      const get = await h.request('/mcp')
      expect(get.status).toBe(401)
      expect(get.headers.get('content-type')).toContain('application/json')
      expect(await h.request('/mcp', { method: 'POST' }).then((r) => r.status)).toBe(401)
    } finally {
      await h.close()
      await rm(dist, { recursive: true, force: true })
    }
  })

  test('a wrong Host on /mcp gets a JSON 403', async () => {
    const h = await createTestApp()
    try {
      const response = await h.app.request('http://evil.example/mcp', { method: 'POST', headers: { host: 'evil.example' } })
      expect(response.status).toBe(403)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toMatchObject({ error: 'host-not-allowed' })
    } finally {
      await h.close()
    }
  })
})

describe('start', () => {
  const resources = () => process.getActiveResourcesInfo().filter((name) => name !== 'TTYWrap' && name !== 'PipeWrap')

  test('listens on port 0 with a stub fetch, answers, and stops without leaving a handle open', async () => {
    const before = resources()
    const lines: string[] = []
    const calls: string[] = []
    const stub: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response('{}')
    }
    const running = await start({ env: { DATABASE_URL: 'sqlite::memory:', HOST: '127.0.0.1' }, fetch: stub, port: 0, serveStatic: false, write: (line) => void lines.push(line) })
    expect(running.port).toBeGreaterThan(0)
    const health = await fetch(`http://127.0.0.1:${running.port}/api/health`, { headers: { connection: 'close' } })
    expect(health.status).toBe(200)
    const mcp = await fetch(`http://127.0.0.1:${running.port}/mcp`, { method: 'POST', headers: { connection: 'close' } })
    expect(mcp.status).toBe(401)
    expect(lines.some((line) => line.includes('TOKEN_ENCRYPTION_KEY is not set'))).toBe(true)

    await running.stop()
    await running.stop()
    const count = (names: string[], name: string) => names.filter((entry) => entry === name).length
    // Handles close on a later turn of the event loop, and so do the client sockets of this test's own fetches.
    for (let turn = 0; turn < 50; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
    for (const name of new Set(resources())) expect({ name, open: count(resources(), name) }).toEqual({ name, open: expect.toSatisfy((n: number) => n <= count(before, name)) })
    expect(calls).toEqual([])
    await expect(fetch(`http://127.0.0.1:${running.port}/api/health`)).rejects.toThrow()
  })

  test('with a key the warning is absent and the key never reaches the log', async () => {
    const key = Buffer.alloc(32, 7).toString('base64')
    const lines: string[] = []
    const running = await start({ env: { DATABASE_URL: 'sqlite::memory:', TOKEN_ENCRYPTION_KEY: key }, port: 0, serveStatic: false, write: (line) => void lines.push(line) })
    await running.stop()
    expect(lines.join('\n')).not.toContain('TOKEN_ENCRYPTION_KEY is not set')
    expect(lines.join('\n')).not.toContain(key)
  })

  test('an invalid configuration rejects with the message that names the variable', async () => {
    await expect(start({ env: { TOKEN_ENCRYPTION_KEY: 'nope' }, port: 0 })).rejects.toThrow('TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64')
  })
})
