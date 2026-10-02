/** Test helpers shared by the Keycloak and GitHub proxy suites: a test app wired to the fake Keycloak, and the sign-in round trip. */
import type { TestApp, TestClient } from '../testing/harness.ts'
import { createTestApp } from '../testing/harness.ts'
import type { KeycloakConfig } from '../config.ts'
import { createFakeKeycloak, type FakeKeycloak, type FakeUser } from './fakeKeycloak.ts'

export const PUBLIC_URL = 'http://localhost:8787'

export interface KeycloakTestApp {
  h: TestApp
  kc: FakeKeycloak
}

export async function createKeycloakApp(
  options: { keycloak?: Partial<KeycloakConfig>; withKeycloak?: boolean; accessLifetime?: number } = {},
): Promise<KeycloakTestApp> {
  const kc = createFakeKeycloak({ accessLifetime: options.accessLifetime })
  const keycloak: KeycloakConfig | null =
    options.withKeycloak === false
      ? null
      : {
          issuer: kc.issuer,
          clientId: kc.clientId,
          clientSecret: kc.clientSecret,
          githubIdpAlias: 'github',
          brokerApi: 'v1',
          allowHttp: false,
          ...options.keycloak,
        }
  const h = await createTestApp({ config: { publicUrl: PUBLIC_URL, keycloak }, fetch: kc.fetch })
  return { h, kc }
}

/** The path and query of a redirect `Location` on the app, for the next request. */
export function appPath(location: string): string {
  const url = new URL(location)
  return url.pathname + url.search
}

/**
 * Signs a user in through the start and callback routes, the fake Keycloak
 * approving the request. Returns the callback response.
 */
export async function keycloakSignIn(browser: TestClient, kc: FakeKeycloak, user: FakeUser): Promise<Response> {
  const start = await browser.get('/api/auth/keycloak/start')
  const location = start.headers.get('location')
  if (start.status !== 302 || location === null) throw new Error(`start answered ${start.status}`)
  const query = kc.authorize(location, user)
  const callback = await browser.get(`/api/auth/keycloak/callback${query}`)
  // The callback is a redirect with no body; read the session so the client learns its CSRF token.
  if (callback.headers.get('location')?.includes('signin-error') === false) await browser.send('GET', '/api/session')
  return callback
}
