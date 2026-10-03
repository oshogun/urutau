/** Checks and reads for creating an issue: the request body, the repository path and GitHub's failure answers. */
import {
  NEW_ISSUE_BODY_MAX,
  NEW_ISSUE_TITLE_MAX,
  type CreateIssueRequest,
  type GitHubFailureDetail,
  type GitHubValidationError,
} from '../../src/domain/api.ts'
import { isRecord } from '../http/body.ts'
import { allowedGitHubPath } from './allowlist.ts'

/** The upstream path `repos/<owner>/<name>/issues`, or null when the owner or name fails the proxy's allow-list rules. */
export function issuesPathFor(owner: string, name: string): string | null {
  const repo = allowedGitHubPath(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, '')
  return repo === null ? null : `${repo}/issues`
}

const length = (text: string) => [...text].length

/**
 * Validates a parsed JSON body: only `title` and `body` keys, a title of 1 to 256 code points after trimming, a body of
 * at most 65,536 code points (counted before trimming). The value is a new object holding the trimmed title and the
 * body when it is not blank; the input object is never forwarded. A message names the field and the rule, never the content.
 */
export function parseCreateIssue(input: unknown): { ok: true; value: CreateIssueRequest } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'The request body must be a JSON object.' }
  if (Object.keys(input).some((key) => key !== 'title' && key !== 'body')) {
    return { ok: false, message: 'Only title and body can be set.' }
  }
  const { title, body } = input
  if (typeof title !== 'string') return { ok: false, message: 'title must be text.' }
  const trimmed = title.trim()
  if (trimmed === '') return { ok: false, message: 'title is required.' }
  if (length(trimmed) > NEW_ISSUE_TITLE_MAX) return { ok: false, message: `title must be at most ${NEW_ISSUE_TITLE_MAX} characters.` }
  if (body !== undefined && typeof body !== 'string') return { ok: false, message: 'body must be text.' }
  if (body !== undefined && length(body) > NEW_ISSUE_BODY_MAX) {
    return { ok: false, message: `body must be at most ${NEW_ISSUE_BODY_MAX.toLocaleString('en-US')} characters.` }
  }
  const value: CreateIssueRequest = { title: trimmed }
  if (body !== undefined && body.trim() !== '') value.body = body
  return { ok: true, value }
}

const cut = (text: string, max: number) => [...text].slice(0, max).join('')
const text = (value: unknown, max: number): string | null => (typeof value === 'string' ? cut(value, max) : null)

function wholeNumber(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value) ? Number(value) : null
}

function validationErrors(value: unknown): GitHubValidationError[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 5).map((entry): GitHubValidationError => {
    const item = isRecord(entry) ? entry : {}
    return { resource: text(item.resource, 200), field: text(item.field, 200), code: text(item.code, 200), message: text(item.message, 200) }
  })
}

/**
 * What the server keeps of GitHub's non-2xx answer: the status, the message and validation errors of a JSON body
 * (null and [] when the body is missing or unreadable) and three numeric headers.
 */
export function failureDetail(status: number, headers: Headers, body: unknown): GitHubFailureDetail {
  const json = isRecord(body) ? body : {}
  return {
    status,
    message: text(json.message, 500),
    errors: validationErrors(json.errors),
    retryAfter: wholeNumber(headers.get('retry-after')),
    rateLimitRemaining: wholeNumber(headers.get('x-ratelimit-remaining')),
    rateLimitReset: wholeNumber(headers.get('x-ratelimit-reset')),
  }
}
