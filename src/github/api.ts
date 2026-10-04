import type { Issue, Label, RepoRef, RepoSnapshot, Repository, User } from '../domain/types.ts'
import { fetchAllPages, fetchJson, type GitHubTransport } from './paging.ts'

/** 10 pages × 100 items; enough for most boards without draining the rate limit. */
const MAX_PAGES = 10

// Only the fields we read. See https://docs.github.com/en/rest/issues
interface GhUser {
  login: string
  avatar_url: string
  html_url: string
}

interface GhLabel {
  name: string
  color: string
  description: string | null
}

export interface GhIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  state_reason?: string | null
  html_url: string
  labels: Array<string | Partial<GhLabel>>
  assignees?: GhUser[] | null
  user: GhUser | null
  milestone: { title: string } | null
  comments: number
  created_at: string
  updated_at: string
  closed_at: string | null
  /** Present when the item is a pull request; the issues API returns both. */
  pull_request?: unknown
  /** GitHub's Markdown body; null when the issue has none. */
  body?: string | null
}

interface GhRepository {
  full_name: string
  description: string | null
  html_url: string
  private: boolean
}

export interface SnapshotOptions {
  /** Load issues closed within this many days; `0` skips closed issues. */
  closedWindowDays: number
  transport: GitHubTransport
  signal?: AbortSignal
  /** Clock for the closed window and `fetchedAt`, in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** `false` skips the label pages and returns `labels: []`. Default `true`. */
  labels?: boolean
  /** `false` leaves `body` off every issue. Default `true`. */
  bodies?: boolean
}

export interface DetailedSnapshot {
  snapshot: RepoSnapshot
  /** Largest number on the raw open and closed pages, pull requests included; 0 when both are empty. */
  highestNumber: number
  /** Numbers of the pull requests on those pages. */
  pullRequests: number[]
  openTruncated: boolean
  closedTruncated: boolean
}

export async function fetchRepoSnapshotDetailed(
  repo: RepoRef,
  { closedWindowDays, transport, signal, now = Date.now, labels: withLabels = true, bodies: withBodies = true }: SnapshotOptions,
): Promise<DetailedSnapshot> {
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

  // Fetch the repository first: it fails fast (and cheaply) on typos or missing access.
  const repository = await fetchJson<GhRepository>(transport, base, signal)

  const startedAt = now()
  const sinceMs = closedWindowDays > 0 ? startedAt - closedWindowDays * 86_400_000 : null
  const since = sinceMs === null ? null : new Date(sinceMs).toISOString()
  const paging = { maxPages: MAX_PAGES, signal }

  const [labels, open, closed] = await Promise.all([
    withLabels
      ? fetchAllPages<GhLabel>(transport, `${base}/labels?per_page=100`, paging)
      : Promise.resolve({ items: [] as GhLabel[], truncated: false }),
    fetchAllPages<GhIssue>(transport, `${base}/issues?state=open&per_page=100`, paging),
    since
      ? fetchAllPages<GhIssue>(
          transport,
          `${base}/issues?state=closed&since=${encodeURIComponent(since)}&per_page=100`,
          paging,
        )
      : Promise.resolve({ items: [] as GhIssue[], truncated: false }),
  ])

  // `since` filters on last update; only keep issues that were actually closed in the window.
  const recentlyClosed = closed.items.filter(
    (issue) => sinceMs !== null && issue.closed_at !== null && Date.parse(issue.closed_at) >= sinceMs,
  )
  const raw = [...open.items, ...closed.items]

  return {
    snapshot: {
      repository: toRepository(repository),
      labels: labels.items.map(toLabel).sort((a, b) => a.name.localeCompare(b.name)),
      issues: [...open.items, ...recentlyClosed].filter(isIssue).map((item) => toIssue(item, withBodies)),
      truncated: open.truncated || closed.truncated,
      fetchedAt: now(),
    },
    highestNumber: raw.reduce((highest, item) => Math.max(highest, item.number), 0),
    pullRequests: raw.filter((item) => !isIssue(item)).map((item) => item.number),
    openTruncated: open.truncated,
    closedTruncated: closed.truncated,
  }
}

export async function fetchRepoSnapshot(repo: RepoRef, options: SnapshotOptions): Promise<RepoSnapshot> {
  return (await fetchRepoSnapshotDetailed(repo, options)).snapshot
}

function isIssue(item: GhIssue): boolean {
  return item.pull_request === undefined
}

function toRepository(repo: GhRepository): Repository {
  return {
    fullName: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    isPrivate: repo.private,
  }
}

function toLabel(label: GhLabel): Label {
  return { name: label.name, color: label.color, description: label.description }
}

function toUser(user: GhUser): User {
  return { login: user.login, avatarUrl: user.avatar_url, url: user.html_url }
}

/** `withBody` false leaves the `body` key off the result; true maps GitHub's null (or missing) body to ''. */
export function toIssue(issue: GhIssue, withBody = true): Issue {
  const mapped: Issue = {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    url: issue.html_url,
    labels: issue.labels
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter(Boolean),
    assignees: (issue.assignees ?? []).map(toUser),
    author: issue.user ? toUser(issue.user) : null,
    milestone: issue.milestone?.title ?? null,
    comments: issue.comments,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
  }
  if (withBody) mapped.body = typeof issue.body === 'string' ? issue.body : ''
  return mapped
}
