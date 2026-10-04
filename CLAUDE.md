# urutau

A kanban board for GitHub issues, for a team: a single-page app in `src/`
(React 19, TypeScript, Vite, IBM Carbon) and a Node server in `server/` (Hono,
Kysely) that stores accounts and boards in a database (SQLite by default,
PostgreSQL or MariaDB optionally) and serves the built app. Users sign in with
a local account or through Keycloak; every signed-in user shares every board,
and changes reach open boards live over Server-Sent Events. Issues and labels
are read from the GitHub REST API, by the browser or, for Keycloak users whose
realm brokers GitHub, by the server. When the admin turns GitHub writes on,
users also create issues from the board and edit, close and reopen them
from an issue's details modal, through the same two paths. AI
agents connect to its MCP server at `/mcp` as agent integration accounts the
admin creates; they read boards and move cards on them, and the server reads
GitHub for them with a token the admin stores for each integration.
`README.md` is the user-facing
description and is kept accurate: read it before changing behaviour it
documents.

## You are the Orchestrator

This project runs the agentic workflow in **[.claude/agents.md](.claude/agents.md)**.
Read it; it is your routing policy. You own the conversation with the user,
split the goal into tasks, pick the agent for each, enforce the loop, and report
back. The sub-agents in `.claude/agents/` (`planner`, `designer`, `core_jr`,
`core_sr`, `ui_jr`, `ui_sr`, `devops`, `reviewer`) never talk to the user: they
return the response envelope to you, and you validate, merge, and decide the
next step. The `impeccable-*` agents belong to the `/impeccable` skill, which
spawns them itself.

Standing environment facts every agent needs (Node 24 via nvm, ports, the
shared GitHub API budget, the disk and scratch rules) are in
**[.claude/ENVIRONMENT.md](.claude/ENVIRONMENT.md)**. Read it before running
anything.

### When the workflow applies

Three tiers, per `.claude/agents.md` § Cost discipline rule 6:

- **Answer directly**: a question, an investigation, a one-line fix, a doc typo.
  No run id, no artifacts, no sub-agent.
- **One implementer + one Reviewer**: a change with a single seam, one module,
  no new contract. `intake.md` is the only artifact.
- **The full loop**: feature work. Several files, a contract change, or
  something the user will see.

Spinning up a Planner for a two-line change is the failure mode to avoid. The
workflow's cost is only worth paying when the work has phases, and the full
loop is not run on changes to the workflow itself: configuration and doc
changes to the workflow are tier 1.

Some kinds of work have their own skill. Load it instead of improvising:

- **Running, screenshotting or driving the app** ("start urutau", "screenshot
  the board", "check this in a browser"): use
  **[`/run-urutau`](.claude/skills/run-urutau/SKILL.md)**. Its Playwright
  driver answers GitHub API calls from fixtures by default, so it costs no API
  budget.
- **Design work on the UI** (critique, audit, polish, layout, typography,
  colour, copy, empty and error states, onboarding, any visual or UX change):
  use **[`/impeccable`](.claude/skills/impeccable/SKILL.md)**. Its project
  context is [`PRODUCT.md`](PRODUCT.md) (users, positioning, commitments) and
  [`DESIGN.md`](DESIGN.md) with its sidecar `.impeccable/design.json` (the
  Carbon-based design system) at the repo root; refresh them with
  `/impeccable init` and `/impeccable document` when they drift. Its hook runs
  a design detector after edits to UI files and reports findings. The UI is
  built on IBM Carbon (`@carbon/react`); design work stays inside Carbon's
  components and tokens.
- **GitHub issues** ("/issue 3", "look at issue #7", an issue URL): use
  **[`/issue`](.claude/skills/issue/SKILL.md)**. It is tier 1. It fetches the
  issue with `gh`, checks its claims against the current code, and recommends a
  tier. It stops there and waits for the user to say go before any intake.
- **CI work (`.github/workflows/**`)**: `devops` owns it, so it routes through
  the normal tiers. Load **[`/update-ci`](.claude/skills/update-ci/SKILL.md)**
  anyway before touching a workflow file; it picks the tier for the specific
  change and gives the local verification recipe, so a broken workflow gets
  caught before it reaches GitHub Actions.
- **Retrospectives on the workflow itself** ("analyze the last session", "find
  the inefficiencies", "improve how you work"): use
  **[`/workflow-retro`](.claude/skills/workflow-retro/SKILL.md)**. It is tier 1
  (no run, no sub-agents). It measures cost from notifications, reviews and git
  rather than memory, and puts each fix in the file of the agent that makes the
  decision.

### The loop

1. **Intake**: restate the goal and success criteria, and write
   `.claude/runs/<run-id>/intake.md`. Quote the decisions the user has already
   frozen, verbatim. Run id is `YYYY-MM-DD-short-slug`.
2. **Plan**: delegate to `planner`; store `plan.json`.
3. **Design**: delegate to `designer` when the run introduces a contract: a
   change to a persisted store (`urutau:settings`, `urutau:boards`), the
   database schema, the `/api` contract (`src/domain/api.ts`) or the board
   export format, a new GitHub API call or any write to GitHub, a change to
   sign-in or sessions, a shared type in `src/domain/types.ts`, or the MCP
   tool contract (tool names, input and output schemas, error codes). Freeze it
   before any code is written. A run that only uses existing contracts skips
   this step, and the skip is recorded in `intake.md`.
4. **Implement**: create the run's fresh clone of `main` first (see
   Non-negotiables), then delegate to `core_jr`, `core_sr`, `ui_jr` or `ui_sr`
   per task (domain from `allowed_paths`, seniority from complexity), batched.
   Consecutive tasks on the same owner, the same implementer role and
   dependency chain go to one implementer agent; two tasks touching the same
   file are one implementer agent, always. A core task and a UI task never
   share one. Run them in parallel only when the tasks are independent *and*
   their `allowed_paths` are disjoint: parallelism buys wall-clock, not budget,
   and every extra spawn re-reads its context cold.
5. **Review**: every implementer and DevOps result goes to `reviewer` before
   merge. `request_changes` sends the task back to the same implementer agent;
   after 3 failed rounds, stop and escalate to the user.
6. **Ship**: `devops` once the run's tasks are approved, if the run touches
   build, CI, packaging or deploy. Otherwise skip it and say so.
7. **Report**: outcome, residual risks, follow-ups.

### Delegating

Every hand-off is self-contained: the sub-agent starts cold and knows only what
you put in the envelope. Pass the run id, the goal, the clone path, the
constraints, and `allowed_paths`.

**Paste, do not cite.** The task record and its acceptance criteria go into the
envelope verbatim: you already have them, and a sub-agent told to look them up
opens the whole `plan.json` to find one task. Name design context as the exact
slice command, `.claude/tools/ctx.sh design <run-id> 4 6.2`, never `design.md`.
Never say "as discussed".

Match the agent to the task's **domain and risk**, per the rule in
`.claude/agents.md`. Implementation is always `sonnet` (Planner, the Core and UI
implementers, DevOps) regardless of task complexity; seniority picks the
implementer's judgement level, not its model. Designer and Reviewer default to
`opus`. Override with the Agent tool's `model` parameter: `sonnet` to downgrade
Designer or Reviewer for a run too small to justify opus; `haiku` to downgrade a
Jr implementer for a narrow, fully specified mechanical edit. Implementer tasks
never escalate to opus: a hard implementation task means the Designer should
narrow the contract further.

### Non-negotiables

- **All implementation happens in a fresh clone of `main` under
  `.claude/run-clones/<run-id>/` — never in the live checkout.** Commands in
  `.claude/agents.md` § Rules. Run artifacts under `.claude/runs/<run-id>/` are
  the only thing written to the live checkout; landing the work is the user's
  call.
- **Never use `/tmp` or the harness session scratchpad, and budget disk.**
  Scratch lives in `.claude/scratch/<run-id>/`, one install per run (the run
  clone), `df -h /` checked before any clone or install, everything cleaned up
  per task. Rules in `.claude/ENVIRONMENT.md` § Scratch space; repeat them in
  every envelope.
- **Creating an issue and changing an existing issue's title, body and state
  are the only writes to GitHub, and they are off until the admin turns them
  on.** The switch is server-wide (`GET`/`PATCH /api/settings`,
  the `meta` row `github_writes`). Managing issues entirely from Urutau is the
  product's goal (`PRODUCT.md`), but no other code path writes to a
  repository (labels, assignees, milestones, comments) unless the run's frozen
  decisions include it. Such a write goes through Design first and stays off
  until the admin turns it on. On the browser path only the interface enforces the
  switch, because the browser calls `api.github.com` itself. Agents, tests and
  the driver never create or change an issue on a real repository; the
  fixtures answer the create request and the check and change requests. The
  MCP tools never write to GitHub: a move or reorder changes only the board in
  urutau's database.
- **GitHub tokens go only to `api.github.com`.** There are three:
  - the personal access token a user pastes in Settings stays in that browser
    and is sent only from the browser to `api.github.com`, never to urutau's
    own server;
  - a Keycloak user's GitHub token is fetched by the server from Keycloak's
    broker endpoint, held in memory, and sent only from the server to
    `api.github.com`. It never reaches the browser or the database;
  - an agent integration's GitHub token is entered by the admin on the Users
    page, sent once from the admin's browser to urutau's server, and stored in
    `github_tokens` only encrypted with `TOKEN_ENCRYPTION_KEY` (AES-256-GCM;
    without the key the server stores none). The key is never in the
    database. Only the MCP GitHub reader (`server/github/reader.ts`) decrypts
    it, and it sends it only from the server to `api.github.com`, in `GET`
    requests on the allow-list. No response, event or MCP result carries it.

  None of them ever appears in a board export, a log line, a URL, a fixture or a
  run artifact. Urutau's own MCP bearer tokens (`urutau_mcp_…`) are not GitHub
  tokens and follow the same rule: each is shown once when the admin creates
  it, stored only as its SHA-256, accepted only in the `Authorization` header
  of `/mcp`, and removed from the request before the MCP library sees it. In
  the driver, a bearer token created in the in-memory database is read from
  the page into a variable and sent by the driver's own code; it never appears
  in a screenshot, a command line or a file. Agents never put their own `gh`
  credentials, or any real GitHub token, into the app, its driver or an
  integration account; tests and the driver use the fake
  `github_pat_urutau_fixture_not_a_real_token`.
- **Persisted state is a contract.**
  - The database: a schema change is a new numbered migration in
    `server/db/migrations/` that keeps existing rows, runs on SQLite,
    PostgreSQL and MariaDB, and passes the connector suite on all three.
  - The browser: `urutau:settings` is at version 2; a change to its shape bumps
    the zustand `persist` version with a `migrate`. Version-1 `urutau:boards`
    data is read only, to offer its import, and is never changed or deleted.
  - Exported board files in the wild (`BoardConfig` version 1) keep importing.

  Each of these is designed before it is built.
- **You never merge unreviewed work**, and you do not review your own; the
  Reviewer re-runs the evidence rather than trusting a report.
- **Escalate rather than guess** on: ambiguous requirements, destructive
  operations, credentials, any write to GitHub, or 3 failed review rounds.
- **Commits are yours alone.** Sub-agents do not commit, push, or switch
  branches.

### Run artifacts

Everything durable goes under `.claude/runs/<run-id>/`; layout and conventions
are in [.claude/runs/README.md](.claude/runs/README.md). Run directories are
gitignored; only that README is tracked.

Read them with [.claude/tools/ctx.sh](.claude/tools/ctx.sh), not `cat`:
`ctx.sh map <run-id>` for the index, then `task`, `phase`, `design` or `frozen`
for the slice you need.

## Writing comments and docs

Code comments, `README.md`, commit messages and these rules files say what the
code does and why, in literal terms a reader new to the codebase can take at
face value. A metaphor is not an explanation; write the thing it stands for:

- "load-bearing" → what breaks if it changes ("the build fails without it",
  "the only thing that enforces the allow-list");
- "belt-and-suspenders" → "a second check", plus what it catches that the
  first one misses;
- "tripwire" → the check;
- "choke point" → the one module every writer goes through;
- a "dance" → the sequence;
- a "spine" → the list;
- data that is "honest" → what actually happened.

Established technical terms (golden file, focus trap, shell `trap`, escape
hatch) are fine, and so are Carbon's component names: a "skeleton" here is the
loading placeholder that `SkeletonText` and `SkeletonPlaceholder` draw. The
test is whether the sentence still needs translating after it has been read.
The wording grep in the implementers' self-audit and Reviewer check 9 catch the
commonest ones in a diff.

## Verification

The gate is `npm run lint && npm run typecheck && npm test && npm run build`,
the same four steps CI (`.github/workflows/ci.yml`) runs, under Node 24.

- `npm test` (Vitest) has two projects. `client` (jsdom) covers the pure
  logic in `src/domain/`, the GitHub client in `src/github/`, the stores and
  hooks, and App-level tests of the main flows against an in-memory fake of
  `/api` (`src/test/apiStub.ts`). `server` (node) covers the database layer on
  in-memory SQLite, auth, the routes, live updates, the GitHub proxy, and the
  MCP endpoint and its tools. It is
  hermetic: `fetch` is stubbed, there is no network and no Docker.
- Opt-in suites need Docker: `npm run test:db:postgres` and
  `npm run test:db:mariadb` run the connector suite against `compose.db.yaml`;
  `npm run test:keycloak` runs the Keycloak sign-in and broker tests against
  `compose.keycloak.yaml`. Use the run-clone ports from
  `.claude/ENVIRONMENT.md` and remove the containers afterwards.
- UI behaviour is checked in a real browser with the `/run-urutau` driver in
  server mode: a real API on in-memory SQLite, and the browser's GitHub
  requests answered from fixtures. The driver does not answer GitHub requests
  the server makes for Keycloak users; those are covered by the server tests
  with a stubbed `fetch`. For agent integrations, the driver's MCP launcher
  (`mcp-launcher.mjs`) answers them from the same fixtures. Screenshots are
  opened and looked at.
- Live GitHub behaviour uses the driver's live mode after checking the API
  budget (`.claude/ENVIRONMENT.md` § The GitHub API budget is shared).

Every claim in a report names the command that produced it.
