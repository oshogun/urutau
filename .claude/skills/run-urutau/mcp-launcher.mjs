// Starts the Urutau API server for driver runs that need agent integrations: an in-memory
// database, a development encryption key, and a fetch that answers GitHub from the fixtures,
// so the server's reads for integrations never leave the machine.
//
//   PORT=8788 node .claude/skills/run-urutau/mcp-launcher.mjs
//   URUTAU_LAUNCHER_NO_KEY=1 PORT=8788 node .claude/skills/run-urutau/mcp-launcher.mjs   # no key
//
// Run it from the repository root (Node 24). It reads no real token or key. Every outbound
// request is written to stdout as `fixture-github <METHOD> <path><query> auth=<present|absent>`;
// header values are never written.
import { start } from '../../../server/main.ts'
import { fixtureFetch } from './fixtures.mjs'

// A development value that protects nothing: Buffer.alloc(32, 0x75), base64.
const DEVELOPMENT_KEY = Buffer.alloc(32, 0x75).toString('base64')

const env = { ...process.env, DATABASE_URL: 'sqlite::memory:', HOST: '127.0.0.1' }
if (process.env.URUTAU_LAUNCHER_NO_KEY === '1') {
  delete env.TOKEN_ENCRYPTION_KEY
} else {
  env.TOKEN_ENCRYPTION_KEY = DEVELOPMENT_KEY
}

async function loggingFetch(input, init) {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const auth = request.headers.get('authorization') ? 'present' : 'absent'
  console.log(`fixture-github ${request.method} ${url.pathname}${url.search} auth=${auth}`)
  // fixtureFetch rejects any URL that is not on api.github.com (Keycloak is not configured here).
  return fixtureFetch(request)
}

const running = await start({ env, fetch: loggingFetch, serveStatic: false })
const shutdown = () => void running.stop().finally(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
