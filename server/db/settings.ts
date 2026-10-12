import type { Kysely } from 'kysely'
import type { GithubWriteKind, GithubWrites } from '../../src/domain/api.ts'
import type { Tables } from './schema.ts'

/** The `meta` row that holds each kind's switch. A new kind needs an entry here and a migration that inserts it '0'. */
const KEYS: Record<GithubWriteKind, string> = {
  createIssues: 'github_writes_create_issues',
  editIssues: 'github_writes_edit_issues',
}

/** Each kind is true only when its `meta` row holds '1'; a missing row or any other value reads as false. */
export async function getGithubWrites(db: Kysely<Tables>): Promise<GithubWrites> {
  const entries = Object.entries(KEYS) as [GithubWriteKind, string][]
  const keys = entries.map(([, key]) => key)
  const rows = await db.selectFrom('meta').select(['key', 'value']).where('key', 'in', keys).execute()
  const values = new Map(rows.map((row) => [row.key, row.value]))
  return Object.fromEntries(entries.map(([kind, key]) => [kind, values.get(key) === '1'])) as GithubWrites
}

/** Writes '1' or '0' to the kind's row, inserting the row when the update changed none. */
export async function setGithubWrite(db: Kysely<Tables>, kind: GithubWriteKind, on: boolean): Promise<void> {
  const key = KEYS[kind]
  const value = on ? '1' : '0'
  const result = await db.updateTable('meta').set({ value }).where('key', '=', key).executeTakeFirst()
  if (Number(result.numUpdatedRows) === 0) await db.insertInto('meta').values({ key, value }).execute()
}
