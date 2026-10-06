import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api/client'
import { getServerSettings, SERVER_SETTINGS_QUERY_KEY } from '../api/settings'
import type { ServerSettings } from '../domain/api'
import type { RepoSnapshot } from '../domain/types'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { SNAPSHOT_QUERY_ROOT } from './useRepoSnapshot'

const ABORTED = Symbol('aborted')

/** Resolves with the promise's value, or ABORTED as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
    promise.then(resolve, reject)
  })
}

/** The failures a write hook throws before anything is sent; `createIssueFailures` and `updateIssueFailures` provide them. */
export interface IssueWriteFailures {
  noToken: () => Error
  writesOff: () => Error
  signedOut: () => Error
  settingsUnreachable: () => Error
  stoppedBeforeSend: () => Error
}

/** The path a write takes and the pasted token. Throws `noToken` on the browser path when there is none. */
export function chooseWritePath(failures: IssueWriteFailures): { via: 'browser' | 'server'; token: string } {
  const via = useSession.getState().session?.githubAccess.mode === 'server' ? 'server' : 'browser'
  const token = useSettings.getState().token
  if (via === 'browser' && token.trim() === '') throw failures.noToken()
  return { via, token }
}

/** Asks the server for the GitHub-writes switch again, because the admin may have turned it off since the board loaded. */
export async function requireWritesOn(
  queryClient: QueryClient,
  signal: AbortSignal | undefined,
  failures: IssueWriteFailures,
): Promise<void> {
  let settings: ServerSettings | typeof ABORTED
  try {
    settings = await untilAborted(
      queryClient.fetchQuery({
        queryKey: SERVER_SETTINGS_QUERY_KEY,
        queryFn: ({ signal: querySignal }) => getServerSettings(querySignal),
        staleTime: 0,
      }),
      signal,
    )
  } catch (error) {
    throw error instanceof ApiError && error.code === 'signed-out' ? failures.signedOut() : failures.settingsUnreachable()
  }
  if (settings === ABORTED) throw failures.stoppedBeforeSend()
  if (typeof settings !== 'object' || settings === null) throw failures.settingsUnreachable()
  if (!settings.githubWrites) throw failures.writesOff()
  if (signal?.aborted) throw failures.stoppedBeforeSend()
}

/** Caches a 'writes-off' answer and refreshes the session when a failure shows it changed. */
export function noteWriteFailure(queryClient: QueryClient, error: { kind: string; problem: string | null }): void {
  if (error.kind === 'writes-off') {
    queryClient.setQueryData<ServerSettings>(SERVER_SETTINGS_QUERY_KEY, { githubWrites: false })
  }
  const sessionChanged = error.kind === 'refused' || (error.kind === 'server-access' && error.problem !== 'unavailable')
  if (sessionChanged) void useSession.getState().refresh()
}

/**
 * Writes `withIssue` into every cached snapshot of the repository. A snapshot fetch still running
 * would overwrite the new version when it lands, so it is cancelled first. Cancelling sends a
 * query that had no data yet (its first fetch) back to pending and discards a Refresh's result,
 * and nothing would fetch either again, so after the write each cancelled query is fetched again
 * (not awaited): the new request starts after GitHub has the change. Queries that were not
 * fetching are left alone. `afterWrite` runs synchronously right after the cache write, so a
 * caller can change other state in the same render.
 */
export async function applyToSnapshots(
  queryClient: QueryClient,
  key: string,
  withIssue: (snapshot: RepoSnapshot) => RepoSnapshot,
  afterWrite?: () => void,
): Promise<void> {
  const snapshots = { queryKey: [SNAPSHOT_QUERY_ROOT, key] }
  const fetching = queryClient.getQueryCache().findAll({ ...snapshots, fetchStatus: 'fetching' })
  const fetchingKeys = fetching.map((query) => query.queryKey)
  if (fetching.length > 0) await queryClient.cancelQueries(snapshots)
  queryClient.setQueriesData<RepoSnapshot>(snapshots, (old) => old && withIssue(old))
  afterWrite?.()
  for (const queryKey of fetchingKeys) void queryClient.refetchQueries({ queryKey, exact: true })
}
