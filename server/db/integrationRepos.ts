import type { Kysely } from 'kysely'
import type { Tables } from './schema.ts'

/** The integration's repository keys, sorted. */
export async function listIntegrationRepos(db: Kysely<Tables>, userId: string): Promise<string[]> {
  const rows = await db.selectFrom('integration_repos').select('repo_key').where('user_id', '=', userId).orderBy('repo_key', 'asc').execute()
  // Sorted in code too: PostgreSQL's collation can order differently from the other backends.
  return rows.map((row) => row.repo_key).sort()
}

/** Every integration's keys, sorted, keyed by user id. */
export async function listAllIntegrationRepos(db: Kysely<Tables>): Promise<Map<string, string[]>> {
  const rows = await db.selectFrom('integration_repos').select(['user_id', 'repo_key']).orderBy('user_id', 'asc').orderBy('repo_key', 'asc').execute()
  const byUser = new Map<string, string[]>()
  for (const row of rows) {
    const keys = byUser.get(row.user_id)
    if (keys) keys.push(row.repo_key)
    else byUser.set(row.user_id, [row.repo_key])
  }
  for (const keys of byUser.values()) keys.sort()
  return byUser
}

/**
 * Replaces the list in one transaction; keys must already be repoKeyOf results, de-duplicated.
 * Returns the keys the list held before that are not in repoKeys, sorted ([] when none was
 * removed), read inside the same transaction.
 */
export async function setIntegrationRepos(db: Kysely<Tables>, userId: string, repoKeys: readonly string[]): Promise<string[]> {
  const run = async (trx: Kysely<Tables>): Promise<string[]> => {
    const before = await listIntegrationRepos(trx, userId)
    const keep = new Set(repoKeys)
    await trx.deleteFrom('integration_repos').where('user_id', '=', userId).execute()
    if (repoKeys.length > 0) {
      await trx.insertInto('integration_repos').values(repoKeys.map((repo_key) => ({ user_id: userId, repo_key }))).execute()
    }
    return before.filter((key) => !keep.has(key))
  }
  return db.isTransaction ? run(db) : db.transaction().execute(run)
}
