#!/usr/bin/env bash
# fencing-check.sh — static portion of the §8.9 fencing verification.
#
# What this proves (without spawning claude):
#   1. src/__fencing-canary.ts exists and exports the canonical token.
#   2. review-dispute.sh invokes claude with the fencing flags (restricted
#      tool set, permission mode, explicit deny for src/**), and does NOT
#      pass --dangerously-skip-permissions (which would bypass all of it).
#   3. REVIEW.template.md contains the verbatim load-bearing phrases from
#      §6.5 rules 3 and 4 (spec §11.13).
#
# Any failure exits non-zero with a specific message so the loop can act on
# it and the operator can see which invariant broke.

set -euo pipefail

CANARY_FILE="src/__fencing-canary.ts"
CANARY_TOKEN="FENCING_CANARY_9F3A2C"
REVIEW_SCRIPT="scripts/review-dispute.sh"
REVIEW_TEMPLATE=".agent/REVIEW.template.md"
AUDIT_SCRIPT="scripts/audit-intent.sh"
AUDIT_TEMPLATE=".agent/AUDIT.template.md"

fail() {
  printf '[fencing] %s\n' "$*" >&2
  exit 1
}

# 1. canary file present and unchanged
[[ -f "$CANARY_FILE" ]] || fail "canary file missing: $CANARY_FILE (spec §8.9)"
grep -q "$CANARY_TOKEN" "$CANARY_FILE" || fail "canary token missing from $CANARY_FILE"

# 2. review-dispute.sh fencing flags
[[ -f "$REVIEW_SCRIPT" ]] || fail "reviewer script missing: $REVIEW_SCRIPT"

# The reviewer must NOT bypass permissions. Ignore comment lines (# ...).
if grep -vE '^\s*#' "$REVIEW_SCRIPT" | grep -qE '(^|[^`"'"'"'a-zA-Z0-9-])--dangerously-skip-permissions'; then
  fail "$REVIEW_SCRIPT uses --dangerously-skip-permissions; fencing is void."
fi

# The reviewer must restrict the built-in tool set (no Grep/Glob/WebFetch).
grep -q -- '--tools' "$REVIEW_SCRIPT" \
  || fail "$REVIEW_SCRIPT missing --tools restriction"
grep -qE '"Read,Write,Edit,Bash"' "$REVIEW_SCRIPT" \
  || fail "$REVIEW_SCRIPT --tools list should be 'Read,Write,Edit,Bash'"

# The reviewer must set a non-bypass permission mode.
grep -qE -- '--permission-mode[[:space:]]+dontAsk' "$REVIEW_SCRIPT" \
  || fail "$REVIEW_SCRIPT must use --permission-mode dontAsk"

# The reviewer must explicitly deny reads under src/.
grep -q 'Read(src/\*\*)' "$REVIEW_SCRIPT" \
  || fail "$REVIEW_SCRIPT must include 'Read(src/**)' in its disallowed tools"

# 3. REVIEW template contains the verbatim load-bearing phrases (spec §11.13).
[[ -f "$REVIEW_TEMPLATE" ]] || fail "review template missing: $REVIEW_TEMPLATE"

grep -Fq 'Your default disposition is `DEV_WRONG`' "$REVIEW_TEMPLATE" \
  || fail "$REVIEW_TEMPLATE missing verbatim: Your default disposition is \`DEV_WRONG\`"

grep -Fq 'Return `AMBIGUOUS` only when the acceptance criterion itself is under-specified' "$REVIEW_TEMPLATE" \
  || fail "$REVIEW_TEMPLATE missing verbatim: Return \`AMBIGUOUS\` only when the acceptance criterion itself is under-specified"

# 4. audit-intent.sh (§8.10) fencing flags. Same invariants as the reviewer,
# with a different denied path set: the auditor must NOT see test-source
# files, otherwise it rationalizes the implementation from them and the
# tautology this step exists to break is preserved.
[[ -f "$AUDIT_SCRIPT" ]] || fail "auditor script missing: $AUDIT_SCRIPT"

if grep -vE '^\s*#' "$AUDIT_SCRIPT" | grep -qE '(^|[^`"'"'"'a-zA-Z0-9-])--dangerously-skip-permissions'; then
  fail "$AUDIT_SCRIPT uses --dangerously-skip-permissions; fencing is void."
fi

grep -q -- '--tools' "$AUDIT_SCRIPT" \
  || fail "$AUDIT_SCRIPT missing --tools restriction"
grep -qE '"Read,Write,Bash"' "$AUDIT_SCRIPT" \
  || fail "$AUDIT_SCRIPT --tools list should be 'Read,Write,Bash' (no Edit — auditor writes only its verdict files)"

grep -qE -- '--permission-mode[[:space:]]+dontAsk' "$AUDIT_SCRIPT" \
  || fail "$AUDIT_SCRIPT must use --permission-mode dontAsk"

grep -q 'Read(tests/\*\*/\*.spec.ts)' "$AUDIT_SCRIPT" \
  || fail "$AUDIT_SCRIPT must deny 'Read(tests/**/*.spec.ts)'"
grep -q 'Read(tests/unit/\*\*)' "$AUDIT_SCRIPT" \
  || fail "$AUDIT_SCRIPT must deny 'Read(tests/unit/**)'"

# 5. AUDIT template contains the verbatim load-bearing phrases (spec §8.10).
[[ -f "$AUDIT_TEMPLATE" ]] || fail "audit template missing: $AUDIT_TEMPLATE"

grep -Fq 'Your default disposition is `INTENT_HONORED`' "$AUDIT_TEMPLATE" \
  || fail "$AUDIT_TEMPLATE missing verbatim: Your default disposition is \`INTENT_HONORED\`"

grep -Fq 'Return `UNCLEAR` only when both the spec and the criterion are genuinely' "$AUDIT_TEMPLATE" \
  || fail "$AUDIT_TEMPLATE missing verbatim: UNCLEAR reserved for cases where intent is not written down"

echo "[fencing] static checks OK"
