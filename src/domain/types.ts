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
}
