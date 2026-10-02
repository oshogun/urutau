import { sql, type Kysely } from 'kysely'
import type { Backend } from '../index.ts'

export async function up(db: Kysely<any>, backend: Backend): Promise<void> {
  // MariaDB compares text case-insensitively by default; utf8mb4_bin makes it byte-exact like the other backends.
  const tableEnd = backend === 'mysql' ? sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin` : sql``
  // MariaDB's TEXT stops at 64 KB.
  const longText = backend === 'mysql' ? sql`mediumtext` : sql`text`

  await db.schema
    .createTable('meta')
    .addColumn('key', 'varchar(64)', (c) => c.primaryKey())
    .addColumn('value', 'varchar(255)', (c) => c.notNull())
    .modifyEnd(tableEnd)
    .execute()
  await db.insertInto('meta').values({ key: 'instance_id', value: crypto.randomUUID() }).execute()

  await db.schema
    .createTable('users')
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
    .addColumn('username', 'varchar(64)', (c) => c.notNull())
    .addColumn('username_key', 'varchar(64)', (c) => c.notNull().unique())
    .addColumn('display_name', 'varchar(128)')
    .addColumn('password_hash', 'varchar(60)')
    .addColumn('is_admin', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'varchar(24)', (c) => c.notNull())
    .modifyEnd(tableEnd)
    .execute()

  // No foreign key on purpose: deleting users must never re-open first-run.
  await db.schema
    .createTable('instance_claim')
    .addColumn('id', 'integer', (c) => c.primaryKey())
    .addColumn('user_id', 'varchar(36)', (c) => c.notNull())
    .addColumn('claimed_at', 'varchar(24)', (c) => c.notNull())
    .modifyEnd(tableEnd)
    .execute()

  await db.schema
    .createTable('sessions')
    .addColumn('id_hash', 'varchar(64)', (c) => c.primaryKey())
    .addColumn('user_id', 'varchar(36)', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('auth_method', 'varchar(16)', (c) => c.notNull())
    .addColumn('csrf_token', 'varchar(64)', (c) => c.notNull())
    .addColumn('created_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('last_seen_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('expires_at', 'varchar(24)', (c) => c.notNull())
    .modifyEnd(tableEnd)
    .execute()
  await db.schema.createIndex('sessions_user_id').on('sessions').column('user_id').execute()
  await db.schema.createIndex('sessions_expires_at').on('sessions').column('expires_at').execute()

  await db.schema
    .createTable('invites')
    .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
    .addColumn('token_hash', 'varchar(64)', (c) => c.notNull().unique())
    .addColumn('created_by', 'varchar(36)', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('expires_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('used_at', 'varchar(24)')
    .addColumn('used_by', 'varchar(36)', (c) => c.references('users.id').onDelete('set null'))
    .modifyEnd(tableEnd)
    .execute()

  await db.schema
    .createTable('identities')
    .addColumn('issuer', 'varchar(255)', (c) => c.notNull())
    .addColumn('subject', 'varchar(255)', (c) => c.notNull())
    .addColumn('user_id', 'varchar(36)', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'varchar(24)', (c) => c.notNull())
    .addPrimaryKeyConstraint('identities_pk', ['issuer', 'subject'])
    .modifyEnd(tableEnd)
    .execute()
  await db.schema.createIndex('identities_user_id').on('identities').column('user_id').execute()

  await db.schema
    .createTable('boards')
    .addColumn('repo_key', 'varchar(200)', (c) => c.primaryKey())
    .addColumn('full_name', 'varchar(200)', (c) => c.notNull())
    .addColumn('config', longText, (c) => c.notNull())
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('updated_at', 'varchar(24)', (c) => c.notNull())
    .addColumn('updated_by', 'varchar(36)', (c) => c.references('users.id').onDelete('set null'))
    .modifyEnd(tableEnd)
    .execute()
}
