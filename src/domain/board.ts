import type { BoardConfig, Bucket, Issue, Label } from './types.ts'

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

export type MovePosition = 'top' | 'bottom' | 'before' | 'after'

/** The numbers of the issues in one bucket, in display order; [] for an unknown bucket. */
export function bucketNumbers(contents: BucketContents, bucketId: string): number[] {
  return (contents.get(bucketId) ?? []).map((issue) => issue.number)
}

export interface PlannedMove {
  config: BoardConfig
  /** The bucket the card was in ('' when it was in none). */
  from: string
  to: string
  /** The target bucket's display order after the move. */
  expected: number[]
  /** The card's index in expected; -1 when a precondition failed. */
  index: number
  changed: boolean
}

const sameNumbers = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((number, index) => number === b[index])

/**
 * Moves an open issue within or into `toBucketId` to `position`. Positions are counted with the
 * moving card removed from the target first, because `moveIssue` removes it before it inserts,
 * so "11 after 10" on [10, 11, 12] is a move that changes nothing.
 *
 * When the issue is missing or closed, the bucket does not exist, or a `before`/`after` anchor
 * is not a card of the target, the config comes back unchanged with `index` -1.
 */
export function moveIssueTo(
  config: BoardConfig,
  issues: Issue[],
  issueNumber: number,
  toBucketId: string,
  position: MovePosition,
  anchor: number | null,
): PlannedMove {
  const contents = resolveBuckets(issues, config)
  const from = findBucketOf(contents, issueNumber)
  const current = bucketNumbers(contents, toBucketId)
  const target = current.filter((number) => number !== issueNumber)
  const issue = issues.find((candidate) => candidate.number === issueNumber)
  const anchorIndex = anchor === null ? -1 : target.indexOf(anchor)
  const failed =
    !issue ||
    issue.state === 'closed' ||
    !config.buckets.some((bucket) => bucket.id === toBucketId) ||
    ((position === 'before' || position === 'after') && anchorIndex === -1)
  if (failed) {
    return { config, from: from ?? '', to: toBucketId, expected: current, index: -1, changed: false }
  }

  const index =
    position === 'top'
      ? 0
      : position === 'bottom'
        ? target.length
        : position === 'before'
          ? anchorIndex
          : anchorIndex + 1
  const expected = [...target.slice(0, index), issueNumber, ...target.slice(index)]
  const next = moveIssue(config, issues, issueNumber, toBucketId, expected[index + 1] ?? null)
  const changed = !(from === toBucketId && sameNumbers(expected, current))
  return { config: next, from: from ?? '', to: toBucketId, expected, index, changed }
}

export interface PlannedReorder {
  config: BoardConfig
  expected: number[]
  changed: boolean
}

/**
 * Puts the `wanted` cards first in `bucketId`, in the listed order, and the bucket's other cards
 * after them in their current order. Placements are not touched.
 */
export function reorderBucket(
  config: BoardConfig,
  issues: Issue[],
  bucketId: string,
  wanted: readonly number[],
): PlannedReorder {
  const current = bucketNumbers(resolveBuckets(issues, config), bucketId)
  const expected = [...wanted, ...current.filter((number) => !wanted.includes(number))]
  return {
    config: { ...config, order: { ...config.order, [bucketId]: expected } },
    expected,
    changed: !sameNumbers(expected, current),
  }
}

export interface UnseenOrderOptions {
  truncated: boolean
  highestNumber: number
  /** The numbers of the cards the change placed: the moved issue, or reorder_bucket's listed order. */
  moved: ReadonlySet<number>
  /**
   * True when the change put the moved card against the card after it or against the bucket's
   * end (bottom or before): an unseen number that lands next to moved cards goes before them.
   * False for top, after and reorder_bucket: it goes after them.
   */
  unseenBeforeMoved: boolean
}

/**
 * Puts back hand order of numbers the caller's snapshot did not contain (new issues newer than
 * `highestNumber`, or any number when the snapshot was truncated). The stored order is walked
 * from its last number to its first. Each such number goes right before the next later number of
 * the stored order that is in the result and is not in `moved`, or at the end when there is none.
 * Numbers this call already put back count as found, so consecutive unseen numbers keep their
 * stored order, and a number stored twice is put back once. A moved card's old place therefore
 * never decides where an unseen number goes; `unseenBeforeMoved` picks the side of any moved
 * cards next to that place. Other unseen numbers are dropped. Returns `next` itself when nothing
 * was put back.
 */
export function keepUnseenOrder(
  stored: BoardConfig,
  next: BoardConfig,
  bucketId: string,
  seen: ReadonlySet<number>,
  options: UnseenOrderOptions,
): BoardConfig {
  const storedOrder = stored.order[bucketId] ?? []
  const result = [...(next.order[bucketId] ?? [])]
  let kept = false

  for (let i = storedOrder.length - 1; i >= 0; i--) {
    const u = storedOrder[i]
    if (seen.has(u) || result.includes(u)) continue
    if (!(u > options.highestNumber || options.truncated)) continue

    let k = result.length
    for (let j = i + 1; j < storedOrder.length; j++) {
      const candidate = storedOrder[j]
      if (options.moved.has(candidate)) continue
      const at = result.indexOf(candidate)
      if (at !== -1) {
        k = at
        break
      }
    }
    if (options.unseenBeforeMoved) {
      while (k > 0 && options.moved.has(result[k - 1])) k--
    }
    result.splice(k, 0, u)
    kept = true
  }

  if (!kept) return next
  return { ...next, order: { ...next.order, [bucketId]: result } }
}

/**
 * Puts a just-created issue at the top of `bucketId` and records the bucket in `placements`,
 * whatever the bucket's label rules say, so the card stays there if labels change later.
 * Returns `config` itself when `bucketId` is not a bucket of the board.
 */
export function placeNewIssue(config: BoardConfig, issueNumber: number, bucketId: string): BoardConfig {
  if (!config.buckets.some((bucket) => bucket.id === bucketId)) return config

  const order: Record<string, number[]> = {}
  for (const [id, numbers] of Object.entries(config.order)) {
    order[id] = numbers.filter((number) => number !== issueNumber)
  }
  order[bucketId] = [issueNumber, ...(order[bucketId] ?? [])]

  return { ...config, placements: { ...config.placements, [issueNumber]: bucketId }, order }
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
