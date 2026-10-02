import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect, type Dialect } from 'kysely'
import { redact, urlSecrets } from '../log.ts'
import { migrateToLatest } from './migrations/index.ts'
import type { Tables } from './schema.ts'
import { kyselySqliteDatabase } from './sqlite.ts'

export type Backend = 'sqlite' | 'postgres' | 'mysql'

export interface Database {
  backend: Backend
  db: Kysely<Tables>
  /** Runs every pending migration; safe to call on every start. */
  migrate(): Promise<void>
  close(): Promise<void>
}

const UNSUPPORTED_SCHEME = 'DATABASE_URL must start with sqlite:, postgres:, postgresql:, mysql: or mariadb:'

function isModuleNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND'
}

function missingDriver(backendName: string, pkg: string): Error {
  return new Error(`DATABASE_URL selects ${backendName}, but the '${pkg}' package is not installed. Run: npm install ${pkg}`)
}

async function openSqlite(url: string): Promise<Dialect> {
  const target = url.slice('sqlite:'.length)
  if (!target) throw new Error('DATABASE_URL sqlite: needs a file path or :memory:')
  const memory = target === ':memory:'
  if (!memory) mkdirSync(dirname(target), { recursive: true })
  const raw = new DatabaseSync(memory ? ':memory:' : target)
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 5000')
  if (!memory) raw.exec('PRAGMA journal_mode = WAL')
  return new SqliteDialect({ database: kyselySqliteDatabase(raw) })
}

/** `importDriver` replaces the dynamic import of an optional driver; tests use it to simulate a package that is not installed. */
export interface OpenOptions {
  importDriver?: {
    pg?: () => Promise<typeof import('pg')>
    mysql2?: () => Promise<typeof import('mysql2')>
  }
}

async function openPostgres(url: string, options: OpenOptions): Promise<Dialect> {
  let pg: typeof import('pg').default
  try {
    pg = (await (options.importDriver?.pg ?? (() => import('pg')))()).default
  } catch (error) {
    if (isModuleNotFound(error)) throw missingDriver('PostgreSQL', 'pg')
    throw error
  }
  return new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) })
}

async function openMysql(url: string, options: OpenOptions): Promise<Dialect> {
  let mysql: typeof import('mysql2')
  try {
    mysql = await (options.importDriver?.mysql2 ?? (() => import('mysql2')))()
  } catch (error) {
    if (isModuleNotFound(error)) throw missingDriver('MariaDB or MySQL', 'mysql2')
    throw error
  }
  return new MysqlDialect({ pool: mysql.createPool({ uri: url.replace(/^mariadb:/, 'mysql:'), connectionLimit: 10 }) })
}

/**
 * Opens the database the URL names. The pg and mysql2 drivers are imported
 * only when selected. No error thrown from here contains the URL or its password.
 */
export async function openDatabase(url: string, options: OpenOptions = {}): Promise<Database> {
  const secrets = urlSecrets(url)
  let backend: Backend
  let dialect: Dialect
  try {
    if (url.startsWith('sqlite:')) {
      backend = 'sqlite'
      dialect = await openSqlite(url)
    } else if (/^postgres(?:ql)?:/.test(url)) {
      backend = 'postgres'
      dialect = await openPostgres(url, options)
    } else if (/^(?:mysql|mariadb):/.test(url)) {
      backend = 'mysql'
      dialect = await openMysql(url, options)
    } else {
      throw new Error(UNSUPPORTED_SCHEME)
    }
  } catch (error) {
    throw scrub(error, secrets)
  }
  const db = new Kysely<Tables>({ dialect })
  return {
    backend,
    db,
    async migrate() {
      try {
        await migrateToLatest(db, backend)
      } catch (error) {
        throw scrub(error, secrets)
      }
    },
    close: () => db.destroy(),
  }
}

/** The same error with the secrets removed from its message; the original is dropped so its text cannot leak. */
function scrub(error: unknown, secrets: readonly string[]): Error {
  const message = error instanceof Error ? error.message : String(error)
  const clean = new Error(redact(message, secrets))
  if (error instanceof Error) clean.name = error.name
  return clean
}

/** True for a unique or primary-key violation on any backend (SQLite errcode 2067/1555, PostgreSQL 23505, MariaDB 1062). */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { code?: unknown; errno?: unknown; errcode?: unknown }
  return (
    e.errcode === 2067 ||
    e.errcode === 1555 ||
    e.code === '23505' ||
    e.code === 'ER_DUP_ENTRY' ||
    e.errno === 1062
  )
}
