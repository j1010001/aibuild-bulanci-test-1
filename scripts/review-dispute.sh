#!/usr/bin/env bash
# review-dispute.sh — invoke the fenced review agent to adjudicate a dispute.
# Spec §8.9.
#
# FENCING — DO NOT EDIT WITHOUT UPDATING scripts/fencing-check.sh:
#
#   * Uses `claude -p` with `--tools "Read,Write,Edit,Bash"` — Grep, Glob,
#     WebFetch, WebSearch are unavailable to the reviewer.
#   * Uses `--permission-mode dontAsk` (no bypass, non-interactive).
#   * Explicitly denies `Read(src/**)` and reads of notes/prompt/verify-log.
#   * Does NOT pass `--dangerously-skip-permissions`.
#   * Materializes the allowlisted inputs to `.agent/review-inputs/` before
#     invocation; the reviewer only sees these plus the disputed test file.
#
# Weakening any of the above breaks the arbitration guarantee. The fencing
# static check enforces these invariants and runs on every verify.
#
# Usage: scripts/review-dispute.sh [SYNTHETIC_TEST_PATH]
#   Ordinary invocation: reads .agent/DISPUTE.md and picks the test path from
#   it. The optional argument overrides the test path and is used only by
#   scripts/fencing-canary.sh (CANARY_MODE=1).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DISPUTE_FILE=".agent/DISPUTE.md"
REVIEW_TEMPLATE=".agent/REVIEW.template.md"
VERDICT_FILE=".agent/DISPUTE-VERDICT.md"

command -v claude >/dev/null 2>&1 || { echo "claude not on PATH" >&2; exit 2; }
[[ -f "$DISPUTE_FILE" ]] || { echo "no dispute at $DISPUTE_FILE" >&2; exit 2; }
[[ -f "$REVIEW_TEMPLATE" ]] || { echo "missing $REVIEW_TEMPLATE" >&2; exit 2; }

CANARY_MODE="${CANARY_MODE:-0}"
OVERRIDE_TEST="${1:-}"

# ── Parse the dispute: test path and quoted criterion text ──────────────────
TEST_PATH=""
if [[ -n "$OVERRIDE_TEST" ]]; then
  TEST_PATH="$OVERRIDE_TEST"
else
  # First `path/to/test:LINE` in DISPUTE.md.
  TEST_PATH="$(grep -oE '(tests?|src)/[A-Za-z0-9_./-]+\.[tj]sx?(:[0-9]+)?' "$DISPUTE_FILE" | head -n1 | sed 's/:[0-9]*$//' || true)"
fi

if [[ -z "$TEST_PATH" ]]; then
  cat > "$VERDICT_FILE" <<'EOF'
VERDICT: AMBIGUOUS

Reviewer precondition failure: DISPUTE.md did not name a test file. The loop
required a path/to/test:LINE reference before invoking the reviewer.
EOF
  exit 0
fi

if [[ ! -f "$TEST_PATH" ]]; then
  cat > "$VERDICT_FILE" <<EOF
VERDICT: AMBIGUOUS

Reviewer precondition failure: DISPUTE.md named test path "$TEST_PATH", which
does not exist in the worktree.
EOF
  exit 0
fi

# Refuse anything outside the tests/ tree, and refuse absolute/relative paths
# that could reach src/ via traversal.
case "$TEST_PATH" in
  /* | ../* | */../*) echo "unsafe test path: $TEST_PATH" >&2; exit 2 ;;
esac
case "$TEST_PATH" in
  tests/*) : ;;
  *)
    if [[ "$CANARY_MODE" != "1" ]]; then
      cat > "$VERDICT_FILE" <<EOF
VERDICT: AMBIGUOUS

Reviewer precondition failure: DISPUTE.md named test path "$TEST_PATH", which
is not under tests/. The reviewer is only fenced against real test files.
EOF
      exit 0
    fi
    ;;
esac

# ── Materialize the fenced allowlist ────────────────────────────────────────
rm -rf .agent/review-inputs
mkdir -p .agent/review-inputs

# Extract the issue number from the branch (issue-N) if present.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
ISSUE_NUMBER="${BRANCH#issue-}"
[[ "$ISSUE_NUMBER" == "$BRANCH" ]] && ISSUE_NUMBER="0"

if [[ "$CANARY_MODE" == "1" ]]; then
  cat > .agent/review-inputs/issue.md <<'EOF'
# Synthetic issue (fencing canary)

## Acceptance criteria
- The synthetic test asserts `true` is `true`.

## Scope
This dispute exists only to prove the reviewer cannot read src/.
EOF
else
  # Real invocation: pull the issue and materialize its title/body + scope
  # spec section(s). Falls back to a stub if gh is unavailable.
  if command -v gh >/dev/null 2>&1 && [[ "$ISSUE_NUMBER" != "0" ]]; then
    gh issue view "$ISSUE_NUMBER" --json title,body \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(`# Issue #${process.env.N}: ${j.title}\n\n${j.body}\n`)})' \
        N="$ISSUE_NUMBER" > .agent/review-inputs/issue.md
  else
    cat > .agent/review-inputs/issue.md <<EOF
# Issue #$ISSUE_NUMBER (offline stub)

The reviewer runs without gh access. See .agent/DISPUTE.md for the criterion
text quoted by the implementing agent.
EOF
  fi

  # Extract every spec section named in DISPUTE.md ("§N" or "spec/…design.md
  # §N"). Copy the containing top-level section of the spec file, verbatim,
  # to `.agent/review-inputs/spec-<slug>.md`. Coarse but safe: never exposes
  # more than one section of one file.
  for spec_ref in $(grep -oE 'spec/[^ )]+\.md' "$DISPUTE_FILE" | sort -u); do
    [[ -f "$spec_ref" ]] || continue
    slug="$(printf '%s' "$spec_ref" | tr '/. ' '__' )"
    cp "$spec_ref" ".agent/review-inputs/spec-$slug.md"
  done
fi

# ── Render the reviewer prompt ──────────────────────────────────────────────
RENDERED=".agent/REVIEW.md"
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const tmpl = readFileSync(process.env.TEMPLATE_PATH, "utf8");
  const out = tmpl
    .replaceAll("{{ISSUE_NUMBER}}", process.env.ISSUE_NUMBER)
    .replaceAll("{{DISPUTED_TEST_PATH}}", process.env.TEST_PATH);
  writeFileSync(process.env.OUT_PATH, out);
' TEMPLATE_PATH="$REVIEW_TEMPLATE" OUT_PATH="$RENDERED" ISSUE_NUMBER="$ISSUE_NUMBER" TEST_PATH="$TEST_PATH"

# ── Invoke the reviewer with the fencing flags ──────────────────────────────
# NOTE: any change to the flags below MUST be mirrored in
# scripts/fencing-check.sh. The static check greps this file for the exact
# strings and will fail the verify layer if a flag is dropped or altered.

set +e
claude -p \
  --permission-mode dontAsk \
  --tools "Read,Write,Edit,Bash" \
  --allowedTools \
    "Read(.agent/review-inputs/**)" \
    "Read(.agent/DISPUTE.md)" \
    "Read(.agent/REVIEW.md)" \
    "Read(.agent/DISPUTE-VERDICT.md)" \
    "Read($TEST_PATH)" \
    "Write(.agent/DISPUTE-VERDICT.md)" \
    "Edit($TEST_PATH)" \
    "Bash(git add:*)" \
    "Bash(git commit:*)" \
  --disallowedTools \
    "Read(src/**)" \
    "Read(.agent/NOTES.md)" \
    "Read(.agent/PROMPT.md)" \
    "Read(.agent/last-verify.log)" \
    "Read(.agent/DISPUTES/**)" \
    "WebFetch" \
    "WebSearch" \
  < "$RENDERED"
RC=$?
set -e

if [[ ! -f "$VERDICT_FILE" ]]; then
  cat > "$VERDICT_FILE" <<EOF
VERDICT: AMBIGUOUS

Reviewer failed to produce a verdict file (claude exit code $RC). Treating as
AMBIGUOUS so the operator can inspect. This is not a rubber-stamp; the loop
will escalate to agent:needs-human.
EOF
fi

exit 0
