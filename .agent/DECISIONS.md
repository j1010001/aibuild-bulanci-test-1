# Decisions log — initial construction (2026-09-16)

Decisions taken during the initial build of the agent build system, where the
spec was silent or ambiguous. Numbered so they can be referenced from PRs and
future spec revisions.

## D1. Toolchain versions (spec silent)

- **Node 20+ (developed on 25.4.0).** Pinned via `engines`-adjacent guidance in
  `AGENT.md`; not enforced by `verify.sh` because a CI-side check is cheaper.
- **npm as package manager.** No `pnpm`/`yarn`; keeps the install surface
  identical to what most operators already have.
- **three.js `^0.170.0`, TypeScript `^5.6`, Vite `^5.4`, Vitest `^2.1`,
  Playwright `^1.48`.** Latest stable at build time. All floating on caret;
  npm lock file is checked in.
- **ESLint 8 (not 9/flat config).** ESLint 9 breaks the `.eslintrc.cjs` +
  `@typescript-eslint` combo used here; the flat-config migration is a separate
  concern the agent loop shouldn't debug on its first day. Revisit later.

## D2. Fencing mechanism (spec §8.9)

The spec required "the tool's process/permission mechanism, not prompt-level."
Claude Code's mechanism is the `--tools` / `--allowedTools` / `--disallowedTools` /
`--permission-mode` flags. Concrete implementation:

- Reviewer invoked with `--tools "Read,Write,Edit,Bash"` — Grep, Glob,
  WebFetch, WebSearch are structurally unavailable.
- `--permission-mode dontAsk` — non-interactive; tools without matching allow
  patterns fail hard rather than prompt.
- `--allowedTools` scoped to the allowlist paths from §8.9.
- `--disallowedTools` explicitly includes `Read(src/**)` even though the tool
  restriction already excludes broad reads. Belt and suspenders — defense in
  depth against a permission-model change in a future Claude Code release.
- `--dangerously-skip-permissions` is deliberately absent; the fencing static
  check fails verify if it appears in `review-dispute.sh` outside a comment.

## D3. Fencing runtime canary is gated (deviation from spec §8.9 wording)

The spec says the runtime canary "runs as part of verify.sh layer 1." Taken
literally, this spawns a `claude` process on every verify — every iteration of
every issue loop, plus every ad-hoc verify. That is economically infeasible.

**Deviation:** the static fencing check runs on every verify (cheap, catches
the common regressions: script edits, template phrase deletion, canary file
removal). The runtime canary is gated behind `VERIFY_FENCING_RUNTIME=1`.

**Guardrails against the deviation:**
- README documents when to run the runtime canary (initial self-test; after any
  change to `review-dispute.sh`, `.agent/REVIEW.template.md`, or the fencing
  verifier).
- Static check enforces that the exact `claude` invocation in `review-dispute.sh`
  is unchanged — dropping a flag fails verify.
- `AGENT.md` states the canary file is load-bearing and must not be removed.

If this proves insufficient, the fix is to run the runtime canary opportunistically
(e.g. on every 10th verify, or on the first verify of each run-issue.sh
invocation) rather than to remove the gate.

## D4. Spec section extraction for review-inputs (spec §8.9 detail-silent)

The spec says the review-inputs should contain "spec section(s) named in the
issue's Scope, extracted as subsections only." Extracting a specific subsection
from an arbitrary Markdown document by heading is fiddly and easy to get wrong.

**Choice:** for v1, copy the entire spec file that DISPUTE.md references, not
the specific subsection. The reviewer's context is still fenced away from
`src/` — the biggest failure mode. Exposing the whole spec to the reviewer is
minor risk (reviewer might read unrelated design context and infer intent) and
easy to tighten later once a Markdown-heading extractor exists.

Documented here so a future iteration can add heading-scoped extraction.

## D5. `AGENT.md`, not `CLAUDE.md` (spec-aligned; small tool cost)

Claude Code auto-loads `CLAUDE.md` at session start. The spec names `AGENT.md`.
Rather than rename the spec artifact, I kept `AGENT.md` and rely on
`PROMPT.template.md` rule 2 to make the agent read it explicitly. If context
bloat becomes a problem, symlink `CLAUDE.md → AGENT.md` at bootstrap.

## D6. Dispute test-path parsing (spec §8.9 format-silent)

The spec says `DISPUTE.md` "names an existing test file and at least one line
number" without specifying the exact format. `review-dispute.sh` uses a regex
that accepts `path/to/test.ts` or `path/to/test.ts:LINE`. If the parser fails
to find a valid path, the reviewer is not invoked and an AMBIGUOUS verdict is
written directly by the script, per the §8.9 precondition-failure path.

## D7. `run-issue.sh` PR body pulls issue body via `gh`, not the local template

The PR body includes the acceptance criteria by re-fetching the issue body at
success time rather than stashing it in the worktree. Rationale: the issue may
have been edited during the loop (operator tightened criteria mid-run); the PR
should reflect the final criteria the branch is claiming to satisfy.

## D8. Worktree not deleted on failure or success (spec §8.7)

Spec §8.7 says worktrees are "never auto-deleted" on failure. I extended this
to success: even after a successful PR, the worktree stays until the operator
prunes it (`git worktree remove .worktrees/issue-N`). Rationale: PR review may
uncover something requiring another turn against the same branch; keeping the
worktree preserves `.agent/NOTES.md` and dispute archives for context.

## D9. No `noEmit` failure path for `vite build`

The Vite production build is not wired into `verify.sh` — only `tsc --noEmit`.
Rationale: `tsc --noEmit` covers the type-safety concern verify.sh cares about;
adding a bundling step doubles static-layer time for little marginal value at
this stage. The `npm run build` script exists for humans; add to verify.sh
once bundling issues start appearing in gameplay work.

## D10. Fencing canary: also scan reviewer stdout, not just verdict file

`scripts/fencing-canary.sh` scans the reviewer's stdout, stderr, and any file
the reviewer wrote for the canary token — not just `DISPUTE-VERDICT.md`. This
catches a reviewer that (say) leaks the token via a `git commit -m` message or
a debug `echo`. Spec §8.9 says "reviewer's stdout, DISPUTE-VERDICT.md, or any
file the reviewer wrote"; the canary script matches that.

## D11. Attribution: Co-Authored-By line

Per the harness-provided attribution guidance in effect for this session,
commits I make end with:

    Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

If the user prefers not to attribute (or wants a different form), remove or
change the line — memory rule or explicit request will override for future
sessions.

## D12. Protected-paths mechanical guard added (2026-09-18)

Operator raised: does the system guarantee the agent cannot edit
`scripts/verify.sh` to always exit 0? Prior answer: no — only human PR review.
That is thin.

Fix: added a `protected-paths` check in `verify.sh` layer 1 that diffs the
working tree against `origin/main` on a fixed list of paths (scripts, prompt
templates, GitHub config, specs, fencing canary, root config files) and fails
verify if any change appears. Matching soft rule 13 added to
`PROMPT.template.md`. Corresponding spec updates (§5.3, §7, criterion 14)
were drafted and moved to `.agent/for-review/spec-changes-2026-09-18.patch`
for the operator's separate review — the operator explicitly said spec edits
were their call, and they were not authorized to land in this commit.

Root config files (`tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
`playwright.config.ts`, `.eslintrc.cjs`) are protected too — a stuck agent
would otherwise loosen strict TypeScript or disable a lint rule to bury a
failure. If a gameplay issue legitimately needs a config change, operator does
it manually. Starting strict; relax only if actual friction shows up.

Sub-decision: the guard skips when the current branch is `main`. Rationale:
the guard exists for `issue-N` branches; on main, the operator legitimately
edits protected paths (this commit is an example). Not perfect — an operator
could accidentally break something on main and only notice later. Not
protecting against operator error is the correct tradeoff; the loop is what we
are defending against.

## D13. Issue template simplified (2026-09-18)

Operator raised: original template leaked implementation detail (Playwright
named in criteria, verify.sh restated as a checkbox, Scope required a file
list). Correct — template should ask for what and why; the loop handles how.

Rewrote to require only Summary + Acceptance criteria; Verification and Scope
are optional with "leave blank" guidance. Criteria must describe observable
behavior, not test tools or file paths. Corresponding spec update (§5.2
revised) is in `.agent/for-review/spec-changes-2026-09-18.patch` — unauthorized
to land in this commit, see D12.

## D14. Interrupted-run label recovery (fixed in the 2026-09-18 commit)

When `run-issue.sh` is interrupted (Ctrl-C or crash), the `trap` removes the
lock file but does NOT restore the issue label from `agent:in-progress` back
to `agent-ready`. Next run refuses (preflight §8.1 requires `agent-ready`).

Discovered 2026-09-18 during the first attempted self-test of issue #1.
Manual fix each time is a two-liner (`gh issue edit N --remove-label
agent:in-progress --add-label agent-ready`), but this is a papercut worth
fixing.

Fix applied in the same 2026-09-18 commit as D12/D13: `run-issue.sh` now
tracks a `CLEAN_EXIT` flag (unset by default; set to 1 by every terminal
path — success, exhaustion, dispute-AMBIGUOUS, bounded-arbitration escalation,
and inside `release_to_needs_human`). A separate `LABEL_CLAIMED` flag records
whether the `agent-ready → agent:in-progress` transition happened. The `EXIT`
trap relabels back to `agent-ready` and posts an "interrupted" comment only
when `CLEAN_EXIT` is unset AND `LABEL_CLAIMED` is set — so lock-collision
preflight failures (never claimed the label) skip recovery, and terminal
paths that already handled labels are not stomped.

## D15. Local-task flow — `/new-task` slash command (added 2026-09-18)

Operator asked to remove GitHub-ceremony friction: kick off the loop from
inside their claude code session, without filing an issue first, and defer
the promote-to-PR step to when they say the branch is ready.

Design: `scripts/run-issue.sh --local <slug>` reads a local task file
(`.agent/tasks/<slug>.md`), works on branch `local/<slug>` in
`.worktrees/local-<slug>/`, and prints (does not push) on green. The
`.claude/commands/new-task.md` slash command drives the interactive claude
session to distill pass/fail criteria from the operator's free-form request,
get approval, materialize the task file, and invoke the loop.
`.claude/commands/promote-task.md` promotes a green branch to a PR (default)
or fast-forwards `main` (opt-in, warned).

Key choices worth naming:

- **Branch prefix `local/<slug>`.** The slash distinguishes it from the
  `issue-N` naming and makes both modes safe to coexist in one repo.
- **Task file gitignored.** Not part of any branch's history until
  `promote-task --pr` copies it into the GitHub issue body. Rationale: keeps
  failed local attempts fully off GitHub; the operator can iterate freely
  without an audit-trail cost.
- **Task file copied into the worktree.** The worktree cannot see the main
  checkout's `.agent/tasks/` (different working tree). `run-issue.sh --local`
  copies the file in so `build-prompt.sh` can render it via its own relative
  path.
- **Promote is manual, not automatic.** Operator explicitly asked for this.
  Trade-off: forgets easily; branches can accumulate. Not fixing until it
  proves a problem in practice.
- **`--main` promotion is warned but supported.** Bypasses PR review, which
  is the design's core human-in-the-loop guarantee. Kept as an escape hatch
  because the operator asked for it. If misused it invalidates the design's
  safety story — the warning marks that in the transcript.
- **`.claude/commands/` NOT protected.** Slash commands are operator
  convention, not part of the loop's own state. If a future issue starts
  modifying them, add to the protected-paths set.
- **Spec update deferred.** Local mode is currently an operator affordance,
  not a design change. Once it settles in practice (a few successful
  end-to-end cycles), land a spec revision adding an §12 "Operator workflows"
  or similar. Documented here so it does not get forgotten.
