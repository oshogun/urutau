import { MysqlAdapter, type InsertObject, type Kysely } from 'kysely'
import type { Tables } from './schema.ts'
import { isUniqueViolation } from './index.ts'

/** Timestamps are stored as ISO 8601 UTC text and compared as text. */
export function iso(date: Date): string {
  return date.toISOString()
}

/** The largest value of an INTEGER column on every backend: PostgreSQL and MariaDB store 32-bit integers (SQLite stores 64-bit). */
const MAX_INTEGER = 2 ** 31 - 1

/**
 * True for a board version the database can hold and increment: a whole number
 * from 1 to one below the INTEGER maximum. Anything else cannot match a stored
 * version, and PostgreSQL would raise an out-of-range error for it.
 */
export function isBoardVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value < MAX_INTEGER
}

/**
 * Inserts one row and returns whether it was inserted; a row that would
 * violate a unique or primary key is skipped and reported as false. Any other
 * failure (a missing foreign key, a value too long) still throws.
 *
 * SQLite and PostgreSQL skip the duplicate with ON CONFLICT DO NOTHING, which
 * raises no error, so the call is safe inside a PostgreSQL transaction (it
 * aborts a transaction after any failed statement). MariaDB's INSERT IGNORE
 * would also swallow foreign-key and length errors, so there the plain INSERT
 * runs and a duplicate-key error is caught; MariaDB keeps a transaction usable
 * after a failed statement.
 */
export async function insertIgnoringDuplicate<T extends keyof Tables>(
  db: Kysely<Tables>,
  table: T,
  values: InsertObject<Tables, T>,
): Promise<boolean> {
  const insert = db.insertInto(table).values(values)
  if (db.getExecutor().adapter instanceof MysqlAdapter) {
    try {
      await insert.execute()
      return true
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  }
  const result = await insert.onConflict((oc) => oc.doNothing()).executeTakeFirst()
  return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1
}
