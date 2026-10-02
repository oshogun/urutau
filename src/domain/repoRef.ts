import type { RepoRef } from './types.ts'

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Accepts `owner/name`, GitHub web URLs and SSH/HTTPS clone URLs.
 * Returns `null` when the input does not look like a repository.
 */
export function parseRepoInput(input: string): RepoRef | null {
  let value = input.trim()
  if (!value) return null

  value = value
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')

  const [owner, rawName] = value.split('/')
  const name = rawName?.replace(/\.git$/i, '')
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
    return null
  }
  return { owner, name }
}

export function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`
}

/** GitHub owner and repository names are case-insensitive. */
export function repoKey(repo: RepoRef): string {
  return formatRepo(repo).toLowerCase()
}
