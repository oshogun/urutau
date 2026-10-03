import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { closeApp, createApp, purgeExpired, serverSecrets } from './app.ts'
import { loadConfig } from './config.ts'
import { createEventHub } from './events/publisher.ts'
import { GrantStore } from './oidc/grants.ts'
import { openDatabase } from './db/index.ts'
import { acceptedHostnames, startupWarning } from './http/hostGuard.ts'
import { createLogger } from './log.ts'
import { defaultDistDir, registerStatic } from './static.ts'

const HOUR_MS = 60 * 60 * 1000
const SHUTDOWN_WAIT_MS = 5000

export interface StartOptions {
  env: Record<string, string | undefined>
  /** Replaces globalThis.fetch for every outbound request (GitHub, Keycloak). */
  fetch?: typeof fetch
  /** Replaces the configured PORT; 0 picks a free port (tests). */
  port?: number
  /** Serve dist/ (default true). */
  serveStatic?: boolean
  /** Where log lines go (default stdout). */
  write?: (line: string) => void
}

export interface RunningServer {
  readonly host: string
  readonly port: number
  /** Stops timers, event streams, the MCP handler, the HTTP server and the database; never exits the process. */
  stop(): Promise<void>
}

/** Reads the configuration, opens and migrates the database and listens. Throws the configuration error when the environment is invalid. */
export async function start(options: StartOptions): Promise<RunningServer> {
  const loaded = loadConfig(options.env)
  const config = options.port === undefined ? loaded : { ...loaded, port: options.port }
  const log = createLogger({ secrets: serverSecrets(config), patterns: true, write: options.write })

  const database = await openDatabase(config.databaseUrl)
  await database.migrate()

  const hub = createEventHub()
  const grants = new GrantStore()
  const app = createApp({
    config,
    database,
    log,
    now: () => new Date(),
    fetch: options.fetch ?? globalThis.fetch,
    eventHub: hub,
    grants,
  })
  if (options.serveStatic !== false) registerStatic(app, defaultDistDir())

  const purge = async () => {
    try {
      await purgeExpired(database, new Date(), grants)
    } catch (error) {
      log.warn('purging expired rows failed', { name: error instanceof Error ? error.name : 'Error' })
    }
  }
  await purge()
  const timer = setInterval(purge, HOUR_MS)

  // No createServer option is passed, so this is a plain HTTP/1 server.
  let server: Server
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listening = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(listening as Server)) as Server
      listening.once('error', reject)
    })
  } catch (error) {
    clearInterval(timer)
    await closeApp(app)
    await database.close()
    throw error
  }
  const address = server.address() as AddressInfo
  log.info('listening', { host: address.address, port: address.port })
  log.info('answering for localhost, IP addresses and', { hostnames: acceptedHostnames(config).join(', ') || 'no other hostname' })
  const warning = startupWarning(config)
  if (warning) log.warn(warning)
  if (config.tokenEncryptionKey === null) {
    log.warn('TOKEN_ENCRYPTION_KEY is not set: agent integrations cannot store a GitHub token.')
  }

  let stopping: Promise<void> | null = null
  const stop = () => {
    stopping ??= (async () => {
      clearInterval(timer)
      hub.closeAll()
      await closeApp(app)
      const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_WAIT_MS)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections()
      })
      clearTimeout(force)
      await database.close()
    })()
    return stopping
  }
  return { host: address.address, port: address.port, stop }
}

async function main(): Promise<void> {
  const log = createLogger({ patterns: true })
  process.on('unhandledRejection', (error) => {
    log.error('unhandled rejection', { name: error instanceof Error ? error.name : 'Error' })
  })
  let running: RunningServer
  try {
    running = await start({ env: process.env })
  } catch (error) {
    console.error(`urutau: ${error instanceof Error ? error.message : 'startup failed'}`)
    process.exit(1)
  }
  const shutdown = () => void running.stop().finally(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (import.meta.main) {
  void main()
}
