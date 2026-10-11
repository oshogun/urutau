---
name: run-urutau
description: Build, run, test, and drive the Urutau kanban web app (Vite + React 19 + Carbon, Hono API server). Use when asked to start urutau or its dev server, run its tests, build it, take a screenshot of the board, drag issues between buckets, edit or close an issue from the board, sign in two users and check live updates, drive the MCP server as an agent integration, or check a UI change in a real browser.
---

Urutau is a React SPA, served with a small API server (`server/`) that holds accounts and boards,
that loads a GitHub repository's issues into a kanban board. The app does nothing without the
server: it opens on the first-run or sign-in page. To drive it, start the API server on an
in-memory database, Vite beside it, then `.claude/skills/run-urutau/driver.mjs`: one persistent
headless Chromium (Playwright) that runs the JavaScript you POST to it. By default the driver
answers all of the browser's GitHub API calls with fixture data, so you need no network, token or
rate-limit budget.

All paths are relative to the repository root. Every command below uses the run-clone ports from
`.claude/ENVIRONMENT.md` § Ports (API 8788, Vite 5174, driver 9334): they work in a run clone and
in the live checkout alike, and they never touch the user's own dev server on 8787/5173.

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

Start the API server on an in-memory SQLite database, Vite proxying `/api` to it, and the driver.
Never start the server without `DATABASE_URL=sqlite::memory:`: the default is `data/urutau.db` in
the checkout, which in the live checkout holds the user's real accounts. The `env -u …` prefix
removes the variables a shell may export for the user's own server (`PUBLIC_URL`, `ALLOWED_HOSTS`,
`TRUST_PROXY`, `KEYCLOAK_*`, `TOKEN_ENCRYPTION_KEY`): with `PUBLIC_URL` set, the server refuses
every write from `127.0.0.1:5174` as `csrf-rejected`, and with `KEYCLOAK_*` set and no
`PUBLIC_URL` it does not start.

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
env -u PUBLIC_URL -u ALLOWED_HOSTS -u TRUST_PROXY -u KEYCLOAK_ISSUER -u KEYCLOAK_CLIENT_ID -u KEYCLOAK_CLIENT_SECRET -u KEYCLOAK_GITHUB_IDP -u KEYCLOAK_BROKER_API -u KEYCLOAK_ALLOW_HTTP -u TOKEN_ENCRYPTION_KEY \
  DATABASE_URL=sqlite::memory: PORT=8788 nohup node server/main.ts > .claude/scratch/run-urutau/api.log 2>&1 &
URUTAU_API_PORT=8788 nohup npm run dev:web -- --host 127.0.0.1 --port 5174 --strictPort > .claude/scratch/run-urutau/dev.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:5174/ >/dev/null; do sleep 1; done'
APP_URL=http://127.0.0.1:5174 DRIVER_PORT=9334 nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9334/health >/dev/null; do sleep 1; done' && echo up
```

The database starts empty on every server start, so the first script creates the admin (the
first-run form), then opens a board:

```bash
curl -s http://127.0.0.1:9334 --data-binary @- <<'EOS'
await goto('/')
await createAdmin('admin', 'correct horse battery')
await openBoard('acme/widgets')
const moved = await drag(14, 'To do')
return { moved, shot: await shot('board') }
EOS
```

Later scripts in the same driver session are already signed in (the session cookie lives in the
browser context). To get back to first-run, restart only the API server:
`lsof -ti:8788 -sTCP:LISTEN | xargs -r kill`, then start it again with the same line.

Logs go to `.claude/scratch/run-urutau/` (`api.log` is the server's JSON request log) and
Chromium's temporary profile to `.claude/scratch/tmp`, never `/tmp` (`.claude/ENVIRONMENT.md`
§ Scratch space). `dev:web` runs Vite alone; `npm run dev` runs both processes and takes the same
`PORT`, but it starts the server without `DATABASE_URL`, so set that too if you use it.

Each POST body runs as an async function with the helpers below in scope. Its `return` value
comes back as JSON. Once signed in:

```bash
curl -s http://127.0.0.1:9334 --data-binary @- <<'EOF'
await openBoard('acme/widgets')
const moved = await drag(14, 'To do')
return { moved, shot: await shot('board') }
EOF
```

The reply looks like `{ ok, result, githubRequests, rateLimitRemaining, logs }`. `logs` lists
console errors, page errors, failed requests and every GitHub `GET`, `POST` and `PATCH` made during that request
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
| `createAgent(username, repos)` | server mode with the launcher, signed in as admin on the main page: creates an agent integration, stores the fake GitHub token, sets its repository list (`['acme/widgets']`) and creates one MCP bearer token. Returns `{ username, repos, tool(name, args) }`; the token lives only in the closure of `tool`, which calls an MCP tool and returns `{ status, result }` (`result.structuredContent` is the tool's JSON). Safe to `return` from a script |
| `seedAgentRuns(agent, repo, { running = 14, waiting = 12 })` | calls `record_run` for a `running` run (a claim with a lease) and an `awaiting_approval` run (a claim without a lease, so a `waitingOnHuman` entry) with one unverified item each of `external`, `normative` and `untested`, then returns `{ humanWaitLimit, waitingOnHuman, cards }` from `get_board` (`cards` are the ones with a `claim` or `lastRun`). Open the board first (`openBoard(repo)`): `running` and the waiting statuses answer `no-board` for a repository nobody opened. Throws with the error text if a call fails |
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
| `acme/readonly` | two open issues; creating or changing an issue answers 403 `Resource not accessible by personal access token` |
| `acme/limited` | 403 rate-limit error. Through an agent integration, this also records the token's rate as spent: that integration's other repositories answer `github-rate-limited` with `reserve: true` for about 45 minutes. Use a separate integration for `acme/limited`, or read it last. |
| anything else | 404 (looks like a private repo without a token) |

On `acme/widgets`, `acme/empty` and `acme/readonly`, any method other than `GET`, `HEAD`, `POST`, `PATCH` and `OPTIONS` answers 405 with `Allow: GET, POST, PATCH, OPTIONS`; `acme/limited` answers 403 to every method except `OPTIONS`, which gets 204. `fixtureFetch` (the fetch-shaped
export the launcher uses) rejects any URL that does not start with `https://api.github.com/` with
`TypeError('fixture fetch answers only https://api.github.com')`; a log line from the launcher
that is not a `GET`, or a `TypeError` with that text, means something tried to leave the fixtures.

Creating an issue (`POST /repos/{owner}/{repo}/issues`) works on `acme/widgets` and `acme/empty` with any
non-empty `Authorization` header (paste `fixture-token` in Settings), answers 401 without one, and keeps the new
issue until the driver stops. No create reaches real GitHub in fixtures mode.

`GET /repos/{owner}/{repo}/issues/{number}` answers the issue from the open or closed list (the pull
request #11 on `acme/widgets` carries its `pull_request` key), or 404. Changing an issue
(`PATCH` of the same URL) answers 401 without an `Authorization` header, 403 on `acme/readonly`, 404
for an unknown number, 422 for a body that is not a JSON object, a key other than `title`, `body`,
`state` and `state_reason`, a blank or non-text `title`, a `state` other than `open` or `closed`, or a
`state_reason` other than `completed`, `not_planned`, `reopened` or null. Otherwise it applies the
fields, moves the issue between the open and closed lists when `state` changes (closing sets
`state_reason`, default `completed`, and `closed_at`; reopening sets `reopened` and clears
`closed_at`), sets `updated_at` to now in whole seconds, and answers 200 with the issue. Any other
`PATCH` path answers 404. Changes are kept until the driver stops. The stale case is `acme/widgets`
#2: its single-issue answer is a newer version than the list holds (title "Add dark mode to the
settings page and the editor", one more line in the description, `updated_at` an hour before the
driver started), so the first change to it is refused as stale; "Apply again" then succeeds, and the
list and the single-issue answer serve the changed issue from then on.

### Edit, close and reopen an issue (GitHub writes)

Writes are off until the admin turns them on (`?view=server-settings`), and the browser needs a
token in Settings; the fixtures accept any non-empty one. This script exercises the stale-edit
refusal on #2 and closes #12; every `PATCH` goes to the fixtures:

```bash
curl -s http://127.0.0.1:9334 --data-binary @- <<'EOS'
page.setDefaultTimeout(10000)
await page.goto(appUrl + '/?view=server-settings')
await page.getByText('Create and edit issues on GitHub').click()
await page.waitForFunction(() => document.querySelector('#github-writes')?.getAttribute('aria-checked') === 'true')
await page.getByRole('button', { name: 'Settings', exact: true }).click()
const dlg = page.getByRole('dialog', { name: 'Settings' })
await dlg.getByLabel('GitHub personal access token').fill('fixture-token')
await dlg.getByRole('button', { name: 'Save', exact: true }).click()
await openBoard('acme/widgets')
await page.getByRole('button', { name: 'Show details of issue #2' }).click()
const modal = page.getByRole('dialog', { name: 'acme/widgets #2' })
await modal.getByRole('button', { name: 'Edit', exact: true }).click()
await modal.getByLabel('Title', { exact: true }).fill('Add dark mode everywhere')
await modal.getByRole('button', { name: 'Save changes' }).click()
await modal.getByRole('button', { name: 'Apply again' }).waitFor()
const stale = await shot('details-stale')
await modal.getByRole('button', { name: 'Apply again' }).click()
await modal.getByRole('button', { name: 'Edit', exact: true }).waitFor()
await modal.getByRole('button', { name: 'Close', exact: true }).click()
await page.getByRole('button', { name: 'Show details of issue #12' }).click()
const m12 = page.getByRole('dialog', { name: 'acme/widgets #12' })
await m12.getByRole('button', { name: 'Close as completed' }).click()
await m12.getByRole('button', { name: 'Reopen' }).waitFor()
const closed = await shot('details-closed')
await m12.getByRole('button', { name: 'Close', exact: true }).click()
return { stale, closed, buckets: (await buckets()).map(b => [b.title, b.issues.join(',')]) }
EOS
```

Afterwards #12 is first in *Done*, and `logs` lists `GET …/issues/2` twice, then `PATCH …/issues/2`,
`GET …/issues/12` and `PATCH …/issues/12`.

### Two accounts and live updates

A second user: `const u = await newUserContext(); await signIn('admin', '…', u.page)`, then drive
`u.page` with Playwright. A wrong password makes `signIn` throw. Live updates between two accounts
(the second joins through an invite), on a fresh server:

```bash
curl -s http://127.0.0.1:9334 --data-binary @- <<'EOS'
await goto('/')
await createAdmin('admin', 'correct horse battery')
const u = await inviteUser('second', 'another long password')
await openBoard('acme/widgets')
await u.page.goto(`${appUrl}/?repo=acme/widgets`)
await u.page.locator('.board-header__name').waitFor()
const { elapsedMs } = await liveMove(14, 'To do', u)
return { elapsedMs, a: await shot('live-admin'), b: await shot('live-second', { page: u.page }) }
EOS
```

Do not write real passwords, session cookies or invite tokens into scripts or screenshot names.

### Agent integrations and MCP (the launcher)

Agent integrations make the server itself read GitHub, so the browser's fixture routing is not
enough. `.claude/skills/run-urutau/mcp-launcher.mjs` starts the server through `start()` from
`server/main.ts` with `DATABASE_URL=sqlite::memory:`, `HOST=127.0.0.1`, a development
`TOKEN_ENCRYPTION_KEY` (`Buffer.alloc(32, 0x75)` in base64, which protects nothing) and a `fetch`
that answers from `fixtures.mjs`. It writes one stdout line per outbound request,
`fixture-github <METHOD> <path><query> auth=<present|absent>` (never a header value). With
`URUTAU_LAUNCHER_NO_KEY=1` it starts without a key, to see the "GitHub tokens cannot be stored" state.
Use it instead of `node server/main.ts` in the commands above; Vite proxies `/mcp` as well as `/api`.
It passes only `PORT` from the shell to the server; every other shell variable except
`URUTAU_LAUNCHER_NO_KEY` is ignored.

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
PORT=8788 nohup node .claude/skills/run-urutau/mcp-launcher.mjs > .claude/scratch/run-urutau/api.log 2>&1 &
URUTAU_API_PORT=8788 nohup npx vite --host 127.0.0.1 --port 5174 --strictPort > .claude/scratch/run-urutau/dev.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:5174/api/session >/dev/null; do sleep 1; done'
APP_URL=http://127.0.0.1:5174 DRIVER_PORT=9334 nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9334/health >/dev/null; do sleep 1; done' && echo up
```

The whole admin flow and the agent's call, in one script so the token stays in a variable (the
Users page is `?view=users`):

```bash
curl -s http://127.0.0.1:9334 --data-binary @- <<'EOS'
page.setDefaultTimeout(10000)
await goto('/'); await createAdmin('admin', 'correct horse battery')
await page.goto(appUrl + '/?view=users')
await page.getByLabel('Integration name').fill('planner-bot')
await page.getByRole('button', { name: 'Create integration' }).click()
await page.getByLabel('Token name').fill('agent')
await page.getByRole('button', { name: 'Create token' }).click()
await page.waitForFunction(() => document.querySelector('.users__link code, .users__link pre')?.textContent?.startsWith('urutau_mcp_'))
const token = (await page.locator('.users__link code, .users__link pre').first().innerText()).trim()
await page.getByRole('button', { name: 'Set GitHub token for planner-bot' }).click()
const gh = page.getByRole('dialog', { name: 'GitHub token for planner-bot' })
await gh.getByLabel('GitHub token (Urutau keeps this)').fill(fixtureGitHubToken)
await gh.getByRole('button', { name: 'Save GitHub token' }).click()
await page.getByText('GitHub token set').first().waitFor()
await page.getByRole('button', { name: 'Edit repositories of planner-bot' }).click()
const rd = page.getByRole('dialog', { name: 'Repositories planner-bot may read' })
await rd.getByLabel('One repository per line, as owner/name').fill('acme/widgets')
await rd.getByRole('button', { name: 'Save', exact: true }).click()
await page.locator('.integrations__repos li', { hasText: 'acme/widgets' }).waitFor()
const other = await context.newPage()
await other.goto(appUrl + '/?repo=acme/widgets')
await other.locator('.board-header__name').waitFor()
const list = await mcp('tools/call', { name: 'list_boards', arguments: {} }, token)
const moved = await mcp('tools/call', { name: 'move_card', arguments: { repo: 'acme/widgets', issue: 12, bucket: 'todo', position: 'top' } }, token)
await other.getByRole('status').filter({ hasText: 'Board updated by' }).first().waitFor()
return { listStatus: list.status, movedStatus: moved.status, movedErr: moved.result?.isError ?? null, shot: await shot('mcp-move', { page: other }) }
EOS
grep -c 'fixture-github \(POST\|PATCH\|PUT\|DELETE\)' .claude/scratch/run-urutau/api.log
```

The token's role-based locator is `page.getByRole('textbox', { name: 'Urutau MCP token', exact: true })`;
`getByLabel('Urutau MCP token')` without `exact` matches three elements and fails Playwright's
strict mode. `getByText('GitHub token set')` matches two tags (the table row and the expanded
row), hence `.first()`.

The 'Board updated by <name>' toast closes after 4 seconds (`ToastNotification timeout={4000}` in `src/board/Board.tsx`), so wait
for it and take the screenshot in the same driver script as the `move_card` call.

Seeding agent runs and claims (for a check of the card's claim, waiting tag or unverified flag) takes one script. The
driver creates the integration and its token itself, so no token is typed, printed or returned:

```js
await goto('/'); await createAdmin('admin', 'correct horse battery')
await openBoard('acme/widgets')                  // creates the board record record_run needs
const agent = await createAgent('carcara', ['acme/widgets'])
const seeded = await seedAgentRuns(agent, 'acme/widgets')   // #14 running, #12 awaiting_approval with 3 unverified
await page.reload(); await page.locator('.board-header__name').waitFor()
return { seeded, shot: await shot('seeded-runs') }
```

`seeded.cards` shows each seeded card's `claim { runId, status, since }` and `lastRun.unverifiedOpen`, and
`seeded.waitingOnHuman` lists #12. Call `agent.tool('record_run', { … })` for other statuses. Verified on
2026-10-08: `grep -rl urutau_mcp_ .claude/scratch .claude/skills/run-urutau/shots` finds nothing after the run.

`grep -c 'fixture-github \(POST\|PATCH\|PUT\|DELETE\)' api.log` must print 0.
Every outbound request of the launched server goes through the launcher's fetch, which only calls `fixtureFetch` and has no
network path. A `TypeError` 'fixture fetch answers only https://api.github.com' in the log means a URL outside
api.github.com was tried.
Mask the token tile's `CodeSnippet` text in the page before any screenshot. A full-page screenshot draws
the fixed header in the middle of the image; use a tall viewport (`page.setViewportSize`) instead.
Stop with `for port in 9334 5174 8788; do lsof -ti:$port -sTCP:LISTEN | xargs -r kill; done`.

### Real GitHub

Restart the driver with `URUTAU_GITHUB=live`. Anonymous use allows 60 requests an hour;
`expressjs/express` costs about 6 per load. The first line checks the budget, and that call
doesn't count against it:

```bash
curl -s https://api.github.com/rate_limit | python3 -c "import json,sys; print(json.load(sys.stdin)['resources']['core']['remaining'])"
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
lsof -ti:9334 -sTCP:LISTEN | xargs -r kill; timeout 10 bash -c 'while lsof -ti:9334 -sTCP:LISTEN >/dev/null; do sleep 0.1; done'
URUTAU_GITHUB=live APP_URL=http://127.0.0.1:5174 DRIVER_PORT=9334 nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9334/health >/dev/null; do sleep 1; done' && echo "driver up"
```

`curl -s http://127.0.0.1:9334 --data-binary 'return mode'` answers `"live"`. A restarted driver
has a fresh browser context, so sign in again with `signIn('admin', …)` (the server kept the
account).

### Production build

In production the API server itself serves `dist/`; there is no Vite. Build, start the server
without Vite, and point the driver at the server's port:

```bash
source ~/.nvm/nvm.sh && nvm use >/dev/null
mkdir -p .claude/scratch/run-urutau .claude/scratch/tmp && export TMPDIR="$PWD/.claude/scratch/tmp"
npm run build
env -u PUBLIC_URL -u ALLOWED_HOSTS -u TRUST_PROXY -u KEYCLOAK_ISSUER -u KEYCLOAK_CLIENT_ID -u KEYCLOAK_CLIENT_SECRET -u KEYCLOAK_GITHUB_IDP -u KEYCLOAK_BROKER_API -u KEYCLOAK_ALLOW_HTTP -u TOKEN_ENCRYPTION_KEY \
  DATABASE_URL=sqlite::memory: PORT=8788 nohup node server/main.ts > .claude/scratch/run-urutau/api.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:8788/ >/dev/null; do sleep 1; done' && echo "server up"
APP_URL=http://127.0.0.1:8788 DRIVER_PORT=9334 nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:9334/health >/dev/null; do sleep 1; done' && echo up
```

Then the same first-run script as above. `npm run build` writes `dist/` (git-ignored) in the
checkout; delete it afterwards in the live checkout (`rm -rf dist`). `npm run preview` is not a
substitute: it serves `dist/` without an API server, so the app cannot sign in.

Other driver settings are `COLOR_SCHEME=dark` and `SCREENSHOT_DIR`; `DRIVER_PORT` defaults to 9333
and `APP_URL` to `http://127.0.0.1:5173`, the user's ports, so always pass both.

### Stop

By port. The driver closes its browser on SIGTERM, and `curl -s http://127.0.0.1:9334/quit`
stops just the driver:

```bash
for port in 9334 5174 8788; do lsof -ti:$port -sTCP:LISTEN | xargs -r kill; done
```

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

Expect every test to pass (1620 passed and 3 skipped, in 81 test files plus 1 skipped, on 2026-10-04). CI (`.github/workflows/ci.yml`) runs the same four steps.

## Gotchas

- **A mouse drag needs many small moves.** dnd-kit activates after 6px, then tracks the pointer
  across further moves. `drag(12, 'To do', { steps: 1 })` leaves the card where it was, while the
  default 20 steps works.
- **Cards below a bucket's visible area can't be grabbed** at their bounding box, because each
  bucket scrolls on its own. The press lands outside the viewport and nothing happens, with no
  error. `drag()` scrolls the card into view first; do the same in hand-written drags.
- **The loading skeleton reuses `.bucket` markup.** Wait for `.board-header__name` (as
  `openBoard` does), not `.bucket`.
- **Every board load in dev logs `[requestfailed] … ERR_ABORTED`** for the repository request and
  for some `/api/…` requests. React StrictMode mounts twice and the first fetch is aborted. The
  production build makes one request of each (5 GitHub requests per `acme/widgets` load, not 6).
- **Boards live on the server; the theme and the pasted token are per origin.** The dev server
  (5174) and the production server (8788) keep separate localStorage. `resetStorage()` clears it
  but leaves the boards and the session.
- **A Carbon `Toggle`'s label covers its switch.** `getByRole('switch', …).click()` retries for
  30 seconds ("… label … subtree intercepts pointer events") and fails. Click the label text:
  `page.getByText('Create and edit issues on GitHub').click()`.
- **A failed locator waits Playwright's default 30 seconds** before the driver answers HTTP 500.
  Start long scripts with `page.setDefaultTimeout(10000)`; it stays set for the driver's life.
- **`githubRequests` and the `[github]` lines in `logs` count the main `page` only.** Requests from
  `context.newPage()` or `newUserContext()` pages are answered by the fixtures but not counted; the
  launcher's `api.log` lists the server's own.
- **Restarting the API server resets accounts and boards, not GitHub.** Issues created, edited or
  closed through the fixtures live in the driver process and stay changed until the driver stops.
- **Stop 8788 before switching servers.** The launcher, `node server/main.ts` and the production
  server all take `PORT=8788`. Start one while another runs and the new one dies with
  `EADDRINUSE` in `api.log`, but the `until curl …` wait succeeds against the old one, so the
  scripts run on the wrong server without an error. Run § Stop first.
- **The first open of a board logs a 404** (`[console.error] Failed to load resource … 404`): the
  app asks `GET /api/boards/<owner>/<repo>` before the board is saved. It is expected.
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

- **`Error: Port 5174 is already in use`**: a dev server is already running. Reuse it, or kill it
  by port (see Stop).
- **`ERR_MODULE_NOT_FOUND … src/github/client`** from a direct `node` import: that module has
  extensionless imports. Use a Vitest test instead.
- **`~@ibm/plex/… didn't resolve at build time`**: someone removed
  `$font-path: '@ibm/plex'` from `src/styles/index.scss`. Vite doesn't understand webpack's `~`
  prefix, so restore the setting.
