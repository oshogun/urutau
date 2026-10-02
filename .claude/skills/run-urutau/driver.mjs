// Agent harness for Urutau: one persistent headless Chromium session that you
// drive by POSTing JavaScript to a local port. Each request body runs as an
// async function with the helpers below in scope (plus Playwright's `page`).
//
//   node .claude/skills/run-urutau/driver.mjs                    # fixture GitHub data
//   URUTAU_GITHUB=live node .claude/skills/run-urutau/driver.mjs # real api.github.com
//
//   curl -s http://127.0.0.1:9333 --data-binary @- <<'EOF'
//   await openBoard('acme/widgets')
//   return { buckets: await buckets(), shot: await shot('board') }
//   EOF
//
// Environment: APP_URL (default http://127.0.0.1:5173), DRIVER_PORT (9333),
// URUTAU_GITHUB (fixtures | live), COLOR_SCHEME (light | dark), SCREENSHOT_DIR.
// Server mode needs no setting: the app is the same, the API server runs beside it
// (see SKILL.md § Server mode).
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { routeGitHubFixtures } from './fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_URL = (process.env.APP_URL ?? 'http://127.0.0.1:5173').replace(/\/+$/, '')
const PORT = Number(process.env.DRIVER_PORT ?? 9333)
const MODE = process.env.URUTAU_GITHUB === 'live' ? 'live' : 'fixtures'
const SHOTS = process.env.SCREENSHOT_DIR ?? join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

// We close the browser ourselves on SIGINT/SIGTERM (see shutdown below).
const browser = await chromium.launch({
  args: ['--no-sandbox'],
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: process.env.COLOR_SCHEME === 'dark' ? 'dark' : 'light',
})
if (MODE === 'fixtures') await routeGitHubFixtures(context)
const page = await context.newPage()

// What happened in the page while a request ran: errors, failed and API requests.
let logs = []
const github = { requests: 0, rateLimitRemaining: null }
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    logs.push(`[console.${message.type()}] ${message.text()}`)
  }
})
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`))
page.on('requestfailed', (request) =>
  logs.push(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`),
)
page.on('request', (request) => {
  if (!request.url().startsWith('https://api.github.com/') || request.method() !== 'GET') return
  github.requests += 1
  logs.push(`[github] GET ${request.url()}`)
})
page.on('response', (response) => {
  const remaining = response.headers()['x-ratelimit-remaining']
  if (response.url().startsWith('https://api.github.com/') && remaining !== undefined) {
    github.rateLimitRemaining = Number(remaining)
  }
})

const cardFor = (issueNumber) =>
  page.locator('.bucket__card').filter({
    has: page.locator('.issue-card__number', { hasText: new RegExp(`^#${issueNumber}\\b`) }),
  })

const bucketList = (title) =>
  page
    .locator('.bucket')
    .filter({ has: page.locator('.bucket__title', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }) })
    .locator('.bucket__cards')

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function submitAuthForm(target, username, password, buttonName) {
  if (target.url() === 'about:blank') await target.goto(`${APP_URL}/`)
  const usernameField = target.getByLabel('Username', { exact: true })
  await usernameField.waitFor({ timeout: 30_000 })
  await usernameField.fill(username)
  await target.getByLabel('Password', { exact: true }).fill(password)
  await target.getByRole('button', { name: buttonName, exact: true }).click()
  // Success removes the form. A rejected submit leaves it in place with an alert.
  try {
    await usernameField.waitFor({ state: 'detached', timeout: 15_000 })
  } catch {
    const alerts = await target.locator('.auth__form [role="alert"]').allInnerTexts()
    throw new Error(`${buttonName} did not leave the form: ${alerts.join(' ').trim() || 'no message'}`)
  }
  return { ok: true }
}

const helpers = {
  page,
  context,
  browser,
  mode: MODE,
  appUrl: APP_URL,

  /** Screenshot of the viewport (or `{ fullPage: true }`, `{ clip }`, ...); returns the file path. */
  async shot(name, options = {}) {
    const path = join(SHOTS, `${name}.png`)
    await page.screenshot({ path, ...options })
    return path
  },

  /** Navigates to a path of the app, e.g. `goto('/')`. */
  async goto(path = '/') {
    await page.goto(`${APP_URL}${path}`)
  },

  /** Opens a repository's board and waits for it, or for its error message, to render. */
  async openBoard(repo) {
    await page.goto(`${APP_URL}/?repo=${repo}`)
    // The loading skeleton reuses the `.bucket` markup, so wait for the real header instead.
    await page.locator('.board-header__name, .board-message').first().waitFor({ timeout: 45_000 })
  },

  /** Each bucket's title, header count and issue numbers in display order. */
  async buckets() {
    return page.$$eval('.board:not(.board--loading) .bucket', (sections) =>
      sections.map((section) => ({
        title: section.querySelector('.bucket__title')?.textContent ?? '',
        count: section.querySelector('.bucket__header .cds--tag')?.textContent ?? '',
        issues: [...section.querySelectorAll('.issue-card__number')].map((element) =>
          Number(/#(\d+)/.exec(element.textContent ?? '')?.[1]),
        ),
      })),
    )
  },

  /**
   * Drags an issue card into a bucket (near the top of it) with real mouse
   * events. dnd-kit only starts after 6px of movement and tracks the pointer
   * across several moves, so the drag is sent in `steps` small moves.
   */
  async drag(issueNumber, bucketTitle, { steps = 20 } = {}) {
    // Buckets scroll on their own; a card further down has a bounding box
    // outside the viewport, and pressing there grabs nothing.
    await cardFor(issueNumber).scrollIntoViewIfNeeded()
    const from = await cardFor(issueNumber).boundingBox()
    const to = await bucketList(bucketTitle).boundingBox()
    if (!from) throw new Error(`No card for issue #${issueNumber} on screen`)
    if (!to) throw new Error(`No bucket titled "${bucketTitle}" on screen`)
    const start = { x: from.x + from.width / 2, y: from.y + 12 }
    const end = { x: to.x + to.width / 2, y: to.y + Math.min(40, to.height / 2) }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    for (let step = 1; step <= steps; step++) {
      await page.mouse.move(
        start.x + ((end.x - start.x) * step) / steps,
        start.y + ((end.y - start.y) * step) / steps,
      )
      await page.waitForTimeout(16)
    }
    await page.waitForTimeout(150)
    await page.mouse.up()
    await page.waitForTimeout(300)
    return helpers.buckets()
  },

  /**
   * Keyboard drag from the card's handle: Space lifts, `keys` move it
   * (e.g. ['ArrowRight']), Space drops.
   */
  async keyboardMove(issueNumber, keys) {
    await page.getByRole('button', { name: `Move issue #${issueNumber}`, exact: true }).focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(250)
    for (const key of keys) {
      await page.keyboard.press(key)
      await page.waitForTimeout(300)
    }
    await page.keyboard.press('Space')
    await page.waitForTimeout(300)
    return helpers.buckets()
  },

  /**
   * Server mode. On a first run (empty database) the app shows the admin form:
   * fills it and waits until the app leaves the form. `target` is a page from
   * newUserContext(); the default is the main page.
   */
  async createAdmin(username, password, target = page) {
    return submitAuthForm(target, username, password, 'Create account')
  },

  /** Server mode: signs in with an existing account through the sign-in form. */
  async signIn(username, password, target = page) {
    return submitAuthForm(target, username, password, 'Sign in')
  },

  /**
   * A second, isolated browser context (own cookies and localStorage) for
   * two-user scenarios. GitHub fixtures are routed in it too. Returns
   * `{ context, page }`; pass `page` as the last argument of signIn(). It is
   * closed when the driver stops.
   */
  async newUserContext() {
    const extra = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: process.env.COLOR_SCHEME === 'dark' ? 'dark' : 'light',
    })
    if (MODE === 'fixtures') await routeGitHubFixtures(extra)
    const extraPage = await extra.newPage()
    await extraPage.goto(`${APP_URL}/`)
    return { context: extra, page: extraPage }
  },

  /** Forgets saved boards, token, theme and recent repositories, then reloads. */
  async resetStorage() {
    await page.evaluate(() => localStorage.clear())
    await page.reload()
  },
}

const AsyncFunction = (async () => {}).constructor

function reply(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}

// Request bodies run as code in this Node process, so only local tools such as curl
// may talk to the driver. Browsers add Origin / Sec-Fetch-* headers (even to `no-cors`
// requests from any open tab), and a DNS-rebinding page arrives with a foreign Host.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

function fromBrowserOrForeignHost(request) {
  const { headers } = request
  return (
    headers.origin !== undefined ||
    headers['sec-fetch-site'] !== undefined ||
    headers['sec-fetch-mode'] !== undefined ||
    !ALLOWED_HOSTS.has(headers.host ?? '')
  )
}

const server = createServer(async (request, response) => {
  if (fromBrowserOrForeignHost(request)) {
    return reply(response, 403, { ok: false, error: 'Only local non-browser clients (e.g. curl) may use the driver' })
  }
  if (request.url === '/health') {
    return reply(response, 200, { ok: true, mode: MODE, appUrl: APP_URL, url: page.url() })
  }
  if (request.url === '/quit') {
    reply(response, 200, { ok: true, quitting: true })
    return shutdown()
  }
  if (request.method !== 'POST') {
    return reply(response, 405, { ok: false, error: 'POST a JavaScript function body to /' })
  }

  let body = ''
  for await (const chunk of request) body += chunk
  logs = []
  const requestsBefore = github.requests
  try {
    const run = new AsyncFunction(...Object.keys(helpers), body)
    const result = await run(...Object.values(helpers))
    reply(response, 200, {
      ok: true,
      result,
      githubRequests: github.requests - requestsBefore,
      rateLimitRemaining: github.rateLimitRemaining,
      logs,
    })
  } catch (error) {
    reply(response, 500, { ok: false, error: error?.stack ?? String(error), logs })
  }
})

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  server.close()
  await browser.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`urutau driver ready on http://127.0.0.1:${PORT} (github: ${MODE}, app: ${APP_URL})`)
})
