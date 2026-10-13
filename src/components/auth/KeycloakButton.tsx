import { Button } from '@carbon/react'

/** Where the browser goes to start a Keycloak sign-in; the server answers with a redirect. */
export const KEYCLOAK_START_URL = 'api/auth/keycloak/start'

interface KeycloakButtonProps {
  children: string
  kind?: 'tertiary' | 'secondary'
  size?: 'sm' | 'md'
  'aria-describedby'?: string
}

/** A link that looks like a button: starting a sign-in leaves the page, so it is not a fetch. */
export function KeycloakButton({
  children,
  kind = 'tertiary',
  size,
  'aria-describedby': describedBy,
}: KeycloakButtonProps) {
  return (
    <Button kind={kind} size={size} href={KEYCLOAK_START_URL} aria-describedby={describedBy}>
      {children}
    </Button>
  )
}
