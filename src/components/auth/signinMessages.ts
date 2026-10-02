const SIGNIN_ERRORS: Record<string, string> = {
  'keycloak-unavailable': 'Keycloak could not be reached. Try again in a moment.',
  'keycloak-expired': 'The Keycloak sign-in took too long. Start it again.',
  'keycloak-denied': 'Keycloak did not let you in.',
  'keycloak-failed': 'The Keycloak sign-in failed. Start it again.',
}

export function signinErrorMessage(code: string): string {
  return SIGNIN_ERRORS[code] ?? 'Signing in failed. Try again.'
}
