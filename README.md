# urutau

A simple kanban-style issue tracker for git. Point it at a GitHub repository and it turns the
issues into a kanban board, with customizable buckets and the repository's labels imported. A small
server keeps accounts and boards, so a team shares them and sees each other's changes live.

Built with React 19, TypeScript, Vite and IBM's [Carbon Design System](https://carbondesignsystem.com/)
for the app, and Hono, Kysely and a SQL database for the server.

## Features

- **Any GitHub repository.** Paste `owner/name` or a GitHub URL. Public repositories work without
  a token; private ones need a personal access token.
- **Customizable buckets.** Add, rename, reorder and delete buckets, and set an optional
  work-in-progress limit. A new board starts with *Backlog → To do → In progress → In review → Done*.
- **Imported labels.** Labels show on cards as Carbon tags, with a dot in the exact GitHub color.
  You can filter by label (with usage counts) and use labels as routing rules: open issues with a
  bucket's labels start in that bucket. Labels that look like workflow stages (`status: in
  progress`, `needs review`, …) are linked to the default buckets automatically.
- **Drag and drop.** Move cards within and between buckets with the mouse, touch or keyboard
  (Space/Enter on a card's handle, then the arrow keys). Each card also has a *Move to…* menu.
- **Closed issues.** Issues closed in the last 14 days (configurable) land in the bucket that
  collects closed issues.
- **Filters.** Search by title, number or author, and filter by label, assignee and milestone.
- **Light and dark themes** (Carbon White and Gray 100), following the system setting by default.
- **Shared boards and live updates.** Boards, buckets and card positions are stored on the server,
  and everyone signed in sees them. A change by a teammate appears in an open board without a
  reload, with a *Live* indicator and a *Board updated by …* notice.
- **Accounts.** Local username and password accounts, created from invite links by the admin, or
  sign-in with Keycloak.
- **Create issues.** When the admin turns on *Create issues on GitHub* on the Server settings page
  (user menu, *Server settings*), each bucket header gets a **+** button. It opens a dialog for a
  title and an optional description, creates the issue on GitHub as the person who clicked, and
  puts the new card in that bucket. The closed-issues bucket has no **+**. The switch is off by
  default and is server-wide.
- **Export and import** of a board as JSON, to move it to another server or share it. A board
  exported from another repository brings its buckets and rules, but not card positions.

Urutau reads issues and labels from GitHub and, when the admin turns on issue creation, creates
issues. It writes nothing else to a repository: no labels, no state changes, no comments. Buckets,
rules and card positions live in the server's database. Creating an issue adds no labels, whatever
the bucket's rules are.

## Getting started

You need Node.js 24 (see `.nvmrc`).

```bash
nvm use        # or install Node 24 another way
npm ci
npm run dev    # app at http://localhost:5173, API server at http://localhost:8787
```

`npm run dev` starts the API server (restarted on change) and the Vite dev server, which proxies
`/api` to it. `PORT` changes the API port. The database is a SQLite file, `data/urutau.db`, created
on first start.

**First run.** The first time the app opens with an empty database it asks for the first account.
Whoever creates it, with a username and password or through Keycloak, becomes the admin. The admin
creates invite links on the Users page; a person opens the link and picks a username and password
(or signs in with Keycloak) to join. Invite links expire.

**Upgrading from the browser-only version.** The start page offers to import the boards that
browser kept in its local storage. Boards already on the server are not replaced, and the browser's
copies are never deleted.

Enter a repository on the start page. Boards can be bookmarked; the URL looks like
`http://localhost:5173/?repo=owner/name`.

### GitHub access

Without a token, GitHub allows 60 API requests per hour per IP address. Loading a board takes
roughly 3–10 requests, depending on how many issues it has. A token raises the limit to 5,000 an
hour and is required for private repositories. There are two ways to give Urutau one:

1. **A token pasted in the browser** (local accounts, Keycloak accounts when `KEYCLOAK_GITHUB_IDP`
   is unset, and Keycloak users without a usable GitHub link). Create a
   [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
   with access to the repositories you want and these permissions: Issues (read-only to view a
   board, **read and write** to create issues) and Metadata (read-only). Paste it in **Settings**
   (the gear icon). It stays in this browser's local storage, is sent only to `api.github.com`,
   and never reaches the Urutau server or a board export. Anyone with access to your browser
   profile can read it. A token with Issues write can create and edit issues in those
   repositories, so give it only the repositories you need, and use a token with Issues read-only
   if you only view boards.
2. **A token held by Keycloak** (Keycloak accounts, when `KEYCLOAK_GITHUB_IDP` is set). The user
   signs in to Keycloak with GitHub. The server asks Keycloak for the GitHub token and keeps it in
   server memory for up to 5 minutes per session, so it does not ask on every request. It drops the
   token at once when GitHub rejects it, on sign-out and on restart. The server forwards `GET`
   requests for issues, labels and repository data to `api.github.com`, and one `POST` that
   creates an issue from a title and a description the server rebuilds itself; it forwards no
   other method and no other fields. The token is never stored
   in the database or sent to the browser. The user's Keycloak tokens are held in server memory
   too, and are not stored in the database either.

## Deploying

One Node process serves the built app and `/api`:

```bash
npm ci
npm run build
npm start      # http://127.0.0.1:8787
```

`npm start` needs `server/`, `src/domain/`, `dist/`, `node_modules/` and `package.json`.

Or with Docker: `docker compose up -d --build` builds the image and runs it with a SQLite database
in a named volume (`<project>_urutau-data`, `urutau_urutau-data` by default), published on
`127.0.0.1:8787` (`URUTAU_HOST_PORT` changes the host port). The image listens on `0.0.0.0:8080`
inside the container and runs as the `node` user.

### Reaching the server by a name

The server only answers requests addressed to `localhost`, an IP address, the hostname of
`PUBLIC_URL`, or a hostname in `ALLOWED_HOSTS`. Any other `Host` gets `403 host-not-allowed` on every
request, including the page itself. This stops a web page on another site from using the server
through DNS rebinding. If you reach the server by a DNS name, set `PUBLIC_URL` (or
`ALLOWED_HOSTS`); until you do, a server bound to a non-loopback address prints a startup warning.
The container binds `0.0.0.0`, so it prints that warning until `PUBLIC_URL` is set.

Behind a reverse proxy, set `PUBLIC_URL` to the address people open, for example
`https://urutau.example.com`, including any path prefix and without a trailing slash. Sign-ins and
other writes compare the browser's `Origin` with it, and nginx's default `proxy_pass` rewrites
`Host`. An `https:` value also makes the session cookie `Secure`. Set `TRUST_PROXY=true` only when
a proxy you control sets `X-Forwarded-For`: the server then takes the last entry as the client
address, which the sign-in rate limit uses. `X-Forwarded-Host` is never read.

### Run one instance only

Live updates, sign-in rate limits, pending Keycloak logins and Keycloak token grants are kept in
the memory of the single server process. Do not run two instances behind a load balancer: a
change saved through one would not reach a browser connected to the other. Restarting the server
signs Keycloak users out of GitHub reads (their Urutau sign-in survives; they sign in with
Keycloak again to read GitHub through the server).

### Environment variables

A bad or incomplete setting stops the server at start with an error naming the variable, never its
value.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address (`0.0.0.0` in the container image). |
| `PORT` | `8787` | Listen port (`8080` in the container image). |
| `DATABASE_URL` | `sqlite:data/urutau.db` | `sqlite:<path>` (relative to the working directory; the directory is created), `sqlite::memory:` (gone on exit), `postgres://…`, `postgresql://…`, `mysql://…` or `mariadb://…`. |
| `PUBLIC_URL` | unset | The address people open: origin and optional path prefix, no trailing slash. Required with Keycloak. |
| `ALLOWED_HOSTS` | unset | Extra hostnames the server answers for, comma-separated, without scheme, port or wildcard, for example `urutau,board.lan`. |
| `TRUST_PROXY` | `false` | `true` to take the client address from the last `X-Forwarded-For` entry. |
| `KEYCLOAK_ISSUER` | unset | Realm URL, for example `https://keycloak.example.com/realms/urutau`. Set with the next two or not at all. An `http:` issuer is accepted only on a loopback host unless `KEYCLOAK_ALLOW_HTTP=true`. |
| `KEYCLOAK_CLIENT_ID` | unset | The confidential client's id. |
| `KEYCLOAK_CLIENT_SECRET` | unset | The client's secret. |
| `KEYCLOAK_GITHUB_IDP` | unset | Alias of the GitHub identity provider in the realm. Unset: Keycloak users paste a token in the browser. |
| `KEYCLOAK_BROKER_API` | `v1` | `v1` or `v2`: which Keycloak token exchange API to use (see below). |
| `KEYCLOAK_ALLOW_HTTP` | `false` | `true` to accept an `http:` issuer on a non-loopback host. |

Other variables are read by tooling, not by the server: `URUTAU_API_PORT` (the `/api` proxy target of
`vite`; `npm run dev` sets it from `PORT`), `URUTAU_TEST_DATABASE_URL` and
`URUTAU_TEST_KEYCLOAK_URL` (opt-in test suites), and the container ports `URUTAU_PG_PORT`,
`URUTAU_MARIADB_PORT`, `URUTAU_KEYCLOAK_PORT` and `URUTAU_HOST_PORT`.

### Databases

SQLite is the default. PostgreSQL 17 and MariaDB 11.4 are supported through `DATABASE_URL`, for
example `postgres://urutau:secret@db:5432/urutau` or `mariadb://urutau:secret@db:3306/urutau`.
The tables are created and migrated at start. The drivers `pg` and `mysql2` are optional
dependencies, installed by `npm ci`.

MariaDB must run with `STRICT_TRANS_TABLES` in `sql_mode`, which is MariaDB 11.4's default. Without
it a value that is too long is silently truncated instead of rejected.

### Keycloak

Keycloak is optional. When `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` and
`PUBLIC_URL` are set, the sign-in page gains a Keycloak button, and a person's first Keycloak
sign-in creates their Urutau account. Accounts are matched on the issuer and Keycloak's subject,
never on username or e-mail. If no account exists yet, the first Keycloak user becomes the admin.

Realm setup (tested with Keycloak 26.8; the realm files in
[.claude/skills/run-urutau/keycloak/](.claude/skills/run-urutau/keycloak/) are a worked example):

1. **Client.** Create an OpenID Connect client, client authentication on (confidential), standard
   flow only. Turn on PKCE with method `S256` (Advanced settings, *Proof Key for Code Exchange
   Code Challenge Method*). Set the valid redirect URI to
   `<PUBLIC_URL>/api/auth/keycloak/callback` and the post logout redirect URI to `<PUBLIC_URL>/*`.
   Copy the client id and secret into the variables above.
2. **GitHub as an identity provider** (only for reading GitHub through Keycloak). Add the GitHub
   identity provider with its OAuth credentials and turn **Store tokens** and **Stored tokens
   readable** on, and its JSON format option on. Set `KEYCLOAK_GITHUB_IDP` to the provider's
   alias. *Stored tokens readable* gives users linked from then on the client role
   `broker.read-token`; users who linked before it was on need that role assigned, and a link made
   before *Store tokens* was on has no stored token until the user signs in again.
3. **Broker API.** Keycloak's default token endpoint for stored tokens is v1
   (`GET /realms/<realm>/broker/<alias>/token`), which Urutau uses with `KEYCLOAK_BROKER_API=v1`.
   If you start Keycloak with `--features=identity-brokering-api:v2`, set
   `KEYCLOAK_BROKER_API=v2` and, on the client, the attributes `external.token.enabled=true` and
   `external.token.idp=<alias>`. The two cannot be enabled at once.

A Keycloak user with no linked GitHub account (or one Keycloak refuses a token for) can still use
Urutau. The server does not read GitHub for them: Settings shows why, and they paste a token in the
browser as local accounts do. The same happens after a server restart until they sign in with
Keycloak again.

The last hop, Keycloak's GitHub provider handing over a real GitHub token, is **not proven** against
real GitHub: the tests use a second Keycloak realm in GitHub's place. The GitHub provider's default
scope, `user:email`, reaches public repositories only and cannot create issues. For private
repositories use an OAuth App with the `repo` scope (OAuth Apps have no read-only private scope) or
a GitHub App's OAuth credentials with Issues and Metadata read access. To create issues, an OAuth
App would need `public_repo` or `repo`, and a GitHub App needs Issues write access. Which OAuth
scope allows creating an issue is **not confirmed**: GitHub's scope page does not mention issues
under `public_repo` or `repo`, and no real GitHub account was tried.

### Creating issues

The switch is a row in the database, off after a first start or an upgrade, and only the admin can
change it (`PATCH /api/settings`). What it enforces depends on the path the token takes:

- **Token held by Keycloak:** the server checks the switch before it fetches the token, and
  refuses the create while it is off.
- **Token pasted in the browser:** only the interface enforces the switch. It hides the **+**
  buttons while the switch is off and re-reads the switch before each create, but the browser
  sends the request straight to `api.github.com`, which the server cannot refuse. Anyone holding a
  token with Issues write can create issues with it outside Urutau. The switch is a product
  setting, not a security boundary for pasted tokens: GitHub's permissions on the token decide
  what it can do.

Creating an issue notifies the repository's watchers, like creating it on github.com. GitHub
limits requests that create content (80 a minute, 500 an hour); Urutau reports a rejection and
does not retry.

**Downgrading past the switch.** Migration `0002_github_writes` adds the switch to the `meta`
table. An older server build refuses to start on a database that has run it, because Kysely
reports a missing migration. To go back to the older build, stop the server and run these two
statements against the database (they run on SQLite, PostgreSQL and MariaDB), then start the
older build:

```sql
DELETE FROM kysely_migration WHERE name = '0002_github_writes';
DELETE FROM meta WHERE meta.key = 'github_writes';
```

Upgrading again runs the migration and starts with the switch off.

## How issues are placed

Each issue's bucket is worked out every time the board renders (`resolveBuckets` in
[src/domain/board.ts](src/domain/board.ts)):

1. **Closed issues** always go to the bucket marked *Collect closed issues*. If no bucket is
   marked, they are hidden.
2. **Issues you moved** stay where you put them.
3. **Label rules.** Otherwise, an issue goes to the rightmost bucket that has one of its labels as a
   rule. On a workflow board, that is the most advanced stage.
4. **Everything else** goes to the first bucket.

Within a bucket, cards you have arranged keep their order. New issues appear below them, newest
first; closed issues are sorted by most recently closed. Deleting a bucket sends its issues back
through rules 3 and 4.

## Scripts

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Start the API server and the Vite dev server together |
| `npm run dev:web`   | Start only the Vite dev server (set `URUTAU_API_PORT` to the API's port) |
| `npm run dev:server`| Start only the API server, restarted on change |
| `npm start`         | Run the server, which also serves `dist/`      |
| `npm run build`     | Type-check and build the app to `dist/`        |
| `npm run preview`   | Serve the production build with Vite (proxies `/api`) |
| `npm test`          | Run the unit, component and server tests (Vitest, no network, no Docker) |
| `npm run test:watch`| Run the tests in watch mode                    |
| `npm run typecheck` | Type-check the app, the tooling and the server |
| `npm run lint`      | Lint with oxlint                               |
| `npm run test:db:postgres` | Run the `server/db` suite against PostgreSQL (opt-in) |
| `npm run test:db:mariadb`  | Run the `server/db` suite against MariaDB (opt-in) |
| `npm run test:keycloak`    | Run the Keycloak suite against a local Keycloak (opt-in); prints why it skips when Keycloak is not running |

CI (`.github/workflows/ci.yml`) runs lint, type-check, tests and build on every push and pull
request, and in a second job the PostgreSQL and MariaDB suites against service containers. It does
not run the Keycloak suite.

### Opt-in test containers

The default `npm test` is hermetic. The database and Keycloak suites need containers (Docker):

```bash
docker compose -f compose.db.yaml up -d --wait       # PostgreSQL on 55432, MariaDB on 53306
npm run test:db:postgres
npm run test:db:mariadb
docker compose -f compose.db.yaml down -v

docker compose -f compose.keycloak.yaml up -d --wait # Keycloak 26.8 on 58080, two realms imported
npm run test:keycloak
docker compose -f compose.keycloak.yaml down -v
```

`URUTAU_PG_PORT`, `URUTAU_MARIADB_PORT` and `URUTAU_KEYCLOAK_PORT` change the host ports. All
passwords and secrets in these files and in the realm files are development values. The Keycloak
file starts in development mode, so never use it as a deployment.

### Driving the app

For headless, scripted checks (screenshots, drag and drop, fake GitHub data instead of the real
API) there is a Playwright harness. It is mostly used by AI coding agents; see
[.claude/skills/run-urutau/SKILL.md](.claude/skills/run-urutau/SKILL.md). Its server mode runs the
real API server on an in-memory SQLite database, creates the admin through the first-run form and
can open a second signed-in browser for two-user checks such as live updates.

## Project structure

```
src/
├── domain/        Model and pure logic shared with the server (placement, filters, label colors, API types)
├── github/        GitHub REST client: pagination, error mapping, mapping to domain types, issue creation (createIssue.ts)
├── api/           Client for the server's /api
├── state/         Zustand stores: session, settings (token, theme) and the open board
├── hooks/         Data fetching (TanStack Query), live updates, theme and URL helpers
├── board/         Board UI: buckets, cards, drag and drop, dialogs (including CreateIssueModal.tsx)
├── components/    App shell: header, start page, settings, sign-in, users and server settings pages
└── styles/        Global Carbon styles
server/
├── main.ts        Starts the server (config, database, shutdown)
├── app.ts         The Hono app: middleware and routes
├── routes/        /api endpoints: auth, invites, users, boards, settings (the switch), events, GitHub reads and issue creation
├── db/            Kysely schema, migrations and one repository module per table
├── auth/          Passwords, sessions, CSRF and sign-in rate limits
├── oidc/          Keycloak sign-in and GitHub token brokering
├── boards/        Validation of board configs
├── events/        In-memory publisher for live updates
├── github/        Allow-list for the GitHub proxy, the rebuilt create-issue request
└── http/          Host allow-list, errors, request helpers
scripts/           dev.mjs
compose*.yaml      The app (compose.yaml) and the opt-in test containers
```

The GitHub layer maps API payloads into the types in [src/domain/types.ts](src/domain/types.ts), and
the UI only uses those types. Adding another provider (GitLab, Gitea, …) means writing another
`fetchRepoSnapshot`.

## Notes on the stack

- **Carbon styles** are compiled from Sass (`sass-embedded`). Carbon's default font path uses
  webpack's `~` prefix, so [src/styles/index.scss](src/styles/index.scss) points `$font-path` at
  `@ibm/plex` for Vite to bundle the fonts. Carbon's own Sass deprecation warnings are silenced
  with `quietDeps`.
- **Theming.** The Carbon theme class (`cds--white` / `cds--g100`) goes on `<html>`, so menus
  and modals that Carbon renders in portals are themed as well. A small inline script in
  `index.html` applies the saved theme before first paint.
- **Data fetching.** TanStack Query caches the GitHub snapshot for 5 minutes and doesn't refetch
  on window focus, to stay within the anonymous rate limit. Use **Refresh** to reload. Board
  changes by other people arrive over a server-sent events stream and are not cached that way.
- **Limits.** At most 1,000 open and 1,000 recently closed issues are loaded per board; a warning
  is shown when a repository has more. Pull requests are filtered out.

## Roadmap ideas

- More writes to GitHub from the board: editing, closing and reopening, labelling, assigning and
  commenting. Creating issues is the only write today.
- Boards stored in the repository itself (e.g. `.urutau.json`).
- Sign in with GitHub (OAuth/device flow) instead of pasting a token.
- UI copy in Portuguese as well as English.
- Issue detail panel with the rendered Markdown body and comments.
- Conditional requests (ETags) and virtualized columns for very large repositories.
- More providers: GitLab, Gitea/Forgejo.
- End-to-end tests with Playwright.

## License

[GPL-3.0](LICENSE)
