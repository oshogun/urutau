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
  '"closedWindowDays":14,"closedHidden":0,"cardBudgetReached":false,"bucketsOmitted":0,"buckets":[{"id":"backlog",' +
  '"title":"Backlog","wipLimit":null,"collectsClosed":false,"labelRules":[],"total":1,"offset":0,"more":false,' +
  '"cards":[{"number":7,"title":"Crash on save","state":"open","labels":["bug"],"assignees":["octocat"],' +
  '"milestone":"v1.0","comments":3,"updatedAt":"2026-09-30T00:00:00Z"}]}]}'

const build = (issue: Issue) =>
  JSON.stringify(
    boardJson(STORED, snapshotOf([issue]), bucketIds(BOARD.buckets), {
      buckets: null,
      limitPerBucket: 50,
      offset: 0,
      includeClosed: false,
    }),
  )

describe('get_board output', () => {
  it('equals one golden string, with no body field, whether or not the issue has a body', () => {
    expect(build(ISSUE)).toBe(GOLDEN)
    expect(build({ ...ISSUE, body: BODY })).toBe(GOLDEN)
    expect(GOLDEN).not.toContain('body')
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
