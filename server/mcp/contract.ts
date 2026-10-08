/**
 * The /mcp contract shared by the modules in server/mcp/ and the GitHub reader:
 * error codes and their fixed texts, limits, the JSON the tools return, and the
 * narrow dependency interfaces each module receives. Types, constants and one
 * error class only. It imports no MCP SDK module, no reader, no save function
 * and no database module, so every other MCP module can depend on it.
 */
import type { BoardSummary, StoredBoard } from '../../src/domain/api.ts'
import type {
  BoardConfig,
  EstimateConfidence,
  EstimateSize,
  HoldingStatus,
  Issue,
  RepoRef,
  RepoSnapshot,
  RunStatus,
  TerminalStatus,
  TriageRange,
  UnverifiedCounts,
  WaitingStatus,
} from '../../src/domain/types.ts'
import type { Logger } from '../log.ts'
import type { RunStore } from '../runs/types.ts'

// ---------------------------------------------------------------- principal

/** The integration a verified Urutau MCP token belongs to. Never holds the token itself. */
export interface McpPrincipal {
  /** users.id of the integration account. */
  userId: string
  username: string
  /** api_tokens.id of the token that authenticated the request. */
  tokenId: string
}

/** What the endpoint hands to the tool registration for one HTTP request. */
export interface McpCallContext {
  principal: McpPrincipal
}

export const MCP_SERVER_INFO = { name: 'urutau', title: 'Urutau', version: '0.1.0' } as const

// ---------------------------------------------------------------- HTTP answers on /mcp

/** Codes of the JSON bodies Urutau itself sends on /mcp. Not part of the browser's ApiErrorCode. */
export type McpHttpErrorCode =
  | 'query-not-allowed' // 400
  | 'invalid-token' // 401
  | 'origin-rejected' // 403
  | 'method-not-allowed' // 405
  | 'too-many-attempts' // 429
  | 'unavailable' // 503: the handler was closed (shutdown)

export interface McpHttpErrorBody {
  error: McpHttpErrorCode
  message: string
}

export const MCP_HTTP_ERROR_TEXT: Record<McpHttpErrorCode, string> = {
  'query-not-allowed':
    'Send the Urutau MCP token in the Authorization header, never in the address. Remove the query string. If a token was put in an address, revoke it on the Users page.',
  'invalid-token': 'The Urutau MCP token is missing, unknown, revoked or expired.',
  'origin-rejected': 'Requests to /mcp from other web pages are refused.',
  'method-not-allowed': 'Only POST is answered here.',
  'too-many-attempts': 'Too many failed attempts. Try again later.',
  unavailable: 'The server is shutting down.',
}

export const MCP_WWW_AUTHENTICATE =
  'Bearer realm="urutau", error="invalid_token", error_description="The Urutau MCP token is missing, unknown, revoked or expired."'

// ---------------------------------------------------------------- tool errors

export type McpToolErrorCode =
  | 'rate-limited'
  | 'repo-not-allowed'
  | 'no-board'
  | 'board-invalid'
  | 'github-token-missing'
  | 'github-token-unreadable'
  | 'github-token-rejected'
  | 'github-rate-limited'
  | 'github-busy'
  | 'github-unavailable'
  | 'repo-not-found'
  | 'repo-moved'
  | 'issues-disabled'
  | 'bucket-not-found'
  | 'offset-needs-one-bucket'
  | 'invalid-position'
  | 'issue-not-on-board'
  | 'is-pull-request'
  | 'issue-closed'
  | 'anchor-not-in-bucket'
  | 'card-not-in-bucket'
  | 'duplicate-card'
  | 'no-change'
  | 'stale-board'
  | 'board-deleted'
  | 'board-busy'
  | 'call-stopped'
  | 'claimed-by-other-run'
  | 'run-finished'
  | 'run-id-taken'
  | 'item-changed'
  | 'too-many-items'
  | 'duplicate-item'
  | 'probed-and-withdrawn'
  | 'unknown-item'
  | 'item-needs-a-person'
  | 'invalid-text'
  | 'server-error'

/** The fixed text of each tool error. Never built from stored data, GitHub data, arguments or exceptions. */
export const TOOL_ERROR_TEXT: Record<McpToolErrorCode, string> = {
  'rate-limited': 'This integration made too many calls in the last minute. Wait retryAfterSeconds seconds and try again.',
  'repo-not-allowed':
    "This integration may not read this repository. The admin lists the repositories it may read on Urutau's Users page.",
  'no-board': 'This repository has no Urutau board yet. A person has to open it in Urutau first.',
  'board-invalid': "This board's stored configuration cannot be read by the MCP tools.",
  'github-token-missing': "This integration has no GitHub token. The admin sets one on Urutau's Users page.",
  'github-token-unreadable':
    "The server cannot read this integration's GitHub token. The admin sets it again on Urutau's Users page.",
  'github-token-rejected': "GitHub rejected this integration's GitHub token. The admin sets a new one on Urutau's Users page.",
  'github-rate-limited':
    "This integration's GitHub token has too few requests left for now. Wait retryAfterSeconds seconds and try again.",
  'github-busy': 'Another GitHub read for this integration is still running. Wait retryAfterSeconds seconds and try again.',
  'github-unavailable': 'GitHub could not be reached or answered with an error. Try again later.',
  'repo-not-found': "GitHub did not find this repository, or this integration's GitHub token cannot read it.",
  'repo-moved': 'GitHub says this repository was renamed or transferred. Open its board in Urutau under the new name.',
  'issues-disabled': 'Issues are turned off for this repository on GitHub.',
  'bucket-not-found': 'The board has no bucket with this id. Call get_board for the current bucket ids.',
  'offset-needs-one-bucket': 'offset can only be used when buckets names exactly one bucket.',
  'invalid-position': "Positions 'before' and 'after' need an anchor that is another card; 'top' and 'bottom' take no anchor.",
  'issue-not-on-board':
    "This issue is not on the board: boards show open issues and issues closed within the board's closed-issue window.",
  'is-pull-request': 'This number is a pull request. Boards show issues only.',
  'issue-closed': 'This issue is closed. Closed issues stay in the bucket that collects closed issues and cannot be moved.',
  'anchor-not-in-bucket': "The anchor is not a card in the target bucket. Call get_board for the bucket's cards.",
  'card-not-in-bucket': "Every issue in order must be a card in this bucket. Call get_board for the bucket's cards.",
  'duplicate-card': 'order lists an issue more than once.',
  'no-change': 'The board already looks like this, so nothing was saved.',
  'stale-board': 'The board changed since the version you read. Nothing was saved. Call get_board and try again.',
  'board-deleted': 'The board was deleted while this change was being saved. Nothing was saved.',
  'board-busy': 'The board kept changing while this change was being saved. Nothing was saved. Try again.',
  'call-stopped':
    'This call was stopped: its Urutau MCP token was revoked, its integration was removed, the repository was taken off its list, or the client closed the connection.',
  'claimed-by-other-run':
    'Another run holds the claim on this issue. Nothing was recorded. Stop work on this issue; a person can release the claim from the card in Urutau.',
  'run-finished':
    'This run has already ended, and an ended run never changes. Nothing was recorded. runStatus is the status it ended with. A retry needs a new runId.',
  'run-id-taken': 'This runId is already used for another issue or by another integration. Nothing was recorded. Use a new runId.',
  'item-changed':
    'An unverified item reuses the id of an earlier item with a different kind or text. Nothing was recorded. Give a changed item a new id.',
  'too-many-items': 'A run has at most 20 unverified items, counting those recorded earlier. Nothing was recorded.',
  'duplicate-item': 'unverified, probes or withdrawn names the same item id more than once. Nothing was recorded.',
  'probed-and-withdrawn':
    'The same item id is in both probes and withdrawn. An item is either checked or withdrawn, not both. Nothing was recorded.',
  'unknown-item': "A probe or a withdrawal names an item id that is not among this run's unverified items. Nothing was recorded.",
  'item-needs-a-person':
    'A probe or a withdrawal names a normative item. Only a person closes a normative item, with Accept on the card. Nothing was recorded.',
  'invalid-text': 'A text field is empty once control characters and extra spaces are removed. Nothing was recorded.',
  'server-error': 'Something went wrong on the server. Call get_board to see the board as it is now.',
}

/** Extra fields an error may carry: numbers, booleans, and runStatus, a value of the TerminalStatus enum read from the database. */
export interface ToolErrorExtra {
  retryAfterSeconds?: number
  reserve?: boolean
  currentVersion?: number | null
  cardMoved?: boolean
  /** Set only on run-finished: the status the ended run has. */
  runStatus?: TerminalStatus
}

/** The object serialised into an error result's text block. */
export interface ToolErrorPayload extends ToolErrorExtra {
  error: McpToolErrorCode
  message: string
}

/**
 * Thrown inside the MCP modules and the reader to end a tool call with a known
 * error. The message is the code itself, never data. The tool handler turns it
 * into the error result for its code.
 */
export class ToolFailure extends Error {
  readonly code: McpToolErrorCode
  readonly extra: ToolErrorExtra

  constructor(code: McpToolErrorCode, extra: ToolErrorExtra = {}) {
    super(code)
    this.name = 'ToolFailure'
    this.code = code
    this.extra = extra
  }
}

// ---------------------------------------------------------------- limits

export const MCP_LIMITS = {
  /** Request body bound passed to the SDK (413 above it). */
  requestBodyBytes: 1_048_576,
  /** Cards in one get_board answer. */
  cardsPerAnswer: 300,
  /** UTF-16 code units of one get_board answer's JSON, cards added while under it. */
  answerChars: 180_000,
  /** _meta["anthropic/maxResultSizeChars"] on get_board. */
  maxResultSizeChars: 400_000,
  bucketsPerAnswer: 50,
  defaultLimitPerBucket: 50,
  maxLimitPerBucket: 300,
  maxOffset: 10_000,
  reorderMaxItems: 1_000,
  callsPerMinute: 120,
  movesPerMinute: 30,
  githubRequestsPerHour: 1_000,
  /** The most GitHub requests one snapshot can make: 1 repository + 10 open pages + 10 closed pages. */
  requestsPerSnapshot: 21,
  /** Share of x-ratelimit-limit left to the token's owner. */
  reserveShare: 0.1,
  snapshotTtlMs: 60_000,
  snapshotCacheEntries: 20,
  refetchThrottleMs: 15_000,
  closedRefetchAgeMs: 10_000,
  queueWaitMs: 20_000,
  githubRequestTimeoutMs: 20_000,
  snapshotDeadlineMs: 60_000,
  saveAttempts: 3,
  busyRetryAfterSeconds: 5,
} as const

/** Code-point caps for untrusted display text (cleanText's max). */
export const DISPLAY_CAPS = {
  title: 120,
  label: 40,
  labelsPerCard: 10,
  login: 39,
  assigneesPerCard: 5,
  milestone: 60,
  bucketTitle: 60,
  labelRulesPerBucket: 10,
  username: 64,
  fullName: 140,
  timestamp: 30,
} as const

// ---------------------------------------------------------------- tool output JSON

export type EditorKind = 'person' | 'integration'

export interface EditorJson {
  username: string
  kind: EditorKind
}

export interface BoardListEntryJson {
  repo: string
  fullName: string
  version: number
  updatedAt: string
  updatedBy: EditorJson | null
}

export interface ListBoardsJson {
  boards: BoardListEntryJson[]
  reposWithoutBoard: string[]
}

export interface CardJson {
  number: number
  title: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  milestone: string | null
  comments: number
  updatedAt: string
  estimate: { size: EstimateSize | null; confidence: EstimateConfidence; by: string; at: string } | null
  lastRun: { status: RunStatus; triageRange: TriageRange | null; unverifiedOpen: UnverifiedCounts; runId: string } | null
  claim: { runId: string; status: HoldingStatus; since: string } | null
}

export interface BucketJson {
  id: string
  title: string
  wipLimit: number | null
  collectsClosed: boolean
  labelRules: string[]
  total: number
  offset: number
  more: boolean
  cards: CardJson[]
}

export interface GetBoardJson {
  repo: string
  fullName: string
  private: boolean
  version: number
  updatedAt: string
  updatedBy: EditorJson | null
  fetchedAt: string
  truncated: boolean
  closedWindowDays: number
  closedHidden: number
  cardBudgetReached: boolean
  bucketsOmitted: number
  /** Hours a card may wait on a human before it counts as over the limit; null: no limit. */
  humanWaitLimit: number | null
  /** Every waiting claim of the repository, oldest first, whether or not its issue is a card in this answer. */
  waitingOnHuman: { issue: number; runId: string; status: WaitingStatus; since: string; overLimit: boolean }[]
  buckets: BucketJson[]
}

export interface RecordRunJson {
  repo: string
  issue: number
  runId: string
  status: RunStatus
  created: boolean
  statusChanged: boolean
  claim: { held: boolean; leaseUntil: string | null }
  unverifiedOpen: UnverifiedCounts
  probesApplied: number
  probesSkipped: number
  withdrawnApplied: number
  withdrawnSkipped: number
  notified: boolean
}

export interface MoveCardJson {
  repo: string
  version: number
  issue: number
  from: string
  to: string
  index: number
  bucketSize: number
  attempts: number
}

export interface ReorderBucketJson {
  repo: string
  version: number
  bucket: string
  order: number[]
  attempts: number
}

// ---------------------------------------------------------------- snapshots

/** One repository's issues as the browser would load them, with what the move rules need. */
export interface BoardSnapshot {
  issues: Issue[]
  /** The numbers of `issues`. */
  seen: ReadonlySet<number>
  /** Largest issue or pull-request number on the raw open and closed pages; 0 when both are empty. */
  highestNumber: number
  pullRequests: ReadonlySet<number>
  /** The open or the closed list stopped before its end. */
  truncated: boolean
  isPrivate: boolean
  /** Epoch milliseconds. */
  fetchedAt: number
}

export interface SnapshotRequest {
  userId: string
  repo: RepoRef
  repoKey: string
  closedWindowDays: number
  signal: AbortSignal
}

/** What the GitHub reader returns for one snapshot: the same fields as DetailedSnapshot in src/github/api.ts. */
export interface ReaderSnapshot {
  snapshot: RepoSnapshot
  /** Largest number on the raw open and closed pages, pull requests included; 0 when both are empty. */
  highestNumber: number
  pullRequests: number[]
  openTruncated: boolean
  closedTruncated: boolean
}

/** Loads one snapshot for an account; rejects with ToolFailure. Implemented by the GitHub reader. */
export type FetchSnapshotFn = (
  userId: string,
  repo: RepoRef,
  closedWindowDays: number,
  signal: AbortSignal,
) => Promise<ReaderSnapshot>

export interface SnapshotProvider {
  /** The cached snapshot when younger than 60 s and of the current generation; else a shared or new fetch. */
  get(request: SnapshotRequest): Promise<BoardSnapshot>
  /** A new fetch unless one started for the key within 15 s; then as get. */
  refresh(request: SnapshotRequest): Promise<BoardSnapshot>
  /** Bumps the account's generation and drops its entries. */
  invalidate(userId: string): void
}

export type GitHubTokenState = 'ok' | 'missing' | 'unreadable' | 'rejected'

// ---------------------------------------------------------------- saving

export interface BoardEditorRef {
  id: string
  username: string
  kind: EditorKind
}

export interface SaveRequest {
  repoKey: string
  /** null creates the board (the /api route only; the MCP never creates a board). */
  baseVersion: number | null
  fullName: string
  board: BoardConfig
  editor: BoardEditorRef
  /** X-Urutau-Client of the saving tab; null for MCP saves. */
  clientId: string | null
}

export type SaveOutcome = { saved: true; stored: StoredBoard } | { saved: false; current: StoredBoard | null }

export type SaveBoardFn = (request: SaveRequest) => Promise<SaveOutcome>

// ---------------------------------------------------------------- dependencies

export interface BoardReads {
  get(repoKey: string): Promise<StoredBoard | null>
  /** Summaries of the boards among these keys, most recently updated first. */
  summaries(repoKeys: readonly string[]): Promise<BoardSummary[]>
}

export interface RepoLocks {
  /** Runs task after every earlier task for the key has settled, in arrival order. */
  run<T>(repoKey: string, signal: AbortSignal, task: () => Promise<T>): Promise<T>
}

export interface CallLimiter {
  /** Takes one unit; returns null when allowed, else the seconds to wait (at least 1). */
  take(userId: string, kind: 'call' | 'move'): number | null
  forget(userId: string): void
}

export interface InflightCall {
  readonly signal: AbortSignal
  end(): void
}

export interface InflightRegistry {
  begin(principal: McpPrincipal, parent?: AbortSignal): InflightCall
  abortToken(tokenId: string): number
  abortIntegration(userId: string): number
  size(): number
}

/** Everything the tool handlers need, built once by createApp. */
export interface ToolDeps {
  log: Logger
  now: () => Date
  boards: BoardReads
  allowedRepos(userId: string): Promise<ReadonlySet<string>>
  tokenState(userId: string): Promise<GitHubTokenState>
  /** True while the api_tokens row exists and has not expired. */
  tokenIsLive(tokenId: string): Promise<boolean>
  snapshots: SnapshotProvider
  save: SaveBoardFn
  locks: RepoLocks
  limits: CallLimiter
  inflight: InflightRegistry
  runs: RunStore
  /** Sends a card-activity event to the streams open on the repository. Synchronous; call it after the change committed. */
  publishCardActivity(event: { repoKey: string; issue: number; clientId: null }): void
}

/** What the save loop needs. */
export type MoveDeps = Pick<ToolDeps, 'log' | 'now' | 'boards' | 'snapshots' | 'save' | 'locks' | 'tokenIsLive'>
