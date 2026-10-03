import { Hono } from 'hono'
import type { ServerSettings } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { requireAdmin } from '../auth/sessions.ts'
import { getGithubWrites, setGithubWrites } from '../db/settings.ts'
import { isRecord, readJson } from '../http/body.ts'
import { invalidRequest } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'

export function settingsRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()
  const db = ctx.database.db

  routes.get('/settings', async (c) => {
    const body: ServerSettings = { githubWrites: await getGithubWrites(db) }
    return c.json(body)
  })

  routes.patch('/settings', requireAdmin, async (c) => {
    const input = await readJson(c)
    if (!isRecord(input) || Object.keys(input).length === 0) throw invalidRequest('The body must be a JSON object with a setting to change.')
    if (Object.keys(input).some((key) => key !== 'githubWrites')) throw invalidRequest('Only githubWrites can be changed.')
    if (typeof input.githubWrites !== 'boolean') throw invalidRequest('githubWrites must be true or false.')
    await setGithubWrites(db, input.githubWrites)
    ctx.log.info('github writes changed', { on: input.githubWrites, user: c.get('auth')!.user.id })
    const body: ServerSettings = { githubWrites: await getGithubWrites(db) }
    return c.json(body)
  })

  return routes
}
