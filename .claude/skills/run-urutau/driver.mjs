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
import { FIXTURE_GITHUB_TOKEN, routeGitHubFixtures } from './fixtures.mjs'

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
  // Method and URL only; a POST body (issue title and text) is never logged.
  if (!request.url().startsWith('https://api.github.com/')) return
  if (request.method() === 'OPTIONS') return
  github.requests += 1
  logs.push(`[github] ${request.method()} ${request.url()}`)
})
page.on('response', (response) => {
  const remaining = response.headers()['x-ratelimit-remaining']
  if (response.url().startsWith('https://api.github.com/') && remaining !== undefined) {
    github.rateLimitRemaining = Number(remaining)
  }
})

let mcpId = 0

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

async function openUserContext(startPath) {
  const extra = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: process.env.COLOR_SCHEME === 'dark' ? 'dark' : 'light',
  })
  if (MODE === 'fixtures') await routeGitHubFixtures(extra)
  const extraPage = await extra.newPage()
  const pageErrors = []
  extraPage.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      logs.push(`[user2 console.${message.type()}] ${message.text()}`)
    }
  })
  extraPage.on('pageerror', (error) => {
    pageErrors.push(error.message)
    logs.push(`[user2 pageerror] ${error.message}`)
  })
  extraPage.on('requestfailed', (request) =>
    logs.push(`[user2 requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`),
  )
  await extraPage.goto(`${APP_URL}${startPath}`)
  return { context: extra, page: extraPage, pageErrors }
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
  /** The fake GitHub token to enter for an agent integration; it is not a real token. */
  fixtureGitHubToken: FIXTURE_GITHUB_TOKEN,

  /** Screenshot of the viewport (or `{ fullPage: true }`, `{ clip }`, ...); returns the file path. `{ page: other }` shoots another page of the context. */
  async shot(name, options = {}) {
    const { page: target = page, ...rest } = options
    const path = join(SHOTS, `${name}.png`)
    await target.screenshot({ path, ...rest })
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
   * `onDropped` is called right after the mouse is released.
   */
  async drag(issueNumber, bucketTitle, { steps = 20, onDropped } = {}) {
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
    onDropped?.()
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
   * `{ context, page, pageErrors }`; pass `page` as the last argument of
   * signIn(). Its console errors, page errors and failed requests go into the
   * running request's `logs` with a `[user2]` prefix, and page errors are also
   * collected in `pageErrors`. It is closed when the driver stops.
   */
  async newUserContext(startPath = '/') {
    return openUserContext(startPath)
  },

  /**
   * Creates a second account through an invite, the way a real user joins:
   * the signed-in admin (main page) creates an invite over the API, and a new
   * context opens its link and fills the account form. Returns the same value
   * as newUserContext(), signed in as the new user. The invite token is used
   * in this function only and is never returned or logged.
   */
  async inviteUser(username, password) {
    const token = await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json()
      const response = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Urutau-CSRF': session.session.csrfToken },
        body: '{}',
      })
      if (!response.ok) throw new Error(`Creating the invite failed with HTTP ${response.status}`)
      return (await response.json()).token
    })
    const user = await openUserContext(`/#invite=${encodeURIComponent(token)}`)
    await submitAuthForm(user.page, username, password, 'Create account')
    return user
  },

  /**
   * Live-update scenario. `other` is a page from inviteUser()/newUserContext(),
   * signed in and showing the same repository as the main page (`openBoard`
   * both). The main page drags `issueNumber` to `bucketTitle`; the time from
   * the mouse release until the card appears in that bucket in `other`, with no
   * reload, is returned in `elapsedMs`. Throws if it takes over `limitMs` or if
   * `other` logged a page error.
   */
  async liveMove(issueNumber, bucketTitle, other, { limitMs = 2000 } = {}) {
    let watcher
    await helpers.drag(issueNumber, bucketTitle, {
      onDropped: () => {
        const started = Date.now()
        watcher = other.page
          .waitForFunction(
            ([issue, title]) => {
              for (const section of document.querySelectorAll('.board:not(.board--loading) .bucket')) {
                if (section.querySelector('.bucket__title')?.textContent !== title) continue
                return [...section.querySelectorAll('.issue-card__number')].some((el) =>
                  new RegExp(`^#${issue}\\b`).test(el.textContent ?? ''),
                )
              }
              return false
            },
            [issueNumber, bucketTitle],
            { timeout: limitMs + 3000, polling: 'raf' },
          )
          .then(() => Date.now() - started)
      },
    })
    const elapsedMs = await watcher
    if (other.pageErrors.length > 0) throw new Error(`Second context page errors: ${other.pageErrors.join(' | ')}`)
    if (elapsedMs > limitMs) throw new Error(`Live update took ${elapsedMs} ms, limit ${limitMs} ms`)
    return { elapsedMs }
  },

  /**
   * Sends one JSON-RPC request to the MCP endpoint (`<appUrl>/mcp`) through Playwright's
   * request context, so the bearer token never appears on a command line. Returns the parsed
   * answer: the `data:` line of an event-stream answer, or the JSON body. `params` may be omitted.
   * Keep `token` in a variable inside the script; do not return or log it.
   */
  async mcp(method, params, token) {
    let response
    try {
      response = await context.request.post(`${APP_URL}/mcp`, {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        data: { jsonrpc: '2.0', id: ++mcpId, method, ...(params === undefined ? {} : { params }) },
      })
    } catch (error) {
      // Playwright's error message ends with a call log that lists every request header,
      // including the bearer token and the session cookie. Keep only the first line.
      const firstLine = String(error?.message ?? error).split('\n')[0]
      throw new Error(`mcp request failed: ${token ? firstLine.split(token).join('<token>') : firstLine}`)
    }
    const text = await response.text()
    const data = text.split('\n').find((line) => line.startsWith('data:'))
    const body = data === undefined ? text : data.slice('data:'.length).trim()
    try {
      return { status: response.status(), ...JSON.parse(body) }
    } catch {
      return { status: response.status(), raw: body.slice(0, 300) }
    }
  },

  /**
   * Server mode with the launcher, signed in as the admin on the main page. Creates an agent
   * integration, gives it the fake GitHub token and `repos` (owner/name list), and creates one
   * MCP bearer token. The token stays inside the returned object's closure: the object has
   * `username`, `repos` and the function `tool(name, args)`, which calls an MCP tool and returns
   * `{ status, ...answer }` (`result.structuredContent` holds a tool's JSON). Returning the
   * object from a script is safe, because functions do not serialize and the token is not a field.
   */
  async createAgent(username, repos) {
    const made = await page.evaluate(
      async ({ username: name, repos: list, githubToken }) => {
        const session = await (await fetch('/api/session')).json()
        const send = async (path, method, body) => {
          const response = await fetch(`/api/${path}`, {
            method,
            headers: { 'content-type': 'application/json', 'X-Urutau-CSRF': session.session.csrfToken },
            body: JSON.stringify(body),
          })
          if (!response.ok) throw new Error(`${method} ${path.replace(/[0-9a-f-]{20,}/g, ':id')} failed with HTTP ${response.status}`)
          return response.json()
        }
        const { integration } = await send('integrations', 'POST', { username: name })
        await send(`integrations/${integration.id}/github-token`, 'PUT', { token: githubToken })
        await send(`integrations/${integration.id}/repos`, 'PUT', { repos: list })
        const created = await send(`integrations/${integration.id}/tokens`, 'POST', { label: 'driver', expiresInDays: 30 })
        return created.secret
      },
      { username, repos, githubToken: FIXTURE_GITHUB_TOKEN },
    )
    const token = made
    return {
      username,
      repos,
      async tool(name, args) {
        return helpers.mcp('tools/call', { name, arguments: args }, token)
      },
    }
  },

  /**
   * Seeds agent runs with `record_run` through an agent from createAgent(). The repository needs
   * an Urutau board first (`openBoard(repo)`), or `running` and the waiting statuses answer
   * `no-board`. Issue 14 gets a `running` run (a claim with a lease). Issue 12 gets an
   * `awaiting_approval` run (a claim with no lease, and so a `waitingOnHuman` entry) with one
   * unverified item of each kind. The default issues exist on `acme/widgets`; `issues` overrides
   * `{ running, waiting }`. Returns what `get_board` then shows for the seeded cards.
   */
  async seedAgentRuns(agent, repo, issues = {}) {
    const running = issues.running ?? 14
    const waiting = issues.waiting ?? 12
    const calls = [
      { repo, issue: running, runId: 'seed-running', status: 'running', triageRange: 'S-M', observedBy: 'carcara/0.9.1' },
      {
        repo,
        issue: waiting,
        runId: 'seed-waiting',
        status: 'awaiting_approval',
        triageRange: 'M',
        uncertaintyKind: 'external',
        unverified: [
          { id: 'U1', kind: 'external', text: 'The upstream API keeps the field name.' },
          { id: 'U2', kind: 'normative', text: 'The retention period needs a decision.' },
          { id: 'U3', kind: 'untested', text: 'The migration was not run on MariaDB.' },
        ],
      },
    ]
    for (const args of calls) {
      const answer = await agent.tool('record_run', args)
      if (answer.status !== 200 || answer.result?.isError) {
        throw new Error(`record_run ${args.runId} failed: ${answer.result?.content?.[0]?.text ?? answer.raw ?? answer.status}`)
      }
    }
    const board = await agent.tool('get_board', { repo })
    const json = JSON.parse(board.result.content[0].text)
    return {
      humanWaitLimit: json.humanWaitLimit,
      waitingOnHuman: json.waitingOnHuman,
      cards: json.buckets
        .flatMap((bucket) => bucket.cards)
        .filter((card) => card.claim !== null || card.lastRun !== null)
        .map(({ number, claim, lastRun }) => ({ number, claim, lastRun })),
    }
  },

  /** Clears the main page's localStorage (theme and any v1 data) and reloads. Boards live on the server, so this does not delete them or sign out. */
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
