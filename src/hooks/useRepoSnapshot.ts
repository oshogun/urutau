import { useQuery } from '@tanstack/react-query'
import { repoKey } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'
import { fetchRepoSnapshot } from '../github/api'
import { GitHubError } from '../github/client'
import { useSettings } from '../state/settings'

export const SNAPSHOT_QUERY_ROOT = 'snapshot'

/**
 * Loads repository, labels and issues in one go.
 *
 * The token is read from the store when the request starts rather than kept in
 * the query key; whoever changes it resets the snapshot queries.
 */
export function useRepoSnapshot(repo: RepoRef, closedWindowDays: number) {
  const key = repoKey(repo)
  return useQuery({
    queryKey: [SNAPSHOT_QUERY_ROOT, key, closedWindowDays],
    queryFn: ({ signal }) =>
      fetchRepoSnapshot(repo, { token: useSettings.getState().token, closedWindowDays, signal }),
    // Keep showing the board while a different closed-issue window loads,
    // but never show one repository's issues while another is loading.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === key ? previous : undefined,
    retry: (failureCount, error) =>
      error instanceof GitHubError && error.retryable && failureCount < 2,
  })
}
