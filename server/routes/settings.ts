import { Hono } from 'hono'
import { GITHUB_WRITE_KINDS, type GithubWriteKind, type ServerSettings } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { requireAdmin } from '../auth/sessions.ts'
import { getGithubWrites, setGithubWrite } from '../db/settings.ts'
import { isRecord, readJson } from '../http/body.ts'
import { invalidRequest } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'

function isKind(key: string): key is GithubWriteKind {
  return (GITHUB_WRITE_KINDS as readonly string[]).includes(key)
}

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
    const writes = input.githubWrites
    if (!isRecord(writes) || Object.keys(writes).length === 0) {
      throw invalidRequest('githubWrites must be a JSON object with a kind of GitHub write to change.')
    }
    const changes: [GithubWriteKind, boolean][] = []
    for (const [kind, on] of Object.entries(writes)) {
      if (!isKind(kind)) throw invalidRequest(`Unknown kind of GitHub write: ${kind}.`)
      if (typeof on !== 'boolean') throw invalidRequest(`githubWrites.${kind} must be true or false.`)
      changes.push([kind, on])
    }
    const user = c.get('auth')!.user.id
    for (const [kind, on] of changes) {
      await setGithubWrite(db, kind, on)
      ctx.log.info('github writes changed', { kind, on, user })
    }
    const body: ServerSettings = { githubWrites: await getGithubWrites(db) }
    return c.json(body)
  })

  return routes
}
