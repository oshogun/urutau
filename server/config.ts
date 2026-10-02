/** The only module that reads environment variables. Errors name the variable, never its value. */

export interface KeycloakConfig {
  issuer: string
  clientId: string
  clientSecret: string
  githubIdpAlias: string | null
  brokerApi: 'v1' | 'v2'
  allowHttp: boolean
}

export interface Config {
  host: string
  port: number
  databaseUrl: string
  publicUrl: string | null
  trustProxy: boolean
  secureCookies: boolean
  keycloak: KeycloakConfig | null
}

const DEFAULT_DATABASE_URL = 'sqlite:data/urutau.db'

type Env = Record<string, string | undefined>

function text(env: Env, name: string): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

function flag(env: Env, name: string): boolean {
  const value = text(env, name)
  if (value === null || value === 'false') return false
  if (value === 'true') return true
  throw new Error(`${name} must be "true" or "false"`)
}

function parseUrl(name: string, value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute http or https URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an absolute http or https URL`)
  }
  return url
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export function loadConfig(env: Env): Config {
  const host = text(env, 'HOST') ?? '127.0.0.1'

  const rawPort = text(env, 'PORT') ?? '8787'
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535')
  }

  const databaseUrl = text(env, 'DATABASE_URL') ?? DEFAULT_DATABASE_URL

  let publicUrl: string | null = null
  const rawPublic = text(env, 'PUBLIC_URL')
  if (rawPublic !== null) {
    const parsed = parseUrl('PUBLIC_URL', rawPublic)
    if (parsed.search || parsed.hash) throw new Error('PUBLIC_URL must not contain a query string or fragment')
    publicUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, '')
  }

  const trustProxy = flag(env, 'TRUST_PROXY')

  const issuer = text(env, 'KEYCLOAK_ISSUER')
  const clientId = text(env, 'KEYCLOAK_CLIENT_ID')
  const clientSecret = text(env, 'KEYCLOAK_CLIENT_SECRET')
  let keycloak: KeycloakConfig | null = null
  const given = [issuer, clientId, clientSecret].filter((value) => value !== null).length
  if (given > 0 && given < 3) {
    const missing = [
      ['KEYCLOAK_ISSUER', issuer],
      ['KEYCLOAK_CLIENT_ID', clientId],
      ['KEYCLOAK_CLIENT_SECRET', clientSecret],
    ]
      .filter(([, value]) => value === null)
      .map(([name]) => name)
    throw new Error(`KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET must be set together; missing: ${missing.join(', ')}`)
  }
  if (issuer !== null && clientId !== null && clientSecret !== null) {
    const parsed = parseUrl('KEYCLOAK_ISSUER', issuer)
    const allowHttp = isLoopback(parsed.hostname) || flag(env, 'KEYCLOAK_ALLOW_HTTP')
    if (parsed.protocol === 'http:' && !allowHttp) {
      throw new Error('KEYCLOAK_ISSUER uses http: on a non-loopback host; use https: or set KEYCLOAK_ALLOW_HTTP=true')
    }
    if (publicUrl === null) throw new Error('PUBLIC_URL is required when Keycloak is configured')
    const brokerApi = text(env, 'KEYCLOAK_BROKER_API') ?? 'v1'
    if (brokerApi !== 'v1' && brokerApi !== 'v2') throw new Error('KEYCLOAK_BROKER_API must be "v1" or "v2"')
    keycloak = {
      issuer: issuer.replace(/\/+$/, ''),
      clientId,
      clientSecret,
      githubIdpAlias: text(env, 'KEYCLOAK_GITHUB_IDP'),
      brokerApi,
      allowHttp,
    }
  }

  return {
    host,
    port,
    databaseUrl,
    publicUrl,
    trustProxy,
    secureCookies: publicUrl?.startsWith('https://') ?? false,
    keycloak,
  }
}
