import type { Kysely } from 'kysely'
import { Migrator, type Migration } from 'kysely/migration'
import type { Backend } from '../index.ts'
import type { Tables } from '../schema.ts'
import { up as m0001 } from './0001_initial.ts'
import { up as m0002 } from './0002_github_writes.ts'

/** Names sort in order and a released migration is never edited; a change is a new numbered entry. */
function migrations(backend: Backend): Record<string, Migration> {
  return { '0001_initial': { up: (db) => m0001(db, backend) }, '0002_github_writes': { up: (db) => m0002(db) } }
}

/** Applies every pending migration and throws the first failure. */
export async function migrateToLatest(db: Kysely<Tables>, backend: Backend): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations(backend) } })
  const { error } = await migrator.migrateToLatest()
  if (error) throw error instanceof Error ? error : new Error(String(error))
}
