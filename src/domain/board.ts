import type { BoardConfig, Bucket, Issue, Label } from './types'

export const DEFAULT_CLOSED_WINDOW_DAYS = 14

interface BucketTemplate {
  id: string
  title: string
  collectsClosed?: boolean
  /** Normalized label names that are routed to this bucket on a new board. */
  synonyms: string[]
}

const DEFAULT_BUCKETS: BucketTemplate[] = [
  { id: 'backlog', title: 'Backlog', synonyms: ['backlog', 'icebox', 'triage', 'needstriage'] },
  { id: 'todo', title: 'To do', synonyms: ['todo', 'ready', 'next', 'upnext', 'selected'] },
  {
    id: 'in-progress',
    title: 'In progress',
    synonyms: ['inprogress', 'wip', 'doing', 'working', 'workinprogress', 'started'],
  },
  {
    id: 'in-review',
    title: 'In review',
    synonyms: ['inreview', 'review', 'needsreview', 'readyforreview', 'codereview'],
  },
  { id: 'done', title: 'Done', collectsClosed: true, synonyms: ['done', 'completed', 'resolved'] },
]

/**
 * Reduces a label name to its workflow keyword so that `Status: In Progress`,
 * `2 - In progress` and `in-progress` all compare equal.
 */
export function normalizeLabelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\d+\s*[-.:)]\s*/, '')
    .replace(/^(?:status|state|stage|kanban|workflow|column|board)\s*[:/-]\s*/, '')
    .replace(/[^a-z0-9]/g, '')
}

/** A fresh board; repo labels that look like workflow stages become routing rules. */
export function createDefaultBoard(labels: Label[]): BoardConfig {
  return {
    version: 1,
    buckets: DEFAULT_BUCKETS.map((template) => ({
      id: template.id,
      title: template.title,
      wipLimit: null,
      labelRules: labels
        .filter((label) => template.synonyms.includes(normalizeLabelName(label.name)))
        .map((label) => label.name),
      collectsClosed: template.collectsClosed ?? false,
    })),
    placements: {},
    order: {},
    closedWindowDays: DEFAULT_CLOSED_WINDOW_DAYS,
  }
}

export function newBucketId(): string {
  return `bucket-${crypto.randomUUID().slice(0, 8)}`
}

/** Issues in each bucket (keyed by bucket id), in display order. */
export type BucketContents = Map<string, Issue[]>

/**
 * Decides which bucket every issue belongs to:
 *
 * 1. Closed issues go to the bucket that collects closed issues (hidden if none).
 * 2. Open issues moved by hand stay where they were put.
 * 3. Otherwise the rightmost bucket with a matching label rule wins.
 * 4. Everything else lands in the first bucket that does not collect closed issues.
 */
export function resolveBuckets(issues: Issue[], config: BoardConfig): BucketContents {
  const contents: BucketContents = new Map(config.buckets.map((bucket) => [bucket.id, []]))
  if (config.buckets.length === 0) return contents

  const closedBucket = config.buckets.find((bucket) => bucket.collectsClosed)
  const fallback = config.buckets.find((bucket) => !bucket.collectsClosed) ?? config.buckets[0]

  for (const issue of issues) {
    const bucketId =
      issue.state === 'closed' ? closedBucket?.id : bucketForOpenIssue(issue, config, fallback.id)
    if (bucketId) contents.get(bucketId)?.push(issue)
  }
  for (const [bucketId, list] of contents) {
    sortBucket(list, config.order[bucketId])
  }
  return contents
}

function bucketForOpenIssue(issue: Issue, config: BoardConfig, fallbackId: string): string {
  const placed = config.placements[issue.number]
  if (placed && config.buckets.some((bucket) => bucket.id === placed)) return placed

  const labels = new Set(issue.labels.map((label) => label.toLowerCase()))
  for (let i = config.buckets.length - 1; i >= 0; i--) {
    const bucket = config.buckets[i]
    if (bucket.labelRules.some((rule) => labels.has(rule.toLowerCase()))) return bucket.id
  }
  return fallbackId
}

/** Hand-ordered issues first; the rest by most recent activity (closed or created). */
function sortBucket(list: Issue[], preferred: number[] | undefined): void {
  const rank = new Map(preferred?.map((number, index) => [number, index]))
  list.sort((a, b) => {
    const rankA = rank.get(a.number)
    const rankB = rank.get(b.number)
    if (rankA !== undefined || rankB !== undefined) {
      return (rankA ?? Infinity) - (rankB ?? Infinity)
    }
    const activity = (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt)
    return activity || b.number - a.number
  })
}

export function findBucketOf(contents: BucketContents, issueNumber: number): string | undefined {
  for (const [bucketId, list] of contents) {
    if (list.some((issue) => issue.number === issueNumber)) return bucketId
  }
  return undefined
}

/**
 * Moves an open issue into `toBucketId`, right before `beforeIssueNumber`
 * (or at the end when it is `null` or not in that bucket).
 *
 * The position is computed against the full bucket, not just the visible
 * cards, so cards hidden by a filter keep their relative order.
 */
export function moveIssue(
  config: BoardConfig,
  issues: Issue[],
  issueNumber: number,
  toBucketId: string,
  beforeIssueNumber: number | null,
): BoardConfig {
  const issue = issues.find((candidate) => candidate.number === issueNumber)
  if (!issue || issue.state === 'closed') return config
  if (!config.buckets.some((bucket) => bucket.id === toBucketId)) return config

  const contents = resolveBuckets(issues, config)
  const fromBucketId = findBucketOf(contents, issueNumber)

  const target = (contents.get(toBucketId) ?? [])
    .map((candidate) => candidate.number)
    .filter((number) => number !== issueNumber)
  const beforeIndex = beforeIssueNumber === null ? -1 : target.indexOf(beforeIssueNumber)
  target.splice(beforeIndex === -1 ? target.length : beforeIndex, 0, issueNumber)

  const order: Record<string, number[]> = {}
  for (const [bucketId, numbers] of Object.entries(config.order)) {
    order[bucketId] = numbers.filter((number) => number !== issueNumber)
  }
  order[toBucketId] = target

  const placements =
    fromBucketId === toBucketId
      ? config.placements
      : { ...config.placements, [issueNumber]: toBucketId }

  return { ...config, placements, order }
}

/** Adds a bucket or replaces the one with the same id. */
export function saveBucket(config: BoardConfig, bucket: Bucket): BoardConfig {
  const exists = config.buckets.some((candidate) => candidate.id === bucket.id)
  let buckets = exists
    ? config.buckets.map((candidate) => (candidate.id === bucket.id ? bucket : candidate))
    : [...config.buckets, bucket]
  if (bucket.collectsClosed) {
    buckets = buckets.map((candidate) =>
      candidate.id === bucket.id ? candidate : { ...candidate, collectsClosed: false },
    )
  }
  return { ...config, buckets }
}

/** Removes a bucket; its issues fall back to label rules or the default bucket. */
export function deleteBucket(config: BoardConfig, bucketId: string): BoardConfig {
  if (config.buckets.length <= 1) return config
  const placements: Record<number, string> = {}
  for (const [issueNumber, placedIn] of Object.entries(config.placements)) {
    if (placedIn !== bucketId) placements[Number(issueNumber)] = placedIn
  }
  const order = { ...config.order }
  delete order[bucketId]
  return {
    ...config,
    buckets: config.buckets.filter((bucket) => bucket.id !== bucketId),
    placements,
    order,
  }
}

export function moveBucket(config: BoardConfig, bucketId: string, offset: -1 | 1): BoardConfig {
  const index = config.buckets.findIndex((bucket) => bucket.id === bucketId)
  const target = index + offset
  if (index === -1 || target < 0 || target >= config.buckets.length) return config
  const buckets = [...config.buckets]
  ;[buckets[index], buckets[target]] = [buckets[target], buckets[index]]
  return { ...config, buckets }
}

/** The JSON file written by "Export board". */
export interface BoardExport {
  app: 'urutau'
  repository: string
  exportedAt: string
  board: BoardConfig
}

export function toBoardExport(board: BoardConfig, repository: string): BoardExport {
  return { app: 'urutau', repository, exportedAt: new Date().toISOString(), board }
}

/**
 * Reads an exported board for `repository`, or returns `null` if the file is not one.
 *
 * Card positions refer to issue numbers, which only mean something in the
 * repository they came from. A board exported elsewhere (or a bare config of
 * unknown origin) keeps its buckets and rules but starts with fresh positions.
 */
export function boardFromExport(file: unknown, repository: string): BoardConfig | null {
  const wrapped = file !== null && typeof file === 'object' && 'board' in file
  const board: unknown = wrapped ? (file as { board: unknown }).board : file
  if (!isBoardConfig(board)) return null

  const source: unknown = wrapped ? (file as { repository?: unknown }).repository : undefined
  const sameRepository =
    typeof source === 'string' && source.toLowerCase() === repository.toLowerCase()
  return sameRepository ? board : { ...board, placements: {}, order: {} }
}

/** Light structural validation for configs coming from storage or an imported file. */
export function isBoardConfig(value: unknown): value is BoardConfig {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BoardConfig>
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.buckets) &&
    candidate.buckets.length > 0 &&
    candidate.buckets.every(
      (bucket) =>
        typeof bucket?.id === 'string' &&
        typeof bucket.title === 'string' &&
        Array.isArray(bucket.labelRules) &&
        typeof bucket.collectsClosed === 'boolean' &&
        (bucket.wipLimit === null || typeof bucket.wipLimit === 'number'),
    ) &&
    typeof candidate.placements === 'object' &&
    candidate.placements !== null &&
    typeof candidate.order === 'object' &&
    candidate.order !== null &&
    typeof candidate.closedWindowDays === 'number'
  )
}
