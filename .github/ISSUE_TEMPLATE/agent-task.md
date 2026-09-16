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
  * Every criterion must be checkable by a machine OR by a human in under a minute.
  * If you cannot state a finish line, this issue is NOT ready to be labeled
    `agent-ready`. Do not queue it.
  * Scope tells the agent what NOT to touch. Fill it in.
-->

## Summary
One paragraph. What changes and why.

## Acceptance criteria
- Given <precondition>, When <action>, Then <observable, checkable result>
- Given ..., When ..., Then ...

## Verification
- [ ] `./scripts/verify.sh` exits 0
- [ ] <issue-specific check, e.g. "new unit test tests/unit/bullet.test.ts covers bullet-through-arch-hole">

## Scope
Relevant spec sections: e.g. `spec/2026-09-15-browser-party-shooter-design.md` §9 (Shooting).
Touch: `src/sim/...`.
Do NOT touch: `src/render.ts`, networking.
