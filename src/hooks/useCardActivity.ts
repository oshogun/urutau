import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CardActivity, IssueActivityResponse } from '../domain/api'
import { repoKey } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'
import { issueActivityKey, useActivity } from '../state/activityStore'

const NO_CARDS: Record<number, CardActivity> = {}

export interface BoardActivity {
  cards: ReadonlyMap<number, CardActivity>
  status: 'loading' | 'ready' | 'error'
}

/**
 * The claim and last run of every issue that has one, for the board page. Loads once when the
 * board opens without activity; the live-updates hook keeps it current after that.
 */
export function useBoardActivity(repo: RepoRef): BoardActivity {
  const key = repoKey(repo)
  const entry = useActivity((state) => state.boards[key])
  useEffect(() => {
    if (!useActivity.getState().boards[key]) void useActivity.getState().load(key)
  }, [key])
  const cards = entry?.cards ?? NO_CARDS
  return useMemo(
    () => ({
      cards: new Map(Object.values(cards).map((card) => [card.issue, card] as const)),
      status: entry?.status ?? 'loading',
    }),
    [cards, entry?.status],
  )
}

export interface IssueActivity {
  data: IssueActivityResponse | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
  /** Releases the claim run `runId` holds; rejects with the server's error. */
  release(runId: string): Promise<void>
  /** Accepts a normative item of a run; rejects with the server's error. */
  accept(runId: string, itemId: string): Promise<void>
}

/** The runs, items and claim of one issue, fetched when it mounts and kept current by card-activity events. */
export function useIssueActivity(repo: RepoRef, issue: number): IssueActivity {
  const key = repoKey(repo)
  const data = useActivity((state) => state.issues[issueActivityKey(key, issue)]) ?? null
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const id = issueActivityKey(key, issue)

  useEffect(() => {
    let current = true
    useActivity
      .getState()
      .refreshIssue(key, issue)
      .then(() => current && setFailure(null))
      .catch((error: unknown) => {
        if (current) setFailure({ key: id, message: error instanceof Error ? error.message : 'The activity could not be loaded.' })
      })
    return () => {
      current = false
    }
  }, [key, issue, id])

  const release = useCallback((runId: string) => useActivity.getState().release(key, issue, runId), [key, issue])
  const accept = useCallback(
    (runId: string, itemId: string) => useActivity.getState().accept(key, issue, runId, itemId),
    [key, issue],
  )
  const error = failure?.key === id ? failure.message : null
  return { data, status: data ? 'ready' : error ? 'error' : 'loading', error, release, accept }
}
