import * as client from 'openid-client'
import type { KeycloakConfig } from '../config.ts'
import type { Logger } from '../log.ts'
import { fetchBrokerToken } from './broker.ts'
import { GrantStore, type Grant, type GitHubTokenResult } from './grants.ts'

/** The `signin-error` values the sign-in routes put in the redirect to the app. */
export type SignInError = 'keycloak-unavailable' | 'keycloak-expired' | 'keycloak-denied' | 'keycloak-failed'

export interface KeycloakClaims {
  issuer: string
  subject: string
  preferredUsername: string | null
  name: string | null
}

export interface KeycloakDeps {
  config: KeycloakConfig
  /** `PUBLIC_URL`, without a trailing slash. */
  publicUrl: string
  fetch: typeof fetch
  now: () => Date
  log: Logger
  grants: GrantStore
}

interface Login {
  codeVerifier: string
  state: string
  nonce: string
  createdAt: number
}

export type FinishedLogin = { ok: true; claims: KeycloakClaims; grant: Grant } | { ok: false; error: SignInError }

const LOGIN_TTL_MS = 10 * 60 * 1000
const MAX_LOGINS = 1000
const REFRESH_MARGIN_MS = 30_000
const GITHUB_TOKEN_TTL_MS = 5 * 60 * 1000
const DISCOVERY_TIMEOUT_S = 10

export const LOGIN_COOKIE = 'urutau_oidc'
export const LOGIN_COOKIE_PATH = '/api/auth/keycloak'
export const LOGIN_COOKIE_MAX_AGE_S = LOGIN_TTL_MS / 1000

type TokenResponse = Awaited<ReturnType<typeof client.refreshTokenGrant>>

function refreshExpiry(tokens: TokenResponse, now: number): number | null {
  const seconds = (tokens as Record<string, unknown>).refresh_expires_in
  return typeof seconds === 'number' && seconds > 0 ? now + seconds * 1000 : null
}

function grantFrom(tokens: TokenResponse, now: number, previous?: Grant): Grant {
  return {
    accessToken: tokens.access_token,
    accessExpiresAt: now + (tokens.expires_in ?? 300) * 1000,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
    refreshExpiresAt: tokens.refresh_token ? refreshExpiry(tokens, now) : (previous?.refreshExpiresAt ?? null),
    idToken: tokens.id_token ?? previous?.idToken ?? null,
    broker: previous?.broker ?? 'unknown',
    github: previous?.github ?? null,
    pending: null,
  }
}

/** True when Keycloak answered and said no, as opposed to not answering. */
function isRefusal(error: unknown): boolean {
  return error instanceof client.ResponseBodyError || error instanceof client.AuthorizationResponseError
}

export interface Keycloak {
  readonly redirectUri: string
  /** True when `KEYCLOAK_GITHUB_IDP` is set, so signed-in users read GitHub through the server. */
  readonly brokersGitHub: boolean
  beginLogin(): Promise<{ loginId: string; location: string } | null>
  finishLogin(loginId: string | undefined, search: string): Promise<FinishedLogin>
  /** Asks the broker once for the session's GitHub token and records the outcome on its grant. */
  githubToken(sessionIdHash: string, options?: { fresh?: boolean }): Promise<GitHubTokenResult>
  /** Where the browser goes to end the Keycloak single sign-on session too; null when it cannot be built. */
  endSessionUrl(idToken: string | null): Promise<string | null>
}

export function createKeycloak(deps: KeycloakDeps): Keycloak {
  const { config, grants } = deps
  const redirectUri = `${deps.publicUrl}/api/auth/keycloak/callback`
  const logins = new Map<string, Login>()
  let discovered: Promise<client.Configuration> | null = null

  function discover(): Promise<client.Configuration> {
    if (!discovered) {
      discovered = client
        .discovery(new URL(config.issuer), config.clientId, config.clientSecret, undefined, {
          execute: config.allowHttp ? [client.allowInsecureRequests] : [],
          [client.customFetch]: deps.fetch,
          timeout: DISCOVERY_TIMEOUT_S,
        })
        .catch((error: unknown) => {
          discovered = null
          throw error
        })
    }
    return discovered
  }

  function pruneLogins(now: number): void {
    for (const [id, login] of logins) {
      if (now - login.createdAt > LOGIN_TTL_MS) logins.delete(id)
    }
    while (logins.size > MAX_LOGINS) {
      const oldest = logins.keys().next()
      if (oldest.done) break
      logins.delete(oldest.value)
    }
  }

  async function refreshGrant(sessionIdHash: string, grant: Grant): Promise<'ok' | 'gone' | 'unavailable'> {
    if (grant.refreshToken === null) {
      grants.delete(sessionIdHash)
      return 'gone'
    }
    try {
      const tokens = await client.refreshTokenGrant(await discover(), grant.refreshToken)
      const now = deps.now().getTime()
      Object.assign(grant, { ...grantFrom(tokens, now, grant), pending: grant.pending })
      return 'ok'
    } catch (error) {
      if (isRefusal(error)) {
        grants.delete(sessionIdHash)
        return 'gone'
      }
      deps.log.warn('keycloak refresh failed', { name: error instanceof Error ? error.name : 'Error' })
      return 'unavailable'
    }
  }

  async function obtain(sessionIdHash: string, grant: Grant): Promise<GitHubTokenResult> {
    if (!config.githubIdpAlias) return { ok: false, problem: 'refused' }
    const idp = { ...config, githubIdpAlias: config.githubIdpAlias }
    if (grant.accessExpiresAt - deps.now().getTime() < REFRESH_MARGIN_MS) {
      const refreshed = await refreshGrant(sessionIdHash, grant)
      if (refreshed === 'gone') return { ok: false, problem: 'signin-expired' }
      if (refreshed === 'unavailable') return { ok: false, problem: 'unavailable' }
    }
    let result = await fetchBrokerToken(idp, grant.accessToken, deps.fetch)
    if (result.kind === 'invalid-token') {
      const refreshed = await refreshGrant(sessionIdHash, grant)
      if (refreshed === 'gone') return { ok: false, problem: 'signin-expired' }
      if (refreshed === 'unavailable') return { ok: false, problem: 'unavailable' }
      result = await fetchBrokerToken(idp, grant.accessToken, deps.fetch)
      if (result.kind === 'invalid-token') {
        grants.delete(sessionIdHash)
        return { ok: false, problem: 'signin-expired' }
      }
    }
    switch (result.kind) {
      case 'token':
        grant.broker = 'ok'
        grant.github = { token: result.token, fetchedAt: deps.now().getTime() }
        return { ok: true, token: result.token }
      case 'not-linked':
      case 'refused':
        grant.broker = result.kind
        grant.github = null
        deps.log.warn('keycloak broker did not return a GitHub token', { reason: result.kind })
        return { ok: false, problem: result.kind }
      default:
        deps.log.warn('keycloak broker unavailable')
        return { ok: false, problem: 'unavailable' }
    }
  }

  return {
    redirectUri,
    brokersGitHub: config.githubIdpAlias !== null,

    async beginLogin() {
      let metadata: client.Configuration
      try {
        metadata = await discover()
      } catch (error) {
        deps.log.warn('keycloak discovery failed', { name: error instanceof Error ? error.name : 'Error' })
        return null
      }
      const now = deps.now().getTime()
      const login: Login = {
        codeVerifier: client.randomPKCECodeVerifier(),
        state: client.randomState(),
        nonce: client.randomNonce(),
        createdAt: now,
      }
      const loginId = crypto.randomUUID()
      pruneLogins(now)
      logins.set(loginId, login)
      const url = client.buildAuthorizationUrl(metadata, {
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        code_challenge: await client.calculatePKCECodeChallenge(login.codeVerifier),
        code_challenge_method: 'S256',
        state: login.state,
        nonce: login.nonce,
      })
      return { loginId, location: url.href }
    },

    async finishLogin(loginId, search) {
      const now = deps.now().getTime()
      const login = loginId === undefined ? undefined : logins.get(loginId)
      if (loginId !== undefined) logins.delete(loginId)
      if (!login || now - login.createdAt > LOGIN_TTL_MS) return { ok: false, error: 'keycloak-expired' }
      if (new URLSearchParams(search).has('error')) return { ok: false, error: 'keycloak-denied' }
      let metadata: client.Configuration
      try {
        metadata = await discover()
      } catch {
        return { ok: false, error: 'keycloak-unavailable' }
      }
      try {
        const tokens = await client.authorizationCodeGrant(metadata, new URL(redirectUri + search), {
          pkceCodeVerifier: login.codeVerifier,
          expectedState: login.state,
          expectedNonce: login.nonce,
        })
        const claims = tokens.claims()
        if (!claims || typeof claims.sub !== 'string' || claims.sub === '') return { ok: false, error: 'keycloak-failed' }
        return {
          ok: true,
          claims: {
            issuer: claims.iss,
            subject: claims.sub,
            preferredUsername: typeof claims.preferred_username === 'string' ? claims.preferred_username : null,
            name: typeof claims.name === 'string' ? claims.name : null,
          },
          grant: grantFrom(tokens, deps.now().getTime()),
        }
      } catch (error) {
        deps.log.warn('keycloak sign-in failed', { name: error instanceof Error ? error.name : 'Error' })
        return { ok: false, error: 'keycloak-failed' }
      }
    },

    async githubToken(sessionIdHash, options = {}) {
      const grant = grants.get(sessionIdHash)
      if (!grant) return { ok: false, problem: 'signin-expired' }
      if (grant.pending) return grant.pending
      if (!options.fresh) {
        if (grant.broker === 'not-linked' || grant.broker === 'refused') return { ok: false, problem: grant.broker }
        if (grant.github && deps.now().getTime() - grant.github.fetchedAt < GITHUB_TOKEN_TTL_MS) {
          return { ok: true, token: grant.github.token }
        }
      }
      // A token GitHub just rejected must not be sent again if the broker cannot supply a new one.
      if (options.fresh) grant.github = null
      const pending = obtain(sessionIdHash, grant).finally(() => {
        grant.pending = null
      })
      grant.pending = pending
      return pending
    },

    async endSessionUrl(idToken) {
      try {
        const metadata = await discover()
        const parameters: Record<string, string> = {
          client_id: config.clientId,
          post_logout_redirect_uri: `${deps.publicUrl}/`,
        }
        if (idToken) parameters.id_token_hint = idToken
        return client.buildEndSessionUrl(metadata, parameters).href
      } catch {
        return null
      }
    },
  }
}
