import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import type { ImportBoardsResponse } from '../domain/api'
import type { BoardExport } from '../domain/board'
import { useSession } from '../state/session'
import {
  declineV1Import,
  importV1Boards,
  isV1ImportPending,
  v1BoardExport,
} from '../state/v1Import'
import { BOARD_LIST_QUERY_KEY } from './useBoardList'

/** State behind the start page's prompt to import this browser's version-1 boards. */
export function useV1Import() {
  const queryClient = useQueryClient()
  const configLoaded = useSession((state) => state.config !== null)
  const [answered, setAnswered] = useState(false)
  const [notNow, setNotNow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportBoardsResponse | null>(null)

  const pending = configLoaded && !notNow && !answered && isV1ImportPending()

  const importNow = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await importV1Boards())
      setAnswered(true)
      void queryClient.invalidateQueries({ queryKey: BOARD_LIST_QUERY_KEY })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The boards could not be imported.')
    } finally {
      setBusy(false)
    }
  }, [queryClient])

  const decline = useCallback(() => {
    declineV1Import()
    setAnswered(true)
  }, [])

  const dismiss = useCallback(() => setNotNow(true), [])
  const copyFor = useCallback((key: string): BoardExport | null => v1BoardExport(key), [])

  return { pending, busy, error, result, importNow, decline, notNow: dismiss, copyFor }
}
