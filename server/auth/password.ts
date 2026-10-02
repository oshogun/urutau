import { compare, hash } from 'bcryptjs'
import { HttpError, invalidRequest } from '../http/errors.ts'

const COST = 12
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/
const MIN_PASSWORD = 8
const MAX_PASSWORD_BYTES = 72

/** A cost-12 hash of a random string nobody knows; compared against when the account does not exist so timing does not show it. */
const DUMMY_HASH = '$2b$12$yLmaF/ieWTEmj4RXEQaxuOt0OMVjB57P88PUFEyAReXbrnih5TX1i'

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
  return hash(password, COST)
}

/** Checks the password against the account's hash, or against a dummy hash when there is none. Returns whether it matches a real hash. */
export async function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  const matches = await compare(password, passwordHash ?? DUMMY_HASH)
  return passwordHash !== null && matches
}
