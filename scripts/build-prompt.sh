#!/usr/bin/env bash
# build-prompt.sh — render .agent/PROMPT.md from the template plus the issue.
# Usage: scripts/build-prompt.sh <issue-number>
#
# The template is re-fed to the agent every iteration unchanged; only the
# issue title and body change. Placeholders substituted: {{ISSUE_NUMBER}},
# {{ISSUE_TITLE}}, {{ISSUE_BODY}}.

set -euo pipefail

ISSUE="${1:?usage: build-prompt.sh <issue-number>}"
TEMPLATE=".agent/PROMPT.template.md"
OUT=".agent/PROMPT.md"

[[ -f "$TEMPLATE" ]] || { echo "missing template: $TEMPLATE" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "gh not on PATH" >&2; exit 1; }

meta_json="$(gh issue view "$ISSUE" --json title,body 2>/dev/null)" \
  || { echo "cannot fetch issue #$ISSUE" >&2; exit 1; }

title="$(printf '%s' "$meta_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.title??"")})')"
body="$(printf '%s' "$meta_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.body??"")})')"

mkdir -p "$(dirname "$OUT")"

# Use node for substitution to avoid sed's escaping woes with multi-line
# bodies containing arbitrary punctuation.
ISSUE_NUMBER="$ISSUE" ISSUE_TITLE="$title" ISSUE_BODY="$body" \
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const tmpl = readFileSync(process.env.TEMPLATE_PATH, "utf8");
    const out = tmpl
      .replaceAll("{{ISSUE_NUMBER}}", process.env.ISSUE_NUMBER)
      .replaceAll("{{ISSUE_TITLE}}", process.env.ISSUE_TITLE)
      .replaceAll("{{ISSUE_BODY}}", process.env.ISSUE_BODY);
    writeFileSync(process.env.OUT_PATH, out);
  ' TEMPLATE_PATH="$TEMPLATE" OUT_PATH="$OUT"

echo "wrote $OUT (issue #$ISSUE)"
