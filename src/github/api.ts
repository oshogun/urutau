import type { Issue, Label, RepoRef, RepoSnapshot, Repository, User } from '../domain/types'
import { getAllPages, getJson, type RequestOptions } from './client'

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

interface GhIssue {
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
}

interface GhRepository {
  full_name: string
  description: string | null
  html_url: string
  private: boolean
}

export interface SnapshotOptions extends RequestOptions {
  /** Load issues closed within this many days; `0` skips closed issues. */
  closedWindowDays: number
}

export async function fetchRepoSnapshot(
  repo: RepoRef,
  { closedWindowDays, ...options }: SnapshotOptions,
): Promise<RepoSnapshot> {
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

  // Fetch the repository first: it fails fast (and cheaply) on typos or missing access.
  const repository = await getJson<GhRepository>(base, options)

  const sinceMs = closedWindowDays > 0 ? Date.now() - closedWindowDays * 86_400_000 : null
  const since = sinceMs === null ? null : new Date(sinceMs).toISOString()
  const paging = { ...options, maxPages: MAX_PAGES }

  const [labels, open, closed] = await Promise.all([
    getAllPages<GhLabel>(`${base}/labels?per_page=100`, paging),
    getAllPages<GhIssue>(`${base}/issues?state=open&per_page=100`, paging),
    since
      ? getAllPages<GhIssue>(
          `${base}/issues?state=closed&since=${encodeURIComponent(since)}&per_page=100`,
          paging,
        )
      : Promise.resolve({ items: [] as GhIssue[], truncated: false }),
  ])

  // `since` filters on last update; only keep issues that were actually closed in the window.
  const recentlyClosed = closed.items.filter(
    (issue) => sinceMs !== null && issue.closed_at !== null && Date.parse(issue.closed_at) >= sinceMs,
  )

  return {
    repository: toRepository(repository),
    labels: labels.items.map(toLabel).sort((a, b) => a.name.localeCompare(b.name)),
    issues: [...open.items, ...recentlyClosed].filter(isIssue).map(toIssue),
    truncated: open.truncated || closed.truncated,
    fetchedAt: Date.now(),
  }
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

export function toIssue(issue: GhIssue): Issue {
  return {
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
}
