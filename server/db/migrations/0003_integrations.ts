import { sql, type Kysely } from 'kysely'
import type { Backend } from '../index.ts'

/**
 * Adds the tables for agent integration accounts: the marker row, their API
 * tokens, a sealed GitHub token and the repositories each may read. Every
 * statement tolerates objects that already exist, so the migration also
 * succeeds when its row in kysely_migration was deleted for a re-run.
 */
export async function up(db: Kysely<any>, backend: Backend): Promise<void> {
  const tableEnd = backend === 'mysql' ? sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin` : sql``

  // MySQL and MariaDB have no CREATE INDEX IF NOT EXISTS: look the index up first.
  const ensureIndex = async (name: string, table: string, column: string): Promise<void> => {
    if (backend === 'mysql') {
      const found = await sql<{ one: number }>`SELECT 1 AS one FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ${table} AND index_name = ${name}`.execute(db)
      if (found.rows.length > 0) return
      await db.schema.createIndex(name).on(table).column(column).execute()
      return
    }
    await db.schema.createIndex(name).ifNotExists().on(table).column(column).execute()
  }

  await db.schema
    .createTable('integrations')
    .ifNotExists()
    .addColumn('user_id', 'varchar(36)', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('created_by', 'varchar(36)', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'varchar(24)', (c) => c.notNull())
    .modifyEnd(tableEnd)
    .execute()

  await db.schema
    .createTable('api_tokens')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
    .addColumn('user_id', 'varchar(36)', (c) => c.notNull().references('integrations.user_id').onDelete('cascade'))
    .addColumn('token_hash', 'varchar(64)', (c) => c.notNull().unique())
    .addColumn('label', 'varchar(64)', (c) => c.notNull())
    .addColumn('created_by', 'varchar(36)', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('expires_at', 'varchar(24)')
    .addColumn('last_used_at', 'varchar(24)')
    .modifyEnd(tableEnd)
    .execute()
  await ensureIndex('api_tokens_user_id', 'api_tokens', 'user_id')
  await ensureIndex('api_tokens_expires_at', 'api_tokens', 'expires_at')

  await db.schema
    .createTable('github_tokens')
    .ifNotExists()
    .addColumn('user_id', 'varchar(36)', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('sealed', 'varchar(1024)', (c) => c.notNull())
    .addColumn('key_id', 'varchar(16)', (c) => c.notNull())
    .addColumn('status', 'varchar(16)', (c) => c.notNull())
    .addColumn('set_by', 'varchar(36)', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('updated_at', 'varchar(24)', (c) => c.notNull())
    .modifyEnd(tableEnd)
    .execute()

  await db.schema
    .createTable('integration_repos')
    .ifNotExists()
    .addColumn('user_id', 'varchar(36)', (c) => c.notNull().references('integrations.user_id').onDelete('cascade'))
    .addColumn('repo_key', 'varchar(200)', (c) => c.notNull())
    .addPrimaryKeyConstraint('integration_repos_pk', ['user_id', 'repo_key'])
    .modifyEnd(tableEnd)
    .execute()
}
