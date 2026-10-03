import { expect, test } from 'vitest'
import { isJsonPath } from './paths.ts'

test('JSON paths: the API, the agent endpoint and the OAuth discovery paths', () => {
  for (const path of ['/api', '/api/boards', '/mcp', '/mcp/', '/mcp/x', '/.well-known', '/.well-known/oauth-protected-resource', '/register', '/authorize', '/token']) {
    expect({ path, json: isJsonPath(path) }).toEqual({ path, json: true })
  }
})

test('the app and look-alike paths are not JSON paths', () => {
  for (const path of ['/', '/boards/acme/widgets', '/apix', '/mcpx', '/.well-knownx', '/registers', '/token/x', '/assets/index.js', '/api-docs']) {
    expect({ path, json: isJsonPath(path) }).toEqual({ path, json: false })
  }
})
