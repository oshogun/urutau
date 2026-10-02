import type { BoardDeletedEvent, BoardUpdatedEvent } from '../../src/domain/api.ts'

export type BoardEvent = { type: 'board-updated'; data: BoardUpdatedEvent } | { type: 'board-deleted'; data: BoardDeletedEvent }

/** One open event stream. `send` must not throw for a closed stream; `close` ends it. */
export interface Subscriber {
  send(event: BoardEvent): void
  close(): void
}

export interface EventHub {
  /** Seconds between heartbeats on an open stream; settable so tests do not wait 25 s. */
  pingMs: number
  /** Sends the event to every stream open on its repository. Synchronous; call it after the write committed. */
  publish(event: BoardEvent): void
  /** Registers a stream for a repository, tagged with the session that opened it. Returns the function that removes it. */
  subscribe(repoKey: string, sessionIdHash: string, subscriber: Subscriber): () => void
  /** Ends every stream the session opened (sign-out, user removal). */
  closeSession(sessionIdHash: string): void
  /** Ends every stream (shutdown). */
  closeAll(): void
  /** Open streams, for tests. */
  size(): number
}

interface Entry {
  sessionIdHash: string
  subscriber: Subscriber
}

/** In-memory fan-out for one server process: streams are grouped by repository key. */
export function createEventHub(options: { pingMs?: number } = {}): EventHub {
  const byRepo = new Map<string, Set<Entry>>()

  function remove(repoKey: string, entry: Entry): void {
    const entries = byRepo.get(repoKey)
    if (!entries) return
    entries.delete(entry)
    if (entries.size === 0) byRepo.delete(repoKey)
  }

  function closeWhere(matches: (entry: Entry) => boolean): void {
    for (const [repoKey, entries] of [...byRepo]) {
      for (const entry of [...entries]) {
        if (!matches(entry)) continue
        remove(repoKey, entry)
        try {
          entry.subscriber.close()
        } catch {
          // A stream that cannot be closed is already gone.
        }
      }
    }
  }

  return {
    pingMs: options.pingMs ?? 25_000,
    publish(event) {
      for (const entry of [...(byRepo.get(event.data.repoKey) ?? [])]) {
        try {
          entry.subscriber.send(event)
        } catch {
          // One failing stream must not stop delivery to the others.
        }
      }
    },
    subscribe(repoKey, sessionIdHash, subscriber) {
      const entry: Entry = { sessionIdHash, subscriber }
      const entries = byRepo.get(repoKey) ?? new Set<Entry>()
      entries.add(entry)
      byRepo.set(repoKey, entries)
      return () => remove(repoKey, entry)
    },
    closeSession: (sessionIdHash) => closeWhere((entry) => entry.sessionIdHash === sessionIdHash),
    closeAll: () => closeWhere(() => true),
    size: () => [...byRepo.values()].reduce((total, entries) => total + entries.size, 0),
  }
}
