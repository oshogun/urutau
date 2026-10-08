import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoredBoard } from '../../src/domain/api.ts'
import type { BoardConfig, Issue } from '../../src/domain/types.ts'
import { toIssue } from '../../src/github/api.ts'
import { createSecretBox } from '../auth/secretBox.ts'
import { putGithubToken } from '../db/githubTokens.ts'
import { openDatabase, type Database } from '../db/index.ts'
import { createIntegration } from '../db/integrations.ts'
import { createAccount } from '../db/users.ts'
import { createLogger } from '../log.ts'
import { boardJson } from '../mcp/boardJson.ts'
import { bucketIds } from '../mcp/clean.ts'
import type { BoardSnapshot } from '../mcp/contract.ts'
import { createGitHubStub, stubIssue } from '../testing/githubStub.ts'
import { createGitHubReader } from './reader.ts'

const TOKEN = 'github_pat_urutau_fixture_not_a_real_token'
const BODY = '## Steps\n\nSecret body text that get_board must never carry.'

const ISSUE: Issue = {
  number: 7,
  title: 'Crash on save',
  state: 'open',
  stateReason: null,
  url: 'https://github.com/acme/widgets/issues/7',
  labels: ['bug'],
  assignees: [{ login: 'octocat', avatarUrl: 'https://avatars.example/octocat', url: 'https://github.com/octocat' }],
  author: { login: 'hubot', avatarUrl: 'https://avatars.example/hubot', url: 'https://github.com/hubot' },
  milestone: 'v1.0',
  comments: 3,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
  closedAt: null,
}

const BOARD: BoardConfig = {
  version: 1,
  buckets: [{ id: 'backlog', title: 'Backlog', wipLimit: null, labelRules: [], collectsClosed: false }],
  placements: {},
  order: {},
  closedWindowDays: 14,
}

const STORED: StoredBoard = {
  repoKey: 'acme/widgets',
  fullName: 'acme/widgets',
  version: 7,
  updatedAt: '2026-10-03T12:00:00.000Z',
  updatedBy: { id: 'u1', username: 'ada', kind: 'person' },
  board: BOARD,
}

function snapshotOf(issues: Issue[]): BoardSnapshot {
  return {
    issues,
    seen: new Set(issues.map((issue) => issue.number)),
    highestNumber: Math.max(0, ...issues.map((issue) => issue.number)),
    pullRequests: new Set(),
    truncated: false,
    isPrivate: false,
    fetchedAt: Date.UTC(2026, 9, 3, 12, 0, 5),
  }
}

const GOLDEN =
  '{"repo":"acme/widgets","fullName":"acme/widgets","private":false,"version":7,"updatedAt":"2026-10-03T12:00:00.000Z",' +
  '"updatedBy":{"username":"ada","kind":"person"},"fetchedAt":"2026-10-03T12:00:05.000Z","truncated":false,' +
  '"closedWindowDays":14,"closedHidden":0,"cardBudgetReached":false,"bucketsOmitted":0,"humanWaitLimit":null,"waitingOnHuman":[],' +
  '"buckets":[{"id":"backlog",' +
  '"title":"Backlog","wipLimit":null,"collectsClosed":false,"labelRules":[],"total":1,"offset":0,"more":false,' +
  '"cards":[{"number":7,"title":"Crash on save","state":"open","labels":["bug"],"assignees":["octocat"],' +
  '"milestone":"v1.0","comments":3,"updatedAt":"2026-09-30T00:00:00Z","estimate":null,"lastRun":null,"claim":null}]}]}'
const GOLDEN_START = GOLDEN.slice(0, GOLDEN.indexOf('"bucketsOmitted":0,') + '"bucketsOmitted":0,'.length)
const GOLDEN_END = GOLDEN.slice(GOLDEN.indexOf('"buckets":[{'))

const OPTIONS = { buckets: null, limitPerBucket: 50, offset: 0, includeClosed: false }
const NOW = new Date('2026-10-08T14:00:00.000Z')
const NO_ACTIVITY = { claims: new Map(), lastRuns: new Map(), waiting: [], now: NOW }

const build = (issue: Issue) => JSON.stringify(boardJson(STORED, snapshotOf([issue]), bucketIds(BOARD.buckets), OPTIONS, NO_ACTIVITY))

describe('get_board output', () => {
  it('equals one golden string, with no body field, whether or not the issue has a body', () => {
    expect(build(ISSUE)).toBe(GOLDEN)
    expect(build({ ...ISSUE, body: BODY })).toBe(GOLDEN)
    expect(GOLDEN).not.toContain('body')
  })

  it('puts the new top-level fields before buckets and the new card fields after updatedAt, keeping the old keys and their order', () => {
    expect(GOLDEN).toContain('"bucketsOmitted":0,"humanWaitLimit":null,"waitingOnHuman":[],"buckets":[')
    expect(GOLDEN).toContain('"updatedAt":"2026-09-30T00:00:00Z","estimate":null,"lastRun":null,"claim":null}')
  })

  it('carries an estimate, a last run, a claim and the waiting cards when the board has them', () => {
    const board: BoardConfig = {
      ...BOARD,
      humanWaitLimit: 24,
      estimates: { 7: { size: 'S', confidence: 'unsure', by: 'ada', at: '2026-10-07T09:00:00.000Z' } },
    }
    const answer = boardJson({ ...STORED, board }, snapshotOf([ISSUE]), bucketIds(board.buckets), OPTIONS, {
      claims: new Map([[7, { runId: 'c-20261008-0001', status: 'awaiting_approval' as const, since: '2026-10-08T12:05:00.000Z' }]]),
      lastRuns: new Map([
        [7, { runId: 'c-20261008-0001', status: 'awaiting_approval' as const, triageRange: 'M-L' as const, unverifiedOpen: { external: 1, normative: 1, untested: 0 } }],
      ]),
      waiting: [
        { issue: 3, runId: 'c-20261006-0002', status: 'needs_human', since: '2026-10-07T06:00:00.000Z' },
        { issue: 7, runId: 'c-20261008-0001', status: 'awaiting_approval', since: '2026-10-08T12:05:00.000Z' },
      ],
      now: NOW,
    })
    const text = JSON.stringify(answer)
    expect(text).toBe(
      GOLDEN_START +
        '"humanWaitLimit":24,"waitingOnHuman":[' +
        '{"issue":3,"runId":"c-20261006-0002","status":"needs_human","since":"2026-10-07T06:00:00.000Z","overLimit":true},' +
        '{"issue":7,"runId":"c-20261008-0001","status":"awaiting_approval","since":"2026-10-08T12:05:00.000Z","overLimit":false}],' +
        GOLDEN_END.replace(
          '"estimate":null,"lastRun":null,"claim":null',
          '"estimate":{"size":"S","confidence":"unsure","by":"ada","at":"2026-10-07T09:00:00.000Z"},' +
            '"lastRun":{"status":"awaiting_approval","triageRange":"M-L","unverifiedOpen":{"external":1,"normative":1,"untested":0},"runId":"c-20261008-0001"},' +
            '"claim":{"runId":"c-20261008-0001","status":"awaiting_approval","since":"2026-10-08T12:05:00.000Z"}',
        ),
    )
  })
})

describe('what the reader gives get_board', () => {
  let database: Database
  let userId: string
  const clock = Date.UTC(2026, 5, 1)
  const now = () => new Date(clock)

  const items = [
    stubIssue(1, { body: BODY, labels: [{ name: 'bug', color: 'd73a4a', description: null }] }),
    stubIssue(2, { body: null }),
    stubIssue(3),
  ]
  const stub = createGitHubStub({ 'acme/widgets': { id: 101, private: false, items } })
  let reader: ReturnType<typeof createGitHubReader>

  beforeEach(async () => {
    database = await openDatabase('sqlite::memory:')
    await database.migrate()
    const box = createSecretBox(Buffer.alloc(32, 7))
    const admin = await createAccount(database.db, { username: 'admin', displayName: null, passwordHash: null, now: now() })
    if (!admin.created) throw new Error('no admin')
    const bot = await createIntegration(database.db, { username: 'planner-bot', createdBy: admin.user.id, now: now() })
    userId = bot.id
    await putGithubToken(database.db, {
      userId,
      sealed: box.sealer.seal(TOKEN, userId),
      keyId: box.sealer.keyId,
      setBy: userId,
      now: now(),
    })
    reader = createGitHubReader({
      db: database.db,
      fetch: stub.fetch,
      now,
      log: createLogger({ write: () => {}, now }),
      opener: box.opener,
    })
  })

  afterEach(async () => {
    await database.close()
  })

  it('reads issues that equal toIssue(item, false) and have no body key', async () => {
    const result = await reader.fetchSnapshot(userId, { owner: 'acme', name: 'widgets' }, 14, new AbortController().signal)
    expect(result.snapshot.issues).toHaveLength(3)
    for (const issue of result.snapshot.issues) {
      expect('body' in issue).toBe(false)
      const item = items.find((candidate) => candidate.number === issue.number)
      if (!item) throw new Error('unexpected issue')
      expect(issue).toEqual(toIssue(item, false))
    }
  })
})
