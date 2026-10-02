import { expect, test } from 'vitest'

// Runs in the Vitest "server" project (node environment): the browser globals
// of the client project's jsdom environment must not exist here.
test('the server project runs in a node environment', () => {
  expect('window' in globalThis).toBe(false)
})
