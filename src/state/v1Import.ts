import { apiRequest } from '../api/client'
import type { ImportBoardsRequest, ImportBoardsResponse } from '../domain/api'
import { isBoardConfig, toBoardExport } from '../domain/board'
import type { BoardExport } from '../domain/board'
import type { BoardConfig } from '../domain/types'
import { useSession } from './session'

/** The browser-only boards of version 1 of the app. Never written or deleted from here. */
const BOARDS_STORAGE_KEY = 'urutau:boards'
/** Records, per server instance, that the user imported or declined. */
const MARKER_STORAGE_KEY = 'urutau:boards-import'

export interface ImportMarker {
  instanceId: string
  outcome: 'imported' | 'declined'
  at: string
}

/** `state.boards` of the stored v1 value, or an empty object when absent or unreadable. */
function readBoards(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(BOARDS_STORAGE_KEY)
    if (!raw) return {}
    const boards = (JSON.parse(raw) as { state?: { boards?: unknown } } | null)?.state?.boards
    return boards !== null && typeof boards === 'object' && !Array.isArray(boards)
      ? (boards as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The marker, or null when absent or unparseable. */
export function readImportMarker(): ImportMarker | null {
  try {
    const raw = localStorage.getItem(MARKER_STORAGE_KEY)
    if (!raw) return null
    const marker = JSON.parse(raw) as Partial<ImportMarker> | null
    if (
      typeof marker?.instanceId === 'string' &&
      (marker.outcome === 'imported' || marker.outcome === 'declined') &&
      typeof marker.at === 'string'
    ) {
      return { instanceId: marker.instanceId, outcome: marker.outcome, at: marker.at }
    }
  } catch {
    // An unreadable marker counts as absent.
  }
  return null
}

function currentInstanceId(): string | null {
  return useSession.getState().config?.instanceId ?? null
}

function writeMarker(outcome: ImportMarker['outcome']): void {
  const instanceId = currentInstanceId()
  if (!instanceId) return
  const marker: ImportMarker = { instanceId, outcome, at: new Date().toISOString() }
  try {
    localStorage.setItem(MARKER_STORAGE_KEY, JSON.stringify(marker))
  } catch {
    // Storage is full or blocked: the user is simply asked again next time.
  }
}

function hasMarkerForThisInstance(): boolean {
  const instanceId = currentInstanceId()
  return instanceId !== null && readImportMarker()?.instanceId === instanceId
}

/** Repository keys of the v1 boards in this browser. */
export function v1BoardKeys(): string[] {
  return Object.keys(readBoards())
}

/** True while there are v1 boards and the user has not answered for this server instance. */
export function isV1ImportPending(): boolean {
  if (currentInstanceId() === null) return false
  return v1BoardKeys().length > 0 && !hasMarkerForThisInstance()
}

/** This browser's v1 board for `key`, whatever the marker says; null when absent or invalid. */
export function readStoredV1Board(key: string): BoardConfig | null {
  const board = readBoards()[key.toLowerCase()] ?? readBoards()[key]
  return isBoardConfig(board) ? board : null
}

/** The v1 board a new server board starts from: only while there is no marker for this instance. */
export function readV1Board(key: string): BoardConfig | null {
  if (currentInstanceId() === null || hasMarkerForThisInstance()) return null
  return readStoredV1Board(key)
}

/** The export file for the "Download my copy" action on a skipped board. */
export function v1BoardExport(key: string): BoardExport | null {
  const board = readStoredV1Board(key)
  return board ? toBoardExport(board, key) : null
}

/**
 * Posts every v1 board. The marker is written only after the server answers 200; on failure the
 * error is thrown and nothing is written, so the user is asked again next time.
 */
export async function importV1Boards(): Promise<ImportBoardsResponse> {
  const body: ImportBoardsRequest = { boards: readBoards() }
  const result = await apiRequest<ImportBoardsResponse>('boards/import', { method: 'POST', body })
  writeMarker('imported')
  return result
}

/** "Don't ask again" for this server instance. */
export function declineV1Import(): void {
  writeMarker('declined')
}
