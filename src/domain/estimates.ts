import type { BoardConfig, Estimate, EstimateConfidence, EstimateSize } from './types.ts'

export const ESTIMATES_MAX = 2000
export const ESTIMATE_BY_MAX = 64
export const HUMAN_WAIT_LIMIT_MAX = 720

const CONFIDENCES: readonly EstimateConfidence[] = ['sure', 'unsure', 'no-idea']
const SIZES: readonly EstimateSize[] = ['S', 'M', 'L']
const ISSUE_KEY = /^[1-9][0-9]{0,9}$/
const MAX_ISSUE_NUMBER = 2_147_483_647
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for an estimate with a size exactly when the confidence is not 'no-idea', a stamped author and a timestamp. */
export function isEstimate(value: unknown): value is Estimate {
  if (!isPlainObject(value)) return false
  const { size, confidence, by, at } = value
  if (typeof confidence !== 'string' || !CONFIDENCES.includes(confidence as EstimateConfidence)) return false
  if (confidence === 'no-idea') {
    if (size !== null) return false
  } else if (typeof size !== 'string' || !SIZES.includes(size as EstimateSize)) {
    return false
  }
  if (typeof by !== 'string') return false
  const byLength = [...by].length
  if (byLength < 1 || byLength > ESTIMATE_BY_MAX) return false
  return typeof at === 'string' && ISO_TIMESTAMP.test(at)
}

/** True when `estimates` and `humanWaitLimit` are absent or valid. Called by isBoardConfig. */
export function validOptionalBoardFields(value: Record<string, unknown>): boolean {
  if ('estimates' in value && value.estimates !== undefined) {
    const estimates = value.estimates
    if (!isPlainObject(estimates)) return false
    const keys = Object.keys(estimates)
    if (keys.length > ESTIMATES_MAX) return false
    for (const key of keys) {
      if (!ISSUE_KEY.test(key) || Number(key) > MAX_ISSUE_NUMBER) return false
      if (!isEstimate(estimates[key])) return false
    }
  }
  if ('humanWaitLimit' in value && value.humanWaitLimit !== undefined) {
    const limit = value.humanWaitLimit
    if (limit !== null) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > HUMAN_WAIT_LIMIT_MAX) return false
    }
  }
  return true
}

export function setEstimate(config: BoardConfig, issue: number, estimate: Estimate): BoardConfig {
  return { ...config, estimates: { ...config.estimates, [issue]: estimate } }
}

/** Returns `config` itself when there is no estimate for the issue; drops `estimates` when the last one goes. */
export function clearEstimate(config: BoardConfig, issue: number): BoardConfig {
  if (!config.estimates || !(issue in config.estimates)) return config
  const { [issue]: _removed, ...rest } = config.estimates
  const { estimates: _previous, ...others } = config
  return Object.keys(rest).length === 0 ? others : { ...others, estimates: rest }
}

/** `next` with the estimates of `previous`, if it has any. Used when a board is reset: estimates are judgements about issues, not card positions. */
export function keepEstimates(next: BoardConfig, previous: BoardConfig): BoardConfig {
  if (!previous.estimates || Object.keys(previous.estimates).length === 0) return next
  return { ...next, estimates: previous.estimates }
}

/** 'M', 'M?' or '?'. A stored entry that fails isEstimate reads as no estimate, so callers pass only valid ones. */
export function estimateLabel(estimate: Estimate): string {
  if (!isEstimate(estimate)) return ''
  if (estimate.confidence === 'no-idea') return '?'
  return estimate.confidence === 'unsure' ? `${estimate.size}?` : `${estimate.size}`
}
