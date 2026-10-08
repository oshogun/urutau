import { create } from 'zustand'
import { acceptItem, getBoardActivity, getIssueActivity, releaseClaim } from '../api/activity'
import { ApiError } from '../api/client'
import type { CardActivity, IssueActivityResponse, RunSummaryView } from '../domain/api'
import { onSessionChange } from './session'

export interface BoardActivityEntry {
  status: 'loading' | 'ready' | 'error'
  cards: Record<number, CardActivity>
}

export interface ActivityState {
  boards: Record<string, BoardActivityEntry>
  /** Keyed by `${repoKey}#${issue}`. */
  issues: Record<string, IssueActivityResponse>
  /** Replaces the cards of a board with the server's list. Calls made while one is in flight share it. */
  load(repoKey: string): Promise<void>
  /**
   * Fetches one issue and updates its detail and its card from the answer. Calls made while one is
   * in flight for the same issue share it, and one more request follows when any arrived meanwhile.
   */
  refreshIssue(repoKey: string, issue: number): Promise<void>
  /** Releases the claim run `runId` holds, then refreshes the issue; refreshes and rethrows when the claim is gone or another run's. */
  release(repoKey: string, issue: number, runId: string): Promise<void>
  /** Accepts a normative item, then refreshes the issue; refreshes and rethrows when the item was already closed. */
  accept(repoKey: string, issue: number, runId: string, itemId: string): Promise<void>
}

export const issueActivityKey = (repoKey: string, issue: number) => `${repoKey}#${issue}`

/** Bumped whenever the session changes, so answers to requests from the old session are dropped. */
let epoch = 0
const loads = new Map<string, Promise<void>>()
const refreshes = new Map<string, { promise: Promise<void>; again: boolean }>()

function summaryOf(run: IssueActivityResponse['runs'][number]): RunSummaryView {
  return {
    runId: run.runId,
    status: run.status,
    statusAt: run.statusAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    triageRange: run.triageRange,
    unverifiedOpen: run.unverifiedOpen,
  }
}

export const useActivity = create<ActivityState>()((set, get) => {
  async function fetchIssue(repoKey: string, issue: number): Promise<void> {
    const startedIn = epoch
    const detail = await getIssueActivity(repoKey, issue)
    if (epoch !== startedIn) return
    set((state) => {
      const next: Partial<ActivityState> = { issues: { ...state.issues, [issueActivityKey(repoKey, issue)]: detail } }
      const board = state.boards[repoKey]
      if (board) {
        const cards = { ...board.cards }
        if (detail.claim === null && detail.runs.length === 0) delete cards[issue]
        else cards[issue] = { issue, claim: detail.claim, lastRun: detail.runs.length > 0 ? summaryOf(detail.runs[0]) : null }
        next.boards = { ...state.boards, [repoKey]: { ...board, cards } }
      }
      return next
    })
  }

  async function settle(repoKey: string, issue: number, error: unknown, codes: readonly string[]): Promise<never> {
    if (error instanceof ApiError && codes.includes(error.code)) {
      try {
        await get().refreshIssue(repoKey, issue)
      } catch {
        // The original refusal is the error the caller needs.
      }
    }
    throw error
  }

  return {
    boards: {},
    issues: {},

    load(repoKey) {
      const running = loads.get(repoKey)
      if (running) return running
      const startedIn = epoch
      if (!get().boards[repoKey]) set((state) => ({ boards: { ...state.boards, [repoKey]: { status: 'loading', cards: {} } } }))
      const slot: { promise: Promise<void> | null } = { promise: null }
      slot.promise = (async () => {
        try {
          const response = await getBoardActivity(repoKey)
          if (epoch !== startedIn) return
          const cards: Record<number, CardActivity> = {}
          for (const card of response.cards) cards[card.issue] = card
          set((state) => ({ boards: { ...state.boards, [repoKey]: { status: 'ready', cards } } }))
        } catch {
          if (epoch !== startedIn) return
          // Cards already shown stay; the next hello loads them again.
          set((state) => {
            const entry = state.boards[repoKey]
            return { boards: { ...state.boards, [repoKey]: { status: 'error', cards: entry?.cards ?? {} } } }
          })
        } finally {
          if (loads.get(repoKey) === slot.promise) loads.delete(repoKey)
        }
      })()
      loads.set(repoKey, slot.promise)
      return slot.promise
    },

    refreshIssue(repoKey, issue) {
      const key = issueActivityKey(repoKey, issue)
      const running = refreshes.get(key)
      if (running) {
        running.again = true
        return running.promise
      }
      const slot: { promise: Promise<void>; again: boolean } = { again: false, promise: Promise.resolve() }
      slot.promise = (async () => {
        try {
          do {
            slot.again = false
            await fetchIssue(repoKey, issue)
          } while (slot.again)
        } finally {
          if (refreshes.get(key) === slot) refreshes.delete(key)
        }
      })()
      refreshes.set(key, slot)
      return slot.promise
    },

    async release(repoKey, issue, runId) {
      try {
        await releaseClaim(repoKey, issue, runId)
      } catch (error) {
        return settle(repoKey, issue, error, ['claim-changed', 'not-found'])
      }
      await get().refreshIssue(repoKey, issue)
    },

    async accept(repoKey, issue, runId, itemId) {
      try {
        await acceptItem(repoKey, runId, itemId)
      } catch (error) {
        return settle(repoKey, issue, error, ['item-resolved'])
      }
      await get().refreshIssue(repoKey, issue)
    },
  }
})

onSessionChange(() => {
  epoch += 1
  loads.clear()
  refreshes.clear()
  useActivity.setState({ boards: {}, issues: {} })
})
