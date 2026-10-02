import type { MiddlewareHandler } from 'hono'
import type { Logger } from '../log.ts'
import type { AppEnv } from './types.ts'

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Frame-Options', 'DENY')
  }
}

/** One log line per request: method, path without the query string, status, duration and user id. Nothing else about the request. */
export function requestLog(log: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now()
    try {
      await next()
    } finally {
      log.info('request', {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
        user: c.get('auth')?.user.id ?? null,
      })
    }
  }
}
