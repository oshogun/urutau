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
  | 'github-writes-off' // 403: the admin has not turned on GitHub writes (creating and changing issues) for this server
  | 'already-set-up' // 409: first-run after the first account exists
  | 'username-taken' // 409
  | 'stale-board' // 409: the save's baseVersion is not the stored version (body: StaleBoardResponse)
  | 'stale-issue' // 409: the issue's updated_at on GitHub differs from expectedUpdatedAt; nothing was sent (body: StaleIssueResponse)
  | 'cannot-remove-admin' // 409: removing the admin account
  | 'encryption-key-missing' // 409: TOKEN_ENCRYPTION_KEY is not set, so the server stores no GitHub token
  | 'not-a-github-token' // 400: the value is an Urutau MCP token (urutau_mcp_…), not a GitHub token
  | 'unsupported-token-format' // 400: not a github_pat_… or ghp_… token
  | 'too-large' // 413
  | 'github-access' // 424: the server could not get a GitHub token from Keycloak (body: GitHubAccessError)
  | 'github-rejected' // 502: GitHub answered a write with a non-2xx status (body: GitHubRejectedError)
  | 'github-no-answer' // 504: a write was sent to GitHub and no answer came back (timeout or connection failure); GitHub may have applied it
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

/** Who saved a board: a person, or an agent integration account. */
export type EditorKind = 'person' | 'integration'

/** BoardAuthor plus what kind of account it is. */
export interface BoardEditor extends BoardAuthor {
  /** Always sent by the server. Optional in the type so values built before it existed stay valid; read a missing kind as 'person'. */
  kind?: EditorKind
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
  updatedBy: BoardEditor | null
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
  updatedBy: BoardEditor | null
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

// ---------------------------------------------------------------- server settings

/** GET /api/settings (any signed-in user) and the 200 body of PATCH /api/settings. */
export interface ServerSettings {
  /** True when the admin has turned on creating and changing issues on GitHub from Urutau. False on new and upgraded servers. */
  githubWrites: boolean
}

/** PATCH /api/settings (admin only): at least one known key; unknown keys are refused with 400. */
export type UpdateServerSettingsRequest = Partial<ServerSettings>

// ---------------------------------------------------------------- creating issues

/** Longest title accepted, in Unicode code points (`[...title].length`), after trimming. */
export const NEW_ISSUE_TITLE_MAX = 256
/** Longest description accepted, in Unicode code points (`[...body].length`), before trimming. */
export const NEW_ISSUE_BODY_MAX = 65_536

/**
 * POST /api/issues/:owner/:name, and the JSON body Urutau sends to GitHub's
 * POST /repos/{owner}/{repo}/issues on either path. GitHub uses the same two names.
 * `title` is sent trimmed; `body` is left out when it is missing or only whitespace.
 */
export interface CreateIssueRequest {
  title: string
  body?: string
}

/** 201 from POST /api/issues/:owner/:name. */
export interface CreateIssueResponse {
  /** GitHub's 201 body, unchanged; null when GitHub's answer was not JSON. The browser validates and maps it. */
  issue: unknown
}

/** One entry of GitHub's `errors` array on a 422, each field cut to 200 characters. */
export interface GitHubValidationError {
  resource: string | null
  field: string | null
  code: string | null
  message: string | null
}

/** What the server read from GitHub's non-2xx answer. Never contains a token, a title or a body. */
export interface GitHubFailureDetail {
  /** GitHub's HTTP status. */
  status: number
  /** GitHub's `message`, cut to 500 characters; null when absent or not a string. */
  message: string | null
  /** GitHub's `errors`, at most the first 5 entries; [] when absent. */
  errors: GitHubValidationError[]
  /** `retry-after` in whole seconds; null when absent or not a whole number. */
  retryAfter: number | null
  /** `x-ratelimit-remaining`; null when absent or not a whole number. */
  rateLimitRemaining: number | null
  /** `x-ratelimit-reset`, epoch seconds; null when absent or not a whole number. */
  rateLimitReset: number | null
}

/** Body of a 502 `github-rejected`. */
export interface GitHubRejectedError extends ApiErrorBody {
  error: 'github-rejected'
  github: GitHubFailureDetail
}

// ---------------------------------------------------------------- changing issues

/** The reasons Urutau sends with a state change. GitHub's `duplicate` is never sent. */
export type IssueStateReason = 'completed' | 'not_planned' | 'reopened'

/**
 * The fields Urutau may change on an issue, with GitHub's own names: the JSON body of GitHub's
 * PATCH /repos/{owner}/{repo}/issues/{issue_number} on either path. Only the fields the person
 * changed are present. `title` is trimmed (1 to NEW_ISSUE_TITLE_MAX code points); `body` is sent as
 * typed (0 to NEW_ISSUE_BODY_MAX code points, '' clears it); `state` and `state_reason` are present
 * together or not at all: 'closed' with 'completed' or 'not_planned', 'open' with 'reopened'.
 */
export interface IssueUpdateFields {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  state_reason?: IssueStateReason
}

/** PATCH /api/issues/:owner/:name/:number (Keycloak users whose realm brokers GitHub). */
export interface UpdateIssueRequest {
  /** The issue's updated_at, as GitHub sent it, when the change started. The server refuses with 409 stale-issue when GitHub's differs. */
  expectedUpdatedAt: string
  /** At least one field. */
  fields: IssueUpdateFields
}

/** 200 from PATCH /api/issues/:owner/:name/:number. */
export interface UpdateIssueResponse {
  /** GitHub's PATCH 200 body, unchanged; null when it was not JSON. The browser validates and maps it. */
  issue: unknown
}

/** Body of a 409 `stale-issue`. */
export interface StaleIssueResponse extends ApiErrorBody {
  error: 'stale-issue'
  /** GitHub's answer to the check request for the issue now, unchanged. */
  current: unknown
}

/** Body of a 502 `github-rejected` from the change route: which of the two GitHub requests was refused. */
export interface IssueUpdateRejectedError extends GitHubRejectedError {
  /** 'check': GitHub refused the GET, so nothing was sent. 'write': GitHub refused the PATCH. */
  step: 'check' | 'write'
}

// ---------------------------------------------------------------- agent integrations (admin)

export type ApiTokenExpiryDays = 30 | 90 | 365

export interface ApiTokenSummary {
  id: string
  label: string
  createdAt: string
  /** null: never expires. */
  expiresAt: string | null
  /** At most an hour behind the last use; null: never used. */
  lastUsedAt: string | null
}

export interface GitHubTokenStatus {
  /** Whether the server holds a GitHub token for this integration. */
  set: boolean
  /** False when the server cannot decrypt it: TOKEN_ENCRYPTION_KEY is unset or changed since. False when not set. */
  readable: boolean
  /** null when not set; 'unchecked' until GitHub answers a read; 'rejected' after GitHub answered 401. */
  status: 'unchecked' | 'ok' | 'rejected' | null
  /** When it was last set; null when not set. */
  updatedAt: string | null
}

export interface IntegrationSummary {
  /** The integration's account id (users.id). */
  id: string
  username: string
  createdAt: string
  createdBy: BoardAuthor | null
  /** Live tokens only (expired ones are left out), newest first. */
  tokens: ApiTokenSummary[]
  githubToken: GitHubTokenStatus
  /** Repository keys (lower-case owner/name) it may read, sorted. */
  repos: string[]
}

/** GET /api/integrations. */
export interface IntegrationListResponse {
  integrations: IntegrationSummary[]
  /** True when TOKEN_ENCRYPTION_KEY is set, so GitHub tokens can be stored. */
  githubTokenStorage: boolean
}

/** POST /api/integrations. */
export interface CreateIntegrationRequest {
  username: string
}

export interface CreateIntegrationResponse {
  integration: IntegrationSummary
}

/** POST /api/integrations/:id/tokens. */
export interface CreateApiTokenRequest {
  /** 1-64 characters after trimming. */
  label: string
  /** null: never expires. */
  expiresInDays: ApiTokenExpiryDays | null
}

export interface CreateApiTokenResponse {
  token: ApiTokenSummary
  /** The Urutau MCP token. Shown once; the server keeps only its SHA-256. */
  secret: string
}

/** PUT /api/integrations/:id/github-token. Write-only: no response ever contains the token. */
export interface SetGitHubTokenRequest {
  token: string
}

export interface SetGitHubTokenResponse {
  githubToken: GitHubTokenStatus
}

/** PUT /api/integrations/:id/repos: replaces the whole list. */
export interface SetIntegrationReposRequest {
  /** owner/name in any letter case; at most 200 entries; duplicates are merged. */
  repos: string[]
}

export interface SetIntegrationReposResponse {
  /** The stored keys, lower case, sorted. */
  repos: string[]
}
