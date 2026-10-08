/**
 * Provider-agnostic domain model. The GitHub layer maps API payloads into
 * these shapes so the rest of the app never touches raw API responses.
 */

export interface RepoRef {
  owner: string
  name: string
}

export interface Repository {
  fullName: string
  description: string | null
  url: string
  isPrivate: boolean
}

export interface Label {
  name: string
  /** Hex color without the leading `#`, as GitHub stores it. */
  color: string
  description: string | null
}

export interface User {
  login: string
  avatarUrl: string
  url: string
}

export type IssueState = 'open' | 'closed'

export interface Issue {
  number: number
  title: string
  state: IssueState
  /** Why the issue was closed (e.g. `completed`, `not_planned`), if known. */
  stateReason: string | null
  url: string
  labels: string[]
  assignees: User[]
  author: User | null
  milestone: string | null
  comments: number
  createdAt: string
  updatedAt: string
  closedAt: string | null
  /**
   * The issue's Markdown description as GitHub returned it with the issue list (or the create
   * response); '' when GitHub's `body` is null. Absent on issues read without bodies: the server's
   * reader for agent integrations, and test data that does not set it.
   */
  body?: string
}

export interface RepoSnapshot {
  repository: Repository
  labels: Label[]
  issues: Issue[]
  /** True when the provider had more issues than we were willing to page through. */
  truncated: boolean
  fetchedAt: number
}

/** A kanban column. */
export interface Bucket {
  id: string
  title: string
  /** Soft limit on the number of open issues in the bucket; `null` means no limit. */
  wipLimit: number | null
  /** Open issues with any of these labels start in this bucket until moved by hand. */
  labelRules: string[]
  /** Closed issues always land here. At most one bucket on a board sets this. */
  collectsClosed: boolean
}

export interface BoardConfig {
  version: 1
  buckets: Bucket[]
  /** Bucket chosen by hand for an issue, keyed by issue number. Wins over label rules. */
  placements: Record<number, string>
  /** Preferred order of issue numbers inside each bucket, keyed by bucket id. */
  order: Record<string, number[]>
  /** How many days of closed issues to load; `0` hides closed issues. */
  closedWindowDays: number
  /** Size estimates people set, keyed by issue number. Absent on boards and files from before estimates. At most 2000 keys. */
  estimates?: Record<number, Estimate>
  /** Hours a card may wait on a human before it turns red; null or absent: no limit. Whole number 1-720. */
  humanWaitLimit?: number | null
}

export type EstimateSize = 'S' | 'M' | 'L'
export type EstimateConfidence = 'sure' | 'unsure' | 'no-idea'

export interface Estimate {
  /** null only when confidence is 'no-idea'; required otherwise. */
  size: EstimateSize | null
  confidence: EstimateConfidence
  /** Username of the person who set it, as the server stamped it. 1-64 code points. */
  by: string
  /** When the server stored it: Date.prototype.toISOString() output. */
  at: string
}

export type RunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'needs_human'
  | 'budget_exceeded'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'plan_only'
export type WaitingStatus = 'awaiting_approval' | 'needs_human' | 'budget_exceeded'
export type HoldingStatus = 'running' | WaitingStatus
export type TerminalStatus = 'done' | 'failed' | 'rejected' | 'plan_only'

/** Printed in this order everywhere: external, normative, untested. */
export type ItemKind = 'external' | 'normative' | 'untested'
export type TriageRange = 'S' | 'M' | 'L' | 'S-M' | 'M-L' | 'S-L'
export type UncertaintyKind = ItemKind | 'none'

export interface UnverifiedItem {
  /** Chosen by the agent, stable across retries: ^[A-Za-z0-9._-]{1,32}$, unique within the run. */
  id: string
  kind: ItemKind
  /** Plain text after cleaning, 1-280 code points. */
  text: string
  /** When the agent withdrew the item; absent while it is not withdrawn. Never set on normative items. */
  withdrawnAt?: string
}

export interface UnverifiedCounts {
  external: number
  normative: number
  untested: number
}
