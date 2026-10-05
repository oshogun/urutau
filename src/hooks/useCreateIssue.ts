import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { CreateIssueRequest } from '../domain/api'
import { placeNewIssue } from '../domain/board'
import { repoKey } from '../domain/repoRef'
import type { Issue, RepoRef, RepoSnapshot } from '../domain/types'
import {
  CreateIssueError,
  createIssue,
  createIssueFailures,
  normalizeIssueFields,
} from '../github/createIssue'
import { chooseWritePath, noteWriteFailure, requireWritesOn } from './issueWriteSteps'
import { useBoard } from './useBoard'
import { SNAPSHOT_QUERY_ROOT } from './useRepoSnapshot'

export interface CreateIssueInput {
  /** `snapshot.repository.fullName`. */
  fullName: string
  bucketId: string
  /** As typed; the hook trims the title and leaves out a blank body. */
  fields: CreateIssueRequest
  /** The dialog's stop signal; checked before the request and passed to createIssue. */
  signal?: AbortSignal
}

/** Adds `issue` to the snapshot, replacing an issue with the same number; everything else stays. */
export function withCreatedIssue(snapshot: RepoSnapshot, issue: Issue): RepoSnapshot {
  return {
    ...snapshot,
    issues: [...snapshot.issues.filter((existing) => existing.number !== issue.number), issue],
  }
}

/**
 * Returns `create`, which makes one GitHub issue and puts it on the board without a snapshot
 * request: the issue GitHub answers with is added to every cached snapshot of `repo`, and its
 * bucket and position are saved through the board store like a card move (a 409 there adopts
 * the teammate's board). `create` resolves with the issue and rejects with a CreateIssueError.
 */
export function useCreateIssue(repo: RepoRef) {
  const queryClient = useQueryClient()
  const board = useBoard(repo)
  const { update } = board
  const key = repoKey(repo)

  return useCallback(
    async ({ fullName, bucketId, fields, signal }: CreateIssueInput): Promise<Issue> => {
      const normalized = normalizeIssueFields(fields)
      if (!normalized.ok) throw createIssueFailures.invalid(normalized.message)

      const { via, token } = chooseWritePath(createIssueFailures)
      await requireWritesOn(queryClient, signal, createIssueFailures)

      let issue: Issue
      try {
        issue = await createIssue({ fullName, fields: normalized.value, via, token, signal })
      } catch (error) {
        if (error instanceof CreateIssueError) noteWriteFailure(queryClient, error)
        throw error
      }

      // A snapshot fetch still running would overwrite the new card when it lands, so cancel it.
      const snapshots = { queryKey: [SNAPSHOT_QUERY_ROOT, key] }
      if (queryClient.isFetching(snapshots) > 0) await queryClient.cancelQueries(snapshots)
      // No await between these two, so React renders the card and its placement together.
      queryClient.setQueriesData<RepoSnapshot>(snapshots, (old) => old && withCreatedIssue(old, issue))
      update((current) => placeNewIssue(current, issue.number, bucketId))
      return issue
    },
    [queryClient, update, key],
  )
}
