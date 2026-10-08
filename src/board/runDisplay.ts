import { ApiError } from '../api/client'
import type { ActorView, ClaimView } from '../domain/api'
import { ageText, isOverWaitLimit, isWaitingClaim, statusLabel } from '../domain/activity'
import type { Estimate, EstimateSize } from '../domain/types'

const SIZE_WORDS: Record<EstimateSize, string> = {
  S: 'small',
  M: 'medium',
  L: 'large',
}

/** 'Estimate: medium, unsure' for screen readers; the tag itself shows 'M?'. */
export function estimateDescription(estimate: Estimate): string {
  if (estimate.confidence === 'no-idea' || estimate.size === null) return 'Estimate: no idea'
  return `Estimate: ${SIZE_WORDS[estimate.size]}, ${estimate.confidence}`
}

export function holderName(holder: ActorView | null): string {
  return holder ? holder.username : 'a removed integration'
}

/** 'Running · 12 min'; the age counts from the moment the run entered its status. */
export function claimText(claim: ClaimView, now: number): string {
  return `${statusLabel(claim.status)} · ${ageText(claim.since, now)}`
}

export type ClaimTone = 'running' | 'waiting' | 'over-limit'

export function claimTone(claim: ClaimView, limitHours: number | null, now: number): ClaimTone {
  if (isOverWaitLimit(claim, limitHours, now)) return 'over-limit'
  return isWaitingClaim(claim, now) ? 'waiting' : 'running'
}

export const CLAIM_TAG_TYPE = {
  running: 'cool-gray',
  waiting: 'magenta',
  'over-limit': 'red',
} as const

/** The value as a link target only when all of it is one https URL; anything else stays text. */
export function httpsLink(value: string): string | null {
  const text = value.trim()
  if (!/^https:\/\/\S+$/.test(text)) return null
  try {
    return new URL(text).protocol === 'https:' ? text : null
  } catch {
    return null
  }
}

/** The sentence for a release the server refused or that failed. */
export function releaseFailure(error: unknown): string {
  if (error instanceof ApiError && error.code === 'claim-changed') {
    return 'The claim changed. Another run holds it now.'
  }
  if (error instanceof ApiError && error.code === 'not-found') {
    return 'This claim is already gone.'
  }
  return error instanceof Error ? error.message : 'The claim could not be released.'
}
