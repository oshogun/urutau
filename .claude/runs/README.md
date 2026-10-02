# Run artifacts

One directory per run: `.claude/runs/<run-id>/`, where `<run-id>` is
`YYYY-MM-DD-short-slug` (e.g. `2026-10-05-label-write-back`).

A run directory is the durable record of one feature: what was asked, what was
frozen, what was built, what was checked, and what shipped. It is written by the
agents in `.claude/agents/` and is the context a later run reads to understand a
decision. Run directories are gitignored; this README is the only tracked file
here.

```
.claude/runs/<run-id>/
├── intake.md          Orchestrator — goal restated, success criteria,
│                      decisions the user froze, steps skipped and why
├── plan.json          Planner    — phases, tasks, deps, allowed_paths,
│                      acceptance criteria
├── design.md          Designer   — the freeze, alternatives, must-not-change
├── contracts/         Designer   — type stubs, store shapes, sample payloads
│                                   (reference only, not wired into the build)
├── prototypes/        Designer   — throwaway scripts that validated an
│                                   assumption against real input
├── reviews/           Reviewer   — one file per phase or task, verdict at top
├── reports/           Implementer / DevOps — evidence: commands and their output
└── tools/             one-off checkers worth keeping for the next run
```

Read a run with `.claude/tools/ctx.sh`, never `cat`. Every agent that opens a
whole `plan.json` or `design.md` pays for all of it:

```
ctx.sh map    <run-id>                index: goal, phases, task ids, design headings
ctx.sh task   <run-id> T-004          one task record
ctx.sh phase  <run-id> 1              a phase and its task records
ctx.sh design <run-id> 3 5.2 must-not-change
ctx.sh frozen <run-id>                frozen_decisions, verbatim
```

Conventions:

- Artifacts are append-mostly. When reality contradicts a frozen section, amend
  it in place, keep the section numbering, and record the change in an amendment
  table with the evidence that forced it.
- **Section numbers in `design.md` are an interface.** `ctx.sh design` slices on
  them and envelopes cite them by number, so they do not get renumbered.
- Reports cite commands and their real output, not summaries of them: the
  deciding line, not the transcript. A report or review over ~150 lines is a
  defect; put bulk output in a file beside it and cite the path.
- Nothing here is imported by the application. `dist/` never depends on a run
  directory.
