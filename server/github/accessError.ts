import type { GitHubAccessError } from '../../src/domain/api.ts'
import { HttpError } from '../http/errors.ts'
import type { GitHubTokenResult } from '../oidc/grants.ts'

/** The 424 `github-access` error for a token problem reported by the Keycloak grant. */
export function accessError(problem: Extract<GitHubTokenResult, { ok: false }>['problem']): HttpError {
  const messages = {
    'signin-expired': 'Sign in with Keycloak again to read GitHub through this server.',
    'not-linked': 'Your Keycloak account is not linked to a GitHub account.',
    refused: 'Keycloak did not hand over a GitHub token for your account.',
    unavailable: 'Keycloak could not be reached to get a GitHub token. Try again shortly.',
  } as const
  const body: Omit<GitHubAccessError, 'error' | 'message'> = { problem }
  return new HttpError(424, 'github-access', messages[problem], { extra: body })
}
