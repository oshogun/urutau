import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { HelloEvent } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { sha256Hex } from '../auth/tokens.ts'
import { repoKeyOf } from '../boards/validate.ts'
import { getBoard } from '../db/boards.ts'
import { getSession } from '../db/sessions.ts'
import { invalidRequest } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'
import { SESSION_COOKIE } from '../auth/sessions.ts'
import { getCookie } from 'hono/cookie'
import type { BoardEvent } from '../events/publisher.ts'

export function eventsRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()
  const db = ctx.database.db

  routes.get('/events', (c) => {
    const raw = c.req.query('repo')
    const repoKey = raw === undefined ? null : repoKeyOf(raw.toLowerCase())
    if (repoKey === null) throw invalidRequest('The repo query parameter must be a repository as owner/name.')
    const idHash = sha256Hex(getCookie(c, SESSION_COOKIE) ?? '')

    const response = streamSSE(c, async (stream) => {
      let closed = false
      let wake: () => void = () => {}
      const stop = () => {
        closed = true
        wake()
      }
      // Events that arrive before hello is written wait here, so hello is always first.
      let pending: BoardEvent[] | null = []
      const write = (event: BoardEvent) => void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) }).catch(stop)

      const unsubscribe = ctx.hub.subscribe(repoKey, idHash, {
        send: (event) => (pending ? pending.push(event) : write(event)),
        close: stop,
      })
      stream.onAbort(() => {
        unsubscribe()
        stop()
      })

      try {
        const stored = await getBoard(db, repoKey)
        await stream.write('retry: 5000\n\n')
        const hello: HelloEvent = { repoKey, version: stored?.version ?? null }
        await stream.writeSSE({ event: 'hello', data: JSON.stringify(hello) })
        for (const event of pending) write(event)
        pending = null

        while (!closed && !stream.aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve
            setTimeout(resolve, ctx.hub.pingMs).unref()
          })
          if (closed || stream.aborted) break
          // Sign-out and user removal end the stream at once (closeSession); this catches a session that expired or was deleted another way.
          if (!(await getSession(db, idHash, ctx.now()))) break
          await stream.write(': ping\n\n')
        }
      } catch {
        // The client went away mid-write; the cleanup below is all that is left to do.
      } finally {
        unsubscribe()
      }
    })
    response.headers.set('Cache-Control', 'no-cache, no-transform')
    response.headers.set('X-Accel-Buffering', 'no')
    return response
  })

  return routes
}
