#!/usr/bin/env bash
# build-prompt.sh — render .agent/PROMPT.md from the template plus the task.
#
# Two modes:
#   scripts/build-prompt.sh <issue-number>       (GitHub issue mode)
#   scripts/build-prompt.sh --local <slug>       (local task mode)
#
# The template is re-fed to the agent every iteration unchanged; only the
# title and body change. Placeholders substituted: {{ISSUE_NUMBER}},
# {{ISSUE_TITLE}}, {{ISSUE_BODY}}. In local mode, {{ISSUE_NUMBER}} is filled
# with `local/<slug>` — the agent reads it as opaque prose.

set -euo pipefail

usage() { echo "usage: $0 <issue-number> | --local <slug>" >&2; exit 2; }
[[ $# -ge 1 ]] || usage

TEMPLATE=".agent/PROMPT.template.md"
OUT=".agent/PROMPT.md"
[[ -f "$TEMPLATE" ]] || { echo "missing template: $TEMPLATE" >&2; exit 1; }

MODE=""
if [[ "$1" == "--local" ]]; then
  MODE="local"
  SLUG="${2:-}"
  [[ -n "$SLUG" ]] || usage
  TASK_FILE=".agent/tasks/$SLUG.md"
  [[ -f "$TASK_FILE" ]] || { echo "missing task file: $TASK_FILE" >&2; exit 1; }

  # Parse minimal YAML frontmatter for `title`. Body is everything after the
  # closing `---`. If there is no frontmatter, title falls back to the slug
  # and body is the whole file.
  title="$(awk '
    NR==1 && /^---[[:space:]]*$/ { in_fm=1; next }
    in_fm && /^---[[:space:]]*$/ { exit }
    in_fm && /^title:[[:space:]]*/ {
      sub(/^title:[[:space:]]*/, "");
      gsub(/^"|"$/, "");
      print; exit
    }
  ' "$TASK_FILE")"
  [[ -n "$title" ]] || title="$SLUG"

  body="$(awk '
    NR==1 && /^---[[:space:]]*$/ { in_fm=1; next }
    in_fm && /^---[[:space:]]*$/ { in_fm=0; skip_blank=1; next }
    !in_fm {
      if (skip_blank && /^[[:space:]]*$/) next
      skip_blank=0
      print
    }
  ' "$TASK_FILE")"

  ISSUE_ID="local/$SLUG"
else
  MODE="issue"
  ISSUE="$1"
  command -v gh >/dev/null 2>&1 || { echo "gh not on PATH" >&2; exit 1; }

  meta_json="$(gh issue view "$ISSUE" --json title,body 2>/dev/null)" \
    || { echo "cannot fetch issue #$ISSUE" >&2; exit 1; }

  title="$(printf '%s' "$meta_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.title??"")})')"
  body="$(printf '%s' "$meta_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.body??"")})')"

  ISSUE_ID="$ISSUE"
fi

mkdir -p "$(dirname "$OUT")"

# Use node for substitution to avoid sed's escaping woes with multi-line
# bodies containing arbitrary punctuation.
# NOTE: All env vars go BEFORE `node` — args after `-e '<script>'` are argv,
# not env. Getting this wrong yields undefined process.env.* silently until
# readFileSync crashes.
TEMPLATE_PATH="$TEMPLATE" OUT_PATH="$OUT" \
ISSUE_NUMBER="$ISSUE_ID" ISSUE_TITLE="$title" ISSUE_BODY="$body" \
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const tmpl = readFileSync(process.env.TEMPLATE_PATH, "utf8");
    const out = tmpl
      .replaceAll("{{ISSUE_NUMBER}}", process.env.ISSUE_NUMBER)
      .replaceAll("{{ISSUE_TITLE}}", process.env.ISSUE_TITLE)
      .replaceAll("{{ISSUE_BODY}}", process.env.ISSUE_BODY);
    writeFileSync(process.env.OUT_PATH, out);
  '

if [[ "$MODE" == "local" ]]; then
  echo "wrote $OUT (local/$SLUG)"
else
  echo "wrote $OUT (issue #$ISSUE)"
fi
