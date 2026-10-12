import type { Kysely } from 'kysely'

/**
 * Splits the `github_writes` switch in `meta` into one row per kind of write: `github_writes_create_issues` and
 * `github_writes_edit_issues`. Each takes today's value, so `'1'` turns both on and anything else, or no row, turns
 * both off. Then it deletes `github_writes`. It keeps an existing per-kind row, so it also succeeds after a rollback
 * that left one. The keys are written out here, not imported, so this migration does not change if the constants do.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const old = await db.selectFrom('meta').select('value').where('key', '=', 'github_writes').executeTakeFirst()
  const value = old?.value === '1' ? '1' : '0'
  for (const key of ['github_writes_create_issues', 'github_writes_edit_issues']) {
    const existing = await db.selectFrom('meta').select('key').where('key', '=', key).executeTakeFirst()
    if (!existing) await db.insertInto('meta').values({ key, value }).execute()
  }
  await db.deleteFrom('meta').where('key', '=', 'github_writes').execute()
}
