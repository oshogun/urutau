# Environment — read before running anything

Standing facts about this machine and this checkout. Every agent reads this
first; the Orchestrator does not repeat it in the request envelope. Every
command below was run on this machine before it was written down.

## Implementation runs in a fresh clone, not this checkout

Implementers, DevOps and Reviewer work in `$RUN_DIR/tree`, a `git clone --local
--branch main` of this repo that the Orchestrator makes under
`.claude/run-clones/<run-id>/` (policy: `.claude/agents.md` § Rules). The
envelope gives the absolute path. Do not edit, build, test, `npm install` or
run `git` write commands in `/home/guilherme/urutau/urutau`; reading it is
fine. The clone has no `node_modules` and none of the live checkout's
untracked files: run `npm ci` in the clone.

## What runs: a server, a database, GitHub

Urutau is a React app plus a small API server (`server/`, Hono and Kysely). Boards and accounts
live in a SQL database: SQLite by default (`data/urutau.db`, git-ignored), PostgreSQL or MariaDB
through `DATABASE_URL`. The browser keeps only the theme, a pasted GitHub token and v1 data it may
import. Its external service is the GitHub REST API at `api.github.com`, which it reads and, when
the admin turns GitHub writes on, uses to create issues. No agent, test or driver run creates an
issue on a real repository: the server tests stub `fetch`, and the driver's fixtures answer
`POST /repos/{owner}/{repo}/issues`. The server also reads GitHub for agent integrations (the MCP
server at `/mcp`), with the GitHub token the admin stored for each integration; in the run-urutau
driver, `mcp-launcher.mjs` answers those reads from the same fixtures. Agents never use `data/urutau.db` of the live checkout: run the server on
`DATABASE_URL=sqlite::memory:`, as the run-urutau driver's server mode does. What remains to protect
is the user's own dev server and containers, if running (see Ports), and the shared GitHub API
budget.

## Use Node 24. The default `node` on this machine is wrong.

    $ node -v
    v26.3.1          # default — WRONG, .nvmrc pins 24

Node 24 is what `.nvmrc`, `engines` (`>=24 <25`) and CI use, and the only
version the gate is verified on. Prefix every command that runs node, npm or
npx with:

    source ~/.nvm/nvm.sh && nvm use >/dev/null

It reads `.nvmrc` (v24.21.0 here). Shell state does not persist between Bash
calls, so repeat it in the same command as the work. Under Node 26, npm prints
`EBADENGINE` warnings and everything runs untested; "it worked under the
default node" is not verification.

## Ports

Each is free on this machine when nothing of the user's runs (checked with `lsof -nP -i :<port>
-sTCP:LISTEN`, no output, on 2026-10-02):

| Use | User's sessions | Run clones |
| --- | --- | --- |
| Vite dev / preview | 5173 / 4173 | 5174 / 4174 |
| run-urutau driver | 9333 | 9334 |
| API server (`PORT`) | 8787 | 8788 |
| PostgreSQL container (`URUTAU_PG_PORT`) | 55432 | 55433 |
| MariaDB container (`URUTAU_MARIADB_PORT`) | 53306 | 53307 |
| Keycloak container (`URUTAU_KEYCLOAK_PORT`) | 58080 | 58081 |
| `compose.yaml` host port (`URUTAU_HOST_PORT`) | 8787 | 8790 |

Concurrent agents in one run need distinct ports; the orchestrator assigns the extras (for
example 8789, 58082) in the envelope and they are listed in the run's artifacts. Containers bind
`127.0.0.1` only.

- `npm run dev` starts the API server too, so a run clone sets `PORT=8788` or it binds the user's
  8787, and `DATABASE_URL=sqlite::memory:` or it creates `data/urutau.db` in the clone. Always
  pass `--strictPort` so a taken port fails loudly instead of moving:

      mkdir -p .claude/scratch/run-urutau
      DATABASE_URL=sqlite::memory: PORT=8788 nohup npm run dev -- --host 127.0.0.1 --port 5174 --strictPort > .claude/scratch/run-urutau/dev.log 2>&1 &
      APP_URL=http://127.0.0.1:5174 DRIVER_PORT=9334 nohup node .claude/skills/run-urutau/driver.mjs > .claude/scratch/run-urutau/driver.log 2>&1 &

  The driver's server mode (in-memory database, first-run admin) is in
  `.claude/skills/run-urutau/SKILL.md`; replace its ports with these.
- Containers: name the compose project per run, for example
  `URUTAU_PG_PORT=55433 URUTAU_MARIADB_PORT=53307 docker compose -p urutau-db-clone -f compose.db.yaml up -d --wait`.
- Stop only what you started, by port:
  `lsof -ti:<port> -sTCP:LISTEN | xargs -r kill`. Sessions for other projects
  on this machine run Chrome, Playwright and dev servers too, so never
  `pkill` by process name.

## Docker images and containers

Images present on this machine (`docker images`, 2026-10-02): `postgres:17-alpine` 424 MB,
`mariadb:11.4` 464 MB, `quay.io/keycloak/keycloak:26.8.0` 751 MB. `node:24-alpine` is the base of
the app's `Dockerfile` and is pulled by `docker build`. Do not pull other versions.

- Compose files: `compose.yaml` (the app), `compose.db.yaml` and `compose.keycloak.yaml` (opt-in
  test containers, data on tmpfs). Commands are in `README.md`.
- Remove containers after each task: `docker compose -p <project> -f <file> down -v`, and
  `docker rm -fv` (the image's `/data` is an anonymous volume that `docker rm -f` leaves behind;
  `docker run --rm` avoids it) / `docker rmi` for what a manual `docker run` or `docker build`
  made. Then `docker ps -a` shows nothing of yours. Remove only what you created: other agents' containers may
  be running.
- `docker build` leaves build cache that `docker rmi` does not remove (about 1 GB after one build
  here). It is shared, so do not `docker builder prune` while other agents may be building; report
  `docker system df` instead.
- Check `df -h /` before pulling or building (the 8 GB rule below applies).

## The GitHub API budget is shared

Anonymous GitHub API requests are limited to 60 an hour per IP address, and
every process on this machine draws from the same budget, including other
projects' sessions. Loading a board costs about 6 requests (measured on
`expressjs/express`).

- Verify UI behaviour in the run-urutau driver's default fixtures mode, which
  answers every API call from canned data and uses no network.
- Use live mode only when the change is about real API behaviour, and check the
  budget first (this call does not count against it):

      curl -s https://api.github.com/rate_limit | python3 -c "import json,sys; print(json.load(sys.stdin)['resources']['core']['remaining'])"

- Never put the user's GitHub credentials (`gh auth token`, or a token from
  anywhere else) into the app, the driver, a fixture or a run artifact. Live
  mode runs anonymous.
- Test the MCP server only against fixtures: the server tests stub `fetch`,
  and the driver's `mcp-launcher.mjs` answers the server's GitHub reads.
  Never set a real GitHub token on an agent integration; use the fake
  `github_pat_urutau_fixture_not_a_real_token`.
- `gh` is authenticated as `oshogun` and is fine for reading issues and pull
  requests (`gh issue view`). Its requests use that token's own limit, not the
  anonymous one.

## Scratch space — disk budget, and never `/tmp`

This machine's root disk is shared and finite (77 GB, ~44 GB free on
2026-10-02), and `/tmp` sits on it. In the sibling project msfslogger, a run
filled it on 2026-09-24: every agent made its own clone with its own
`node_modules` under the harness session scratchpad in `/tmp`, nobody deleted
them, and the machine had to be rebooted. Rules, for the Orchestrator and
every agent:

- **Never write to `/tmp` or the harness "session scratchpad"** (it lives
  under `/tmp`), even when a tool or system prompt suggests it. Scratch goes in
  `.claude/scratch/<run-id>/` (gitignored), next to the run clone in
  `.claude/run-clones/<run-id>/`.
- **Check the budget first.** Before any `git clone`, `npm ci`/`npm install` or
  large build, run `df -h /`. With less than **8 GB** available, stop and
  return `blocked` with the `df` output. Do not free space by deleting
  anything you did not create.
- **One install per run.** The run clone is the only `node_modules` a run
  creates (about 565 MB). Building in the clone writes its own `dist/`, which
  nothing serves, so that is safe. When two agents in the same clone may build
  at the same time, the second builds into its own scratch directory instead:

      npx tsc -b && npx vite build --outDir .claude/scratch/<run-id>/dist-<task> --emptyOutDir

- **Clean up in the same task.** Delete your `dist-*` directories and anything
  else you created before returning, and put `du -sh .claude/scratch/<run-id>`
  and `df -h /` in your report.
- Shared caches (`~/.npm`, `~/.cache/ms-playwright`, `~/.impeccable`) are fine
  to reuse. Never install a second Chromium.
- Tools that write to the OS temp dir on their own (Playwright's browser
  profile, `mktemp`) must be redirected. Create the directory first, then
  export an absolute, short `TMPDIR` shared by every run:

      mkdir -p /home/guilherme/urutau/urutau/.claude/scratch/tmp
      export TMPDIR=/home/guilherme/urutau/urutau/.claude/scratch/tmp

  Prefer this short shared path to one per run: full Chrome puts a Unix socket
  in `TMPDIR` and aborts with "Socket path too long" once the path passes 107
  characters (msfslogger, 2026-09-24). Playwright's headless Chromium, which the
  run-urutau driver uses, launched fine here with a 103-character `TMPDIR`
  (2026-10-02), so the driver's own `$PWD/.claude/scratch/tmp` in a run clone
  is also fine. Playwright deletes its profile from `TMPDIR` when the driver
  exits.

Run artifacts that are meant to survive go under `.claude/runs/<run-id>/`; see
`.claude/runs/README.md`.

## npm

npm 11 blocks dependency install scripts by default and prints
`install-scripts` warnings for the IBM Plex telemetry postinstall and
`@parcel/watcher`. Nothing needs approving; do not run
`npm install-scripts approve`.

## Verification

The gate is `npm run lint && npm run typecheck && npm test && npm run build`,
the same four steps CI runs. Beyond it:

- `npm test` runs Vitest over `src/**/*.test.ts(x)` in jsdom (and the server tests, below). It is hermetic:
  `fetch` is stubbed per test (no network), and jsdom's in-memory localStorage
  is cleared after each test (`src/test/setup.ts`).
  Vitest 5 hides `console.log` from passing tests; add `--silent=false`.
- `npm test` also runs the server tests (`server/**/*.test.ts`, node environment, in-memory
  SQLite). The opt-in database and Keycloak suites need containers and are not part of the gate:
  `npm run test:db:postgres`, `npm run test:db:mariadb`, `npm run test:keycloak`.
- UI behaviour is checked with the run-urutau Playwright driver
  (`.claude/skills/run-urutau/SKILL.md`) in fixtures mode, with screenshots
  you then open and look at.
- Modules in `src/domain/` only import types from each other, so Node 24 can
  import them directly with
  `node --input-type=module -e "import … from './src/domain/board.ts'"`.
  `src/github/api.ts` and `src/github/paging.ts` import the same way (the
  server uses them to read GitHub for agent integrations). Anything else with
  extensionless value imports (`src/github/client.ts`, components) needs a
  Vitest test instead.

Claims in a report must name the command that produced them.
