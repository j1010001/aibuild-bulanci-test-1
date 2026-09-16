#!/usr/bin/env bash
# setup-labels.sh — idempotent creation of the four agent state labels.
# Spec §5.1. Re-running is a no-op.

set -euo pipefail

command -v gh >/dev/null 2>&1 || { echo "gh not on PATH" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }

upsert() {
  local name="$1" color="$2" desc="$3"
  if gh label list --limit 200 --json name --jq '.[].name' | grep -Fxq "$name"; then
    gh label edit "$name" --color "$color" --description "$desc" >/dev/null
    echo "updated $name"
  else
    gh label create "$name" --color "$color" --description "$desc" >/dev/null
    echo "created $name"
  fi
}

upsert "agent-ready"       "0e8a16" "Queued for the agent. Body is verifiable."
upsert "agent:in-progress" "fbca04" "A loop is actively working this issue."
upsert "agent:in-review"   "1d76db" "PR open, awaiting human review."
upsert "agent:needs-human" "b60205" "Loop stalled or dispute unresolved; see logs."

echo "labels ready."
