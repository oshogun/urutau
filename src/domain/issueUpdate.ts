/**
 * Rules for changing an issue, shared by the browser and the server: the field checks, what the
 * person changed, and how a draft is rebased when GitHub's copy moved. Pure functions; imports
 * only from src/domain with the `.ts` extension so the server can import the file as it is.
 */
import {
  NEW_ISSUE_BODY_MAX,
  NEW_ISSUE_TITLE_MAX,
  type IssueUpdateFields,
  type UpdateIssueRequest,
} from './api.ts'
import type { Issue } from './types.ts'

/** The fields a change starts from or compares. A missing `body` reads as ''. */
export type IssueVersion = Pick<Issue, 'title' | 'body' | 'state' | 'stateReason' | 'updatedAt'>

/** The edit form's two values, as the inputs hold them. */
export interface IssueDraft {
  title: string
  body: string
}

/** The three state buttons of the details dialog. */
export type IssueStateAction = 'close-completed' | 'close-not-planned' | 'reopen'

/** One line of "what changed on GitHub"; 'other' when none of the three fields differs. */
export type IssueChange = 'title' | 'body' | 'state' | 'other'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const length = (text: string) => [...text].length
const FIELD_KEYS = ['title', 'body', 'state', 'state_reason']

/**
 * Checks the fields with the rules shared by the browser and the server. The value is a new
 * object; the input is never forwarded.
 */
export function normalizeIssueUpdate(
  input: unknown,
): { ok: true; value: IssueUpdateFields } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'The fields must be a JSON object.' }
  const keys = Object.keys(input)
  if (keys.some((key) => !FIELD_KEYS.includes(key))) {
    return { ok: false, message: 'Only title, body, state and state_reason can be changed.' }
  }
  if (keys.length === 0) return { ok: false, message: 'Nothing to change.' }

  const value: IssueUpdateFields = {}
  const { title, body, state, state_reason: reason } = input
  if (title !== undefined) {
    if (typeof title !== 'string') return { ok: false, message: 'title must be text.' }
    const trimmed = title.trim()
    if (trimmed === '') return { ok: false, message: 'title is required.' }
    if (length(trimmed) > NEW_ISSUE_TITLE_MAX) {
      return { ok: false, message: `title must be at most ${NEW_ISSUE_TITLE_MAX} characters.` }
    }
    value.title = trimmed
  }
  if (body !== undefined) {
    if (typeof body !== 'string') return { ok: false, message: 'body must be text.' }
    if (length(body) > NEW_ISSUE_BODY_MAX) {
      return { ok: false, message: `body must be at most ${NEW_ISSUE_BODY_MAX.toLocaleString('en-US')} characters.` }
    }
    value.body = body
  }
  if (state !== undefined && state !== 'open' && state !== 'closed') {
    return { ok: false, message: 'state must be open or closed.' }
  }
  if ((state === undefined) !== (reason === undefined)) {
    return { ok: false, message: 'state and state_reason go together.' }
  }
  if (state !== undefined) {
    const fits = state === 'closed' ? reason === 'completed' || reason === 'not_planned' : reason === 'reopened'
    if (!fits) return { ok: false, message: 'state_reason does not fit state.' }
    value.state = state
    value.state_reason = reason as IssueUpdateFields['state_reason']
  }
  if (Object.keys(value).length === 0) return { ok: false, message: 'Nothing to change.' }
  return { ok: true, value }
}

/** Checks the server route's body: `expectedUpdatedAt` and `fields` only. */
export function parseUpdateIssueRequest(
  input: unknown,
): { ok: true; value: UpdateIssueRequest } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'The request body must have expectedUpdatedAt and fields only.' }
  const keys = Object.keys(input)
  if (keys.length !== 2 || !keys.includes('expectedUpdatedAt') || !keys.includes('fields')) {
    return { ok: false, message: 'The request body must have expectedUpdatedAt and fields only.' }
  }
  const { expectedUpdatedAt, fields } = input
  if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt.length > 64 || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    return { ok: false, message: 'expectedUpdatedAt must be a time.' }
  }
  const normalized = normalizeIssueUpdate(fields)
  if (!normalized.ok) return normalized
  return { ok: true, value: { expectedUpdatedAt, fields: normalized.value } }
}

/** True when both parse with Date.parse to the same finite instant. */
export function sameUpdatedAt(a: string, b: string): boolean {
  const first = Date.parse(a)
  const second = Date.parse(b)
  return Number.isFinite(first) && Number.isFinite(second) && first === second
}

/** The text as a <textarea> holds it: every "\r\n" and lone "\r" becomes "\n". */
export function textareaValue(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** The form's starting values: the title, and the description as a <textarea> holds it. */
export function startDraft(base: IssueVersion): IssueDraft {
  return { title: base.title, body: textareaValue(base.body ?? '') }
}

/** The fields the person changed; {} when nothing changed. */
export function editFields(base: IssueVersion, draft: IssueDraft): IssueUpdateFields {
  const fields: IssueUpdateFields = {}
  if (draft.title.trim() !== base.title.trim()) fields.title = draft.title.trim()
  if (draft.body !== textareaValue(base.body ?? '')) fields.body = draft.body
  return fields
}

/** The PATCH fields of a state button. */
export function stateFields(action: IssueStateAction): IssueUpdateFields {
  if (action === 'close-completed') return { state: 'closed', state_reason: 'completed' }
  if (action === 'close-not-planned') return { state: 'closed', state_reason: 'not_planned' }
  return { state: 'open', state_reason: 'reopened' }
}

/** Whether the state button would still change `current`'s state. */
export function stateActionPending(action: IssueStateAction, current: IssueVersion): boolean {
  return action === 'reopen' ? current.state === 'closed' : current.state === 'open'
}

/** What differs between the version a change started from and GitHub's current one. */
export function describeChanges(base: IssueVersion, current: IssueVersion): IssueChange[] {
  const changes: IssueChange[] = []
  if (base.title !== current.title) changes.push('title')
  if (textareaValue(base.body ?? '') !== textareaValue(current.body ?? '')) changes.push('body')
  if (base.state !== current.state || (base.state === 'closed' && base.stateReason !== current.stateReason)) {
    changes.push('state')
  }
  return changes.length > 0 ? changes : ['other']
}

/** Keeps the fields the person changed and takes GitHub's current text for the others. */
export function rebaseDraft(base: IssueVersion, draft: IssueDraft, current: IssueVersion): IssueDraft {
  return {
    title: draft.title.trim() !== base.title.trim() ? draft.title : current.title,
    body: draft.body !== textareaValue(base.body ?? '') ? draft.body : textareaValue(current.body ?? ''),
  }
}

/** Fields both the person and GitHub changed, in the order title, body. */
export function conflictingFields(
  base: IssueVersion,
  draft: IssueDraft,
  current: IssueVersion,
): Array<'title' | 'body'> {
  const mine = editFields(base, draft)
  const theirs = describeChanges(base, current)
  const conflicts: Array<'title' | 'body'> = []
  if (mine.title !== undefined && theirs.includes('title')) conflicts.push('title')
  if (mine.body !== undefined && theirs.includes('body')) conflicts.push('body')
  return conflicts
}
