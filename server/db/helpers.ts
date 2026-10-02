import { MysqlAdapter, type InsertObject, type Kysely } from 'kysely'
import type { Tables } from './schema.ts'

/** Timestamps are stored as ISO 8601 UTC text and compared as text. */
export function iso(date: Date): string {
  return date.toISOString()
}

/**
 * Inserts one row and returns whether it was inserted. A row that would
 * violate a unique or primary key is skipped without raising an error, so the
 * call is safe inside a transaction (PostgreSQL aborts a transaction after any
 * failed statement).
 */
export async function insertIgnoringDuplicate<T extends keyof Tables>(
  db: Kysely<Tables>,
  table: T,
  values: InsertObject<Tables, T>,
): Promise<boolean> {
  const insert = db.insertInto(table).values(values)
  const result = await (db.getExecutor().adapter instanceof MysqlAdapter
    ? insert.ignore()
    : insert.onConflict((oc) => oc.doNothing())
  ).executeTakeFirst()
  return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1
}
