import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { createApp, purgeExpired, serverSecrets } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db/index.ts'
import { acceptedHostnames, startupWarning } from './http/hostGuard.ts'
import { createLogger } from './log.ts'
import { defaultDistDir, registerStatic } from './static.ts'

const HOUR_MS = 60 * 60 * 1000
const SHUTDOWN_WAIT_MS = 5000

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig(process.env)
  } catch (error) {
    console.error(`urutau: ${error instanceof Error ? error.message : 'invalid configuration'}`)
    process.exit(1)
  }
  const log = createLogger({ secrets: serverSecrets(config) })

  const database = await openDatabase(config.databaseUrl)
  await database.migrate()

  const app = createApp({
    config,
    database,
    log,
    now: () => new Date(),
    fetch: globalThis.fetch,
    boardEvents: { publish: () => {} },
  })
  registerStatic(app, defaultDistDir())

  const purge = async () => {
    try {
      await purgeExpired(database, new Date())
    } catch (error) {
      log.warn('purging expired rows failed', { name: error instanceof Error ? error.name : 'Error' })
    }
  }
  await purge()
  const timer = setInterval(purge, HOUR_MS)

  // No createServer option is passed, so this is a plain HTTP/1 server.
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info('listening', { host: info.address, port: info.port })
    log.info('answering for localhost, IP addresses and', { hostnames: acceptedHostnames(config).join(', ') || 'no other hostname' })
    const warning = startupWarning(config)
    if (warning) log.warn(warning)
  }) as Server

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_WAIT_MS)
    server.close(() => {
      clearTimeout(force)
      database.close().finally(() => process.exit(0))
    })
    server.closeIdleConnections()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error: unknown) => {
  console.error(`urutau: ${error instanceof Error ? error.message : 'startup failed'}`)
  process.exit(1)
})
