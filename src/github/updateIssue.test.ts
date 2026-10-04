import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../state/session'
import { installApiStub, stubCreatedIssue, stubUpdatedIssue, type ApiStub } from '../test/apiStub'
import { UpdateIssueError, classifyUpdateFailure, updateIssue, type UpdateIssueCall } from './updateIssue'

const FULL_NAME = 'acme/widgets'
const TOKEN = 'github_pat_urutau_fixture_not_a_real_token'
const STARTED = '2026-01-01T00:00:00Z'
const BASE = { fullName: FULL_NAME, number: 7, expectedUpdatedAt: STARTED, fields: { title: 'Renamed' } }

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } })
const current = (overrides: Record<string, unknown> = {}) => ({
  ...stubCreatedIssue(FULL_NAME, 7, 'Old title', 'Old body'),
  created_at: '2025-12-01T00:00:00Z',
  updated_at: STARTED,
  ...overrides,
})

function mockFetch(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response)
    else fetchMock.mockResolvedValueOnce(response)
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const browser = (overrides: Partial<UpdateIssueCall> = {}) => updateIssue({ ...BASE, via: 'browser', token: TOKEN, ...overrides })

async function failure(promise: Promise<unknown>): Promise<UpdateIssueError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(UpdateIssueError)
  return error as UpdateIssueError
}

const methods = (fetchMock: ReturnType<typeof mockFetch>) => fetchMock.mock.calls.map(([, init]) => init?.method)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('updateIssue on the browser path', () => {
  it('checks the issue, then patches only the changed fields, with the token in Authorization only', async () => {
    const fetchMock = mockFetch(json(current()), json(current({ title: 'Renamed', updated_at: '2026-01-02T00:00:00Z' })))
    const issue = await browser()
    expect(issue).toMatchObject({ number: 7, title: 'Renamed', updatedAt: '2026-01-02T00:00:00Z' })
    expect(methods(fetchMock)).toEqual(['GET', 'PATCH'])
    const [[checkUrl, check], [writeUrl, write]] = fetchMock.mock.calls
    expect(checkUrl).toBe('https://api.github.com/repos/acme/widgets/issues/7')
    expect(writeUrl).toBe('https://api.github.com/repos/acme/widgets/issues/7')
    expect(check?.cache).toBe('no-store')
    expect(check?.redirect).toBe('manual')
    expect(write?.redirect).toBe('manual')
    expect(check?.body).toBeUndefined()
    expect(JSON.parse(String(write?.body))).toEqual({ title: 'Renamed' })
    for (const init of [check, write]) {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(headers.get('x-github-api-version')).toBe('2022-11-28')
      expect(JSON.stringify([init?.body, [...headers].filter(([name]) => name !== 'authorization')])).not.toContain(TOKEN)
    }
    expect(new Headers(write?.headers).get('content-type')).toBe('application/json')
  })

  it('treats the same instant written two ways as unchanged', async () => {
    const fetchMock = mockFetch(json(current({ updated_at: '2026-01-01T00:00:00.000Z' })), json(current()))
    await browser()
    expect(methods(fetchMock)).toEqual(['GET', 'PATCH'])
  })

  it('refuses with stale and sends no PATCH when updated_at moved', async () => {
    const fetchMock = mockFetch(json(current({ title: 'Theirs', updated_at: '2026-01-03T00:00:00Z' })))
    const error = await failure(browser())
    expect(error).toMatchObject({ kind: 'stale', outcome: 'not-applied', action: null, current: { title: 'Theirs', updatedAt: '2026-01-03T00:00:00Z' } })
    expect(error.message).toBe('The issue changed on GitHub since this change started. Nothing was sent.')
    expect(methods(fetchMock)).toEqual(['GET'])
  })

  it.each([
    ['close as completed', { state: 'closed', state_reason: 'completed' } as const, { state: 'closed', state_reason: 'completed', closed_at: '2026-01-02T00:00:00Z' }],
    ['close as not planned', { state: 'closed', state_reason: 'not_planned' } as const, { state: 'closed', state_reason: 'not_planned', closed_at: '2026-01-02T00:00:00Z' }],
    ['reopen', { state: 'open', state_reason: 'reopened' } as const, { state: 'open', state_reason: 'reopened', closed_at: null }],
  ])('sends %s and reads the state GitHub answers with', async (_name, fields, answer) => {
    const fetchMock = mockFetch(json(current()), json(current({ ...answer, updated_at: '2026-01-02T00:00:00Z' })))
    const issue = await browser({ fields })
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(fields)
    expect(issue).toMatchObject({ state: answer.state, stateReason: answer.state_reason })
  })

  const refused = (status: number, body: unknown, headers: Record<string, string> = {}) => json(body, { status, headers })
  type Expected = Omit<Partial<UpdateIssueError>, 'message'> & { message?: RegExp }
  const checkCases: [string, Response, Expected][] = [
    ['401', refused(401, { message: 'Bad credentials' }), { kind: 'token-rejected', action: 'open-settings', message: /update it in Settings/ }],
    ['403', refused(403, { message: 'Forbidden' }), { kind: 'no-permission', action: 'open-settings', message: /^Your token can't read acme\/widgets \(Forbidden\)\. Nothing was changed\.$/ }],
    ['404', refused(404, { message: 'Not Found' }), { kind: 'not-found', action: 'refresh', message: /answered “not found” for acme\/widgets #7: .*your token can't read it\. Nothing was changed\. Refresh the board\./ }],
    ['410', refused(410, { message: 'Gone' }), { kind: 'gone', action: 'refresh', message: /acme\/widgets #7 is gone: it was deleted, or issues are turned off/ }],
    ['rate limit', refused(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }), { kind: 'rate-limited', action: null, message: /rate limit for your token was reached\. It resets at .*Nothing was changed\./ }],
    ['500', refused(502, {}), { kind: 'unreachable', outcome: 'not-applied', message: /GitHub had a problem \(502\) answering the check\. Nothing was sent/ }],
  ]
  it.each(checkCases)('maps %s on the check, sends no PATCH', async (_name, response, expected) => {
    const fetchMock = mockFetch(response)
    const error = await failure(browser())
    expect(methods(fetchMock)).toEqual(['GET'])
    const { message, ...fields } = expected
    expect(error).toMatchObject({ outcome: 'not-applied', ...fields })
    if (message) expect(error.message).toMatch(message)
    expect(error.message).not.toContain(TOKEN)
  })

  const writeCases: [string, Response, Expected][] = [
    ['401', refused(401, { message: 'Bad credentials' }), { kind: 'token-rejected', action: 'open-settings', outcome: 'not-applied' }],
    ['403', refused(403, { message: 'Resource not accessible by personal access token' }), { kind: 'no-permission', action: 'open-settings', outcome: 'not-applied', message: /^GitHub refused to change acme\/widgets #7 \(Resource not accessible by personal access token\)\. Nothing was changed\. If your token lacks Issues read and write permission/ }],
    ['404', refused(404, { message: 'Not Found' }), { kind: 'not-found', action: 'open-settings', message: /your token may not be allowed to change issues in acme\/widgets/ }],
    ['410', refused(410, {}), { kind: 'gone', action: 'refresh' }],
    ['422', refused(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] }), { kind: 'invalid', message: /^GitHub did not accept the change \(Validation Failed: title missing_field\)\. Nothing was changed\.$/ }],
    ['rate limit', refused(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }), { kind: 'rate-limited', message: /^GitHub's rate limit for your token was reached\. Nothing was changed\.$/ }],
    ['secondary limit', refused(403, { message: 'slow down' }, { 'retry-after': '120' }), { kind: 'secondary-rate-limited', message: /Wait 2 minutes/ }],
    ['500', refused(500, {}), { kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh', message: /GitHub had a problem \(500\), so the change may have been applied/ }],
    ['418', refused(418, { message: 'teapot' }), { kind: 'unknown', message: /GitHub returned an error \(418: teapot\)\. Nothing was changed\./ }],
  ]
  it.each(writeCases)('maps %s on the write after one check and one PATCH', async (_name, response, expected) => {
    const fetchMock = mockFetch(json(current()), response)
    const error = await failure(browser())
    expect(methods(fetchMock)).toEqual(['GET', 'PATCH'])
    const { message, ...fields } = expected
    expect(error).toMatchObject(fields)
    if (message) expect(error.message).toMatch(message)
    expect(error.message).not.toContain(TOKEN)
  })

  it('reports a redirect, manual or opaque, as moved on either request', async () => {
    mockFetch(json({}, { status: 301, headers: { location: 'https://api.github.com/elsewhere' } }))
    expect(await failure(browser())).toMatchObject({ kind: 'moved', action: 'refresh', outcome: 'not-applied' })

    const opaque = { type: 'opaqueredirect', ok: false, status: 0, headers: new Headers(), json: () => Promise.reject(new Error('opaque')) }
    const fetchMock = mockFetch(json(current()), opaque as unknown as Response)
    expect(await failure(browser())).toMatchObject({ kind: 'moved', action: 'refresh', status: 301 })
    expect(methods(fetchMock)).toEqual(['GET', 'PATCH'])
  })

  it('reports a failed check request as unreachable with nothing sent, and offline in its own words', async () => {
    const fetchMock = mockFetch(new TypeError('Failed to fetch'))
    const error = await failure(browser())
    expect(error).toMatchObject({ kind: 'unreachable', outcome: 'not-applied' })
    expect(error.message).toContain('no answer from GitHub while checking the issue')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    mockFetch(new TypeError('Failed to fetch'))
    expect((await failure(browser())).message).toContain('You are offline. Nothing was sent to GitHub.')
  })

  it('reports an unreadable or pull request check answer as unreachable and sends no PATCH', async () => {
    const fetchMock = mockFetch(new Response('<html>', { status: 200 }), json({ ...current(), pull_request: {} }))
    expect(await failure(browser())).toMatchObject({ kind: 'unreachable', message: expect.stringContaining('could not be read') })
    expect(await failure(browser())).toMatchObject({ kind: 'unreachable' })
    expect(methods(fetchMock)).toEqual(['GET', 'GET'])
  })

  it('reports a failed PATCH as an unknown outcome, in an offline browser too', async () => {
    mockFetch(json(current()), new TypeError('Failed to fetch'))
    expect(await failure(browser())).toMatchObject({ kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh', message: expect.stringContaining('may have been applied') })

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    mockFetch(json(current()), new TypeError('Failed to fetch'))
    const error = await failure(browser())
    expect(error).toMatchObject({ kind: 'outcome-unknown', outcome: 'unknown' })
    expect(error.message).toContain('The connection was lost while the change was being sent')
  })

  it('reads a 200 that is not an issue as applied but unreadable', async () => {
    mockFetch(json(current()), new Response('ok', { status: 200 }))
    expect(await failure(browser())).toMatchObject({ kind: 'applied-unreadable', outcome: 'applied', action: 'refresh' })
  })

  it('times out the check after 20 s and the write after 30 s, without a retry', async () => {
    vi.useFakeTimers()
    const hang = (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const checkMock = vi.fn<typeof fetch>(hang)
    vi.stubGlobal('fetch', checkMock)
    const pendingCheck = failure(browser())
    await vi.advanceTimersByTimeAsync(19_999)
    expect(checkMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pendingCheck).toMatchObject({ kind: 'unreachable', outcome: 'not-applied' })
    expect(checkMock).toHaveBeenCalledTimes(1)

    const writeMock = vi.fn<typeof fetch>((url, init) => (init?.method === 'PATCH' ? hang(url, init) : Promise.resolve(json(current()))))
    vi.stubGlobal('fetch', writeMock)
    const pendingWrite = failure(browser())
    await vi.advanceTimersByTimeAsync(29_999)
    expect(writeMock.mock.calls[1][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pendingWrite).toMatchObject({ kind: 'outcome-unknown', outcome: 'unknown' })
    expect(writeMock).toHaveBeenCalledTimes(2)
  })

  it('sends nothing when the stop signal was already aborted', async () => {
    const fetchMock = mockFetch()
    const stop = new AbortController()
    stop.abort()
    expect(await failure(browser({ signal: stop.signal }))).toMatchObject({ kind: 'stopped', outcome: 'not-applied' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a stop during the check is not-applied, and a stop while the PATCH is out is unknown', async () => {
    const hang = (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const duringCheck = new AbortController()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(hang))
    const first = failure(browser({ signal: duringCheck.signal }))
    await Promise.resolve()
    duringCheck.abort()
    expect(await first).toMatchObject({ kind: 'stopped', outcome: 'not-applied' })

    const duringWrite = new AbortController()
    const fetchMock = vi.fn<typeof fetch>((url, init) => (init?.method === 'PATCH' ? hang(url, init) : Promise.resolve(json(current()))))
    vi.stubGlobal('fetch', fetchMock)
    const second = failure(browser({ signal: duringWrite.signal }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    duringWrite.abort()
    const error = await second
    expect(error).toMatchObject({ kind: 'stopped', outcome: 'unknown', action: 'refresh' })
    expect(error.message).toContain("You stopped waiting, so Urutau doesn't know")
  })

  it('a stop or the time limit ends a check body that never finishes, with nothing sent', async () => {
    const stalled = (init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"number":7,'))
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(stream, { status: 200 })
    }
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => stalled(init))
    vi.stubGlobal('fetch', fetchMock)
    const stop = new AbortController()
    const first = failure(browser({ signal: stop.signal }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    stop.abort()
    expect(await first).toMatchObject({ kind: 'stopped', outcome: 'not-applied' })

    vi.useFakeTimers()
    const second = failure(browser())
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await second).toMatchObject({ kind: 'unreachable' })
    expect(methods(fetchMock)).toEqual(['GET', 'GET'])
  })

  it('a stop or the time limit ends a PATCH body that never finishes as an unknown outcome', async () => {
    const stalled = (init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"number":7,'))
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(stream, { status: 200 })
    }
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => (init?.method === 'GET' ? json(current()) : stalled(init)))
    vi.stubGlobal('fetch', fetchMock)
    const stop = new AbortController()
    const first = failure(browser({ signal: stop.signal }))
    await vi.waitFor(() => expect(methods(fetchMock)).toEqual(['GET', 'PATCH']))
    stop.abort()
    expect(await first).toMatchObject({ kind: 'stopped', outcome: 'unknown' })

    vi.useFakeTimers()
    const second = failure(browser())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await second).toMatchObject({ kind: 'outcome-unknown', outcome: 'unknown' })
  })

  it('encodes the owner and name into both paths', async () => {
    const fetchMock = mockFetch(json(current()), json(current()))
    await browser({ fullName: 'ac me/wid.gets' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('https://api.github.com/repos/ac%20me/wid.gets/issues/7'))
  })
})

describe('updateIssue on the server path', () => {
  let stub: ApiStub
  beforeEach(() => {
    useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
  })

  async function start(options: Parameters<typeof installApiStub>[0] = {}) {
    stub = installApiStub({ githubAccess: { mode: 'server' }, githubWrites: true, ...options })
    await useSession.getState().load()
  }
  /** The stub does not watch the request's signal, as a real fetch does; make held requests reject when it aborts. */
  function honourAbort() {
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      Promise.race([
        inner(input, init),
        new Promise<never>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
      ]),
    )
  }
  const server = (overrides: Partial<UpdateIssueCall> = {}) => updateIssue({ ...BASE, via: 'server', ...overrides })

  it('patches api/issues with the CSRF header, the expected time and no Authorization', async () => {
    await start()
    const issue = await server()
    expect(issue).toMatchObject({ number: 7, title: 'Renamed' })
    const [call] = stub.requests('PATCH issues/acme/widgets/7')
    expect(stub.requests('PATCH issues')).toHaveLength(1)
    expect(call.body).toEqual({ expectedUpdatedAt: STARTED, fields: { title: 'Renamed' } })
    expect(call.headers['authorization']).toBeUndefined()
    expect(call.headers['x-urutau-csrf']).toBe(stub.session?.csrfToken)
  })

  const rejection = (github: object, step?: 'check' | 'write') => ({
    status: 502,
    error: 'github-rejected' as const,
    body: { error: 'github-rejected', message: 'GitHub refused the request.', github, ...(step ? { step } : {}) },
  })
  const detail = { status: 0, message: null, errors: [], retryAfter: null, rateLimitRemaining: null, rateLimitReset: null }
  const access = (problem: string) => ({ status: 424, error: 'github-access' as const, body: { error: 'github-access', message: 'x', problem } })
  type Expected = Omit<Partial<UpdateIssueError>, 'message'> & { message?: RegExp }
  const cases: [string, Parameters<ApiStub['failNext']>[1], Expected][] = [
    ['rejected 401 on the write', rejection({ ...detail, status: 401 }, 'write'), { kind: 'token-rejected', action: 'sign-in-keycloak', message: /Sign in with Keycloak again\./ }],
    ['rejected 403 on the check', rejection({ ...detail, status: 403, message: 'nope' }, 'check'), { kind: 'no-permission', action: null, message: /^Your GitHub account, through its Keycloak link, can't read acme\/widgets \(nope\)\. Nothing was changed\.$/ }],
    ['rejected 403 on the write', rejection({ ...detail, status: 403 }, 'write'), { kind: 'no-permission', message: /lacks write access to issues in this repository, ask the admin/ }],
    ['rejected 403 without a step', rejection({ ...detail, status: 403 }), { kind: 'no-permission', message: /^GitHub refused to change/ }],
    ['rejected 404 on the check', rejection({ ...detail, status: 404 }, 'check'), { kind: 'not-found', action: 'refresh', message: /your Keycloak GitHub link can't read it/ }],
    ['rejected 404 on the write', rejection({ ...detail, status: 404 }, 'write'), { kind: 'not-found', action: null, message: /Keycloak GitHub link may not be allowed/ }],
    ['rejected 410', rejection({ ...detail, status: 410 }, 'write'), { kind: 'gone' }],
    ['rejected 422', rejection({ ...detail, status: 422, message: 'Validation Failed' }, 'write'), { kind: 'invalid', message: /\(Validation Failed\)\. Nothing was changed\./ }],
    ['rejected primary limit', rejection({ ...detail, status: 403, rateLimitRemaining: 0, rateLimitReset: 1_790_000_000 }, 'write'), { kind: 'rate-limited', message: /rate limit for your GitHub account was reached\. It resets at / }],
    ['rejected 500 on the check', rejection({ ...detail, status: 500 }, 'check'), { kind: 'unreachable', outcome: 'not-applied' }],
    ['rejected 500 on the write', rejection({ ...detail, status: 500 }, 'write'), { kind: 'outcome-unknown', outcome: 'unknown' }],
    ['rejected redirect', rejection({ ...detail, status: 301 }, 'check'), { kind: 'moved' }],
    ['github-no-answer', { status: 504, error: 'github-no-answer' }, { kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh', message: /The Urutau server got no answer from GitHub, so the change may have been applied/ }],
    ['github-writes-off', { status: 403, error: 'github-writes-off' }, { kind: 'writes-off' }],
    ['access signin-expired', access('signin-expired'), { kind: 'server-access', action: 'sign-in-keycloak', message: /Sign in with Keycloak again to change issues/ }],
    ['access not-linked', access('not-linked'), { kind: 'server-access', action: null, message: /no linked GitHub account/ }],
    ['access refused', access('refused'), { kind: 'server-access', message: /did not hand out your GitHub token/ }],
    ['access unavailable', access('unavailable'), { kind: 'server-access', problem: 'unavailable', message: /Keycloak could not be reached/ }],
    ['csrf-rejected', { status: 403, error: 'csrf-rejected' }, { kind: 'refused', message: /Reload the page/ }],
    ['forbidden', { status: 403, error: 'forbidden' }, { kind: 'refused' }],
    ['signed-out', { status: 401, error: 'signed-out' }, { kind: 'signed-out' }],
    ['invalid-request', { status: 400, error: 'invalid-request', message: 'Nothing to change.' }, { kind: 'invalid', message: /^Urutau refused the change: Nothing to change\.$/ }],
    ['503', { status: 503, error: 'unavailable' }, { kind: 'unreachable', outcome: 'not-applied', message: /nothing was changed on GitHub/ }],
    ['no answer from Urutau', 'network', { kind: 'outcome-unknown', outcome: 'unknown', message: /^No answer came from the Urutau server, so the change may have been applied/ }],
    ['500', { status: 500 }, { kind: 'outcome-unknown', outcome: 'unknown', message: /The Urutau server had a problem \(500\)/ }],
    ['418', { status: 418, error: 'server-error' }, { kind: 'unknown', message: /^The Urutau server answered 418\.$/ }],
  ]
  it.each(cases)('maps %s with exactly one request', async (_name, injected, expected) => {
    await start()
    stub.failNext('PATCH issues', injected)
    const error = await failure(server())
    expect(stub.requests('PATCH issues')).toHaveLength(1)
    const { message, ...fields } = expected
    expect(error).toMatchObject(fields)
    if (message) expect(error.message).toMatch(message)
  })

  it('maps a 409 stale-issue to stale with the current issue, or null when it cannot be read', async () => {
    await start()
    const body = { error: 'stale-issue', message: 'x', current: current({ title: 'Theirs', updated_at: '2026-01-03T00:00:00Z' }) }
    stub.failNext('PATCH issues', { status: 409, error: 'stale-issue', body })
    expect(await failure(server())).toMatchObject({ kind: 'stale', outcome: 'not-applied', action: null, current: { title: 'Theirs' } })

    stub.failNext('PATCH issues', { status: 409, error: 'stale-issue', body: { ...body, current: null } })
    const unreadable = await failure(server())
    expect(unreadable).toMatchObject({ kind: 'stale', current: null, action: 'refresh' })
    expect(unreadable.message).toContain('Refresh the board to see it.')
  })

  it('reads a 200 without an issue as applied but unreadable', async () => {
    await start({ updateIssue: () => new Response(JSON.stringify({ issue: null }), { status: 200 }) })
    expect(await failure(server())).toMatchObject({ kind: 'applied-unreadable', outcome: 'applied' })
  })

  it.each([200, 201])('reads a %i whose body is empty, null or not JSON as applied but unreadable', async (status) => {
    for (const text of ['null', '<html>', '{"number":7,', '', '[]', '7']) {
      await start({ updateIssue: () => new Response(text, { status }) })
      expect(await failure(server()), `${status} ${text}`).toMatchObject({
        kind: 'applied-unreadable',
        outcome: 'applied',
        action: 'refresh',
      })
    }
  })

  /** A 200 whose body starts and then stalls until the request's signal aborts, as a real fetch's body does. */
  function stallBodyOf200() {
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PATCH') return inner(input, init)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"number":7,'))
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
  }

  it('reads a 200 with an empty body as applied but unreadable', async () => {
    await start({ updateIssue: () => new Response('', { status: 200 }) })
    expect(await failure(server())).toMatchObject({ kind: 'applied-unreadable', outcome: 'applied' })
  })

  it('a stop during a 200 body is stopped with an unknown outcome', async () => {
    await start()
    stallBodyOf200()
    const stop = new AbortController()
    const pending = failure(server({ signal: stop.signal }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop.abort()
    expect(await pending).toMatchObject({ kind: 'stopped', outcome: 'unknown', action: 'refresh' })
  })

  it('the 90 s limit during a 200 body is an unknown outcome', async () => {
    await start()
    stallBodyOf200()
    vi.useFakeTimers()
    const pending = failure(server())
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await pending).toMatchObject({ kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh' })
  })

  it('times out after 90 s as an unknown outcome', async () => {
    await start()
    honourAbort()
    vi.useFakeTimers()
    const gate = stub.hold('PATCH issues')
    const pending = failure(server())
    await vi.advanceTimersByTimeAsync(90_000)
    const error = await pending
    expect(error).toMatchObject({ kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh' })
    expect(error.message).toBe(
      'No answer came from the Urutau server, so the change may have been applied. Refresh the board to see the issue as GitHub has it.',
    )
    gate.release()
  })

  it('a stop while the request is held is unknown with Refresh', async () => {
    await start()
    honourAbort()
    const gate = stub.hold('PATCH issues')
    const stop = new AbortController()
    const pending = failure(server({ signal: stop.signal }))
    await Promise.resolve()
    stop.abort()
    expect(await pending).toMatchObject({ kind: 'stopped', outcome: 'unknown', action: 'refresh' })
    gate.release()
  })

  it('stubUpdatedIssue answers a state change in GitHub terms', () => {
    expect(stubUpdatedIssue(FULL_NAME, 7, { state: 'closed', state_reason: 'not_planned' })).toMatchObject({ state: 'closed', state_reason: 'not_planned' })
    expect(stubUpdatedIssue(FULL_NAME, 7, { state: 'open', state_reason: 'reopened' })).toMatchObject({ state: 'open', state_reason: 'reopened', closed_at: null })
  })
})

describe('classifyUpdateFailure', () => {
  const detail = { status: 403, message: null, errors: [], retryAfter: null, rateLimitRemaining: null, rateLimitReset: null }
  const now = new Date('2026-10-03T10:00:00Z')
  it('puts a 403 with no remaining requests before no-permission', () => {
    expect(classifyUpdateFailure({ ...detail, rateLimitRemaining: 0 }, 'write', 'browser', FULL_NAME, 7, now).kind).toBe('rate-limited')
    expect(classifyUpdateFailure(detail, 'write', 'browser', FULL_NAME, 7, now).kind).toBe('no-permission')
  })

  it('computes the secondary limit reset from the clock', () => {
    expect(classifyUpdateFailure({ ...detail, retryAfter: 90 }, 'write', 'browser', FULL_NAME, 7, now).resetAt).toEqual(new Date('2026-10-03T10:01:30Z'))
    expect(classifyUpdateFailure({ ...detail, status: 429 }, 'write', 'browser', FULL_NAME, 7, now).resetAt).toEqual(new Date('2026-10-03T10:01:00Z'))
  })

  it('gives an unknown status the message with GitHub text', () => {
    expect(classifyUpdateFailure({ ...detail, status: 418, message: 'teapot' }, 'check', 'browser', FULL_NAME, 7, now).message).toBe('GitHub returned an error (418: teapot). Nothing was changed.')
  })
})
