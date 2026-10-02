import { Hono } from 'hono'
import type { UserListResponse } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { requireAdmin } from '../auth/sessions.ts'
import { deleteUser, getUserById, listUsers } from '../db/users.ts'
import { HttpError } from '../http/errors.ts'
import type { AppEnv } from '../http/types.ts'

export function usersRoutes(ctx: AppContext) {
  const routes = new Hono<AppEnv>()
  const db = ctx.database.db

  routes.get('/users', requireAdmin, async (c) => {
    const body: UserListResponse = {
      users: (await listUsers(db)).map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        isAdmin: user.is_admin === 1,
        authMethod: user.password_hash === null ? 'keycloak' : 'local',
        createdAt: user.created_at,
      })),
    }
    return c.json(body)
  })

  routes.delete('/users/:id', requireAdmin, async (c) => {
    const user = await getUserById(db, c.req.param('id'))
    if (!user) throw new HttpError(404, 'not-found', 'There is no user with this id.')
    if (user.is_admin === 1) throw new HttpError(409, 'cannot-remove-admin', 'The admin account cannot be removed.')
    await deleteUser(db, user.id)
    return c.body(null, 204)
  })

  return routes
}
