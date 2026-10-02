// Smoke test for compose.keycloak.yaml: signs in as the seeded user `octocat`
// through the stand-in realm (kc_idp_hint=github, PKCE S256, Playwright for the
// login form), then calls the broker token endpoint with the access token and
// prints the HTTP status. Token values are never printed.
//   URUTAU_KEYCLOAK_PORT=58081 node .claude/skills/run-urutau/keycloak/smoke.mjs
import * as client from 'openid-client'
import { chromium } from 'playwright'

const KC = `http://127.0.0.1:${process.env.URUTAU_KEYCLOAK_PORT ?? 58080}`
const REDIRECT = 'http://127.0.0.1:8788/api/auth/keycloak/callback'

const config = await client.discovery(new URL(`${KC}/realms/urutau`), 'urutau', 'urutau-dev-secret', undefined, {
  execute: [client.allowInsecureRequests],
})
console.log('discovery issuer:', config.serverMetadata().issuer)

const verifier = client.randomPKCECodeVerifier()
const state = client.randomState()
const nonce = client.randomNonce()
const authUrl = client.buildAuthorizationUrl(config, {
  redirect_uri: REDIRECT,
  scope: 'openid profile email',
  state,
  nonce,
  code_challenge: await client.calculatePKCECodeChallenge(verifier),
  code_challenge_method: 'S256',
  kc_idp_hint: 'github',
})
const browser = await chromium.launch({ args: ['--no-sandbox'] })
let callback = ''
try {
  const page = await (await browser.newContext()).newPage()
  // Redirected navigations skip route handlers, so read the callback URL from the request event.
  page.on('request', (request) => {
    if (request.url().startsWith(REDIRECT)) callback = request.url()
  })
  await page.goto(authUrl.href)
  await page.fill('#username', 'octocat')
  await page.fill('#password', 'octocat-dev-password')
  await page.click('#kc-login')
  for (let i = 0; i < 100 && !callback; i += 1) await page.waitForTimeout(200)
} finally {
  await browser.close()
}
if (!callback) throw new Error('The login did not reach the redirect URI')
const tokens = await client.authorizationCodeGrant(config, new URL(callback), {
  pkceCodeVerifier: verifier,
  expectedState: state,
  expectedNonce: nonce,
})
console.log('signed in as:', tokens.claims()?.preferred_username)
const broker = await fetch(`${KC}/realms/urutau/broker/github/token`, {
  headers: { Authorization: `Bearer ${tokens.access_token}` },
})
const body = await broker.text()
console.log(`broker token endpoint: HTTP ${broker.status}, ${body.length} chars, has access_token: ${body.includes('access_token')}`)
process.exit(broker.status === 200 ? 0 : 1)
