#!/usr/bin/env bash
# verify.sh — the finish line.
#
# Runs static -> unit -> e2e layers in order and exits non-zero at the first
# failure. Also runs the fencing static check (spec §8.9). The runtime canary
# check is expensive (spawns claude) and is gated behind
# VERIFY_FENCING_RUNTIME=1; the static check catches the common regressions on
# every run and the runtime check is exercised during the initial self-test
# and periodically thereafter.
#
# Exit code is authoritative — the loop and `verify.sh` alone decide "done."
# Do not add commentary that the agent could read as success.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

banner() {
  printf '\n== %s ==\n' "$*"
}

fail() {
  printf '\n[verify.sh] FAILED at layer: %s\n' "$1" >&2
  exit 1
}

# Route disputes: if a dispute is pending, the loop must handle it before
# verify runs again. Spec §7 line: "When .agent/DISPUTE.md exists at the
# start of a loop iteration, verify.sh is not run for that iteration."
# verify.sh is defensive: if invoked directly while a dispute is pending, it
# exits non-zero and names the situation so nothing rubber-stamps the branch.
if [[ -f .agent/DISPUTE.md ]]; then
  banner "dispute pending"
  echo "A .agent/DISPUTE.md is present. verify.sh does not adjudicate disputes."
  echo "Run scripts/review-dispute.sh (invoked automatically by run-issue.sh)."
  fail "dispute-routing"
fi

# ── layer 1: static ─────────────────────────────────────────────────────────
banner "layer 1: static (typecheck + lint + fencing)"

echo "-> tsc --noEmit"
npx tsc --noEmit || fail "static/typecheck"

echo "-> eslint"
npx eslint . --max-warnings=0 || fail "static/lint"

echo "-> fencing static check"
FENCING_LOG=$(mktemp)
if ! bash scripts/fencing-check.sh > "$FENCING_LOG" 2>&1; then
  cat "$FENCING_LOG"
  rm -f "$FENCING_LOG"
  fail "static/fencing"
fi
cat "$FENCING_LOG"
rm -f "$FENCING_LOG"

if [[ "${VERIFY_FENCING_RUNTIME:-0}" == "1" ]]; then
  echo "-> fencing runtime canary (VERIFY_FENCING_RUNTIME=1)"
  bash scripts/fencing-canary.sh || fail "static/fencing-runtime"
else
  echo "-> fencing runtime canary skipped (set VERIFY_FENCING_RUNTIME=1 to run)"
fi

# ── layer 2: unit ───────────────────────────────────────────────────────────
banner "layer 2: unit tests"
npx vitest run || fail "unit"

# ── layer 3: e2e smoke ──────────────────────────────────────────────────────
banner "layer 3: e2e smoke (Playwright)"
mkdir -p tests/e2e/output
npx playwright test || fail "e2e"

banner "verify: OK"
