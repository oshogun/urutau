import type { Issue } from './types.ts'

/**
 * Sentinel for "no assignee" / "no milestone". GitHub logins and milestone
 * titles are never empty, so it cannot collide with a real value.
 */
export const NONE = ''

export interface BoardFilters {
  text: string
  /** Matches issues carrying any of these labels. */
  labels: string[]
  /** `null` matches anyone, `NONE` matches unassigned issues. */
  assignee: string | null
  /** `null` matches any milestone, `NONE` matches issues without one. */
  milestone: string | null
}

export const EMPTY_FILTERS: BoardFilters = { text: '', labels: [], assignee: null, milestone: null }

export function isFiltering(filters: BoardFilters): boolean {
  return (
    filters.text.trim() !== '' ||
    filters.labels.length > 0 ||
    filters.assignee !== null ||
    filters.milestone !== null
  )
}

export function matchesFilters(issue: Issue, filters: BoardFilters): boolean {
  if (filters.labels.length > 0 && !issue.labels.some((label) => filters.labels.includes(label))) {
    return false
  }
  if (filters.assignee !== null) {
    const matches =
      filters.assignee === NONE
        ? issue.assignees.length === 0
        : issue.assignees.some((assignee) => assignee.login === filters.assignee)
    if (!matches) return false
  }
  if (filters.milestone !== null && (issue.milestone ?? NONE) !== filters.milestone) {
    return false
  }
  const terms = filters.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length > 0) {
    const haystack = `#${issue.number} ${issue.title} ${issue.author?.login ?? ''}`.toLowerCase()
    if (!terms.every((term) => haystack.includes(term))) return false
  }
  return true
}

/** Number of loaded issues that carry each label. */
export function countLabels(issues: Issue[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const issue of issues) {
    for (const label of issue.labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return counts
}
