import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSecretBox } from '../auth/secretBox.ts'
import { getGithubToken, putGithubToken } from '../db/githubTokens.ts'
import { openDatabase, type Database } from '../db/index.ts'
import { createIntegration } from '../db/integrations.ts'
import { createAccount } from '../db/users.ts'
import { createLogger } from '../log.ts'
import { MCP_LIMITS } from '../mcp/contract.ts'
import { createGitHubStub, stubIssue, type GitHubStub } from '../testing/githubStub.ts'
import { createGitHubReader, GITHUB_API_ORIGIN, type GitHubReader } from './reader.ts'

const TOKEN = 'github_pat_urutau_fixture_not_a_real_token'
const REPO = { owner: 'acme', name: 'widgets' }
const KEY = Buffer.alloc(32, 7)

let database: Database
let clock: number
let logs: string[]
let userId: string
let box: ReturnType<typeof createSecretBox>

const now = () => new Date(clock)

beforeEach(async () => {
  clock = Date.UTC(2026, 5, 1)
  logs = []
  database = await openDatabase('sqlite::memory:')
  await database.migrate()
  box = createSecretBox(KEY)
  const admin = await createAccount(database.db, { username: 'admin', displayName: null, passwordHash: null, now: now() })
  if (!admin.created) throw new Error('no admin')
  const bot = await createIntegration(database.db, { username: 'planner-bot', createdBy: admin.user.id, now: now() })
  userId = bot.id
  await storeToken(TOKEN)
})

afterEach(async () => {
  vi.useRealTimers()
  await database.close()
})

async function storeToken(plain: string): Promise<void> {
  await putGithubToken(database.db, { userId, sealed: box.sealer.seal(plain, userId), keyId: box.sealer.keyId, setBy: userId, now: now() })
}

function makeReader(fetchFn: typeof fetch, opener: typeof box.opener | null = box.opener): GitHubReader {
  const log = createLogger({ write: (line) => logs.push(line), now })
  return createGitHubReader({ db: database.db, fetch: fetchFn, now, log, opener })
}

/** A fetch that fails the test on any call. */
const unplanned: typeof fetch = async (input) => {
  throw new Error(`unplanned request: ${String(input)}`)
}

function stubWithWidgets(items = [stubIssue(1), stubIssue(2)]): GitHubStub {
  return createGitHubStub({ 'acme/widgets': { id: 101, private: true, items } })
}

const signal = () => new AbortController().signal
const snapshotOf = (reader: GitHubReader, days = 14, s = signal()) => reader.fetchSnapshot(userId, REPO, days, s)
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const repoBody = { full_name: 'acme/widgets', description: null, html_url: 'https://github.com/acme/widgets', private: false }

describe('requests', () => {
  it('sends only GETs to api.github.com with the token in Authorization alone', async () => {
    const stub = stubWithWidgets()
    const result = await snapshotOf(makeReader(stub.fetch))
    expect(result.snapshot.issues.map((issue) => issue.number)).toEqual([2, 1])
    expect(result.snapshot.repository.isPrivate).toBe(true)
    expect(stub.calls.length).toBe(3)
    for (const call of stub.calls) {
      expect(call.method).toBe('GET')
      expect(call.url.startsWith(`${GITHUB_API_ORIGIN}/`)).toBe(true)
      expect(call.redirect).toBe('manual')
      expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(call.headers.get('accept')).toBe('application/vnd.github+json')
      expect(call.headers.get('x-github-api-version')).toBe('2022-11-28')
      expect(call.headers.get('user-agent')).toBe('urutau')
      expect(call.headers.get('cookie')).toBeNull()
      expect(call.url).not.toContain(TOKEN)
    }
    expect(stub.calls.some((call) => call.url.includes('/labels'))).toBe(false)
    expect(stub.calls[0].url).toBe(`${GITHUB_API_ORIGIN}/repos/acme/widgets`)
  })

  it('skips the closed list when the window is 0', async () => {
    const stub = stubWithWidgets()
    await snapshotOf(makeReader(stub.fetch), 0)
    expect(stub.calls.map((call) => new URL(call.url).search)).toEqual(['', '?state=open&per_page=100'])
  })

  it('follows next links on api.github.com across pages', async () => {
    const items = Array.from({ length: 230 }, (_, i) => stubIssue(i + 1))
    const stub = stubWithWidgets(items)
    const result = await snapshotOf(makeReader(stub.fetch))
    expect(result.snapshot.issues).toHaveLength(230)
    expect(result.openTruncated).toBe(false)
    expect(result.highestNumber).toBe(230)
  })

  it('runs the open and closed lists in parallel', async () => {
    const started: string[] = []
    const releases: Array<() => void> = []
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/repos/acme/widgets')) return json(repoBody)
      started.push(new URL(url).searchParams.get('state') ?? '')
      await new Promise<void>((resolve) => releases.push(resolve))
      return json([])
    }
    const pending = snapshotOf(makeReader(fetchFn))
    await vi.waitFor(() => expect(started.sort()).toEqual(['closed', 'open']))
    releases.forEach((release) => release())
    await pending
  })

  it('stops at a foreign next link and flags the list as truncated', async () => {
    const calls: string[] = []
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/repos/acme/widgets')) return json(repoBody)
      if (url.includes('state=open')) return json([], 200, { link: '<https://evil.example/issues?page=2>; rel="next"' })
      return json([])
    }
    const result = await snapshotOf(makeReader(fetchFn))
    expect(result.openTruncated).toBe(true)
    expect(calls.every((url) => url.startsWith(`${GITHUB_API_ORIGIN}/`))).toBe(true)
  })

  it('fails with github-unavailable when a next link on api.github.com is not allowed', async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/repos/acme/widgets')) return json(repoBody)
      if (url.includes('state=open')) return json([], 200, { link: '<https://api.github.com/user/keys?page=2>; rel="next"' })
      return json([])
    }
    await expect(snapshotOf(makeReader(fetchFn))).rejects.toMatchObject({ code: 'github-unavailable' })
    expect(logs.some((line) => JSON.parse(line).msg === 'github link refused')).toBe(true)
  })

  it('marks an unchecked token as ok after the first success, and leaves it alone afterwards', async () => {
    expect((await getGithubToken(database.db, userId))?.status).toBe('unchecked')
    await snapshotOf(makeReader(stubWithWidgets().fetch))
    expect((await getGithubToken(database.db, userId))?.status).toBe('ok')
  })
})

describe('answers', () => {
  const answering = (status: number, headers: Record<string, string> = {}): typeof fetch =>
    async () => new Response('{"message":"x"}', { status, headers })

  it('maps a redirect to repo-moved and never requests the Location', async () => {
    const calls: string[] = []
    const fetchFn: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/9' } })
    }
    await expect(snapshotOf(makeReader(fetchFn))).rejects.toMatchObject({ code: 'repo-moved' })
    expect(calls).toEqual([`${GITHUB_API_ORIGIN}/repos/acme/widgets`])
  })

  it('treats a 401 as a rejected token and makes zero requests on the next call', async () => {
    const calls: string[] = []
    const reader = makeReader(async (input) => {
      calls.push(String(input))
      return new Response('{}', { status: 401 })
    })
    await expect(snapshotOf(reader)).rejects.toMatchObject({ code: 'github-token-rejected' })
    expect((await getGithubToken(database.db, userId))?.status).toBe('rejected')
    expect(await reader.tokenState(userId)).toBe('rejected')
    const before = calls.length
    await expect(snapshotOf(reader)).rejects.toMatchObject({ code: 'github-token-rejected' })
    expect(calls.length).toBe(before)
  })

  it('does not mark a token replaced meanwhile as rejected', async () => {
    const replaced = 'github_pat_urutau_second_fixture_not_a_real_token'
    const reader = makeReader(async () => {
      await storeToken(replaced)
      return new Response('{}', { status: 401 })
    })
    await expect(snapshotOf(reader)).rejects.toMatchObject({ code: 'github-token-rejected' })
    expect((await getGithubToken(database.db, userId))?.status).toBe('unchecked')
  })

  it('maps 403 and 429 rate answers to github-rate-limited with the wait', async () => {
    await expect(snapshotOf(makeReader(answering(429, { 'retry-after': '42' })))).rejects.toMatchObject({
      code: 'github-rate-limited',
      extra: { retryAfterSeconds: 42, reserve: false },
    })
    const reset = Math.floor(clock / 1000) + 90
    await expect(
      snapshotOf(makeReader(answering(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(reset) }))),
    ).rejects.toMatchObject({ code: 'github-rate-limited', extra: { retryAfterSeconds: 90, reserve: false } })
  })

  it.each([
    [403, 'repo-not-found'],
    [404, 'repo-not-found'],
    [410, 'issues-disabled'],
    [500, 'github-unavailable'],
    [429, 'github-unavailable'],
  ])('maps a plain %i to %s', async (status, code) => {
    await expect(snapshotOf(makeReader(answering(status)))).rejects.toMatchObject({ code })
  })

  it('maps a network error and a body that is not JSON to github-unavailable', async () => {
    await expect(
      snapshotOf(
        makeReader(async () => {
          throw new TypeError('fetch failed')
        }),
      ),
    ).rejects.toMatchObject({ code: 'github-unavailable' })
    await expect(snapshotOf(makeReader(async () => new Response('<html>', { status: 200 })))).rejects.toMatchObject({
      code: 'github-unavailable',
    })
  })

  it('logs one warn line per failure without the token, a query or a body', async () => {
    await expect(snapshotOf(makeReader(answering(500)))).rejects.toMatchObject({ code: 'github-unavailable' })
    const lines = logs.map((line) => JSON.parse(line))
    expect(lines).toEqual([
      expect.objectContaining({ level: 'warn', msg: 'github read failed', integration: userId, repo: 'acme/widgets', status: 500, code: 'github-unavailable' }),
    ])
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('reports the call being stopped as call-stopped', async () => {
    const controller = new AbortController()
    const reader = makeReader(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          controller.abort()
        }),
    )
    await expect(snapshotOf(reader, 14, controller.signal)).rejects.toMatchObject({ code: 'call-stopped' })
  })
})

describe('the stored token', () => {
  it('refuses with github-token-missing and no request when there is no token', async () => {
    await database.db.deleteFrom('github_tokens').execute()
    const reader = makeReader(unplanned)
    await expect(snapshotOf(reader)).rejects.toMatchObject({ code: 'github-token-missing' })
    expect(await reader.tokenState(userId)).toBe('missing')
  })

  it('gives github-token-unreadable with no request when the key is unset or differs', async () => {
    const reader = makeReader(unplanned, null)
    await expect(snapshotOf(reader)).rejects.toMatchObject({ code: 'github-token-unreadable' })
    expect(await reader.tokenState(userId)).toBe('unreadable')
    const other = createSecretBox(Buffer.alloc(32, 9))
    const otherReader = makeReader(unplanned, other.opener)
    await expect(snapshotOf(otherReader)).rejects.toMatchObject({ code: 'github-token-unreadable' })
    expect(await otherReader.tokenState(userId)).toBe('unreadable')
  })

  it('reports an ok state without decrypting', async () => {
    expect(await makeReader(unplanned).tokenState(userId)).toBe('ok')
  })

  it.each([
    ['an OAuth token', () => 'gho_' + 'F'.repeat(36)],
    ['a server token', () => 'ghs_' + 'F'.repeat(36)],
    ['40 hex digits', () => 'f'.repeat(40)],
    ['an Urutau MCP token', () => 'urutau_mcp_' + 'A'.repeat(43)],
    ['a value with a line break', () => `${TOKEN}\nX-Evil: 1`],
  ])('gives github-token-unreadable with no request for %s, and the error and logs do not hold it', async (_name, make) => {
    const plain = make()
    await storeToken(plain)
    const reader = makeReader(unplanned)
    const error = await snapshotOf(reader).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'github-token-unreadable' })
    expect(String((error as Error).message) + String((error as Error).stack) + logs.join('\n')).not.toContain(plain)
  })

  it('accepts a classic token shape', async () => {
    await storeToken('ghp_' + 'F'.repeat(36))
    const stub = stubWithWidgets()
    await snapshotOf(makeReader(stub.fetch))
    expect(stub.calls[0].headers.get('authorization')).toBe(`Bearer ghp_${'F'.repeat(36)}`)
  })

  it('keeps the token out of errors and log lines when GitHub fails', async () => {
    const reader = makeReader(async () => {
      throw new Error(`boom ${TOKEN}`)
    })
    const error = await snapshotOf(reader).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'github-unavailable' })
    expect(String((error as Error).message) + logs.join('\n')).not.toContain(TOKEN)
  })
})

describe('budget', () => {
  const withRate = (remaining: number, limit = 5000, resetInSeconds = 600): typeof fetch =>
    async (input) => {
      const headers = {
        'x-ratelimit-limit': String(limit),
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-reset': String(Math.floor(clock / 1000) + resetInSeconds),
      }
      if (String(input).endsWith('/repos/acme/widgets')) return json(repoBody, 200, headers)
      return json([], 200, headers)
    }

  it('refuses a cold fetch below the reserve with no request, and lifts the refusal at the reset time', async () => {
    const calls: string[] = []
    const inner = withRate(499)
    const reader = makeReader(async (input, init) => {
      calls.push(String(input))
      return inner(input, init)
    })
    await snapshotOf(reader)
    const before = calls.length
    await expect(snapshotOf(reader)).rejects.toMatchObject({
      code: 'github-rate-limited',
      extra: { reserve: true, retryAfterSeconds: 600 },
    })
    expect(calls.length).toBe(before)
    clock += 600_000
    await snapshotOf(reader)
    expect(calls.length).toBeGreaterThan(before)
  })

  it('allows a fetch with exactly the reserve left', async () => {
    const reader = makeReader(withRate(500))
    await snapshotOf(reader)
    await expect(snapshotOf(reader)).resolves.toBeDefined()
  })

  it('refuses a cold fetch when the hourly cap would be passed, and forget clears the count', async () => {
    const stub = stubWithWidgets([])
    const reader = makeReader(stub.fetch)
    const perSnapshot = 3
    const rounds = Math.floor((MCP_LIMITS.githubRequestsPerHour - MCP_LIMITS.requestsPerSnapshot) / perSnapshot) + 1
    for (let i = 0; i < rounds; i++) {
      await snapshotOf(reader)
      clock += 1000
    }
    const made = stub.calls.length
    expect(made + MCP_LIMITS.requestsPerSnapshot).toBeGreaterThan(MCP_LIMITS.githubRequestsPerHour)
    const error = await snapshotOf(reader).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'github-rate-limited', extra: { reserve: false } })
    expect((error as { extra: { retryAfterSeconds: number } }).extra.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(stub.calls.length).toBe(made)
    reader.forget(userId)
    await snapshotOf(reader)
    expect(stub.calls.length).toBe(made + perSnapshot)
  })

  it('lets requests leave the hourly window', async () => {
    const stub = stubWithWidgets([])
    const reader = makeReader(stub.fetch)
    const rounds = Math.floor((MCP_LIMITS.githubRequestsPerHour - MCP_LIMITS.requestsPerSnapshot) / 3) + 1
    for (let i = 0; i < rounds; i++) await snapshotOf(reader)
    await expect(snapshotOf(reader)).rejects.toMatchObject({ code: 'github-rate-limited' })
    clock += 3_600_001
    await expect(snapshotOf(reader)).resolves.toBeDefined()
  })
})

describe('one snapshot at a time per account', () => {
  function gatedFetch() {
    const waiting: Array<() => void> = []
    let inRepoCalls = 0
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).endsWith('/repos/acme/widgets')) {
        inRepoCalls++
        await new Promise<void>((resolve) => waiting.push(resolve))
        return json(repoBody)
      }
      return json([])
    }
    return { fetchFn, waiting, repoCalls: () => inRepoCalls }
  }

  it('starts the second snapshot of an account only after the first finished', async () => {
    const gate = gatedFetch()
    const reader = makeReader(gate.fetchFn)
    const first = snapshotOf(reader)
    const second = snapshotOf(reader)
    await vi.waitFor(() => expect(gate.repoCalls()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(gate.repoCalls()).toBe(1)
    gate.waiting[0]()
    await first
    await vi.waitFor(() => expect(gate.repoCalls()).toBe(2))
    gate.waiting[1]()
    await second
  })

  it('does not make another account wait', async () => {
    const gate = gatedFetch()
    const reader = makeReader(gate.fetchFn)
    const other = await createIntegration(database.db, { username: 'other-bot', createdBy: userId, now: now() })
    await putGithubToken(database.db, { userId: other.id, sealed: box.sealer.seal(TOKEN, other.id), keyId: box.sealer.keyId, setBy: userId, now: now() })
    const first = snapshotOf(reader)
    const second = reader.fetchSnapshot(other.id, REPO, 14, signal())
    await vi.waitFor(() => expect(gate.repoCalls()).toBe(2))
    gate.waiting.forEach((release) => release())
    await Promise.all([first, second])
  })

  it('gives github-busy after 20 seconds in the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gate = gatedFetch()
    const reader = makeReader(gate.fetchFn)
    const first = snapshotOf(reader)
    await vi.waitFor(() => expect(gate.repoCalls()).toBe(1))
    const second = snapshotOf(reader)
    const outcome = second.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(MCP_LIMITS.queueWaitMs - 1)
    let settled = false
    void outcome.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toMatchObject({ code: 'github-busy', extra: { retryAfterSeconds: 5 } })
    expect(gate.repoCalls()).toBe(1)
    gate.waiting[0]()
    await first
  })

  it('gives call-stopped to a waiter that aborts, and lets the next one run', async () => {
    const gate = gatedFetch()
    const reader = makeReader(gate.fetchFn)
    const first = snapshotOf(reader)
    await vi.waitFor(() => expect(gate.repoCalls()).toBe(1))
    const controller = new AbortController()
    const waiter = snapshotOf(reader, 14, controller.signal)
    const third = snapshotOf(reader)
    controller.abort()
    await expect(waiter).rejects.toMatchObject({ code: 'call-stopped' })
    gate.waiting[0]()
    await first
    await vi.waitFor(() => expect(gate.repoCalls()).toBe(2))
    gate.waiting[1]()
    await third
  })

  it('gives up on a request that gets no answer for 20 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reader = makeReader(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const outcome = snapshotOf(reader).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(MCP_LIMITS.githubRequestTimeoutMs)
    expect(await outcome).toMatchObject({ code: 'github-unavailable' })
  })

  it('aborts a snapshot that has run for 60 seconds even when each request is answered in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let requests = 0
    const reader = makeReader(
      (input, init) =>
        new Promise<Response>((resolve, reject) => {
          requests++
          const url = String(input)
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          const page = Number(new URL(url).searchParams.get('page') ?? 1)
          setTimeout(() => {
            if (url.endsWith('/repos/acme/widgets')) return resolve(json(repoBody))
            const next = `${GITHUB_API_ORIGIN}/repositories/101/issues?state=open&per_page=100&page=${page + 1}`
            resolve(json([], 200, new URL(url).searchParams.get('state') === 'open' ? { link: `<${next}>; rel="next"` } : {}))
          }, 15_000)
        }),
    )
    const outcome = snapshotOf(reader).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(MCP_LIMITS.snapshotDeadlineMs)
    expect(await outcome).toMatchObject({ code: 'github-unavailable' })
    expect(requests).toBeGreaterThanOrEqual(4)
  })
})
