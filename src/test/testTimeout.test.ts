import { expect, it } from 'vitest'

it('runs client tests with the 30 s timeout from the Vitest configuration', ({ task }) => {
  expect(task.timeout).toBe(30_000)
})
