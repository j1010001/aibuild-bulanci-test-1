# AGENT.md — operating manual for this repo

Maintained by the agent build loop. See
`spec/2026-09-15-agent-build-system-design.md` for the system's design rationale
and `BUILD-SYSTEM-README.md` for operator instructions.

## Install

```
npm install
npx playwright install chromium
```

Requires Node ≥ 20.

## Run the game (dev)

```
npm run dev
```

Opens on `http://localhost:5173`. Practice mode is the default landing.

## Verify (the finish line)

```
./scripts/verify.sh
```

Three layers, fastest first, stop at first failure:

1. **Static** — `tsc --noEmit`, `eslint`, fencing static check (`scripts/fencing-check.sh`).
2. **Unit** — `vitest run`.
3. **E2E smoke** — Playwright; boots the dev server itself.

The e2e output (screenshots, traces) is under `tests/e2e/output/`.

The fencing **runtime** canary check (spawns claude and is expensive) is gated:

```
VERIFY_FENCING_RUNTIME=1 ./scripts/verify.sh
```

Run it during the initial self-test and after any change to the reviewer
invocation, `.agent/REVIEW.template.md`, or the fencing verifier.

### Run each layer individually

```
npx tsc --noEmit
npx eslint . --max-warnings=0
bash scripts/fencing-check.sh
npx vitest run
npx playwright test
```

## Repo rules

- **`src/sim/`** is pure TypeScript. No DOM imports, no three.js imports, no
  network imports. Deterministic function of its inputs. Testable in Node
  (vitest) with no browser.
- **State changes only via `step()`.** Do not mutate `State` in place from
  render or input layers.
- **`window.__game`** is the e2e test hook (spec §9). Dev-only; gated by
  `import.meta.env.DEV`. When you add state to the sim, extend the hook's
  `getState()` shape so Playwright can assert on it.
- **Commits** reference the issue number: `issue #N: <what changed>`.

## Local tasks (no GitHub, no PR)

For ad-hoc work the operator wants to try without filing a GitHub issue:

```
./scripts/run-issue.sh --local <slug>
```

- Task body lives in `.agent/tasks/<slug>.md` (gitignored). Simple YAML
  frontmatter (`title:` + `slug:` + `created:`) then Markdown body with
  `## Summary` and `## Acceptance criteria` sections.
- Branch: `local/<slug>`. Worktree: `.worktrees/local-<slug>/`. Neither is
  pushed to the remote.
- Success path prints how to preview and promote — no PR is opened.
- Failure paths (budget exhausted, dispute AMBIGUOUS) leave the worktree in
  place with `NOTES.md`, `last-verify.log`, and any `DISPUTES/` archive for
  inspection.

From within an interactive Claude Code session the recommended entry point
is the `/new-task` slash command (see `.claude/commands/new-task.md`), which
distills the operator's free-form request into pass/fail criteria before
invoking the loop.

Promotion to a GitHub PR or a `main` fast-forward is a separate step:
`/promote-task <slug> [--pr | --main]` (see `.claude/commands/promote-task.md`).
Default `--pr` opens the issue + PR; `--main` bypasses review and is warned.

## Protected paths (mechanical guard)

The loop, its prompts, GitHub configuration, specs, the fencing canary, and
root config files are owned by humans and the loop — not by issue
implementations. `verify.sh` layer 1 diffs the working tree against
`origin/main` and fails if any of these change:

- `scripts/**`
- `.agent/PROMPT.template.md`, `.agent/REVIEW.template.md`
- `.github/**`
- `spec/**`
- `src/__fencing-canary.ts`
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `.eslintrc.cjs`

If an issue truly needs a change here, end the turn with a note in
`.agent/NOTES.md` and let the operator make the change manually. There is no
in-loop escape hatch. See spec §5.3.

## Fencing canary

`src/__fencing-canary.ts` is load-bearing test infrastructure, not dead code.
It contains a distinctive token (`FENCING_CANARY_9F3A2C`) that the dispute
reviewer must never see. The fencing static check (`scripts/fencing-check.sh`)
verifies the file's presence and token; the runtime canary
(`scripts/fencing-canary.sh`) proves the reviewer cannot read it via the
Claude Code permission mechanism. Removing this file, refactoring it away, or
removing either check is a spec violation (see
`spec/2026-09-15-agent-build-system-design.md` §8.9 and §13). If you truly
need to replace the mechanism, write `.agent/CANARY-REPLACEMENT.md` first with
an equivalent guarantee.

## Layout

```
src/                 game code (walking skeleton + gameplay-per-issue)
src/sim/             pure simulation core (no DOM)
src/__fencing-canary.ts  load-bearing test infra (do not delete)
tests/unit/          vitest tests for src/sim/
tests/e2e/           Playwright smoke suite
scripts/             verify.sh, run-issue.sh, build-prompt.sh, review-dispute.sh, setup-labels.sh, fencing-check.sh, fencing-canary.sh
.agent/              PROMPT.template.md, REVIEW.template.md (checked in); runtime artifacts gitignored
spec/                design specs (game + build-system)
```

## Common pitfalls the loop has learned

_This section grows over time. Each entry names a specific failure once
observed, not general advice. Add to the bottom; do not delete history._

- **False GREEN when `claude` exits non-zero.** Observed 2026-09-19 on task
  `board-fit-view`: the local `claude` CLI was not logged in, so the turn
  subprocess exited immediately with "Not logged in · Please run /login"
  (rc=1). `run-issue.sh` captured the exit code, logged it, then ran
  `verify.sh` on the still-unchanged worktree; the walking skeleton passed
  verify, and the loop reported "verify: GREEN — success path" against a
  branch identical to `main`. Fixed by escalating immediately on non-zero
  turn exit (spec §8.5, revised). If a similar false-GREEN pattern is
  observed again (e.g. from a turn that exits 0 but performs no meaningful
  work), consider a separate "no commits ahead of base" guard on the
  success path.
