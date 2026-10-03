import { useQuery } from '@tanstack/react-query'
import { repoKey } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'
import { fetchRepoSnapshot } from '../github/api'
import { GitHubError, browserTransport } from '../github/client'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'

export const SNAPSHOT_QUERY_ROOT = 'snapshot'

/**
 * Loads repository, labels and issues in one go.
 *
 * The token is read from the store when the request starts rather than kept in
 * the query key; whoever changes it resets the snapshot queries.
 *
 * When the session's GitHub access mode is `server`, reads go through the Urutau server's
 * proxy and the pasted token is not used. The mode is part of the query key, so it refetches
 * when the mode changes. A `server-access` failure (the server cannot get the user's GitHub
 * token) reloads the session; its access then says `browser` with the problem and the
 * snapshot is fetched from the browser.
 */
export function useRepoSnapshot(repo: RepoRef, closedWindowDays: number) {
  const key = repoKey(repo)
  const mode = useSession((state) => state.session?.githubAccess.mode ?? 'browser')
  return useQuery({
    queryKey: [SNAPSHOT_QUERY_ROOT, key, closedWindowDays, mode],
    queryFn: async ({ signal }) => {
      try {
        return await fetchRepoSnapshot(repo, {
          closedWindowDays,
          signal,
          transport: browserTransport(
            mode === 'server' ? { via: 'server' } : { token: useSettings.getState().token },
          ),
        })
      } catch (error) {
        if (error instanceof GitHubError && error.kind === 'server-access') {
          void useSession.getState().refresh()
        }
        throw error
      }
    },
    // Keep showing the board while a different closed-issue window loads,
    // but never show one repository's issues while another is loading.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === key ? previous : undefined,
    retry: (failureCount, error) =>
      error instanceof GitHubError && error.retryable && failureCount < 2,
  })
}
