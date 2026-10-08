/** The JSON the read tools return, built from a stored board and a snapshot. */
import { isBoardConfig, resolveBuckets } from '../../src/domain/board.ts'
import type { BoardSummary, StoredBoard } from '../../src/domain/api.ts'
import { isOverWaitLimit } from '../../src/domain/activity.ts'
import { isEstimate } from '../../src/domain/estimates.ts'
import type { BoardConfig, Issue } from '../../src/domain/types.ts'
import type { ActivityForCards, WaitingClaim } from '../runs/types.ts'
import { cleanText, type BucketIds } from './clean.ts'
import {
  DISPLAY_CAPS,
  MCP_LIMITS,
  type BoardListEntryJson,
  type BoardSnapshot,
  type BucketJson,
  type CardJson,
  type EditorJson,
  type EditorKind,
  type GetBoardJson,
  type ListBoardsJson,
} from './contract.ts'

export interface BoardJsonOptions {
  /** Stored bucket ids to include, in any order (output keeps board order); null for every bucket. */
  buckets: readonly string[] | null
  limitPerBucket: number
  offset: number
  includeClosed: boolean
}

function cleanList(values: readonly unknown[], max: number, limit: number): string[] {
  const out: string[] = []
  for (const value of values) {
    const text = cleanText(value, max)
    if (text) out.push(text)
    if (out.length === limit) break
  }
  return out
}

/** What get_board reads from the run store, for the cards of one answer. */
export interface BoardActivityInput extends ActivityForCards {
  waiting: readonly WaitingClaim[]
  now: Date
}

function cardJson(issue: Issue, config: BoardConfig, activity: BoardActivityInput): CardJson {
  const estimate = config.estimates?.[issue.number]
  const lastRun = activity.lastRuns.get(issue.number)
  const claim = activity.claims.get(issue.number)
  return {
    number: issue.number,
    title: cleanText(issue.title, DISPLAY_CAPS.title),
    state: issue.state,
    labels: cleanList(issue.labels, DISPLAY_CAPS.label, DISPLAY_CAPS.labelsPerCard),
    assignees: cleanList(
      issue.assignees.map((user) => user.login),
      DISPLAY_CAPS.login,
      DISPLAY_CAPS.assigneesPerCard,
    ),
    milestone: issue.milestone === null ? null : cleanText(issue.milestone, DISPLAY_CAPS.milestone),
    comments: issue.comments,
    updatedAt: cleanText(issue.updatedAt, DISPLAY_CAPS.timestamp),
    estimate:
      estimate !== undefined && isEstimate(estimate)
        ? {
            size: estimate.size,
            confidence: estimate.confidence,
            by: cleanText(estimate.by, DISPLAY_CAPS.username),
            at: cleanText(estimate.at, DISPLAY_CAPS.timestamp),
          }
        : null,
    lastRun: lastRun
      ? { status: lastRun.status, triageRange: lastRun.triageRange, unverifiedOpen: lastRun.unverifiedOpen, runId: lastRun.runId }
      : null,
    claim: claim ? { runId: claim.runId, status: claim.status, since: claim.since } : null,
  }
}

interface ShownBuckets {
  chosen: BoardConfig['buckets']
  selected: BoardConfig['buckets']
  shown: { bucket: BoardConfig['buckets'][number]; list: Issue[] }[]
  closedHidden: number
}

/** The buckets an answer covers and each one's cards in display order, before offset, limit and the card budget. */
function shownBuckets(config: BoardConfig, snapshot: BoardSnapshot, options: BoardJsonOptions): ShownBuckets {
  const wanted = options.buckets ? new Set(options.buckets) : null
  const chosen = config.buckets.filter((bucket) => !wanted || wanted.has(bucket.id))
  const selected = chosen.slice(0, MCP_LIMITS.bucketsPerAnswer)
  const contents = resolveBuckets(snapshot.issues, config)

  let closedHidden = 0
  const shown = selected.map((bucket) => {
    const all = contents.get(bucket.id) ?? []
    if (options.includeClosed) return { bucket, list: all }
    const list = all.filter((issue) => issue.state !== 'closed')
    closedHidden += all.length - list.length
    return { bucket, list }
  })
  return { chosen, selected, shown, closedHidden }
}

/** The numbers of the cards in the windows (offset and limit) of the buckets an answer covers, before the card budget. */
export function windowNumbers(stored: StoredBoard, snapshot: BoardSnapshot, options: BoardJsonOptions): number[] {
  const { shown } = shownBuckets(stored.board, snapshot, options)
  return shown.flatMap(({ list }) => list.slice(options.offset, options.offset + options.limitPerBucket).map((issue) => issue.number))
}

/** get_board's answer, with the card budget applied. */
export function boardJson(
  stored: StoredBoard,
  snapshot: BoardSnapshot,
  ids: BucketIds,
  options: BoardJsonOptions,
  activity: BoardActivityInput,
): GetBoardJson {
  const config = stored.board
  const { chosen, selected, shown, closedHidden } = shownBuckets(config, snapshot, options)

  const buckets: BucketJson[] = shown.map(({ bucket, list }) => ({
    id: ids.toOutput(bucket.id),
    title: cleanText(bucket.title, DISPLAY_CAPS.bucketTitle),
    wipLimit: bucket.wipLimit,
    collectsClosed: bucket.collectsClosed,
    labelRules: bucket.labelRules
      .slice(0, DISPLAY_CAPS.labelRulesPerBucket)
      .map((rule) => cleanText(rule, DISPLAY_CAPS.label))
      .filter(Boolean),
    total: list.length,
    offset: options.offset,
    more: false,
    cards: [],
  }))

  const answer: GetBoardJson = {
    repo: stored.repoKey,
    fullName: cleanText(stored.fullName, DISPLAY_CAPS.fullName),
    private: snapshot.isPrivate,
    version: stored.version,
    updatedAt: stored.updatedAt,
    updatedBy: editorJson(stored.updatedBy),
    fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    truncated: snapshot.truncated,
    closedWindowDays: config.closedWindowDays,
    closedHidden,
    cardBudgetReached: false,
    bucketsOmitted: chosen.length - selected.length,
    humanWaitLimit: config.humanWaitLimit ?? null,
    waitingOnHuman: activity.waiting.map((waiting) => ({
      issue: waiting.issue,
      runId: waiting.runId,
      status: waiting.status,
      since: waiting.since,
      overLimit: isOverWaitLimit(
        { status: waiting.status, leaseUntil: null, since: waiting.since },
        config.humanWaitLimit ?? null,
        activity.now.getTime(),
      ),
    })),
    buckets,
  }

  let used = JSON.stringify(answer).length
  let cardCount = 0
  walk: for (let i = 0; i < shown.length; i++) {
    const window = shown[i].list.slice(options.offset, options.offset + options.limitPerBucket)
    for (const issue of window) {
      const card = cardJson(issue, config, activity)
      const size = JSON.stringify(card).length + 1
      if (cardCount >= MCP_LIMITS.cardsPerAnswer || used + size > MCP_LIMITS.answerChars) {
        answer.cardBudgetReached = true
        break walk
      }
      buckets[i].cards.push(card)
      cardCount++
      used += size
    }
  }
  for (const bucket of buckets) bucket.more = bucket.offset + bucket.cards.length < bucket.total
  return answer
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** list_boards' answer: the given summaries (already filtered to the list), and the listed keys without a board. */
export function boardListJson(
  summaries: readonly BoardSummary[],
  listed: ReadonlySet<string>,
): ListBoardsJson {
  const boards: BoardListEntryJson[] = [...summaries]
    .sort((a, b) => byCodeUnit(b.updatedAt, a.updatedAt) || byCodeUnit(a.repoKey, b.repoKey))
    .map((summary) => ({
      repo: summary.repoKey,
      fullName: cleanText(summary.fullName, DISPLAY_CAPS.fullName),
      version: summary.version,
      updatedAt: summary.updatedAt,
      updatedBy: editorJson(summary.updatedBy),
    }))
  const present = new Set(summaries.map((summary) => summary.repoKey))
  const reposWithoutBoard = [...listed].filter((key) => !present.has(key)).sort()
  return { boards, reposWithoutBoard }
}

/** { username (cleaned), kind } or null; a missing kind reads as 'person'. */
export function editorJson(
  editor: { username: string; kind?: EditorKind } | null,
): EditorJson | null {
  if (!editor) return null
  return { username: cleanText(editor.username, DISPLAY_CAPS.username), kind: editor.kind ?? 'person' }
}

const isNumberList = (value: unknown) =>
  Array.isArray(value) && value.every((entry) => Number.isInteger(entry))

/** isBoardConfig, plus: every labelRules entry and placements value is a string, every order value is a list of integers, closedWindowDays is a finite number from 0. resolveBuckets throws on a board that fails these. */
export function readableBoard(config: unknown): config is BoardConfig {
  if (!isBoardConfig(config)) return false
  return (
    config.buckets.every((bucket) => bucket.labelRules.every((rule) => typeof rule === 'string')) &&
    Object.values(config.placements).every((placed) => typeof placed === 'string') &&
    Object.values(config.order).every(isNumberList) &&
    Number.isFinite(config.closedWindowDays) &&
    config.closedWindowDays >= 0
  )
}
