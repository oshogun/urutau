import { describe, expect, it } from 'vitest'
import { makeBoard, makeBucket, makeIssue, makeLabel } from '../test/fixtures'
import {
  boardFromExport,
  createDefaultBoard,
  deleteBucket,
  isBoardConfig,
  moveBucket,
  moveIssue,
  normalizeLabelName,
  resolveBuckets,
  saveBucket,
  toBoardExport,
} from './board'
import type { BoardConfig, Issue } from './types'

const numbersIn = (config: BoardConfig, issues: Issue[], bucketId: string) =>
  resolveBuckets(issues, config)
    .get(bucketId)
    ?.map((issue) => issue.number)

const board = () =>
  makeBoard([
    makeBucket('backlog'),
    makeBucket('doing', { labelRules: ['in progress'] }),
    makeBucket('review', { labelRules: ['needs review'] }),
    makeBucket('done', { collectsClosed: true }),
  ])

describe('createDefaultBoard', () => {
  it('creates the standard workflow buckets with a single closed-issues bucket', () => {
    const config = createDefaultBoard([])
    expect(config.buckets.map((bucket) => bucket.title)).toEqual([
      'Backlog',
      'To do',
      'In progress',
      'In review',
      'Done',
    ])
    expect(config.buckets.filter((bucket) => bucket.collectsClosed)).toHaveLength(1)
  })

  it('links repository labels that look like workflow stages', () => {
    const config = createDefaultBoard([
      makeLabel('Status: In Progress'),
      makeLabel('needs-review'),
      makeLabel('bug'),
    ])
    const rules = Object.fromEntries(config.buckets.map((bucket) => [bucket.id, bucket.labelRules]))
    expect(rules['in-progress']).toEqual(['Status: In Progress'])
    expect(rules['in-review']).toEqual(['needs-review'])
    expect(rules.backlog).toEqual([])
  })
})

describe('normalizeLabelName', () => {
  it.each([
    ['In Progress', 'inprogress'],
    ['status: in-progress', 'inprogress'],
    ['2 - Working', 'working'],
    ['kanban/To Do', 'todo'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeLabelName(input)).toBe(expected)
  })
})

describe('resolveBuckets', () => {
  it('puts unlabeled open issues in the first bucket, newest first', () => {
    const issues = [makeIssue(1), makeIssue(3), makeIssue(2)]
    expect(numbersIn(board(), issues, 'backlog')).toEqual([3, 2, 1])
  })

  it('routes open issues by label rule', () => {
    const issues = [makeIssue(1, { labels: ['in progress'] }), makeIssue(2)]
    expect(numbersIn(board(), issues, 'doing')).toEqual([1])
    expect(numbersIn(board(), issues, 'backlog')).toEqual([2])
  })

  it('matches label rules case-insensitively', () => {
    const issues = [makeIssue(1, { labels: ['In Progress'] })]
    expect(numbersIn(board(), issues, 'doing')).toEqual([1])
  })

  it('lets the rightmost matching bucket win', () => {
    const issues = [makeIssue(1, { labels: ['in progress', 'needs review'] })]
    expect(numbersIn(board(), issues, 'review')).toEqual([1])
  })

  it('keeps hand placement over label rules', () => {
    const config = makeBoard(board().buckets, { placements: { 1: 'backlog' } })
    const issues = [makeIssue(1, { labels: ['in progress'] })]
    expect(numbersIn(config, issues, 'backlog')).toEqual([1])
  })

  it('always puts closed issues in the closed-issues bucket, even if placed elsewhere', () => {
    const config = makeBoard(board().buckets, { placements: { 1: 'doing' } })
    const issues = [makeIssue(1, { state: 'closed', closedAt: '2026-02-01T00:00:00Z' })]
    expect(numbersIn(config, issues, 'done')).toEqual([1])
    expect(numbersIn(config, issues, 'doing')).toEqual([])
  })

  it('hides closed issues when no bucket collects them', () => {
    const config = makeBoard([makeBucket('a'), makeBucket('b')])
    const issues = [makeIssue(1, { state: 'closed' }), makeIssue(2)]
    const contents = resolveBuckets(issues, config)
    expect([...contents.values()].flat().map((issue) => issue.number)).toEqual([2])
  })

  it('orders closed issues by most recently closed', () => {
    const issues = [
      makeIssue(1, { state: 'closed', closedAt: '2026-03-01T00:00:00Z' }),
      makeIssue(2, { state: 'closed', closedAt: '2026-01-01T00:00:00Z' }),
      makeIssue(3, { state: 'closed', closedAt: '2026-02-01T00:00:00Z' }),
    ]
    expect(numbersIn(board(), issues, 'done')).toEqual([1, 3, 2])
  })

  it('follows the stored order and appends unranked issues after it', () => {
    const config = makeBoard(board().buckets, { order: { backlog: [1, 3] } })
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)]
    expect(numbersIn(config, issues, 'backlog')).toEqual([1, 3, 4, 2])
  })

  it('ignores placements that point to a bucket that no longer exists', () => {
    const config = makeBoard(board().buckets, { placements: { 1: 'gone' } })
    expect(numbersIn(config, [makeIssue(1)], 'backlog')).toEqual([1])
  })
})

describe('moveIssue', () => {
  const issues = [makeIssue(1), makeIssue(2), makeIssue(3)]

  it('moves an issue to another bucket and remembers the placement', () => {
    const next = moveIssue(board(), issues, 2, 'doing', null)
    expect(numbersIn(next, issues, 'doing')).toEqual([2])
    expect(numbersIn(next, issues, 'backlog')).toEqual([3, 1])
    expect(next.placements[2]).toBe('doing')
  })

  it('reorders within a bucket without pinning the issue there', () => {
    const next = moveIssue(board(), issues, 1, 'backlog', 3)
    expect(numbersIn(next, issues, 'backlog')).toEqual([1, 3, 2])
    expect(next.placements[1]).toBeUndefined()
  })

  it('appends when the "before" issue is not in the target bucket', () => {
    const next = moveIssue(board(), issues, 3, 'backlog', 99)
    expect(numbersIn(next, issues, 'backlog')).toEqual([2, 1, 3])
  })

  it('keeps the relative order of cards hidden by a filter', () => {
    // Full bucket: 5, h4, 3, h2, 1 — only the odd-numbered issues are visible.
    const all = [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4), makeIssue(5)]
    // Visible [5, 3, 1] → user drags 1 between 5 and 3, so it goes before 3.
    const next = moveIssue(board(), all, 1, 'backlog', 3)
    const order = numbersIn(next, all, 'backlog')
    expect(order).toEqual([5, 4, 1, 3, 2])
    expect(order!.indexOf(4)).toBeLessThan(order!.indexOf(2))
  })

  it('refuses to move closed issues', () => {
    const closed = [makeIssue(1, { state: 'closed' })]
    const config = board()
    expect(moveIssue(config, closed, 1, 'backlog', null)).toBe(config)
  })

  it('ignores unknown target buckets', () => {
    const config = board()
    expect(moveIssue(config, issues, 1, 'nope', null)).toBe(config)
  })
})

describe('bucket editing', () => {
  it('allows only one bucket to collect closed issues', () => {
    const next = saveBucket(board(), makeBucket('archive', { collectsClosed: true }))
    expect(next.buckets.filter((bucket) => bucket.collectsClosed).map((b) => b.id)).toEqual([
      'archive',
    ])
  })

  it('updates an existing bucket in place', () => {
    const next = saveBucket(board(), makeBucket('doing', { title: 'Doing', wipLimit: 3 }))
    expect(next.buckets.map((bucket) => bucket.id)).toEqual(['backlog', 'doing', 'review', 'done'])
    expect(next.buckets[1]).toMatchObject({ title: 'Doing', wipLimit: 3 })
  })

  it('returns issues of a deleted bucket to automatic placement', () => {
    const issues = [makeIssue(1), makeIssue(2, { labels: ['in progress'] })]
    let config = moveIssue(board(), issues, 1, 'review', null)
    config = moveIssue(config, issues, 2, 'review', null)
    config = deleteBucket(config, 'review')

    expect(config.buckets.map((bucket) => bucket.id)).toEqual(['backlog', 'doing', 'done'])
    expect(config.placements).toEqual({})
    expect(config.order.review).toBeUndefined()
    expect(numbersIn(config, issues, 'backlog')).toEqual([1])
    expect(numbersIn(config, issues, 'doing')).toEqual([2])
  })

  it('never deletes the last bucket', () => {
    const config = makeBoard([makeBucket('only')])
    expect(deleteBucket(config, 'only')).toBe(config)
  })

  it('moves buckets left and right within bounds', () => {
    const config = board()
    expect(moveBucket(config, 'doing', -1).buckets.map((b) => b.id)).toEqual([
      'doing',
      'backlog',
      'review',
      'done',
    ])
    expect(moveBucket(config, 'backlog', -1)).toBe(config)
    expect(moveBucket(config, 'done', 1)).toBe(config)
  })
})

describe('board export and import', () => {
  const issues = [makeIssue(1), makeIssue(2)]
  const arranged = moveIssue(board(), issues, 1, 'doing', null)
  const file = () => JSON.parse(JSON.stringify(toBoardExport(arranged, 'acme/widgets')))

  it('round-trips a board for the same repository, ignoring case', () => {
    expect(boardFromExport(file(), 'Acme/Widgets')).toEqual(arranged)
  })

  it('keeps buckets and rules but drops card positions from another repository', () => {
    const imported = boardFromExport(file(), 'acme/gadgets')
    expect(imported?.buckets).toEqual(arranged.buckets)
    expect(imported?.placements).toEqual({})
    expect(imported?.order).toEqual({})
  })

  it('treats a bare config as coming from an unknown repository', () => {
    expect(boardFromExport(JSON.parse(JSON.stringify(arranged)), 'acme/widgets')?.placements).toEqual({})
  })

  it('rejects anything that is not a board', () => {
    expect(boardFromExport({ board: { version: 1 } }, 'acme/widgets')).toBeNull()
    expect(boardFromExport('nope', 'acme/widgets')).toBeNull()
    expect(boardFromExport(null, 'acme/widgets')).toBeNull()
  })
})

describe('isBoardConfig', () => {
  it('accepts a default board and rejects junk', () => {
    expect(isBoardConfig(createDefaultBoard([]))).toBe(true)
    expect(isBoardConfig(JSON.parse(JSON.stringify(createDefaultBoard([]))))).toBe(true)
    expect(isBoardConfig({ version: 1, buckets: [] })).toBe(false)
    expect(isBoardConfig(null)).toBe(false)
    expect(isBoardConfig({ ...createDefaultBoard([]), version: 2 })).toBe(false)
  })
})
