/** The server's GET-only GitHub reader for agent integrations. The only module given the opener. */
import type { Kysely } from 'kysely'
import { fetchRepoSnapshotDetailed } from '../../src/github/api.ts'
import type { GitHubTransport } from '../../src/github/paging.ts'
import type { RepoRef } from '../../src/domain/types.ts'
import type { SecretOpener } from '../auth/secretBox.ts'
import { getGithubToken, setGithubTokenStatus } from '../db/githubTokens.ts'
import type { Tables } from '../db/schema.ts'
import type { Logger } from '../log.ts'
import { MCP_LIMITS, ToolFailure, type FetchSnapshotFn, type GitHubTokenState, type McpToolErrorCode } from '../mcp/contract.ts'
import { allowedGitHubPath } from './allowlist.ts'
import { checkGitHubToken } from './tokenFormats.ts'

export const GITHUB_API_ORIGIN = 'https://api.github.com' as const

const HOUR_MS = 3_600_000

export interface GitHubReaderDeps {
  db: Kysely<Tables>
  fetch: typeof fetch
  now: () => Date
  log: Logger
  /** null when TOKEN_ENCRYPTION_KEY is not set. */
  opener: SecretOpener | null
}

export interface GitHubReader {
  /** The stored token's state, without decrypting it. */
  tokenState(userId: string): Promise<GitHubTokenState>
  /** One snapshot with the account's token: one at a time per account, budget checked; rejects with ToolFailure. */
  fetchSnapshot: FetchSnapshotFn
  /** Drops the account's rate record and request counter. */
  forget(userId: string): void
}

interface RateRecord {
  limit: number
  remaining: number
  /** Epoch milliseconds. */
  resetAt: number
}

/** A failure plus the GitHub status that caused it (0 when there was none), kept for the one log line. */
interface Failure {
  failure: ToolFailure
  status: number
}

function failure(code: McpToolErrorCode, status: number, extra: ConstructorParameters<typeof ToolFailure>[1] = {}): Failure {
  return { failure: new ToolFailure(code, extra), status }
}

function wholeHeader(response: Response, name: string): number | null {
  const value = response.headers.get(name)
  if (value === null || !/^\d{1,15}$/.test(value.trim())) return null
  return Number(value)
}

export function createGitHubReader(deps: GitHubReaderDeps): GitHubReader {
  const { db, opener, log } = deps
  const rates = new Map<string, RateRecord>()
  const requestTimes = new Map<string, number[]>()
  const tails = new Map<string, Promise<void>>()
  const nowMs = () => deps.now().getTime()

  const currentRate = (userId: string): RateRecord | null => {
    const record = rates.get(userId)
    if (record && nowMs() >= record.resetAt) {
      rates.delete(userId)
      return null
    }
    return record ?? null
  }

  const recordRate = (userId: string, response: Response): void => {
    const limit = wholeHeader(response, 'x-ratelimit-limit')
    const remaining = wholeHeader(response, 'x-ratelimit-remaining')
    const reset = wholeHeader(response, 'x-ratelimit-reset')
    if (limit === null || remaining === null || reset === null) return
    rates.set(userId, { limit, remaining, resetAt: reset * 1000 })
  }

  const recentRequests = (userId: string): number[] => {
    const cutoff = nowMs() - HOUR_MS
    const times = (requestTimes.get(userId) ?? []).filter((time) => time > cutoff)
    requestTimes.set(userId, times)
    return times
  }

  /** Waits for the account's earlier snapshots; returns the function that lets the next one start. */
  const takeTurn = async (userId: string, signal: AbortSignal): Promise<() => void> => {
    const previous = tails.get(userId) ?? Promise.resolve()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const tail = previous.then(() => gate)
    tails.set(userId, tail)
    const release = () => {
      finish()
      void tail.then(() => {
        if (tails.get(userId) === tail) tails.delete(userId)
      })
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const outcome = await Promise.race([
      previous.then(() => 'turn' as const),
      new Promise<'busy'>((resolve) => {
        timer = setTimeout(() => resolve('busy'), MCP_LIMITS.queueWaitMs)
      }),
      new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted')
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
    if (outcome === 'aborted' || signal.aborted) {
      release()
      throw new ToolFailure('call-stopped')
    }
    if (outcome === 'busy') {
      release()
      throw new ToolFailure('github-busy', { retryAfterSeconds: MCP_LIMITS.busyRetryAfterSeconds })
    }
    return release
  }

  /** The decrypted token for the account, or a ToolFailure; the value never leaves the caller's scope. */
  const readToken = async (userId: string): Promise<{ plain: string; sealed: string; status: string }> => {
    const row = await getGithubToken(db, userId)
    if (!row) throw new ToolFailure('github-token-missing')
    if (row.status === 'rejected') throw new ToolFailure('github-token-rejected')
    if (!opener || row.key_id !== opener.keyId) throw new ToolFailure('github-token-unreadable')
    const plain = opener.open(row.sealed, userId)
    if (plain === null || !checkGitHubToken(plain).ok) throw new ToolFailure('github-token-unreadable')
    return { plain, sealed: row.sealed, status: row.status }
  }

  const checkBudget = (userId: string): void => {
    const rate = currentRate(userId)
    if (rate && rate.remaining < Math.ceil(rate.limit * MCP_LIMITS.reserveShare)) {
      throw new ToolFailure('github-rate-limited', {
        retryAfterSeconds: Math.max(1, Math.ceil((rate.resetAt - nowMs()) / 1000)),
        reserve: true,
      })
    }
    const times = recentRequests(userId)
    const excess = times.length + MCP_LIMITS.requestsPerSnapshot - MCP_LIMITS.githubRequestsPerHour
    if (excess > 0) {
      const frees = times[Math.min(excess, times.length) - 1] + HOUR_MS
      throw new ToolFailure('github-rate-limited', {
        retryAfterSeconds: Math.max(1, Math.ceil((frees - nowMs()) / 1000)),
        reserve: false,
      })
    }
  }

  const rateLimitedFailure = (response: Response): Failure | null => {
    const limited = response.headers.get('x-ratelimit-remaining')?.trim() === '0' || response.headers.get('retry-after') !== null
    if (!limited) return null
    const reset = wholeHeader(response, 'x-ratelimit-reset')
    const seconds =
      wholeHeader(response, 'retry-after') ?? (reset === null ? 1 : Math.ceil((reset * 1000 - nowMs()) / 1000))
    return failure('github-rate-limited', response.status, { retryAfterSeconds: Math.max(1, seconds), reserve: false })
  }

  const fetchSnapshot: FetchSnapshotFn = async (userId, repo: RepoRef, closedWindowDays, signal) => {
    if (signal.aborted) throw new ToolFailure('call-stopped')
    const repoName = `${repo.owner}/${repo.name}`
    const release = await takeTurn(userId, signal)
    const snapshotAbort = new AbortController()
    const onCallAbort = () => snapshotAbort.abort()
    signal.addEventListener('abort', onCallAbort, { once: true })
    const deadline = setTimeout(() => snapshotAbort.abort(), MCP_LIMITS.snapshotDeadlineMs)
    // Each request's timeout keeps running while its body is read; all are cleared when the snapshot ends.
    const requestTimers = new Set<ReturnType<typeof setTimeout>>()
    const dropTimer = (timer: ReturnType<typeof setTimeout>): void => {
      clearTimeout(timer)
      requestTimers.delete(timer)
    }
    // The first failure ends the snapshot; the requests it aborts reject later with errors of their own.
    const state: { first: Failure | null } = { first: null }
    const fail = (value: Failure): ToolFailure => {
      state.first ??= value
      snapshotAbort.abort()
      return state.first.failure
    }

    try {
      const token = await readToken(userId)
      checkBudget(userId)
      let marked = token.status !== 'unchecked'

      const transport: GitHubTransport = {
        root: GITHUB_API_ORIGIN,
        get: async (url, requestSignal) => {
          if (snapshotAbort.signal.aborted) throw state.first?.failure ?? new ToolFailure(signal.aborted ? 'call-stopped' : 'github-unavailable')
          let path: string | null = null
          if (url.startsWith(`${GITHUB_API_ORIGIN}/`)) {
            const parsed = new URL(url)
            path = allowedGitHubPath(parsed.pathname.slice(1), parsed.search.slice(1))
          }
          if (path === null) {
            log.warn('github link refused', { integration: userId, repo: repoName })
            throw fail(failure('github-unavailable', 0))
          }

          const timeout = new AbortController()
          const timer = setTimeout(() => timeout.abort(), MCP_LIMITS.githubRequestTimeoutMs)
          requestTimers.add(timer)
          const signals = [snapshotAbort.signal, timeout.signal]
          if (requestSignal) signals.push(requestSignal)
          recentRequests(userId).push(nowMs())
          let response: Response
          try {
            response = await deps.fetch(url, {
              method: 'GET',
              redirect: 'manual',
              signal: AbortSignal.any(signals),
              headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                Authorization: `Bearer ${token.plain}`,
                'User-Agent': 'urutau',
              },
            })
          } catch {
            dropTimer(timer)
            throw signal.aborted ? new ToolFailure('call-stopped') : fail(failure('github-unavailable', 0))
          }

          recordRate(userId, response)
          const status = response.status
          if (response.ok) {
            if (!marked) {
              marked = true
              await setGithubTokenStatus(db, userId, token.sealed, 'ok').catch(() => false)
            }
            return response
          }
          dropTimer(timer)
          void response.body?.cancel().catch(() => undefined)
          if (status >= 300 && status < 400) throw fail(failure('repo-moved', status))
          if (status === 401) {
            await setGithubTokenStatus(db, userId, token.sealed, 'rejected').catch(() => false)
            throw fail(failure('github-token-rejected', status))
          }
          if (status === 403 || status === 429) {
            const limited = rateLimitedFailure(response)
            if (limited) throw fail(limited)
            throw fail(failure(status === 403 ? 'repo-not-found' : 'github-unavailable', status))
          }
          if (status === 404) throw fail(failure('repo-not-found', status))
          if (status === 410) throw fail(failure('issues-disabled', status))
          throw fail(failure('github-unavailable', status))
        },
      }

      try {
        return await fetchRepoSnapshotDetailed(repo, {
          closedWindowDays,
          transport,
          signal: snapshotAbort.signal,
          now: nowMs,
          labels: false,
          bodies: false,
        })
      } catch {
        if (state.first) throw state.first.failure
        if (signal.aborted) throw new ToolFailure('call-stopped')
        // A body that is not JSON, or any other unexpected error.
        throw fail(failure('github-unavailable', 0))
      }
    } catch (error) {
      if (error instanceof ToolFailure) {
        const recorded = state.first
        if (error.code !== 'call-stopped' && error.code !== 'github-busy') {
          log.warn('github read failed', {
            integration: userId,
            repo: repoName,
            status: recorded && recorded.failure === error ? recorded.status : 0,
            code: error.code,
          })
        }
        throw error
      }
      log.warn('github read failed', { integration: userId, repo: repoName, status: 0, code: 'github-unavailable' })
      throw new ToolFailure('github-unavailable')
    } finally {
      clearTimeout(deadline)
      for (const timer of requestTimers) clearTimeout(timer)
      signal.removeEventListener('abort', onCallAbort)
      release()
    }
  }

  return {
    async tokenState(userId) {
      const row = await getGithubToken(db, userId)
      if (!row) return 'missing'
      if (row.status === 'rejected') return 'rejected'
      if (!opener || row.key_id !== opener.keyId) return 'unreadable'
      return 'ok'
    },
    fetchSnapshot,
    forget(userId) {
      rates.delete(userId)
      requestTimes.delete(userId)
    },
  }
}
