import { describe, expect, it } from 'vitest'
import type { StoredBoard } from '../../src/domain/api.ts'
import { resolveBuckets } from '../../src/domain/board.ts'
import type { BoardConfig, Bucket, Issue } from '../../src/domain/types.ts'
import { boardJson, boardListJson, editorJson, readableBoard, windowNumbers, type BoardActivityInput, type BoardJsonOptions } from './boardJson.ts'
import { bucketIds } from './clean.ts'
import { DISPLAY_CAPS, MCP_LIMITS, type BoardSnapshot } from './contract.ts'

function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  const day = `2026-01-${String(number % 28 + 1).padStart(2, '0')}T00:00:00Z`
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    stateReason: null,
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    assignees: [],
    author: null,
    milestone: null,
    comments: 0,
    createdAt: day,
    updatedAt: day,
    closedAt: null,
    ...overrides,
  }
}

function makeBucket(id: string, overrides: Partial<Bucket> = {}): Bucket {
  return { id, title: id, wipLimit: null, labelRules: [], collectsClosed: false, ...overrides }
}

function makeBoard(buckets: Bucket[], overrides: Partial<BoardConfig> = {}): BoardConfig {
  return { version: 1, buckets, placements: {}, order: {}, closedWindowDays: 14, ...overrides }
}

const OPTIONS: BoardJsonOptions = { buckets: null, limitPerBucket: 50, offset: 0, includeClosed: false }

function stored(board: StoredBoard['board']): StoredBoard {
  return {
    repoKey: 'acme/widgets',
    fullName: 'acme/widgets',
    version: 7,
    updatedAt: '2026-10-03T12:00:00.000Z',
    updatedBy: { id: 'u1', username: 'ada', kind: 'person' },
    board,
  }
}

function snapshot(issues: Issue[], overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    issues,
    seen: new Set(issues.map((issue) => issue.number)),
    highestNumber: Math.max(0, ...issues.map((issue) => issue.number)),
    pullRequests: new Set(),
    truncated: false,
    isPrivate: false,
    fetchedAt: Date.UTC(2026, 9, 3, 12, 0, 5),
    ...overrides,
  }
}

const NO_ACTIVITY: BoardActivityInput = { claims: new Map(), lastRuns: new Map(), waiting: [], now: new Date('2026-10-08T14:00:00.000Z') }

function build(stor: StoredBoard, snap: BoardSnapshot, options: Partial<BoardJsonOptions> = {}, activity: BoardActivityInput = NO_ACTIVITY) {
  return boardJson(stor, snap, bucketIds(stor.board.buckets), { ...OPTIONS, ...options }, activity)
}

describe('boardJson order', () => {
  it('lists buckets and cards in the order resolveBuckets gives', () => {
    const board = makeBoard(
      [
        makeBucket('backlog'),
        makeBucket('doing', { labelRules: ['status: doing'], wipLimit: 3 }),
        makeBucket('done', { collectsClosed: true }),
      ],
      { placements: { 4: 'doing' }, order: { backlog: [3, 1], doing: [4] } },
    )
    const issues = [
      makeIssue(1),
      makeIssue(2),
      makeIssue(3),
      makeIssue(4),
      makeIssue(5, { labels: ['status: doing'] }),
      makeIssue(6, { state: 'closed', closedAt: '2026-02-01T00:00:00Z' }),
    ]
    const json = build(stored(board), snapshot(issues), { includeClosed: true })
    const expected = resolveBuckets(issues, board)
    expect(json.buckets.map((bucket) => bucket.id)).toEqual(board.buckets.map((bucket) => bucket.id))
    for (const bucket of json.buckets) {
      expect(bucket.cards.map((card) => card.number)).toEqual((expected.get(bucket.id) ?? []).map((i) => i.number))
    }
    expect(json.buckets[0].cards.map((card) => card.number)).toEqual([3, 1, 2])
    expect(json.buckets[1].wipLimit).toBe(3)
    expect(json).toMatchObject({ repo: 'acme/widgets', private: false, version: 7, closedWindowDays: 14 })
    expect(json.fetchedAt).toBe('2026-10-03T12:00:05.000Z')
    expect(json.updatedBy).toEqual({ username: 'ada', kind: 'person' })
  })

  it('hides closed cards unless asked and counts them', () => {
    const board = makeBoard([makeBucket('open'), makeBucket('done', { collectsClosed: true })])
    const issues = [makeIssue(1), makeIssue(2, { state: 'closed' }), makeIssue(3, { state: 'closed' })]
    const hidden = build(stored(board), snapshot(issues))
    expect(hidden.closedHidden).toBe(2)
    expect(hidden.buckets[1]).toMatchObject({ total: 0, cards: [], more: false })
    const shown = build(stored(board), snapshot(issues), { includeClosed: true })
    expect(shown.closedHidden).toBe(0)
    expect(shown.buckets[1].total).toBe(2)
  })

  it('selects buckets in board order, pages with offset and limit, and reports more', () => {
    const board = makeBoard([makeBucket('a'), makeBucket('b'), makeBucket('c')], {
      placements: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, 'b'])),
    })
    const issues = [1, 2, 3, 4, 5].map((n) => makeIssue(n))
    const order = resolveBuckets(issues, board).get('b')!.map((issue) => issue.number)
    const json = build(stored(board), snapshot(issues), { buckets: ['c', 'b'], limitPerBucket: 2, offset: 1 })
    expect(json.buckets.map((bucket) => bucket.id)).toEqual(['b', 'c'])
    expect(json.buckets[0]).toMatchObject({ total: 5, offset: 1, more: true })
    expect(json.buckets[0].cards.map((card) => card.number)).toEqual(order.slice(1, 3))
  })

  it('reports a truncated snapshot and a private repository', () => {
    const board = makeBoard([makeBucket('a')])
    const json = build(stored(board), snapshot([], { truncated: true, isPrivate: true }))
    expect(json).toMatchObject({ truncated: true, private: true, cardBudgetReached: false })
  })

  it('prints a hostile bucket id as its alias and cleans text', () => {
    const hostile = 'Hi\u202E there'
    const board = makeBoard([makeBucket(hostile, { title: 'T\u200Bitle', labelRules: ['x\u3164', '\u200B'] })])
    const json = build(
      stored(board),
      snapshot([
        makeIssue(1, {
          title: 'Fix\u202E it',
          labels: ['bug\uFE0F', ' ', 'ok'],
          assignees: [{ login: 'oc\u{E0041}to', avatarUrl: '', url: '' }],
          milestone: 'v1\u061C',
        }),
      ]),
    )
    expect(json.buckets[0].id).toMatch(/^~[0-9a-f]{16}$/)
    expect(json.buckets[0].title).toBe('Title')
    expect(json.buckets[0].labelRules).toEqual(['x'])
    expect(json.buckets[0].cards[0]).toMatchObject({ title: 'Fix it', labels: ['bug', 'ok'], assignees: ['octo'], milestone: 'v1' })
  })

  it('takes the first 10 label rules, then drops the ones that clean to nothing', () => {
    const rules = Array.from({ length: 11 }, (_, i) => `rule${i + 1}`)
    rules[1] = '\u200B'
    const json = build(stored(makeBoard([makeBucket('a', { labelRules: rules })])), snapshot([]))
    expect(json.buckets[0].labelRules).toHaveLength(9)
    expect(json.buckets[0].labelRules).not.toContain('rule11')
  })

  it('omits buckets beyond the first 50', () => {
    const board = makeBoard(Array.from({ length: 53 }, (_, i) => makeBucket(`b${i}`)))
    const json = build(stored(board), snapshot([]))
    expect(json.buckets).toHaveLength(50)
    expect(json.bucketsOmitted).toBe(3)
  })
})

describe('card budget', () => {
  it('stops at 300 cards and sets cardBudgetReached', () => {
    const board = makeBoard([makeBucket('a'), makeBucket('b')], {
      placements: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [i + 1, i < 150 ? 'a' : 'b'])),
    })
    const issues = Array.from({ length: 400 }, (_, i) => makeIssue(i + 1, { title: 'x' }))
    const json = build(stored(board), snapshot(issues), { limitPerBucket: 300 })
    const count = json.buckets.reduce((sum, bucket) => sum + bucket.cards.length, 0)
    expect(count).toBe(MCP_LIMITS.cardsPerAnswer)
    expect(json.cardBudgetReached).toBe(true)
    expect(json.buckets.some((bucket) => bucket.more)).toBe(true)
  })

  it('does not set the flag when everything fits', () => {
    const board = makeBoard([makeBucket('a')])
    const json = build(stored(board), snapshot([makeIssue(1)]))
    expect(json.cardBudgetReached).toBe(false)
  })

  it('keeps the largest answer the caps allow under the declared result size', () => {
    const astral = (n: number) => '\u{1F600}'.repeat(n)
    const buckets = Array.from({ length: 60 }, (_, i) =>
      makeBucket(`bucket \u{1F600}${i}`, {
        title: astral(DISPLAY_CAPS.bucketTitle),
        wipLimit: 99,
        labelRules: Array.from({ length: 10 }, () => astral(DISPLAY_CAPS.label)),
      }),
    )
    const issues = Array.from({ length: 1_000 }, (_, i) =>
      makeIssue(2_000_000_000 + i, {
        title: astral(DISPLAY_CAPS.title),
        labels: Array.from({ length: 12 }, () => astral(DISPLAY_CAPS.label)),
        assignees: Array.from({ length: 6 }, () => ({ login: astral(DISPLAY_CAPS.login), avatarUrl: '', url: '' })),
        milestone: astral(DISPLAY_CAPS.milestone),
        comments: 2_147_483_647,
        updatedAt: astral(DISPLAY_CAPS.timestamp),
      }),
    )
    const board = makeBoard(buckets, {
      placements: Object.fromEntries(issues.map((issue) => [issue.number, buckets[0].id])),
    })
    const stor = { ...stored(board), fullName: astral(200), updatedBy: { id: 'u', username: astral(100), kind: 'person' as const } }
    const json = build(stor, snapshot(issues), { limitPerBucket: 300 })
    const size = JSON.stringify(json).length
    expect(json.cardBudgetReached).toBe(true)
    expect(json.buckets).toHaveLength(50)
    expect(size).toBeLessThanOrEqual(182_000)
    expect(size * 2).toBeLessThan(MCP_LIMITS.maxResultSizeChars)
  })
})

describe('boardListJson', () => {
  const summary = (repoKey: string, updatedAt: string) => ({
    repoKey,
    fullName: repoKey,
    version: 1,
    updatedAt,
    updatedBy: null,
  })

  it('breaks an updatedAt tie by repo key in code-unit order, like the keys without a board', () => {
    const at = '2026-01-01T00:00:00.000Z'
    const json = boardListJson([summary('acme/w_x', at), summary('acme/w-x', at), summary('acme/w.x', at)], new Set())
    expect(json.boards.map((board) => board.repo)).toEqual(['acme/w-x', 'acme/w.x', 'acme/w_x'])
  })

  it('orders boards, lists keys without a board sorted, and handles empty', () => {
    const json = boardListJson(
      [summary('a/old', '2026-01-01T00:00:00.000Z'), summary('b/new', '2026-02-01T00:00:00.000Z')],
      new Set(['b/new', 'z/none', 'a/old', 'c/none']),
    )
    expect(json.boards.map((board) => board.repo)).toEqual(['b/new', 'a/old'])
    expect(json.reposWithoutBoard).toEqual(['c/none', 'z/none'])
    expect(boardListJson([], new Set())).toEqual({ boards: [], reposWithoutBoard: [] })
  })
})

describe('editorJson', () => {
  it('reads a missing kind as person and cleans the name', () => {
    expect(editorJson({ username: 'a\u202Eb' })).toEqual({ username: 'ab', kind: 'person' })
    expect(editorJson({ username: 'bot', kind: 'integration' })).toEqual({ username: 'bot', kind: 'integration' })
    expect(editorJson(null)).toBeNull()
  })
})

describe('readableBoard', () => {
  const good = makeBoard([makeBucket('a', { labelRules: ['x'] })], { placements: { 1: 'a' }, order: { a: [1] } })

  it('accepts a normal board', () => {
    expect(readableBoard(good)).toBe(true)
  })

  it('refuses boards that would make resolveBuckets throw', () => {
    expect(readableBoard(null)).toBe(false)
    expect(readableBoard({ ...good, buckets: [{ ...good.buckets[0], labelRules: [1] }] })).toBe(false)
    expect(readableBoard({ ...good, placements: { 1: 5 } })).toBe(false)
    expect(readableBoard({ ...good, order: { a: ['1'] } })).toBe(false)
    expect(readableBoard({ ...good, order: { a: [1.5] } })).toBe(false)
    expect(readableBoard({ ...good, closedWindowDays: -1 })).toBe(false)
    expect(readableBoard({ ...good, closedWindowDays: Infinity })).toBe(false)
  })
})

describe('boardJson run activity', () => {
  const NOW = new Date('2026-10-08T14:00:00.000Z')
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
  const board = makeBoard([makeBucket('todo')], {
    humanWaitLimit: 24,
    estimates: {
      1: { size: 'M', confidence: 'sure', by: 'ada\u202e', at: '2026-10-07T09:00:00.000Z' },
      2: { size: null, confidence: 'no-idea', by: 'ada', at: '2026-10-07T09:00:00.000Z' },
    },
  })
  const issues = [makeIssue(1), makeIssue(2), makeIssue(3)]

  it('gives every card its estimate, last run and claim, null when absent, with the author cleaned', () => {
    const answer = build(stored(board), snapshot(issues), {}, {
      claims: new Map([[3, { runId: 'r3', status: 'running', since: hoursAgo(1) }]]),
      lastRuns: new Map([[3, { runId: 'r3', status: 'running', triageRange: null, unverifiedOpen: { external: 0, normative: 0, untested: 2 } }]]),
      waiting: [],
      now: NOW,
    })
    const card = (n: number) => answer.buckets[0].cards.find((c) => c.number === n)!
    const [one, two, three] = [card(1), card(2), card(3)]
    expect(one).toMatchObject({ estimate: { size: 'M', confidence: 'sure', by: 'ada' }, lastRun: null, claim: null })
    expect(two.estimate).toEqual({ size: null, confidence: 'no-idea', by: 'ada', at: '2026-10-07T09:00:00.000Z' })
    expect(three).toMatchObject({
      estimate: null,
      lastRun: { runId: 'r3', status: 'running', triageRange: null, unverifiedOpen: { external: 0, normative: 0, untested: 2 } },
      claim: { runId: 'r3', status: 'running', since: hoursAgo(1) },
    })
  })

  it('marks a waiting card over the limit only when it has waited strictly longer, and lists waiting issues that are not cards', () => {
    const answer = build(stored(board), snapshot(issues), {}, {
      claims: new Map(),
      lastRuns: new Map(),
      waiting: [
        { issue: 99, runId: 'old', status: 'budget_exceeded', since: hoursAgo(30) },
        { issue: 1, runId: 'edge', status: 'needs_human', since: hoursAgo(24) },
        { issue: 2, runId: 'new', status: 'awaiting_approval', since: hoursAgo(2) },
      ],
      now: NOW,
    })
    expect(answer.humanWaitLimit).toBe(24)
    expect(answer.waitingOnHuman.map((w) => [w.issue, w.overLimit])).toEqual([[99, true], [1, false], [2, false]])
  })

  it('never marks a waiting card over the limit when the board has none', () => {
    const answer = build(stored(makeBoard([makeBucket('todo')])), snapshot(issues), {}, {
      claims: new Map(),
      lastRuns: new Map(),
      waiting: [{ issue: 1, runId: 'r', status: 'needs_human', since: hoursAgo(5000) }],
      now: NOW,
    })
    expect(answer.humanWaitLimit).toBeNull()
    expect(answer.waitingOnHuman[0].overLimit).toBe(false)
  })

  it('names the cards in the offset and limit windows before the card budget', () => {
    const many = Array.from({ length: 10 }, (_, i) => makeIssue(i + 1))
    const stor = stored(makeBoard([makeBucket('todo')]))
    expect(windowNumbers(stor, snapshot(many), { ...OPTIONS, offset: 2, limitPerBucket: 3 })).toEqual([8, 7, 6])
    expect(windowNumbers(stor, snapshot([...many, makeIssue(11, { state: 'closed' })]), OPTIONS)).toHaveLength(10)
  })

  it('refuses a board whose estimates are invalid', () => {
    expect(readableBoard(board)).toBe(true)
    expect(readableBoard({ ...board, estimates: { 1: { size: 'XL', confidence: 'sure', by: 'a', at: 'x' } } })).toBe(false)
  })
})
