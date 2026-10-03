import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'
import { isJsonPath } from './http/paths.ts'
import type { AppEnv } from './http/types.ts'

/** The built app, found relative to this file so the working directory does not matter. */
export function defaultDistDir(): string {
  return fileURLToPath(new URL('../dist', import.meta.url))
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Serves the built app from `distDir`: files as they are (hashed files under
 * /assets cached for a year), and index.html for any other GET or HEAD outside
 * the JSON paths (/api, /mcp and the OAuth discovery paths) so the browser app can open any URL. Register it after every API route.
 */
export function registerStatic(app: Hono<AppEnv>, distDir: string): void {
  const files = serveStatic({ root: distDir })
  const isRead = (method: string) => method === 'GET' || method === 'HEAD'

  app.use('/*', async (c, next) => {
    await next()
    if (isRead(c.req.method) && !isJsonPath(c.req.path) && (c.res.status === 200 || c.res.status === 206)) {
      // The index.html fallback sets no-cache itself; a missing /assets file must not become immutable.
      if (!c.res.headers.has('Cache-Control')) {
        c.header('Cache-Control', c.req.path.startsWith('/assets/') ? IMMUTABLE : 'no-cache')
      }
    }
  })
  app.use('/*', (c, next) => (isRead(c.req.method) && !isJsonPath(c.req.path) ? files(c, next) : next()))

  app.get('*', async (c) => {
    if (isJsonPath(c.req.path)) return c.notFound()
    let html: string
    try {
      html = await readFile(`${distDir}/index.html`, 'utf8')
    } catch {
      return c.text('The app is not built. Run npm run build.', 503)
    }
    c.header('Cache-Control', 'no-cache')
    return c.html(html)
  })
}
