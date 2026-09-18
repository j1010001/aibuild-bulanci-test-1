---
name: Agent task
about: A unit of work for the agent build loop. Requires verifiable acceptance criteria.
title: ""
labels: []
assignees: []
---

<!--
Rules for this template (read before filing):
  * Every acceptance criterion must be pass/fail. If two readers could disagree
    about whether it passed, rewrite it. Vague adjectives ("properly", "gracefully",
    "responsive", "fast") are forbidden — replace with exact values or observable
    states.
  * Describe OBSERVABLE BEHAVIOR, not implementation. Do not name test tools
    (Playwright, Vitest) or file paths in criteria — the agent picks those.
  * Every criterion must be checkable by a machine OR by a human in under a minute.
  * If you cannot state a finish line, this issue is NOT ready to be labeled
    `agent-ready`. Do not queue it.
  * `scripts/verify.sh` is the standard finish line and runs automatically — you
    do not need to mention it. Fill Verification only if there is an extra check
    beyond what verify.sh already covers.
  * Scope is optional. Leave blank if the whole codebase is fair game.
-->

## Summary
One paragraph. What changes and why.

## Acceptance criteria
- Given <precondition>, When <observation>, Then <observable, checkable result>
- Given ..., When ..., Then ...

## Verification (optional)
<Extra checks beyond `./scripts/verify.sh` (which runs automatically).
Leave blank if none.
Example: "manual: play a round with two browser tabs and confirm no desync.">

## Scope (optional)
<What part of the product this concerns, and anything the agent should not
touch. Leave blank if the whole codebase is fair game. Do not list files —
name product areas.
Example: "movement and collision; the networking layer is off limits.">
