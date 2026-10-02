---
name: workflow-retro
description: Look back at a finished session or run, find the N biggest inefficiencies (default 3), and change the agentic workflow (.claude/agents.md, the role files in .claude/agents/, the skills, ENVIRONMENT.md, CLAUDE.md) so they don't happen again. Use for "analyze the last session", "what went wrong / what was slow", "improve the workflow", "retro", "self-iterate on how you work". Not for fixing the product code a run produced (that's a normal run) and not for a single rule the user dictates word for word (just edit it, tier 1).
---

You are running the **workflow-retro** skill as the Orchestrator defined in
`.claude/agents.md`. The output is a small set of edits to the workflow's own
files. Each edit is aimed at an inefficiency that really cost something, and
each has that cost written next to it as the reason. It is tier-1 work
(`CLAUDE.md` § When the workflow applies): configuration and doc changes to the
workflow. That means no run id and no sub-agents, and the retro must cost far
less than the waste it removes.

## 1. Gather evidence, don't recall it

Your memory of a long session is compacted and flattering. Rebuild the timeline
from primary sources, cheapest first:

- **The conversation itself**, if the session is this one:
  - task notifications carry each sub-agent's `subagent_tokens`, `tool_uses`
    and `duration_ms`;
  - every user message that corrects, complains or repeats a request is
    evidence of waste;
  - so is every "it doesn't seem to have changed" or "I didn't reject
    anything".
- **Run artifacts:** `.claude/runs/<run-id>/`.
  - Read `.claude/tools/ctx.sh map <run-id>` first.
  - Then the review verdicts: count the `request_changes` rounds, count the
    non-blocking findings that later turned into their own tasks, and note what
    each finding was.
  - Then `intake.md` for the frozen decisions and amendments. An amendment is a
    place where the design was wrong.
- **git**: `git log` in the run clone (`.claude/run-clones/<run-id>/tree`) for
  fix-up commits and reverts. Many commits touching the same file are rework.
- **An earlier session's transcript**: this only applies if the retro is about
  a session other than the current one. Transcripts live at
  `~/.claude/projects/-home-guilherme-urutau-urutau/<session-id>.jsonl` and run
  to many MB, so never read one whole. `grep -c`/`grep -o` it for
  `subagent_tokens`, `"type":"user"` messages, `request_changes`, `blocked`,
  `Exit code`, `denied`, then read only the lines around the hits.

Write down each candidate with a **measured cost**: tokens, minutes, spawns,
review rounds, GitHub API requests, or a user-visible incident (a wrong answer
the user had to catch, a broken board, a lost stored board). A candidate you
can't put a number or an incident on is a hunch. Say so, or drop it.

## 2. Rank and pick

Score each candidate on **cost × likelihood it recurs**. Recurrence is what
makes a fix worth writing: one bad-luck event under a sound rule scores low.
Keep only candidates where **the workflow itself was the cause**:
- a missing rule;
- a rule in the wrong file, one the acting agent never reads;
- a check that was left to judgement when a mechanical check would do;
- a skill whose procedure leads to the miss.

Group incidents that share a root cause into one inefficiency. (In msfslogger's
first retro, a broken deploy note, a `TMPDIR` rule that broke a test and a
restart that caused downtime were **one** inefficiency: things frozen before
anyone executed them.) Pick the top N (default 3). Everything else goes in the
report as a one-line "also seen".

## 3. Put each fix where the decision is made

For each pick, find the file read by the agent that **makes** the decision the
fix changes. Not the file you happen to have open:

| Who decides | File |
|---|---|
| The Orchestrator: routing, envelopes, what to freeze, how to handle a verdict | `.claude/agents.md` § Rules / § Cost discipline, and `CLAUDE.md` for the non-negotiables |
| An implementer, before hand-back | `.claude/agents/{core,ui}_{jr,sr}.md` § Verify before you report. Edit all four when it applies to all four |
| The Reviewer | `.claude/agents/reviewer.md` |
| Planner / Designer / DevOps | their role file |
| Every agent: machine facts | `.claude/ENVIRONMENT.md` |
| A kind of work with its own procedure | `.claude/skills/<skill>/SKILL.md` |

The `impeccable` skill is vendored from upstream (`pbakaus/impeccable`, as are
the `impeccable-*` agents), and `npx impeccable update` rewrites the skill's
files, so a local edit there does not last. Put a fix about how this project
uses impeccable in `CLAUDE.md` or the role files instead.

Rules for writing the fix:

- **Read the existing text first.** Grep for the topic across `.claude/`. If a
  rule already covers the case and was ignored, the fix is to move it where the
  decider reads it, or to make it mechanical. Adding a second copy doesn't fix
  anything.
- **Prefer a check to an exhortation.** A grep, a script or a required field in
  the envelope beats "be careful to". (The first msfslogger retro gave
  implementers a pre-hand-back `git diff | grep` self-audit, not advice about
  test quality.)
- **Every rule carries its incident**: run id, what happened, and the measured
  cost. That is what stops a later reader deleting it as bureaucracy.
- **Execute what you add.** A grep or command in a rule gets tested against a
  sample it must catch and one it must not. Paste both into the shell. (The
  first msfslogger retro found its own timeout grep missed `180_000`.) This
  skill is bound by `agents.md` § "Nothing is frozen until it has been
  executed" like everything else.
- **Check every path and run id you cite still exists** (`ls`).
- **Keep it small.** Each fix should be a few lines in the right place. If a fix
  needs a new skill, a new role or a restructure, propose it in the report and
  let the user decide. Don't do it inside the retro.
- **Don't contradict `CLAUDE.md`'s non-negotiables.** If a fix seems to need one
  of them relaxed, that's the user's call. Escalate it.

## 4. Verify and report

```bash
git -C /home/guilherme/urutau/urutau diff --stat -- .claude CLAUDE.md
git -C /home/guilherme/urutau/urutau status --short -- .claude CLAUDE.md
```

Only workflow files should appear (`status` also lists new, untracked files,
which `diff` does not). Reread each edit in place once, to confirm it's under
the right heading and doesn't duplicate an existing sentence.

Report to the user:

- **The top N**, each with:
  - what happened and its measured cost, with the source (notification usage,
    review file, user message);
  - the root cause in the workflow;
  - the fix, with the file links;
  - how you tested any check you added.
- **Also seen**: the lower-ranked candidates, one line each.
- **Outside the workflow**: anything the retro turned up that isn't a workflow
  fix, such as missing files, uncommitted work, or a product bug. Report it;
  don't fix it.
- The edits are **uncommitted**. Ask before committing, and stage only the
  workflow files: other sessions' work in progress may sit in the same tree.

If a later retro sees one of these rules fail to fire, treat that as its own
inefficiency. Usually the rule is in a file the acting agent doesn't read.
