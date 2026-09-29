---
description: Investigate a reported problem or requested change, fix it, and keep spec/2026-09-15-browser-party-shooter-design.md and tests/unit/ in sync so it can't regress.
---

# /project_update — investigate, fix, keep spec and tests in sync

The operator's report or requested change (free-form) follows as `$ARGUMENTS`. It may
be a bug report ("arrow up doesn't move up"), an observed inconsistency, or a wanted
behavior change. Your job is to close the loop completely: understand it, fix the
code, and leave the spec and the test suite in a state that matches the fixed code and
would catch the same class of problem again. A fix that changes code but not spec+tests
is incomplete — do not stop there.

## What the operator typed

$ARGUMENTS

## Step-by-step

1. **Read the spec first.** Open `spec/2026-09-15-browser-party-shooter-design.md` and
   find the section(s) the report touches before reading or changing any code. The spec
   is the design authority — you need to know what it currently claims is true before
   you can tell whether code diverged from it or the spec itself needs to change.

2. **Investigate and find the root cause. Do not patch symptoms on a guess.**
   - Simulation-logic reports (movement, collision, shooting, rounds/match, spawn) —
     reproduce with the pure `sim`/`GameApi` directly: a scratch `vitest` case or a
     quick Node script. It's fast and deterministic; use it before touching the browser.
   - Visual/interactive reports (camera, rendering, input feel, HUD) — start the dev
     server if it isn't already running (`preview_start` with the `dev` launch config
     from `.claude/launch.json`) and reproduce in the Browser pane. Prefer numeric
     verification over eyeballing pixels: dispatch real `KeyboardEvent`s via
     `javascript_tool` (the Browser pane's synthetic `computer key` action has been
     unreliable for held-key timing in this project) and read state back through
     `window.GameAPI.getState()`/`getPlayer()`. For anything involving elapsed time,
     prefer `window.GameAPI.runTicks(n)` over real-time waits — the live page's own
     render loop keeps ticking between your tool calls (and throttles when the tab is
     backgrounded), which makes real-time waits noisy and non-reproducible.
   - State the root cause in one or two sentences before writing a fix. If you can't,
     you haven't found it yet — keep investigating.

3. **Classify the fix before making it:**
   - **Spec was right, code diverged** — fix the code; the spec doesn't need to change
     (it may still gain a short regression note if the failure mode is worth
     remembering).
   - **Spec was silent or ambiguous and the implementation's unstated choice was wrong**
     (this was the camera-azimuth bug: the spec never pinned down that azimuth had to
     be cardinal) — decide the correct behavior, then update the spec to state it
     explicitly *and* fix the code to match, together.
   - **This is a deliberate behavior change**, not a bug — update the spec first to
     describe the new intended behavior, then change the code to match it.
   In every case, spec and code must describe the same behavior when you're done. Never
   leave them disagreeing.

4. **Write the regression test before the fix (test-first, see `CLAUDE.md`).** Add a
   test in `tests/unit/` that reproduces the report and fails on the current, broken
   code. Run it and confirm it fails for the reason you stated in step 2 — a test that
   passes before the fix proves nothing. Prefer testing a pure invariant derived from
   the single source of truth (see `tests/unit/camera.test.ts`) over hardcoding both
   sides of a check that can drift apart the same way the bug did.

5. **Fix the underlying cause, not just its symptom.** If the bug came from two places
   independently hardcoding values that must stay in sync — as the camera's azimuth and
   the keyboard's direction mapping did — extract a single source of truth and derive
   the second value from the first (see `src/camera.ts` and how `src/input.ts` now
   derives its key mapping from it) rather than just correcting both constants by hand.
   A fix that removes the class of bug is worth more than one that removes this
   instance of it.

6. **Update the spec.** Edit
   `spec/2026-09-15-browser-party-shooter-design.md` directly — this is the one design
   document; do not create a new file. Cross-reference the sections involved. If the
   bug is subtle or the wrong assumption was easy to make, add a short note explaining
   what broke and why the new rule prevents it (see §8/§11's azimuth notes for the
   model to follow).

7. **Verify before declaring done — all of these, not a subset:**
   - `npx tsc --noEmit`
   - `npx vitest run` (the full suite, not just the new test)
   - `npm run build`
   - If the change is observable in the running app (rendering, input, camera, HUD,
     game feel), reproduce the *original* reported symptom against the live dev server
     in the Browser pane and confirm it's gone — via `window.GameAPI`, not just a look.

8. **Report back concisely.** State the root cause, list what changed (code files /
   spec sections / test files), and name the specific check that proves each part of
   the fix — don't just assert "fixed."

## Rules (do not violate)

- **Never change code to fix a report without also updating the spec**, when the
  report reveals the spec was wrong, silent, or ambiguous about the behavior in
  question. An out-of-date or silent spec is exactly what lets the same mistake happen
  again later — closing that gap is the point of this command.
- **Never ship a fix without a regression test**, except for something genuinely
  untestable (rendering look-and-feel is the one documented exception, per spec §15) —
  and say so explicitly rather than silently skipping it.
- **Never invent scope.** If the report implies a bigger change than it states, surface
  that to the operator with `AskUserQuestion` before proceeding rather than guessing
  how far to take it.
- **Never commit or push.** Leave changes staged/unstaged in the working tree; the
  operator commits explicitly when ready.
- **Prefer one derived value over two hardcoded ones that must agree.** This project
  has already regressed once from exactly that pattern (camera azimuth vs. keyboard
  mapping) — treat a newly-discovered pair of values that must stay in sync as a
  refactor opportunity, not just two numbers to fix.
