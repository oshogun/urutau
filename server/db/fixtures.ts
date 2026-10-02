import type { BoardConfig } from '../../src/domain/types.ts'

/** A valid board config for database tests. */
export function fixtureBoard(title = 'To do'): BoardConfig {
  return {
    version: 1,
    buckets: [{ id: 'b1', title, wipLimit: null, labelRules: [], collectsClosed: true }],
    placements: { 3: 'b1' },
    order: { b1: [3, 1] },
    closedWindowDays: 14,
  }
}
