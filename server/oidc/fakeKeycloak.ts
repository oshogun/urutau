/**
 * A stand-in for Keycloak and api.github.com behind one stubbed `fetch`, for
 * the default test suite: OIDC discovery, a signing key, the token endpoint
 * (checking PKCE and the client secret, issuing signed id tokens), the broker
 * endpoint and GitHub. Tests only; the server never imports it.
 */
import { createHash, createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'

export interface FakeUser {
  sub: string
  preferred_username?: string
  name?: string
}

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export interface FakeKeycloakOptions {
  issuer?: string
  clientId?: string
  clientSecret?: string
  /** Seconds the access token lives; default 300. */
  accessLifetime?: number
}

export interface FakeKeycloak {
  issuer: string
  clientId: string
  clientSecret: string
  fetch: typeof fetch
  requests: RecordedRequest[]
  /** Requests to one host, in order. */
  to(host: string): RecordedRequest[]
  /** What the broker endpoint answers; change it between requests. */
  broker: { status: number; body: string }
  /** Replaces the answer of api.github.com (default: 200, `{"ok":true}`). */
  github: (request: RecordedRequest) => Response
  /** Make the discovery document unreachable. */
  discoveryDown: boolean
  /** Put a wrong nonce in the next id token. */
  wrongNonce: boolean
  /** The access token the broker expects; others get 400 `Invalid token.` */
  acceptedAccessToken(): string | null
  /** Plays the browser: approves the authorization request and returns the callback query string (`?code=…&state=…`). */
  authorize(location: string, user: FakeUser, overrides?: { state?: string }): string
  /** How many token requests were made, by grant type. */
  tokenRequests(grantType: string): number
  /** Makes the next refresh-token grant answer an OAuth `invalid_grant` error. */
  refreshFails: boolean
}

let keys: { privateKey: KeyObject; jwk: Record<string, unknown> } | null = null

function signingKey() {
  if (!keys) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    keys = { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'fake-key', alg: 'RS256', use: 'sig' } }
  }
  return keys
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function signJwt(payload: Record<string, unknown>): string {
  const input = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fake-key' }))}.${base64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(input).sign(signingKey().privateKey)
  return `${input}.${base64url(signature)}`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function createFakeKeycloak(options: FakeKeycloakOptions = {}): FakeKeycloak {
  const issuer = options.issuer ?? 'https://keycloak.test/realms/urutau'
  const clientId = options.clientId ?? 'urutau'
  const clientSecret = options.clientSecret ?? 'fake-client-secret'
  const lifetime = options.accessLifetime ?? 300
  const codes = new Map<string, { user: FakeUser; nonce: string; challenge: string; redirectUri: string }>()
  const refreshTokens = new Map<string, FakeUser>()
  let accessCounter = 0
  let currentAccess: string | null = null
  const grantCounts = new Map<string, number>()
  const origin = new URL(issuer).origin

  const state: FakeKeycloak = {
    issuer,
    clientId,
    clientSecret,
    requests: [],
    broker: { status: 200, body: JSON.stringify({ access_token: 'gho_brokered_token_value', token_type: 'bearer' }) },
    github: () => json({ ok: true }),
    discoveryDown: false,
    wrongNonce: false,
    refreshFails: false,
    to: (host) => state.requests.filter((request) => new URL(request.url).host === host),
    acceptedAccessToken: () => currentAccess,
    tokenRequests: (grantType) => grantCounts.get(grantType) ?? 0,
    authorize(location, user, overrides = {}) {
      const url = new URL(location)
      const code = randomUUID()
      codes.set(code, {
        user,
        nonce: url.searchParams.get('nonce') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
      })
      return `?code=${code}&state=${encodeURIComponent(overrides.state ?? url.searchParams.get('state') ?? '')}`
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const body = init?.body === undefined || init.body === null ? '' : String(init.body)
      const request: RecordedRequest = { url, method: init?.method ?? 'GET', headers, body }
      state.requests.push(request)
      const parsed = new URL(url)

      if (parsed.host === 'api.github.com') return state.github(request)
      if (parsed.origin !== origin) throw new TypeError(`unexpected request to ${parsed.host}`)

      if (parsed.pathname === `${new URL(issuer).pathname}/.well-known/openid-configuration`) {
        if (state.discoveryDown) throw new TypeError('connection refused')
        return json({
          issuer,
          authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
          jwks_uri: `${issuer}/protocol/openid-connect/certs`,
          end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        })
      }
      if (parsed.pathname.endsWith('/protocol/openid-connect/certs')) return json({ keys: [signingKey().jwk] })
      if (parsed.pathname.endsWith('/protocol/openid-connect/token')) return tokenEndpoint(new URLSearchParams(body), headers)
      if (parsed.pathname.includes('/broker/') && parsed.pathname.endsWith('/token')) return brokerEndpoint(request)
      return new Response('not found', { status: 404 })
    }) as typeof fetch,
  }

  function issueTokens(user: FakeUser, nonce: string | null): Response {
    accessCounter += 1
    currentAccess = `access-token-${accessCounter}`
    const refresh = `refresh-token-${accessCounter}`
    refreshTokens.set(refresh, user)
    const now = Math.floor(Date.now() / 1000)
    const idToken = signJwt({
      iss: issuer,
      aud: clientId,
      sub: user.sub,
      exp: now + 300,
      iat: now,
      ...(nonce === null ? {} : { nonce: state.wrongNonce ? 'not-the-nonce' : nonce }),
      ...(user.preferred_username === undefined ? {} : { preferred_username: user.preferred_username }),
      ...(user.name === undefined ? {} : { name: user.name }),
    })
    return json({
      access_token: currentAccess,
      token_type: 'Bearer',
      expires_in: lifetime,
      refresh_token: refresh,
      refresh_expires_in: 1800,
      id_token: idToken,
      scope: 'openid profile email',
    })
  }

  function tokenEndpoint(form: URLSearchParams, headers: Record<string, string>): Response {
    const grantType = form.get('grant_type') ?? ''
    grantCounts.set(grantType, (grantCounts.get(grantType) ?? 0) + 1)
    const basic = headers.authorization?.startsWith('Basic ') ? Buffer.from(headers.authorization.slice(6), 'base64').toString() : null
    const secretOk = form.get('client_secret') === clientSecret || basic === `${clientId}:${clientSecret}`
    if (!secretOk) return json({ error: 'unauthorized_client' }, 401)
    if (grantType === 'authorization_code') {
      const code = codes.get(form.get('code') ?? '')
      codes.delete(form.get('code') ?? '')
      if (!code) return json({ error: 'invalid_grant' }, 400)
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url')
      if (challenge !== code.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
      if (form.get('redirect_uri') !== code.redirectUri) return json({ error: 'invalid_grant' }, 400)
      return issueTokens(code.user, code.nonce)
    }
    if (grantType === 'refresh_token') {
      const user = refreshTokens.get(form.get('refresh_token') ?? '')
      if (!user || state.refreshFails) return json({ error: 'invalid_grant' }, 400)
      return issueTokens(user, null)
    }
    return json({ error: 'unsupported_grant_type' }, 400)
  }

  function brokerEndpoint(request: RecordedRequest): Response {
    const presented = request.method === 'POST' ? new URLSearchParams(request.body).get('token') : request.headers.authorization?.replace(/^Bearer /, '')
    if (presented !== currentAccess) return json({ errorMessage: 'Invalid token.' }, 400)
    return new Response(state.broker.body, { status: state.broker.status, headers: { 'content-type': 'application/json' } })
  }

  return state
}
