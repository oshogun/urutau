import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, CLIENT_ID, apiRequest, setCsrfToken, setSignedOutHandler } from './client'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

function stubFetch(response: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  setCsrfToken(null)
  setSignedOutHandler(null)
})

describe('apiRequest', () => {
  it('uses a relative URL, same-origin cookies and no Authorization header', async () => {
    const fetchMock = stubFetch(() => json(200, { ok: true }))
    await expect(apiRequest('boards')).resolves.toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('api/boards')
    expect(init?.credentials).toBe('same-origin')
    const headers = init?.headers as Record<string, string>
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization')
    expect(headers['X-Urutau-CSRF']).toBeUndefined()
  })

  it('sends the CSRF token on state-changing requests, and 1 before sign-in', async () => {
    const fetchMock = stubFetch(() => json(200, {}))
    await apiRequest('auth/sign-in', { method: 'POST', body: { a: 1 } })
    setCsrfToken('tok')
    await apiRequest('boards/a/b', { method: 'PUT', body: {}, headers: { 'X-Urutau-Client': 'c' } })
    const first = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    const second = fetchMock.mock.calls[1][1]?.headers as Record<string, string>
    expect(first['X-Urutau-CSRF']).toBe('1')
    expect(first['Content-Type']).toBe('application/json')
    expect(second['X-Urutau-CSRF']).toBe('tok')
    expect(second['X-Urutau-Client']).toBe('c')
    expect(fetchMock.mock.calls[0][1]?.body).toBe('{"a":1}')
  })

  it('throws an ApiError with the code and body of a non-2xx answer', async () => {
    stubFetch(() => json(409, { error: 'stale-board', message: 'Changed.', current: null }))
    const error = await apiRequest('boards/a/b', { method: 'PUT', body: {} }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'stale-board', message: 'Changed.' })
    expect((error as ApiError).body).toMatchObject({ current: null })
  })

  it('maps a network failure to status 0 and code unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(apiRequest('session')).rejects.toMatchObject({ status: 0, code: 'unavailable' })
  })

  it('falls back to a code from the status when the body is not JSON', async () => {
    stubFetch(() => new Response('<html>bad gateway</html>', { status: 503 }))
    await expect(apiRequest('session')).rejects.toMatchObject({ status: 503, code: 'unavailable' })
  })

  it('returns undefined for 204 and calls the signed-out handler on code signed-out', async () => {
    stubFetch(() => new Response(null, { status: 204 }))
    await expect(apiRequest('invites/x', { method: 'DELETE' })).resolves.toBeUndefined()

    const handler = vi.fn()
    setSignedOutHandler(handler)
    stubFetch(() => json(401, { error: 'signed-out', message: 'Sign in.' }))
    await expect(apiRequest('boards')).rejects.toMatchObject({ code: 'signed-out' })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('CLIENT_ID', () => {
  it('is 32 lowercase hex characters, which the server accepts as a tab id', () => {
    expect(CLIENT_ID).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is generated without crypto.randomUUID', async () => {
    vi.resetModules()
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const fresh = await import('./client')
    vi.unstubAllGlobals()
    expect(fresh.CLIENT_ID).toMatch(/^[0-9a-f]{32}$/)
  })
})
