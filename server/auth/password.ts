import { compare, hash } from 'bcryptjs'
import { HttpError, invalidRequest } from '../http/errors.ts'

const PRODUCTION_COST = 12
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/
const MIN_PASSWORD = 8
const MAX_PASSWORD_BYTES = 72

/** A cost-12 hash of a random string nobody knows; compared against when the account does not exist so timing does not show it. */
const PRODUCTION_DUMMY_HASH = '$2b$12$yLmaF/ieWTEmj4RXEQaxuOt0OMVjB57P88PUFEyAReXbrnih5TX1i'

let cost = PRODUCTION_COST
const dummyHashes = new Map<number, Promise<string>>([[PRODUCTION_COST, Promise.resolve(PRODUCTION_DUMMY_HASH)]])

/**
 * Lowers the bcrypt cost so tests do not spend seconds hashing; only the test
 * harness calls it. Production keeps cost 12.
 */
export function setPasswordCost(value: number): void {
  cost = value
}

/** The hash an unknown account is compared against: always at the cost in effect, so the timing is the same as for a real account. */
export function dummyHash(): Promise<string> {
  let hashed = dummyHashes.get(cost)
  if (!hashed) {
    hashed = hash(`dummy-${crypto.randomUUID()}`, cost)
    dummyHashes.set(cost, hashed)
  }
  return hashed
}

export function validateUsername(username: string): void {
  if (!USERNAME.test(username)) {
    throw invalidRequest('The username must be 3 to 32 characters: letters, digits, dots, dashes and underscores, starting with a letter or digit.')
  }
}

export function validatePassword(password: string): void {
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new HttpError(400, 'password-too-long', 'The password can be at most 72 bytes.')
  }
  if (password.length < MIN_PASSWORD) throw invalidRequest('The password must be at least 8 characters.')
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, cost)
}

/** Checks the password against the account's hash, or against a dummy hash when there is none. Returns whether it matches a real hash. */
export async function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  const matches = await compare(password, passwordHash ?? (await dummyHash()))
  return passwordHash !== null && matches
}
