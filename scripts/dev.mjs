// Development: runs the API server (restarted on change) and Vite together.
// PORT (default 8787) is the API port; Vite proxies /api to it through
// URUTAU_API_PORT. Arguments after `--` go to Vite. Either process exiting, or
// SIGINT/SIGTERM, stops both.
import { spawn } from 'node:child_process'

const port = process.env.PORT ?? '8787'

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
