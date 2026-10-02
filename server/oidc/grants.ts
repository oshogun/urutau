import type { GitHubAccessProblem } from '../../src/domain/api.ts'

/** What Keycloak's broker endpoint last said about this user's GitHub token. */
export type BrokerStatus = 'ok' | 'not-linked' | 'refused' | 'unknown'

export type GitHubTokenResult = { ok: true; token: string } | { ok: false; problem: GitHubAccessProblem | 'unavailable' }

/**
 * The Keycloak tokens of one signed-in session. Held in server memory only:
 * nothing in a grant is written to the database, logged, sent to the browser
 * or put in a URL or a cookie.
 */
export interface Grant {
  accessToken: string
  /** Milliseconds since the epoch. */
  accessExpiresAt: number
  refreshToken: string | null
  refreshExpiresAt: number | null
  idToken: string | null
  broker: BrokerStatus
  github: { token: string; fetchedAt: number } | null
  /** The refresh or broker call in flight; concurrent requests wait for it instead of starting another. */
  pending: Promise<GitHubTokenResult> | null
}

const MAX_GRANTS = 10_000

/** Grants by the hash of the session id they belong to. */
export class GrantStore {
  private readonly grants = new Map<string, Grant>()

  get(sessionIdHash: string): Grant | undefined {
    return this.grants.get(sessionIdHash)
  }

  /** Stores the grant, first dropping those whose refresh token has expired and, past 10,000 grants, the oldest. */
  set(sessionIdHash: string, grant: Grant, now: number): void {
    for (const [key, existing] of this.grants) {
      if (existing.refreshExpiresAt !== null && existing.refreshExpiresAt <= now) this.grants.delete(key)
    }
    this.grants.delete(sessionIdHash)
    this.grants.set(sessionIdHash, grant)
    while (this.grants.size > MAX_GRANTS) {
      const oldest = this.grants.keys().next()
      if (oldest.done) break
      this.grants.delete(oldest.value)
    }
  }

  delete(sessionIdHash: string): void {
    this.grants.delete(sessionIdHash)
  }

  get size(): number {
    return this.grants.size
  }
}
