import type { MiddlewareHandler } from 'hono'
import { CSRF_HEADER } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { HttpError } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'
import { safeEqual } from './tokens.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function rejected(): HttpError {
  return new HttpError(403, 'csrf-rejected', 'The request was refused: it did not come from this app.')
}

/** Whether an Origin header names this app: the configured public origin, or else the request's own host. */
export function originAllowed(config: { publicUrl: string | null }, origin: string, host: string): boolean {
  if (config.publicUrl !== null) return origin === new URL(config.publicUrl).origin
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Cross-site protection for POST, PUT, PATCH and DELETE: the Origin (or
 * Sec-Fetch-Site) must be this app, and the CSRF header must carry the
 * session's token, or any non-empty value when there is no session yet.
 */
export function csrfGuard(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next()
    const origin = c.req.header('origin')
    if (origin !== undefined) {
      const host = c.req.header('host') ?? new URL(c.req.url).host
      if (!originAllowed(ctx.config, origin, host)) throw rejected()
    } else {
      const site = c.req.header('sec-fetch-site')
      if (site !== undefined && site !== 'same-origin') throw rejected()
    }
    const token = c.req.header(CSRF_HEADER)
    if (!token) throw rejected()
    const auth = c.get('auth')
    if (auth && !safeEqual(token, auth.session.csrf_token)) throw rejected()
    await next()
  }
}
