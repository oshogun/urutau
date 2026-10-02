---
name: update-ci
description: Add, change, or debug a step or job in .github/workflows/ci.yml (or add a new workflow file). Use for "add a step to CI", "CI is failing", "add caching or a new check to the pipeline", "wire X into CI". CI already has an owner in .claude/agents.md (devops); this skill picks the tier for a CI-shaped change and gives the recipe that runs the workflow's commands locally first, so nobody debugs a workflow by pushing and watching Actions fail. Not for a feature run that happens to include a CI task as one of several tasks (that's the standard loop, with devops as one of the implementers).
---

You are running the **update-ci** skill as the Orchestrator defined in
`.claude/agents.md`. This is a reference for CI-shaped work, not a replacement
loop: `devops` already owns `.github/workflows/**`, so a CI change routes
through the normal three tiers in `CLAUDE.md` § When the workflow applies. What
this skill adds: which tier a CI change usually is, this repo's CI facts, and a
verification recipe that catches a broken workflow *before* it reaches GitHub
Actions.

## Why verify locally first

A workflow bug (wrong indentation, a step that references an env var never set,
a script that only works with files the runner's clean checkout lacks) is cheap
to catch locally and expensive to catch by pushing: each iteration costs CI
minutes and a round trip, and sub-agents do not commit or push, so a broken
workflow that reaches `main` sits there until someone notices. Run every command
the workflow will run, by hand, in a clean clone, before considering the diff
done.

## Tier for a CI change

- **Tier 1, answer and fix directly.** Bump a pinned action version, fix a
  typo in a step `name:`, reorder two steps with no dependency between them,
  correct an env var name that is clearly wrong. No run id.
- **Tier 2, one `devops` + one `reviewer`, `intake.md` only.** Add a step or
  job that reuses a pattern already in the workflow: another `npm run …`
  step, an `actions/upload-artifact` call, a cache for an existing install.
  Single seam, no new infrastructure contract. This is the common case.
- **Tier 3, the full loop with Design first.** The change introduces a pattern
  future CI work will build on: a deploy target (GitHub Pages or anything
  else), a secret, a matrix build, or browser tests in CI. Browser tests need
  Chromium on the runner (`npm ci` installs the `playwright` package but no
  browser), which is a provisioning decision to freeze in `design.md`: the
  install step, its cost in minutes and download size, and the teardown.

## This repo's CI facts

- **One workflow file**, `.github/workflows/ci.yml`: on push to `main` and on
  pull requests, one job `check` on `ubuntu-latest` with
  `actions/checkout@v7`, `actions/setup-node@v7` (`node-version-file: .nvmrc`,
  `cache: npm`), then `npm ci`, `npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build`. Add a job to this file rather than a second file
  unless the user explicitly wants a separately triggered pipeline (a
  schedule-only job, say).
- **Node 24** comes from `.nvmrc` on the runner. Locally, use nvm for every
  command (`.claude/ENVIRONMENT.md` § Use Node 24): the machine's default
  `node` is 26.
- **npm 11 blocks dependency install scripts** on the runner as it does locally,
  so a dependency that needs its install script will not get it in CI either.
  The local dry run shows the same `install-scripts` warnings.
- **No secrets are used today.** A step that needs one is escalated to the
  user, never added with a placeholder.

## The verification recipe

Run it in the run's clone (`.claude/agents.md` § Rules), or a throwaway clone
for tier 1. Never `/tmp`: clones live under `.claude/run-clones/`.

```bash
df -h /    # at least 8 GB available
RUN_DIR=/home/guilherme/urutau/urutau/.claude/run-clones/<run-id>
mkdir -p "$RUN_DIR"
git clone --local --branch main /home/guilherme/urutau/urutau "$RUN_DIR/tree"
git -C "$RUN_DIR/tree" switch -c run/<run-id>
cd "$RUN_DIR/tree"
# edit .github/workflows/ci.yml here, then check that it still parses:
python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/ci.yml')); print([s.get('run') or s.get('uses') for s in d['jobs']['check']['steps']])"
source ~/.nvm/nvm.sh && nvm use
npm ci
# then run, in order, exactly the commands the new or changed steps run, e.g.
npm run lint && npm run typecheck && npm test && npm run build
```

Confirm afterward that nothing is left listening on a port you opened and that
the throwaway clone is deleted (or, for a run, left for the user to land).

## Reviewer brief for a CI diff

Whether tier 2 or tier 3, the Reviewer pass should specifically:

- Re-diff `.github/workflows/ci.yml` (and any other changed file) itself, not
  read the implementer's report of it.
- Confirm step and job ordering, `needs:`, working directory and env vars match
  what was intended (the task record, or the frozen design for tier 3) exactly.
- Confirm every new step runs only against the runner's own ephemeral checkout:
  no step reaches a real, persisted resource or the user's GitHub data.
- Confirm a failure in the new step actually fails the job. Check that `if:`
  conditions such as `!cancelled()` versus `failure()` suit what they gate: a
  report-upload step usually runs on `!cancelled()` so it uploads even for a
  passing run, and a debug-artifact step usually wants `failure()` only.
- Name, as a standing non-blocking risk: making the job a required status check
  is a GitHub repository setting (Settings → Branches → Branch protection rules
  → Require status checks to pass before merging), and no workflow file can
  enable it.

## Committing

Same discipline as any Orchestrator commit: check `git status` for unrelated
in-progress work before staging, stage only the files this change touched, and
don't push unless asked.
