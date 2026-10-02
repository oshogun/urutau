import { InlineNotification } from '@carbon/react'
import type { GitHubAccessProblem } from '../../domain/api'
import { useSession } from '../../state/session'
import { KeycloakButton } from './KeycloakButton'
import './auth.scss'

const PROBLEM_TEXT: Record<GitHubAccessProblem, string> = {
  'signin-expired': 'Sign in with Keycloak again to read issues through your GitHub link.',
  'not-linked': 'Your Keycloak account has no linked GitHub account.',
  refused: 'Keycloak did not hand out your GitHub token.',
}

/**
 * Why issues are not read through the Keycloak link for this session, with the way out: sign in
 * again when the link expired, or paste a token. Renders nothing when there is no problem.
 */
export function GitHubAccessNotice() {
  const access = useSession((state) => state.session?.githubAccess)
  if (access?.mode !== 'browser' || !access.problem) return null
  const expired = access.problem === 'signin-expired'
  return (
    <div className="github-access-notice">
      <InlineNotification
        role="status"
        kind="warning"
        lowContrast
        hideCloseButton
        title={PROBLEM_TEXT[access.problem]}
        subtitle={expired ? 'Or paste a token below.' : 'You can paste a token below instead.'}
      />
      {expired && <KeycloakButton kind="secondary">Sign in with Keycloak again</KeycloakButton>}
    </div>
  )
}
