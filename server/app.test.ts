import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { purgeExpired, serverSecrets } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db/index.ts'
import { createLogger } from './log.ts'
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
      expect(await purgeExpired(h.database, h.clock.now)).toEqual({ sessions: 0, invites: 0 })

      h.clock.advance(31 * day)
      expect(await purgeExpired(h.database, h.clock.now)).toEqual({ sessions: 1, invites: 1 })
      expect(await h.database.db.selectFrom('invites').select('id').execute()).toHaveLength(1)
      h.clock.advance(31 * day)
      expect(await purgeExpired(h.database, h.clock.now)).toEqual({ sessions: 0, invites: 1 })
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
