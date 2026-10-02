import { useCallback } from 'react'
import { DEFAULT_CLOSED_WINDOW_DAYS } from '../domain/board'
import { formatRepo, repoKey } from '../domain/repoRef'
import type { BoardConfig, RepoRef } from '../domain/types'
import { useBoards } from '../state/boardStore'
import type { BoardEntry } from '../state/boardStore'

const NO_ENTRY: BoardEntry = {
  status: 'loading',
  stored: null,
  board: null,
  saving: false,
  dirty: false,
  conflict: null,
  saveError: null,
  loadError: null,
}

/** The server-stored board of one repository, with its optimistic edits and save state. */
export function useBoard(repo: RepoRef) {
  const key = repoKey(repo)
  const entry = useBoards((state) => state.entries[key]) ?? NO_ENTRY

  const load = useCallback(() => useBoards.getState().load(key), [key])
  const create = useCallback(
    (board: BoardConfig, fullName?: string) =>
      useBoards.getState().create(key, fullName ?? formatRepo(repo), board),
    [key, repo],
  )
  const update = useCallback(
    (recipe: (current: BoardConfig) => BoardConfig) => {
      const stored = useBoards.getState().entries[key]?.stored
      useBoards.getState().update(key, stored?.fullName ?? formatRepo(repo), recipe)
    },
    [key, repo],
  )
  const retrySave = useCallback(() => useBoards.getState().retrySave(key), [key])
  const dismissConflict = useCallback(() => useBoards.getState().dismissConflict(key), [key])
  const reloadIfIdle = useCallback(() => useBoards.getState().reloadIfIdle(key), [key])

  return { ...entry, key, load, create, update, retrySave, dismissConflict, reloadIfIdle }
}

/** The closed-issue window is needed before the board (and its labels) has loaded. */
export function useClosedWindowDays(key: string): number {
  return useBoards((state) => state.entries[key]?.board?.closedWindowDays ?? DEFAULT_CLOSED_WINDOW_DAYS)
}
