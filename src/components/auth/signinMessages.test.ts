import { describe, expect, it } from 'vitest'
import { signinErrorMessage } from './signinMessages'

const GENERIC = 'Signing in failed. Try again.'

describe('signinErrorMessage', () => {
  it.each([
    ['keycloak-unavailable', 'Keycloak could not be reached. Try again in a moment.'],
    ['keycloak-expired', 'The Keycloak sign-in took too long. Start it again.'],
    ['keycloak-denied', 'Keycloak did not let you in.'],
    ['keycloak-failed', 'The Keycloak sign-in failed. Start it again.'],
  ])('returns the message for %s', (code, message) => {
    expect(signinErrorMessage(code)).toBe(message)
  })

  it('returns the generic message for an unknown code', () => {
    expect(signinErrorMessage('something-else')).toBe(GENERIC)
    expect(signinErrorMessage('')).toBe(GENERIC)
  })

  it.each([...Object.getOwnPropertyNames(Object.prototype), '__proto__'])(
    'returns the generic message for the Object.prototype key %s',
    (code) => {
      expect(signinErrorMessage(code)).toBe(GENERIC)
    },
  )
})
