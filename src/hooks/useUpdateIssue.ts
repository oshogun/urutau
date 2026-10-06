import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { IssueUpdateFields } from '../domain/api'
import { normalizeIssueUpdate } from '../domain/issueUpdate'
import { repoKey } from '../domain/repoRef'
import type { Issue, RepoRef, RepoSnapshot } from '../domain/types'
import { UpdateIssueError, updateIssue, updateIssueFailures } from '../github/updateIssue'
import { applyToSnapshots, chooseWritePath, noteWriteFailure, requireWritesOn } from './issueWriteSteps'

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

      const { via, token } = chooseWritePath(updateIssueFailures)
      await requireWritesOn(queryClient, signal, updateIssueFailures)

      const apply = (issue: Issue) => applyToSnapshots(queryClient, key, (snapshot) => withUpdatedIssue(snapshot, issue))

      let issue: Issue
      try {
        issue = await updateIssue({ fullName, number, expectedUpdatedAt, fields: normalized.value, via, token, signal })
      } catch (error) {
        if (error instanceof UpdateIssueError) {
          noteWriteFailure(queryClient, error)
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
