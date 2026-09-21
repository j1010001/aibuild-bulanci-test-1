# Agent Build System — Design Specification

Date: 2026-09-15
Status: approved (design review) — revised 2026-09-16 to add dispute arbitration (§2.5, §6.5, §8.9); revised 2026-09-18 to simplify the issue template (§5.2) and add mechanical protected-paths enforcement (§5.3, §7)

## 1. Overview

This spec describes the **build system** to be constructed in this repository: an
issue-driven development loop in which a human files GitHub issues (bugs, features)
against the Browser Party Shooter game (see `spec/2026-09-15-browser-party-shooter-design.md`)
and an AI coding agent picks each issue up, implements it, verifies its work against a
mechanical finish line, and opens a pull request for human review.

The system is deliberately boring: bash scripts, the `gh` CLI, and the `claude` CLI.
No frameworks, no daemons, no multi-agent orchestration. Everything is inspectable.

**The human remains the operator.** The system is not autonomous fire-and-forget.
The operator's jobs: write issues with verifiable acceptance criteria, review PRs,
and tune the prompt/rules when the agent fails in a new way.

### Reading this spec

Sections 2–4 explain *how and why* the system works (the mental model).
Sections 5–10 are the *construction requirements* — what to build, file by file.
Sections 11–13 are acceptance criteria, build order, and known failure modes.

A coding agent instructed to "build the system described in this spec" should be
able to do so without asking questions. Where a judgment call remains, it is
marked DECISION with the recommended default.

## 2. How the system works (mental model)

### 2.1 The loop

The core is a loop that repeatedly invokes a coding agent on the same prompt:

```
for i in 1..MAX_ITERATIONS:
    cat PROMPT.md | claude -p      # one agent turn; full tool access
    if ./verify.sh passes:         # checked by bash, NOT by the agent
        open PR, exit 0
mark issue needs-human, exit 1
```

Each `claude -p` invocation is a fresh agent process. Two properties follow:

1. **The filesystem is the agent's memory.** An agent turn remembers nothing from
   previous turns. All continuity — what was done, what remains, what was learned —
   must live on disk: the code itself, git history, and `.agent/NOTES.md`.
2. **"Done" is decided by bash, not by the agent.** An agent stops when it *believes*
   the task is complete; the loop stops when `verify.sh` exits 0. The finish line is
   environmental and mechanical. This is the single most important design decision.

### 2.2 Issue-driven workflow (state machine)

Issues carry their state in GitHub labels. Exactly one state label at a time:

```
                operator files issue            run-issue.sh N          verify passes
┌──────────┐   with acceptance criteria   ┌──────────────┐   loop   ┌───────────┐
│ (no      │ ───────────────────────────► │ agent-ready  │ ───────► │ agent:    │
│  label)  │  operator adds label        │ (queued)     │  starts  │ in-progress│
└──────────┘                              └──────────────┘          └─────┬─────┘
                                                                          │
                    ┌─────────────────────────────────────────────────────┤
                    │ verify.sh exit 0                          MAX iterations
                    ▼                                          exhausted
             ┌─────────────┐                              ┌──────────────┐
             │ agent:      │  PR opened, operator reviews │ agent:       │
             │ in-review   │ ──► merged by HUMAN only     │ needs-human  │
             └─────────────┘                              └──────────────┘
                                                                   │
                                                                   ▼
                                              operator reads logs, tightens the
                                              issue criteria or the standing rules,
                                              re-labels agent-ready
```

Invariants:
- The agent **never merges**. Merging is a human action. The agent's deliverable is a PR.
- An issue is worked on **exactly one worktree/branch** (`issue-<N>`), never on `main`.
- A lockfile prevents two concurrent runs (see 8.6).
- `agent:needs-human` is a first-class outcome, not a crash. It means "the finish
  line was not reachable in the iteration budget; a human must intervene."

### 2.3 The verification stack (backpressure)

`verify.sh` is a single entrypoint that runs checks fastest-first and exits non-zero
at the first failure. The agent is instructed to run it after every change; the loop
script runs it after every agent turn. Layers:

| # | Layer | Command (indicative) | What it catches | Speed |
|---|---|---|---|---|
| 1 | Static | `tsc --noEmit` + `eslint` + fencing checks (§8.9) | Type errors, dead code, wrong APIs, fencing regressions | seconds |
| 2 | Unit | `vitest run` | Logic regressions in the deterministic `sim` core | seconds |
| 3 | E2E smoke | Playwright against `npm run dev` | App doesn't boot, console errors, blank canvas, broken input→state wiring | tens of seconds |

Layer 3 requires a **test hook** in the game app (section 9): in dev builds the app
exposes game state on `window.__game` so Playwright can assert state transitions
(e.g., "after pressing Space, a bullet exists") instead of screenshot-guessing.
The game spec's solo **practice mode** is what makes layer 3 possible without WebRTC.

### 2.4 Why this shape (evidence base)

- One issue per loop turn, standing prompt re-read every iteration — the Ralph
  technique (Huntley). Prompt rules below are compiled from its documented failure
  modes (placeholder implementations, false "not implemented" conclusions, build/test
  backpressure from parallel test runs).
- Acceptance criteria in the issue, checked mechanically — spec-driven development
  (spec-kit) and the agent-readable acceptance-criteria pattern: every criterion must
  be pass/fail with no room for two readers to disagree.
- Single agent, human review gate, no multi-agent fan-out — coding tasks parallelize
  poorly (interdependent edits); Anthropic's production guidance and cost data
  (multi-agent ≈ 15× tokens) say start with one well-instrumented loop. The dispute
  arbitration flow (§6.5, §8.9) is a bounded, single-shot exception to this rule,
  invoked only when the implementing agent explicitly signals a test-vs-criterion
  contradiction — not a general-purpose second agent.

### 2.5 Terms

- **Dispute** — a signal, raised by the implementing agent via `.agent/DISPUTE.md`,
  that a failing test contradicts its acceptance criterion. Distinct from a normal
  verify failure, which the agent is expected to fix.
- **Review agent** — a separate agent invocation with a restricted (fenced) context,
  invoked by the loop solely to adjudicate a dispute. It sees only material needed to
  compare the test against the acceptance criterion; it cannot see the implementation
  under `src/`, the working notes, or the implementing agent's session history.
  *(For example, in Claude Code this is implemented as a subagent invocation with a
  scoped file allowlist.)*

## 3. Scope

### In scope (this system)

- Bash scripts: `run-issue.sh`, `build-prompt.sh`, `verify.sh`, `setup-labels.sh`,
  `review-dispute.sh`.
- Standing prompt templates: `.agent/PROMPT.template.md` (implementing agent),
  `.agent/REVIEW.template.md` (review agent).
- GitHub issue template and label set.
- `AGENT.md` — the project's self-improving operating manual.
- A **minimal runnable app skeleton** (walking skeleton) so `verify.sh` has a green
  baseline from the first issue: Vite + TypeScript + three.js app that renders an
  empty 3D scene, plus vitest and Playwright wired up, plus the `window.__game`
  test hook, plus practice-mode entry point. The skeleton implements *no gameplay* —
  gameplay arrives through issues.
- A **fencing canary** file `src/__fencing-canary.ts` (see §8.9) — load-bearing test
  infrastructure for the dispute-review flow.
- `.gitignore` entries for `.agent/` runtime artifacts, `.worktrees/`, Playwright output.

### Out of scope

- Automatic issue pickup (watcher daemon). The operator runs `run-issue.sh N`
  by hand. (Natural later graduation: a 30-line polling wrapper.)
- Multi-agent orchestration beyond the bounded, single-shot dispute reviewer (§6.5, §8.9).
  No dependency-graph issue trackers, merge queues, or role-based agent fleets.
- Implementing the game itself — that happens through issues after the system exists.
- CI hosting. `verify.sh` is designed to be CI-able later, but no CI config is built.

## 4. Repository layout after construction

```
├── spec/                                  # existing — game design spec(s)
├── .github/
│   └── ISSUE_TEMPLATE/
│       └── agent-task.md                  # issue template with acceptance criteria
├── .agent/
│   ├── PROMPT.template.md                 # implementing agent standing rules (checked in)
│   └── REVIEW.template.md                 # review agent standing rules (checked in)
├── scripts/
│   ├── run-issue.sh                       # the loop
│   ├── build-prompt.sh                    # assembles per-issue PROMPT.md
│   ├── review-dispute.sh                  # invokes the review agent with a fenced context
│   ├── verify.sh                          # the finish line
│   └── setup-labels.sh                    # one-time label creation
├── src/                                   # walking skeleton app (Vite + TS + three.js)
│   ├── __fencing-canary.ts                # load-bearing test infra (§8.9); do NOT delete
│   └── ...                                #   (gameplay added later via issues)
├── tests/
│   ├── unit/                              # vitest (starts nearly empty)
│   └── e2e/                               # Playwright smoke suite
├── AGENT.md                               # how to build/test/run; agent-maintained
├── BUILD-SYSTEM-README.md                 # operator documentation (exists already)
├── package.json, tsconfig.json, vite config, playwright.config.ts, vitest config
└── .gitignore
```

Runtime artifacts (gitignored): `.agent/PROMPT.md`, `.agent/REVIEW.md`, `.agent/NOTES.md`,
`.agent/last-verify.log`, `.agent/DISPUTE.md`, `.agent/DISPUTE-VERDICT.md`,
`.agent/DISPUTES/` (archived per-turn copies), `.agent/review-inputs/` (materialized
fenced inputs), `.worktrees/issue-<N>/`, `.agent/run.lock`.

## 5. GitHub configuration

### 5.1 Labels (created by `scripts/setup-labels.sh`, idempotent)

| Label | Color | Meaning |
|---|---|---|
| `agent-ready` | green | Queued for the agent. Issue body is complete and verifiable. |
| `agent:in-progress` | yellow | A loop is actively working this issue. |
| `agent:in-review` | blue | PR open, awaiting human review. |
| `agent:needs-human` | red | Loop exhausted its iteration budget, or a dispute could not be resolved by the reviewer; see logs comment. |

### 5.2 Issue template (`.github/ISSUE_TEMPLATE/agent-task.md`)

Template design principle: the operator writes the *what and why*; the loop
handles the *how*. Never require the operator to name test frameworks, list
files the agent will edit, or restate the standard finish line. `Summary` and
`Acceptance criteria` are required; `Verification` and `Scope` are optional
and stay blank when they add nothing.

Required sections, in this order:

```markdown
## Summary
One paragraph. What changes and why.

## Acceptance criteria
- Given <precondition>, When <observation>, Then <observable, checkable result>
- ... (each must be pass/fail; no "properly", "gracefully", "fast")

## Verification (optional)
<Extra checks beyond `./scripts/verify.sh` (which runs automatically).
Leave blank if none.>

## Scope (optional)
<What part of the product this concerns, and anything the agent should not
touch. Leave blank if the whole codebase is fair game. Do not list files —
name product areas.>
```

Rules the template must state in comments:

- Criteria describe **observable behavior**, not implementation. Do not name
  test tools (Playwright, Vitest) or file paths in criteria — the agent picks
  those.
- Criteria must be checkable by a machine or by a human in under a minute.
- Vague adjectives are forbidden.
- `scripts/verify.sh` is the standard finish line and runs automatically. Fill
  `Verification` only when there is an extra check verify.sh does not cover
  (e.g., "manual: play a round with two browser tabs and confirm no desync").
- If the writer cannot state a finish line as one or more observable-behavior
  criteria, the issue is not ready to be labeled `agent-ready`.

### 5.3 Protected paths (mechanical guard)

Some files are owned by humans and the loop, not by issue implementations.
The agent may not modify:

- `scripts/**` — the loop and verify.sh itself
- `.agent/PROMPT.template.md`, `.agent/REVIEW.template.md` — standing prompts
- `.github/**` — issue template and any workflows
- `spec/**` — design specs (human-owned)
- `src/__fencing-canary.ts` — load-bearing per §13
- Root config files: `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
  `playwright.config.ts`, `.eslintrc.cjs`

The prompt template states this in a soft rule (rule 13). Enforcement is
mechanical: `verify.sh` layer 1 diffs the working tree against `origin/main`
on the listed paths and exits non-zero if any change appears. Same design
principle as "done is decided by bash": the guard exists in bash so an agent
that tries to loosen a lint rule, disable strict TypeScript, edit verify.sh to
always exit 0, or delete the fencing canary is stopped by the next verify —
not by hoping it read the prompt.

Paths NOT protected (the agent may modify them):

- `AGENT.md` — the agent maintains it per prompt rule 9
- `src/**` except the canary — game code
- `tests/**` — the agent writes tests
- `index.html`, `package.json`, `package-lock.json` — legitimate UI and
  dependency changes

If a legitimate issue truly needs to modify a protected path, the agent stops
and ends the turn with a note in `.agent/NOTES.md`; the operator makes the
change manually and re-labels `agent-ready`. There is no in-loop escape hatch;
the whole point is that the loop cannot relax its own constraints.

## 6. The standing prompt (`.agent/PROMPT.template.md`)

`build-prompt.sh` renders the template into `.agent/PROMPT.md` by substituting
`{{ISSUE_NUMBER}}`, `{{ISSUE_TITLE}}`, `{{ISSUE_BODY}}`. The rendered prompt is
re-fed to the agent every iteration unchanged. Template content requirements:

1. **Role and task**: "You are implementing GitHub issue #{{ISSUE_NUMBER}}:
   {{ISSUE_TITLE}} in this repository." followed by the full issue body.
2. **Read first**: `AGENT.md`, the referenced spec sections, and `.agent/NOTES.md`
   (if it exists) — before editing anything.
3. **Search before building**: never assume functionality is missing; grep/read the
   codebase first. (False "not implemented" conclusions cause duplicate work.)
4. **One issue only**: the smallest change that satisfies every acceptance criterion.
   No drive-by refactors, no speculative features.
5. **Verify continuously**: run `./scripts/verify.sh` after every change; a turn MUST
   NOT end while `verify.sh` fails, unless you are raising a dispute per rule 12.
   Work is not done until it passes.
6. **No placeholders**: full implementations only. No stub functions, no
   `// TODO: implement`, no trivially-true tests written to make criteria pass.
   Tests must derive from the issue's acceptance criteria, not from the code written.
   Tests already committed to this issue's branch may not be edited during
   implementation. If you believe a test is wrong, raise a dispute per rule 12; do
   not silently modify it.
7. **Commit discipline**: commit after every logical change with a message referencing
   the issue number (`issue #42: add bullet spawn on shoot edge`). Push at end of turn.
8. **Memory**: maintain `.agent/NOTES.md` — what was done, what remains, gotchas —
   written for a future reader with zero context. Update it every turn.
9. **Self-improvement**: if you discover something about how to build, test, or run
   this project (a command, a pitfall), update `AGENT.md` briefly. Do not put status
   reports in `AGENT.md`.
10. **Subagent discipline**: use subagents for bulk search/reading; exactly one
    process runs the test suite at a time.
11. **Stuck protocol**: after 3 failed attempts at the same problem, stop editing,
    write a full diagnosis to `.agent/NOTES.md`, and end the turn. Do not thrash.
12. **Dispute protocol**: If `verify.sh` fails and, after at least one honest attempt
    to satisfy the failing test, you have concluded that the test itself contradicts
    the issue's acceptance criterion or the referenced spec, do NOT edit the test or
    the code. Write `.agent/DISPUTE.md` containing:
    - the failing test file and line(s),
    - the exact acceptance criterion or spec sentence you believe the test contradicts,
    - a ≤200-word explanation of the contradiction,
    - the minimal test change you propose (as a code snippet, not a diff you apply).

    Then end the turn. Do not raise a dispute on the first failed verify — attempt
    the test at least once. Do not raise a dispute for a test failure that reflects
    a bug in your implementation.

## 6.5 The reviewer standing prompt (`.agent/REVIEW.template.md`)

The reviewer is a distinct role from the implementing agent, with a separate
template, separate rules, and a fenced context (§8.9). `scripts/review-dispute.sh`
renders this template into `.agent/REVIEW.md` by substituting the issue and dispute
details. Template content requirements — each of these must be present verbatim or
in substance:

1. **Role**: "You are adjudicating a dispute raised by an implementing agent. Your
   only output is a verdict on whether a failing test contradicts its acceptance
   criterion. You do not implement features, refactor code, comment on style, or
   offer advice to the implementing agent."

2. **Available material**: the reviewer names every file it may read, taken directly
   from the §8.9 allowlist. The prompt states that any attempt to read outside this
   list will fail at the tool level and that this is a design property, not a bug —
   the reviewer should not attempt to work around it.

3. **Default disposition is `DEV_WRONG`.** *This rule is load-bearing.* State it in
   the prompt in these words or near-equivalents:

   > "Your default disposition is `DEV_WRONG`. Return `TEST_WRONG` only if the test's
   > assertion cannot be true under any reasonable reading of the acceptance criterion.
   > Ambiguity, awkwardness, style preferences, or 'I would have written this test
   > differently' are not grounds for `TEST_WRONG` — the criterion binds, not your
   > preference. Disagreement between you and the test author does not settle the
   > question in your favor. When in doubt, return `DEV_WRONG` and let the
   > implementation adapt."

   Rationale: reviewers exhibit a documented bias toward the more actionable verdict
   (`TEST_WRONG` produces a concrete correction; `DEV_WRONG` produces nothing to
   commit). Without this rule stated explicitly and forcefully, reviewers rubber-stamp
   disputes at rates that make the arbitration mechanism worse than useless — it
   launders the dev's mistake with the appearance of independent review. The prompt
   must resist this bias structurally; a mild phrasing will not.

4. **`AMBIGUOUS` is reserved for criterion defects, not test defects, and not
   reviewer discomfort.** *Also load-bearing.* State literally:

   > "Return `AMBIGUOUS` only when the acceptance criterion itself is under-specified —
   > i.e., a competent implementer could not know from the criterion alone whether
   > the test is correct. Do not use `AMBIGUOUS` as an escape valve when the criterion
   > is clear but the situation is subtle. Subtle situations still resolve to
   > `TEST_WRONG` or `DEV_WRONG`. If the criterion clearly supports one side, return
   > that verdict even if the case feels close."

   Rationale: `AMBIGUOUS` escalates to a human, which is expensive. Reviewers hedge
   by defaulting there to avoid taking a position; this both wastes human attention
   and trains the operator to distrust the mechanism.

5. **No modification of implementation, ever.** The reviewer may not edit any file
   under `src/`. If the verdict is `TEST_WRONG`, the reviewer commits a minimal
   correction to the disputed test file only. The correction makes the test consistent
   with the acceptance criterion; it does not improve style, add coverage, or refactor.

6. **Rationale format**: `DISPUTE-VERDICT.md` must (a) quote the specific criterion
   text, (b) quote the specific test assertion, (c) explain in one paragraph why they
   are or are not consistent under a reasonable reading of the criterion. No advice to
   the implementing agent. No commentary on the codebase.

7. **No self-improvement, no notes, no worktree state.** The reviewer does not
   maintain or read `AGENT.md`, `NOTES.md`, or any other cross-turn state. Its entire
   persistent output is `DISPUTE-VERDICT.md` and, for `TEST_WRONG`, a single
   test-correction commit. This is what "single-shot" means (rule 8).

8. **Single-shot.** The reviewer produces its verdict in one turn. If it cannot
   decide in one turn, it returns `AMBIGUOUS`. The loop does not iterate the
   reviewer — there is no reviewer stuck protocol, because the reviewer has one job
   that must complete or escalate immediately.

## 7. `scripts/verify.sh` contract

- Runs from the repo root (or a worktree root) with no arguments.
- Executes layers in order: static → unit → e2e. Stops at first failure.
- Prints a clear per-layer banner (`== layer 2: unit tests ==`) to stdout.
- Exit 0 iff all layers pass. Any failure → exit 1.
- E2E layer boots the dev server itself (Playwright webServer config), runs the
  smoke suite, and tears it down. Smoke suite v1 (against the walking skeleton):
  1. Home page loads with zero browser console errors.
  2. The 3D canvas renders non-blank pixels (screenshot compared against blank).
  3. Practice mode: `window.__game.getState()` returns a state object; after
     dispatching a movement key, the player position changes; after Space, a bullet
     appears (once gameplay exists — skeleton version asserts the hook exists and
     returns an object).
- Screenshots from the e2e run are written to `tests/e2e/output/` for PR evidence.
- The static layer additionally runs the fencing verification checks defined in
  §8.9 (static allowlist grep + runtime canary check) and the protected-paths
  guard defined in §5.3.
- When `.agent/DISPUTE.md` exists at the start of a loop iteration, `verify.sh` is
  not run for that iteration; the loop routes to the dispute-review flow (§8.9)
  instead.

## 8. `scripts/run-issue.sh` behavior

Usage: `./scripts/run-issue.sh <issue-number>` from the repo root.

Step-by-step requirements:

8.1 **Preflight** — fail fast with a clear message if: no argument; `gh auth status`
fails; issue does not exist; issue lacks label `agent-ready`; issue is open but
already `agent:in-progress`; the git working tree is dirty.

8.2 **Claim** — `gh issue edit N --add-label agent:in-progress --remove-label agent-ready`.

8.3 **Isolate** — `git fetch origin`, then
`git worktree add .worktrees/issue-N -b issue-N origin/main`. All agent work happens
inside the worktree. `main` is never touched by the agent.

8.4 **Assemble prompt** — run `build-prompt.sh N` inside the worktree, producing
`.worktrees/issue-N/.agent/PROMPT.md` from the template plus the issue body
(`gh issue view N --json title,body`).

8.5 **Loop** — `MAX_ITERATIONS` default 15, overridable via env
(`MAX_ITERATIONS=25 ./scripts/run-issue.sh 7`). Per iteration:
- If `.agent/DISPUTE.md` exists, run the dispute-review flow (§8.9) instead of the
  normal turn. The dispute-review consumes one iteration of the budget.
- `cat .agent/PROMPT.md | claude -p --dangerously-skip-permissions`
  (DECISION: the flag is required for unattended operation; the blast radius is
  contained to the worktree. Document this prominently in the README.)
- If `claude` exits non-zero, the turn produced no work (CLI bailed before the
  agent could act — not logged in, credit exhausted, killed mid-turn, harness
  failure). The loop must NOT then run `verify.sh` and declare success off the
  pre-turn tree; a walking skeleton that already passes verify would produce a
  false GREEN against work that never happened. Instead: escalate immediately
  via the standard needs-human path (issue comment + label in GitHub mode,
  banner in local mode), and exit 1. This is orthogonal to the exhaustion path
  (§8.7), which fires only after MAX_ITERATIONS of *executed* turns.
- Otherwise: `./verify.sh > .agent/last-verify.log 2>&1`.
- If verify exits 0: **success path** — push branch, open PR with
  `gh pr create --title "issue #N: <title>" --body-file -` where the PR body contains:
  the issue link, the full acceptance criteria, the *tail of last-verify.log* as
  evidence, and the e2e screenshot paths. Relabel `agent:in-review` (remove
  `agent:in-progress`). Exit 0.

8.6 **Concurrency** — a lockfile `.agent/run.lock` (created with `mkdir`, the
portable atomic primitive) guards the whole run; a second invocation exits
immediately with "another run is active (lock: …)". Lock is removed on every exit
path via `trap`.

8.7 **Exhaustion path** — after MAX_ITERATIONS without green verify:
`gh issue comment N` with the tail of `last-verify.log` and a note that the agent
could not reach the finish line; relabel `agent:needs-human` (remove
`agent:in-progress`). Exit 1. The worktree and branch are left in place for
inspection — never auto-deleted.

8.8 **No state in the script** — the script holds no memory between invocations.
Everything it needs is in GitHub (issue, labels), git (branch, commits), or the
worktree (`.agent/` files).

### 8.9 Dispute-review flow

Triggered when `.agent/DISPUTE.md` is present at the top of a loop iteration.

**Preconditions checked by the loop** (fail the dispute with `AMBIGUOUS` if
violated, do not invoke the reviewer):
- DISPUTE.md names an existing test file and at least one line number.
- DISPUTE.md quotes text present in the issue body or a spec section referenced in
  the issue's Scope.
- No prior `DEV_WRONG` verdict exists for this issue (see bounded-arbitration
  invariant below).

**Invocation**: `scripts/review-dispute.sh` starts a fresh agent process using
`.agent/REVIEW.template.md` as its standing prompt. Its context is **fenced** —
meaning the agent process is *technically incapable* of reading anything outside
the allowlist below, not merely instructed not to. Prompt-level restrictions are
insufficient. Fencing must be enforced by the tool's process/permission mechanism
*(for example, in Claude Code this is a subagent invocation with an explicit tool
allowlist restricting Read/Grep/Glob to a whitelisted path set; a bare `claude -p`
with only a prompt-level "don't read src/" instruction is NOT sufficient and
constitutes a spec violation)*.

If the tool in use cannot mechanically enforce the allowlist, `review-dispute.sh`
must fail with a clear error and the loop must escalate to `agent:needs-human` with
the message "fencing unavailable — reviewer cannot be trusted." It must never
degrade to an unfenced invocation. Fencing is the load-bearing property of the
entire arbitration mechanism; unenforced, the reviewer becomes a second implementer
with the same context bias and the arbitration loses all meaning.

**Allowlist** (all reads by the reviewer process must resolve to these paths; any
read outside is a hard error at the tool level):
- `.agent/review-inputs/issue.md` — the issue title, acceptance criteria, and Scope,
  materialized to a single file before invocation.
- `.agent/review-inputs/spec-*.md` — the spec section(s) named in the issue's Scope,
  extracted as subsections only. The full spec file is not exposed, to prevent
  broad browsing.
- The disputed test file(s) named in DISPUTE.md (paths verified against the
  allowlist before invocation).
- `.agent/DISPUTE.md`.
- `.agent/REVIEW.md` (the reviewer's own rendered standing prompt).

**Denylist** (redundant with the allowlist; stated explicitly because these are
the paths a reviewer would most plausibly try to read if fencing failed):
- Any file under `src/`, `tests/` other than the specifically disputed file(s),
  or `.worktrees/`.
- `.agent/NOTES.md`, `.agent/PROMPT.md`, `.agent/last-verify.log`, prior
  `.agent/DISPUTES/` archives.
- The git log or git diff of any commit touching `src/`.
- Any network address (no outbound HTTP; no `gh`/`git fetch` calls).

**Fencing verification** (required, runs as part of `verify.sh` layer 1):
1. **Static check**: grep `scripts/review-dispute.sh` for the tool-specific fencing
   invocation (e.g., the subagent-with-allowlist flag) and fail if absent, removed,
   or replaced with a bare invocation.
2. **Runtime canary check**: a file `src/__fencing-canary.ts` contains a distinctive
   token (e.g., `FENCING_CANARY_9F3A2C`) and is otherwise a no-op export. The verify
   layer runs the reviewer against a synthetic dispute and asserts the canary token
   does not appear in the reviewer's stdout, DISPUTE-VERDICT.md, or any file the
   reviewer wrote. If it does, the fencing has been bypassed and verify exits
   non-zero naming this layer.

The canary file is intentional load-bearing test infrastructure and is documented
as such in `AGENT.md`. Removing it or removing the check is a spec violation
regardless of who does it (human or agent).

**Output**: the review agent writes exactly one file, `.agent/DISPUTE-VERDICT.md`,
whose first line is one of:

```
VERDICT: TEST_WRONG
VERDICT: DEV_WRONG
VERDICT: AMBIGUOUS
```

followed by a ≤300-word rationale. If the verdict is `TEST_WRONG`, the review agent
additionally commits the minimal test correction on the issue branch with message
`dispute-review: apply test correction (issue #N)`. It does not edit any file under
`src/`.

**Loop routing**:

| Verdict | Loop action |
|---|---|
| `TEST_WRONG` | Archive DISPUTE.md and VERDICT to `.agent/DISPUTES/turn-K/`. Delete DISPUTE.md. Resume normal iteration; the dev's next turn will see the corrected test and re-run verify. |
| `DEV_WRONG` | Archive as above. Delete DISPUTE.md. Prepend the verdict text to `.agent/NOTES.md` under a `## Dispute rejected (turn K)` header. Resume normal iteration; the dev's next turn sees the verdict at the top of NOTES.md. |
| `AMBIGUOUS` | Do not resume. Comment DISPUTE.md and VERDICT on the issue. Relabel `agent:needs-human` (remove `agent:in-progress`). Exit 1. |

**Bounded-arbitration invariant** (this is the whole point of the design):
- The reviewer runs at most **once per issue** on the same conclusion. If a
  `DEV_WRONG` verdict exists and the dev writes a **new** DISPUTE.md in a subsequent
  turn, the loop immediately escalates: comment both DISPUTE files and the prior
  verdict on the issue, relabel `agent:needs-human`, exit 1. The reviewer is not
  invoked a second time.
- A `TEST_WRONG` verdict does not count against this bound (the dev has not
  disputed; it accepted a correction and resumed).

**Cost note**: the dispute-review consumes one iteration of `MAX_ITERATIONS`. The
reviewer's session is typically short (small fenced context, single-file output).

## 9. Requirement on the game app: the test hook

The walking skeleton — and all later game code — must expose, in dev mode only:

```ts
window.__game = {
  getState(): unknown,        // serializable snapshot of current sim/menu state
  press(key: string): void,   // dispatch a normalized input as if from the keyboard
}
```

This is what makes e2e verification assertions possible (`expect(state.bullets).toHaveLength(1)`)
instead of pixel-diffing. The hook is behind an env check so production builds
exclude it. Gameplay issues that add state must extend the hook's state exposure
accordingly; the standing prompt says so.

## 10. `AGENT.md` contract

Created at bootstrap with the minimal operating manual: how to install, run dev
server, run each verify layer individually, project layout, and the "rules of the
repo" (deterministic sim is pure TS with no DOM imports; state changes only via
`step()`; etc., per the game spec's architecture section). Thereafter the agent
maintains it per standing rule 9. It is checked into git — its evolution is
reviewable in PR diffs.

`AGENT.md` must also document the fencing canary (`src/__fencing-canary.ts`) as
intentional load-bearing test infrastructure that must not be removed or refactored
away — see §8.9 and §13.

## 11. Acceptance criteria for THIS system

The system is built when all of the following hold (each is pass/fail):

1. **Scripts exist and are executable**: the five scripts in section 4, plus
   `.agent/PROMPT.template.md`, `.agent/REVIEW.template.md`, `AGENT.md`, the issue
   template, and the walking skeleton app. Given a fresh clone, When following
   `BUILD-SYSTEM-README.md` setup steps, Then `./scripts/verify.sh` exits 0.
2. **Labels**: Given `setup-labels.sh` has run, When `gh label list` is executed,
   Then all four labels from 5.1 exist. Re-running the script changes nothing.
3. **Verify catches failure**: Given a deliberately introduced type error, When
   `./scripts/verify.sh` runs, Then it exits 1 and the output names the failing layer.
4. **End-to-end issue cycle**: Given issue #1 labeled `agent-ready` whose criteria are
   "the home page displays the text entered in the issue body", When
   `./scripts/run-issue.sh 1` completes, Then either (a) a PR exists labeled
   `agent:in-review` whose diff implements the criteria and whose body contains the
   verify log, or (b) issue #1 is labeled `agent:needs-human` with a logs comment.
   (This criterion exercises the loop against a trivially-verifiable issue.)
5. **Locking**: Given a run in progress, When a second `run-issue.sh` is invoked,
   Then it exits immediately non-zero with a lock message.
6. **Prompt completeness**: `grep` of the rendered `.agent/PROMPT.md` finds every
   standing rule from section 6 (spot-check rules 3, 5, 6, 7, 12 by their key phrases).
7. **Agent never on main**: after any completed or failed run,
   `git branch --show-current` in the main checkout is unchanged and `git status`
   is clean.
8. **No placeholders escape**: the standing prompt contains the no-placeholder rule
   (rule 6) verbatim in substance.
9. **Dispute resolvable (test at fault)**: Given a test deliberately written to
   contradict its criterion, When the dev writes DISPUTE.md and the loop invokes
   the reviewer, Then `.agent/DISPUTE-VERDICT.md` exists with `VERDICT: TEST_WRONG`,
   the corrected test is committed by the reviewer, and the next iteration's verify
   passes.
10. **Dispute rejectable (dev at fault)**: Given a correct test with a spurious
    dispute, When the reviewer runs, Then it produces `VERDICT: DEV_WRONG`, the
    dev's `.agent/NOTES.md` receives a `## Dispute rejected` section, and the loop
    continues to iterate.
11. **Bounded arbitration**: Given a prior `DEV_WRONG` verdict on the current issue,
    When the dev writes a second DISPUTE.md, Then the loop escalates to
    `agent:needs-human` in the same iteration without invoking the reviewer, and
    both DISPUTE files plus the prior verdict are posted as an issue comment.
12. **Fencing enforced**: Given a modified `scripts/review-dispute.sh` that drops
    the allowlist flag (or a modified reviewer that attempts to read `src/`), When
    `./scripts/verify.sh` runs, Then it exits non-zero and names the fencing layer
    as the failure. The canary token from `src/__fencing-canary.ts` never appears
    in the reviewer's output during any passing run of verify.
13. **Reviewer bias rule present verbatim**: `grep` of `.agent/REVIEW.template.md`
    finds the exact phrase "Your default disposition is `DEV_WRONG`" and the exact
    phrase "Return `AMBIGUOUS` only when the acceptance criterion itself is
    under-specified". Rewording these — even to say the same thing more elegantly —
    is a spec violation because the phrasing itself is load-bearing (see §6.5
    rules 3–4 rationale).
14. **Protected paths enforced**: Given an issue branch with a modification to
    any path listed in §5.3, When `./scripts/verify.sh` runs, Then it exits
    non-zero and names `static/protected-paths` as the failing layer, listing
    the offending file(s). Given no such modification, verify passes on that
    layer with a "no protected paths modified" message.

## 12. Build order

1. **Skeleton + verify first**: scaffold the app, `verify.sh` with all three layers
   green against the empty scene. This proves the finish line works before the loop
   exists.
2. **Labels + issue template + AGENT.md + prompt template.**
3. **`build-prompt.sh`, then `run-issue.sh`** (with lockfile and both exit paths).
3.5. **Add the dispute-review flow**: `scripts/review-dispute.sh`,
   `.agent/REVIEW.template.md`, the `src/__fencing-canary.ts` file, the fencing
   verification checks in `verify.sh`, and the §8.9 branch in `run-issue.sh`.
   Self-test with two deliberately-crafted seed issues covering criteria 11.9 and 11.10.
4. **Self-test**: file issue #1 (criterion 11.4), run the loop against it.
   Iterate on the prompt until the loop completes it. This first run is expected to
   expose prompt gaps — that is its purpose.
5. **Seed game issues**: the operator then files gameplay issues derived from the
   game spec, one per concern, each with acceptance criteria, starting with the
   `sim` core (pure, unit-testable) before rendering/networking.

## 13. Known failure modes (operator's field guide)

| Symptom | Cause | Fix |
|---|---|---|
| PR implements a stub that "passes" | Criterion too weak | Tighten criterion; restate rule 6 with the observed trick named |
| Agent rebuilds existing code | Didn't search first | Rule 3 exists; add the specific symbol it missed to NOTES/AGENT.md |
| Loop edits forever, never green | Finish line unreachable or broken verify | Read `last-verify.log`; fix verify or split the issue |
| Tests mirror the code, not the spec | Self-confirming tests | Reject PR; demand criteria-derived tests in the issue's Verification section |
| Same failure across 3+ iterations | Thrashing | Stuck protocol (rule 11) should have fired; tighten it with the observed pattern |
| Context bloat, slow turns | Agent reading whole repo each turn | Enforce subagent rule (10); narrow the issue's Scope section |
| Dispute raised on first failed verify | Dev skipped the "honest attempt" clause of rule 12 | Prompt tightening: quote rule 12 verbatim; add a "count of failed verifies for this test" check that the loop can enforce cheaply. |
| Dev disputes every `DEV_WRONG` verdict → always escalates | Dev over-trusts its own reasoning | Reject the PR pattern in review; add a standing prompt rule that `DEV_WRONG` verdicts are terminal for that test unless the criterion itself is changed via a new issue. |
| Reviewer sides with a mirrored test / rubber-stamps disputes | Fencing bypassed OR §6.5 rule 3 weakened/removed | Run the fencing canary check in `verify.sh` — confirm it wasn't skipped. Grep REVIEW.template.md for the verbatim rule 3 phrasing (§11.13). If either fails, the arbitration is invalid; discard any recent `TEST_WRONG` verdicts and re-adjudicate manually. |
| Reviewer over-uses `AMBIGUOUS` to avoid deciding | §6.5 rule 4 weakened, or reviewer template is being fed dispute context that makes it hedge | Restore rule 4 verbatim; if the pattern persists, add examples of "close but clearly `DEV_WRONG`" and "close but clearly `TEST_WRONG`" cases to the reviewer template. Do not accept the pattern by relaxing the rule. |
| Someone deletes or "cleans up" `src/__fencing-canary.ts` | Agent or human treated it as dead code | The file is documented in `AGENT.md` as intentional test infrastructure; §11.12 will fail if it is removed. Restore from git history. Consider a pre-commit hook that rejects deletions of this file without an accompanying `.agent/CANARY-REPLACEMENT.md` explaining the new mechanism. |

Every new failure mode observed in practice → add a row here and a rule to the
prompt. That tuning loop *is* the operating model, not a symptom of the system
failing.