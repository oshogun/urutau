import type { SessionRow } from '../db/sessions.ts'
import type { UserRow } from '../db/users.ts'

export interface AuthContext {
  user: UserRow
  session: SessionRow
}

/** Hono environment shared by every route: `auth` is null for a request without a valid session. */
export interface AppEnv {
  Variables: {
    auth: AuthContext | null
  }
}
