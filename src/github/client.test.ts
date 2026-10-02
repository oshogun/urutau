import { describe, expect, it, vi } from 'vitest'
import { GitHubError, getAllPages, getJson, parseNextLink } from './client'

const headersOf = (fetchMock: ReturnType<typeof mockFetch>, call = 0) =>
  (fetchMock.mock.calls[call][1]?.headers ?? {}) as Record<string, string>

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })

function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const response of responses) fetchMock.mockResolvedValueOnce(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function errorFrom(promise: Promise<unknown>): Promise<GitHubError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(GitHubError)
  return error as GitHubError
}

describe('parseNextLink', () => {
  it('finds the next page among other relations', () => {
    const header =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'
    expect(parseNextLink(header)).toBe('https://api.github.com/x?page=2')
  })

  it('returns null on the last page or without a header', () => {
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull()
    expect(parseNextLink(null)).toBeNull()
  })
})

describe('getJson', () => {
  it('sends the token as a bearer header', async () => {
    const fetchMock = mockFetch(json({ ok: true }))
    await getJson('/repos/a/b', { token: 'secret' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/a/b')
    expect(headersOf(fetchMock).Authorization).toBe('Bearer secret')
  })

  it('omits the authorization header without a token', async () => {
    const fetchMock = mockFetch(json({ ok: true }))
    await getJson('/repos/a/b', {})
    expect(headersOf(fetchMock).Authorization).toBeUndefined()
  })

  it('maps rate limiting to a dedicated error with the reset time', async () => {
    mockFetch(
      json(
        { message: 'API rate limit exceeded' },
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } },
      ),
    )
    const error = await errorFrom(getJson('/repos/a/b', {}))
    expect(error.kind).toBe('rate-limited')
    expect(error.resetAt?.getTime()).toBe(1_900_000_000_000)
    expect(error.message).toMatch(/personal access token/)
  })

  it('suggests a token for a 404 when none is set', async () => {
    mockFetch(json({ message: 'Not Found' }, { status: 404 }))
    const error = await errorFrom(getJson('/repos/a/private', {}))
    expect(error.kind).toBe('not-found')
    expect(error.needsToken).toBe(true)
    expect(error.message).toMatch(/private/)
  })

  it('maps 401 to an invalid token error', async () => {
    mockFetch(json({ message: 'Bad credentials' }, { status: 401 }))
    const error = await errorFrom(getJson('/repos/a/b', { token: 'expired' }))
    expect(error.kind).toBe('unauthorized')
  })

  it('reports network failures as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')))
    const error = await errorFrom(getJson('/repos/a/b', {}))
    expect(error.kind).toBe('network')
    expect(error.retryable).toBe(true)
  })
})

describe('getAllPages', () => {
  const page = (items: number[], next?: string) =>
    json(items, next ? { headers: { link: `<${next}>; rel="next"` } } : {})

  it('follows next links until the last page', async () => {
    const fetchMock = mockFetch(
      page([1, 2], 'https://api.github.com/items?page=2'),
      page([3], 'https://api.github.com/items?page=3'),
      page([4]),
    )
    const result = await getAllPages<number>('/items', { maxPages: 10 })
    expect(result).toEqual({ items: [1, 2, 3, 4], truncated: false })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops at maxPages and reports truncation', async () => {
    const fetchMock = mockFetch(
      page([1], 'https://api.github.com/items?page=2'),
      page([2], 'https://api.github.com/items?page=3'),
    )
    const result = await getAllPages<number>('/items', { maxPages: 2 })
    expect(result).toEqual({ items: [1, 2], truncated: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
