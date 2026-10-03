import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test, vi } from 'vitest'

const opened = vi.hoisted(() => ({ close: vi.fn(async () => {}) }))

vi.mock('./db/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./db/index.ts')>()
  return {
    ...original,
    openDatabase: async (url: string) => {
      const database = await original.openDatabase(url)
      return {
        ...database,
        migrate: async () => {
          throw new Error('migration failed')
        },
        close: async () => {
          opened.close()
          await database.close()
        },
      }
    },
  }
})

const { isEntryModule, start } = await import('./main.ts')

describe('start', () => {
  test('closes the database and rethrows when the migration throws', async () => {
    await expect(start({ env: { DATABASE_URL: 'sqlite::memory:' }, port: 0, serveStatic: false })).rejects.toThrow('migration failed')
    expect(opened.close).toHaveBeenCalledTimes(1)
  })
})

describe('isEntryModule', () => {
  const file = fileURLToPath(new URL('./main.ts', import.meta.url))
  const url = pathToFileURL(file).href

  test('follows import.meta.main when it is defined', () => {
    expect(isEntryModule({ main: true, url }, '/elsewhere.ts')).toBe(true)
    expect(isEntryModule({ main: false, url }, file)).toBe(false)
  })

  test('compares argv[1] with this module when import.meta.main is undefined', () => {
    expect(isEntryModule({ main: undefined, url }, file)).toBe(true)
    expect(isEntryModule({ url }, file)).toBe(true)
    expect(isEntryModule({ main: undefined, url }, file.replace('main.ts', 'other.ts'))).toBe(false)
    expect(isEntryModule({ main: undefined, url }, undefined)).toBe(false)
  })
})
