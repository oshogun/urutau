// Turns an issue's Markdown body into a tree of plain data (see bodyTree.ts). It is the only
// module in src/ that imports markdown-it, and only the worker entry (issueBody.worker.ts) imports
// it at run time, so markdown-it never runs on the main thread. Only `md.parse` is called: no
// HTML string is produced, and every string in the tree is shown by the UI as text.
import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import {
  ALT_MAX,
  BLOCK_NESTING_MAX,
  BODY_NODES_MAX,
  HREF_MAX,
  INLINE_DEPTH_MAX,
  RUN_TEXT_MAX,
  TABLE_CELLS_MAX,
  cutBody,
  type BodyBlock,
  type BodyInline,
  type BodyListItem,
  type BodyTableCell,
  type BodyTableRow,
  type ParsedBody,
} from './bodyTree.ts'

const SCHEMES = new Set(['http:', 'https:', 'mailto:'])

const OPTIONS = { html: true, linkify: true, typographer: false, maxNesting: BLOCK_NESTING_MAX }
const md = new MarkdownIt('default', OPTIONS)
const mdNoTables = new MarkdownIt('default', OPTIONS).disable('table')

/**
 * Resolves `raw` against `base` (the issue's GitHub address) and returns the resulting `href` when
 * its scheme is http:, https: or mailto: and it is at most HREF_MAX units long; null otherwise,
 * and null when `raw` is longer than HREF_MAX or does not parse. The length is checked again after
 * parsing because the URL parser percent-encodes some characters that markdown-it leaves as they
 * are (`'` in a query, `;` in user info), so the parsed address can be three times longer.
 */
export function safeHref(raw: string | null, base: string): string | null {
  if (typeof raw !== 'string' || raw.length > HREF_MAX) return null
  try {
    const url = new URL(raw, base)
    return SCHEMES.has(url.protocol) && url.href.length <= HREF_MAX ? url.href : null
  } catch {
    return null
  }
}

const LINE_BREAK = /\r\n?|\n/
const CONTAINER_PREFIX = /^[ \t>]+/
const DELIMITER_ROW = /^[|\-: \t]+$/
const DASH_RUN = /-+/g

/**
 * An upper bound on the table cells (header and body cells) markdown-it emits for `source`,
 * computed without parsing, in one pass over its lines. Never smaller than the real count.
 * Each line that could be a table's delimiter row (only `|`, `-`, `:`, spaces and tabs after its
 * container prefix, preceded by a line with `|`) counts its columns times the rows that may
 * follow it, up to the next blank line.
 */
export function estimateTableCells(source: string): number {
  const lines = source.split(LINE_BREAK)
  let total = 0
  // Number of consecutive lines after line i whose trim() is not empty.
  let rowsAfter = 0
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]
    const rest = line.replace(CONTAINER_PREFIX, '')
    if (rest.includes('-') && DELIMITER_ROW.test(rest) && lines[i - 1].includes('|')) {
      const columns = (rest.match(DASH_RUN) ?? []).length
      total += columns * (1 + rowsAfter)
    }
    rowsAfter = line.trim() === '' ? 0 : rowsAfter + 1
  }
  return total
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isSpaceOrTab = (code: number): boolean => code === 0x20 || code === 0x09

// Where to cut `text` so the first part has at most `room` code units: after the last space or tab
// in the second half of the room, else at `room`, one less if that would separate a surrogate pair
// (0 when the room is one unit and that unit starts a pair: the split then comes first).
function cutPoint(text: string, room: number): number {
  for (let i = room - 1; i >= Math.ceil(room / 2); i--) {
    if (isSpaceOrTab(text.charCodeAt(i))) return i + 1
  }
  return isHighSurrogate(text.charCodeAt(room - 1)) ? room - 1 : room
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

// The index of the `>` that ends a tag starting before `from`, or -1 when a `<` or the end of the
// text comes first.
function tagEndFrom(html: string, from: number): number {
  for (let i = from; i < html.length; i++) {
    if (html[i] === '>') return i
    if (html[i] === '<') return -1
  }
  return -1
}

// The text of an HTML fragment with its comments and tags removed. One left-to-right pass: an
// unterminated comment ends the text, a tag end is searched only up to the next `<`, and a `<`
// with no tag end is kept as text.
function visibleText(html: string): string {
  let out = ''
  let at = 0
  while (at < html.length) {
    const tag = html.indexOf('<', at)
    if (tag === -1) {
      out += html.slice(at)
      break
    }
    out += html.slice(at, tag)
    if (html.startsWith('<!--', tag)) {
      const close = html.indexOf('-->', tag + 4)
      if (close === -1) break
      at = close + 3
    } else {
      const close = tagEndFrom(html, tag + 1)
      if (close === -1) {
        out += '<'
        at = tag + 1
      } else {
        at = close + 1
      }
    }
  }
  return out
}

type HtmlEvent = { kind: 'summary'; text: string } | { kind: 'img'; tag: string }

// One left-to-right scan of an HTML block. Every search stops at the next `<`, so it is linear in
// the length of the block. Emits summaries and img tags in order, and reports other visible text.
function scanHtmlBlock(html: string): { events: HtmlEvent[]; omitted: boolean } {
  const lower = html.toLowerCase()
  const events: HtmlEvent[] = []
  let other = ''
  let at = 0
  const opens = (name: string, i: number): boolean =>
    lower.startsWith(`<${name}`, i) && /[\s/>]/.test(lower.charAt(i + name.length + 1) || '>')
  while (at < html.length) {
    const lt = html.indexOf('<', at)
    if (lt === -1) {
      other += html.slice(at)
      break
    }
    other += html.slice(at, lt)
    if (lower.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      at = close === -1 ? html.length : close + 3
    } else if (opens('summary', lt)) {
      const open = tagEndFrom(html, lt + 8)
      if (open === -1) {
        other += '<'
        at = lt + 1
        continue
      }
      const close = lower.indexOf('</summary', open + 1)
      const inner = html.slice(open + 1, close === -1 ? html.length : close)
      const text = visibleText(inner).replace(/\s+/g, ' ').trim()
      if (text !== '') events.push({ kind: 'summary', text })
      if (close === -1) {
        at = html.length
      } else {
        const end = tagEndFrom(html, close + 9)
        at = end === -1 ? close + 9 : end + 1
      }
    } else if (opens('img', lt)) {
      const end = tagEndFrom(html, lt + 4)
      if (end === -1) {
        other += '<'
        at = lt + 1
        continue
      }
      events.push({ kind: 'img', tag: html.slice(lt, end + 1) })
      at = end + 1
    } else {
      const end = tagEndFrom(html, lt + 1)
      if (end === -1) {
        other += '<'
        at = lt + 1
        continue
      }
      at = end + 1
    }
  }
  return { events, omitted: other.trim() !== '' }
}

const BR = /^<br\s*\/?>$/i

function cutAlt(text: string): string {
  const chars = Array.from(text.trim())
  return chars.length > ALT_MAX ? `${chars.slice(0, ALT_MAX).join('')}…` : chars.join('')
}

type ImageNode = Extract<BodyInline, { type: 'image' }>

function imageNode(src: string | null, alt: string | null, insideLink: boolean, base: string): ImageNode {
  return { type: 'image', alt: cutAlt(alt ?? ''), href: insideLink ? null : safeHref(src ?? '', base) }
}

function tokenAttr(token: Token, name: string): string | null {
  const value = token.attrGet(name)
  return typeof value === 'string' ? value : null
}

// The node budget: `take()` is called just before a node is appended to a parent that is in the
// tree. Once it returns false nothing more is appended and the walkers stop.
interface Budget {
  stopped: boolean
  take(): boolean
}

function budget(max: number): Budget {
  let used = 0
  const state: Budget = {
    stopped: false,
    take() {
      if (used >= max) {
        state.stopped = true
        return false
      }
      used++
      return true
    },
  }
  return state
}

type InlineContainer = Extract<BodyInline, { children: BodyInline[] }>
type InlineTarget = { children: BodyInline[] }

interface InlineWriter {
  /** Containers opened and not yet closed, not counting the ones passed through. */
  readonly depth: number
  openContainer(node: InlineContainer): boolean
  passThrough(): void
  close(): void
  lineBreak(): void
  text(type: 'text' | 'code', value: string): void
  image(node: ImageNode): void
}

// Every inline node of one paragraph, heading or cell goes through this writer. It keeps the run
// rule: a run holds at most RUN_TEXT_MAX code units of text; a full run ends with a split marker
// placed directly in the target, and the open containers are re-opened after it.
function inlineWriter(target: InlineTarget, nodes: Budget): InlineWriter {
  const open: InlineTarget[] = [target]
  const pushed: boolean[] = []
  let run = 0
  const top = (): InlineTarget => open[open.length - 1]
  const appendTo = (parent: InlineTarget, node: BodyInline): boolean => {
    if (!nodes.take()) return false
    parent.children.push(node)
    return true
  }
  const split = (): boolean => {
    if (!appendTo(target, { type: 'split' })) return false
    run = 0
    const chain = open.splice(1) as InlineContainer[]
    for (const container of chain) {
      const copy: InlineContainer =
        container.type === 'link'
          ? { type: 'link', href: container.href, children: [] }
          : { type: container.type, children: [] }
      if (!appendTo(top(), copy)) return false
      open.push(copy)
    }
    return true
  }
  return {
    get depth() {
      return open.length - 1
    },
    openContainer(node) {
      if (!appendTo(top(), node)) return false
      open.push(node)
      pushed.push(true)
      return true
    },
    passThrough() {
      pushed.push(false)
    },
    close() {
      if (pushed.length > 0 && pushed.pop()) open.pop()
    },
    lineBreak() {
      if (open.length === 1 && run >= RUN_TEXT_MAX / 2) split()
      else appendTo(top(), { type: 'break' })
    },
    text(type, value) {
      let rest = value
      while (rest.length > 0 && !nodes.stopped) {
        const room = RUN_TEXT_MAX - run
        if (rest.length <= room) {
          if (appendTo(top(), { type, text: rest })) run += rest.length
          return
        }
        const take = room > 0 ? cutPoint(rest, room) : 0
        if (take > 0) {
          if (!appendTo(top(), { type, text: rest.slice(0, take) })) return
          rest = rest.slice(take)
        }
        if (!split()) return
      }
    },
    image(node) {
      const length = node.alt.length + 7
      if (run > 0 && run + length > RUN_TEXT_MAX && !split()) return
      if (appendTo(top(), node)) run += length
    },
  }
}

function inlineNodes(tokens: Token[], base: string, writer: InlineWriter, nodes: Budget): void {
  let linkDepth = 0
  for (const token of tokens) {
    if (nodes.stopped) break
    switch (token.type) {
      case 'text':
      case 'text_special':
        if (token.content !== '') writer.text('text', token.content)
        break
      case 'softbreak':
      case 'hardbreak':
        writer.lineBreak()
        break
      case 'code_inline':
        if (token.content !== '') writer.text('code', token.content)
        break
      case 'em_open':
      case 'strong_open':
      case 's_open': {
        const type = token.type === 'em_open' ? 'emphasis' : token.type === 'strong_open' ? 'strong' : 'strikethrough'
        if (writer.depth >= INLINE_DEPTH_MAX || !writer.openContainer({ type, children: [] })) writer.passThrough()
        break
      }
      case 'link_open': {
        const href = linkDepth > 0 ? null : safeHref(tokenAttr(token, 'href'), base)
        if (href === null || writer.depth >= INLINE_DEPTH_MAX || !writer.openContainer({ type: 'link', href, children: [] })) {
          writer.passThrough()
        }
        linkDepth++
        break
      }
      case 'em_close':
      case 'strong_close':
      case 's_close':
        writer.close()
        break
      case 'link_close':
        writer.close()
        linkDepth = Math.max(0, linkDepth - 1)
        break
      case 'image':
        writer.image(imageNode(tokenAttr(token, 'src'), token.content, linkDepth > 0, base))
        break
      case 'html_inline': {
        const value = token.content.trim()
        if (BR.test(value)) writer.lineBreak()
        else if (/^<img[\s/>]/i.test(value)) {
          writer.image(imageNode(attr(value, 'src'), attr(value, 'alt'), linkDepth > 0, base))
        }
        break
      }
      default:
        if (token.content) writer.text('text', token.content)
    }
  }
}

const ALIGN: Record<string, BodyTableCell['align']> = {
  'text-align:left': 'left',
  'text-align:center': 'center',
  'text-align:right': 'right',
}
const TASK = /^\[([ xX])\](?: |$)/

// The plain-text fallback, under its own node budget: one paragraph of the source's lines.
function plainText(source: string): { blocks: BodyBlock[]; stopped: boolean } {
  const nodes = budget(BODY_NODES_MAX)
  if (source === '') return { blocks: [], stopped: false }
  const paragraph: BodyBlock & { type: 'paragraph' } = { type: 'paragraph', children: [] }
  nodes.take()
  const writer = inlineWriter(paragraph, nodes)
  source.split(/\r?\n/).forEach((line, i) => {
    if (nodes.stopped) return
    if (i > 0) writer.lineBreak()
    if (line !== '') writer.text('text', line)
  })
  return { blocks: [paragraph], stopped: nodes.stopped }
}

type Frame =
  | { kind: 'root'; children: BodyBlock[] }
  | { kind: 'blockquote'; children: BodyBlock[] }
  | { kind: 'list'; node: BodyBlock & { type: 'list' } }
  | { kind: 'item'; children: BodyBlock[]; item: BodyListItem }
  | { kind: 'table'; node: BodyBlock & { type: 'table' }; section: 'head' | 'body'; row: BodyTableRow | null }
  | { kind: 'skipped' }

// Block tokens to BodyBlock[], with an explicit stack of open containers.
function convert(tokens: Token[], issueUrl: string, nodes: Budget): { blocks: BodyBlock[]; omittedHtml: boolean } {
  let omittedHtml = false
  const root: Frame & { kind: 'root' } = { kind: 'root', children: [] }
  const stack: Frame[] = [root]
  const top = (): Frame => stack[stack.length - 1]
  // Appends a block to the current container; false when the container takes no blocks or the budget is spent.
  const add = (block: BodyBlock): boolean => {
    const container = top()
    if (container.kind !== 'root' && container.kind !== 'blockquote' && container.kind !== 'item') return false
    if (!nodes.take()) return false
    container.children.push(block)
    return true
  }
  let pending: InlineTarget | null = null
  for (const token of tokens) {
    if (nodes.stopped) break
    switch (token.type) {
      case 'paragraph_open': {
        const node: BodyBlock = { type: 'paragraph', children: [] }
        pending = add(node) ? node : null
        if (token.hidden) {
          // Tight list: markdown-it hides the paragraph tokens of every item.
          for (let i = stack.length - 1; i >= 0; i--) {
            const frame = stack[i]
            if (frame.kind === 'list') {
              frame.node.tight = true
              break
            }
          }
        }
        break
      }
      case 'heading_open': {
        const level = Number(token.tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6
        const node: BodyBlock = { type: 'heading', level, children: [] }
        pending = add(node) ? node : null
        break
      }
      case 'th_open':
      case 'td_open': {
        const cell: BodyTableCell = { align: ALIGN[tokenAttr(token, 'style') ?? ''] ?? null, children: [] }
        const frame = top()
        const row = frame.kind === 'table' ? frame.row : null
        if (row && nodes.take()) {
          row.cells.push(cell)
          pending = cell
        } else {
          pending = null
        }
        break
      }
      case 'inline':
        if (pending) inlineNodes(token.children ?? [], issueUrl, inlineWriter(pending, nodes), nodes)
        pending = null
        break
      case 'paragraph_close':
      case 'heading_close':
      case 'th_close':
      case 'td_close':
        pending = null
        break
      case 'blockquote_open': {
        const node: BodyBlock & { type: 'blockquote' } = { type: 'blockquote', children: [] }
        stack.push(add(node) ? { kind: 'blockquote', children: node.children } : { kind: 'skipped' })
        break
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open'
        const start = token.attrGet('start')
        const node: BodyBlock & { type: 'list' } = {
          type: 'list',
          ordered,
          start: ordered ? (start === null ? 1 : Number(start)) : null,
          tight: false,
          items: [],
        }
        stack.push(add(node) ? { kind: 'list', node } : { kind: 'skipped' })
        break
      }
      case 'list_item_open': {
        const item: BodyListItem = { task: null, children: [] }
        const list = top()
        if (list.kind === 'list' && nodes.take()) {
          list.node.items.push(item)
          stack.push({ kind: 'item', children: item.children, item })
        } else {
          stack.push({ kind: 'skipped' })
        }
        break
      }
      case 'list_item_close': {
        const frame = stack.pop()
        if (frame?.kind !== 'item') break
        const first = frame.item.children[0]
        const firstInline = first?.type === 'paragraph' ? first.children[0] : undefined
        if (first?.type === 'paragraph' && firstInline?.type === 'text') {
          const match = TASK.exec(firstInline.text)
          if (match) {
            frame.item.task = match[1] === ' ' ? 'open' : 'done'
            const rest = firstInline.text.slice(match[0].length)
            if (rest === '') first.children.shift()
            else first.children[0] = { type: 'text', text: rest }
          }
        }
        break
      }
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'blockquote_close':
      case 'table_close':
        stack.pop()
        break
      case 'table_open': {
        const node: BodyBlock & { type: 'table' } = { type: 'table', head: [], body: [] }
        stack.push(add(node) ? { kind: 'table', node, section: 'head', row: null } : { kind: 'skipped' })
        break
      }
      case 'thead_open':
      case 'tbody_open': {
        const frame = top()
        if (frame.kind === 'table') frame.section = token.type === 'thead_open' ? 'head' : 'body'
        break
      }
      case 'tr_open': {
        const frame = top()
        if (frame.kind !== 'table') break
        const row: BodyTableRow = { cells: [] }
        if (nodes.take()) {
          frame.node[frame.section].push(row)
          frame.row = row
        } else {
          frame.row = null
        }
        break
      }
      case 'fence':
      case 'code_block':
        add({ type: 'code', text: token.content.replace(/\n$/, '') })
        break
      case 'hr':
        add({ type: 'rule' })
        break
      case 'html_block': {
        const scan = scanHtmlBlock(token.content)
        let images: InlineWriter | null = null
        for (const event of scan.events) {
          if (nodes.stopped) break
          if (event.kind === 'summary') {
            images = null
            const paragraph: BodyBlock & { type: 'paragraph' } = { type: 'paragraph', children: [] }
            if (add(paragraph)) {
              const writer = inlineWriter(paragraph, nodes)
              if (writer.openContainer({ type: 'strong', children: [] })) writer.text('text', event.text)
            }
          } else {
            if (!images) {
              const paragraph: BodyBlock & { type: 'paragraph' } = { type: 'paragraph', children: [] }
              if (!add(paragraph)) continue
              images = inlineWriter(paragraph, nodes)
            } else {
              images.text('text', ' ')
            }
            images.image(imageNode(attr(event.tag, 'src'), attr(event.tag, 'alt'), false, issueUrl))
          }
        }
        if (scan.omitted) omittedHtml = true
        break
      }
      case 'thead_close':
      case 'tbody_close':
      case 'tr_close':
      case 'reference_definition':
        break
      default:
        if (token.content) {
          const paragraph: BodyBlock & { type: 'paragraph' } = { type: 'paragraph', children: [] }
          if (add(paragraph)) inlineWriter(paragraph, nodes).text('text', token.content)
        }
    }
  }
  return { blocks: root.children, omittedHtml }
}

/**
 * Parses an issue body. Never throws: if markdown-it or the conversion throws, it returns the
 * plain-text fallback. `body` is the `Issue.body` string, or the worker request's `body` (cut to
 * BODY_RENDER_LIMIT + 1, so a longer body is still detected); `issueUrl` is `Issue.url`. The
 * returned tree has at most BODY_NODES_MAX nodes, and no run in it holds more than RUN_TEXT_MAX
 * code units of text.
 */
export function parseIssueBody(body: string, issueUrl: string): ParsedBody {
  const { text: source, cut: cutShort } = cutBody(body)
  try {
    const tablesAsText = estimateTableCells(source) > TABLE_CELLS_MAX
    const nodes = budget(BODY_NODES_MAX)
    const tokens = (tablesAsText ? mdNoTables : md).parse(source, {})
    const { blocks, omittedHtml } = convert(tokens, issueUrl, nodes)
    return { blocks, omittedHtml, truncated: cutShort || nodes.stopped, tablesAsText }
  } catch {
    const fallback = plainText(source)
    return { blocks: fallback.blocks, omittedHtml: false, truncated: cutShort || fallback.stopped, tablesAsText: false }
  }
}
