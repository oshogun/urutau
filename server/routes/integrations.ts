import { Hono } from 'hono'
import {
  INTEGRATION_PERMISSIONS,
  type ApiTokenSummary,
  type CreateApiTokenResponse,
  type CreateIntegrationResponse,
  type GitHubTokenStatus,
  type IntegrationListResponse,
  type IntegrationPermission,
  type IntegrationPermissions,
  type IntegrationSummary,
  type SetGitHubTokenResponse,
  type SetIntegrationReposResponse,
  type UpdateIntegrationResponse,
} from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { newBearerToken } from '../auth/bearer.ts'
import { validateUsername } from '../auth/password.ts'
import type { SecretSealer } from '../auth/secretBox.ts'
import { requireAdmin } from '../auth/sessions.ts'
import { repoKeyOf } from '../boards/validate.ts'
import { createApiToken, deleteApiToken, listApiTokens, type ApiTokenRow } from '../db/apiTokens.ts'
import { deleteGithubToken, listGithubTokenInfo, putGithubToken, type GithubTokenInfo } from '../db/githubTokens.ts'
import { isUniqueViolation } from '../db/index.ts'
import { listAllIntegrationRepos, listIntegrationRepos, setIntegrationRepos } from '../db/integrationRepos.ts'
import {
  createIntegration,
  deleteIntegration,
  isIntegration,
  listIntegrations,
  setIntegrationPermissions,
  type IntegrationRow,
} from '../db/integrations.ts'
import { checkGitHubToken } from '../github/tokenFormats.ts'
import { isRecord, readJson } from '../http/body.ts'
import { HttpError, invalidRequest } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_REPOS = 200
const MAX_GITHUB_TOKEN_LENGTH = 300
const SERVER_ERROR_TEXT = 'Something went wrong on the server.'

const notAnIntegration = () => new HttpError(404, 'not-found', 'There is no agent integration with this id.')

function tokenSummary(row: ApiTokenRow): ApiTokenSummary {
  return { id: row.id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at }
}

function githubTokenStatus(info: GithubTokenInfo | undefined, sealer: SecretSealer | null): GitHubTokenStatus {
  if (!info) return { set: false, readable: false, status: null, updatedAt: null }
  return { set: true, readable: sealer !== null && sealer.recognizesKeyId(info.key_id), status: info.status, updatedAt: info.updated_at }
}

function permissionsOf(row: IntegrationRow): IntegrationPermissions {
  return { moveCards: row.move_cards === 1 }
}

function isPermission(key: string): key is IntegrationPermission {
  return (INTEGRATION_PERMISSIONS as readonly string[]).includes(key)
}

/** Reads a `permissions` object: known keys only, each a boolean; at least one when `nonEmpty`. */
function readPermissions(input: unknown, nonEmpty: boolean): Partial<IntegrationPermissions> {
  if (!isRecord(input) || (nonEmpty && Object.keys(input).length === 0)) {
    throw invalidRequest('permissions must be a JSON object with a permission to set.')
  }
  const permissions: Partial<IntegrationPermissions> = {}
  for (const [key, on] of Object.entries(input)) {
    if (!isPermission(key)) throw invalidRequest(`Unknown permission: ${key}.`)
    if (typeof on !== 'boolean') throw invalidRequest(`permissions.${key} must be true or false.`)
    permissions[key] = on
  }
  return permissions
}

export function integrationsRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()
  const db = ctx.database.db
  const { mcp } = ctx

  /** Runs the route body; a database error becomes a 500 whose log line carries the error name only. */
  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof HttpError) throw error
      ctx.log.error('integration request failed', { name: error instanceof Error ? error.name : 'Error' })
      throw new HttpError(500, 'server-error', SERVER_ERROR_TEXT)
    }
  }

  async function requireIntegration(id: string): Promise<void> {
    if (!(await isIntegration(db, id))) throw notAnIntegration()
  }

  /** The one place an IntegrationSummary is built; `tokens` are this integration's live tokens. */
  function summary(row: IntegrationRow, tokens: ApiTokenRow[], githubToken: GithubTokenInfo | undefined, repos: string[]): IntegrationSummary {
    return {
      id: row.id,
      username: row.username,
      createdAt: row.created_at,
      createdBy: row.created_by !== null && row.created_by_username !== null ? { id: row.created_by, username: row.created_by_username } : null,
      tokens: tokens.map(tokenSummary),
      githubToken: githubTokenStatus(githubToken, ctx.githubTokenSealer),
      repos,
      permissions: permissionsOf(row),
    }
  }

  async function findIntegration(id: string): Promise<IntegrationRow> {
    const row = (await listIntegrations(db)).find((entry) => entry.id === id)
    if (!row) throw notAnIntegration()
    return row
  }

  routes.get('/integrations', requireAdmin, (c) =>
    guarded(async () => {
      const now = ctx.now()
      const [rows, tokens, githubTokens, repos] = await Promise.all([
        listIntegrations(db),
        listApiTokens(db, null, now),
        listGithubTokenInfo(db),
        listAllIntegrationRepos(db),
      ])
      const integrations: IntegrationSummary[] = rows.map((row) =>
        summary(
          row,
          tokens.filter((token) => token.user_id === row.id),
          githubTokens.get(row.id),
          repos.get(row.id) ?? [],
        ),
      )
      const body: IntegrationListResponse = { integrations, githubTokenStorage: ctx.githubTokenSealer !== null }
      return c.json(body)
    }),
  )

  routes.post('/integrations', requireAdmin, (c) =>
    guarded(async () => {
      const body = await readJson(c)
      if (!isRecord(body) || typeof body.username !== 'string') throw invalidRequest('A username is required.')
      validateUsername(body.username)
      const permissions = body.permissions === undefined ? {} : readPermissions(body.permissions, false)
      const admin = c.get('auth')!.user
      const now = ctx.now()
      let user
      try {
        user = await createIntegration(db, { username: body.username, createdBy: admin.id, now, moveCards: permissions.moveCards ?? true })
      } catch (error) {
        if (isUniqueViolation(error)) throw new HttpError(409, 'username-taken', 'That username is already taken.')
        throw error
      }
      ctx.log.info('integration created', { integration: user.id, user: admin.id })
      const row: IntegrationRow = {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
        created_by: admin.id,
        created_by_username: admin.username,
        move_cards: (permissions.moveCards ?? true) ? 1 : 0,
      }
      const response: CreateIntegrationResponse = { integration: summary(row, [], undefined, []) }
      return c.json(response, 201)
    }),
  )

  routes.patch('/integrations/:id', requireAdmin, (c) =>
    guarded(async () => {
      const id = c.req.param('id')
      const before = await findIntegration(id)
      const body = await readJson(c)
      if (!isRecord(body) || Object.keys(body).some((key) => key !== 'permissions')) {
        throw invalidRequest('The body must be a JSON object with only permissions.')
      }
      const permissions = readPermissions(body.permissions, true)
      if (!(await setIntegrationPermissions(db, id, permissions))) throw notAnIntegration()
      const previous = permissionsOf(before)
      // Calls that passed the permission check before the change stop at their next wait or before they save.
      if (INTEGRATION_PERMISSIONS.some((key) => previous[key] && permissions[key] === false)) mcp.inflight.abortIntegration(id)
      const user = c.get('auth')!.user.id
      ctx.log.info('integration permissions changed', { integration: id, user, ...permissions })
      const now = ctx.now()
      const [row, tokens, githubTokens, repos] = await Promise.all([
        findIntegration(id),
        listApiTokens(db, id, now),
        listGithubTokenInfo(db),
        listIntegrationRepos(db, id),
      ])
      const response: UpdateIntegrationResponse = { integration: summary(row, tokens, githubTokens.get(id), repos) }
      return c.json(response)
    }),
  )

  routes.delete('/integrations/:id', requireAdmin, (c) =>
    guarded(async () => {
      const id = c.req.param('id')
      if (!(await deleteIntegration(db, id))) throw notAnIntegration()
      mcp.inflight.abortIntegration(id)
      mcp.snapshots.invalidate(id)
      mcp.reader.forget(id)
      mcp.limits.forget(id)
      ctx.log.info('integration removed', { integration: id, user: c.get('auth')!.user.id })
      return c.body(null, 204)
    }),
  )

  routes.post('/integrations/:id/tokens', requireAdmin, (c) =>
    guarded(async () => {
      const id = c.req.param('id')
      await requireIntegration(id)
      const body = await readJson(c)
      const label = isRecord(body) && typeof body.label === 'string' ? body.label.trim() : ''
      if (label.length < 1 || label.length > 64) throw invalidRequest('label must be 1 to 64 characters.')
      const days = isRecord(body) ? body.expiresInDays : undefined
      if (days !== null && days !== 30 && days !== 90 && days !== 365) throw invalidRequest('expiresInDays must be 30, 90, 365 or null.')
      const now = ctx.now()
      const expiresAt = days === null ? null : new Date(now.getTime() + days * DAY_MS)
      const admin = c.get('auth')!.user
      // A second attempt covers the practically impossible case of a hash that already exists.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { secret, hash } = newBearerToken()
        let row
        try {
          row = await createApiToken(db, { userId: id, tokenHash: hash, label, createdBy: admin.id, now, expiresAt })
        } catch (error) {
          if (isUniqueViolation(error)) continue
          throw error
        }
        ctx.log.info('api token created', {
          integration: id,
          tokenId: row.id,
          expiresAt: row.expires_at,
          user: admin.id,
        })
        const response: CreateApiTokenResponse = { token: tokenSummary(row), secret }
        return c.json(response, 201)
      }
      throw new HttpError(500, 'server-error', SERVER_ERROR_TEXT)
    }),
  )

  routes.delete('/integrations/:id/tokens/:tokenId', requireAdmin, (c) =>
    guarded(async () => {
      const id = c.req.param('id')
      const tokenId = c.req.param('tokenId')
      await requireIntegration(id)
      if (!(await deleteApiToken(db, id, tokenId))) throw new HttpError(404, 'not-found', 'There is no such token for this integration.')
      mcp.inflight.abortToken(tokenId)
      ctx.log.info('api token revoked', { integration: id, tokenId, user: c.get('auth')!.user.id })
      return c.body(null, 204)
    }),
  )

  routes.put('/integrations/:id/github-token', requireAdmin, (c) =>
    guarded(async () => {
      const id = c.req.param('id')
      await requireIntegration(id)
      const body = await readJson(c)
      if (!isRecord(body) || typeof body.token !== 'string' || body.token.length > MAX_GITHUB_TOKEN_LENGTH) {
        throw invalidRequest('token must be text of at most 300 characters.')
      }
      const sealer = ctx.githubTokenSealer
      if (sealer === null) {
        throw new HttpError(409, 'encryption-key-missing', 'The server has no TOKEN_ENCRYPTION_KEY, so it cannot store a GitHub token.')
      }
      const token = body.token.trim()
      const check = checkGitHubToken(token)
      if (!check.ok) {
        throw check.code === 'not-a-github-token'
          ? new HttpError(400, 'not-a-github-token', 'This is an Urutau MCP token, not a GitHub token.')
          : new HttpError(400, 'unsupported-token-format', 'Use a fine-grained token (github_pat_…) or a classic token (ghp_…).')
      }
      const admin = c.get('auth')!.user
      const now = ctx.now()
      await putGithubToken(db, { userId: id, sealed: sealer.seal(token, id), keyId: sealer.keyId, setBy: admin.id, now })
      mcp.snapshots.invalidate(id)
      mcp.reader.forget(id)
      ctx.log.info('github token set', { integration: id, user: admin.id })
      const response: SetGitHubTokenResponse = {
        githubToken: { set: true, readable: true, status: 'unchecked', updatedAt: now.toISOString() },
      }
      return c.json(response)
    }),
  )

  routes.delete('/integrations/:id/github-token', requireAdmin, (c) =>
    guarded(async () => {
      const id = c.req.param('id')
      await requireIntegration(id)
      await deleteGithubToken(db, id)
      mcp.snapshots.invalidate(id)
      mcp.reader.forget(id)
      ctx.log.info('github token cleared', { integration: id, user: c.get('auth')!.user.id })
      return c.body(null, 204)
    }),
  )

  routes.put('/integrations/:id/repos', requireAdmin, (c) =>
    guarded(async () => {
      const id = c.req.param('id')
      await requireIntegration(id)
      const body = await readJson(c)
      const list = isRecord(body) ? body.repos : undefined
      if (!Array.isArray(list) || list.length > MAX_REPOS || !list.every((entry) => typeof entry === 'string')) {
        throw invalidRequest('repos must be a list of at most 200 repositories.')
      }
      const keys = new Set<string>()
      for (const [index, entry] of (list as string[]).entries()) {
        const key = repoKeyOf(entry.trim())
        if (key === null) throw invalidRequest(`Entry ${index + 1} is not a repository as owner/name.`)
        keys.add(key)
      }
      const sorted = [...keys].sort()
      const removed = await setIntegrationRepos(db, id, sorted)
      // Calls that passed the repository check before the change stop at their next wait or before they save.
      if (removed.length > 0) mcp.inflight.abortIntegration(id)
      ctx.log.info('integration repos changed', { integration: id, count: sorted.length, user: c.get('auth')!.user.id })
      const response: SetIntegrationReposResponse = { repos: await listIntegrationRepos(db, id) }
      return c.json(response)
    }),
  )

  return routes
}
