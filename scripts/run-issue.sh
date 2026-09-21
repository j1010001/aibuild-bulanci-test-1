#!/usr/bin/env bash
# run-issue.sh — the loop. See spec §8 and §8.9.
#
# Two modes:
#   ./scripts/run-issue.sh <issue-number>    (GitHub-issue mode)
#   ./scripts/run-issue.sh --local <slug>    (local task mode)
#
# GitHub mode: claim `agent-ready`, work on branch issue-N, open PR on green.
# Local mode: no GitHub, work on branch local/<slug>, print result on green.
#   The task body comes from .agent/tasks/<slug>.md (see build-prompt.sh --local).
#   Promotion to PR/main is deferred to `/promote-task`.
#
# Invariants enforced here (not just prompt-level):
#   * Main is never touched: work happens in .worktrees/... on a branch.
#   * Done is decided by verify.sh exit code, not by the agent's belief.
#   * Bounded arbitration: reviewer runs at most once per task on the same
#     conclusion. A second DISPUTE.md after a DEV_WRONG verdict escalates.
#   * Concurrent runs blocked by a lockfile (regardless of mode).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Argument parsing ────────────────────────────────────────────────────────
usage() { echo "usage: $0 <issue-number> | --local <slug>" >&2; exit 2; }

MODE=""
ISSUE=""
SLUG=""

if [[ "${1:-}" == "--local" ]]; then
  MODE="local"
  SLUG="${2:-}"
  [[ -n "$SLUG" ]] || usage
  [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,29}$ ]] \
    || { echo "slug must be kebab-case, 1-30 chars, [a-z0-9-]" >&2; exit 2; }
  TASK_ID="local/$SLUG"
  BRANCH="local/$SLUG"
  WORKTREE=".worktrees/local-$SLUG"
elif [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  MODE="issue"
  ISSUE="$1"
  TASK_ID="#$ISSUE"
  BRANCH="issue-$ISSUE"
  WORKTREE=".worktrees/issue-$ISSUE"
else
  usage
fi

MAX_ITERATIONS="${MAX_ITERATIONS:-15}"
# Absolute path — the script cd's into the worktree before the trap fires;
# a relative LOCK_DIR would make the trap look in the wrong directory and
# leak the lock across runs.
LOCK_DIR="$ROOT/.agent/run.lock"

log() { printf '[run-issue %s] %s\n' "$TASK_ID" "$*"; }
is_local() { [[ "$MODE" == "local" ]]; }

# ── Preflight ───────────────────────────────────────────────────────────────
command -v claude >/dev/null 2>&1 || { echo "claude not on PATH" >&2; exit 2; }

if is_local; then
  # Local mode: no gh needed. Task file must exist.
  TASK_FILE=".agent/tasks/$SLUG.md"
  [[ -f "$TASK_FILE" ]] || { echo "missing task file: $TASK_FILE" >&2; exit 2; }
else
  # GitHub mode: full preflight per spec §8.1.
  command -v gh >/dev/null 2>&1 || { echo "gh not on PATH" >&2; exit 2; }
  gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 2; }

  issue_json="$(gh issue view "$ISSUE" --json number,title,state,labels 2>/dev/null)" \
    || { echo "issue #$ISSUE not found" >&2; exit 2; }

  state="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.state)})')"
  labels="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.labels.map(l=>l.name).join(","))})')"
  title="$(printf '%s' "$issue_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.title)})')"

  [[ "$state" == "OPEN" ]] || { echo "issue #$ISSUE state=$state; must be OPEN" >&2; exit 2; }
  [[ ",$labels," == *",agent-ready,"* ]] || { echo "issue #$ISSUE lacks label agent-ready" >&2; exit 2; }
  [[ ",$labels," != *",agent:in-progress,"* ]] || { echo "issue #$ISSUE already agent:in-progress" >&2; exit 2; }
fi

# Working tree must be clean on the current checkout (main).
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "git working tree is dirty; commit or stash first" >&2
  git status --porcelain >&2
  exit 2
fi

# ── Lock (§8.6) ─────────────────────────────────────────────────────────────
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "another run is active (lock: $LOCK_DIR); remove after confirming no claude is running" >&2
  # Preflight lock-collision failure: we never claimed anything, so no
  # recovery needed. Skip the trap's recovery path.
  CLEAN_EXIT=1
  exit 2
fi

# CLEAN_EXIT is set to 1 by every terminal path. If the trap fires with
# CLEAN_EXIT unset, the run was interrupted (Ctrl-C, crash, kill) between the
# label claim and one of the terminal paths; the trap then relabels
# agent:in-progress back to agent-ready so the issue is not stuck.
# In local mode there is no label to recover — the trap only removes the lock.
# See DECISIONS.md D14.
CLEAN_EXIT=0
LABEL_CLAIMED=0

on_exit() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
  if [[ "$CLEAN_EXIT" != "1" && "$LABEL_CLAIMED" == "1" ]]; then
    gh issue edit "$ISSUE" \
      --remove-label agent:in-progress \
      --add-label agent-ready >/dev/null 2>&1 || true
    gh issue comment "$ISSUE" \
      --body "run-issue.sh was interrupted before reaching a terminal path; label restored to \`agent-ready\`. Re-run when ready." \
      >/dev/null 2>&1 || true
  fi
}
trap on_exit EXIT

# ── Claim (§8.2) ────────────────────────────────────────────────────────────
if is_local; then
  log "local mode; no label to claim"
else
  log "claim: add agent:in-progress, remove agent-ready"
  gh issue edit "$ISSUE" --add-label agent:in-progress --remove-label agent-ready >/dev/null
  LABEL_CLAIMED=1
fi

# On failure paths in GitHub mode, relabel to needs-human and post a log.
# In local mode, just print — nothing to label, nothing to comment on.
release_to_needs_human() {
  local reason_file="$1"
  if is_local; then
    log "escalation (local): reason in $reason_file"
    if [[ -f "$reason_file" ]]; then
      echo "--- $reason_file (tail) ---" >&2
      tail -c 4000 "$reason_file" >&2 || true
    fi
    CLEAN_EXIT=1
    return
  fi
  gh issue edit "$ISSUE" --add-label agent:needs-human --remove-label agent:in-progress >/dev/null || true
  if [[ -f "$reason_file" ]]; then
    tail -c 15000 "$reason_file" | gh issue comment "$ISSUE" --body-file - >/dev/null || true
  else
    gh issue comment "$ISSUE" --body "Agent loop escalated to agent:needs-human. See worktree ${WORKTREE:-<n/a>}." >/dev/null || true
  fi
  CLEAN_EXIT=1
}

# ── Isolate (§8.3) ──────────────────────────────────────────────────────────
log "fetch origin"
git fetch origin --quiet 2>/dev/null || log "fetch origin failed (offline?); continuing with local refs"

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

# The templates live at the repo root (checked in); copy them into the
# worktree so the loop is self-contained.
if [[ ! -f .agent/PROMPT.template.md ]]; then
  cp "$ROOT/.agent/PROMPT.template.md" .agent/PROMPT.template.md
  cp "$ROOT/.agent/REVIEW.template.md" .agent/REVIEW.template.md
  cp "$ROOT/.agent/AUDIT.template.md" .agent/AUDIT.template.md
fi

# In local mode, the task file lives in the MAIN checkout's .agent/tasks/
# (it is gitignored so it isn't on the branch). Copy it into the worktree so
# build-prompt.sh --local can find it via its own relative path.
if is_local; then
  mkdir -p .agent/tasks
  cp "$ROOT/.agent/tasks/$SLUG.md" ".agent/tasks/$SLUG.md"
fi

log "render .agent/PROMPT.md from template"
if is_local; then
  bash "$ROOT/scripts/build-prompt.sh" --local "$SLUG"
else
  bash "$ROOT/scripts/build-prompt.sh" "$ISSUE"
fi

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
      if ! is_local; then
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
      else
        log "(local) both DISPUTE files preserved in .agent/DISPUTES/ for review"
      fi
      CLEAN_EXIT=1
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
        log "AMBIGUOUS — escalating"
        if ! is_local; then
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
        else
          log "(local) DISPUTE and VERDICT archived in $archive for review"
        fi
        CLEAN_EXIT=1
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

  # A non-zero exit from claude means the turn produced no work: the CLI
  # bailed before the agent could act (not logged in, credit exhausted, killed
  # mid-turn, harness failure). Running verify.sh anyway is unsafe — if the
  # pre-turn tree already passes verify (walking skeleton before any change),
  # the loop would declare GREEN against work that never happened. Escalate.
  # Spec §8.5.
  if [[ $turn_rc -ne 0 ]]; then
    log "claude turn produced no work (exit=$turn_rc); escalating"
    turn_reason=".agent/turn-failure.log"
    {
      echo "The claude turn subprocess exited with status $turn_rc."
      echo
      echo "Common causes:"
      echo "  - 'claude' CLI not logged in (run 'claude' interactively and complete /login)"
      echo "  - session credit exhausted or rate-limited"
      echo "  - subprocess killed (SIGTERM/SIGKILL) mid-turn"
      echo "  - transient network failure"
      echo
      echo "Nothing was committed. verify.sh was NOT run; declaring the branch"
      echo "green off pre-turn state would be a false success."
    } > "$turn_reason"
    release_to_needs_human "$turn_reason"
    exit 1
  fi

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

    # Intent audit (§8.10) — advisory only, gated by AUDIT_INTENT (default 1).
    # Runs on every green; never blocks the success path. Verdict lands in
    # .agent/INTENT-AUDIT.md and is surfaced alongside the success banner /
    # PR body below.
    AUDIT_INTENT="${AUDIT_INTENT:-1}"
    if [[ "$AUDIT_INTENT" == "1" ]]; then
      log "intent audit (advisory)"
      set +e
      bash "$ROOT/scripts/audit-intent.sh" > .agent/last-audit.log 2>&1
      set -e
      if [[ -f .agent/INTENT-AUDIT.md ]]; then
        audit_line="$(head -n1 .agent/INTENT-AUDIT.md)"
        log "audit: $audit_line"
      fi
    else
      log "intent audit skipped (AUDIT_INTENT=0)"
    fi

    if is_local; then
      # Local mode: leave the branch on disk, print how to promote. No push,
      # no PR, no label transitions. The task file, NOTES, verify log, and
      # any screenshots all stay in .worktrees/local-$SLUG/.
      log "branch local/$SLUG is green"
      echo ""
      echo "──────────────────────────────────────────────────────────────"
      echo "  Task local/$SLUG passed verify."
      echo "  Branch:   $BRANCH"
      echo "  Worktree: $WORKTREE"
      echo ""
      if [[ -f .agent/INTENT-AUDIT.md ]]; then
        echo "  Intent audit (advisory, spec §8.10):"
        sed 's/^/    /' .agent/INTENT-AUDIT.md
        echo ""
        if [[ -f .agent/SPEC-PROPOSAL.md ]]; then
          echo "  Spec-proposal (SPEC root cause):"
          sed 's/^/    /' .agent/SPEC-PROPOSAL.md
          echo ""
        fi
      fi
      echo "  Preview:  cd $WORKTREE && npm run dev"
      echo "  Review:   git -C $WORKTREE log --oneline main.."
      echo "  Promote:  /promote-task $SLUG   (in a claude code session)"
      echo "──────────────────────────────────────────────────────────────"
      CLEAN_EXIT=1
      exit 0
    fi

    # GitHub mode: push branch, open PR, relabel.
    if ! git rev-parse HEAD >/dev/null 2>&1 || [[ -z "$(git log origin/main.. --oneline 2>/dev/null)" ]]; then
      log "no commits ahead of origin/main; treating as a spec-11.4-style empty implementation"
    fi

    git push -u origin "$BRANCH" 2>&1 | tail -20 || {
      log "push failed"
      release_to_needs_human .agent/last-verify.log
      exit 1
    }

    body_file=".agent/PR-body.md"
    {
      echo "Closes #$ISSUE"
      echo
      echo "## From the issue"
      gh issue view "$ISSUE" --json body --jq .body || true
      echo
      echo "## Verify output (tail)"
      echo '```'
      tail -c 8000 .agent/last-verify.log
      echo '```'
      echo
      if [[ -f .agent/INTENT-AUDIT.md ]]; then
        echo "## Intent audit (advisory, spec §8.10)"
        cat .agent/INTENT-AUDIT.md
        echo
        if [[ -f .agent/SPEC-PROPOSAL.md ]]; then
          echo "### Spec-proposal (SPEC root cause)"
          cat .agent/SPEC-PROPOSAL.md
          echo
        fi
      fi
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
    CLEAN_EXIT=1
    exit 0
  fi

  # Belt-and-suspenders continuity across turns: prepend a compact record of
  # what verify considered broken to NOTES.md. Rule 2 requires the next turn's
  # agent to read NOTES.md AND last-verify.log; this backstop makes the
  # failure visible even if the agent skims one and misses the other.
  failed_layer="$(grep -E 'FAILED at layer:' .agent/last-verify.log 2>/dev/null | tail -1 | sed -E 's/^.*FAILED at layer:[[:space:]]*//' || echo "unknown")"
  {
    echo "## Turn $i verify failed"
    echo "Layer: ${failed_layer:-unknown}"
    echo
    echo '```'
    tail -n 40 .agent/last-verify.log 2>/dev/null || echo "(no verify log)"
    echo '```'
    echo
    if [[ -f .agent/NOTES.md ]]; then cat .agent/NOTES.md; fi
  } > .agent/NOTES.md.new
  mv .agent/NOTES.md.new .agent/NOTES.md

  log "verify: FAILED (rc=$verify_rc, layer=${failed_layer:-unknown}) — next iteration"
done

# ── Exhaustion (§8.7) ───────────────────────────────────────────────────────
log "budget exhausted after $MAX_ITERATIONS iterations"
if is_local; then
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  echo "  Task local/$SLUG exhausted its budget ($MAX_ITERATIONS iterations)."
  echo "  Worktree kept for inspection: $WORKTREE"
  echo "  Read: $WORKTREE/.agent/NOTES.md  and  $WORKTREE/.agent/last-verify.log"
  echo "──────────────────────────────────────────────────────────────"
else
  {
    echo "Agent loop exhausted its budget ($MAX_ITERATIONS iterations) without a green verify."
    echo
    echo "## Last verify tail"
    echo '```'
    tail -c 15000 .agent/last-verify.log 2>/dev/null || echo "(no verify log)"
    echo '```'
  } | gh issue comment "$ISSUE" --body-file - >/dev/null || true
  gh issue edit "$ISSUE" --add-label agent:needs-human --remove-label agent:in-progress >/dev/null || true
fi
CLEAN_EXIT=1
exit 1
