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
 * One global pattern for urutau_mcp_, github_pat_ and gh[pousr]_ values. A match needs 20
 * characters after the prefix that fit that prefix's alphabet: letters, digits and underscores
 * for github_pat_, letters and digits for gh[pousr]_, letters, digits, underscores and hyphens
 * for urutau_mcp_. So ordinary text such as highs_and_lows_of_the_season, where "gh" and "_"
 * are followed by underscore-separated words, is left alone. Once a match starts, the whole run
 * of letters, digits, underscores and hyphens after it is removed too, so two tokens written back
 * to back become a single [redacted] and no tail of either is left in the text. It has no
 * leading \b so a token right after a letter, digit, underscore or URL escape (%20, %3D) is
 * still matched. A shorter look-alike such as ghp_short or ghs_count is left alone.
 */
export const SECRET_PATTERN = /(?:github_pat_[A-Za-z0-9_]{20}|gh[pousr]_[A-Za-z0-9]{20}|urutau_mcp_[A-Za-z0-9_-]{20})[A-Za-z0-9_-]*/g
