import type { Kysely } from 'kysely'
import type { Tables } from './schema.ts'

const GITHUB_WRITES = 'github_writes'

/** True only when the `github_writes` row of `meta` holds '1'; a missing row or any other value reads as false. */
export async function getGithubWrites(db: Kysely<Tables>): Promise<boolean> {
  const row = await db.selectFrom('meta').select('value').where('key', '=', GITHUB_WRITES).executeTakeFirst()
  return row?.value === '1'
}

/** Writes '1' or '0' to the `github_writes` row, inserting the row when the update changed none. */
export async function setGithubWrites(db: Kysely<Tables>, on: boolean): Promise<void> {
  const value = on ? '1' : '0'
  const result = await db.updateTable('meta').set({ value }).where('key', '=', GITHUB_WRITES).executeTakeFirst()
  if (Number(result.numUpdatedRows) === 0) await db.insertInto('meta').values({ key: GITHUB_WRITES, value }).execute()
}
