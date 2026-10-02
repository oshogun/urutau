import { Hono } from 'hono'
import type {
  AcceptInviteRequest,
  CreateInviteResponse,
  InviteCheckResponse,
  InviteListResponse,
  InviteSummary,
} from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { hashPassword, validatePassword, validateUsername } from '../auth/password.ts'
import { requireAdmin, startSession } from '../auth/sessions.ts'
import { randomToken, sha256Hex } from '../auth/tokens.ts'
import { isUniqueViolation } from '../db/index.ts'
import { createInvite, deleteInvite, getUsableInvite, listUsableInvites, markInviteUsed, type InviteRow } from '../db/invites.ts'
import { createAccount, listUsers } from '../db/users.ts'
import { isRecord, readJson, readOptionalJson } from '../http/body.ts'
import { HttpError, invalidRequest } from '../http/errors.ts'
import { clientIp } from '../http/ip.ts'
import type { AppEnv } from '../http/types.ts'
import { guardAttempts, parseCredentials } from './auth.ts'

const DEFAULT_HOURS = 168
const HOUR_MS = 60 * 60 * 1000

const inviteInvalid = () => new HttpError(404, 'invite-invalid', 'This invite link is not valid.')

/** Thrown inside the accept transaction when the invite was used or expired meanwhile, so the new account rolls back. */
class InviteUnusable extends Error {}

function tokenOf(body: unknown): string {
  if (!isRecord(body) || typeof body.token !== 'string' || body.token.length === 0 || body.token.length > 200) {
    throw invalidRequest('An invite token is required.')
  }
  return body.token
}

export function invitesRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()
  const db = ctx.database.db

  function summary(row: InviteRow, names: Map<string, string>): InviteSummary {
    const creator = row.created_by === null ? undefined : names.get(row.created_by)
    return {
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      createdBy: row.created_by !== null && creator !== undefined ? { id: row.created_by, username: creator } : null,
    }
  }

  async function usernames(): Promise<Map<string, string>> {
    return new Map((await listUsers(db)).map((user) => [user.id, user.username]))
  }

  routes.get('/invites', requireAdmin, async (c) => {
    const names = await usernames()
    const body: InviteListResponse = { invites: (await listUsableInvites(db, ctx.now())).map((row) => summary(row, names)) }
    return c.json(body)
  })

  routes.post('/invites', requireAdmin, async (c) => {
    const body = await readOptionalJson(c)
    const requested = isRecord(body) ? body.expiresInHours : undefined
    if (requested !== undefined && (!Number.isInteger(requested) || (requested as number) < 1 || (requested as number) > 720)) {
      throw invalidRequest('expiresInHours must be a whole number from 1 to 720.')
    }
    const hours = (requested as number | undefined) ?? DEFAULT_HOURS
    const token = randomToken()
    const now = ctx.now()
    const admin = c.get('auth')!.user
    const row = await createInvite(db, {
      tokenHash: sha256Hex(token),
      createdBy: admin.id,
      now,
      expiresAt: new Date(now.getTime() + hours * HOUR_MS),
    })
    const response: CreateInviteResponse = { invite: summary(row, new Map([[admin.id, admin.username]])), token }
    return c.json(response, 201)
  })

  routes.delete('/invites/:id', requireAdmin, async (c) => {
    if (!(await deleteInviteIfUnused(c.req.param('id')))) throw new HttpError(404, 'not-found', 'There is no pending invite with this id.')
    return c.body(null, 204)
  })

  async function deleteInviteIfUnused(id: string): Promise<boolean> {
    const usable = (await listUsableInvites(db, ctx.now())).some((invite) => invite.id === id)
    return usable && deleteInvite(db, id)
  }

  routes.post('/invites/check', async (c) => {
    const ip = clientIp(c, ctx.config.trustProxy)
    guardAttempts(ctx, ip)
    const token = tokenOf(await readJson(c))
    const invite = await getUsableInvite(db, sha256Hex(token), ctx.now())
    if (!invite) {
      ctx.limits.recordFailure(ip)
      throw inviteInvalid()
    }
    const body: InviteCheckResponse = { expiresAt: invite.expires_at }
    return c.json(body)
  })

  routes.post('/invites/accept', async (c) => {
    const ip = clientIp(c, ctx.config.trustProxy)
    guardAttempts(ctx, ip)
    const raw = await readJson(c)
    const request: AcceptInviteRequest = { ...parseCredentials(raw), token: tokenOf(raw) }
    validateUsername(request.username)
    validatePassword(request.password)
    const tokenHash = sha256Hex(request.token)
    if (!(await getUsableInvite(db, tokenHash, ctx.now()))) {
      ctx.limits.recordFailure(ip)
      throw inviteInvalid()
    }
    const passwordHash = await hashPassword(request.password)
    let user
    try {
      user = await db.transaction().execute(async (trx) => {
        const now = ctx.now()
        const result = await createAccount(trx, { username: request.username, displayName: null, passwordHash, now })
        if (!result.created) throw new InviteUnusable()
        if (!(await markInviteUsed(trx, tokenHash, result.user.id, now))) throw new InviteUnusable()
        return result.user
      })
    } catch (error) {
      if (error instanceof InviteUnusable) {
        ctx.limits.recordFailure(ip)
        throw inviteInvalid()
      }
      if (isUniqueViolation(error)) throw new HttpError(409, 'username-taken', 'That username is already taken.')
      throw error
    }
    return c.json(await startSession(ctx, c, user, 'local'), 201)
  })

  return routes
}
