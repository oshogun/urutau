import { describe, expect, it } from 'vitest'
import { makeBoard, makeBucket, makeIssue, makeLabel } from '../test/fixtures.ts'
import {
  boardFromExport,
  bucketNumbers,
  createDefaultBoard,
  deleteBucket,
  isBoardConfig,
  keepUnseenOrder,
  moveBucket,
  moveIssue,
  moveIssueTo,
  normalizeLabelName,
  placeNewIssue,
  reorderBucket,
  resolveBuckets,
  saveBucket,
  toBoardExport,
} from './board.ts'
import type { BoardConfig, Issue } from './types.ts'

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

describe('placeNewIssue', () => {
  it('puts the issue first in its bucket even when label rules would send it elsewhere', () => {
    const issues = [makeIssue(1), makeIssue(6, { labels: ['in progress'] })]
    const placed = placeNewIssue(board(), 6, 'backlog')
    expect(placed.placements[6]).toBe('backlog')
    expect(numbersIn(placed, issues, 'backlog')).toEqual([6, 1])
    expect(numbersIn(placed, issues, 'doing')).toEqual([])
  })

  it('records the placement even when the label rules would pick the same bucket', () => {
    const placed = placeNewIssue(board(), 6, 'doing')
    expect(placed.placements).toEqual({ 6: 'doing' })
    expect(placed.order.doing).toEqual([6])
  })

  it('goes before the hand order of the bucket and leaves other buckets alone', () => {
    const config = { ...board(), placements: { 3: 'doing' }, order: { backlog: [2, 4], doing: [3] } }
    const issues = [2, 3, 4, 5, 7].map((number) => makeIssue(number))
    const placed = placeNewIssue(config, 7, 'backlog')
    expect(placed.order).toEqual({ backlog: [7, 2, 4], doing: [3] })
    expect(numbersIn(placed, issues, 'backlog')).toEqual([7, 2, 4, 5])
  })

  it('removes a stale entry of the same number from every other order list', () => {
    const config = { ...board(), order: { doing: [7, 3], review: [7] } }
    expect(placeNewIssue(config, 7, 'backlog').order).toEqual({ doing: [3], review: [], backlog: [7] })
  })

  it('accepts a bucket that collects closed issues', () => {
    expect(placeNewIssue(board(), 7, 'done').placements[7]).toBe('done')
  })

  it('returns the same object for a bucket the board does not have', () => {
    const config = board()
    expect(placeNewIssue(config, 7, 'gone')).toBe(config)
  })

  it('does not change the config it was given', () => {
    const config = board()
    const before = JSON.stringify(config)
    placeNewIssue(config, 7, 'backlog')
    expect(JSON.stringify(config)).toBe(before)
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

describe('moveIssueTo', () => {
  const issues = [makeIssue(10), makeIssue(11), makeIssue(12)]
  const config = (order: number[]) =>
    makeBoard([makeBucket('todo'), makeBucket('done', { collectsClosed: true })], {
      placements: { 10: 'todo', 11: 'todo', 12: 'todo' },
      order: { todo: order },
    })
  const display = (planned: { config: BoardConfig }, list = issues) =>
    numbersIn(planned.config, list, 'todo')

  it('X after N already in place changes nothing', () => {
    const planned = moveIssueTo(config([10, 11, 12]), issues, 11, 'todo', 'after', 10)
    expect(planned.changed).toBe(false)
    expect(planned.expected).toEqual([10, 11, 12])
    expect(planned.index).toBe(1)
  })

  it('X after N from the end puts X right after N', () => {
    const planned = moveIssueTo(config([10, 12, 11]), issues, 11, 'todo', 'after', 10)
    expect(planned.changed).toBe(true)
    expect(planned.expected).toEqual([10, 11, 12])
    expect(display(planned)).toEqual([10, 11, 12])
  })

  it('X before N counts positions with X removed', () => {
    const planned = moveIssueTo(config([10, 11, 12]), issues, 12, 'todo', 'before', 11)
    expect(planned.expected).toEqual([10, 12, 11])
    expect(display(planned)).toEqual([10, 12, 11])
  })

  it('top of an empty bucket', () => {
    const empty = makeBoard([makeBucket('todo'), makeBucket('other')], { placements: { 10: 'other' } })
    const planned = moveIssueTo(empty, [makeIssue(10)], 10, 'todo', 'top', null)
    expect(planned.expected).toEqual([10])
    expect(planned.index).toBe(0)
    expect(planned.changed).toBe(true)
    expect(planned.from).toBe('other')
  })

  it('bottom moves a card to the end', () => {
    const planned = moveIssueTo(config([10, 11, 12]), issues, 10, 'todo', 'bottom', null)
    expect(planned.expected).toEqual([11, 12, 10])
    expect(planned.index).toBe(2)
  })

  it('returns the config unchanged when a precondition fails', () => {
    const start = config([10, 11, 12])
    const noAnchor = moveIssueTo(start, issues, 10, 'todo', 'after', 99)
    expect(noAnchor).toMatchObject({ config: start, index: -1, changed: false, expected: [10, 11, 12] })
    const closed = [makeIssue(10, { state: 'closed' })]
    expect(moveIssueTo(start, closed, 10, 'todo', 'top', null).changed).toBe(false)
    expect(moveIssueTo(start, issues, 10, 'nowhere', 'top', null).index).toBe(-1)
  })
})

describe('reorderBucket', () => {
  const issues = [1, 2, 3, 4].map((n) => makeIssue(n))
  const start = makeBoard([makeBucket('todo')], { order: { todo: [1, 2, 3, 4] } })

  it('sets one bucket order: wanted first, the others after in their current order', () => {
    const planned = reorderBucket(start, issues, 'todo', [3, 1])
    expect(planned.expected).toEqual([3, 1, 2, 4])
    expect(planned.changed).toBe(true)
    expect(planned.config.order.todo).toEqual([3, 1, 2, 4])
    expect(numbersIn(planned.config, issues, 'todo')).toEqual(planned.expected)
    expect(planned.config.placements).toBe(start.placements)
  })

  it('reports no change when the listed cards are already first', () => {
    const planned = reorderBucket(
      makeBoard([makeBucket('todo')], { order: { todo: [1, 2, 3] } }),
      [1, 2, 3].map((n) => makeIssue(n)),
      'todo',
      [1, 2],
    )
    expect(planned.changed).toBe(false)
  })
})

describe('keepUnseenOrder', () => {
  const open = (...numbers: number[]) => numbers.map((n) => makeIssue(n))
  const buckets = () => [makeBucket('todo'), makeBucket('other')]
  const keep = (
    stored: BoardConfig,
    next: BoardConfig,
    seen: number[],
    options: { truncated?: boolean; highestNumber: number; moved: number[]; unseenBeforeMoved: boolean },
  ) =>
    keepUnseenOrder(stored, next, 'todo', new Set(seen), {
      truncated: options.truncated ?? false,
      highestNumber: options.highestNumber,
      moved: new Set(options.moved),
      unseenBeforeMoved: options.unseenBeforeMoved,
    })

  const newIssueBoard = () => {
    const issues = open(1, 2, 3)
    const stored = makeBoard(buckets(), {
      placements: { 1: 'todo', 2: 'todo', 3: 'other' },
      order: { todo: [500, 1, 2] },
    })
    return { issues, stored }
  }

  it('keeps a new issue ranked above the cards it was above, move to bottom', () => {
    const { issues, stored } = newIssueBoard()
    const planned = moveIssueTo(stored, issues, 3, 'todo', 'bottom', null)
    const final = keep(stored, planned.config, [1, 2, 3], { highestNumber: 499, moved: [3], unseenBeforeMoved: true })
    expect(final.order.todo).toEqual([500, 1, 2, 3])
    expect(numbersIn(final, issues, 'todo')).toEqual([1, 2, 3])
    expect(bucketNumbers(resolveBuckets(issues, final), 'todo')).toEqual(planned.expected)
  })

  it('keeps a new issue when the card moves to top', () => {
    const { issues, stored } = newIssueBoard()
    const planned = moveIssueTo(stored, issues, 3, 'todo', 'top', null)
    const final = keep(stored, planned.config, [1, 2, 3], { highestNumber: 499, moved: [3], unseenBeforeMoved: false })
    expect(final.order.todo).toEqual([3, 500, 1, 2])
  })

  const staleBoard = () => {
    const issues = open(1, 2, 3)
    const stored = makeBoard(buckets(), {
      placements: { 1: 'todo', 2: 'todo', 3: 'other' },
      order: { todo: [1, 9, 2] },
    })
    return { issues, stored, planned: moveIssueTo(stored, issues, 3, 'todo', 'bottom', null) }
  }

  it('truncated snapshot: a stale unseen number is kept', () => {
    const { stored, planned } = staleBoard()
    const final = keep(stored, planned.config, [1, 2, 3], { truncated: true, highestNumber: 9, moved: [3], unseenBeforeMoved: true })
    expect(final.order.todo).toEqual([1, 9, 2, 3])
  })

  it('complete snapshot: a stale unseen number is dropped', () => {
    const { stored, planned } = staleBoard()
    const final = keep(stored, planned.config, [1, 2, 3], { highestNumber: 9, moved: [3], unseenBeforeMoved: true })
    expect(final.order.todo).toEqual([1, 2, 3])
  })

  it('returns next itself when nothing is kept', () => {
    const { stored, planned } = staleBoard()
    expect(keep(stored, planned.config, [1, 2, 3], { highestNumber: 9, moved: [3], unseenBeforeMoved: true })).toBe(
      planned.config,
    )
  })

  const movedBoard = (order: number[]) => {
    const issues = open(3, 7)
    const stored = makeBoard(buckets(), { placements: { 3: 'todo', 7: 'todo' }, order: { todo: order } })
    return { issues, stored }
  }

  it('a moved card is never the anchor of an unseen number', () => {
    const { issues, stored } = movedBoard([7, 500, 3])
    const planned = moveIssueTo(stored, issues, 3, 'todo', 'top', null)
    expect(planned.expected).toEqual([3, 7])
    expect(planned.changed).toBe(true)
    const final = keep(stored, planned.config, [3, 7], { highestNumber: 7, moved: [3], unseenBeforeMoved: false })
    expect(final.order.todo).toEqual([3, 7, 500])
    expect(numbersIn(final, issues, 'todo')).toEqual([3, 7])
    expect(bucketNumbers(resolveBuckets(issues, final), 'todo')).toEqual(planned.expected)
  })

  it('reorder keeps unseen numbers after the listed cards', () => {
    const { issues, stored } = movedBoard([7, 500, 3])
    const planned = reorderBucket(stored, issues, 'todo', [3])
    expect(planned.expected).toEqual([3, 7])
    const final = keep(stored, planned.config, [3, 7], { highestNumber: 7, moved: [3], unseenBeforeMoved: false })
    expect(final.order.todo).toEqual([3, 7, 500])
  })

  it('an unseen number goes before a card moved to bottom', () => {
    const issues = [makeIssue(7), makeIssue(3)]
    const stored = makeBoard(buckets(), { placements: { 7: 'todo', 3: 'other' }, order: { todo: [7, 500] } })
    const planned = moveIssueTo(stored, issues, 3, 'todo', 'bottom', null)
    expect(planned.expected).toEqual([7, 3])
    const final = keep(stored, planned.config, [3, 7], { highestNumber: 7, moved: [3], unseenBeforeMoved: true })
    expect(final.order.todo).toEqual([7, 500, 3])
    expect(bucketNumbers(resolveBuckets(issues, final), 'todo')).toEqual([7, 3])
  })

  it('an unseen number goes after a card moved after its anchor', () => {
    const issues = [makeIssue(7), makeIssue(3)]
    const stored = makeBoard(buckets(), { placements: { 7: 'todo', 3: 'other' }, order: { todo: [7, 500] } })
    const planned = moveIssueTo(stored, issues, 3, 'todo', 'after', 7)
    expect(planned.expected).toEqual([7, 3])
    const final = keep(stored, planned.config, [3, 7], { highestNumber: 7, moved: [3], unseenBeforeMoved: false })
    expect(final.order.todo).toEqual([7, 3, 500])
  })

  it('consecutive unseen numbers keep their stored order', () => {
    const { issues, stored } = movedBoard([7, 500, 600])
    const planned = moveIssueTo(stored, issues, 3, 'todo', 'top', null)
    const final = keep(stored, planned.config, [3, 7], { highestNumber: 7, moved: [3], unseenBeforeMoved: false })
    expect(final.order.todo).toEqual([3, 7, 500, 600])
  })

  it('a number stored twice is put back once', () => {
    const { issues, stored } = movedBoard([7, 500, 500, 3])
    const planned = moveIssueTo(stored, issues, 3, 'todo', 'top', null)
    const final = keep(stored, planned.config, [3, 7], { highestNumber: 7, moved: [3], unseenBeforeMoved: false })
    expect(final.order.todo).toEqual([3, 7, 500])
  })
})

const PROTOTYPE_IDS = [...new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__'])]

/** A board whose bucket ids are `ids`, with cards 1 and 2 placed by hand in the second one. */
function prototypeBoard(ids: [string, string, string]): BoardConfig {
  const [first, second, third] = ids
  const config = makeBoard([makeBucket(first), makeBucket(second), makeBucket(third, { collectsClosed: true })])
  return {
    ...config,
    placements: { 1: second, 2: second },
    order: Object.fromEntries([
      [second, [2, 1]],
      [first, [4, 3]],
    ]),
  }
}

const prototypeIssues = () => [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4), makeIssue(5, { state: 'closed' })]

function expectPlainMaps(config: BoardConfig) {
  expect(Object.getPrototypeOf(config.order)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(config.placements)).toBe(Object.prototype)
}

describe.each(PROTOTYPE_IDS)('a bucket id of %s', (name) => {
  const ordinary = prototypeBoard(['ids-a', 'ids-b', 'ids-c'])
  const special = prototypeBoard([name, `${name}-2`, 'ids-c'])
  const renamed = prototypeBoard(['ids-a', name, 'ids-c'])
  const numbers = (config: BoardConfig, issues: Issue[]) =>
    [...resolveBuckets(issues, config).values()].map((list) => list.map((issue) => issue.number))

  it('resolves to the same cards and order as an ordinary id', () => {
    const issues = prototypeIssues()
    expect(numbers(special, issues)).toEqual(numbers(ordinary, issues))
    expect(numbers(renamed, issues)).toEqual(numbers(ordinary, issues))
    expect(numbersIn(renamed, issues, name)).toEqual([2, 1])
    expect(numbersIn(special, issues, name)).toEqual([4, 3])
  })

  it('sorts a bucket without hand order by activity when only the prototype has the key', () => {
    const config = makeBoard([makeBucket(name), makeBucket('other', { collectsClosed: true })])
    expect(numbersIn(config, [makeIssue(1), makeIssue(2)], name)).toEqual([2, 1])
  })

  it('moves a card into the bucket, within it and out of it, keeping plain maps', () => {
    const issues = prototypeIssues()
    let config = moveIssue(renamed, issues, 3, name, 2)
    expect(numbersIn(config, issues, name)).toEqual([3, 2, 1])
    expect(Object.hasOwn(config.order, name)).toBe(true)
    expect(config.placements[3]).toBe(name)
    expectPlainMaps(config)

    config = moveIssue(config, issues, 1, name, 3)
    expect(numbersIn(config, issues, name)).toEqual([1, 3, 2])

    config = moveIssue(config, issues, 1, 'ids-a', null)
    expect(numbersIn(config, issues, name)).toEqual([3, 2])
    expect(numbersIn(config, issues, 'ids-a')).toEqual([4, 1])
    expectPlainMaps(config)
  })

  it('moves with moveIssueTo and reorders with reorderBucket and keepUnseenOrder', () => {
    const issues = prototypeIssues()
    const moved = moveIssueTo(renamed, issues, 4, name, 'top', null)
    expect(moved.expected).toEqual([4, 2, 1])
    expectPlainMaps(moved.config)

    const reordered = reorderBucket(renamed, issues, name, [1])
    expect(reordered.expected).toEqual([1, 2])
    expect(Object.hasOwn(reordered.config.order, name)).toBe(true)
    expectPlainMaps(reordered.config)

    const kept = keepUnseenOrder(renamed, reordered.config, name, new Set([1, 2]), {
      truncated: true,
      highestNumber: 2,
      moved: new Set([1]),
      unseenBeforeMoved: false,
    })
    expectPlainMaps(kept)
    expect(kept.order[name]).toEqual([1, 2])

    const putBack = keepUnseenOrder(
      { ...renamed, order: Object.fromEntries([[name, [20, 2, 1]]]) },
      reordered.config,
      name,
      new Set([1, 2]),
      { truncated: false, highestNumber: 5, moved: new Set([1]), unseenBeforeMoved: false },
    )
    expect(putBack).not.toBe(reordered.config)
    expect(putBack.order[name]).toEqual([1, 20, 2])
    expect(Object.hasOwn(putBack.order, name)).toBe(true)
    expectPlainMaps(putBack)
  })

  it('places a new issue at the top and deletes the bucket', () => {
    const issues = prototypeIssues()
    const placed = placeNewIssue(renamed, 9, name)
    expect(placed.order[name]).toEqual([9, 2, 1])
    expect(placed.placements[9]).toBe(name)
    expectPlainMaps(placed)

    const fresh = placeNewIssue(ordinary, 9, 'ids-b')
    expect(placeNewIssue(makeBoard([makeBucket(name)]), 9, name).order[name]).toEqual([9])
    expect(fresh.order['ids-b']).toEqual([9, ...(ordinary.order['ids-b'] ?? [])])

    const deleted = deleteBucket(renamed, name)
    expect(Object.hasOwn(deleted.order, name)).toBe(false)
    expect(Object.values(deleted.placements)).not.toContain(name)
    expect(deleted.buckets.map((bucket) => bucket.id)).toEqual(['ids-a', 'ids-c'])
    expectPlainMaps(deleted)
    expect(numbersIn(deleted, issues, 'ids-a')).toEqual([4, 3, 2, 1])
  })

  it('survives a JSON round trip, the import check and an export file', () => {
    const parsed: unknown = JSON.parse(JSON.stringify(renamed))
    expect(isBoardConfig(parsed)).toBe(true)
    const config = parsed as BoardConfig
    expect(config.buckets).toEqual(renamed.buckets)
    expect(Object.entries(config.order)).toEqual(Object.entries(renamed.order))
    expect(config.placements).toEqual(renamed.placements)
    expect(Object.hasOwn(config.order, name)).toBe(true)
    expectPlainMaps(config)

    const file: unknown = JSON.parse(JSON.stringify(toBoardExport(renamed, 'acme/widgets')))
    expect(boardFromExport(file, 'Acme/Widgets')).toEqual(renamed)
    const elsewhere = boardFromExport(file, 'other/repo')
    expect(elsewhere?.buckets).toEqual(renamed.buckets)
    expect(elsewhere?.order).toEqual({})
  })
})

describe('a bucket id that names an array property', () => {
  const config = {
    ...makeBoard([makeBucket('length'), makeBucket('other', { collectsClosed: true })]),
    order: [],
  } as unknown as BoardConfig
  const issues = [makeIssue(1), makeIssue(2)]

  it('does not throw when order is an array', () => {
    expect(isBoardConfig(JSON.parse(JSON.stringify(config)))).toBe(true)
    expect(() => resolveBuckets(issues, config)).not.toThrow()
    expect(() => moveIssue(config, issues, 1, 'length', null)).not.toThrow()
    expect(() => placeNewIssue(config, 9, 'length')).not.toThrow()
  })
})
