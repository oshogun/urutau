import { describe, expect, it } from 'vitest'
import { openDatabase } from './index.ts'

// The error Node raises when a package is not installed.
const notInstalled = (name: string) => async (): Promise<never> => {
  throw Object.assign(new Error(`Cannot find package '${name}'`), { code: 'ERR_MODULE_NOT_FOUND' })
}
const importDriver = { pg: notInstalled('pg'), mysql2: notInstalled('mysql2') }

describe('selecting a backend whose driver is missing', () => {
  it.each(['postgres://u:pw@db.example/app', 'postgresql://u:pw@db.example/app'])('names the pg package for %s', async (url) => {
    await expect(openDatabase(url, { importDriver })).rejects.toThrow(
      "DATABASE_URL selects PostgreSQL, but the 'pg' package is not installed. Run: npm install pg",
    )
  })

  it.each(['mysql://u:pw@db.example/app', 'mariadb://u:pw@db.example/app'])('names the mysql2 package for %s', async (url) => {
    await expect(openDatabase(url, { importDriver })).rejects.toThrow(
      "DATABASE_URL selects MariaDB or MySQL, but the 'mysql2' package is not installed. Run: npm install mysql2",
    )
  })

  it('does not hide other import failures as a missing driver', async () => {
    const broken = { pg: async (): Promise<never> => { throw new Error('syntax error in driver') } }
    await expect(openDatabase('postgres://u:pw@db.example/app', { importDriver: broken })).rejects.toThrow('syntax error in driver')
  })

  it('rejects an unknown scheme', async () => {
    await expect(openDatabase('ftp://example', { importDriver })).rejects.toThrow(
      'DATABASE_URL must start with sqlite:, postgres:, postgresql:, mysql: or mariadb:',
    )
  })
})
