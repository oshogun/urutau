import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/** The socket address, or with `trustProxy` the last X-Forwarded-For entry (the one the nearest proxy appended). */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')
    const last = forwarded?.split(',').at(-1)?.trim()
    if (last) return last
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    // No socket behind the request (tests call the app directly).
    return 'unknown'
  }
}
