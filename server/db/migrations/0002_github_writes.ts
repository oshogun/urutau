import type { Kysely } from 'kysely'

/** Adds the `github_writes` switch to `meta`, off. It keeps an existing row, so it also succeeds after a rollback that left one. */
export async function up(db: Kysely<any>): Promise<void> {
  const existing = await db.selectFrom('meta').select('key').where('key', '=', 'github_writes').executeTakeFirst()
  if (!existing) await db.insertInto('meta').values({ key: 'github_writes', value: '0' }).execute()
}
