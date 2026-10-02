import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { apiRequest } from '../api/client'
import type { BoardListResponse, BoardSummary } from '../domain/api'
import { onBoardListChange } from '../state/boardStore'
import { onSessionChange } from '../state/session'

export const BOARD_LIST_QUERY_KEY = ['boards'] as const

/** The server-wide list of boards, most recently changed first. */
export function useBoardList() {
  const query = useQuery({
    queryKey: BOARD_LIST_QUERY_KEY,
    queryFn: async ({ signal }): Promise<BoardSummary[]> =>
      (await apiRequest<BoardListResponse>('boards', { signal })).boards,
  })
  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  }
}

/**
 * Connects the query cache to the stores: it is reset on every session change (mounted queries refetch) and the board
 * list refetches after a board is created. Call once where the QueryClient is created; the
 * returned function undoes it.
 */
export function bindQueryClient(queryClient: QueryClient): () => void {
  const offSession = onSessionChange(() => {
    void queryClient.resetQueries()
  })
  const offBoards = onBoardListChange(() => {
    void queryClient.invalidateQueries({ queryKey: BOARD_LIST_QUERY_KEY })
  })
  return () => {
    offSession()
    offBoards()
  }
}
