/** Paths answered with JSON, never with the app's HTML. */

const JSON_ROOTS = ['/api', '/mcp', '/.well-known'] as const
const JSON_EXACT = ['/register', '/authorize', '/token'] as const

/** True for /api, /mcp, /.well-known (and anything under them), /register, /authorize and /token. */
export function isJsonPath(path: string): boolean {
  return JSON_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)) || (JSON_EXACT as readonly string[]).includes(path)
}
