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
- **Issue details.** The button at the right end of a card's title row opens the issue in a
  modal: state, who opened it and when, last update, comment count, labels, assignees, milestone,
  a link to the issue on GitHub, and the description formatted from its Markdown (headings,
  lists, task lists, tables, code, quotes, links; images are never loaded: each shows as a link,
  or as its alt text when its address is refused). The modal is read only unless the admin has
  turned on *Create and edit issues on GitHub* (see *Edit, close and reopen issues* below). The
  description comes from the issue list the board already loads, so opening the modal makes no
  request to the GitHub API. The description is formatted in a Web Worker; one that takes more
  than a second to format is shown as plain text, with a notice.
- **Filters.** Search by title, number or author, and filter by label, assignee and milestone.
- **Light and dark themes** (Carbon White and Gray 100), following the system setting by default.
- **Shared boards and live updates.** Boards, buckets and card positions are stored on the server,
  and everyone signed in sees them. A board change by a teammate (buckets, card positions) appears
  in an open board without a reload, with a *Live* indicator and a *Board updated by …* notice.
- **Accounts.** Local username and password accounts, created from invite links by the admin, or
  sign-in with Keycloak.
- **Create issues.** When the admin turns on *Create and edit issues on GitHub* on the Server
  settings page (user menu, *Server settings*), each bucket header gets a **+** button. It opens a
  dialog for a title and an optional description, creates the issue on GitHub as the person who
  clicked, and puts the new card in that bucket. The closed-issues bucket has no **+**. The switch is off by
  default and is server-wide.
- **Edit, close and reopen issues.** With the same switch on, the issue details modal can edit the
  issue's title and description, close it as completed or as not planned, and reopen a closed one,
  on GitHub, as the person who clicked. It works with a token pasted in the browser and with a
  token held by Keycloak. A change (edit, close or reopen) is refused, with nothing sent, when the
  issue changed on GitHub since the edit started; see [Editing issues](#editing-issues). Labels, assignees, milestones and
  comments are not changed.
- **AI agents (MCP).** An admin can create agent integrations: accounts of their own that an AI
  agent uses to list boards, read them and move cards through Urutau's MCP server, with no
  access to GitHub beyond reading. See [AI agents (MCP)](#ai-agents-mcp).
- **Export and import** of a board as JSON, to move it to another server or share it. A board
  exported from another repository brings its buckets and rules, but not card positions.

Urutau reads issues and labels from GitHub and, when the admin turns on *Create and edit issues on
GitHub*, creates issues and changes an existing issue's title, description and state (open or
closed). It writes nothing else to a repository: no labels, assignees, milestones or comments.
Buckets, rules and card positions live in the server's database. Creating an issue adds no
labels, whatever the bucket's rules are. The moves an AI agent makes through MCP are Urutau-only:
they change card positions in Urutau's database and never write to GitHub.

## Getting started

You need Node.js 24 (see `.nvmrc`).

```bash
nvm use        # or install Node 24 another way
npm ci
npm run dev    # app at http://localhost:5173, API server at http://localhost:8787
```

`npm run dev` starts the API server (restarted on change) and the Vite dev server, which proxies
`/api` and `/mcp` to it. `PORT` changes the API port. The database is a SQLite file,
`data/urutau.db`, created on first start.

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
hour and is required for private repositories. There are three ways to give Urutau one:

1. **A token pasted in the browser** (local accounts, Keycloak accounts when `KEYCLOAK_GITHUB_IDP`
   is unset, and Keycloak users without a usable GitHub link). Create a
   [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
   with access to the repositories you want and these permissions: Issues (read-only to view a
   board, **read and write** to create or edit issues) and Metadata (read-only). Paste it in
   **Settings** (the gear icon). It stays in this browser's local storage, is sent only to `api.github.com`,
   and never reaches the Urutau server or a board export. Anyone with access to your browser
   profile can read it. A token with Issues write can create and edit issues in those
   repositories, so give it only the repositories you need, and use a token with Issues read-only
   if you only view boards.
2. **A token held by Keycloak** (Keycloak accounts, when `KEYCLOAK_GITHUB_IDP` is set). The user
   signs in to Keycloak with GitHub. The server asks Keycloak for the GitHub token and keeps it in
   server memory for up to 5 minutes per session, so it does not ask on every request. It drops the
   token at once when GitHub rejects it, on sign-out and on restart. The server forwards `GET`
   requests for issues, labels and repository data to `api.github.com`, one `POST` that
   creates an issue from a title and a description the server rebuilds itself, and, to change an
   issue, a `GET` that checks it and a `PATCH` with its title, description, or state and its
   reason (both sent once more with a fresh token after GitHub rejects an expired one); it
   forwards no other method and no other fields. The token is never stored
   in the database or sent to the browser. The user's Keycloak tokens are held in server memory
   too, and are not stored in the database either.
3. **A token stored for an agent integration** (only for the MCP endpoint). The admin gives an
   integration its own GitHub token on the Users page. The server encrypts it with
   `TOKEN_ENCRYPTION_KEY` before it stores it, decrypts it in memory when an agent asks for a
   board, and sends it only to `api.github.com`, in `GET` requests. It never reaches the browser,
   a log line or a board export, and no signed-in person's request uses it. See
   [AI agents (MCP)](#ai-agents-mcp).

## Deploying

**One-line installer.** Each release from the first packaged one on installs per user (no `sudo`),
with its own Node 24 and a service that starts at boot (Linux, systemd user unit) or at logon
(Windows, Scheduled Task):

```bash
curl -fsSL https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.ps1 | iex
```

It asks which address people will open. An unattended run listens on this computer only, and whoever
opens a new install first creates the admin account. Releases v0.1.0 to v0.5.0 have no bundle, so the
installer works from the next release on; until then use Docker or a checkout, below. macOS and Alpine
use Docker. Options, paths, upgrading and uninstalling: [docs/install.md](docs/install.md).

**From a checkout.** One Node process serves the built app, `/api` and `/mcp`:

```bash
npm ci
npm run build
npm start      # http://127.0.0.1:8787
```

`npm start` needs `server/`, `src/domain/`, `src/github/api.ts`, `src/github/paging.ts`, `dist/`,
`node_modules/` and `package.json`. (The MCP GitHub reader imports the two `src/github` files; the
rest of `src/github` is browser code.)

Or with Docker: `docker compose up -d --build` builds the image and runs it with a SQLite database
in a named volume (`<project>_urutau-data`, `urutau_urutau-data` by default), published on
`127.0.0.1:8787` (`URUTAU_HOST_PORT` changes the host port). The image listens on `0.0.0.0:8080`
inside the container and runs as the `node` user. `TOKEN_ENCRYPTION_KEY` is passed through to the
container if it is set in the shell or in a `.env` file.

Released images are published at `ghcr.io/oshogun/urutau`, tagged with the version (`X.Y.Z`):

```bash
docker run -p 127.0.0.1:8787:8080 -v urutau-data:/data ghcr.io/oshogun/urutau:X.Y.Z
```

How versions are numbered, how a release is cut and how to upgrade are in
[docs/release.md](docs/release.md).

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
address, which the sign-in rate limit and the `/mcp` failed-token limiter use. `X-Forwarded-Host`
is never read. A proxy must also forward `/mcp` and its `Authorization` header (see
[AI agents (MCP)](#ai-agents-mcp)).

### Run one instance only

Live updates, sign-in rate limits, pending Keycloak logins and Keycloak token grants are kept in the
memory of the single server process. So are the MCP endpoint's GitHub snapshot cache, its
per-account snapshot queue, its per-repository move lock, its failed-token limiter, its call and
GitHub request counters and the registry of calls in progress; a restart empties them. Do not run
two instances behind a load balancer: a change saved through one would not reach a browser connected
to the other. Restarting the server signs Keycloak users out of GitHub reads (their Urutau sign-in
survives; they sign in with Keycloak again to read GitHub through the server).

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
| `TRUST_PROXY` | `false` | `true` to take the client address from the last `X-Forwarded-For` entry. The sign-in rate limit and the `/mcp` failed-token limiter use that address. |
| `TOKEN_ENCRYPTION_KEY` | unset | 32 random bytes, base64 (`openssl rand -base64 32`). Without it the server stores no GitHub token for agent integrations. Keep it away from the place the database backups are kept; changing it makes stored tokens unreadable until they are set again. A value that is not 32 bytes of base64 stops the server at start. |
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
scope, `user:email`, reaches public repositories only and cannot create or edit issues. For private
repositories use an OAuth App with the `repo` scope (OAuth Apps have no read-only private scope) or
a GitHub App's OAuth credentials with Issues and Metadata read access. To create or edit issues,
an OAuth App would need `public_repo` or `repo`, and a GitHub App needs Issues write access.
Which OAuth scope allows creating or editing an issue is **not confirmed**: GitHub's scope page
does not mention issues under `public_repo` or `repo`, and no real GitHub account was tried.

### Creating and editing issues

The switch covers creating an issue and changing one (edit, close, reopen). It is a row in the
database, off after a first start or an upgrade from a build without it, and only the admin can
change it (`PATCH /api/settings`). A server where creating issues was already on keeps it on, and
that now also allows editing, closing and reopening, with no action by the admin. What it
enforces depends on the path the token takes:

- **Token held by Keycloak:** the server checks the switch before it fetches the token, and
  refuses the create or the change while it is off.
- **Token pasted in the browser:** only the interface enforces the switch. It hides the **+**
  buttons and the details modal's edit, close and reopen controls while the switch is off and
  re-reads the switch before each create or change, but the browser sends the request straight to
  `api.github.com`, which the server cannot refuse. Anyone holding a token with Issues write can
  create and edit issues with it outside Urutau. The switch is a product
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

#### Editing issues

The details modal has an *Edit* button for the title and description, and buttons for *Close as
completed*, *Close as not planned* and *Reopen*. Before it sends a change, Urutau reads the issue
from GitHub (one `GET`) and compares its last-update time with the one the modal showed when the
edit started. If they differ, the change is refused, nothing is sent, and the modal shows what the
issue looks like now; *Apply again* then sends the change on top of that version, unless GitHub
already has it, which the modal then says. A change that
goes through costs two GitHub requests (the read and the `PATCH`), and a refused one costs one;
on the Keycloak path, an expired token adds one or two more. These requests use the acting
person's token, never an agent integration's.

The check does not cover everything:

- A change someone makes on GitHub between Urutau's read and GitHub applying the `PATCH` is not
  seen. GitHub has no conditional `PATCH` for issues. Urutau sends only the fields the person
  changed. For a field it sends, Urutau's value wins; every other field keeps the other person's
  value.
- GitHub's last-update time has a one-second precision, so a change in the same second as the
  version the board read is not noticed.
- A change that does not move the last-update time (for example, labels added a second or two
  after the issue was created) causes no refusal. Urutau does not send labels, so it does not
  overwrite them.
- A new comment moves the time, so it also causes a refusal even though the title, description and
  state are unchanged. *Apply again* sends the same change.
- Teammates' boards and your other tabs are not told of the change until they reload the issues.

## AI agents (MCP)

Urutau serves a [Model Context Protocol](https://modelcontextprotocol.io/) endpoint at
`<PUBLIC_URL>/mcp` (`http://127.0.0.1:8787/mcp` on a default local start).
It takes JSON-RPC requests over HTTP `POST`; a request it accepts is answered as a
`text/event-stream`, and a refused one (400, 401, 403, 405, 406, 413, 415, 429, 503) as JSON. It offers four tools:

| Tool | What it does |
| --- | --- |
| `list_boards` | Lists the boards the integration may read. Reads only Urutau. |
| `get_board` | Returns one board as JSON: buckets and cards in the order people see them. Closed issues are left out unless asked for. |
| `move_card` | Moves one open issue's card to a position in a bucket. |
| `reorder_bucket` | Sets the order of the cards in one bucket in one save. |

**MCP moves are Urutau-only.** `move_card` and `reorder_bucket` change card positions in Urutau's
database and nothing on GitHub. No MCP request makes a non-`GET` request to GitHub, and the
endpoint cannot create or edit issues. Everyone with the board open sees an agent's move
live, labelled *Agent*. Issue titles, labels and other text come from GitHub and are untrusted:
an agent should treat them as data, not as instructions.

### Setup

1. **Set `TOKEN_ENCRYPTION_KEY`**: `openssl rand -base64 32`, in the server's environment. Without
   it the server starts, logs a warning, and cannot store a GitHub token for an integration.
2. **Create the integration.** As the admin, open *Users* in the user menu, then *Agent
   integrations*, and create one. It is an account of its own: it cannot sign in, it is never the
   admin, and its name shares the username namespace with people, so a name a person has is taken.
3. **Add repositories.** The integration can read only the boards of the repositories on its list
   (at most 200).
4. **Set its GitHub token.** Use a [fine-grained personal access
   token](https://github.com/settings/personal-access-tokens/new) with access to those repositories
   and read-only Issues and Metadata permissions. Urutau keeps it encrypted and uses it only for
   `GET` requests to `api.github.com`.
5. **Create an Urutau MCP token** for the integration (expiring in 30, 90 or 365 days, or never).
   Urutau shows it once and keeps only a fingerprint. It is the credential the agent sends as
   `Authorization: Bearer <token>`.

The *Connect an agent* box on the same page shows the configurations below with your server's URL.
Put the token in the environment variable `URUTAU_MCP_TOKEN`, or type it when the client asks.
**Never write the token itself into an MCP client's configuration file.**

### Client configuration

`<url>` is the endpoint address above.

**Claude Code**, from the command line (the single quotes keep your shell from expanding the
variable; Claude Code expands it when it connects):

```bash
claude mcp add --transport http urutau <url> --header 'Authorization: Bearer ${URUTAU_MCP_TOKEN}'
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "urutau": {
      "type": "http",
      "url": "<url>",
      "headers": { "Authorization": "Bearer ${URUTAU_MCP_TOKEN}" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "urutau": {
      "url": "<url>",
      "headers": { "Authorization": "Bearer ${env:URUTAU_MCP_TOKEN}" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`) asks for the token in a password prompt:

```json
{
  "inputs": [
    { "type": "promptString", "id": "urutau-token", "description": "Urutau MCP token", "password": true }
  ],
  "servers": {
    "urutau": {
      "type": "http",
      "url": "<url>",
      "headers": { "Authorization": "Bearer ${input:urutau-token}" }
    }
  }
}
```

**Clients that only start local programs** can use
[mcp-remote](https://www.npmjs.com/package/mcp-remote) 0.12.0 or later,
which reads headers from a file with `--header-file`. Write the file once, in a
terminal where `URUTAU_MCP_TOKEN` is set (the command stops without writing if it is unset):

```bash
mkdir -p ~/.config/urutau
(umask 077; printf 'Authorization: Bearer %s\n' "${URUTAU_MCP_TOKEN:?Set URUTAU_MCP_TOKEN first}" > ~/.config/urutau/mcp-headers)
chmod 600 ~/.config/urutau/mcp-headers
```

The file holds the token, so it is a credential file: keep it outside any repository and readable
only by you. The client configuration holds only its path, which must be the full path because
mcp-remote does not expand `~` (for example `/home/you/.config/urutau/mcp-headers`):

```json
{
  "mcpServers": {
    "urutau": {
      "command": "npx",
      "args": ["mcp-remote", "<url>", "--header-file", "/home/you/.config/urutau/mcp-headers"]
    }
  }
}
```

For an `http:` address add `"--allow-http"` to `args`. An older mcp-remote ignores `--header-file`,
connects without a token and gets 401. On Windows, put the line `Authorization: Bearer` followed by
the token in a text file in your user folder instead, and use a path without spaces. Do not use the
`env`-block form from mcp-remote's own README: it writes the token into the client's configuration.

### What the endpoint requires

- `POST` only; any other method with a valid token gets 405 (without one it gets 401, as every
  request does). A query string gets 400, so a token in the address is never
  read.
- Clients must send `Accept: application/json, text/event-stream`.
- A request whose `Origin` header is not Urutau's own address (the `PUBLIC_URL` origin, or the
  server's own host when `PUBLIC_URL` is unset) gets 403 `origin-rejected`. Desktop clients do not
  normally send `Origin`; one that sends its own is refused.
- A missing, wrong, revoked or expired token gets 401 `invalid-token`. A client may answer that with
  an OAuth or client-registration error: it means the Urutau MCP token is missing, wrong or revoked.
  The endpoint has no OAuth.
- The failed-token limiter answers 429 `too-many-attempts` to failed attempts from one address
  after 50 in 15 minutes. It limits answers to failures; it is not brute-force protection. A token
  guess is still looked up, and what makes guessing impractical is the token's 256 random bits.
  A valid token always passes. With `TRUST_PROXY=true` the address is the last `X-Forwarded-For`
  entry.
- A reverse proxy must forward `/mcp` and the `Authorization` header, and must not buffer
  `text/event-stream` answers. A proxy that does its own authentication must leave `/mcp` to
  Urutau's tokens.
- Urutau sends no CORS headers. A server reachable only on a LAN cannot be a claude.ai connector,
  because the connection comes from Anthropic's servers.
- If the client cancels a `move_card` or `reorder_bucket`, the change may still be saved: only a
  closed connection stops a running call. Call `get_board` to see the result.
- Send tokens over HTTPS. Over `http:` they cross the network unencrypted; the Users page warns
  when it is opened over plain HTTP.

### Limits

- Each integration's reads count against its own GitHub token. A cold board read takes 2 to 21
  GitHub requests, is cached for 60 seconds, leaves the last 10% of the token's hourly allowance
  alone, and the integration makes at most 1,000 GitHub requests an hour.
- 120 tool calls and 30 moves a minute per integration.
- At most 300 cards per `get_board` answer; name one bucket and raise `offset` to page through it.

### If a key or token leaks

An Urutau MCP token: revoke it on the Users page. Calls it is making stop at once. After a suspected
leak of `TOKEN_ENCRYPTION_KEY` or of the database, revoke each stored GitHub token **at GitHub**
first, then set a new one in Urutau. Clearing a token in Urutau only deletes the stored copy; it
does not revoke the token at GitHub. Changing the key makes stored GitHub tokens unreadable
until they are set again.

Use one integration per trust domain. Do not give one integration private repositories and an agent
that reads untrusted public content and can write elsewhere: text in an issue is untrusted input
to the agent.

### Downgrading past the integrations

Migration `0003_integrations` adds the integration tables. An older server build refuses to start
on a database that has run it:
`urutau: corrupted migrations: previously executed migration 0003_integrations is missing`. To go
back, stop the server and run these statements against the database in this order, then start the
older build. On SQLite, run `PRAGMA foreign_keys = ON;` first: the `sqlite3` command-line tool
starts with foreign keys off, and then the first statement would delete the integration accounts
without clearing `boards.updated_by`, leaving boards that point at deleted users.

```sql
DELETE FROM users WHERE id IN (SELECT user_id FROM integrations);
DROP TABLE integration_repos;
DROP TABLE api_tokens;
DROP TABLE github_tokens;
DROP TABLE integrations;
DELETE FROM kysely_migration WHERE name = '0003_integrations';
```

The first statement is optional: without it the integration accounts stay as `users` rows with no
password that an older build lists as Keycloak users who cannot sign in. If you also go back past
the issue switch, run the `0002_github_writes` statements from *Creating and editing issues*
afterwards.

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

The MCP endpoint applies the same rules but keeps the hand order of issues it has not loaded: a
new issue, or one past the 1,000-item cap. The browser does not keep those.

## Scripts

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Start the API server and the Vite dev server together |
| `npm run dev:web`   | Start only the Vite dev server (set `URUTAU_API_PORT` to the API's port) |
| `npm run dev:server`| Start only the API server, restarted on change |
| `npm start`         | Run the server, which also serves `dist/`      |
| `npm run build`     | Type-check and build the app to `dist/`        |
| `npm run preview`   | Serve the production build with Vite (proxies `/api` and `/mcp`) |
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
docker compose -p urutau-test-db -f compose.db.yaml up -d --wait             # PostgreSQL on 55432, MariaDB on 53306
npm run test:db:postgres
npm run test:db:mariadb
docker compose -p urutau-test-db -f compose.db.yaml down -v

docker compose -p urutau-test-keycloak -f compose.keycloak.yaml up -d --wait # Keycloak 26.8 on 58080, two realms imported
npm run test:keycloak
docker compose -p urutau-test-keycloak -f compose.keycloak.yaml down -v
```

`URUTAU_PG_PORT`, `URUTAU_MARIADB_PORT` and `URUTAU_KEYCLOAK_PORT` change the host ports. All
passwords and secrets in these files and in the realm files are development values. The Keycloak
file starts in development mode, so never use it as a deployment. Both files set their own project name
(`urutau-test-db`, `urutau-test-keycloak`), so the directory you run them from does not choose the
project, and the commands pass the same name with `-p`.

### Driving the app

For headless, scripted checks (screenshots, drag and drop, fake GitHub data instead of the real
API) there is a Playwright harness. It is mostly used by AI coding agents; see
[.claude/skills/run-urutau/SKILL.md](.claude/skills/run-urutau/SKILL.md). Its server mode runs the
real API server on an in-memory SQLite database, creates the admin through the first-run form and
can open a second signed-in browser for two-user checks such as live updates. For agent
integrations, `mcp-launcher.mjs` in the same directory starts the server with an in-memory
database, a development encryption key (it protects nothing) and GitHub answered from the
fixtures, and logs every request the server makes to GitHub (method, path, and whether an
`Authorization` header was present, never its value):

```bash
PORT=8788 node .claude/skills/run-urutau/mcp-launcher.mjs
```

## Project structure

```
src/
├── domain/        Model and pure logic shared with the server (placement, filters, label colors, issue change rules (issueUpdate.ts), API types)
├── github/        GitHub REST client: pagination (paging.ts), error mapping, mapping to domain types, issue creation (createIssue.ts) and changes (updateIssue.ts)
├── api/           Client for the server's /api, including the agent integration admin calls
├── state/         Zustand stores: session, settings (token, theme) and the open board
├── hooks/         Data fetching (TanStack Query), live updates, theme and URL helpers
├── markdown/      Issue-body parser (markdown-it to a plain tree) and the Web Worker that runs it with a time limit
├── board/         Board UI: buckets, cards, drag and drop, dialogs (including CreateIssueModal.tsx and IssueDetailModal.tsx)
├── components/    App shell: header, start page, settings, sign-in, users and server settings pages
└── styles/        Global Carbon styles
server/
├── main.ts        Starts the server (config, database, shutdown)
├── app.ts         The Hono app: middleware and routes
├── routes/        /api endpoints: auth, invites, users, agent integrations, boards, settings (the switch), events, GitHub reads and issue creation and changes
├── db/            Kysely schema, migrations and one repository module per table
├── auth/          Passwords, sessions, CSRF, sign-in rate limits, MCP bearer tokens, the secret box for stored GitHub tokens
├── oidc/          Keycloak sign-in and GitHub token brokering
├── boards/        Validation of board configs
├── events/        In-memory publisher for live updates
├── github/        Allow-list for the GitHub proxy, the rebuilt create-issue request, updateIssue.ts (the path and the check of GitHub's answer for the change route), reader.ts (the MCP endpoint's GitHub reads)
├── mcp/           The /mcp endpoint, its four tools, board JSON, snapshot cache, move and reorder, locks and call limits
└── http/          Host allow-list, errors, request helpers
scripts/           dev.mjs
compose*.yaml      The app (compose.yaml) and the opt-in test containers
```

The GitHub layer maps API payloads into the types in [src/domain/types.ts](src/domain/types.ts), and
the UI only uses those types. Adding another provider (GitLab, Gitea, …) means writing another
`fetchRepoSnapshot` and its own `createIssue` and `updateIssue`.

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
  is shown when a repository has more. Pull requests are filtered out. The MCP endpoint has its
  own limits (see [AI agents (MCP)](#ai-agents-mcp)).

## Roadmap ideas

- More writes to GitHub from the board: labelling, assigning and commenting. Creating issues and
  editing, closing and reopening them are the only writes today.
- Boards stored in the repository itself (e.g. `.urutau.json`).
- Sign in with GitHub (OAuth/device flow) instead of pasting a token.
- UI copy in Portuguese as well as English.
- Comments in the issue details modal.
- Conditional requests (ETags) and virtualized columns for very large repositories.
- More providers: GitLab, Gitea/Forgejo.
- End-to-end tests with Playwright.

## License

[GPL-3.0](LICENSE)
