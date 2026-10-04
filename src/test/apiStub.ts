import { vi } from 'vitest'
import { CLIENT_ID_HEADER, CSRF_HEADER, NEW_ISSUE_BODY_MAX, NEW_ISSUE_TITLE_MAX } from '../domain/api'
import type {
  AcceptInviteRequest,
  ApiErrorBody,
  ApiErrorCode,
  AppConfigResponse,
  BoardAuthor,
  BoardEditor,
  BoardEventName,
  BoardUpdatedEvent,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateIntegrationResponse,
  CreateInviteRequest,
  CreateIssueResponse,
  IssueUpdateFields,
  CreateInviteResponse,
  CredentialsRequest,
  GitHubAccess,
  IntegrationListResponse,
  IntegrationSummary,
  ImportBoardsResponse,
  ServerSettings,
  InviteSummary,
  SaveBoardRequest,
  Session,
  SessionResponse,
  SessionUser,
  SetGitHubTokenRequest,
  SetGitHubTokenResponse,
  SetIntegrationReposRequest,
  SetIntegrationReposResponse,
  StaleBoardResponse,
  StoredBoard,
  UpdateIssueResponse,
  UserSummary,
} from '../domain/api'
import { isBoardConfig } from '../domain/board'
import { parseUpdateIssueRequest } from '../domain/issueUpdate'
import { parseRepoInput, repoKey } from '../domain/repoRef'
import type { BoardConfig } from '../domain/types'

/**
 * A typed in-memory fake of the /api contract for App tests. GitHub URLs keep going to whatever
 * `fetch` was stubbed before `installApiStub` ran; `api/...` URLs are answered here. Call it
 * after stubbing `fetch` for GitHub.
 */

export type StubSessionMode = 'signed-in' | 'signed-out' | 'first-run'

export interface ApiStubOptions {
  /** Where the browser starts. Default 'signed-in'. */
  session?: StubSessionMode
  /** The signed-in user (default: admin "ada"). */
  user?: Partial<SessionUser>
  githubAccess?: GitHubAccess
  keycloak?: boolean
  instanceId?: string
  /** Boards on the server at the start. */
  boards?: StoredBoard[]
  /** Accounts that can sign in, besides the signed-in user. Default password for "ada" is "correct horse". */
  accounts?: { username: string; password: string; isAdmin?: boolean }[]
  signOutRedirectTo?: string | null
  /**
   * Answers GET api/github/<path>?<query> while the session's githubAccess mode is 'server'
   * (path without the `api/github/` prefix). Without it, or for an unknown path, the stub
   * answers 404 github-path-not-allowed. In browser mode the stub answers 403 forbidden.
   */
  github?: (request: { path: string; query: string; headers: Record<string, string> }) => Response | undefined
  /** The server-wide GitHub writes switch at the start. Default false. */
  githubWrites?: boolean
  /**
   * Answers POST api/issues/<owner>/<name> once the stub's own checks pass, in the server's order:
   * CSRF (403 csrf-rejected), session (401 signed-out), session mode 'server' (else 403 forbidden),
   * switch on (else 403 github-writes-off), owner and name by the proxy's patterns (else 400
   * invalid-request), fields valid by the server's rules, lengths in code points (else 400
   * invalid-request). The host guard, body limit, 424, 503 and 504 are not modelled; inject them
   * with failNext. Return undefined for the default answer: 201 with
   * `{ issue: stubCreatedIssue(`${owner}/${name}`, 1000 + n, title, body) }`, n counting the
   * stub's successful creates from 1.
   */
  createIssue?: (request: {
    owner: string
    name: string
    body: unknown
    headers: Record<string, string>
  }) => Response | undefined
  /**
   * Answers PATCH api/issues/<owner>/<name>/<number> once the stub's own checks pass, in the
   * server's order: session (401 signed-out), session mode 'server' (else 403 forbidden), switch on
   * (else 403 github-writes-off), owner, name and number by the server's patterns (else 400
   * invalid-request), body by the server's rules (else 400 invalid-request). The stale check,
   * the host guard, body limit, 424, 502, 503 and 504 are not modelled; return them from this
   * handler or inject them with failNext. Return undefined for the default answer: 200 with
   * `{ issue: stubUpdatedIssue(`${owner}/${name}`, number, fields) }`.
   */
  updateIssue?: (request: {
    owner: string
    name: string
    number: number
    body: unknown
    headers: Record<string, string>
  }) => Response | undefined
  /** Whether the server can store GitHub tokens (TOKEN_ENCRYPTION_KEY is set). Default true. */
  githubTokenStorage?: boolean
  /** Agent integrations at the start. */
  integrations?: { username: string; repos?: string[]; githubToken?: boolean }[]
}

export interface ApiCall {
  method: string
  /** Path after `api/`, with the query string. */
  path: string
  headers: Record<string, string>
  body: unknown
}

export interface StubFailure {
  status: number
  error?: ApiErrorCode
  message?: string
  body?: unknown
}

export type CallMatcher = string | ((call: ApiCall) => boolean)

export interface ApiStub {
  /** Every /api request seen, in order. */
  calls: ApiCall[]
  /** Calls matching `METHOD path-prefix` (e.g. `'PUT boards/acme/widgets'`) or a predicate. */
  requests(matcher: CallMatcher): ApiCall[]
  /** The stored board for a key, or undefined. */
  board(key: string): StoredBoard | undefined
  /** Stores a board as if another user saved it (no event); returns it. */
  putBoard(fullName: string, board: BoardConfig, by?: BoardEditor | null): StoredBoard
  /** Saves as another browser tab or user would and publishes the event to open streams. */
  externalSave(fullName: string, board: BoardConfig, by?: BoardEditor | null): StoredBoard
  /** Removes a board as another user would and publishes board-deleted. */
  externalDelete(repoKey: string): void
  /** Sends an event to every open fake EventSource for the repository. */
  emitBoardEvent(repoKey: string, name: BoardEventName, data: unknown): void
  /** Answers the next `times` matching requests with an error (or a network failure). */
  failNext(matcher: CallMatcher, failure: StubFailure | 'network', times?: number): void
  /** Holds matching requests until `release()`; a held request has not changed any state. */
  hold(matcher: CallMatcher): { release(): void }
  users: UserSummary[]
  /** The stub's agent integrations, as GET api/integrations lists them. */
  readonly integrations: IntegrationSummary[]
  invites: { summary: InviteSummary; token: string }[]
  /** Changes the GitHub access of the signed-in session, as the server would report it from now on. */
  setGithubAccess(access: GitHubAccess): void
  /** The signed-in session, or null. */
  readonly session: Session | null
  /** The GitHub writes switch as the stub's server holds it now. */
  readonly githubWrites: boolean
  /** Changes the switch as the admin would from another browser; this client is not told. */
  setGithubWrites(on: boolean): void
  /** Number of EventSource instances currently open. */
  openStreams(): number
  /** Fails every open stream: 'reconnect' (the browser retries) or 'closed' (HTTP error, source ended). */
  failStreams(mode: 'reconnect' | 'closed'): void
  restore(): void
}

interface Account {
  user: UserSummary
  password: string
}

const DEFAULT_PASSWORD = 'correct horse'

function toResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status })
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function error(status: number, code: ApiErrorCode, message: string, extra: object = {}): Response {
  const body: ApiErrorBody = { error: code, message }
  return toResponse(status, { ...body, ...extra })
}

/**
 * A GitHub issue JSON object as GitHub's create-issue 201 returns it, with the fields the app's
 * issue mapping reads. Exported for App tests that answer the browser path's POST to api.github.com.
 */
export function stubCreatedIssue(fullName: string, number: number, title: string, body?: string): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    number,
    title,
    body: body ?? null,
    state: 'open',
    state_reason: null,
    html_url: `https://github.com/${fullName}/issues/${number}`,
    labels: [],
    assignees: [],
    user: { login: 'ada', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', html_url: 'https://github.com/ada' },
    milestone: null,
    comments: 0,
    created_at: now,
    updated_at: now,
    closed_at: null,
  }
}

/**
 * A GitHub issue JSON object as GitHub's update-issue 200 returns it: the created-issue shape with
 * the title and description from `fields` when present, the state and reason from `fields`
 * (closed: closed_at now; open: null), and updated_at now.
 */
export function stubUpdatedIssue(fullName: string, number: number, fields: IssueUpdateFields): Record<string, unknown> {
  const issue = stubCreatedIssue(fullName, number, fields.title ?? `Issue ${number}`, fields.body)
  const now = new Date().toISOString()
  return {
    ...issue,
    state: fields.state ?? 'open',
    state_reason: fields.state_reason ?? null,
    closed_at: fields.state === 'closed' ? now : null,
    updated_at: now,
  }
}

/** The server's three GitHub token format rules (a local copy: src cannot import server). */
function githubTokenProblem(value: string): { code: ApiErrorCode; message: string } | null {
  if (value.startsWith('urutau_mcp_')) {
    return { code: 'not-a-github-token', message: 'This is an Urutau MCP token, not a GitHub token.' }
  }
  if (/^github_pat_[A-Za-z0-9_]{20,255}$/.test(value) || /^ghp_[A-Za-z0-9]{36}$/.test(value)) return null
  return {
    code: 'unsupported-token-format',
    message: 'Use a fine-grained token (github_pat_…) or a classic token (ghp_…).',
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const length = (text: string) => [...text].length

/** The server's field rules for a new issue; the message is for the 400 answer. */
function newIssueProblem(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'The request body must be a JSON object.'
  const fields = body as Record<string, unknown>
  if (Object.keys(fields).some((key) => key !== 'title' && key !== 'body')) return 'Only title and body can be set.'
  if (typeof fields.title !== 'string') return 'title must be text.'
  const title = fields.title.trim()
  if (title === '') return 'title is required.'
  if (length(title) > NEW_ISSUE_TITLE_MAX) return `title must be at most ${NEW_ISSUE_TITLE_MAX} characters.`
  if (fields.body !== undefined && typeof fields.body !== 'string') return 'body must be text.'
  if (typeof fields.body === 'string' && length(fields.body) > NEW_ISSUE_BODY_MAX) return `body must be at most ${NEW_ISSUE_BODY_MAX.toLocaleString('en-US')} characters.`
  return null
}

class FakeEventSource {
  static instances = new Set<FakeEventSource>()
  readonly url: string
  readonly repoKey: string
  readyState = 0
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  private onOpen: (source: FakeEventSource) => void

  constructor(url: string, onOpen: (source: FakeEventSource) => void) {
    this.onOpen = onOpen
    this.url = url
    this.repoKey = new URL(url, window.location.href).searchParams.get('repo') ?? ''
    FakeEventSource.instances.add(this)
    queueMicrotask(() => {
      if (this.readyState === 2) return
      this.readyState = 1
      this.onOpen(this)
      this.onopen?.(new Event('open'))
    })
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    const set = this.listeners.get(name) ?? new Set()
    set.add(listener)
    this.listeners.set(name, set)
  }

  removeEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(name)?.delete(listener)
  }

  dispatch(name: string, data: unknown) {
    const event = new MessageEvent(name, { data: JSON.stringify(data) })
    this.listeners.get(name)?.forEach((listener) => listener(event))
  }

  close() {
    this.readyState = 2
    FakeEventSource.instances.delete(this)
  }

  /**
   * A network error. 'reconnect' mimics the browser retrying by itself (readyState CONNECTING,
   * then open with a new hello); 'closed' mimics an HTTP error that ends the source for good.
   */
  fail(mode: 'reconnect' | 'closed') {
    if (mode === 'closed') {
      this.readyState = 2
      FakeEventSource.instances.delete(this)
      this.onerror?.(new Event('error'))
      return
    }
    this.readyState = 0
    this.onerror?.(new Event('error'))
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onOpen(this)
      this.onopen?.(new Event('open'))
    })
  }
}

export function installApiStub(options: ApiStubOptions = {}): ApiStub {
  const config: AppConfigResponse = {
    keycloak: { enabled: options.keycloak ?? false },
    instanceId: options.instanceId ?? 'instance-test',
  }

  let nextId = 1
  let tick = 0
  const accounts: Account[] = []
  const makeAccount = (username: string, password: string, isAdmin: boolean): Account => ({
    password,
    user: {
      id: `user-${nextId++}`,
      username,
      displayName: null,
      isAdmin,
      authMethod: 'local',
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, nextId)).toISOString(),
    },
  })

  /** Usernames are unique across people and agent integrations, ignoring case, as on the server. */
  const usernameTaken = (username: string): boolean => {
    const lower = username.toLowerCase()
    return (
      accounts.some((a) => a.user.username.toLowerCase() === lower) ||
      integrations.some((i) => i.username.toLowerCase() === lower)
    )
  }
  const takenUsername = () => error(409, 'username-taken', 'That username is already taken.')

  const mode = options.session ?? 'signed-in'
  if (mode !== 'first-run') {
    const base = makeAccount(options.user?.username ?? 'ada', DEFAULT_PASSWORD, options.user?.isAdmin ?? true)
    Object.assign(base.user, options.user)
    accounts.push(base)
  }
  for (const extra of options.accounts ?? []) {
    accounts.push(makeAccount(extra.username, extra.password, extra.isAdmin ?? false))
  }

  let githubWrites = options.githubWrites ?? false
  let createdIssues = 0
  let current: Session | null = null
  const startSession = (account: Account): Session => {
    const { id, username, displayName, isAdmin, authMethod } = account.user
    current = {
      user: { id, username, displayName, isAdmin, authMethod },
      csrfToken: `csrf-${nextId++}`,
      githubAccess: options.githubAccess ?? { mode: 'browser', problem: null },
    }
    return current
  }
  if (mode === 'signed-in') startSession(accounts[0])

  const boards = new Map<string, StoredBoard>()
  const stamp = () => new Date(Date.UTC(2026, 9, 2, 12, 0, tick++)).toISOString()
  const author = (): BoardEditor | null =>
    current ? { id: current.user.id, username: current.user.username, kind: 'person' } : null
  const creator = (): BoardAuthor | null => (current ? { id: current.user.id, username: current.user.username } : null)
  for (const stored of options.boards ?? []) boards.set(stored.repoKey, stored)

  const githubTokenStorage = options.githubTokenStorage ?? true
  const integrations: IntegrationSummary[] = (options.integrations ?? []).map((start) => ({
    id: `integration-${nextId++}`,
    username: start.username,
    createdAt: stamp(),
    createdBy: creator(),
    tokens: [],
    githubToken: start.githubToken
      ? { set: true, readable: githubTokenStorage, status: 'unchecked', updatedAt: stamp() }
      : { set: false, readable: false, status: null, updatedAt: null },
    repos: [...new Set((start.repos ?? []).map((r) => r.toLowerCase()))].sort(),
  }))
  let issuedTokens = 0

  const invites: ApiStub['invites'] = []
  const calls: ApiCall[] = []
  const failures: { matcher: CallMatcher; failure: StubFailure | 'network'; times: number }[] = []
  const holds: { matcher: CallMatcher; gate: Promise<void>; release: () => void }[] = []

  const matches = (matcher: CallMatcher, call: ApiCall) =>
    typeof matcher === 'function' ? matcher(call) : `${call.method} ${call.path}`.startsWith(matcher)

  const emit = (key: string, name: BoardEventName, data: unknown) => {
    for (const source of FakeEventSource.instances) {
      if (source.repoKey === key) source.dispatch(name, data)
    }
  }

  const store = (fullName: string, board: BoardConfig, by: BoardEditor | null): StoredBoard => {
    const key = fullName.toLowerCase()
    const previous = boards.get(key)
    const saved: StoredBoard = {
      repoKey: key,
      fullName,
      version: (previous?.version ?? 0) + 1,
      updatedAt: stamp(),
      updatedBy: by,
      board,
    }
    boards.set(key, saved)
    return saved
  }

  const publishUpdate = (saved: StoredBoard, clientId: string | null) => {
    const event: BoardUpdatedEvent = {
      repoKey: saved.repoKey,
      version: saved.version,
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy,
      clientId,
    }
    emit(saved.repoKey, 'board-updated', event)
  }

  const stale = (key: string): Response =>
    toResponse(409, {
      error: 'stale-board',
      message: 'The board changed since you opened it.',
      current: boards.get(key) ?? null,
    } satisfies StaleBoardResponse)

  const validKey = (path: string): { key: string } | null => {
    const ref = path.split('/').length === 2 ? parseRepoInput(path) : null
    return ref && repoKey(ref) === path ? { key: path } : null
  }

  function integrationsRoute(method: string, tail: string, body: unknown): Response {
    const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    if (tail === '') {
      if (method === 'GET') {
        const list: IntegrationListResponse = { integrations, githubTokenStorage }
        return toResponse(200, list)
      }
      if (method === 'POST') {
        const username = fields?.username
        if (typeof username !== 'string') return error(400, 'invalid-request', 'A username is required.')
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username)) {
          return error(400, 'invalid-request', 'The username must be 3 to 32 characters: letters, digits, dots, dashes and underscores, starting with a letter or digit.')
        }
        if (usernameTaken(username)) return takenUsername()
        const integration: IntegrationSummary = {
          id: `integration-${nextId++}`,
          username,
          createdAt: stamp(),
          createdBy: creator(),
          tokens: [],
          githubToken: { set: false, readable: false, status: null, updatedAt: null },
          repos: [],
        }
        integrations.push(integration)
        return toResponse(201, { integration } satisfies CreateIntegrationResponse)
      }
      return error(404, 'not-found', 'No such route.')
    }

    const [id, section, sectionId, ...more] = tail.split('/').map(decodeURIComponent)
    const integration = integrations.find((i) => i.id === id)
    if (!integration) return error(404, 'not-found', 'There is no agent integration with this id.')
    if (more.length > 0) return error(404, 'not-found', 'No such route.')

    if (section === undefined && method === 'DELETE') {
      integrations.splice(integrations.indexOf(integration), 1)
      return toResponse(204, null)
    }
    if (section === 'tokens' && sectionId === undefined && method === 'POST') {
      const request = fields as Partial<CreateApiTokenRequest> | null
      const label = typeof request?.label === 'string' ? request.label.trim() : ''
      if (label === '' || length(label) > 64) return error(400, 'invalid-request', 'label must be 1 to 64 characters.')
      const days = request?.expiresInDays
      if (days !== null && days !== 30 && days !== 90 && days !== 365) {
        return error(400, 'invalid-request', 'expiresInDays must be 30, 90, 365 or null.')
      }
      issuedTokens += 1
      const token: CreateApiTokenResponse['token'] = {
        id: `token-${nextId++}`,
        label,
        createdAt: stamp(),
        expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
        lastUsedAt: null,
      }
      integration.tokens.unshift(token)
      const suffix = String(issuedTokens).padStart(43, 'A')
      return toResponse(201, { token, secret: `urutau_mcp_${suffix}` } satisfies CreateApiTokenResponse)
    }
    if (section === 'tokens' && sectionId !== undefined && method === 'DELETE') {
      const token = integration.tokens.find((t) => t.id === sectionId)
      if (!token) return error(404, 'not-found', 'There is no such token for this integration.')
      integration.tokens.splice(integration.tokens.indexOf(token), 1)
      return toResponse(204, null)
    }
    if (section === 'github-token' && sectionId === undefined && method === 'PUT') {
      const token = (fields as Partial<SetGitHubTokenRequest> | null)?.token
      if (typeof token !== 'string' || token.length > 300) {
        return error(400, 'invalid-request', 'token must be text of at most 300 characters.')
      }
      if (!githubTokenStorage) {
        return error(409, 'encryption-key-missing', 'The server has no TOKEN_ENCRYPTION_KEY, so it cannot store a GitHub token.')
      }
      const problem = githubTokenProblem(token.trim())
      if (problem) return error(400, problem.code, problem.message)
      integration.githubToken = { set: true, readable: true, status: 'unchecked', updatedAt: stamp() }
      return toResponse(200, { githubToken: integration.githubToken } satisfies SetGitHubTokenResponse)
    }
    if (section === 'github-token' && sectionId === undefined && method === 'DELETE') {
      integration.githubToken = { set: false, readable: false, status: null, updatedAt: null }
      return toResponse(204, null)
    }
    if (section === 'repos' && sectionId === undefined && method === 'PUT') {
      const repos = (fields as Partial<SetIntegrationReposRequest> | null)?.repos
      if (!Array.isArray(repos) || repos.length > 200 || repos.some((r) => typeof r !== 'string')) {
        return error(400, 'invalid-request', 'repos must be a list of at most 200 repositories.')
      }
      const keys: string[] = []
      for (const [index, entry] of (repos as string[]).entries()) {
        const text = entry.trim()
        const ref = parseRepoInput(text)
        if (!ref || repoKey(ref) !== text.toLowerCase()) {
          return error(400, 'invalid-request', `Entry ${index + 1} is not a repository as owner/name.`)
        }
        keys.push(repoKey(ref))
      }
      integration.repos = [...new Set(keys)].sort()
      return toResponse(200, { repos: integration.repos } satisfies SetIntegrationReposResponse)
    }
    return error(404, 'not-found', 'No such route.')
  }

  function route(call: ApiCall, url: URL): Response {
    const { method } = call
    const [head, ...rest] = url.pathname.replace(/^.*\/api\//, '').split('/')
    const tail = rest.join('/')
    const body = call.body

    // Public routes.
    if (method === 'GET' && head === 'health') return toResponse(200, { ok: true })
    if (method === 'GET' && head === 'config') return toResponse(200, config)
    if (method === 'GET' && head === 'session') {
      const response: SessionResponse = current
        ? { signedIn: true, session: current }
        : { signedIn: false, firstRun: accounts.length === 0 }
      return toResponse(200, response)
    }

    const credentials = body as Partial<CredentialsRequest> | null
    if (method === 'POST' && head === 'auth' && tail === 'first-run') {
      if (accounts.length > 0) return error(409, 'already-set-up', 'The server is already set up.')
      if (!credentials?.username || !credentials.password) {
        return error(400, 'invalid-request', 'Username and password are required.')
      }
      if (usernameTaken(credentials.username)) return takenUsername()
      const account = makeAccount(credentials.username, credentials.password, true)
      accounts.push(account)
      return toResponse(201, startSession(account))
    }
    if (method === 'POST' && head === 'auth' && tail === 'sign-in') {
      const account = accounts.find(
        (a) => a.user.username.toLowerCase() === credentials?.username?.toLowerCase(),
      )
      if (!account || account.password !== credentials?.password) {
        return error(401, 'invalid-credentials', 'Wrong username or password.')
      }
      return toResponse(200, startSession(account))
    }
    if (method === 'POST' && head === 'auth' && tail === 'sign-out') {
      current = null
      return toResponse(200, { redirectTo: options.signOutRedirectTo ?? null })
    }
    if (method === 'POST' && head === 'invites' && (tail === 'check' || tail === 'accept')) {
      const token = (body as { token?: string } | null)?.token
      const invite = invites.find((i) => i.token === token)
      if (!invite || Date.parse(invite.summary.expiresAt) < Date.now()) {
        return error(404, 'invite-invalid', 'This invite is not valid any more.')
      }
      if (tail === 'check') return toResponse(200, { expiresAt: invite.summary.expiresAt })
      const accept = body as AcceptInviteRequest
      if (!accept.username || !accept.password) {
        return error(400, 'invalid-request', 'Username and password are required.')
      }
      if (usernameTaken(accept.username)) return takenUsername()
      invites.splice(invites.indexOf(invite), 1)
      const account = makeAccount(accept.username, accept.password, false)
      accounts.push(account)
      return toResponse(201, startSession(account))
    }

    // Everything else needs a session.
    if (!current) return error(401, 'signed-out', 'Sign in to continue.')

    if (head === 'settings' && method === 'GET' && tail === '') {
      return toResponse(200, { githubWrites } satisfies ServerSettings)
    }
    if (head === 'settings' && method === 'PATCH' && tail === '') {
      if (!current.user.isAdmin) return error(403, 'forbidden', 'Only the admin can do this.')
      const request = body as Partial<ServerSettings> | null
      const keys = request && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request) : []
      if (keys.length === 0 || keys.some((key) => key !== 'githubWrites') || typeof request?.githubWrites !== 'boolean') {
        return error(400, 'invalid-request', 'The settings request is not valid.')
      }
      githubWrites = request.githubWrites
      return toResponse(200, { githubWrites } satisfies ServerSettings)
    }
    if (head === 'issues' && method === 'POST') {
      const [owner = '', name = '', ...more] = tail.split('/').map(decodeURIComponent)
      if (more.length > 0) return error(404, 'not-found', 'No such route.')
      if (current.githubAccess.mode !== 'server') {
        return error(403, 'forbidden', 'This account creates issues from the browser.')
      }
      if (!githubWrites) return error(403, 'github-writes-off', 'The admin has not turned on creating issues on GitHub.')
      if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name) || name === '.' || name === '..') {
        return error(400, 'invalid-request', 'The path must be a repository as owner/name.')
      }
      const problem = newIssueProblem(body)
      if (problem) return error(400, 'invalid-request', problem)
      const answer = options.createIssue?.({ owner, name, body, headers: call.headers })
      if (answer) return answer
      const fields = body as { title: string; body?: string }
      createdIssues += 1
      const issue = stubCreatedIssue(`${owner}/${name}`, 1000 + createdIssues, fields.title.trim(), fields.body?.trim() === '' ? undefined : fields.body)
      return toResponse(201, { issue } satisfies CreateIssueResponse)
    }

    if (head === 'issues' && method === 'PATCH') {
      const [owner = '', name = '', digits = '', ...more] = tail.split('/').map(decodeURIComponent)
      if (more.length > 0) return error(404, 'not-found', 'No such route.')
      if (current.githubAccess.mode !== 'server') {
        return error(403, 'forbidden', 'This account changes issues from the browser.')
      }
      if (!githubWrites) return error(403, 'github-writes-off', 'The admin has not turned on changing issues on GitHub.')
      const number = Number(digits)
      if (
        !OWNER_PATTERN.test(owner) ||
        !NAME_PATTERN.test(name) ||
        name === '.' ||
        name === '..' ||
        !/^[1-9][0-9]{0,9}$/.test(digits) ||
        number > 2147483647
      ) {
        return error(400, 'invalid-request', 'The path must be a repository as owner/name and an issue number.')
      }
      const parsed = parseUpdateIssueRequest(body)
      if (!parsed.ok) return error(400, 'invalid-request', parsed.message)
      const answer = options.updateIssue?.({ owner, name, number, body, headers: call.headers })
      if (answer) return answer
      const issue = stubUpdatedIssue(`${owner}/${name}`, number, parsed.value.fields)
      return toResponse(200, { issue } satisfies UpdateIssueResponse)
    }

    if (head === 'github' && method === 'GET') {
      if (current.githubAccess.mode !== 'server') {
        return error(403, 'forbidden', 'GitHub reads go through the browser for this session.')
      }
      const answer = options.github?.({ path: tail, query: url.search.replace(/^\?/, ''), headers: call.headers })
      return answer ?? error(404, 'github-path-not-allowed', 'That GitHub path is not allowed.')
    }

    if (head === 'boards') {
      if (method === 'GET' && tail === '') {
        const list = [...boards.values()]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(({ board: _board, ...summary }) => summary)
        return toResponse(200, { boards: list })
      }
      if (method === 'POST' && tail === 'import') {
        const entries = (body as { boards?: unknown } | null)?.boards
        if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
          return error(400, 'invalid-request', 'boards must be an object.')
        }
        const result: ImportBoardsResponse = { imported: [], skipped: [], invalid: [] }
        for (const [key, value] of Object.entries(entries)) {
          if (!validKey(key) || !isBoardConfig(value)) result.invalid.push(key)
          else if (boards.has(key)) result.skipped.push(key)
          else {
            const saved = store(key, value, author())
            result.imported.push(key)
            publishUpdate(saved, null)
          }
        }
        return toResponse(200, result)
      }

      const target = validKey(decodeURIComponent(tail))
      if (!target) return error(400, 'invalid-request', 'Not a repository key.')
      const existing = boards.get(target.key)

      if (method === 'GET') {
        return existing ? toResponse(200, existing) : error(404, 'not-found', 'No board for this repository.')
      }
      if (method === 'PUT') {
        const request = body as Partial<SaveBoardRequest> | null
        if (
          typeof request?.fullName !== 'string' ||
          request.fullName.toLowerCase() !== target.key ||
          !isBoardConfig(request.board) ||
          (request.baseVersion !== null && typeof request.baseVersion !== 'number')
        ) {
          return error(400, 'invalid-request', 'The board request is not valid.')
        }
        if (request.baseVersion === null ? existing : request.baseVersion !== existing?.version) {
          return stale(target.key)
        }
        const saved = store(request.fullName, request.board, author())
        publishUpdate(saved, call.headers[CLIENT_ID_HEADER.toLowerCase()] ?? null)
        return toResponse(request.baseVersion === null ? 201 : 200, saved)
      }
      if (method === 'DELETE') {
        if (!existing) return error(404, 'not-found', 'No board for this repository.')
        if (Number(url.searchParams.get('version')) !== existing.version) return stale(target.key)
        boards.delete(target.key)
        emit(target.key, 'board-deleted', {
          repoKey: target.key,
          clientId: call.headers[CLIENT_ID_HEADER.toLowerCase()] ?? null,
        })
        return toResponse(204, null)
      }
    }

    if (head === 'integrations') {
      if (!current.user.isAdmin) return error(403, 'forbidden', 'Only the admin can do this.')
      return integrationsRoute(method, tail, body)
    }

    if (head === 'users' || head === 'invites') {
      if (!current.user.isAdmin) return error(403, 'forbidden', 'Only the admin can do this.')
      if (head === 'users') {
        if (method === 'GET') {
          const list = accounts.map((a) => a.user).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          return toResponse(200, { users: list })
        }
        if (method === 'DELETE') {
          const account = accounts.find((a) => a.user.id === tail)
          if (!account) return error(404, 'not-found', 'No such user.')
          if (account.user.isAdmin) return error(409, 'cannot-remove-admin', 'The admin cannot be removed.')
          accounts.splice(accounts.indexOf(account), 1)
          return toResponse(204, null)
        }
      } else {
        if (method === 'GET') {
          return toResponse(200, { invites: invites.map((i) => i.summary) })
        }
        if (method === 'POST') {
          const hours = (body as CreateInviteRequest | null)?.expiresInHours ?? 168
          if (!(hours >= 1 && hours <= 720)) return error(400, 'invalid-request', 'expiresInHours is 1 to 720.')
          const summary: InviteSummary = {
            id: `invite-${nextId++}`,
            createdAt: stamp(),
            expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
            createdBy: creator(),
          }
          const token = `token-${summary.id}`
          invites.push({ summary, token })
          return toResponse(201, { invite: summary, token } satisfies CreateInviteResponse)
        }
        if (method === 'DELETE') {
          const invite = invites.find((i) => i.summary.id === tail)
          if (!invite) return error(404, 'not-found', 'No such invite.')
          invites.splice(invites.indexOf(invite), 1)
          return toResponse(204, null)
        }
      }
    }

    return error(404, 'not-found', 'No such route.')
  }

  const inner = globalThis.fetch

  const stubbed = vi.fn<typeof fetch>(async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, window.location.href)
    if (url.origin !== window.location.origin || !/\/api\//.test(url.pathname)) {
      return inner(input, init)
    }

    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    const call: ApiCall = {
      method,
      path: url.pathname.replace(/^.*\/api\//, '') + url.search,
      headers,
      body,
    }
    calls.push(call)

    for (const hold of holds.filter((h) => matches(h.matcher, call))) await hold.gate

    const failure = failures.find((f) => f.times > 0 && matches(f.matcher, call))
    if (failure) {
      failure.times -= 1
      if (failure.failure === 'network') throw new TypeError('Failed to fetch')
      const { status, error: code, message, body: extra } = failure.failure
      return extra !== undefined
        ? toResponse(status, extra)
        : error(status, code ?? 'server-error', message ?? 'Injected failure.')
    }

    if (method !== 'GET' && !/\/api\/auth\/keycloak\//.test(url.pathname)) {
      const sent = headers[CSRF_HEADER.toLowerCase()]
      if (!sent || (current && sent !== current.csrfToken)) {
        return error(403, 'csrf-rejected', 'Missing or wrong CSRF header.')
      }
    }
    return route(call, url)
  })
  vi.stubGlobal('fetch', stubbed)
  vi.stubGlobal(
    'EventSource',
    class extends FakeEventSource {
      constructor(url: string) {
        super(url, (source) => {
          if (!current) return
          const version = boards.get(source.repoKey)?.version ?? null
          source.dispatch('hello', { repoKey: source.repoKey, version })
        })
      }
    },
  )

  return {
    calls,
    requests: (matcher) => calls.filter((call) => matches(matcher, call)),
    board: (key) => boards.get(key.toLowerCase()),
    putBoard: (fullName, board, by = null) => store(fullName, board, by),
    externalSave(fullName, board, by = { id: 'user-other', username: 'grace', kind: 'person' }) {
      const saved = store(fullName, board, by)
      publishUpdate(saved, null)
      return saved
    },
    externalDelete(key) {
      boards.delete(key.toLowerCase())
      emit(key.toLowerCase(), 'board-deleted', { repoKey: key.toLowerCase(), clientId: null })
    },
    emitBoardEvent: emit,
    failNext(matcher, failure, times = 1) {
      failures.push({ matcher, failure, times })
    },
    hold(matcher) {
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.push({ matcher, gate, release })
      return { release }
    },
    get users() {
      return accounts.map((a) => a.user)
    },
    get integrations() {
      return integrations
    },
    invites,
    setGithubAccess(access) {
      if (current) current = { ...current, githubAccess: access }
    },
    get session() {
      return current
    },
    get githubWrites() {
      return githubWrites
    },
    setGithubWrites(on) {
      githubWrites = on
    },
    openStreams: () => FakeEventSource.instances.size,
    failStreams: (mode) => [...FakeEventSource.instances].forEach((source) => source.fail(mode)),
    restore() {
      FakeEventSource.instances.clear()
      vi.stubGlobal('fetch', inner)
    },
  } as ApiStub
}
