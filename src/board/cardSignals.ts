import { createContext, useContext } from 'react'
import type { CardActivity } from '../domain/api'
import type { Estimate } from '../domain/types'

/** What the cards of a board need besides their issue: estimates, claims and the last run, and the clock they are judged by. */
export interface CardSignals {
  estimates: Readonly<Record<number, Estimate>> | undefined
  activity: ReadonlyMap<number, CardActivity>
  /** Epoch milliseconds, refreshed by the board page; ages and the wait limit are computed from it. */
  now: number
  humanWaitLimit: number | null
  /** Absent while nobody can change estimates here. */
  onEditEstimate?: (issue: number, launcher: HTMLElement | null) => void
  /** Absent for anyone who cannot release a claim. */
  onReleaseClaim?: (issue: number) => void
}

const NO_ACTIVITY: ReadonlyMap<number, CardActivity> = new Map()

export const CardSignalsContext = createContext<CardSignals>({
  estimates: undefined,
  activity: NO_ACTIVITY,
  now: 0,
  humanWaitLimit: null,
})

export function useCardSignals(): CardSignals {
  return useContext(CardSignalsContext)
}
