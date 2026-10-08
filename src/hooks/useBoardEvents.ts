import { useEffect, useState } from 'react'
import { apiRequest, CLIENT_ID } from '../api/client'
import { openBoardEvents } from '../api/events'
import type {
  BoardDeletedEvent,
  BoardUpdatedEvent,
  CardActivityEvent,
  EditorKind,
  HelloEvent,
  SessionResponse,
} from '../domain/api'
import { repoKey } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'
import { useActivity } from '../state/activityStore'
import { useBoards } from '../state/boardStore'
import { useSession } from '../state/session'

/** `live`: stream open. `reconnecting`: the browser is retrying by itself. `offline`: not connected (hidden tab, or waiting to reopen). */
export type BoardConnection = 'live' | 'reconnecting' | 'offline'

/** A change another user or tab made, applied to the board on screen. */
export interface RemoteChange {
  /** Username of whoever saved it, null when unknown. */
  by: string | null
  /** What kind of account saved it: the adopted board's, else the event's, else 'person'. */
  kind: EditorKind
  /** When the server stored it (ISO). */
  at: string
  version: number
}

export interface BoardEvents {
  connection: BoardConnection
  /** The latest remote change that replaced the board; null until one arrives. Show a toast when it changes. */
  lastRemoteChange: RemoteChange | null
}

const CLOSED = 2
const MAX_DELAY_MS = 30_000

/** Delay before reopening a closed stream: 1, 2, 4 ... 30 seconds. */
export function reopenDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_DELAY_MS)
}

function parse<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T
  } catch {
    return null
  }
}

/**
 * Keeps the open board in step with other users and tabs. The stream is open while `enabled` is
 * true (pass false until the board has loaded) and the document is visible, and closed otherwise
 * and on unmount. Mount it once on the board page.
 *
 * A `hello` (sent on every connection, so also after a reconnect) or a `board-updated` from
 * another client with a version other than the local one reloads the board, unless a save is in
 * flight or an edit is pending; that save then gets a 409 and the store reconciles it. A
 * `board-deleted` from another client marks the board missing with a 'deleted' conflict.
 *
 * A `hello` also loads the board's card activity again, which covers events missed while the
 * stream was closed. A `card-activity` from another client refreshes that one issue's activity;
 * it never reloads the board, because runs and claims do not change the board version.
 */
export function useBoardEvents(repo: RepoRef, enabled = true): BoardEvents {
  const key = repoKey(repo)
  const [connection, setConnection] = useState<BoardConnection>('offline')
  const [lastRemoteChange, setLastRemoteChange] = useState<{ key: string; change: RemoteChange } | null>(null)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const active = enabled && visible
  useEffect(() => {
    if (!active) return
    let stopped = false
    let source: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const known = () => {
      const entry = useBoards.getState().entries[key]
      return entry && entry.status !== 'loading' ? entry : null
    }

    const reconcile = async (version: number | null, remote: BoardUpdatedEvent | null) => {
      const entry = known()
      if (!entry || version === (entry.stored?.version ?? null)) return
      const adopted = await useBoards.getState().reloadIfIdle(key)
      if (stopped || !adopted || !remote) return
      setLastRemoteChange({
        key,
        change: {
          by: adopted.updatedBy?.username ?? remote.updatedBy?.username ?? null,
          kind: adopted.updatedBy?.kind ?? remote.updatedBy?.kind ?? 'person',
          at: adopted.updatedAt,
          version: adopted.version,
        },
      })
    }

    const reopen = async () => {
      setConnection('offline')
      try {
        const response = await apiRequest<SessionResponse>('session')
        if (stopped) return
        if (!response.signedIn) {
          useSession.getState().markSignedOut()
          return
        }
      } catch {
        if (stopped) return
      }
      timer = setTimeout(connect, reopenDelay(attempt))
      attempt += 1
    }

    const connect = () => {
      if (stopped) return
      const next = openBoardEvents(key)
      source = next
      setConnection('reconnecting')
      next.addEventListener('hello', (event) => {
        const hello = parse<HelloEvent>(event)
        attempt = 0
        setConnection('live')
        if (hello) void reconcile(hello.version, null)
        void useActivity.getState().load(key)
      })
      next.addEventListener('card-activity', (event) => {
        const activity = parse<CardActivityEvent>(event)
        if (!activity || activity.repoKey !== key || activity.clientId === CLIENT_ID) return
        useActivity.getState().refreshIssue(key, activity.issue).catch(() => {
          // The next event for the issue or the next hello fetches it again.
        })
      })
      next.addEventListener('board-updated', (event) => {
        const update = parse<BoardUpdatedEvent>(event)
        if (!update || update.repoKey !== key || update.clientId === CLIENT_ID) return
        void reconcile(update.version, update)
      })
      next.addEventListener('board-deleted', (event) => {
        const deleted = parse<BoardDeletedEvent>(event)
        if (!deleted || deleted.repoKey !== key || deleted.clientId === CLIENT_ID) return
        if (known()) useBoards.getState().applyRemoteDelete(key)
      })
      next.onerror = () => {
        if (stopped) return
        if (next.readyState === CLOSED) {
          next.close()
          void reopen()
        } else {
          setConnection('reconnecting')
        }
      }
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      source?.close()
      setConnection('offline')
    }
  }, [active, key])

  return {
    connection: active ? connection : 'offline',
    lastRemoteChange: lastRemoteChange?.key === key ? lastRemoteChange.change : null,
  }
}
