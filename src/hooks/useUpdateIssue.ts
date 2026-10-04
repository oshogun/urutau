import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { ApiError } from '../api/client'
import { getServerSettings, SERVER_SETTINGS_QUERY_KEY } from '../api/settings'
import type { IssueUpdateFields, ServerSettings } from '../domain/api'
import { normalizeIssueUpdate } from '../domain/issueUpdate'
import { repoKey } from '../domain/repoRef'
import type { Issue, RepoRef, RepoSnapshot } from '../domain/types'
import { UpdateIssueError, updateIssue, updateIssueFailures } from '../github/updateIssue'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { SNAPSHOT_QUERY_ROOT } from './useRepoSnapshot'

export interface UpdateIssueInput {
  /** `snapshot.repository.fullName`. */
  fullName: string
  number: number
  /** The issue's `updatedAt` when the change started. */
  expectedUpdatedAt: string
  /** From `editFields` or `stateFields`; normalized again here. */
  fields: IssueUpdateFields
  /** The dialog's stop signal; checked before the request and passed to updateIssue. */
  signal?: AbortSignal
}

export type IssueUpdater = (input: UpdateIssueInput) => Promise<Issue>

/**
 * Replaces the entry with `issue.number` in place. When there is none, appends `issue` only if it
 * is open; a closed issue the snapshot does not have leaves the snapshot unchanged (the same
 * object returned). Everything else stays.
 */
export function withUpdatedIssue(snapshot: RepoSnapshot, issue: Issue): RepoSnapshot {
  if (snapshot.issues.some((existing) => existing.number === issue.number)) {
    return { ...snapshot, issues: snapshot.issues.map((existing) => (existing.number === issue.number ? issue : existing)) }
  }
  return issue.state === 'open' ? { ...snapshot, issues: [...snapshot.issues, issue] } : snapshot
}

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

/**
 * Returns a stable callback that checks the fields and the switch, changes the issue on GitHub,
 * and writes GitHub's answer into every cached snapshot of `repo` (after a stale refusal, GitHub's
 * current issue). It never writes the board store: a change moves no card, and the bucket rules
 * place the card again from the new state. It resolves with the issue and rejects with an
 * UpdateIssueError.
 */
export function useUpdateIssue(repo: RepoRef): IssueUpdater {
  const queryClient = useQueryClient()
  const key = repoKey(repo)

  return useCallback(
    async ({ fullName, number, expectedUpdatedAt, fields, signal }: UpdateIssueInput): Promise<Issue> => {
      const normalized = normalizeIssueUpdate(fields)
      if (!normalized.ok) throw updateIssueFailures.invalid(normalized.message)

      const via = useSession.getState().session?.githubAccess.mode === 'server' ? 'server' : 'browser'
      const token = useSettings.getState().token
      if (via === 'browser' && token.trim() === '') throw updateIssueFailures.noToken()

      // Ask the server for the switch again: the admin may have turned it off since the board loaded.
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
        throw error instanceof ApiError && error.code === 'signed-out'
          ? updateIssueFailures.signedOut()
          : updateIssueFailures.settingsUnreachable()
      }
      if (settings === ABORTED) throw updateIssueFailures.stoppedBeforeSend()
      if (typeof settings !== 'object' || settings === null) throw updateIssueFailures.settingsUnreachable()
      if (!settings.githubWrites) throw updateIssueFailures.writesOff()
      if (signal?.aborted) throw updateIssueFailures.stoppedBeforeSend()

      const snapshots = { queryKey: [SNAPSHOT_QUERY_ROOT, key] }
      /** A snapshot fetch still running would overwrite the new version when it lands, so cancel it. */
      const apply = async (issue: Issue) => {
        if (queryClient.isFetching(snapshots) > 0) await queryClient.cancelQueries(snapshots)
        queryClient.setQueriesData<RepoSnapshot>(snapshots, (old) => old && withUpdatedIssue(old, issue))
      }

      let issue: Issue
      try {
        issue = await updateIssue({ fullName, number, expectedUpdatedAt, fields: normalized.value, via, token, signal })
      } catch (error) {
        if (error instanceof UpdateIssueError) {
          if (error.kind === 'writes-off') {
            queryClient.setQueryData<ServerSettings>(SERVER_SETTINGS_QUERY_KEY, { githubWrites: false })
          }
          const sessionChanged =
            error.kind === 'refused' || (error.kind === 'server-access' && error.problem !== 'unavailable')
          if (sessionChanged) void useSession.getState().refresh()
          if (error.kind === 'stale' && error.current) await apply(error.current)
        }
        throw error
      }
      await apply(issue)
      return issue
    },
    [queryClient, key],
  )
}
