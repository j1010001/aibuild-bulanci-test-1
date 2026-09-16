#!/usr/bin/env bash
# run-issue.sh — the loop. See spec §8 and §8.9.
#
# Usage: ./scripts/run-issue.sh <issue-number>
#
# Invariants enforced here (not just prompt-level):
#   * Main is never touched: work happens in .worktrees/issue-N/ on branch issue-N.
#   * Done is decided by verify.sh exit code, not by the agent's belief.
#   * Bounded arbitration: reviewer runs at most once per issue on the same
#     conclusion. A second DISPUTE.md after a DEV_WRONG verdict escalates.
#   * Concurrent runs blocked by a lockfile.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Config ──────────────────────────────────────────────────────────────────
ISSUE="${1:-}"
MAX_ITERATIONS="${MAX_ITERATIONS:-15}"
LOCK_DIR=".agent/run.lock"

usage() { echo "usage: $0 <issue-number>" >&2; exit 2; }
[[ -n "$ISSUE" ]] || usage
[[ "$ISSUE" =~ ^[0-9]+$ ]] || { echo "issue must be numeric, got: $ISSUE" >&2; exit 2; }

log() { printf '[run-issue #%s] %s\n' "$ISSUE" "$*"; }

# ── Preflight (§8.1) ────────────────────────────────────────────────────────
command -v claude >/dev/null 2>&1 || { echo "claude not on PATH" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "gh not on PATH" >&2; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 2; }

# Verify the issue exists and has agent-ready.
issue_json="$(gh issue view "$ISSUE" --json number,title,state,labels 2>/dev/null)" \
  || { echo "issue #$ISSUE not found" >&2; exit 2; }

state="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.state)})')"
labels="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.labels.map(l=>l.name).join(","))})')"
title="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.title)})')"

[[ "$state" == "OPEN" ]] || { echo "issue #$ISSUE state=$state; must be OPEN" >&2; exit 2; }
[[ ",$labels," == *",agent-ready,"* ]] || { echo "issue #$ISSUE lacks label agent-ready" >&2; exit 2; }
[[ ",$labels," != *",agent:in-progress,"* ]] || { echo "issue #$ISSUE already agent:in-progress" >&2; exit 2; }

# Working tree must be clean on main.
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "git working tree is dirty; commit or stash first" >&2
  git status --porcelain >&2
  exit 2
fi

# ── Lock (§8.6) ─────────────────────────────────────────────────────────────
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "another run is active (lock: $LOCK_DIR); remove after confirming no claude is running" >&2
  exit 2
fi
release_lock() { rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap release_lock EXIT

# ── Claim (§8.2) ────────────────────────────────────────────────────────────
log "claim: add agent:in-progress, remove agent-ready"
gh issue edit "$ISSUE" --add-label agent:in-progress --remove-label agent-ready >/dev/null

# On failure paths, relabel back to needs-human (or leave in-progress with a note).
release_to_needs_human() {
  local reason_file="$1"
  gh issue edit "$ISSUE" --add-label agent:needs-human --remove-label agent:in-progress >/dev/null || true
  if [[ -f "$reason_file" ]]; then
    # Only post the tail; the full log lives in the worktree.
    tail -c 15000 "$reason_file" | gh issue comment "$ISSUE" --body-file - >/dev/null || true
  else
    gh issue comment "$ISSUE" --body "Agent loop escalated to agent:needs-human. See worktree ${WORKTREE:-<n/a>}." >/dev/null || true
  fi
}

# ── Isolate (§8.3) ──────────────────────────────────────────────────────────
BRANCH="issue-$ISSUE"
WORKTREE=".worktrees/issue-$ISSUE"

log "fetch origin"
git fetch origin --quiet

if [[ -d "$WORKTREE" ]]; then
  log "worktree exists; reusing $WORKTREE"
else
  log "worktree add $WORKTREE (branch $BRANCH from origin/main)"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git worktree add "$WORKTREE" "$BRANCH"
  else
    git worktree add "$WORKTREE" -b "$BRANCH" origin/main
  fi
fi

# ── Assemble prompt (§8.4) ──────────────────────────────────────────────────
cd "$WORKTREE"
mkdir -p .agent

# The template lives at the repo root (checked in); build-prompt.sh renders
# into the worktree's .agent/PROMPT.md via the template path relative to cwd.
if [[ ! -f .agent/PROMPT.template.md ]]; then
  # Copy checked-in template into the worktree so the loop is self-contained.
  cp "$ROOT/.agent/PROMPT.template.md" .agent/PROMPT.template.md
  cp "$ROOT/.agent/REVIEW.template.md" .agent/REVIEW.template.md
fi

log "render .agent/PROMPT.md from template"
bash "$ROOT/scripts/build-prompt.sh" "$ISSUE"

# Track prior verdicts for bounded arbitration.
PRIOR_DEV_WRONG=0
mkdir -p .agent/DISPUTES

# ── Loop (§8.5) ─────────────────────────────────────────────────────────────
log "loop start; MAX_ITERATIONS=$MAX_ITERATIONS"

for ((i = 1; i <= MAX_ITERATIONS; i++)); do
  log "── iteration $i / $MAX_ITERATIONS ──"

  # Dispute routing (§8.9): if a dispute exists at the top of the iteration,
  # invoke the reviewer INSTEAD of running the agent + verify.
  if [[ -f .agent/DISPUTE.md ]]; then
    log "dispute pending — bounded arbitration check"

    if [[ "$PRIOR_DEV_WRONG" -eq 1 ]]; then
      log "second DISPUTE.md after a DEV_WRONG verdict — escalating (§8.9 bounded-arbitration)"
      {
        echo "Bounded-arbitration invariant tripped: the agent raised a second dispute after a prior DEV_WRONG verdict on the same issue."
        echo
        echo "## Prior verdict"
        cat .agent/DISPUTES/latest-verdict.md 2>/dev/null || echo "(missing)"
        echo
        echo "## Second dispute"
        cat .agent/DISPUTE.md
      } | gh issue comment "$ISSUE" --body-file - >/dev/null || true
      gh issue edit "$ISSUE" --add-label agent:needs-human --remove-label agent:in-progress >/dev/null || true
      exit 1
    fi

    log "invoke review-dispute.sh"
    if ! bash "$ROOT/scripts/review-dispute.sh"; then
      log "review-dispute.sh failed hard — escalating"
      release_to_needs_human .agent/DISPUTE.md
      exit 1
    fi

    if [[ ! -f .agent/DISPUTE-VERDICT.md ]]; then
      log "reviewer produced no verdict — escalating"
      release_to_needs_human .agent/DISPUTE.md
      exit 1
    fi

    verdict_line="$(head -n1 .agent/DISPUTE-VERDICT.md)"
    log "verdict: $verdict_line"

    archive=".agent/DISPUTES/turn-$i"
    mkdir -p "$archive"
    cp .agent/DISPUTE.md "$archive/DISPUTE.md"
    cp .agent/DISPUTE-VERDICT.md "$archive/VERDICT.md"
    cp .agent/DISPUTE-VERDICT.md .agent/DISPUTES/latest-verdict.md

    case "$verdict_line" in
      "VERDICT: TEST_WRONG")
        log "TEST_WRONG — dev resumes with corrected test"
        rm -f .agent/DISPUTE.md .agent/DISPUTE-VERDICT.md
        continue
        ;;
      "VERDICT: DEV_WRONG")
        log "DEV_WRONG — prepending verdict to NOTES.md; dev resumes"
        {
          echo "## Dispute rejected (turn $i)"
          cat .agent/DISPUTE-VERDICT.md
          echo
          if [[ -f .agent/NOTES.md ]]; then cat .agent/NOTES.md; fi
        } > .agent/NOTES.md.new
        mv .agent/NOTES.md.new .agent/NOTES.md
        PRIOR_DEV_WRONG=1
        rm -f .agent/DISPUTE.md .agent/DISPUTE-VERDICT.md
        continue
        ;;
      "VERDICT: AMBIGUOUS")
        log "AMBIGUOUS — escalating to agent:needs-human"
        {
          echo "Dispute-review returned AMBIGUOUS."
          echo
          echo "## Dispute"
          cat "$archive/DISPUTE.md"
          echo
          echo "## Verdict"
          cat "$archive/VERDICT.md"
        } | gh issue comment "$ISSUE" --body-file - >/dev/null || true
        gh issue edit "$ISSUE" --add-label agent:needs-human --remove-label agent:in-progress >/dev/null || true
        exit 1
        ;;
      *)
        log "unrecognized verdict line: $verdict_line — escalating"
        release_to_needs_human .agent/DISPUTE-VERDICT.md
        exit 1
        ;;
    esac
  fi

  # Normal turn: run the implementing agent, then verify.
  log "claude turn"
  set +e
  cat .agent/PROMPT.md | claude -p --dangerously-skip-permissions
  turn_rc=$?
  set -e
  log "claude turn exit=$turn_rc"

  # If the agent wrote a DISPUTE.md this turn, the next iteration routes to
  # the reviewer. We do NOT run verify.sh when a dispute is pending (§7).
  if [[ -f .agent/DISPUTE.md ]]; then
    log "agent raised a dispute this turn; will route to reviewer next iteration"
    continue
  fi

  log "verify.sh"
  set +e
  ./scripts/verify.sh > .agent/last-verify.log 2>&1
  verify_rc=$?
  set -e

  if [[ $verify_rc -eq 0 ]]; then
    log "verify: GREEN — success path"

    # Push branch, open PR, relabel.
    if ! git rev-parse HEAD >/dev/null 2>&1 || [[ -z "$(git log origin/main.. --oneline 2>/dev/null)" ]]; then
      log "no commits ahead of origin/main; treating as a spec-11.4-style empty implementation"
    fi

    git push -u origin "$BRANCH" 2>&1 | tail -20 || {
      log "push failed"
      release_to_needs_human .agent/last-verify.log
      exit 1
    }

    # Assemble PR body.
    body_file=".agent/PR-body.md"
    {
      echo "Closes #$ISSUE"
      echo
      echo "## Acceptance criteria"
      gh issue view "$ISSUE" --json body --jq .body || true
      echo
      echo "## Verify output (tail)"
      echo '```'
      tail -c 8000 .agent/last-verify.log
      echo '```'
      echo
      if compgen -G "tests/e2e/output/*.png" > /dev/null; then
        echo "## E2E screenshots"
        for p in tests/e2e/output/*.png; do
          echo "- \`$p\`"
        done
      fi
    } > "$body_file"

    gh pr create --head "$BRANCH" --base main \
      --title "issue #$ISSUE: $title" \
      --body-file "$body_file" >/dev/null

    gh issue edit "$ISSUE" --add-label agent:in-review --remove-label agent:in-progress >/dev/null
    log "PR opened; issue labeled agent:in-review"
    exit 0
  fi

  log "verify: FAILED (rc=$verify_rc) — next iteration"
done

# ── Exhaustion (§8.7) ───────────────────────────────────────────────────────
log "budget exhausted after $MAX_ITERATIONS iterations"
{
  echo "Agent loop exhausted its budget ($MAX_ITERATIONS iterations) without a green verify."
  echo
  echo "## Last verify tail"
  echo '```'
  tail -c 15000 .agent/last-verify.log 2>/dev/null || echo "(no verify log)"
  echo '```'
} | gh issue comment "$ISSUE" --body-file - >/dev/null || true
gh issue edit "$ISSUE" --add-label agent:needs-human --remove-label agent:in-progress >/dev/null || true
exit 1
