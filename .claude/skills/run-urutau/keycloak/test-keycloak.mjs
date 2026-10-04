// `npm run test:keycloak`: runs the opt-in Keycloak suite when Keycloak is
// reachable at URUTAU_TEST_KEYCLOAK_URL (default: port URUTAU_KEYCLOAK_PORT or
// 58080); otherwise prints why it skipped and exits 0. Extra arguments go to
// vitest. The suite files belong to the OIDC tasks and are listed in SUITES.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const url = process.env.URUTAU_TEST_KEYCLOAK_URL ?? `http://127.0.0.1:${process.env.URUTAU_KEYCLOAK_PORT ?? 58080}`
const SUITES = ['server/oidc', 'server/routes/oidc.test.ts', 'server/routes/github.test.ts']

try {
  const response = await fetch(`${url}/realms/urutau/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
} catch (error) {
  console.log(`test:keycloak skipped: Keycloak is not reachable at ${url} (${error.message}). Start it with: docker compose -p urutau-test-keycloak -f compose.keycloak.yaml up -d --wait. In a run clone use URUTAU_KEYCLOAK_PORT=58081 and -p urutau-test-keycloak-clone`)
  process.exit(0)
}
const present = SUITES.filter((path) => existsSync(path))
if (present.length === 0) {
  console.log('test:keycloak skipped: Keycloak is up, but none of the suite files exist yet')
  process.exit(0)
}
const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'server', ...present, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, URUTAU_TEST_KEYCLOAK_URL: url },
})
process.exit(run.status ?? 1)
