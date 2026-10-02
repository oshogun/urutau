import type { BoardConfig, Bucket, Issue, Label } from '../domain/types'

export function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    stateReason: null,
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    assignees: [],
    author: null,
    milestone: null,
    comments: 0,
    createdAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`,
    updatedAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`,
    closedAt: null,
    ...overrides,
  }
}

export function makeLabel(name: string, color = 'cccccc'): Label {
  return { name, color, description: null }
}

export function makeBucket(id: string, overrides: Partial<Bucket> = {}): Bucket {
  return { id, title: id, wipLimit: null, labelRules: [], collectsClosed: false, ...overrides }
}

export function makeBoard(buckets: Bucket[], overrides: Partial<BoardConfig> = {}): BoardConfig {
  return { version: 1, buckets, placements: {}, order: {}, closedWindowDays: 14, ...overrides }
}
