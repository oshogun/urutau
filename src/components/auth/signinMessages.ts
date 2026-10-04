const SIGNIN_ERRORS: Record<string, string> = {
  'keycloak-unavailable': 'Keycloak could not be reached. Try again in a moment.',
  'keycloak-expired': 'The Keycloak sign-in took too long. Start it again.',
  'keycloak-denied': 'Keycloak did not let you in.',
  'keycloak-failed': 'The Keycloak sign-in failed. Start it again.',
}

const GENERIC_MESSAGE = 'Signing in failed. Try again.'

export function signinErrorMessage(code: string): string {
  // Own keys only: a code such as `__proto__` or `constructor` would otherwise read an inherited value.
  return Object.hasOwn(SIGNIN_ERRORS, code) ? SIGNIN_ERRORS[code] : GENERIC_MESSAGE
}
