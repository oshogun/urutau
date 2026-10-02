import type { KeycloakConfig } from '../config.ts'

export type BrokerResult =
  | { kind: 'token'; token: string }
  /** Keycloak rejected the user's access token; a refresh may fix it. */
  | { kind: 'invalid-token' }
  | { kind: 'not-linked' }
  | { kind: 'refused' }
  /** Network failure or a 5xx answer; nothing is known about the account. */
  | { kind: 'unavailable' }

function accessTokenOf(body: string): string | null {
  const trimmed = body.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const token = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).access_token : undefined
      return typeof token === 'string' && token !== '' ? token : null
    } catch {
      return null
    }
  }
  // Keycloak returns GitHub's token response as stored: form-encoded unless the identity provider's JSON option is on.
  return new URLSearchParams(trimmed).get('access_token') || null
}

/**
 * Asks Keycloak's broker endpoint for the GitHub token stored for the user the
 * access token belongs to. Version 1 is a GET with the access token as a
 * bearer; version 2 is a POST with the client credentials and the access token
 * in the form.
 */
export async function fetchBrokerToken(
  config: KeycloakConfig & { githubIdpAlias: string },
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<BrokerResult> {
  const url = `${config.issuer}/broker/${encodeURIComponent(config.githubIdpAlias)}/token`
  let response: Response
  try {
    if (config.brokerApi === 'v2') {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, token: accessToken }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    } else {
      response = await fetchFn(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    }
  } catch {
    return { kind: 'unavailable' }
  }
  let body: string
  try {
    body = await response.text()
  } catch {
    return { kind: 'unavailable' }
  }
  if (response.status === 200) {
    const token = accessTokenOf(body)
    return token === null ? { kind: 'refused' } : { kind: 'token', token }
  }
  if (response.status >= 500) return { kind: 'unavailable' }
  if (response.status === 404) return { kind: 'not-linked' }
  if (response.status === 400) {
    if (/not associated/i.test(body)) return { kind: 'not-linked' }
    if (/invalid token|invalid_token/i.test(body)) return { kind: 'invalid-token' }
    return { kind: 'refused' }
  }
  return { kind: 'refused' }
}
