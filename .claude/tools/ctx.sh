#!/usr/bin/env bash
# ctx.sh — pull the slice of a run artifact an agent actually needs.
#
# plan.json and design.md run to 60–70 KB each. A cold sub-agent that cats both
# spends ~30k tokens before it does any work, and re-spends it on every spawn.
# Every subcommand here is a cheap substitute for that. See
# `.claude/agents.md` § Cost discipline.
set -euo pipefail

RUNS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runs"

usage() {
  cat <<'EOF'
ctx.sh map    <run-id>                  index: goal, phases, task ids, design headings
ctx.sh task   <run-id> <task-id>...     the full record for one task, from plan.json
ctx.sh phase  <run-id> <n>              one phase entry plus the records of its tasks
ctx.sh design <run-id> <section>...     sections of design.md: "3", "5.2", or "must-not-change"
ctx.sh frozen <run-id>                  frozen_decisions, verbatim
EOF
  exit 2
}

[ $# -ge 2 ] || usage
cmd=$1; run=$2; shift 2
plan="$RUNS/$run/plan.json"
design="$RUNS/$run/design.md"

# Print one markdown section: from its heading to the next heading of the same
# or higher level. Level is the length of the leading '#' run.
section() {
  awk -v pat="$1" '
    !p && tolower($0) ~ pat { p = 1; lvl = length($1); print; next }
    p && /^#+ /             { if (length($1) <= lvl) exit }
    p                       { print }
  ' "$design"
}

case "$cmd" in
  map)
    [ -f "$plan" ] && jq -r '
      "GOAL: \(.goal)\n",
      (.phases[] | "phase \(.phase)  \(.name)  [\(.tasks | join(", "))]  ships: \(.ships)"),
      "",
      (.tasks[] | "\(.id)  \(.role)\t\(.title)\tdeps=\(.depends_on | join(",") // "-")")
    ' "$plan"
    [ -f "$design" ] && { echo; echo "DESIGN SECTIONS (pull with: ctx.sh design $run <n>)"; grep -n '^#\{2,3\} ' "$design"; }
    ;;
  task)
    [ $# -ge 1 ] || usage
    for id in "$@"; do jq --arg id "$id" '.tasks[] | select(.id == $id)' "$plan"; done
    ;;
  phase)
    [ $# -eq 1 ] || usage
    jq --argjson n "$1" '
      (.phases[] | select(.phase == $n)) as $p
      | { phase: $p, tasks: [ .tasks[] | select(.id | IN($p.tasks[])) ] }
    ' "$plan"
    ;;
  design)
    [ $# -ge 1 ] || usage
    for key in "$@"; do
      case "$key" in
        [0-9]*.[0-9]*) section "^#+ ${key//./[.]} " ;;
        [0-9]*)        section "^#+ ${key}[.] " ;;
        *)             section "^#+ .*$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" ;;
      esac
    done
    ;;
  frozen)
    jq -r '.frozen_decisions[]' "$plan"
    ;;
  *) usage ;;
esac
