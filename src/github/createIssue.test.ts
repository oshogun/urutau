import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../state/session'
import { installApiStub, stubCreatedIssue, type ApiStub } from '../test/apiStub'
import {
  CreateIssueError,
  classifyGitHubFailure,
  createIssue,
  failureDetailOf,
  normalizeIssueFields,
  parseCreatedIssue,
} from './createIssue'

const FULL_NAME = 'acme/widgets'
const TOKEN = 'ghp_pasted_secret'
const FIELDS = { title: 'Crash on save', body: 'Steps' }

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } })

function mockFetch(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response)
    else fetchMock.mockResolvedValueOnce(response)
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const browser = (signal?: AbortSignal) => createIssue({ fullName: FULL_NAME, fields: FIELDS, via: 'browser', token: TOKEN, signal })

async function failure(promise: Promise<unknown>): Promise<CreateIssueError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(CreateIssueError)
  return error as CreateIssueError
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('normalizeIssueFields', () => {
  it('trims the title and leaves out a blank body', () => {
    expect(normalizeIssueFields({ title: '  A  ', body: ' \n' })).toEqual({ ok: true, value: { title: 'A' } })
    expect(normalizeIssueFields({ title: 'A', body: '  keep\n' })).toEqual({ ok: true, value: { title: 'A', body: '  keep\n' } })
  })

  it('counts code points: 256 emoji pass and 257 fail, 65536 emoji in a body pass', () => {
    const emoji = (count: number) => '\u{1F600}'.repeat(count)
    expect(normalizeIssueFields({ title: emoji(256) }).ok).toBe(true)
    expect(normalizeIssueFields({ title: emoji(257) })).toEqual({ ok: false, message: 'title must be at most 256 characters.' })
    expect(normalizeIssueFields({ title: 'a', body: emoji(65_536) }).ok).toBe(true)
    expect(normalizeIssueFields({ title: 'a', body: emoji(65_537) })).toEqual({ ok: false, message: 'body must be at most 65,536 characters.' })
  })

  it('refuses a missing, blank or non-text title and a non-text body', () => {
    expect(normalizeIssueFields({ title: '   ' })).toEqual({ ok: false, message: 'title is required.' })
    expect(normalizeIssueFields({ title: 4 })).toEqual({ ok: false, message: 'title must be text.' })
    expect(normalizeIssueFields({ title: 'a', body: 4 })).toEqual({ ok: false, message: 'body must be text.' })
  })
})

describe('createIssue on the browser path', () => {
  it('sends one POST to api.github.com with the token in Authorization only and no labels', async () => {
    const fetchMock = mockFetch(json(stubCreatedIssue(FULL_NAME, 19, 'Crash on save', 'Steps'), { status: 201 }))
    const issue = await browser()
    expect(issue).toMatchObject({ number: 19, title: 'Crash on save', state: 'open', labels: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/acme/widgets/issues')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    expect(init?.credentials).toBeUndefined()
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Crash on save', body: 'Steps' })
    const everythingElse = JSON.stringify([url, init?.body, [...headers].filter(([name]) => name !== 'authorization')])
    expect(everythingElse).not.toContain(TOKEN)
  })

  it('encodes the owner and name into the path', async () => {
    const fetchMock = mockFetch(json(stubCreatedIssue(FULL_NAME, 1, 'x'), { status: 201 }))
    await createIssue({ fullName: 'ac me/wid.gets', fields: { title: 'x' }, via: 'browser', token: TOKEN })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/ac%20me/wid.gets/issues')
  })

  const rejected = (status: number, body: unknown, headers: Record<string, string> = {}) => json(body, { status, headers })
  const cases: [string, Response, Omit<Partial<CreateIssueError>, 'message'> & { message?: RegExp }][] = [
    ['401', rejected(401, { message: 'Bad credentials' }), { kind: 'token-rejected', action: 'open-settings', outcome: 'not-created', message: /update it in Settings/ }],
    ['403 read-only token', rejected(403, { message: 'Resource not accessible by personal access token' }), { kind: 'no-permission', action: 'open-settings', message: /Resource not accessible by personal access token\). Give it Issues read and write permission/ }],
    ['404', rejected(404, { message: 'Not Found' }), { kind: 'not-found', action: 'open-settings', message: /may have been renamed or deleted, or your token can't write to it/ }],
    ['410 issues disabled', rejected(410, { message: 'Issues are disabled for this repo' }), { kind: 'issues-disabled', action: null, message: /Issues are turned off for acme\/widgets/ }],
    ['422', rejected(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] }), { kind: 'invalid', message: /\(Validation Failed: title missing_field\)\. Change the title or description/ }],
    ['primary rate limit', rejected(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }), { kind: 'rate-limited', message: /rate limit for your token was reached\. It resets at / }],
    ['secondary rate limit by retry-after', rejected(403, { message: 'slow down' }, { 'retry-after': '120' }), { kind: 'secondary-rate-limited', message: /Wait 2 minutes and try again/ }],
    ['secondary rate limit by 429', rejected(429, {}), { kind: 'secondary-rate-limited', message: /Wait a minute and try again/ }],
    ['secondary rate limit by message', rejected(403, { message: 'You have exceeded a secondary rate limit.' }), { kind: 'secondary-rate-limited', message: /Wait a minute/ }],
    ['500', rejected(500, { message: 'Server Error' }), { kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh', message: /GitHub had a problem \(500\), so the issue may have been created/ }],
    ['418', rejected(418, { message: 'teapot' }), { kind: 'unknown', message: /GitHub returned an error \(418: teapot\)\./ }],
  ]
  it.each(cases)('maps %s and sends exactly one request', async (_name, response, expected) => {
    const fetchMock = mockFetch(response)
    const error = await failure(browser())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { message, ...fields } = expected
    expect(error).toMatchObject(fields)
    if (message) expect(error.message).toMatch(message)
    expect(error.message).not.toContain(TOKEN)
  })

  it('sets resetAt from the rate limit headers', async () => {
    mockFetch(json({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' } }))
    expect((await failure(browser())).resetAt).toEqual(new Date(1_790_000_000_000))
  })

  it('reports a rejected fetch as an unknown outcome with a Refresh action', async () => {
    mockFetch(new TypeError('Failed to fetch'))
    expect(await failure(browser())).toMatchObject({
      kind: 'outcome-unknown',
      outcome: 'unknown',
      action: 'refresh',
      message: expect.stringContaining('Urutau got no answer from GitHub, so the issue may have been created'),
    })
  })

  it('reports an offline browser as nothing sent', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    mockFetch(new TypeError('Failed to fetch'))
    expect(await failure(browser())).toMatchObject({ kind: 'unreachable', outcome: 'not-created' })
    vi.restoreAllMocks()
  })

  it('times out after 30 s without a retry, as an unknown outcome', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = failure(browser())
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads a 201 without a number as created but unreadable', async () => {
    mockFetch(json({ title: 'x' }, { status: 201 }))
    expect(await failure(browser())).toMatchObject({ kind: 'created-unreadable', outcome: 'created', action: 'refresh' })
  })

  it('reads a 201 that is not JSON as created but unreadable', async () => {
    mockFetch(new Response('created', { status: 201 }))
    expect(await failure(browser())).toMatchObject({ kind: 'created-unreadable', outcome: 'created' })
  })

  it('sends nothing when the stop signal was already aborted', async () => {
    const fetchMock = mockFetch()
    const stop = new AbortController()
    stop.abort()
    expect(await failure(browser(stop.signal))).toMatchObject({ kind: 'stopped', outcome: 'not-created', action: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a stop while the request is out is unknown with Refresh, and differs from a timeout', async () => {
    const stop = new AbortController()
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = failure(browser(stop.signal))
    await Promise.resolve()
    stop.abort()
    const error = await pending
    expect(error).toMatchObject({ kind: 'stopped', outcome: 'unknown', action: 'refresh' })
    expect(error.message).toContain("You stopped waiting, so Urutau doesn't know")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('createIssue on the server path', () => {
  let stub: ApiStub
  beforeEach(async () => {
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
  const server = (signal?: AbortSignal) => createIssue({ fullName: FULL_NAME, fields: FIELDS, via: 'server', signal })

  it('posts to api/issues with the CSRF header and no Authorization, and maps the answer', async () => {
    await start()
    const issue = await server()
    expect(issue).toMatchObject({ number: 1001, title: 'Crash on save' })
    const [call] = stub.requests('POST issues/acme/widgets')
    expect(stub.requests('POST issues')).toHaveLength(1)
    expect(call.body).toEqual({ title: 'Crash on save', body: 'Steps' })
    expect(call.headers['authorization']).toBeUndefined()
    expect(call.headers['x-urutau-csrf']).toBe(stub.session?.csrfToken)
  })

  const rejection = (github: object) => ({
    status: 502,
    error: 'github-rejected' as const,
    body: { error: 'github-rejected', message: 'GitHub refused the request.', github },
  })
  const detail = { status: 0, message: null, errors: [], retryAfter: null, rateLimitRemaining: null, rateLimitReset: null }
  const cases: [string, Parameters<ApiStub['failNext']>[1], Omit<Partial<CreateIssueError>, 'message'> & { message?: RegExp }][] = [
    ['github-rejected 401', rejection({ ...detail, status: 401 }), { kind: 'token-rejected', action: 'sign-in-keycloak', message: /Sign in with Keycloak again\./ }],
    ['github-rejected 403', rejection({ ...detail, status: 403, message: 'nope' }), { kind: 'no-permission', action: null, message: /through its Keycloak link, can't create issues in acme\/widgets \(nope\)/ }],
    ['github-rejected 404', rejection({ ...detail, status: 404 }), { kind: 'not-found', message: /Keycloak GitHub link can't write to it/ }],
    ['github-rejected 410', rejection({ ...detail, status: 410 }), { kind: 'issues-disabled' }],
    ['github-rejected 422', rejection({ ...detail, status: 422, message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'invalid', message: 'bad title' }] }), { kind: 'invalid', message: /\(Validation Failed: bad title\)/ }],
    ['github-rejected primary limit', rejection({ ...detail, status: 403, rateLimitRemaining: 0, rateLimitReset: 1_790_000_000 }), { kind: 'rate-limited', message: /rate limit for your GitHub account was reached\. It resets at / }],
    ['github-rejected secondary limit', rejection({ ...detail, status: 403, retryAfter: 60 }), { kind: 'secondary-rate-limited', message: /Wait a minute/ }],
    ['github-rejected 500', rejection({ ...detail, status: 500 }), { kind: 'outcome-unknown', outcome: 'unknown', message: /GitHub had a problem \(500\)/ }],
    ['github-no-answer', { status: 504, error: 'github-no-answer' }, { kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh', message: /The Urutau server got no answer from GitHub/ }],
    ['github-writes-off', { status: 403, error: 'github-writes-off' }, { kind: 'writes-off', outcome: 'not-created' }],
    ['github-access signin-expired', { status: 424, error: 'github-access', body: { error: 'github-access', message: 'x', problem: 'signin-expired' } }, { kind: 'server-access', problem: 'signin-expired', action: 'sign-in-keycloak', message: /Sign in with Keycloak again to create issues/ }],
    ['github-access not-linked', { status: 424, error: 'github-access', body: { error: 'github-access', message: 'x', problem: 'not-linked' } }, { kind: 'server-access', problem: 'not-linked', action: null, message: /no linked GitHub account/ }],
    ['github-access refused', { status: 424, error: 'github-access', body: { error: 'github-access', message: 'x', problem: 'refused' } }, { kind: 'server-access', problem: 'refused', message: /did not hand out your GitHub token/ }],
    ['github-access unavailable', { status: 424, error: 'github-access', body: { error: 'github-access', message: 'x', problem: 'unavailable' } }, { kind: 'server-access', problem: 'unavailable', message: /Keycloak could not be reached\. Nothing was sent/ }],
    ['csrf-rejected', { status: 403, error: 'csrf-rejected' }, { kind: 'refused', message: /Reload the page/ }],
    ['forbidden', { status: 403, error: 'forbidden' }, { kind: 'refused' }],
    ['invalid-request', { status: 400, error: 'invalid-request', message: 'title is required.' }, { kind: 'invalid', message: /^Urutau refused the issue: title is required\.$/ }],
    ['503', { status: 503, error: 'unavailable' }, { kind: 'unreachable', outcome: 'not-created', message: /nothing was created on GitHub/ }],
    ['no answer from Urutau', 'network', { kind: 'outcome-unknown', outcome: 'unknown', message: /^No answer came from the Urutau server, so/ }],
    ['500', { status: 500 }, { kind: 'outcome-unknown', outcome: 'unknown', message: /The Urutau server had a problem \(500\)/ }],
    ['418', { status: 418, error: 'server-error' }, { kind: 'unknown', message: /^The Urutau server answered 418\.$/ }],
  ]
  it.each(cases)('maps %s with exactly one request', async (_name, injected, expected) => {
    await start()
    stub.failNext('POST issues', injected)
    const error = await failure(server())
    expect(stub.requests('POST issues')).toHaveLength(1)
    const { message, ...fields } = expected
    expect(error).toMatchObject(fields)
    if (message) expect(error.message).toMatch(message)
  })

  it('maps a signed-out answer', async () => {
    await start()
    stub.failNext('POST issues', { status: 401, error: 'signed-out' })
    expect(await failure(server())).toMatchObject({ kind: 'signed-out' })
  })

  it('reads a 201 without an issue as created but unreadable', async () => {
    await start({ createIssue: () => new Response(JSON.stringify({ issue: null }), { status: 201 }) })
    expect(await failure(server())).toMatchObject({ kind: 'created-unreadable', outcome: 'created' })
  })

  it.each([
    ['an empty 201 body', () => new Response('', { status: 201 })],
    ['a 204', () => new Response(null, { status: 204 })],
    ['a 201 whose body is not JSON', () => new Response('<html>created</html>', { status: 201 })],
  ])('reads %s as created but unreadable, not a TypeError or not-created', async (_name, answer) => {
    await start({ createIssue: answer })
    expect(await failure(server())).toMatchObject({ kind: 'created-unreadable', outcome: 'created', action: 'refresh' })
  })

  it('a stop that fires while the answer arrives is reported as stopped, not as the issue', async () => {
    const stop = new AbortController()
    await start({
      createIssue: () => {
        stop.abort()
        return undefined
      },
    })
    expect(await failure(server(stop.signal))).toMatchObject({ kind: 'stopped', outcome: 'unknown', action: 'refresh' })
  })

  it('times out after 60 s as an unknown outcome', async () => {
    await start()
    honourAbort()
    vi.useFakeTimers()
    const gate = stub.hold('POST issues')
    const pending = failure(server())
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await pending
    expect(error).toMatchObject({ kind: 'outcome-unknown', outcome: 'unknown', action: 'refresh' })
    expect(error.message).toBe(
      'No answer came from the Urutau server, so the issue may have been created. Refresh the board and look for it before creating it again.',
    )
    expect(error.message).not.toContain("You stopped waiting")
    gate.release()
  })

  it('a stop while the request is held is unknown with Refresh', async () => {
    await start()
    honourAbort()
    const gate = stub.hold('POST issues')
    const stop = new AbortController()
    const pending = failure(server(stop.signal))
    await Promise.resolve()
    stop.abort()
    expect(await pending).toMatchObject({ kind: 'stopped', outcome: 'unknown', action: 'refresh' })
    gate.release()
  })
})

describe('classifyGitHubFailure', () => {
  const detail = { status: 403, message: null, errors: [], retryAfter: null, rateLimitRemaining: null, rateLimitReset: null }
  it('leaves out the second sentence of a primary limit without a reset time', () => {
    const error = classifyGitHubFailure({ ...detail, rateLimitRemaining: 0 }, 'browser', FULL_NAME, new Date())
    expect(error.message).toBe("GitHub's rate limit for your token was reached.")
    expect(error.resetAt).toBeNull()
  })

  it('computes the secondary limit reset from the clock', () => {
    const now = new Date('2026-10-03T10:00:00Z')
    expect(classifyGitHubFailure({ ...detail, retryAfter: 90 }, 'browser', FULL_NAME, now).resetAt).toEqual(new Date('2026-10-03T10:01:30Z'))
    expect(classifyGitHubFailure({ ...detail, retryAfter: 30 }, 'browser', FULL_NAME, now).resetAt).toEqual(new Date('2026-10-03T10:00:30Z'))
    expect(classifyGitHubFailure({ ...detail, status: 429 }, 'browser', FULL_NAME, now).resetAt).toEqual(new Date('2026-10-03T10:01:00Z'))
  })
})

describe('failureDetailOf', () => {
  it('keeps the first five errors, cuts long text and ignores headers that are not whole numbers', async () => {
    const errors = Array.from({ length: 7 }, () => ({ resource: 'Issue', field: 'title', code: 'invalid', message: 'm'.repeat(300) }))
    const response = json({ message: 'v'.repeat(600), errors }, { status: 422, headers: { 'retry-after': '12', 'x-ratelimit-remaining': 'many', 'x-ratelimit-reset': '1790000000' } })
    const detail = await failureDetailOf(response)
    expect(detail.status).toBe(422)
    expect(detail.message).toHaveLength(500)
    expect(detail.errors).toHaveLength(5)
    expect(detail.errors[0].message).toHaveLength(200)
    expect(detail).toMatchObject({ retryAfter: 12, rateLimitRemaining: null, rateLimitReset: 1_790_000_000 })
  })

  it('gives a null message and no errors for a body that is not JSON', async () => {
    expect(await failureDetailOf(new Response('<html>', { status: 500 }))).toMatchObject({ status: 500, message: null, errors: [] })
  })
})

describe('parseCreatedIssue', () => {
  const valid = () => stubCreatedIssue(FULL_NAME, 5, 'Hello')
  it('maps a GitHub issue with the existing mapping', () => {
    expect(parseCreatedIssue(valid())).toMatchObject({ number: 5, title: 'Hello', state: 'open', url: 'https://github.com/acme/widgets/issues/5', author: { login: 'ada' } })
  })

  it.each(['number', 'title', 'state', 'html_url', 'labels', 'created_at', 'updated_at'])('returns null without %s', (field) => {
    const body = valid()
    delete body[field]
    expect(parseCreatedIssue(body)).toBeNull()
  })

  it('returns null for a pull request, a bad number or a non-object', () => {
    expect(parseCreatedIssue({ ...valid(), pull_request: {} })).toBeNull()
    expect(parseCreatedIssue({ ...valid(), number: 0 })).toBeNull()
    expect(parseCreatedIssue({ ...valid(), number: 1.5 })).toBeNull()
    expect(parseCreatedIssue(null)).toBeNull()
    expect(parseCreatedIssue([])).toBeNull()
  })
})
