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

// Where another token starts inside a body: a prefix followed by 20 characters of that prefix's
// own body class, so the pattern for that token is certain to match there. A shorter
// prefix-like tail stays part of the current body so it is removed with it.
const NEXT_TOKEN = '(?!github_pat_[A-Za-z0-9_]{20}|gh[pousr]_[A-Za-z0-9]{20}|urutau_mcp_[A-Za-z0-9_-]{20})'

/**
 * Global patterns for urutau_mcp_, github_pat_ and gh[pousr]_ values of at least 20 characters
 * after the prefix. They have no leading \b so a token right after a letter, digit, underscore
 * or URL escape (%20, %3D) is still matched. The first 20 body characters are always taken;
 * after them a body ends where the next token's prefix and 20 body characters start, so two
 * tokens written back to back are each redacted.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(`urutau_mcp_[A-Za-z0-9_-]{20}(?:${NEXT_TOKEN}[A-Za-z0-9_-])*`, 'g'),
  new RegExp(`github_pat_[A-Za-z0-9_]{20}(?:${NEXT_TOKEN}[A-Za-z0-9_])*`, 'g'),
  new RegExp(`gh[pousr]_[A-Za-z0-9]{20}(?:${NEXT_TOKEN}[A-Za-z0-9])*`, 'g'),
]

/** The text with every SECRET_PATTERNS match replaced by [redacted]. */
export function redactPatterns(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]')
  return result
}
