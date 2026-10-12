import type {
  Estimate,
  EstimateSize,
  RunStatus,
  TerminalStatus,
  TriageRange,
  UnverifiedCounts,
  WaitingStatus,
} from './types.ts'

export const WAITING_STATUSES: readonly WaitingStatus[] = ['awaiting_approval', 'needs_human', 'budget_exceeded']
export const TERMINAL_STATUSES: readonly TerminalStatus[] = ['done', 'failed', 'rejected', 'plan_only']

export function isWaitingStatus(status: RunStatus): status is WaitingStatus {
  return (WAITING_STATUSES as readonly string[]).includes(status)
}

export function isTerminalStatus(status: RunStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** null when there are no open items; else e.g. '3 unverified (external, normative)'. */
export function unverifiedFlagText(counts: UnverifiedCounts): string | null {
  const n = counts.external + counts.normative + counts.untested
  if (n === 0) return null
  const kinds = (['external', 'normative', 'untested'] as const).filter((kind) => counts[kind] > 0)
  return `${n} unverified (${kinds.join(', ')})`
}

const SIZE_ORDER: readonly EstimateSize[] = ['S', 'M', 'L']
const RANGE_BOUNDS: Record<TriageRange, [EstimateSize, EstimateSize]> = {
  S: ['S', 'S'],
  M: ['M', 'M'],
  L: ['L', 'L'],
  'S-M': ['S', 'M'],
  'M-L': ['M', 'L'],
  'S-L': ['S', 'L'],
}

/** 'M' for a one-size range, else e.g. 'S–M' (en dash). */
export function triageRangeText(range: TriageRange): string {
  const [low, high] = RANGE_BOUNDS[range]
  return low === high ? low : `${low}–${high}`
}

/** The sizes a range spans, smallest first: 'S-L' → ['S', 'M', 'L']. */
export function triageRangeSizes(range: TriageRange): EstimateSize[] {
  const [low, high] = RANGE_BOUNDS[range]
  return SIZE_ORDER.slice(SIZE_ORDER.indexOf(low), SIZE_ORDER.indexOf(high) + 1)
}

/** True when a person's estimate has a size and it is outside the run's triage range. */
export function triageDisagrees(estimate: Estimate | null, range: TriageRange | null): boolean {
  if (!estimate || estimate.size === null || range === null) return false
  const bounds = RANGE_BOUNDS[range]
  if (!bounds) return false
  const [low, high] = bounds
  const at = SIZE_ORDER.indexOf(estimate.size)
  return at < SIZE_ORDER.indexOf(low) || at > SIZE_ORDER.indexOf(high)
}

/** 'carcara: S–M' named after the agent, or 'triage: S–M' when the agent is unknown. */
export function triageTagText(range: TriageRange, agentName: string | null): string {
  return `${agentName ?? 'triage'}: ${triageRangeText(range)}`
}

/** null unless the estimate's size is outside the run's triage range; else e.g. 'triage: M–L' (en dash). */
export function triageFlagText(estimate: Estimate | null, range: TriageRange | null): string | null {
  if (range === null || !triageDisagrees(estimate, range)) return null
  return triageTagText(range, null)
}

const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  needs_human: 'Needs a human',
  budget_exceeded: 'Budget exceeded',
  done: 'Done',
  failed: 'Failed',
  rejected: 'Rejected',
  plan_only: 'Question answered',
}

export function statusLabel(status: RunStatus): string {
  return STATUS_LABELS[status]
}

/** A plan_only run that sent a triage range sized the issue: 'Sized'; otherwise the status label. */
export function runOutcomeLabel(run: { status: RunStatus; triageRange: TriageRange | null }): string {
  return run.status === 'plan_only' && run.triageRange !== null ? 'Sized' : statusLabel(run.status)
}

/** A claim with no lease (waiting on a human) never expires; otherwise it is live until its lease passes. */
export function claimIsLive(claim: { leaseUntil: string | null }, nowMs: number): boolean {
  return claim.leaseUntil === null || Date.parse(claim.leaseUntil) > nowMs
}

/** 'just now', '<m> min', '<h> h', '<d> d', rounded down. */
export function ageText(sinceIso: string, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - Date.parse(sinceIso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

export function isWaitingClaim(
  claim: { status: RunStatus; leaseUntil: string | null } | null,
  nowMs: number,
): boolean {
  return claim !== null && claimIsLive(claim, nowMs) && isWaitingStatus(claim.status)
}

/** A waiting claim older than the limit, strictly: the same rule as a bucket's WIP limit. With a null limit no claim is over it. */
export function isOverWaitLimit(
  claim: { status: RunStatus; leaseUntil: string | null; since: string } | null,
  limitHours: number | null,
  nowMs: number,
): boolean {
  return (
    limitHours !== null &&
    claim !== null &&
    isWaitingClaim(claim, nowMs) &&
    nowMs - Date.parse(claim.since) > limitHours * 3_600_000
  )
}

export function humanWaitState(
  cards: readonly { claim: { status: RunStatus; leaseUntil: string | null; since: string } | null }[],
  limitHours: number | null,
  nowMs: number,
): { waiting: number; over: number; limitHours: number | null } {
  let waiting = 0
  let over = 0
  for (const { claim } of cards) {
    if (isWaitingClaim(claim, nowMs)) waiting += 1
    if (isOverWaitLimit(claim, limitHours, nowMs)) over += 1
  }
  return { waiting, over, limitHours }
}
