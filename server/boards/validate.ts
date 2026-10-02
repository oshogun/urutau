import { isBoardConfig } from '../../src/domain/board.ts'
import { parseRepoInput, repoKey } from '../../src/domain/repoRef.ts'
import type { BoardConfig } from '../../src/domain/types.ts'

/**
 * The lower-case repository key for `owner/name` text in any case, or null
 * when the text is anything else (a URL, a `.git` suffix, extra path parts,
 * surrounding spaces).
 */
export function repoKeyOf(text: string): string | null {
  const repo = parseRepoInput(text)
  if (!repo) return null
  const key = repoKey(repo)
  return key === text.toLowerCase() ? key : null
}

export function asBoardConfig(value: unknown): BoardConfig | null {
  return isBoardConfig(value) ? value : null
}
