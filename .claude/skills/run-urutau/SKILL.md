---
name: run-urutau
description: Build, run, test, and drive the Urutau kanban web app (Vite + React 19 + Carbon). Use when asked to start urutau or its dev server, run its tests, build it, take a screenshot of the board, drag issues between buckets, or check a UI change in a real browser.
---

Urutau is a React SPA, served with a small API server (`server/`) that holds accounts and boards,
that loads a GitHub repository's issues into a kanban board.
To drive it, start the dev server, then start `.claude/skills/run-urutau/driver.mjs`: one
persistent headless Chromium (Playwright) that runs the JavaScript you POST to
`http://127.0.0.1:9333`. By default the driver answers all GitHub API calls with fixture data,
so you need no network, token or rate-limit budget.

All paths are relative to the repository root.

## Prerequisites

Node 24 (`.nvmrc`). The shell may default to another Node. Every Bash call is a fresh shell, so
start each one that runs `node`/`npm`/`npx` with:

```bash
source ~/.nvm/nvm.sh && nvm use
```

On Ubuntu 24.04 no apt packages were needed: Playwright's Chromium launched as-is.

## Setup

```bash
source ~/.nvm/nvm.sh && nvm use
npm ci
npx playwright install chromium
```

npm 11 prints `install-scripts` warnings for the IBM Plex telemetry postinstall and
`@parcel/watcher`. Nothing needs approving.

## Run (agent path)

This starts `npm run dev`, which also starts the API server on `PORT` (default 8787, the user's).
In a run clone use § Server mode below (it sets `PORT=8788`) instead of these commands.

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
nohup npm run dev -- --host 127.0.0.1 --port 5173 --strictPort > .claude/scratch/run-urutau/dev.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:5173/ >/dev/null; do sleep 1; done' && echo "dev server up"

nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9333/health >/dev/null; do sleep 1; done' && echo "driver up"
```

Logs go to `.claude/scratch/run-urutau/` and Chromium's temporary profile to
`.claude/scratch/tmp`, never `/tmp` (`.claude/ENVIRONMENT.md` § Scratch space).
Agents working in a run clone use the ports from `.claude/ENVIRONMENT.md`
§ Ports (5174, 4174, 9334) instead of the defaults below.

Each POST body runs as an async function with the helpers below in scope. Its `return` value
comes back as JSON:

```bash
curl -s http://127.0.0.1:9333 --data-binary @- <<'EOF'
await openBoard('acme/widgets')
const moved = await drag(14, 'To do')
return { moved, shot: await shot('board') }
EOF
```

The reply looks like `{ ok, result, githubRequests, rateLimitRemaining, logs }`. `logs` lists
console errors, page errors, failed requests and every GitHub `GET` and `POST` made during that request
(method and URL only, never a body or header; CORS preflight `OPTIONS` calls are not listed). If
your code throws, the reply is HTTP 500 with `{ ok: false, error, logs }`.
Screenshots go to `.claude/skills/run-urutau/shots/<name>.png` (git-ignored); open them with
Read. Browser state (localStorage) persists between requests until the driver stops.

| helper | what it does |
|---|---|
| `openBoard(repo)` | open `/?repo=<repo>` and wait for the board or its error message |
| `buckets()` | `[{ title, count, issues: [numbers in display order] }]` |
| `drag(issue, bucketTitle, { steps = 20 })` | mouse-drag a card to the top of a bucket; returns `buckets()` |
| `keyboardMove(issue, keys)` | Space on the card's handle, press `keys` (e.g. `['ArrowRight']`), Space |
| `shot(name, options?)` | screenshot (Playwright options: `fullPage`, `clip`, …; `page: other` shoots another page of the context); returns the path |
| `goto(path)` | open a path of the app, e.g. `goto('/')` for the start page |
| `createAdmin(username, password, page?)` | server mode, empty database: fill the first-run form, wait until the app leaves it |
| `signIn(username, password, page?)` | server mode: fill the sign-in form; throws with the form's error text if it stays |
| `newUserContext()` | a second isolated browser context with GitHub fixtures; returns `{ context, page, pageErrors }`, pass `page` to `signIn`. Its console and page errors appear in `logs` as `[user2 ...]` |
| `inviteUser(username, password)` | the admin creates an invite, a new context opens it and creates the second account; returns `newUserContext()`'s value, signed in |
| `liveMove(issue, bucketTitle, other, { limitMs = 2000 })` | main page drags the card; returns `{ elapsedMs }` until `other.page` shows it in that bucket without reload; throws over the limit or on a page error in `other` |
| `resetStorage()` | clear the main page's localStorage (theme, v1 data), then reload; boards live on the server, so it neither deletes them nor signs out |
| `mcp(method, params, token)` | server mode with the launcher: sends one JSON-RPC request to `<appUrl>/mcp` with Playwright's request context (full `Accept` header, bearer `token`) and returns `{ status, ...answer }`, reading the `data:` line of an event-stream answer. Keep the token in a variable inside the script; never return, log or write it |
| `fixtureGitHubToken` | the fake GitHub token (`github_pat_urutau_fixture_not_a_real_token`) to type into an integration's GitHub-token modal |
| `page`, `context`, `browser` | raw Playwright objects; `mode` and `appUrl` describe the setup |

The following role-based selectors are verified:

- Card menu: `page.getByRole('button', { name: 'Actions for issue #9' })`, then
  `page.getByRole('menuitem', { name: 'Move to In review' })`.
- Label filter: `page.getByRole('combobox', { name: 'Labels' })`, then
  `page.getByRole('option', { name: /^bug/ })`.
- Theme: `page.getByRole('button', { name: 'Switch to dark theme' })`.
- Dialogs: `page.getByRole('dialog', { name: 'Board settings' })`.

**Fixture repositories** (`fixtures.mjs`; dates are relative to now):

| repo | serves |
|---|---|
| `acme/widgets` | 13 open issues over two pages, one PR (the app hides it), 3 recently closed issues plus 1 closed long ago (outside the window), labels that auto-link to *In progress* and *In review* |
| `acme/empty` | no labels, no issues |
| `acme/readonly` | two open issues; creating an issue answers 403 `Resource not accessible by personal access token` |
| `acme/limited` | 403 rate-limit error |
| anything else | 404 (looks like a private repo without a token) |

On a known repository, `PATCH`, `PUT` and `DELETE` answer 405 with `Allow: GET, POST, OPTIONS`. `fixtureFetch` (the fetch-shaped
export the launcher uses) rejects any URL that does not start with `https://api.github.com/` with
`TypeError('fixture fetch answers only https://api.github.com')`; a log line from the launcher
that is not a `GET`, or a `TypeError` with that text, means something tried to leave the fixtures.

Creating an issue (`POST /repos/{owner}/{repo}/issues`) works on `acme/widgets` and `acme/empty` with any
non-empty `Authorization` header (paste `fixture-token` in Settings), answers 401 without one, and keeps the new
issue until the driver stops. No create reaches real GitHub in fixtures mode.

**Real GitHub.** Restart the driver with `URUTAU_GITHUB=live`. Anonymous use allows 60 requests
an hour; `expressjs/express` costs about 6 per load. The first line checks the budget, and that
call doesn't count against it:

```bash
curl -s https://api.github.com/rate_limit | python3 -c "import json,sys; print(json.load(sys.stdin)['resources']['core']['remaining'])"
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
lsof -ti:9333 -sTCP:LISTEN | xargs -r kill; timeout 10 bash -c 'while lsof -ti:9333 -sTCP:LISTEN >/dev/null; do sleep 0.1; done'
URUTAU_GITHUB=live nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9333/health >/dev/null; do sleep 1; done' && echo "driver up"
```

**Production build.** Build and serve it, then point the driver at it with `APP_URL`:

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
npm run build
nohup npm run preview -- --host 127.0.0.1 --port 4173 --strictPort > .claude/scratch/run-urutau/preview.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:4173/ >/dev/null; do sleep 1; done' && echo "preview up"
lsof -ti:9333 -sTCP:LISTEN | xargs -r kill; timeout 10 bash -c 'while lsof -ti:9333 -sTCP:LISTEN >/dev/null; do sleep 0.1; done'
APP_URL=http://127.0.0.1:4173 nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9333/health >/dev/null; do sleep 1; done' && echo "driver up"
```

Other driver settings are `DRIVER_PORT` (default 9333), `COLOR_SCHEME=dark` and `SCREENSHOT_DIR`.

**Stop** by port. The driver closes its browser on SIGTERM, and `curl -s http://127.0.0.1:9333/quit`
stops just the driver:

```bash
for port in 9333 5173 4173; do lsof -ti:$port -sTCP:LISTEN | xargs -r kill; done
```

## Server mode (accounts and boards on the real API server)

Boards live in the API server's database, so the driver needs the server beside Vite. GitHub is
still answered from fixtures in the browser (`fixtures.mjs` answers `api.github.com` only, never
`/api`). An in-memory SQLite database starts empty on every server start, so each start begins at
first-run. Ports for the user are 8787 (API), 5173 and 9333; agents in a run clone use 8788,
5174 and 9334. Setting `PORT=8788` keeps the clone's server off the user's 8787:

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
DATABASE_URL=sqlite::memory: PORT=8788 nohup node server/main.ts > .claude/scratch/run-urutau/api.log 2>&1 &
URUTAU_API_PORT=8788 nohup npm run dev:web -- --host 127.0.0.1 --port 5174 --strictPort > .claude/scratch/run-urutau/dev.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:5174/ >/dev/null; do sleep 1; done'
APP_URL=http://127.0.0.1:5174 DRIVER_PORT=9334 nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9334/health >/dev/null; do sleep 1; done' && echo up

curl -s http://127.0.0.1:9334 --data-binary @- <<'EOS'
await goto('/')
await createAdmin('admin', 'correct horse battery')
await openBoard('acme/widgets')
const moved = await drag(14, 'To do')
return { moved, shot: await shot('board') }
EOS
```

(`dev:web` runs Vite alone; `npm run dev` runs both processes and takes the same `PORT`.) A second
user: `const u = await newUserContext(); await signIn('admin', '…', u.page)`, then drive
`u.page` with Playwright. A wrong password makes `signIn` throw. Stop by port, adding 8788:
`for port in 9334 5174 8788; do lsof -ti:$port -sTCP:LISTEN | xargs -r kill; done`.
Live updates between two accounts (the second joins through an invite):

```bash
curl -s http://127.0.0.1:9334 --data-binary @- <<'EOS'
await goto('/')
await createAdmin('admin', 'correct horse battery')
const u = await inviteUser('second', 'another long password')
await openBoard('acme/widgets')
await u.page.goto(`${appUrl}/?repo=acme/widgets`)
await u.page.locator('.board-header__name').waitFor()
const { elapsedMs } = await liveMove(14, 'To do', u)
return { elapsedMs, a: await shot('live-admin'), b: await u.page.screenshot({ path: `${process.env.SCREENSHOT_DIR ?? '.claude/skills/run-urutau/shots'}/live-second.png` }).then(() => 'saved') }
EOS
```

Do not write real passwords, session cookies or invite tokens into scripts or screenshot names.

### Server mode with agent integrations (the launcher)

Agent integrations make the server itself read GitHub, so the browser's fixture routing is not
enough. `.claude/skills/run-urutau/mcp-launcher.mjs` starts the server through `start()` from
`server/main.ts` with `DATABASE_URL=sqlite::memory:`, `HOST=127.0.0.1`, a development
`TOKEN_ENCRYPTION_KEY` (`Buffer.alloc(32, 0x75)` in base64, which protects nothing) and a `fetch`
that answers from `fixtures.mjs`. It writes one stdout line per outbound request,
`fixture-github <METHOD> <path><query> auth=<present|absent>` (never a header value). With
`URUTAU_LAUNCHER_NO_KEY=1` it starts without a key, to see the "GitHub tokens cannot be stored" state.
Use it instead of `node server/main.ts` in the commands above; Vite proxies `/mcp` as well as `/api`.

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
PORT=8788 nohup node .claude/skills/run-urutau/mcp-launcher.mjs > .claude/scratch/run-urutau/api.log 2>&1 &
URUTAU_API_PORT=8788 nohup npx vite --host 127.0.0.1 --port 5174 --strictPort > .claude/scratch/run-urutau/dev.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:5174/api/session >/dev/null; do sleep 1; done'
APP_URL=http://127.0.0.1:5174 DRIVER_PORT=9334 nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9334/health >/dev/null; do sleep 1; done' && echo up
```

A two-actor check, in one script so the token stays in a variable (the Users page is `?view=users`):

```js
await goto('/'); await createAdmin('admin', 'correct horse battery')
await page.goto(appUrl + '/?view=users')
await page.getByLabel('Integration name').fill('planner-bot')
await page.getByRole('button', { name: 'Create integration' }).click()
await page.getByLabel('Token name').fill('agent')
await page.getByRole('button', { name: 'Create token' }).click()
await page.waitForFunction(() => document.querySelector('.users__link code, .users__link pre')?.textContent?.startsWith('urutau_mcp_'))
const token = (await page.locator('.users__link code, .users__link pre').first().innerText()).trim()
// role-based alternative, same text: page.getByRole('textbox', { name: 'Urutau MCP token', exact: true })
// (getByLabel('Urutau MCP token') without exact matches three elements and fails Playwright's strict mode)
// ... set the GitHub token (fixtureGitHubToken) and the repositories, open the board in
// context.newPage(), then:
const moved = await mcp('tools/call', { name: 'move_card', arguments: { repo: 'acme/widgets', issue: 12, bucket: 'todo', position: 'top' } }, token)
await other.getByRole('status').filter({ hasText: 'Board updated by' }).first().waitFor() // other = the board page
```

The 'Board updated by <name>' toast closes after 4 seconds (`ToastNotification timeout={4000}` in `src/board/Board.tsx`), so wait
for it and take the screenshot in the same driver script as the `move_card` call.

`grep -c 'fixture-github \(POST\|PATCH\|PUT\|DELETE\)' api.log` must print 0.
Every outbound request of the launched server goes through the launcher's fetch, which only calls `fixtureFetch` and has no
network path. A `TypeError` 'fixture fetch answers only https://api.github.com' in the log means a URL outside
api.github.com was tried.
Mask the token tile's `CodeSnippet` text in the page before any screenshot. A full-page screenshot draws
the fixed header in the middle of the image; use a tall viewport (`page.setViewportSize`) instead.
Stop with `for port in 9334 5174 8788; do lsof -ti:$port -sTCP:LISTEN | xargs -r kill; done`.

## Direct invocation (domain logic)

Node 24 strips types, and `src/domain/*.ts` only import types from each other, so you can call
them without the app:

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
node --input-type=module -e "import { createDefaultBoard } from './src/domain/board.ts'; console.log(createDefaultBoard([]).buckets.map((b) => b.title))"
```

Anything else (`src/github`, components) has extensionless value imports. Exercise it through
Vitest instead.

## Run (human path)

```bash
npm run dev   # -> http://localhost:5173, enter owner/name. Ctrl-C to stop.
```

## Test

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
npm run lint && npm run typecheck && npm test && npm run build
```

Expect every test to pass (644 passed and 3 skipped, in 43 files, on 2026-10-03). CI (`.github/workflows/ci.yml`) runs the same four steps.

## Gotchas

- **A mouse drag needs many small moves.** dnd-kit activates after 6px, then tracks the pointer
  across further moves. `drag(12, 'To do', { steps: 1 })` leaves the card where it was, while the
  default 20 steps works.
- **Cards below a bucket's visible area can't be grabbed** at their bounding box, because each
  bucket scrolls on its own. The press lands outside the viewport and nothing happens, with no
  error. `drag()` scrolls the card into view first; do the same in hand-written drags.
- **The loading skeleton reuses `.bucket` markup.** Wait for `.board-header__name` (as
  `openBoard` does), not `.bucket`.
- **Every board load in dev logs `[requestfailed] … ERR_ABORTED`** for the repository request.
  React StrictMode mounts twice and the first fetch is aborted. The production build makes one
  request.
- **Board state is per origin.** The dev server (5173) and the preview (4173) keep separate
  boards in localStorage. Use `resetStorage()` for a clean board.
- **Some edits trigger a full reload.** Editing `src/main.tsx` reloads the page, which refetches
  the issues (spending live-mode budget). Edits to board components hot-reload but reset
  unsaved UI state such as filters.
- **Vitest 5 hides `console.log` output from passing tests.** Add `--silent=false`.
- **In jsdom tests, Carbon overflow-menu items stay visibility-hidden** because there's no layout.
  `findByRole('menuitem', { name })` fails, so use `findByText('Move to To do')`. In the real
  browser (driver), role queries work.
- **Other processes may run Chrome too.** Stop things by port, never with `pkill chrome`.
- **The driver runs whatever code it is sent**, inside Node. It refuses requests that carry
  browser headers (`Origin`, `Sec-Fetch-*`) or a `Host` other than `127.0.0.1:<port>`, so web
  pages can't reach it. Only use it from local tools like curl, and never expose the port.

## Troubleshooting

- **`Error: Port 5173 is already in use`**: a dev server is already running. Reuse it, or kill it
  by port (see Stop).
- **`ERR_MODULE_NOT_FOUND … src/github/client`** from a direct `node` import: that module has
  extensionless imports. Use a Vitest test instead.
- **`~@ibm/plex/… didn't resolve at build time`**: someone removed
  `$font-path: '@ibm/plex'` from `src/styles/index.scss`. Vite doesn't understand webpack's `~`
  prefix, so restore the setting.
