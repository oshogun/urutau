import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('uses the defaults', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 8787,
      databaseUrl: 'sqlite:data/urutau.db',
      publicUrl: null,
      trustProxy: false,
      secureCookies: false,
      keycloak: null,
    })
  })

  it('names the variable, not its value, for a bad setting', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT')
    expect(() => loadConfig({ PORT: '70000' })).toThrow('PORT')
    expect(() => loadConfig({ TRUST_PROXY: 'yes-please' })).toThrow('TRUST_PROXY')
    expect(() => loadConfig({ PUBLIC_URL: 'not a url' })).toThrow('PUBLIC_URL')
    try {
      loadConfig({ TRUST_PROXY: 'yes-please' })
    } catch (error) {
      expect((error as Error).message).not.toContain('yes-please')
    }
  })

  it('normalises PUBLIC_URL and derives secure cookies from https', () => {
    const config = loadConfig({ PUBLIC_URL: 'https://boards.example.com/urutau/' })
    expect(config.publicUrl).toBe('https://boards.example.com/urutau')
    expect(config.secureCookies).toBe(true)
  })

  const keycloak = {
    KEYCLOAK_ISSUER: 'https://sso.example.com/realms/urutau',
    KEYCLOAK_CLIENT_ID: 'urutau',
    KEYCLOAK_CLIENT_SECRET: 'top-secret',
    PUBLIC_URL: 'https://boards.example.com',
  }

  it('reads a complete Keycloak setting', () => {
    expect(loadConfig(keycloak).keycloak).toEqual({
      issuer: 'https://sso.example.com/realms/urutau',
      clientId: 'urutau',
      clientSecret: 'top-secret',
      githubIdpAlias: null,
      brokerApi: 'v1',
      allowHttp: false,
    })
  })

  it('requires all three Keycloak variables, PUBLIC_URL, and a valid broker API', () => {
    const { KEYCLOAK_CLIENT_SECRET: _omit, ...partial } = keycloak
    expect(() => loadConfig(partial)).toThrow('KEYCLOAK_CLIENT_SECRET')
    const { PUBLIC_URL: _omitUrl, ...noPublic } = keycloak
    expect(() => loadConfig(noPublic)).toThrow('PUBLIC_URL')
    expect(() => loadConfig({ ...keycloak, KEYCLOAK_BROKER_API: 'v3' })).toThrow('KEYCLOAK_BROKER_API')
  })

  it('refuses an http issuer on a non-loopback host unless allowed', () => {
    const http = { ...keycloak, KEYCLOAK_ISSUER: 'http://sso.internal/realms/urutau' }
    expect(() => loadConfig(http)).toThrow('KEYCLOAK_ISSUER')
    expect(loadConfig({ ...http, KEYCLOAK_ALLOW_HTTP: 'true' }).keycloak?.allowHttp).toBe(true)
    expect(loadConfig({ ...keycloak, KEYCLOAK_ISSUER: 'http://localhost:8080/realms/urutau' }).keycloak?.allowHttp).toBe(true)
  })
})
