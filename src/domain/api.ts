/**
 * The HTTP contract shared by the browser app and the server. Types and
 * constants only, and no value import from outside src/domain, because the
 * server imports this file directly under Node's type stripping. Relative
 * imports carry the `.ts` extension for the same reason.
 */
import type { BoardConfig } from './types.ts'

/** Header that carries the session's CSRF token on every POST, PUT, PATCH and DELETE. */
export const CSRF_HEADER = 'X-Urutau-CSRF'
/** Header with a random id per browser tab, echoed in board events so a tab can skip its own saves. */
export const CLIENT_ID_HEADER = 'X-Urutau-Client'

// ---------------------------------------------------------------- errors

export type ApiErrorCode =
  | 'invalid-request' // 400: body or parameters failed validation; `message` says which
  | 'password-too-long' // 400: password over 72 UTF-8 bytes (bcrypt ignores the rest)
  | 'signed-out' // 401: no session, or the session expired or was removed
  | 'invalid-credentials' // 401: wrong username or password on sign-in
  | 'host-not-allowed' // 403: the request is addressed to a host the server does not answer for
  | 'csrf-rejected' // 403: missing or wrong CSRF header, or a cross-site Origin
  | 'forbidden' // 403: signed in, but the route is for the admin only
  | 'not-found' // 404: unknown route, board, user or invite id
  | 'invite-invalid' // 404: invite token unknown, already used, revoked or expired
  | 'keycloak-disabled' // 404: a Keycloak route while Keycloak is not configured
  | 'github-path-not-allowed' // 404: GitHub proxy path or query outside the allow-list
  | 'already-set-up' // 409: first-run after the first account exists
  | 'username-taken' // 409
  | 'stale-board' // 409: the save's baseVersion is not the stored version (body: StaleBoardResponse)
  | 'cannot-remove-admin' // 409: removing the admin account
  | 'too-large' // 413
  | 'github-access' // 424: the server could not get a GitHub token from Keycloak (body: GitHubAccessError)
  | 'too-many-attempts' // 429: sign-in rate limit; Retry-After header in seconds
  | 'server-error' // 500
  | 'unavailable' // 503: database unreachable

/** Body of every non-2xx JSON response from /api. */
export interface ApiErrorBody {
  error: ApiErrorCode
  /** One sentence for people; never contains a token, hash, password or URL with credentials. */
  message: string
}

// ---------------------------------------------------------------- session and config

export type AuthMethod = 'local' | 'keycloak'

export interface SessionUser {
  id: string
  /** As chosen at sign-up, or derived from Keycloak's preferred_username. Unique ignoring case. */
  username: string
  /** Keycloak `name` claim; null for local accounts. */
  displayName: string | null
  isAdmin: boolean
  authMethod: AuthMethod
}

/** Why a Keycloak user's GitHub reads cannot go through the server right now. */
export type GitHubAccessProblem =
  | 'signin-expired' // no Keycloak tokens in server memory (server restarted, or refresh failed)
  | 'not-linked' // the Keycloak account has no linked GitHub identity, or no token stored for it
  | 'refused' // Keycloak refused: no broker read-token role, Store tokens off, or V2 client not allowed

export type GitHubAccess =
  /** The browser calls api.github.com itself, anonymously or with the token pasted in Settings. */
  | { mode: 'browser'; problem: GitHubAccessProblem | null }
  /** The browser calls /api/github/…; the server attaches the Keycloak-brokered token. */
  | { mode: 'server' }

export interface Session {
  user: SessionUser
  /** Send as the CSRF_HEADER value on every state-changing request. */
  csrfToken: string
  githubAccess: GitHubAccess
}

/** GET /api/session (public). */
export type SessionResponse =
  | { signedIn: false; /** True until the first account exists. */ firstRun: boolean }
  | { signedIn: true; session: Session }

/** GET /api/config (public). */
export interface AppConfigResponse {
  keycloak: { enabled: boolean }
  /** Random id created by the first database migration; changes only when the database is replaced. */
  instanceId: string
}

/** POST /api/auth/first-run and POST /api/auth/sign-in. */
export interface CredentialsRequest {
  username: string
  password: string
}

/** POST /api/auth/sign-out. */
export interface SignOutResponse {
  /** Keycloak end-session URL the browser should open next; null for local sessions. */
  redirectTo: string | null
}

// ---------------------------------------------------------------- boards

export interface BoardAuthor {
  id: string
  username: string
}

/** One entry of the server-wide board list (GET /api/boards). */
export interface BoardSummary {
  /** `owner/name` in lower case; the primary key. */
  repoKey: string
  /** `owner/name` as GitHub spells it; equals repoKey for boards imported from v1 data until the next save. */
  fullName: string
  version: number
  updatedAt: string
  /** null when the user was removed. */
  updatedBy: BoardAuthor | null
}

/** GET/PUT /api/boards/:owner/:name. */
export interface StoredBoard extends BoardSummary {
  board: BoardConfig
}

/** PUT /api/boards/:owner/:name. */
export interface SaveBoardRequest {
  /** The version this edit started from; null creates the board and fails if it exists. */
  baseVersion: number | null
  fullName: string
  board: BoardConfig
}

/** Body of a 409 `stale-board`. */
export interface StaleBoardResponse extends ApiErrorBody {
  error: 'stale-board'
  /** The stored board now; null when the board no longer exists. */
  current: StoredBoard | null
}

export interface BoardListResponse {
  boards: BoardSummary[]
}

/** POST /api/boards/import: the `state.boards` object of a version-1 `urutau:boards` value. */
export interface ImportBoardsRequest {
  boards: Record<string, unknown>
}

export interface ImportBoardsResponse {
  /** Keys stored as new boards (version 1). */
  imported: string[]
  /** Keys the server already had; left unchanged. */
  skipped: string[]
  /** Keys that are not repository keys or whose value is not a BoardConfig; nothing stored. */
  invalid: string[]
}

// ---------------------------------------------------------------- users and invites (admin)

export interface UserSummary {
  id: string
  username: string
  displayName: string | null
  isAdmin: boolean
  authMethod: AuthMethod
  createdAt: string
}

export interface UserListResponse {
  users: UserSummary[]
}

export interface InviteSummary {
  id: string
  createdAt: string
  expiresAt: string
  createdBy: BoardAuthor | null
}

export interface InviteListResponse {
  invites: InviteSummary[]
}

/** POST /api/invites. */
export interface CreateInviteRequest {
  /** 1–720; default 168 (7 days). */
  expiresInHours?: number
}

export interface CreateInviteResponse {
  invite: InviteSummary
  /** Shown once; the server keeps only its SHA-256. The client builds `<app URL>#invite=<token>`. */
  token: string
}

/** POST /api/invites/check (public). */
export interface InviteCheckRequest {
  token: string
}

export interface InviteCheckResponse {
  expiresAt: string
}

/** POST /api/invites/accept (public). */
export interface AcceptInviteRequest extends CredentialsRequest {
  token: string
}

// ---------------------------------------------------------------- live updates (SSE)

/** Event names on GET /api/events?repo=<repoKey>. */
export type BoardEventName = 'hello' | 'board-updated' | 'board-deleted'

/** Sent first on every (re)connection. */
export interface HelloEvent {
  repoKey: string
  /** Stored version now; null when there is no board for the repository. */
  version: number | null
}

export interface BoardUpdatedEvent {
  repoKey: string
  version: number
  updatedAt: string
  updatedBy: BoardAuthor | null
  /** CLIENT_ID_HEADER of the save that caused it; null for imports without the header. */
  clientId: string | null
}

export interface BoardDeletedEvent {
  repoKey: string
  clientId: string | null
}

// ---------------------------------------------------------------- GitHub proxy

/** Body of a 424 from /api/github/…; the browser falls back to calling GitHub itself. */
export interface GitHubAccessError extends ApiErrorBody {
  error: 'github-access'
  problem: GitHubAccessProblem | 'unavailable'
}
