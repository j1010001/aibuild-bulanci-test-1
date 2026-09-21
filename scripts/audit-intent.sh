#!/usr/bin/env bash
# audit-intent.sh — invoke the fenced intent auditor on a green branch.
# Spec §8.10.
#
# FENCING — DO NOT EDIT WITHOUT UPDATING scripts/fencing-check.sh:
#
#   * Uses `claude -p` with `--tools "Read,Write,Bash"` — Edit, Grep, Glob,
#     WebFetch, WebSearch are unavailable to the auditor.
#   * Uses `--permission-mode dontAsk` (no bypass, non-interactive).
#   * Explicitly denies reads of `tests/**/*.spec.ts`, `tests/**/*.test.ts`,
#     `tests/unit/**`, notes, prompt, and prior disputes.
#   * Does NOT pass `--dangerously-skip-permissions`.
#   * Materializes the allowlisted task + diff + spec extracts to
#     `.agent/audit-inputs/` before invocation.
#
# Weakening any of the above breaks the "auditor doesn't see the tests"
# guarantee, which is the load-bearing property of this step (spec §8.10).
#
# Advisory: this script never exits non-zero on a defensible audit outcome —
# it either writes a verdict file or writes an "UNCLEAR" fallback. The loop's
# success path is not gated on the verdict.
#
# Usage: scripts/audit-intent.sh
#   Expects the current directory to be the worktree (chdir performed by
#   run-issue.sh). Reads task + branch state from there.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE="$(pwd)"

AUDIT_TEMPLATE=".agent/AUDIT.template.md"
RENDERED=".agent/AUDIT.md"
VERDICT_FILE=".agent/INTENT-AUDIT.md"
INPUTS_DIR=".agent/audit-inputs"

command -v claude >/dev/null 2>&1 || { echo "claude not on PATH" >&2; exit 2; }
[[ -f "$AUDIT_TEMPLATE" ]] || { echo "missing $AUDIT_TEMPLATE" >&2; exit 2; }

# ── Determine the task identifier ───────────────────────────────────────────
# The auditor doesn't need this for anything beyond a header, but the template
# renders {{TASK_ID}} so the auditor's own verdict file self-identifies.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
TASK_ID="$BRANCH"

# ── Materialize inputs ──────────────────────────────────────────────────────
rm -rf "$INPUTS_DIR"
mkdir -p "$INPUTS_DIR"

# Task body: from .agent/tasks/<slug>.md (local mode) or the GitHub issue.
if [[ "$BRANCH" == local/* ]]; then
  SLUG="${BRANCH#local/}"
  if [[ -f ".agent/tasks/$SLUG.md" ]]; then
    cp ".agent/tasks/$SLUG.md" "$INPUTS_DIR/task.md"
  else
    printf '# Task %s (no task file found)\n' "$TASK_ID" > "$INPUTS_DIR/task.md"
  fi
elif [[ "$BRANCH" == issue-* ]]; then
  ISSUE_NUMBER="${BRANCH#issue-}"
  if command -v gh >/dev/null 2>&1; then
    gh issue view "$ISSUE_NUMBER" --json title,body \
      | N="$ISSUE_NUMBER" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(`# Issue #${process.env.N}: ${j.title}\n\n${j.body}\n`)})' \
        > "$INPUTS_DIR/task.md" \
      || printf '# Issue #%s (gh view failed)\n' "$ISSUE_NUMBER" > "$INPUTS_DIR/task.md"
  else
    printf '# Issue #%s (gh unavailable)\n' "$ISSUE_NUMBER" > "$INPUTS_DIR/task.md"
  fi
else
  printf '# Task on branch %s (no known task convention)\n' "$BRANCH" > "$INPUTS_DIR/task.md"
fi

# Branch diff vs origin/main — the change under audit.
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  git diff origin/main..HEAD > "$INPUTS_DIR/diff.patch" 2>/dev/null || true
else
  echo "(origin/main not available; diff omitted)" > "$INPUTS_DIR/diff.patch"
fi

# Spec-section extracts named in task.md. Same heuristic as review-dispute.sh:
# grep out `spec/…md` mentions and copy each verbatim to a slug-named file.
# Coarse but safe: never exposes anything not referenced from the task.
for spec_ref in $(grep -oE 'spec/[^ )]+\.md' "$INPUTS_DIR/task.md" | sort -u); do
  [[ -f "$spec_ref" ]] || continue
  slug="$(printf '%s' "$spec_ref" | tr '/. ' '__')"
  cp "$spec_ref" "$INPUTS_DIR/spec-$slug.md"
done

# ── Render the auditor prompt ───────────────────────────────────────────────
TEMPLATE_PATH="$AUDIT_TEMPLATE" OUT_PATH="$RENDERED" TASK_ID="$TASK_ID" \
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const tmpl = readFileSync(process.env.TEMPLATE_PATH, "utf8");
  const out = tmpl.replaceAll("{{TASK_ID}}", process.env.TASK_ID);
  writeFileSync(process.env.OUT_PATH, out);
'

# ── Invoke the auditor with the fencing flags ───────────────────────────────
# NOTE: any change to the flags below MUST be mirrored in
# scripts/fencing-check.sh. The static check greps this file for the exact
# strings and will fail verify layer 1 if a flag is dropped or altered.

rm -f "$VERDICT_FILE" .agent/SPEC-PROPOSAL.md

set +e
claude -p \
  --permission-mode dontAsk \
  --tools "Read,Write,Edit,Bash" \
  --allowedTools \
    "Read(.agent/audit-inputs/**)" \
    "Read(.agent/AUDIT.md)" \
    "Read(.agent/last-verify.log)" \
    "Read(spec/**)" \
    "Read(src/**)" \
    "Read(tests/e2e/output/**)" \
    "Write(.agent/INTENT-AUDIT.md)" \
    "Write(.agent/SPEC-PROPOSAL.md)" \
    "Edit(.agent/INTENT-AUDIT.md)" \
    "Edit(.agent/SPEC-PROPOSAL.md)" \
  --disallowedTools \
    "Read(tests/**/*.spec.ts)" \
    "Read(tests/**/*.test.ts)" \
    "Read(tests/unit/**)" \
    "Read(.agent/NOTES.md)" \
    "Read(.agent/PROMPT.md)" \
    "Read(.agent/DISPUTES/**)" \
    "WebFetch" \
    "WebSearch" \
  < "$RENDERED"
RC=$?
set -e

if [[ ! -f "$VERDICT_FILE" ]]; then
  cat > "$VERDICT_FILE" <<EOF
VERDICT: UNCLEAR

Auditor failed to produce a verdict file (claude exit code $RC). Treating as
UNCLEAR so the operator sees the failure; the run is not blocked (spec §8.10
advisory). Inspect .agent/last-audit.log for details.
EOF
fi

exit 0
