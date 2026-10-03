import { afterEach, beforeEach, expect, test } from 'vitest'
import { getBoard } from '../db/boards.ts'
import { fixtureBoard } from '../db/fixtures.ts'
import { openDatabase, type Database } from '../db/index.ts'
import { createIntegration } from '../db/integrations.ts'
import { createAccount } from '../db/users.ts'
import type { BoardEvent } from '../events/publisher.ts'
import { InvalidBoardSave, saveAndPublish, type SaveDeps } from './save.ts'

const NOW = new Date('2026-10-03T10:00:00.000Z')

let database: Database
let events: BoardEvent[]
let deps: SaveDeps
let person: { id: string; username: string }
let agent: { id: string; username: string }

beforeEach(async () => {
  database = await openDatabase('sqlite::memory:')
  await database.migrate()
  events = []
  deps = { db: database.db, now: () => NOW, boardEvents: { publish: (event) => void events.push(event) } }
  const made = await createAccount(database.db, { username: 'ana', displayName: null, passwordHash: null, now: NOW })
  if (!made.created) throw new Error('account not created')
  person = { id: made.user.id, username: 'ana' }
  const integration = await createIntegration(database.db, { username: 'agent', createdBy: person.id, now: NOW })
  agent = { id: integration.id, username: 'agent' }
})

afterEach(async () => {
  await database.close()
})

function request(baseVersion: number | null, editor: { id: string; username: string }, kind: 'person' | 'integration', clientId: string | null = null) {
  return {
    repoKey: 'acme/widgets',
    baseVersion,
    fullName: 'Acme/Widgets',
    board: fixtureBoard(baseVersion === null ? 'To do' : 'Moved'),
    editor: { ...editor, kind },
    clientId,
  }
}

test('creating a board saves version 1 and publishes one event with the tab id', async () => {
  const outcome = await saveAndPublish(deps, request(null, person, 'person', 'tab-1'))
  expect(outcome).toMatchObject({ saved: true, stored: { version: 1, updatedBy: { username: 'ana', kind: 'person' } } })
  expect(events).toEqual([
    {
      type: 'board-updated',
      data: {
        repoKey: 'acme/widgets',
        version: 1,
        updatedAt: NOW.toISOString(),
        updatedBy: { id: person.id, username: 'ana', kind: 'person' },
        clientId: 'tab-1',
      },
    },
  ])
})

test('creating over an existing board saves nothing, publishes nothing and returns the stored board', async () => {
  await saveAndPublish(deps, request(null, person, 'person'))
  events.length = 0
  const outcome = await saveAndPublish(deps, request(null, agent, 'integration'))
  expect(outcome).toMatchObject({ saved: false, current: { version: 1 } })
  expect(events).toEqual([])
})

test('a stale version returns saved:false without writing or publishing', async () => {
  await saveAndPublish(deps, request(null, person, 'person'))
  events.length = 0
  const outcome = await saveAndPublish(deps, request(5, agent, 'integration'))
  expect(outcome.saved).toBe(false)
  if (outcome.saved) return
  expect(outcome.current?.version).toBe(1)
  expect((await getBoard(database.db, 'acme/widgets'))?.board.buckets[0]?.title).toBe('To do')
  expect(events).toEqual([])
})

test('a stale save on a missing board returns current null', async () => {
  expect(await saveAndPublish(deps, request(1, agent, 'integration'))).toEqual({ saved: false, current: null })
  expect(events).toEqual([])
})

test('an integration save publishes exactly one event with clientId null and kind integration', async () => {
  await saveAndPublish(deps, request(null, person, 'person'))
  events.length = 0
  const outcome = await saveAndPublish(deps, request(1, agent, 'integration'))
  expect(outcome).toMatchObject({ saved: true, stored: { version: 2, updatedBy: { kind: 'integration' } } })
  expect(events).toEqual([
    {
      type: 'board-updated',
      data: {
        repoKey: 'acme/widgets',
        version: 2,
        updatedAt: NOW.toISOString(),
        updatedBy: { id: agent.id, username: 'agent', kind: 'integration' },
        clientId: null,
      },
    },
  ])
  expect((await getBoard(database.db, 'acme/widgets'))?.updatedBy).toMatchObject({ username: 'agent', kind: 'integration' })
})

test('a repository key that does not match the full name throws and writes nothing', async () => {
  await expect(saveAndPublish(deps, { ...request(null, person, 'person'), repoKey: 'acme/other' })).rejects.toBeInstanceOf(InvalidBoardSave)
  expect(await getBoard(database.db, 'acme/other')).toBeNull()
  expect(events).toEqual([])
})

test('a board that is not a valid configuration throws and writes nothing', async () => {
  await expect(
    saveAndPublish(deps, { ...request(null, person, 'person'), board: { ...fixtureBoard(), buckets: 'nope' } as never }),
  ).rejects.toBeInstanceOf(InvalidBoardSave)
  expect(await getBoard(database.db, 'acme/widgets')).toBeNull()
  expect(events).toEqual([])
})
