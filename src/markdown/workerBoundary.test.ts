import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>
const files = Object.entries(sources).filter(([path]) => !/\.test\.[^/]*$/.test(path))

// Any mention of the markdown-it package or one of its subpaths as a module specifier.
const markdownItSpecifier = /['"]markdown-it(?:\/[^'"]*)?['"]/

// A static import, a re-export, a side-effect import or a dynamic import whose specifier ends in
// /issueBody or /issueBody.ts. `import type` and `export type` are skipped.
const issueBodyRuntimeImport =
  /(?:^|[;\s])(?:import\s+(?!type\b)(?:[^'"]*?\bfrom\s*)?|export\s+(?!type\b)[^'"]*?\bfrom\s*|import\s*\(\s*)['"][^'"]*\/issueBody(?:\.ts)?['"]/m

describe('boundary patterns', () => {
  it('match every way to name markdown-it', () => {
    for (const text of [
      "import MarkdownIt from 'markdown-it'",
      "export { parseIssueBody } from 'markdown-it'",
      "await import('markdown-it')",
      "import 'markdown-it'",
      "import x from 'markdown-it/lib/token.mjs'",
    ]) {
      expect(markdownItSpecifier.test(text), text).toBe(true)
    }
    expect(markdownItSpecifier.test("import x from 'markdown-it-foo'")).toBe(false)
  })

  it('match every runtime import of issueBody and skip type-only ones', () => {
    for (const text of [
      "import { parseIssueBody } from './issueBody'",
      "import { parseIssueBody } from './issueBody.ts'",
      "export { parseIssueBody } from './issueBody'",
      "const m = await import('./issueBody')",
      "import { parseIssueBody } from '../../markdown/issueBody'",
      "import './issueBody'",
      "import {\\n  a,\\n  b,\\n} from './issueBody.ts'".replace(/\\n/g, '\n'),
    ]) {
      expect(issueBodyRuntimeImport.test(text), text).toBe(true)
    }
    for (const text of [
      "import type { X } from './issueBody'",
      "export type { X } from './issueBody'",
      "import { X } from './issueBodyOther'",
    ]) {
      expect(issueBodyRuntimeImport.test(text), text).toBe(false)
    }
  })
})

describe('markdown-it stays off the main thread', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(20)
    expect(files.map(([path]) => path)).toContain('/src/markdown/issueBody.ts')
  })

  it('is imported only by src/markdown/issueBody.ts', () => {
    const importers = files.filter(([, text]) => markdownItSpecifier.test(text)).map(([path]) => path)
    expect(importers).toEqual(['/src/markdown/issueBody.ts'])
  })

  it('has issueBody.ts imported at run time only by the worker entry', () => {
    const importers = files.filter(([, text]) => issueBodyRuntimeImport.test(text)).map(([path]) => path)
    expect(importers).toEqual(['/src/markdown/issueBody.worker.ts'])
  })
})
