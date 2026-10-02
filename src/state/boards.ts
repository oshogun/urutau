import { useCallback, useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_CLOSED_WINDOW_DAYS, createDefaultBoard } from '../domain/board'
import type { BoardConfig, Label } from '../domain/types'

interface BoardsState {
  /** Board configuration per repository, keyed by `repoKey()`. */
  boards: Record<string, BoardConfig>
  saveBoard: (key: string, board: BoardConfig) => void
  resetBoard: (key: string) => void
}

export const useBoards = create<BoardsState>()(
  persist(
    (set) => ({
      boards: {},
      saveBoard: (key, board) => set((state) => ({ boards: { ...state.boards, [key]: board } })),
      resetBoard: (key) =>
        set((state) => {
          const boards = { ...state.boards }
          delete boards[key]
          return { boards }
        }),
    }),
    {
      name: 'urutau:boards',
      version: 1,
      partialize: ({ boards }) => ({ boards }),
    },
  ),
)

/** The closed-issue window is needed before the board (and its labels) has loaded. */
export function useClosedWindowDays(key: string): number {
  return useBoards((state) => state.boards[key]?.closedWindowDays ?? DEFAULT_CLOSED_WINDOW_DAYS)
}

/**
 * The stored board for a repository, or a default one built from its labels.
 * The default is only persisted once the user changes something.
 */
export function useBoardConfig(key: string, labels: Label[]) {
  const stored = useBoards((state) => state.boards[key])
  const saveBoard = useBoards((state) => state.saveBoard)
  const fallback = useMemo(() => createDefaultBoard(labels), [labels])

  const update = useCallback(
    (recipe: (current: BoardConfig) => BoardConfig) => {
      const current = useBoards.getState().boards[key] ?? fallback
      const next = recipe(current)
      if (next !== current) saveBoard(key, next)
    },
    [key, fallback, saveBoard],
  )

  return [stored ?? fallback, update] as const
}
