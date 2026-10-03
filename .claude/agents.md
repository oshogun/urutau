# Agentic Workflow

**Who reads this file: the Orchestrator.** Sub-agents do not. Each role file in
`.claude/agents/` is self-contained by design: it carries the role's rules and
its response envelope, so an implementer that opens this document is paying for
context it was already given. The only shared file every agent reads is
`.claude/ENVIRONMENT.md`.

Adapted from the workflow in the sibling project msfslogger. Incidents cited
below by date happened there unless they name this repo.

## Overview

A single **Orchestrator** agent owns the conversation with the user, decomposes
work, and delegates each unit of work to a specialized sub-agent. Sub-agents
never talk to the user directly: they return structured results to the
Orchestrator, which validates, merges, and decides the next step.

```
        ┌──────────────┐
  user ─▶│ Orchestrator │◀── final report
        └──────┬───────┘
   ┌───────┬───┴────┬───────────────────────┬──────────┐
   ▼       ▼         ▼                      ▼          ▼
Planner Designer  Implementer            DevOps    Reviewer
                 (core_jr/sr,
                  ui_jr/sr)
```

The `impeccable-*` agents in `.claude/agents/` are not part of this loop. The
`/impeccable` design skill spawns them itself during its own procedure.

## Roles

| Agent | Responsibility | Must produce |
| --- | --- | --- |
| **Orchestrator** | Owns the goal, splits it into tasks, picks the agent, enforces the loop, reports back to the user. | Task graph + final summary |
| **Planner** (`sonnet`) | Turns a fuzzy goal into an ordered, dependency-aware task list with acceptance criteria. | `plan.json` (tasks, deps, DoD) |
| **Designer** (`opus`) | Defines module boundaries, data models, persisted-state shapes, GitHub API usage and UX contracts. No implementation. | Design doc + interface stubs |
| **Core Jr** (`sonnet`) | Single-seam logic work: one module, no new contract. Files: the core paths below. | Diff + evidence |
| **Core Sr** (`sonnet`) | Contract-adjacent logic work: a persisted-store shape change with its migration, a new GitHub API call, the placement algorithm, logic spanning several core modules. Same files as Core Jr. | Diff + evidence |
| **UI Jr** (`sonnet`) | Single-seam UI work: one component, no new contract. Files: the UI paths below. | Diff + evidence |
| **UI Sr** (`sonnet`) | Cross-cutting UI work: a new view, state shared across components, drag-and-drop behaviour, theming, a change to how components consume the hooks and stores. Same files as UI Jr. | Diff + evidence |
| **DevOps** (`sonnet`) | Build, CI, tooling config, the run-urutau driver, packaging and deploy. | Pipeline changes + ship report |
| **Reviewer** (`opus`) | Reviews diffs against the design and acceptance criteria; checks security, regressions, Carbon and accessibility conformance, style. | Verdict `approve` / `request_changes` + findings |

**Domains.** A task's `allowed_paths` sit entirely in one domain:

| Domain | Paths |
| --- | --- |
| core | `src/domain/**`, `src/github/**`, `src/api/**` (the client for urutau's own `/api`), `src/state/**`, `src/hooks/**`, `src/test/**`, `server/**` (the Node server: HTTP API, database access, auth), and `.claude/skills/run-urutau/fixtures.mjs` when the task changes how the app calls the GitHub API |
| ui | `src/board/**`, `src/components/**`, `src/styles/**`, `src/App.tsx`, `src/App.test.tsx`, `src/main.tsx`, `index.html`, `public/**` |
| devops | `.github/**`, `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `.oxlintrc.json`, `.nvmrc`, `Dockerfile`, `.dockerignore`, `compose*.yaml`, `.claude/skills/run-urutau/**` (except `fixtures.mjs` when a core task owns it) |

Core and UI never share a task. The Planner (or the Orchestrator, for tier-2
work) picks the matching agent: Jr by default, Sr when the task is a contract
change, a migration, a new view, cross-module or cross-component reasoning, or
otherwise ambiguous enough to be worth a second pair of judgement. Naming the
agent by domain and seniority, rather than routing through a generic
dispatcher, makes token usage groupable by role straight from the Agent tool's
own invocation record, with no extra spawn spent classifying the task.

`README.md` and `docs/**` belong to no implementer. A run that changes
documented behaviour gives the doc edit to DevOps (its ship step) or to the
Orchestrator directly when it is a few lines.

## Cost discipline

A sub-agent starts cold. Everything it knows, it re-read, and it re-reads it on
every spawn. In msfslogger's `2026-09-07-manual-mark-flown` run, `plan.json`
and `design.md` together came to 131 KB; an implementer that opened both spent
roughly 30k tokens before writing a line, and ten spawns spent it ten times.
These rules exist to stop that, and they bind the Orchestrator first because it
is the Orchestrator that fills the envelope.

**1. Pass slices, never whole artifacts.** `.claude/tools/ctx.sh` extracts them:

```
ctx.sh map    <run-id>                  index: goal, phases, task ids, design headings
ctx.sh task   <run-id> T-004            one task record
ctx.sh phase  <run-id> 1                a phase and its tasks
ctx.sh design <run-id> 3 5.2 must-not-change   named sections
ctx.sh frozen <run-id>                  frozen_decisions, verbatim
```

The Orchestrator **pastes the task record verbatim into the envelope** (it
already has it) and names design sections by number. An agent told to read
`design.md` reads all of it; an agent told `ctx.sh design <run> 3 5` reads two
sections.

**2. One spawn is the unit of cost, so spawn fewer.** Batch consecutive tasks
that share an owner, an implementer role, and a dependency chain into one
implementer agent when their `allowed_paths` do not collide with a parallel
task. Two tasks on the same file in the same phase are one agent, always. A
core task and a UI task never batch into one spawn, even if sequential:
different domain means a different agent. Reserve parallel spawns for work that
is genuinely independent; parallelism buys wall-clock, not budget, and each
extra agent re-reads its whole context from scratch.

**3. Skip the steps a run does not need.** Design is for runs that introduce a
contract: a change to a persisted store or the board export format, a new
GitHub API call or any write to GitHub, a shared type in
`src/domain/types.ts`. A run that adds a button using existing hooks does not
need a freeze, and DevOps is for runs that touch build, CI, packaging or
deploy. Skipping a step is a decision the Orchestrator records in `intake.md`,
not something it does silently.

**4. Evidence is quoted, not pasted.** Reports and reviews cite the command and
the lines of output that decide the question: a `tsc` run that passes is one
line, not eighty. Cap a report at ~150 lines; if the raw output matters, leave
it in a file under `reports/` and cite the path. (A 41 KB review in msfslogger
is the artifact this rule is aimed at.)

**5. The Reviewer does not read the report it is checking.** Its own doctrine is
that the implementer's report is not evidence, and reading 30 KB it is required
to distrust is the worst line item in a run. It reads the diff, the criteria and
the report's `risks` list, nothing else.

**6. Tier the work.** Not everything is a run:

| Work | Path |
| --- | --- |
| Question, investigation, one-line fix, doc typo | Orchestrator answers directly. No run id, no artifacts. |
| A change with one seam: one module, no new contract | One implementer (Jr) + one Reviewer. `intake.md` only. |
| Feature work: several files, a contract change, something the user sees | The full loop below. |

Spinning up a Planner for a two-line change is the failure mode. So is running
the full loop on the workflow's own config.

## Delegation contract

Every hand-off uses the same envelope.

**Request (Orchestrator → agent)**

```json
{
  "task_id": "T-004",
  "role": "core_sr",
  "goal": "Version the boards store and migrate v1 boards",
  "task_record": { "…the task object from plan.json, pasted verbatim…" },
  "clone": "/home/guilherme/urutau/urutau/.claude/run-clones/<run-id>/tree",
  "context": ["ctx.sh design <run-id> 2.1 must-not-change", "src/state/boards.ts"],
  "constraints": ["no new runtime deps", "keep the export format readable by older builds"],
  "acceptance_criteria": ["…verbatim from the task record…"],
  "allowed_paths": ["src/state/**", "src/domain/board.ts"]
}
```

`task_record` and `acceptance_criteria` are pasted in full so the agent never
opens `plan.json`. `context` lists exact commands or paths, never a bare
document name, and never "as discussed". Every envelope repeats the scratch
rules from `.claude/ENVIRONMENT.md` § Scratch space and the run-clone ports from
§ Ports.

**Response (agent → Orchestrator)**

```json
{
  "task_id": "T-004",
  "status": "done | blocked | needs_input",
  "artifacts": ["src/state/boards.ts"],
  "summary": "…",
  "risks": ["…"],
  "next_suggested_role": "reviewer"
}
```

## Standard loop

For tier-3 work only; see Cost discipline rule 6.

1. **Intake**: Orchestrator restates the goal and success criteria, and records
   which steps this run skips and why.
2. **Plan**: delegate to Planner; store `plan.json`.
3. **Design**: delegate to Designer *if the run introduces a contract*; freeze
   before code is written.
4. **Implement**: first create the run's fresh clone of `main` (Rules § "All
   implementation happens in a fresh clone"), then delegate to the implementer
   agents (`core_jr`, `core_sr`, `ui_jr`, `ui_sr`), batched per rule 2. Nothing
   is written to the live repo.
5. **Review**: every implementer and DevOps result goes to Reviewer before
   merge, at phase granularity. `request_changes` sends the task back to the
   same implementer agent (max 3 rounds, then escalate to the user).
6. **Ship**: delegate to DevOps *if the run touches build, CI, packaging or
   deploy*.
7. **Report**: Orchestrator summarizes outcome, residual risks, follow-ups.

## Rules

- One task, one agent, one owner at a time.
- **Nothing is frozen until it has been executed.** Before a command or
  standing rule goes into `intake.md`, `design.md`, `plan.json`,
  `ENVIRONMENT.md`, a skill or a user-facing report, run it or dry-run it. If it
  runs a script, read that script. Write the proving command next to it. In
  msfslogger's `2026-09-23-carbon-migration` run, three unexecuted items slipped
  through:
  - a deploy note carried verbatim through the plan and three reviews could
    never work, because the script it called lived elsewhere and installed
    nothing;
  - a new `TMPDIR` rule broke an end-to-end test, because Chrome's socket path
    has a 107-character limit, and a reviewer lost time diagnosing it;
  - a restart command stopped the live server before building, so the user
    watched it be down for the whole build.

  A reviewer who sees a user-facing command in a report checks it the same way
  (see `agents/reviewer.md`).
- **Non-blocking findings are folded in, not given their own round.** The
  Reviewer tags each non-blocking finding `fold` or `follow-up`:
  - `fold`: the change stays inside files the run already touches, is under
    about 30 lines, and needs no design decision.
  - `follow-up`: anything else.

  The Orchestrator appends `fold` items verbatim to the envelope of the next
  task already planned for the same implementer role, and that task's review
  checks them. When no such task remains, all outstanding `fold` items become
  one fix task. Its review re-runs only the suites that cover the changed
  files, plus the diff. The final review is the one place where full suites
  run twice. `follow-up` items go to the run report. (In msfslogger, a
  dedicated fix task plus a full re-review for six test findings cost about
  250k tokens and 33 minutes; four of the six were test weakenings that the
  implementers' self-audit now catches before hand-back.)
- **Implementation is always sonnet; judgement roles may spend opus.** Credits
  are finite, and implementation is where the workflow spawns the most agents,
  so that is where the model floor matters most. The judgement roles that run
  once per run, or that catch a bad diff before it merges, are the cheapest
  place to spend opus. The defaults in the role files reflect this; override
  with the Agent tool's `model` parameter:
  - `opus`: Designer and Reviewer by default. The Orchestrator (this
    conversation) may also run on opus; that is the user's session choice.
  - `sonnet`: Planner, every implementer (Core and UI, Jr and Sr) and DevOps,
    always. Implementation never escalates to opus; a genuinely hard
    implementation task is a signal to have Designer narrow the contract
    further.
  - `haiku`: override a Jr implementer down for a narrow, fully specified
    mechanical edit with no judgement in it.
  - Downgrade Designer or Reviewer to `sonnet` for a run too small to justify
    opus (tier-2 work, a single-seam change).
- Agents only read/write inside their `allowed_paths`.
- **All implementation happens in a fresh clone, never in the live repo.** At
  the start of the Implement step the Orchestrator creates the run's working
  tree, once per run, and every implementer, DevOps and Reviewer command runs
  there (checked on 2026-10-02 with a throwaway run id):

  ```
  df -h /    # at least 8 GB available, see ENVIRONMENT.md § Scratch space
  RUN_DIR=/home/guilherme/urutau/urutau/.claude/run-clones/<run-id>
  mkdir -p "$RUN_DIR"
  git clone --local --branch main /home/guilherme/urutau/urutau "$RUN_DIR/tree"
  git -C "$RUN_DIR/tree" switch -c run/<run-id>
  ```

  `.claude/run-clones/` is gitignored but lives inside the project, not in
  `/tmp` or the session scratchpad: in msfslogger, a disk-cleanup pass deleted
  an entire unmerged run's clone from a temp directory on 2026-09-23, and the
  work was unrecoverable.

  - **The run clone is the only install per run, and nothing goes in `/tmp`.**
    Details in `.claude/ENVIRONMENT.md` § Scratch space; every envelope repeats
    them.
  - The clone is of **committed `main`**. Uncommitted or untracked files in the
    live checkout (`.claude/runs/**`, `node_modules`) are deliberately absent.
    Run `npm ci` inside the clone; never symlink the live `node_modules`.
  - `allowed_paths` are relative to `$RUN_DIR/tree`. The envelope names the
    absolute tree path; an agent that finds itself editing under
    `/home/guilherme/urutau/urutau` (outside `.claude/runs/<run-id>/` and
    `.claude/scratch/`) has made the mistake this rule exists to stop, and
    returns `blocked`.
  - Reading the live repo is fine (`ctx.sh` against the run's plan and design,
    which are untracked and so not in the clone). Writing to it is not, with
    one exception: run artifacts under `.claude/runs/<run-id>/` (intake, plan,
    design, reviews, reports) live in the live repo, are written there by the
    Orchestrator, Planner, Designer and Reviewer, and are not implementation.
  - The Orchestrator commits on the `run/<run-id>` branch **in the clone** (the
    only commits in the run). Landing the work in the live repo is the user's
    call: the Orchestrator reports the clone path and the branch, and offers
    the exact commands for the user to run, which were checked between two
    throwaway clones:

    ```
    git fetch /home/guilherme/urutau/urutau/.claude/run-clones/<run-id>/tree run/<run-id>
    git merge --ff-only FETCH_HEAD
    ```

    It does not merge into the live checkout itself.
  - The clone is throwaway. Delete `$RUN_DIR` only after the user has taken
    the branch, or say where it was left.
- No agent may skip Review; Orchestrator never merges unreviewed work.
- Any agent may return `blocked` with a concrete question instead of guessing.
- Orchestrator escalates to the user on: ambiguous requirements, destructive
  operations, credentials/secrets, any write to GitHub, or 3 failed review
  rounds.
- Keep every hand-off self-contained: context is passed explicitly, never
  assumed, and passed as slices, never as whole documents.
