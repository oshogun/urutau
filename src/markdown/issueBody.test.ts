import MarkdownIt from 'markdown-it'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BODY_NODES_MAX,
  BODY_RENDER_LIMIT,
  HREF_MAX,
  RUN_TEXT_MAX,
  TABLE_CELLS_MAX,
  type BodyBlock,
  type BodyInline,
  type ParsedBody,
} from './bodyTree'
import { estimateTableCells, parseIssueBody, safeHref } from './issueBody'

const ISSUE_URL = 'https://github.com/acme/widgets/issues/12'
const parse = (body: string) => parseIssueBody(body, ISSUE_URL)

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff

// Repeats `unit` to `length` code units, dropping a last unit that would leave half a surrogate pair.
function fit(unit: string, length: number): string {
  const text = unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
  return isHigh(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text
}

type Container = Extract<BodyInline, { children: BodyInline[] }>

/** Every node in the tree: blocks, inline nodes (splits included), list items, table rows and table cells. */
function countNodes(parsed: ParsedBody): number {
  let count = 0
  const inlines = (nodes: BodyInline[]) => {
    for (const node of nodes) {
      count++
      if ('children' in node) inlines((node as Container).children)
    }
  }
  const blocks = (nodes: BodyBlock[]) => {
    for (const node of nodes) {
      count++
      switch (node.type) {
        case 'paragraph':
        case 'heading':
          inlines(node.children)
          break
        case 'blockquote':
          blocks(node.children)
          break
        case 'list':
          for (const item of node.items) {
            count++
            blocks(item.children)
          }
          break
        case 'table':
          for (const row of [...node.head, ...node.body]) {
            count++
            for (const cell of row.cells) {
              count++
              inlines(cell.children)
            }
          }
          break
      }
    }
  }
  blocks(parsed.blocks)
  return count
}

const textOf = (node: BodyInline): number =>
  node.type === 'text' || node.type === 'code' ? node.text.length : node.type === 'image' ? node.alt.length + 7 : 0

interface RunReport {
  maxRun: number
  splits: number
  splitInsideContainer: boolean
  halfPairs: number
}

// For every paragraph, heading and cell: the largest run between splits, how many splits there are,
// whether a split sits inside a container, and how many text nodes end inside a surrogate pair.
function runReport(parsed: ParsedBody): RunReport {
  const report: RunReport = { maxRun: 0, splits: 0, splitInsideContainer: false, halfPairs: 0 }
  const targets: BodyInline[][] = []
  const walk = (blocks: BodyBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'paragraph' || block.type === 'heading') targets.push(block.children)
      else if (block.type === 'blockquote') walk(block.children)
      else if (block.type === 'list') for (const item of block.items) walk(item.children)
      else if (block.type === 'table') {
        for (const row of [...block.head, ...block.body]) for (const cell of row.cells) targets.push(cell.children)
      }
    }
  }
  walk(parsed.blocks)
  for (const children of targets) {
    let run = 0
    const count = (nodes: BodyInline[], nested: boolean) => {
      for (const node of nodes) {
        if (node.type === 'split') {
          if (nested) report.splitInsideContainer = true
          else {
            report.splits++
            report.maxRun = Math.max(report.maxRun, run)
            run = 0
          }
          continue
        }
        run += textOf(node)
        if ((node.type === 'text' || node.type === 'code') && node.text.length > 0) {
          if (isHigh(node.text.charCodeAt(node.text.length - 1))) report.halfPairs++
        }
        if ('children' in node) count((node as Container).children, true)
      }
    }
    count(children, false)
    report.maxRun = Math.max(report.maxRun, run)
  }
  return report
}

// The text of a body made of one paragraph of text nodes.
function joinText(parsed: ParsedBody): string {
  let out = ''
  const walk = (nodes: BodyInline[]) => {
    for (const node of nodes) {
      if (node.type === 'text' || node.type === 'code') out += node.text
      if ('children' in node) walk((node as Container).children)
    }
  }
  for (const block of parsed.blocks) if (block.type === 'paragraph' || block.type === 'heading') walk(block.children)
  return out
}

const links = (nodes: BodyInline[]): Array<Extract<BodyInline, { type: 'link' }>> =>
  nodes.flatMap((node) => {
    if (node.type === 'link') return [node, ...links(node.children)]
    return 'children' in node ? links((node as Container).children) : []
  })

const firstParagraph = (parsed: ParsedBody): BodyInline[] => {
  const block = parsed.blocks[0]
  if (block?.type !== 'paragraph') throw new Error('expected a paragraph first')
  return block.children
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('safeHref', () => {
  it('resolves relative addresses against the issue address', () => {
    expect(safeHref('../wiki/Install', ISSUE_URL)).toBe('https://github.com/acme/widgets/wiki/Install')
    expect(safeHref('#top', ISSUE_URL)).toBe('https://github.com/acme/widgets/issues/12#top')
    expect(safeHref('//evil.example/x', ISSUE_URL)).toBe('https://evil.example/x')
  })

  it('accepts http, https and mailto only', () => {
    expect(safeHref('http://example.com/', ISSUE_URL)).toBe('http://example.com/')
    expect(safeHref('mailto:dev@example.com', ISSUE_URL)).toBe('mailto:dev@example.com')
    for (const raw of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html;base64,AAAA',
      'data:image/png;base64,AAAA',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'blob:https://example.com/id',
    ]) {
      expect(safeHref(raw, ISSUE_URL), raw).toBeNull()
    }
  })

  it('gives null for a missing address or one that does not parse', () => {
    expect(safeHref(null, ISSUE_URL)).toBeNull()
    expect(safeHref('http://', ISSUE_URL)).toBeNull()
  })

  it('refuses addresses whose parsed form is longer than the limit', () => {
    expect(safeHref(`https://example.com/?${"'".repeat(2020)}`, ISSUE_URL)).toBeNull()
    expect(safeHref(`https://${';'.repeat(2000)}@example.com/`, ISSUE_URL)).toBeNull()
  })

  it('returns an address of 2,048 units unchanged and refuses one unit more', () => {
    const exact = `https://example.com/${'x'.repeat(HREF_MAX - 20)}`
    expect(exact.length).toBe(HREF_MAX)
    expect(safeHref(exact, ISSUE_URL)).toBe(exact)
    expect(safeHref(`${exact}x`, ISSUE_URL)).toBeNull()
  })
})

describe('estimateTableCells', () => {
  const REVIEW_TABLE = '|' + 'a|'.repeat(300) + '\n|' + '-|'.repeat(300) + '\n' + '|b\n'.repeat(230)
  const TABLE_CASES: Record<string, string> = {
    'review table': REVIEW_TABLE,
    'review table x 2': Array.from({ length: 2 }, () => REVIEW_TABLE).join('\n'),
    'plain table': '| a | b |\n| - | :-: |\n| 1 | 2 |\n| 3 | 4 |',
    'no outer pipes': 'a | b\n--|--\n1 | 2',
    'one column': 'a|\n--\nb\nc',
    'escaped pipe in header': 'a \\| b | c\n--|--\n1|2',
    'rows wider than header': '|a|b|\n|-|-|\n|1|2|3|4|5|',
    'in blockquote': '> | a | b |\n> | - | - |\n> | 1 | 2 |',
    'nested blockquotes': '> > | a | b |\n> > |---|---|\n> > | 1 | 2 |',
    'lazy blockquote line': '> a|b\n-|-\n1|2',
    'in bullet item': '- | a | b |\n  | - | - |\n  | 1 | 2 |',
    'in ordered item': '1. a|b\n   -|-\n   1|2',
    'quote in list in quote': '> - > a|b\n>   > -|-\n>   > 1|2',
    tabs: '\ta|b\n\t-|-\n\t1|2',
    CRLF: 'a|b\r\n-|-\r\n1|2\r\n3|4',
    'CR only': 'a|b\r-|-\r1|2',
    'NBSP-only line ends the table': 'a|b\n-|-\n1|2\n\u00a0\n3|4',
    'table after paragraph': 'text\na|b\n-|-\n1|2',
    'setext underline after pipe line': 'a | b\n---\nmore',
    'delimiter rows as body rows': 'a|b\n-|-\n-|-\n-|-\n-|-',
    'fence holding a table': '```\na|b\n-|-\n1|2\n```',
    'alignment row': '|a|b|c|\n|:-|:-:|-:|\n|1|2|3|',
  }
  const reference = new MarkdownIt('default', { html: true, linkify: true, typographer: false, maxNesting: 20 })
  const cells = (body: string) =>
    reference.parse(body, {}).filter((token) => token.type === 'th_open' || token.type === 'td_open').length

  for (const [name, body] of Object.entries(TABLE_CASES)) {
    it(`is at least the cells markdown-it emits: ${name}`, () => {
      expect(estimateTableCells(body)).toBeGreaterThanOrEqual(cells(body))
    })
  }

  it('gives the exact estimates for the review table, a plain table and a fenced table', () => {
    expect(estimateTableCells(REVIEW_TABLE)).toBe(69_300)
    expect(estimateTableCells(TABLE_CASES['plain table'])).toBe(6)
    expect(estimateTableCells(TABLE_CASES['fence holding a table'])).toBe(6)
  })

  it('is 0 for text with no table', () => {
    expect(estimateTableCells('just text\n\nand more')).toBe(0)
    expect(estimateTableCells('')).toBe(0)
  })
})

describe('parseIssueBody: untrusted input', () => {
  it('shows nothing for an empty body or one with only white space', () => {
    expect(parse('')).toEqual({ blocks: [], omittedHtml: false, truncated: false, tablesAsText: false })
    expect(parse('  \n\n ').blocks).toEqual([])
  })

  it('shows nothing, and sets no flag, for an HTML comment alone', () => {
    expect(parse('<!-- Please describe the bug -->')).toEqual({
      blocks: [],
      omittedHtml: false,
      truncated: false,
      tablesAsText: false,
    })
  })

  it('shows no element for a script, and sets omittedHtml', () => {
    const parsed = parse('<script>alert(1)</script>')
    expect(parsed.blocks).toEqual([])
    expect(parsed.omittedHtml).toBe(true)
  })

  it('turns an img tag into an image node with no onerror', () => {
    const children = firstParagraph(parse('before <img src=x onerror=alert(1)> after'))
    expect(children).toEqual([
      { type: 'text', text: 'before ' },
      { type: 'image', alt: '', href: 'https://github.com/acme/widgets/issues/x' },
      { type: 'text', text: ' after' },
    ])
  })

  it('keeps only the text of an anchor with a javascript: address', () => {
    const parsed = parse('<a href="javascript:alert(1)">click</a>')
    expect(links(firstParagraph(parsed))).toEqual([])
    expect(joinText(parsed)).toBe('click')
  })

  it.each([
    ['[x](javascript:alert(1))'],
    ['[x](JaVaScRiPt:alert(1))'],
    ['<javascript:alert(1)>'],
    ['[a][r]\n\n[r]: javascript:alert(1)'],
    ['[y](data:text/html;base64,AAAA)'],
    ['[v](vbscript:msgbox(1))'],
  ])('makes no link from %j', (body) => {
    const parsed = parse(body)
    expect(parsed.blocks.length).toBeGreaterThan(0)
    expect(links(firstParagraph(parsed))).toEqual([])
  })

  it('refuses the address of a data: image', () => {
    expect(firstParagraph(parse('![d](data:image/png;base64,AAAA)'))).toEqual([
      { type: 'image', alt: 'd', href: null },
    ])
  })

  it('keeps the text of an ftp link without a link', () => {
    const children = firstParagraph(parse('[f](ftp://example.com/file)'))
    expect(links(children)).toEqual([])
    expect(joinText(parse('[f](ftp://example.com/file)'))).toBe('f')
  })

  it('maps a Markdown image and an HTML upload tag to image nodes', () => {
    expect(firstParagraph(parse('![t](https://example.com/a.png)'))).toEqual([
      { type: 'image', alt: 't', href: 'https://example.com/a.png' },
    ])
    const upload =
      '<img width="300" alt="Image" src="https://github.com/user-attachments/assets/0f1e2d3c" />'
    expect(firstParagraph(parse(upload))).toEqual([
      { type: 'image', alt: 'Image', href: 'https://github.com/user-attachments/assets/0f1e2d3c' },
    ])
  })

  it('does not nest an image address inside a link', () => {
    const children = firstParagraph(parse('[![build](https://img.shields.io/badge/x.svg)](https://ci.example.com/run/1)'))
    expect(children).toEqual([
      {
        type: 'link',
        href: 'https://ci.example.com/run/1',
        children: [{ type: 'image', alt: 'build', href: null }],
      },
    ])
  })

  it('shows a details summary as a bold paragraph, then the Markdown inside', () => {
    const parsed = parse('<details><summary>Logs</summary>\n\nstack trace here\n\n</details>')
    expect(parsed.blocks[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'strong', children: [{ type: 'text', text: 'Logs' }] }],
    })
    expect(parsed.blocks[1]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'stack trace here' }] })
    expect(parsed.omittedHtml).toBe(false)
  })

  it('keeps a < in a summary that has no tag end, and cuts real tags out of it', () => {
    const summaryText = (summary: string) => {
      const block = parse(`<details>\n<summary>${summary}</summary>\n\nbody\n\n</details>`).blocks[0]
      if (block.type !== 'paragraph') throw new Error('expected a paragraph')
      const strong = block.children[0]
      if (strong.type !== 'strong') throw new Error('expected a bold summary')
      return strong.children[0]
    }
    expect(summaryText('Version < 2.0 crashes')).toEqual({ type: 'text', text: 'Version < 2.0 crashes' })
    expect(summaryText('a < b <i>c</i>')).toEqual({ type: 'text', text: 'a < b c' })
  })

  it('resolves relative links like the issue page', () => {
    const hrefs = (body: string) => links(firstParagraph(parse(body))).map((link) => link.href)
    expect(hrefs('[docs](../wiki/Install)')).toEqual(['https://github.com/acme/widgets/wiki/Install'])
    expect(hrefs('[top](#top)')).toEqual(['https://github.com/acme/widgets/issues/12#top'])
    expect(hrefs('[p](//evil.example/x)')).toEqual(['https://evil.example/x'])
  })

  it('reads task list items', () => {
    const parsed = parse('- [ ] todo\n- [x] done\n- [X] Done too\n- [y] not a task\n- [ ]')
    const list = parsed.blocks[0]
    if (list?.type !== 'list') throw new Error('expected a list')
    expect(list.tight).toBe(true)
    expect(list.items.map((item) => item.task)).toEqual(['open', 'done', 'done', null, 'open'])
    expect(list.items[0].children[0]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'todo' }] })
    expect(list.items[4].children[0]).toEqual({ type: 'paragraph', children: [] })
  })

  it('keeps the paragraphs of a tight list item apart (6 nodes)', () => {
    const parsed = parse('- a\n  <!-- c -->\n  b')
    expect(parsed.blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        start: null,
        tight: true,
        items: [
          {
            task: null,
            children: [
              { type: 'paragraph', children: [{ type: 'text', text: 'a' }] },
              { type: 'paragraph', children: [{ type: 'text', text: 'b' }] },
            ],
          },
        ],
      },
    ])
    expect(countNodes(parsed)).toBe(6)
  })

  it('reads the start of an ordered list', () => {
    const list = parse('3. three\n\n4. four').blocks[0]
    expect(list).toMatchObject({ type: 'list', ordered: true, start: 3, tight: false })
  })

  it('renders a body of 100,000 characters whole, without the truncated flag', () => {
    const parsed = parse(fit('word ', 100_000))
    expect(parsed.truncated).toBe(false)
    expect(joinText(parsed).length).toBeGreaterThan(99_000)
  })

  it('cuts a body of 200,000 characters and sets truncated', () => {
    const parsed = parse('x'.repeat(200_000))
    expect(parsed.truncated).toBe(true)
    expect(joinText(parsed).length).toBe(BODY_RENDER_LIMIT)
  })

  it('stops reading blocks nested deeper than 20 levels, without throwing', () => {
    const parsed = parse('> '.repeat(30_000) + 'deep')
    let depth = 0
    let block: BodyBlock | undefined = parsed.blocks[0]
    while (block?.type === 'blockquote') {
      depth++
      block = block.children[0]
    }
    expect(depth).toBeLessThanOrEqual(20)
    expect(depth).toBeGreaterThan(10)
  })

  it('parses an ordinary table with its alignment', () => {
    const body = '| a | b |\n| - | :-: |\n| 1 | 2 |'
    expect(estimateTableCells(body)).toBe(4)
    const parsed = parse(body)
    expect(parsed.tablesAsText).toBe(false)
    expect(parsed.blocks).toEqual([
      {
        type: 'table',
        head: [
          {
            cells: [
              { align: null, children: [{ type: 'text', text: 'a' }] },
              { align: 'center', children: [{ type: 'text', text: 'b' }] },
            ],
          },
        ],
        body: [
          {
            cells: [
              { align: null, children: [{ type: 'text', text: '1' }] },
              { align: 'center', children: [{ type: 'text', text: '2' }] },
            ],
          },
        ],
      },
    ])
  })

  it('parses a table with tables off when the estimate is over the limit (the review table)', () => {
    const body = '|' + 'a|'.repeat(300) + '\n|' + '-|'.repeat(300) + '\n' + '|b\n'.repeat(230)
    expect(body.length).toBe(1894)
    const parsed = parse(body)
    expect(parsed.tablesAsText).toBe(true)
    expect(parsed.truncated).toBe(false)
    expect(parsed.blocks).toHaveLength(1)
    const children = firstParagraph(parsed)
    expect(children.filter((node) => node.type === 'text')).toHaveLength(232)
    expect(children.filter((node) => node.type === 'break')).toHaveLength(230)
    expect(children.filter((node) => node.type === 'split')).toHaveLength(1)
    expect(countNodes(parsed)).toBe(464)
  })

  it('shows a table of 121 columns (the quota table) as text with 186 nodes and 3 splits', () => {
    const body =
      'How are quotas counted?\n\n' +
      '| Plan |' + Array.from({ length: 120 }, (_, i) => ` Type ${i + 1} |`).join('') + '\n' +
      '|' + ' --- |'.repeat(121) + '\n' +
      Array.from({ length: 90 }, (_, i) => `| Plan ${i + 1} | 10 |`).join('\n')
    expect(estimateTableCells(body)).toBe(11_011)
    expect(estimateTableCells(body)).toBeGreaterThan(TABLE_CELLS_MAX)
    const parsed = parse(body)
    expect(parsed.tablesAsText).toBe(true)
    expect(parsed.blocks.some((block) => block.type === 'table')).toBe(false)
    expect(countNodes(parsed)).toBe(186)
    expect(runReport(parsed).splits).toBe(3)
  })

  it("stops at exactly 10,000 nodes for 'a*' repeated 30,000 times", () => {
    const parsed = parse('a*'.repeat(30_000))
    expect(countNodes(parsed)).toBe(BODY_NODES_MAX)
    expect(runReport(parsed).splits).toBe(3)
    expect(parsed.truncated).toBe(true)
  })

  it('splits mixed-direction text with no spaces into runs of at most 2,048 units', () => {
    const parsed = parse(fit('abאב', 65_536))
    expect(countNodes(parsed)).toBe(64)
    const children = firstParagraph(parsed)
    expect(children.filter((node) => node.type === 'text')).toHaveLength(32)
    expect(children.filter((node) => node.type === 'split')).toHaveLength(31)
    expect(runReport(parsed).maxRun).toBe(RUN_TEXT_MAX)
  })

  it('gives 9,965 images with href null in 10,000 nodes and 34 splits for the quote-query reference body', () => {
    const head = `[r]: https://example.com/?${"'".repeat(2020)}\n\n`
    const body = head + '![][r]'.repeat(Math.ceil((65_534 - head.length) / 6)).slice(0, 65_534 - head.length)
    const parsed = parse(body)
    const children = firstParagraph(parsed)
    const images = children.filter((node) => node.type === 'image')
    expect(countNodes(parsed)).toBe(BODY_NODES_MAX)
    expect(parsed.truncated).toBe(true)
    expect(images).toHaveLength(9_965)
    expect(children.filter((node) => node.type === 'split')).toHaveLength(34)
    expect(images.every((image) => image.href === null)).toBe(true)
  })
})

describe('parseIssueBody: patterns that make markdown-it slow, at 8,192 units', () => {
  const cases: Array<[string, string, number, number]> = [
    ['a<!--', fit('a<!--', 8_192), 8, 3],
    ['a<?', fit('a<?', 8_192), 8, 3],
    ['a<!A ', fit('a<!A ', 8_192), 10, 4],
    ['text <!-- x ', fit('text <!-- x ', 8_192), 10, 4],
    ['a<!--\\n', fit('a<!--\n', 8_192), 2_732, 6],
    ['a<![CDATA[', fit('a<![CDATA[', 8_192), 8, 3],
  ]
  it.each(cases)('%s gives the node and split counts and no flag', (_name, body, nodes, splits) => {
    const parsed = parse(body)
    expect(countNodes(parsed)).toBe(nodes)
    expect(runReport(parsed).splits).toBe(splits)
    expect(parsed.truncated).toBe(false)
    expect(parsed.omittedHtml).toBe(false)
  })
})

describe('parseIssueBody: the run rule', () => {
  const SHAPES: Record<string, (n: number) => string> = {
    'bidi, no spaces, one paragraph': (n) => fit('abאב', n),
    'emoji, one paragraph': (n) => fit('\u{1F600} ', n),
    'bidi inside strong': (n) => '**' + fit('abאב', n - 4) + '**',
    'bidi inside strong emphasis inside a link': (n) => '[***' + fit('abאב', n - 30) + '***](https://a.co/)',
    'bidi as link text': (n) => '[' + fit('abאב', n - 20) + '](https://a.co/)',
    'bidi in one table cell': (n) => '| a |\n| - |\n| ' + fit('abאב', n - 20) + ' |',
    'bidi heading': (n) => '# ' + fit('abאב', n - 2),
    'bidi inline code': (n) => '`' + fit('abאב', n - 2) + '`',
    'bidi lines in one paragraph': (n) => fit('abאבabאבabאב\n', n),
    'long words with spaces': (n) => fit('abcdefghij'.repeat(30) + ' ', n),
    'summary text': (n) => '<details><summary>' + fit('abאב ', n - 40) + '</summary>\n\n</details>',
    'images with long alt text': (n) => fit('![' + 'a'.repeat(100) + '](https://a.co/x.png)', n),
    'surrogate pairs only': (n) => fit('\u{1F600}', n),
    'one letter then surrogate pairs': (n) => 'a' + fit('\u{1F600}', n - 1),
    'letters and pairs mixed': (n) => fit('a\u{1F600}bc\u{1F600}', n),
  }

  for (const [name, make] of Object.entries(SHAPES)) {
    it(`keeps every run within 2,048 units: ${name}`, () => {
      const report = runReport(parse(make(65_536)))
      expect(report.maxRun).toBeLessThanOrEqual(RUN_TEXT_MAX)
      expect(report.splitInsideContainer).toBe(false)
      expect(report.halfPairs).toBe(0)
    })
  }

  it.each(['bidi, no spaces, one paragraph', 'surrogate pairs only', 'long words with spaces'])(
    'keeps the text of a one-paragraph body: %s',
    (name) => {
      const body = SHAPES[name](20_000)
      expect(joinText(parse(body))).toBe(body.trim())
    },
  )

  it('re-opens a strong container after each split', () => {
    const parsed = parse(SHAPES['bidi inside strong'](10_000))
    const children = firstParagraph(parsed)
    expect(children.filter((node) => node.type === 'strong').length).toBeGreaterThan(1)
    expect(children.filter((node) => node.type === 'text')).toHaveLength(0)
  })

  it('handles the fixture-sized paragraph of Latin and Hebrew text with 28 runs', () => {
    const body =
      'Proposed shortcuts:\n\n' +
      'Ctrl+K פתח חיפוש, Ctrl+B הוסף כרטיס, '.repeat(1_500)
    const parsed = parse(body)
    const report = runReport(parsed)
    expect(report.maxRun).toBeLessThanOrEqual(RUN_TEXT_MAX)
    expect(report.splits).toBeGreaterThan(20)
  })
})

describe('parseIssueBody: the fallback when markdown-it throws', () => {
  it('returns text, break and split nodes in one paragraph', () => {
    vi.spyOn(MarkdownIt.prototype, 'parse').mockImplementation(() => {
      throw new Error('boom')
    })
    const body = 'first line\r\nsecond line\n\n' + fit('word ', 6_000)
    const parsed = parse(body)
    expect(parsed.omittedHtml).toBe(false)
    expect(parsed.tablesAsText).toBe(false)
    expect(parsed.truncated).toBe(false)
    expect(parsed.blocks).toHaveLength(1)
    const children = firstParagraph(parsed)
    expect(children[0]).toEqual({ type: 'text', text: 'first line' })
    expect(children[1]).toEqual({ type: 'break' })
    expect(children.some((node) => node.type === 'split')).toBe(true)
    expect(runReport(parsed).maxRun).toBeLessThanOrEqual(RUN_TEXT_MAX)
  })

  it('returns no blocks for an empty body', () => {
    vi.spyOn(MarkdownIt.prototype, 'parse').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(parse('')).toEqual({ blocks: [], omittedHtml: false, truncated: false, tablesAsText: false })
  })

  it('respects its own node budget and sets truncated', () => {
    vi.spyOn(MarkdownIt.prototype, 'parse').mockImplementation(() => {
      throw new Error('boom')
    })
    const parsed = parse('a\n'.repeat(20_000))
    expect(countNodes(parsed)).toBe(BODY_NODES_MAX)
    expect(parsed.truncated).toBe(true)
  })

  it('sets truncated when the body was cut', () => {
    vi.spyOn(MarkdownIt.prototype, 'parse').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(parse('x'.repeat(BODY_RENDER_LIMIT + 1)).truncated).toBe(true)
  })
})
