import { afterEach, describe, expect, test } from 'vitest'
import { loadConfig } from '../config.ts'
import { createTestApp, type TestApp } from '../testing/harness.ts'
import { acceptedHostnames, startupWarning } from './hostGuard.ts'

let h: TestApp
afterEach(async () => {
  await h.close()
})

const VALID = { username: 'admin', password: 'correct horse battery' }

test('a rebinding request with a matching Origin cannot create the admin', async () => {
  h = await createTestApp()
  const response = await h.post('/api/auth/first-run', VALID, { host: 'evil.example:8789', origin: 'http://evil.example:8789' })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ error: 'host-not-allowed' })
  expect(await (await h.get('/api/session')).json()).toEqual({ signedIn: false, firstRun: true })
})

describe('without PUBLIC_URL', () => {
  const accepted = ['localhost:8787', '127.0.0.1:5174', '[::1]:8787', '192.168.1.5:8787', 'LOCALHOST.:8787']
  const refused = ['evil.example', 'localhost.evil.example', '127.0.0.1.nip.io:8787', 'evil.example:8787', 'not a host']

  test.each(['/api/session', '/'])('%s: loopback names and IP addresses pass, other names get 403', async (path) => {
    h = await createTestApp()
    expect((await h.request(path)).status).not.toBe(403)
    for (const host of accepted) {
      expect({ host, status: (await h.request(path, { headers: { host } })).status }).not.toEqual({ host, status: 403 })
    }
    for (const host of refused) {
      const response = await h.request(path, { headers: { host } })
      expect({ host, status: response.status }).toEqual({ host, status: 403 })
      if (path === '/') {
        expect(response.headers.get('content-type')).toContain('text/plain')
      } else {
        expect(await response.json()).toMatchObject({ error: 'host-not-allowed' })
      }
    }
  })

  test('the refusal is logged once per hostname', async () => {
    h = await createTestApp()
    for (let i = 0; i < 3; i += 1) await h.request('/api/session', { headers: { host: 'evil.example' } })
    await h.request('/api/session', { headers: { host: 'other.example' } })
    const warnings = h.logs.map((line) => JSON.parse(line) as { level: string; host?: string }).filter((line) => line.level === 'warn')
    expect(warnings.map((line) => line.host)).toEqual(['evil.example', 'other.example'])
  })
})

describe('with PUBLIC_URL, ALLOWED_HOSTS and TRUST_PROXY', () => {
  async function configured() {
    const config = loadConfig({ PUBLIC_URL: 'https://urutau.example.com', ALLOWED_HOSTS: 'urutau', TRUST_PROXY: 'true' })
    h = await createTestApp({ config })
  }

  test('accepts the configured names in any case, with a trailing dot or a port', async () => {
    await configured()
    for (const host of ['urutau.example.com', 'URUTAU.example.com.', 'urutau:8080', '127.0.0.1:8787']) {
      expect({ host, status: (await h.request('/api/session', { headers: { host } })).status }).toEqual({ host, status: 200 })
    }
    expect((await h.request('/api/session', { headers: { host: 'other.example.com' } })).status).toBe(403)
  })

  test('X-Forwarded-Host never counts', async () => {
    await configured()
    const response = await h.request('/api/session', { headers: { host: 'evil.example', 'x-forwarded-host': 'urutau.example.com' } })
    expect(response.status).toBe(403)
  })

  test('the host of the request URL is checked too, not only the Host header', async () => {
    await configured()
    expect((await h.app.request('http://localhost/api/session', { headers: { host: 'evil.example' } })).status).toBe(403)
    expect((await h.app.request('http://rebind.example:8789/api/session', { headers: { host: 'localhost:8789' } })).status).toBe(403)
    const warnings = h.logs.map((line) => JSON.parse(line) as { level: string; host?: string }).filter((line) => line.level === 'warn')
    expect(warnings.map((line) => line.host)).toEqual(['evil.example', 'rebind.example:8789'])
    expect(acceptedHostnames(h.deps.config)).toEqual(['urutau.example.com', 'urutau'])
  })
})

describe('startup warning', () => {
  test('is given for a non-loopback bind with neither variable, and for no other case', () => {
    expect(startupWarning(loadConfig({ HOST: '0.0.0.0' }))).toContain('Listening on 0.0.0.0:8787 without PUBLIC_URL or ALLOWED_HOSTS')
    expect(startupWarning(loadConfig({ HOST: '127.0.0.1' }))).toBeNull()
    expect(startupWarning(loadConfig({ HOST: '::1' }))).toBeNull()
    expect(startupWarning(loadConfig({ HOST: '0.0.0.0', PUBLIC_URL: 'https://urutau.example.com' }))).toBeNull()
    expect(startupWarning(loadConfig({ HOST: '0.0.0.0', ALLOWED_HOSTS: 'urutau' }))).toBeNull()
  })
})
