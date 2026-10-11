// Development: runs the API server (restarted on change) and Vite together.
// PORT (default 8787) is the API port; Vite proxies /api to it through
// URUTAU_API_PORT. Arguments after `--` go to Vite. Either process exiting, or
// SIGINT/SIGTERM, stops both.
//
// `node --watch` does not exit when the server fails to start: it waits for a
// file change. So the API port is checked first, on the host the server binds
// (HOST, default 127.0.0.1); if it is in use, neither process is started.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const port = process.env.PORT ?? '8787'
const host = process.env.HOST?.trim() || '127.0.0.1'

/** Resolves with the listen error code (e.g. EADDRINUSE), or null when the port could be bound. */
function tryListen(portNumber) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', (error) => resolve(error.code ?? 'error'))
    probe.listen({ host, port: portNumber, exclusive: true }, () => probe.close(() => resolve(null)))
  })
}

const portNumber = Number(port.trim())
// An invalid PORT is left to the server, which reports it.
if (/^\d+$/.test(port.trim()) && portNumber >= 1 && portNumber <= 65535) {
  const code = await tryListen(portNumber)
  if (code === 'EADDRINUSE') {
    console.error(`API port ${portNumber} on ${host} is already in use. Stop the process using it, or set PORT to another port.`)
    process.exit(1)
  }
}

const children = [
  spawn(process.execPath, ['--watch', 'server/main.ts'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: port },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, URUTAU_API_PORT: port },
  }),
]

let exiting = false
function stopAll(code) {
  if (exiting) return
  exiting = true
  for (const child of children) child.kill('SIGTERM')
  process.exitCode = code
}

for (const child of children) {
  child.on('exit', (code) => stopAll(code ?? 0))
  child.on('error', (error) => {
    console.error(error)
    stopAll(1)
  })
}
process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))
