import { afterEach, expect, test } from 'vitest'
import { fixtureBoard } from '../db/fixtures.ts'
import { createTestApp, type TestApp } from '../testing/harness.ts'

let h: TestApp
afterEach(async () => {
  await h.close()
})

test.each([2147483648, 1e300, -1, 1.5, 0])('a save with baseVersion %s is a 400, not a database error', async (baseVersion) => {
  h = await createTestApp()
  expect((await h.post('/api/auth/first-run', { username: 'admin', password: 'correct horse battery' })).status).toBe(201)
  const response = await h.put('/api/boards/acme/widgets', { baseVersion, fullName: 'acme/widgets', board: fixtureBoard() })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: 'invalid-request' })
})
