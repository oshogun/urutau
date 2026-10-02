import { DatabaseSync } from 'node:sqlite'

/**
 * Wraps a node:sqlite database in the better-sqlite3-shaped object that
 * Kysely's SqliteDialect expects. `reader` is true for statements that return
 * rows, and Kysely passes parameters as one array while node:sqlite takes them
 * as separate arguments.
 */
export function kyselySqliteDatabase(db: DatabaseSync) {
  return {
    close: () => db.close(),
    prepare(text: string) {
      const stmt = db.prepare(text)
      return {
        get reader() {
          return stmt.columns().length > 0
        },
        all: (params: ReadonlyArray<unknown>) => stmt.all(...(params as never[])),
        run: (params: ReadonlyArray<unknown>) => stmt.run(...(params as never[])),
        iterate: (params: ReadonlyArray<unknown>) => stmt.iterate(...(params as never[])) as IterableIterator<unknown>,
      }
    },
  }
}
