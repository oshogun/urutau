import type { IssueState } from '../domain/types'

export function avatarSrc(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}s=40`
}

export interface IssueStateTag {
  /** Carbon Tag type. */
  type: 'green' | 'purple' | 'gray'
  /** The card's text; the card shows the tag on closed issues only. */
  short: string
  /** The details dialog's text. */
  long: string
}

/** One function for the card's tag and the dialog's tag, so their colours never disagree. */
export function issueStateTag(state: IssueState, stateReason: string | null): IssueStateTag {
  if (state === 'open') return { type: 'green', short: 'Open', long: 'Open' }
  switch (stateReason) {
    case 'not_planned':
      return { type: 'gray', short: 'Not planned', long: 'Closed as not planned' }
    case 'completed':
      return { type: 'purple', short: 'Closed', long: 'Closed as completed' }
    case 'duplicate':
      return { type: 'purple', short: 'Closed', long: 'Closed as duplicate' }
    default:
      return { type: 'purple', short: 'Closed', long: 'Closed' }
  }
}
