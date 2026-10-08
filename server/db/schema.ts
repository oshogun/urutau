import type { RunStatus, TriageRange, UncertaintyKind } from '../../src/domain/types.ts'

/**
 * Column types as the application sees them on every backend: ids are UUID
 * strings, timestamps are ISO 8601 UTC strings from Date.prototype.toISOString(),
 * booleans are 0 or 1, JSON is text.
 */
export interface MetaTable {
  key: string // VARCHAR(64) PK; rows: 'instance_id', and 'github_writes' ('1' when the admin has turned on GitHub writes, '0' otherwise)
  value: string // VARCHAR(255)
}

export interface UsersTable {
  id: string // VARCHAR(36) PK, crypto.randomUUID()
  username: string // VARCHAR(64) as entered or derived
  username_key: string // VARCHAR(64) UNIQUE, username.toLowerCase()
  display_name: string | null // VARCHAR(128)
  password_hash: string | null // VARCHAR(60) bcrypt; null for Keycloak accounts
  is_admin: number // INTEGER 0 | 1
  created_at: string // VARCHAR(24)
}

export interface InstanceClaimTable {
  id: number // INTEGER PK, always 1
  user_id: string // VARCHAR(36), no foreign key on purpose: deleting users never re-opens first-run
  claimed_at: string // VARCHAR(24)
}

export interface SessionsTable {
  id_hash: string // VARCHAR(64) PK, hex SHA-256 of the cookie value
  user_id: string // VARCHAR(36) FK users.id ON DELETE CASCADE, indexed
  auth_method: 'local' | 'keycloak' // VARCHAR(16)
  csrf_token: string // VARCHAR(64), base64url of 32 random bytes
  created_at: string
  last_seen_at: string
  expires_at: string // indexed
}

export interface InvitesTable {
  id: string // VARCHAR(36) PK
  token_hash: string // VARCHAR(64) UNIQUE, hex SHA-256 of the token
  created_by: string | null // VARCHAR(36) FK users.id ON DELETE SET NULL
  created_at: string
  expires_at: string
  used_at: string | null
  used_by: string | null // VARCHAR(36) FK users.id ON DELETE SET NULL
}

export interface IdentitiesTable {
  issuer: string // VARCHAR(255), PK part 1: the Keycloak issuer URL
  subject: string // VARCHAR(255), PK part 2: the `sub` claim
  user_id: string // VARCHAR(36) FK users.id ON DELETE CASCADE, indexed
  created_at: string
}

export interface BoardsTable {
  repo_key: string // VARCHAR(200) PK, lower case owner/name
  full_name: string // VARCHAR(200)
  config: string // TEXT (MEDIUMTEXT on MariaDB): JSON.stringify(BoardConfig)
  version: number // INTEGER, 1 on create, +1 per save
  created_at: string
  updated_at: string
  updated_by: string | null // VARCHAR(36) FK users.id ON DELETE SET NULL
}

export interface IntegrationsTable {
  user_id: string // VARCHAR(36) PK, FK users.id ON DELETE CASCADE
  created_by: string | null // VARCHAR(36) FK users.id ON DELETE SET NULL
  created_at: string // VARCHAR(24)
}

export interface ApiTokensTable {
  id: string // VARCHAR(36) PK
  user_id: string // VARCHAR(36) FK integrations.user_id ON DELETE CASCADE, indexed
  token_hash: string // VARCHAR(64) UNIQUE, hex SHA-256 of the whole token
  label: string // VARCHAR(64)
  created_by: string | null // VARCHAR(36) FK users.id ON DELETE SET NULL
  created_at: string // VARCHAR(24)
  expires_at: string | null // VARCHAR(24), indexed; null never expires
  last_used_at: string | null // VARCHAR(24)
}

export type GithubTokenRowStatus = 'unchecked' | 'ok' | 'rejected'

export interface GithubTokensTable {
  user_id: string // VARCHAR(36) PK, FK users.id ON DELETE CASCADE
  sealed: string // VARCHAR(1024): v1.<kid>.<iv>.<ct>.<tag>
  key_id: string // VARCHAR(16)
  status: GithubTokenRowStatus // VARCHAR(16)
  set_by: string | null // VARCHAR(36) FK users.id ON DELETE SET NULL
  updated_at: string // VARCHAR(24)
}

export interface IntegrationReposTable {
  user_id: string // VARCHAR(36) FK integrations.user_id ON DELETE CASCADE; PK part 1
  repo_key: string // VARCHAR(200) lower-case owner/name; PK part 2
}

export interface CardRunsTable {
  run_id: string // VARCHAR(64) PK; also UNIQUE (repo_key, issue, run_id)
  repo_key: string // VARCHAR(200) lower-case owner/name
  issue: number // INTEGER
  agent_user_id: string // VARCHAR(36), no foreign key: runs never change when an integration is removed
  status: RunStatus // VARCHAR(24)
  status_at: string // VARCHAR(24): when status last changed value
  triage_range: TriageRange | null // VARCHAR(8)
  uncertainty_kind: UncertaintyKind | null // VARCHAR(16)
  unverified: string // TEXT (MEDIUMTEXT on MariaDB): JSON UnverifiedItem[] (withdrawnAt on withdrawn items)
  merge_shas: string // TEXT: JSON string[]
  files: string // TEXT (MEDIUMTEXT on MariaDB): JSON string[]
  files_omitted: number // INTEGER, 0 when not given: paths the agent left out of files
  areas: string // TEXT: JSON string[]
  observed_by: string | null // VARCHAR(64)
  fix_rounds: number // INTEGER, 0 when not given
  cost_usd: number | null // DOUBLE PRECISION
  findings: string | null // TEXT, plain text up to 1000 code points
  started_at: string // VARCHAR(24)
  ended_at: string | null // VARCHAR(24), set with a terminal status
}

export interface CardClaimsTable {
  repo_key: string // VARCHAR(200), PK part 1
  issue: number // INTEGER, PK part 2
  run_id: string // VARCHAR(64) FK card_runs.run_id
  holder: string // VARCHAR(36) FK users.id ON DELETE CASCADE, indexed
  lease_until: string | null // VARCHAR(24); null while waiting on a human
  claimed_at: string // VARCHAR(24)
}

export interface RunEventsTable {
  id: string // VARCHAR(36) PK, crypto.randomUUID()
  run_id: string // VARCHAR(64) FK card_runs.run_id; UNIQUE (run_id, resolves)
  kind: 'probe' | 'accepted' // VARCHAR(16); the run store refuses any other kind
  resolves: string | null // VARCHAR(32): the item id it closes
  surfaced_at: string // VARCHAR(24); equals at in phase 1
  detail: string // TEXT: JSON, probe {note}, accepted {note}
  by: string // VARCHAR(36) users.id, no foreign key
  at: string // VARCHAR(24)
}

export interface Tables {
  meta: MetaTable
  users: UsersTable
  instance_claim: InstanceClaimTable
  sessions: SessionsTable
  invites: InvitesTable
  identities: IdentitiesTable
  boards: BoardsTable
  integrations: IntegrationsTable
  api_tokens: ApiTokensTable
  github_tokens: GithubTokensTable
  integration_repos: IntegrationReposTable
  card_runs: CardRunsTable
  card_claims: CardClaimsTable
  run_events: RunEventsTable
}
