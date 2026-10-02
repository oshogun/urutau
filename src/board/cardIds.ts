import type { UniqueIdentifier } from '@dnd-kit/core'

/** Drag-and-drop ids for issue cards; bucket ids are used as-is for columns. */
export const cardId = (issueNumber: number) => `issue-${issueNumber}`

export const issueNumberOf = (id: UniqueIdentifier) => Number(String(id).replace(/^issue-/, ''))
