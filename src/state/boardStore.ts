import { create } from 'zustand'
import { ApiError, CLIENT_ID, apiRequest } from '../api/client'
import { CLIENT_ID_HEADER } from '../domain/api'
import type { SaveBoardRequest, StaleBoardResponse, StoredBoard } from '../domain/api'
import type { BoardConfig } from '../domain/types'
import { onSessionChange } from './session'

export interface ConflictNotice {
  /** 'stale': a user change was refused; 'deleted': the board was deleted by someone else. */
  kind: 'stale' | 'deleted'
  /** Who made the version now shown, when known. */
  by: string | null
}

export interface BoardEntry {
  status: 'loading' | 'missing' | 'ready' | 'error'
  /** Last state confirmed by the server. */
  stored: StoredBoard | null
  /** What the board shows: `stored.board` plus edits not yet confirmed. */
  board: BoardConfig | null
  /** A save request is on the wire. */
  saving: boolean
  /** `board` has edits that no request carries yet. */
  dirty: boolean
  conflict: ConflictNotice | null
  /** Last non-409 save failure, shown with a Retry action; null when none. */
  saveError: string | null
  loadError: string | null
}

export interface BoardsState {
  entries: Record<string, BoardEntry>
  load(repoKey: string): Promise<void>
  /** First open: PUT with baseVersion null; a 409 adopts the server's board without a notice. */
  create(repoKey: string, fullName: string, board: BoardConfig): Promise<void>
  /** Optimistic edit; saves follow the queue: one request in flight, the latest edit queued. */
  update(repoKey: string, fullName: string, recipe: (current: BoardConfig) => BoardConfig): void
  retrySave(repoKey: string): void
  /** Called by the live-updates hook for a newer version from another tab. */
  reloadIfIdle(repoKey: string): Promise<void>
  dismissConflict(repoKey: string): void
}

const EMPTY_ENTRY: BoardEntry = {
  status: 'loading',
  stored: null,
  board: null,
  saving: false,
  dirty: false,
  conflict: null,
  saveError: null,
  loadError: null,
}

type BoardListListener = () => void
const boardListListeners = new Set<BoardListListener>()

/** Runs after a board is created on the server, so the board list can refetch. */
export function onBoardListChange(listener: BoardListListener): () => void {
  boardListListeners.add(listener)
  return () => boardListListeners.delete(listener)
}

/** Bumped whenever the session changes, so answers to requests from the old session are dropped. */
let epoch = 0
/** The `owner/name` spelling for each key, for saves that start without the caller's help (retry). */
const fullNames = new Map<string, string>()
/** The board each key's first save started from; a 409 on it is adopted silently only if unedited. */
const createdBoards = new Map<string, BoardConfig>()

const boardPath = (repoKey: string) => `boards/${repoKey.split('/').map(encodeURIComponent).join('/')}`

function staleCurrent(error: ApiError): StoredBoard | null {
  const body = error.body as Partial<StaleBoardResponse> | null
  return body?.current ?? null
}

export const useBoards = create<BoardsState>()((set, get) => {
  const patch = (key: string, changes: Partial<BoardEntry>) =>
    set((state) => ({
      entries: { ...state.entries, [key]: { ...(state.entries[key] ?? EMPTY_ENTRY), ...changes } },
    }))

  const adopt = (key: string, current: StoredBoard | null, conflict: ConflictNotice | null) => {
    patch(key, {
      status: current ? 'ready' : 'missing',
      stored: current,
      board: current?.board ?? null,
      dirty: false,
      saving: false,
      saveError: null,
      conflict,
    })
  }

  async function send(key: string): Promise<void> {
    const entry = get().entries[key]
    if (!entry?.board) return
    const fullName = fullNames.get(key) ?? entry.stored?.fullName ?? key
    const request: SaveBoardRequest = {
      baseVersion: entry.stored?.version ?? null,
      fullName,
      board: entry.board,
    }
    const startedIn = epoch
    patch(key, { saving: true, dirty: false, saveError: null })

    try {
      const saved = await apiRequest<StoredBoard>(boardPath(key), {
        method: 'PUT',
        body: request,
        headers: { [CLIENT_ID_HEADER]: CLIENT_ID },
      })
      if (epoch !== startedIn) return
      patch(key, { stored: saved, saving: false, status: 'ready' })
      if (request.baseVersion === null) boardListListeners.forEach((listener) => listener())
      if (get().entries[key]?.dirty) void send(key)
    } catch (error) {
      if (epoch !== startedIn) return
      if (error instanceof ApiError && error.status === 409 && error.code === 'stale-board') {
        const current = staleCurrent(error)
        const by = current?.updatedBy?.username ?? null
        const unedited =
          request.baseVersion === null &&
          request.board === createdBoards.get(key) &&
          !get().entries[key]?.dirty
        adopt(key, current, unedited && current ? null : { kind: current ? 'stale' : 'deleted', by })
        return
      }
      patch(key, {
        saving: false,
        dirty: true,
        saveError: error instanceof Error ? error.message : 'The board could not be saved.',
      })
    }
  }

  async function fetchStored(key: string): Promise<StoredBoard | null> {
    try {
      return await apiRequest<StoredBoard>(boardPath(key))
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  }

  return {
    entries: {},

    async load(key) {
      const startedIn = epoch
      const existing = get().entries[key]
      if (!existing) patch(key, { status: 'loading' })
      try {
        const stored = await fetchStored(key)
        if (epoch !== startedIn) return
        const entry = get().entries[key]
        if (entry?.saving || entry?.dirty) return
        if (stored) {
          patch(key, { status: 'ready', stored, board: stored.board, loadError: null })
        } else {
          patch(key, { status: 'missing', stored: null, board: null, loadError: null })
        }
      } catch (error) {
        if (epoch !== startedIn) return
        const message = error instanceof Error ? error.message : 'The board could not be loaded.'
        if (get().entries[key]?.board) patch(key, { loadError: message })
        else patch(key, { status: 'error', loadError: message })
      }
    },

    async create(key, fullName, board) {
      fullNames.set(key, fullName)
      createdBoards.set(key, board)
      patch(key, { status: 'ready', stored: null, board, conflict: null })
      await send(key)
    },

    update(key, fullName, recipe) {
      const entry = get().entries[key]
      if (!entry?.board) return
      const next = recipe(entry.board)
      if (next === entry.board) return
      fullNames.set(key, fullName)
      patch(key, { board: next, dirty: true })
      if (!entry.saving) void send(key)
    },

    retrySave(key) {
      const entry = get().entries[key]
      if (!entry?.board || entry.saving) return
      void send(key)
    },

    async reloadIfIdle(key) {
      const startedIn = epoch
      const before = get().entries[key]
      if (!before || before.saving || before.dirty) return
      try {
        const stored = await fetchStored(key)
        if (epoch !== startedIn) return
        const entry = get().entries[key]
        if (!entry || entry.saving || entry.dirty) return
        if (stored) {
          if (stored.version === entry.stored?.version) return
          patch(key, { status: 'ready', stored, board: stored.board })
        } else if (entry.stored) {
          adopt(key, null, { kind: 'deleted', by: null })
        }
      } catch {
        // The next event or the next open of the board loads it again.
      }
    },

    dismissConflict(key) {
      if (get().entries[key]?.conflict) patch(key, { conflict: null })
    },
  }
})

onSessionChange(() => {
  epoch += 1
  fullNames.clear()
  createdBoards.clear()
  useBoards.setState({ entries: {} })
})
