import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { EditorKind as ApiEditorKind } from '../../src/domain/api.ts'
import type { AppContext } from '../app.ts'
import { createTestApp, type TestApp } from '../testing/harness.ts'
import type { EditorKind as McpEditorKind } from './contract.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'migrations' ? [] : walk(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

const isTest = (path: string) => /\.(test|suite)\.ts$/.test(path)
const serverFiles = walk(join(ROOT, 'server')).filter((path) => !isTest(path))
const text = (path: string) => readFileSync(path, 'utf8')
const rel = (path: string) => relative(ROOT, path)

/** The repository-relative paths a file imports (static and dynamic, relative specifiers only). */
function imports(path: string): string[] {
  const found: string[] = []
  for (const match of text(path).matchAll(/(?:\bfrom|\bimport\s*\(|\bimport)\s*['"](\.[^'"]*)['"]/g)) {
    found.push(rel(resolve(dirname(path), match[1])))
  }
  return found
}

const inMcp = serverFiles.filter((path) => rel(path).startsWith('server/mcp/'))
const named = (...names: string[]) => names.map((name) => join(ROOT, 'server/mcp', name))

describe('who holds the secret box and the opener', () => {
  test('only app.ts, the reader and the integration routes import the secret box module', () => {
    const importers = serverFiles.filter((path) => imports(path).includes('server/auth/secretBox.ts')).map(rel).sort()
    expect(importers).toEqual(['server/app.ts', 'server/github/reader.ts', 'server/routes/integrations.ts'])
  })

  test('createSecretBox( appears only in app.ts, outside its own definition', () => {
    const files = serverFiles.filter((path) => rel(path) !== 'server/auth/secretBox.ts' && text(path).includes('createSecretBox('))
    expect(files.map(rel)).toEqual(['server/app.ts'])
  })

  test('the opener goes to the reader: one line of app.ts names it, and no other file but the reader and the box does', () => {
    const lines = text(join(ROOT, 'server/app.ts')).split('\n').filter((line) => /\bopener\b/i.test(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('createGitHubReader(')

    const others = serverFiles.filter((path) => !['server/app.ts', 'server/auth/secretBox.ts', 'server/github/reader.ts'].includes(rel(path)) && /\bopener\b|SecretOpener/i.test(text(path)))
    expect(others.map(rel)).toEqual([])
    const typed = serverFiles.filter((path) => rel(path) !== 'server/auth/secretBox.ts' && text(path).includes('SecretOpener'))
    expect(typed.map(rel)).toEqual(['server/github/reader.ts'])
  })

  test('the sealer type is used only by app.ts and the integration routes', () => {
    const files = serverFiles.filter((path) => rel(path) !== 'server/auth/secretBox.ts' && text(path).includes('SecretSealer'))
    expect(files.map(rel).sort()).toEqual(['server/app.ts', 'server/routes/integrations.ts'])
  })

  test('the context type has no key and no opener (checked by the type checker)', () => {
    type Assert<T extends true> = T
    type NoKey = Assert<'tokenEncryptionKey' extends keyof AppContext['config'] ? false : true>
    type NoOpener = Assert<'opener' extends keyof AppContext ? false : true>
    const checked: [NoKey, NoOpener] = [true, true]
    expect(checked).toEqual([true, true])
  })

  describe('at run time', () => {
    let h: TestApp
    afterEach(async () => {
      await h.close()
    })

    test('the context the routes receive holds no key, with or without one configured', async () => {
      h = await createTestApp({ config: { tokenEncryptionKey: Buffer.alloc(32, 7) } })
      expect('tokenEncryptionKey' in h.ctx.config).toBe(false)
      expect('opener' in h.ctx).toBe(false)
      expect(h.ctx.githubTokenSealer).not.toBeNull()
      expect(JSON.stringify(h.ctx.config)).not.toContain(Buffer.alloc(32, 7).toString('base64'))
    })
  })
})

describe('the browser and the server share only pure code', () => {
  test('src/github/api.ts and paging.ts import only domain modules and paging.ts', () => {
    for (const name of ['api.ts', 'paging.ts']) {
      for (const imported of imports(join(ROOT, 'src/github', name))) {
        expect(imported).toMatch(/^src\/(domain\/[\w.]+\.ts|github\/paging\.ts)$/)
      }
    }
  })

  test('no server file imports the browser client, issue creation, state, hooks, api, components or board code', () => {
    const forbidden = /^src\/(github\/client\.ts|github\/createIssue\.ts|(state|hooks|api|components|board)\/)/
    const offenders = serverFiles.flatMap((path) => imports(path).filter((imported) => forbidden.test(imported)).map((imported) => `${rel(path)} -> ${imported}`))
    expect(offenders).toEqual([])
  })
})

describe('the MCP modules keep their layers', () => {
  const importsOf = (names: string[]) => names.flatMap((path) => imports(path).map((imported) => ({ file: rel(path), imported })))
  const usesSdk = (path: string) => /from\s+['"]@modelcontextprotocol\/server/.test(text(path))

  test('clean, locks, inflight and boardJson import neither the SDK, the reader nor save', () => {
    const files = named('clean.ts', 'locks.ts', 'inflight.ts', 'boardJson.ts')
    expect(files.filter(usesSdk).map(rel)).toEqual([])
    expect(importsOf(files).filter(({ imported }) => ['server/github/reader.ts', 'server/boards/save.ts'].includes(imported))).toEqual([])
  })

  test('tools, move and reorder import neither the reader nor save', () => {
    const files = named('tools.ts', 'move.ts', 'reorder.ts')
    expect(importsOf(files).filter(({ imported }) => ['server/github/reader.ts', 'server/boards/save.ts'].includes(imported))).toEqual([])
  })

  test('only endpoint.ts names an HTTP method that writes; the reader names none', () => {
    const files = [...inMcp.filter((path) => rel(path) !== 'server/mcp/endpoint.ts'), join(ROOT, 'server/github/reader.ts')]
    const offenders = files.filter((path) => /'(POST|PATCH|PUT|DELETE)'/.test(text(path)))
    expect(offenders.map(rel)).toEqual([])
  })

  test('the MCP modules and the reader do not import the routes or the issue-creation request builder', () => {
    const files = [...inMcp, join(ROOT, 'server/github/reader.ts')]
    const offenders = importsOf(files).filter(({ imported }) => imported.startsWith('server/routes/') || imported === 'server/github/newIssue.ts')
    expect(offenders).toEqual([])
  })

  test('no MCP module calls a global fetch: GitHub is reached through the reader only', () => {
    // A bare call only; the SDK handler's own handler.fetch( is a method call and is allowed.
    const bareFetch = /(?<![.\w])fetch\(/
    expect(inMcp.filter((path) => bareFetch.test(text(path))).map(rel)).toEqual([])
  })
})

test('EditorKind is the same union in the contract and in the API types (checked by the type checker)', () => {
  type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
  const same: Same<ApiEditorKind, McpEditorKind> = true
  expect(same).toBe(true)
})
