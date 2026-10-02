import { afterEach, describe, expect, test } from 'vitest'
import { dummyHash, hashPassword, setPasswordCost, verifyPassword } from './password.ts'

afterEach(() => setPasswordCost(12))

describe('password hashing cost', () => {
  test('production hashes use bcrypt cost 12', async () => {
    expect(await hashPassword('correct horse battery')).toMatch(/^\$2[aby]\$12\$/)
  })

  test('the dummy hash for unknown users has the cost in effect', async () => {
    expect(await dummyHash()).toMatch(/^\$2[aby]\$12\$/)
    setPasswordCost(4)
    expect(await dummyHash()).toMatch(/^\$2[aby]\$04\$/)
    expect(await hashPassword('correct horse battery')).toMatch(/^\$2[aby]\$04\$/)
  })

  test('an unknown account never verifies, and a real hash does', async () => {
    setPasswordCost(4)
    expect(await verifyPassword('anything at all', null)).toBe(false)
    const stored = await hashPassword('correct horse battery')
    expect(await verifyPassword('correct horse battery', stored)).toBe(true)
    expect(await verifyPassword('wrong horse battery', stored)).toBe(false)
  })
})
