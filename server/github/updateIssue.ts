/** Checks for changing an issue: the repository and issue path, and what the stale check reads from GitHub's answer. */
import { isRecord } from '../http/body.ts'
import { allowedGitHubPath } from './allowlist.ts'

const MAX_ISSUE_NUMBER = 2147483647

/**
 * `repos/<owner>/<name>/issues/<number>`, or null when owner or name fail the proxy's rules
 * (allowedGitHubPath on `repos/<owner>/<name>`) or number does not match /^[1-9][0-9]{0,9}$/ or is
 * above 2147483647.
 */
export function issuePathFor(owner: string, name: string, number: string): string | null {
  const repo = allowedGitHubPath(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, '')
  if (repo === null || !/^[1-9][0-9]{0,9}$/.test(number) || Number(number) > MAX_ISSUE_NUMBER) return null
  return `${repo}/issues/${number}`
}

/**
 * From the check request's parsed 2xx body: its updated_at and whether it is a pull request
 * ('pull_request' in body). Null when the body is not an object or has no string updated_at.
 */
export function checkedIssue(body: unknown): { updatedAt: string; pullRequest: boolean } | null {
  if (!isRecord(body) || typeof body.updated_at !== 'string') return null
  return { updatedAt: body.updated_at, pullRequest: 'pull_request' in body }
}
