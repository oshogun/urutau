import { expect, test } from 'vitest'
import { createEventHub, type BoardEvent, type Subscriber } from './publisher.ts'

function updated(repoKey: string, version = 2): BoardEvent {
  return { type: 'board-updated', data: { repoKey, version, updatedAt: '2026-10-02T12:00:00.000Z', updatedBy: null, clientId: null } }
}

function recorder() {
  const received: BoardEvent[] = []
  let closed = false
  const subscriber: Subscriber = { send: (event) => void received.push(event), close: () => void (closed = true) }
  return { subscriber, received, isClosed: () => closed }
}

test('delivers an event only to streams on its repository', () => {
  const hub = createEventHub()
  const a = recorder()
  const b = recorder()
  hub.subscribe('acme/widgets', 's1', a.subscriber)
  hub.subscribe('acme/gadgets', 's1', b.subscriber)
  hub.publish(updated('acme/widgets'))
  expect(a.received).toHaveLength(1)
  expect(b.received).toHaveLength(0)
})

test('unsubscribe removes the stream', () => {
  const hub = createEventHub()
  const a = recorder()
  const off = hub.subscribe('acme/widgets', 's1', a.subscriber)
  expect(hub.size()).toBe(1)
  off()
  expect(hub.size()).toBe(0)
  hub.publish(updated('acme/widgets'))
  expect(a.received).toEqual([])
})

test('a subscriber that throws does not stop delivery to the others', () => {
  const hub = createEventHub()
  const b = recorder()
  hub.subscribe('acme/widgets', 's1', { send: () => { throw new Error('closed') }, close: () => {} })
  hub.subscribe('acme/widgets', 's2', b.subscriber)
  hub.publish(updated('acme/widgets'))
  expect(b.received).toHaveLength(1)
})

test('closeSession ends only that session\'s streams; closeAll ends the rest', () => {
  const hub = createEventHub()
  const a = recorder()
  const b = recorder()
  hub.subscribe('acme/widgets', 's1', a.subscriber)
  hub.subscribe('acme/gadgets', 's2', b.subscriber)
  hub.closeSession('s1')
  expect([a.isClosed(), b.isClosed(), hub.size()]).toEqual([true, false, 1])
  hub.closeAll()
  expect([b.isClosed(), hub.size()]).toEqual([true, 0])
})

test('delivers a card-activity event like a board event, only to streams on its repository', () => {
  const hub = createEventHub()
  const a = recorder()
  const b = recorder()
  hub.subscribe('acme/widgets', 's1', a.subscriber)
  hub.subscribe('acme/gadgets', 's1', b.subscriber)
  const event: BoardEvent = { type: 'card-activity', data: { repoKey: 'acme/widgets', issue: 7, clientId: null } }
  hub.publish(event)
  expect(a.received).toEqual([event])
  expect(b.received).toEqual([])
})
