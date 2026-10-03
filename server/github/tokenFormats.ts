/** The GitHub token formats Urutau stores, and the patterns the logger removes. */

export type GitHubTokenCheck =
  | { ok: true; kind: 'fine-grained' | 'classic' }
  | { ok: false; code: 'not-a-github-token' | 'unsupported-token-format' }

/**
 * Checks the value as given (callers trim first): a urutau_mcp_ value is not a GitHub token;
 * github_pat_ followed by 20-255 letters, digits or underscores, and ghp_ followed by 36
 * letters or digits, are accepted; anything else is an unsupported format.
 */
export function checkGitHubToken(value: string): GitHubTokenCheck {
  if (value.startsWith('urutau_mcp_')) return { ok: false, code: 'not-a-github-token' }
  if (/^github_pat_[A-Za-z0-9_]{20,255}$/.test(value)) return { ok: true, kind: 'fine-grained' }
  if (/^ghp_[A-Za-z0-9]{36}$/.test(value)) return { ok: true, kind: 'classic' }
  return { ok: false, code: 'unsupported-token-format' }
}

/**
 * Global patterns for urutau_mcp_, github_pat_ and gh[pousr]_ values of at least 20 characters
 * after the prefix. They have no leading \b so a token right after a letter, digit, underscore
 * or URL escape (%20, %3D) is still matched.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /urutau_mcp_[A-Za-z0-9_-]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
]

/** The text with every SECRET_PATTERNS match replaced by [redacted]. */
export function redactPatterns(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]')
  return result
}
