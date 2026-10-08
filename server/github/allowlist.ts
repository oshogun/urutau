/** What the GitHub proxy may forward: a few GET paths with a known set of query parameters, nothing else. */

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/
const ID = /^[1-9][0-9]{0,19}$/
const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/
const MAX_ISSUE_NUMBER = 2147483647
const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const AFTER = /^[A-Za-z0-9+/=_-]{1,200}$/

type Validator = (value: string) => boolean

function whole(min: number, max: number): Validator {
  return (value) => /^\d{1,5}$/.test(value) && Number(value) >= min && Number(value) <= max
}

const PAGING: Record<string, Validator> = { per_page: whole(1, 100), page: whole(1, 9999) }
const LABEL_QUERY = PAGING
const ISSUE_QUERY: Record<string, Validator> = {
  ...PAGING,
  state: (value) => value === 'open' || value === 'closed',
  since: (value) => SINCE.test(value),
  after: (value) => AFTER.test(value),
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** True when every query parameter is known, appears once and has a valid value. `+` stays a plus sign: only percent escapes are decoded. */
function validQuery(rawQuery: string, allowed: Record<string, Validator>): boolean {
  if (rawQuery === '') return true
  const seen = new Set<string>()
  for (const part of rawQuery.split('&')) {
    const equals = part.indexOf('=')
    const key = decode(equals === -1 ? part : part.slice(0, equals))
    const value = decode(equals === -1 ? '' : part.slice(equals + 1))
    if (key === null || value === null) return false
    const validator = Object.hasOwn(allowed, key) ? allowed[key] : undefined
    if (!validator || seen.has(key) || !validator(value)) return false
    seen.add(key)
  }
  return true
}

/**
 * The upstream path to request for a proxied path (without the `/api/github/`
 * prefix) and raw query string, or null when either is outside the list.
 * The returned path is the validated, decoded one; the caller appends the raw
 * query unchanged.
 */
export function allowedGitHubPath(rawPath: string, rawQuery: string): string | null {
  // Each segment is decoded on its own so that an encoded slash cannot turn one segment into two.
  const parts = rawPath.split('/').map(decode)
  if (parts.some((part) => part === null || part.includes('/'))) return null
  const decoded = parts.join('/')
  const [first, second, third, fourth, fifth] = parts as string[]

  if (first === 'repos' && parts.length >= 3 && OWNER.test(second) && NAME.test(third) && third !== '.' && third !== '..') {
    if (parts.length === 3) return rawQuery === '' ? decoded : null
    if (parts.length === 4 && fourth === 'labels') return validQuery(rawQuery, LABEL_QUERY) ? decoded : null
    if (parts.length === 4 && fourth === 'issues') return validQuery(rawQuery, ISSUE_QUERY) ? decoded : null
    // One issue. The path says nothing about the method: both callers send GET only.
    if (parts.length === 5 && fourth === 'issues' && ISSUE_NUMBER.test(fifth) && Number(fifth) <= MAX_ISSUE_NUMBER) {
      return rawQuery === '' ? decoded : null
    }
    return null
  }
  if (first === 'repositories' && parts.length === 3 && ID.test(second)) {
    if (third === 'labels') return validQuery(rawQuery, LABEL_QUERY) ? decoded : null
    if (third === 'issues') return validQuery(rawQuery, ISSUE_QUERY) ? decoded : null
  }
  return null
}
