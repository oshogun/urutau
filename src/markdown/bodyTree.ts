// Types, constants and pure helpers shared by the main thread and the body worker. It has no
// runtime import, so a module that imports it never pulls markdown-it into the main bundle. Only
// issueBody.ts imports markdown-it; the UI imports from this file and from parseBodyInWorker.ts.

/** Bodies longer than this many UTF-16 code units are cut to this length before parsing. */
export const BODY_RENDER_LIMIT = 131_072

/** Addresses longer than this many UTF-16 code units, as written in the body or after parsing, are refused by `safeHref`. */
export const HREF_MAX = 2_048

/** Image descriptions longer than this many code points are cut and end with an ellipsis (U+2026). */
export const ALT_MAX = 100

/** Passed to markdown-it as `maxNesting`: block content nested deeper than this (lists, quotes) is not read. */
export const BLOCK_NESTING_MAX = 20

/** Inside one paragraph, heading or cell, emphasis, strong, strikethrough and links nested deeper than this keep their text and lose their formatting. */
export const INLINE_DEPTH_MAX = 8

/**
 * The converter appends at most this many nodes to the tree: blocks, inline nodes (split markers
 * included), list items, table rows and table cells all count. At the limit it stops and sets `truncated`.
 */
export const BODY_NODES_MAX = 10_000

/**
 * When `estimateTableCells(source)` is larger than this, the body is parsed with markdown-it's
 * table rule turned off, so tables show as their Markdown text, and `tablesAsText` is set.
 */
export const TABLE_CELLS_MAX = 10_000

/**
 * No block box the page lays out for a body holds more than this many UTF-16 code units of body
 * text. Chromium's layout time for one block of mixed-direction text grows with the square of its
 * length; keeping every block at or under this size keeps the main thread's layout time linear in
 * the length of the body. Paragraphs, headings and table cells are split by the converter (split
 * markers); code blocks and the plain-text view are split by `splitTextRuns`.
 */
export const RUN_TEXT_MAX = 2_048

/** Text inside a paragraph, heading or table cell. */
export type BodyInline =
  | { type: 'text'; text: string }
  /** A line break: markdown-it's `softbreak` and `hardbreak`, and an HTML `<br>` tag. */
  | { type: 'break' }
  | { type: 'code'; text: string }
  | { type: 'emphasis'; children: BodyInline[] }
  | { type: 'strong'; children: BodyInline[] }
  | { type: 'strikethrough'; children: BodyInline[] }
  /** `href` is the output of `safeHref`: an absolute http, https or mailto address. */
  | { type: 'link'; href: string; children: BodyInline[] }
  /**
   * A Markdown image or an HTML `<img>` tag. Never loaded: the UI renders it as a link to `href`
   * labelled "Image" or "Image: <alt>", or as that label alone when `href` is null (a refused
   * address, or an image inside a link).
   */
  | { type: 'image'; alt: string; href: string | null }
  /**
   * The end of one run and the start of the next (see `parseIssueBody`). It appears only
   * directly in a paragraph's, heading's or cell's `children`, never inside emphasis, strong,
   * strikethrough or a link. Between two splits (or a target's start or end) there are at most
   * RUN_TEXT_MAX code units of text. The UI renders each run as its own block box.
   */
  | { type: 'split' }

export interface BodyListItem {
  /** `'open'` for a leading `[ ] `, `'done'` for `[x] ` or `[X] `, null otherwise. */
  task: 'open' | 'done' | null
  children: BodyBlock[]
}

export interface BodyTableCell {
  align: 'left' | 'center' | 'right' | null
  children: BodyInline[]
}

export interface BodyTableRow {
  cells: BodyTableCell[]
}

export type BodyBlock =
  | { type: 'paragraph'; children: BodyInline[] }
  /** The level written in the Markdown, 1 to 6. The UI may show it one level lower. */
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: BodyInline[] }
  | { type: 'blockquote'; children: BodyBlock[] }
  /**
   * `start` is the first number of an ordered list (1 when the Markdown gives none) and null for
   * a bullet list. `tight` is true when markdown-it hid the paragraphs of the items: the UI then
   * renders each item's paragraphs without paragraph spacing.
   */
  | { type: 'list'; ordered: boolean; start: number | null; tight: boolean; items: BodyListItem[] }
  /** A fenced or indented code block; `text` has its final newline removed. The UI splits it with `splitTextRuns`. */
  | { type: 'code'; text: string }
  | { type: 'rule' }
  | { type: 'table'; head: BodyTableRow[]; body: BodyTableRow[] }

export interface ParsedBody {
  blocks: BodyBlock[]
  /** True when an HTML block held visible text that is not shown. */
  omittedHtml: boolean
  /**
   * True when only the start of the body is in `blocks`: the body was longer than
   * BODY_RENDER_LIMIT, or the converter reached BODY_NODES_MAX.
   */
  truncated: boolean
  /** True when the body was parsed with tables turned off because its estimate passed TABLE_CELLS_MAX. */
  tablesAsText: boolean
}

/** The one message the main thread posts to the body worker. */
export interface BodyWorkerRequest {
  /** The body cut to at most BODY_RENDER_LIMIT + 1 code units (one more than the limit, so the parser can still see that it was longer). */
  body: string
  /** `Issue.url`. */
  issueUrl: string
}

/**
 * The messages the body worker posts: `ready` once, when its module has loaded, then `parsed`
 * once, for the request. Every value in it can be copied by the structured clone algorithm.
 */
export type BodyWorkerMessage = { type: 'ready' } | { type: 'parsed'; parsed: ParsedBody }

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/**
 * Cuts a body for parsing and for the plain-text view: the first
 * BODY_RENDER_LIMIT code units, minus one more if the last kept unit is a high surrogate
 * (0xD800 to 0xDBFF). `cut` is true when anything was removed.
 */
export function cutBody(body: string): { text: string; cut: boolean } {
  if (body.length <= BODY_RENDER_LIMIT) return { text: body, cut: false }
  let end = BODY_RENDER_LIMIT
  if (isHighSurrogate(body.charCodeAt(end - 1))) end -= 1
  return { text: body.slice(0, end), cut: true }
}

/**
 * Splits `text` into parts of at most `max` code units whose concatenation is `text`.
 * From each start position, the part ends just after the last newline
 * ('\n') at an index from start to start + max - 1, if there is one; otherwise at start + max,
 * one unit earlier if the unit at start + max - 1 is a high surrogate. The last part is the
 * rest (possibly ''; `splitTextRuns('')` is `['']`). Linear: each backward search stops at the start position.
 */
export function splitTextRuns(text: string, max: number): string[] {
  const runs: string[] = []
  let start = 0
  while (text.length - start > max) {
    let end = start + max
    let newline = -1
    for (let i = end - 1; i >= start; i--) {
      if (text.charCodeAt(i) === 0x0a) {
        newline = i
        break
      }
    }
    if (newline !== -1) end = newline + 1
    else if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
    runs.push(text.slice(start, end))
    start = end
  }
  runs.push(text.slice(start))
  return runs
}
