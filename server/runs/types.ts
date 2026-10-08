import type {
  CardActivity,
  ClaimView,
  IssueActivityResponse,
  UnverifiedItemView,
} from '../../src/domain/api.ts'
import type {
  HoldingStatus,
  RunStatus,
  TerminalStatus,
  TriageRange,
  UncertaintyKind,
  UnverifiedCounts,
  UnverifiedItem,
  WaitingStatus,
} from '../../src/domain/types.ts'

export const RUN_LIMITS = {
  leaseMs: 1_800_000,
  itemsPerRun: 20,
  itemIdPattern: '^[A-Za-z0-9._-]{1,32}$',
  itemTextMax: 280,
  itemTextInputMax: 1_000,
  probesPerCall: 20,
  withdrawnPerCall: 20,
  filesOmittedMax: 100_000,
  noteMax: 280,
  noteInputMax: 1_000,
  findingsMax: 1_000,
  findingsInputMax: 4_000,
  mergeShasPerRun: 20,
  filesPerRun: 200,
  fileMax: 256,
  areasPerRun: 10,
  areaMax: 64,
  fixRoundsMax: 1_000,
  costUsdMax: 1_000_000,
  runsPerIssueView: 20,
  activityCardsMax: 1_000,
  transactionAttempts: 3,
} as const

/** The validated, cleaned record_run input. Omitted optional fields are undefined. */
export interface RecordRunInput {
  repoKey: string
  issue: number
  runId: string
  agentUserId: string
  status: RunStatus
  triageRange?: TriageRange
  uncertaintyKind?: UncertaintyKind
  unverified?: UnverifiedItem[]
  mergeShas?: string[]
  files?: string[]
  filesOmitted?: number
  areas?: string[]
  observedBy?: string
  fixRounds?: number
  costUsd?: number
  findings?: string
  probes?: { item: string; note: string | null }[]
  /** Item ids to withdraw; never overlaps probes (checked before the store is called). */
  withdrawn?: string[]
}

export interface RecordRunOutcome {
  status: RunStatus
  created: boolean
  statusChanged: boolean
  claim: { held: boolean; leaseUntil: string | null }
  unverifiedOpen: UnverifiedCounts
  probesApplied: number
  probesSkipped: number
  withdrawnApplied: number
  withdrawnSkipped: number
  /** Whether a card-activity event must be published. */
  notify: boolean
}

export type RunStoreErrorCode =
  | 'claimed-by-other-run'
  | 'run-finished'
  | 'run-id-taken'
  | 'item-changed'
  | 'too-many-items'
  | 'unknown-item'
  | 'item-needs-a-person'

/** A refusal of a record_run call, release or accept; the transaction that raised it is rolled back. */
export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode
  /** Set for run-finished: the status the run ended with. */
  readonly runStatus?: TerminalStatus
  constructor(code: RunStoreErrorCode, runStatus?: TerminalStatus) {
    super(code)
    this.name = 'RunStoreError'
    this.code = code
    this.runStatus = runStatus
  }
}

export interface BoardActivity {
  repoKey: string
  cards: CardActivity[]
}

export type IssueActivity = IssueActivityResponse

/** For get_board: keyed by issue number. */
export interface ActivityForCards {
  claims: Map<number, { runId: string; status: HoldingStatus; since: string }>
  lastRuns: Map<number, { runId: string; status: RunStatus; triageRange: TriageRange | null; unverifiedOpen: UnverifiedCounts }>
}

export interface WaitingClaim {
  issue: number
  runId: string
  status: WaitingStatus
  /** The run's status_at: when it started waiting. */
  since: string
}

export type ReleaseOutcome =
  | { released: true }
  | { released: false; current: ClaimView | null }

export interface AcceptInput {
  repoKey: string
  runId: string
  itemId: string
  /** The person's users.id. */
  userId: string
  /** Already cleaned; null when none. */
  note: string | null
}

export type AcceptOutcome =
  | { kind: 'accepted'; item: UnverifiedItemView }
  | { kind: 'not-found' }
  | { kind: 'not-normative' }
  | { kind: 'resolved'; item: UnverifiedItemView }

export interface RunStore {
  recordRun(input: RecordRunInput, now: Date): Promise<RecordRunOutcome>
  boardActivity(repoKey: string, now: Date): Promise<BoardActivity>
  issueActivity(repoKey: string, issue: number, now: Date): Promise<IssueActivity>
  activityFor(repoKey: string, issues: readonly number[], now: Date): Promise<ActivityForCards>
  /** Every live claim whose run status is a WaitingStatus, oldest since first, then by issue. */
  waitingClaims(repoKey: string, now: Date): Promise<WaitingClaim[]>
  releaseClaim(repoKey: string, issue: number, runId: string): Promise<ReleaseOutcome>
  acceptItem(input: AcceptInput, now: Date): Promise<AcceptOutcome>
}
