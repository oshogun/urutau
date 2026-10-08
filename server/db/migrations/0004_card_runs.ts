import { sql, type Kysely } from 'kysely'
import type { Backend } from '../index.ts'

/**
 * Adds the tables for agent runs on issues: one row per run, the claim an
 * issue's current run holds, and the events that close a run's unverified
 * items. No existing table changes. Every statement tolerates objects that
 * already exist, so the migration also succeeds when its row in
 * kysely_migration was deleted for a re-run.
 */
export async function up(db: Kysely<any>, backend: Backend): Promise<void> {
  const tableEnd = backend === 'mysql' ? sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin` : sql``
  const longText = backend === 'mysql' ? sql`mediumtext` : sql`text`

  // MySQL has no CREATE INDEX IF NOT EXISTS, and the mysql backend serves MySQL as well as MariaDB: look the index up first.
  const ensureIndex = async (name: string, table: string, columns: string[]): Promise<void> => {
    if (backend === 'mysql') {
      const found = await sql<{ one: number }>`SELECT 1 AS one FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ${table} AND index_name = ${name}`.execute(db)
      if (found.rows.length > 0) return
      await db.schema.createIndex(name).on(table).columns(columns).execute()
      return
    }
    await db.schema.createIndex(name).ifNotExists().on(table).columns(columns).execute()
  }

  await db.schema
    .createTable('card_runs')
    .ifNotExists()
    .addColumn('run_id', 'varchar(64)', (c) => c.primaryKey())
    .addColumn('repo_key', 'varchar(200)', (c) => c.notNull())
    .addColumn('issue', 'integer', (c) => c.notNull())
    .addColumn('agent_user_id', 'varchar(36)', (c) => c.notNull())
    .addColumn('status', 'varchar(24)', (c) => c.notNull())
    .addColumn('status_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('triage_range', 'varchar(8)')
    .addColumn('uncertainty_kind', 'varchar(16)')
    .addColumn('unverified', longText, (c) => c.notNull())
    .addColumn('merge_shas', 'text', (c) => c.notNull())
    .addColumn('files', longText, (c) => c.notNull())
    .addColumn('files_omitted', 'integer', (c) => c.notNull())
    .addColumn('areas', 'text', (c) => c.notNull())
    .addColumn('observed_by', 'varchar(64)')
    .addColumn('fix_rounds', 'integer', (c) => c.notNull())
    .addColumn('cost_usd', 'double precision')
    .addColumn('findings', 'text')
    .addColumn('started_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('ended_at', 'varchar(24)')
    .addUniqueConstraint('card_runs_repo_issue_run', ['repo_key', 'issue', 'run_id'])
    .modifyEnd(tableEnd)
    .execute()
  await ensureIndex('card_runs_repo_issue_status_at', 'card_runs', ['repo_key', 'issue', 'status_at'])

  await db.schema
    .createTable('card_claims')
    .ifNotExists()
    .addColumn('repo_key', 'varchar(200)', (c) => c.notNull())
    .addColumn('issue', 'integer', (c) => c.notNull())
    .addColumn('run_id', 'varchar(64)', (c) => c.notNull().references('card_runs.run_id'))
    .addColumn('holder', 'varchar(36)', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('lease_until', 'varchar(24)')
    .addColumn('claimed_at', 'varchar(24)', (c) => c.notNull())
    .addPrimaryKeyConstraint('card_claims_pk', ['repo_key', 'issue'])
    .modifyEnd(tableEnd)
    .execute()
  await ensureIndex('card_claims_holder', 'card_claims', ['holder'])

  await db.schema
    .createTable('run_events')
    .ifNotExists()
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
    .addColumn('run_id', 'varchar(64)', (c) => c.notNull().references('card_runs.run_id'))
    .addColumn('kind', 'varchar(16)', (c) => c.notNull())
    .addColumn('resolves', 'varchar(32)')
    .addColumn('surfaced_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('detail', 'text', (c) => c.notNull())
    .addColumn('by', 'varchar(36)', (c) => c.notNull())
    .addColumn('at', 'varchar(24)', (c) => c.notNull())
    .addUniqueConstraint('run_events_run_resolves', ['run_id', 'resolves'])
    .modifyEnd(tableEnd)
    .execute()
}
