# Agent Build System — Operator README

This repo is developed by an AI coding agent working one GitHub issue at a time.
You file issues with verifiable acceptance criteria; the system implements them and
opens pull requests. **You review and merge every PR.** The full design, rationale,
and failure-mode field guide: `spec/2026-09-15-agent-build-system-design.md`.

## How it works in 30 seconds

```
you:  file issue → add label `agent-ready` → ./scripts/run-issue.sh 42
loop: agent works in worktree .worktrees/issue-42 → runs ./scripts/verify.sh
      after every change → commits → repeats (max 15 turns)
done: verify.sh exits 0 → PR opened, labeled `agent:in-review` → you review & merge
stuck: 15 turns without green → issue labeled `agent:needs-human` + logs comment
dispute: agent writes .agent/DISPUTE.md → fenced review agent adjudicates
         → TEST_WRONG (test fixed, loop continues) | DEV_WRONG (verdict added
         to NOTES, loop continues) | AMBIGUOUS (escalates to agent:needs-human)
```

Two rules make it safe: the agent never works on `main` (isolated git worktree per
issue), and "done" is decided by `verify.sh` run from bash — never by the agent
saying so. A third rule handles the case where the finish line itself is wrong:
when a failing test contradicts the acceptance criterion, the implementing agent
raises a dispute rather than editing the test; a **separately-fenced** review
agent (no read access to `src/`) decides. The review runs at most once per issue
on the same conclusion (§8.9 bounded arbitration).

## Prerequisites

| Tool | Check | Install |
|---|---|---|
| Claude Code CLI | `claude --version` | https://code.claude.com/docs/en/overview |
| GitHub CLI, authenticated | `gh auth status` | `brew install gh && gh auth login` |
| Node.js ≥ 20 | `node --version` | https://nodejs.org |
| Playwright browser | — | `npx playwright install chromium` (after `npm install`) |
| This repo on GitHub | `gh repo view` | the remote `origin` must be a GitHub repo you can push to |

## One-time setup

```bash
npm install                          # app + test tooling
npx playwright install chromium      # e2e browser
./scripts/setup-labels.sh            # create the four agent labels on the repo
./scripts/verify.sh                  # sanity: green against the walking skeleton
```

## Daily use

### 1. File an issue

`gh issue create` (or the web UI) — use the **Agent task** template. The Acceptance
criteria section is where quality is won or lost:

- Every criterion must be pass/fail. Test: *could two people disagree about whether
  this passed?* If yes, rewrite it with exact values/messages/states.
- Bad: "shooting should feel responsive." Good: "Given a player alive in a round,
  When Space is pressed, Then a bullet spawns at the player's position moving along
  `facing` within one tick; a unit test proves it."
- Fill the **Scope** section: which spec sections apply, which files may be touched.
  This prevents wandering and duplicate work.

### 2. Queue it

```bash
gh issue edit 42 --add-label agent-ready
```

Only label an issue `agent-ready` when its finish line is written down. An issue
without verifiable criteria is not ready — the agent will build *something* and the
loop cannot tell it apart from the right thing.

### 3. Run the loop

```bash
./scripts/run-issue.sh 42
# optional: bigger budget for a meatier issue
MAX_ITERATIONS=25 ./scripts/run-issue.sh 42
```

Watch the first few runs of any new issue type. The technique rewards supervision:
you are listening for new failure patterns, not just waiting for green.

### 4. Review the PR

The PR body contains the acceptance criteria, the tail of the passing verify log,
and e2e screenshots. Review the diff like any junior colleague's work: criteria met?
tests derived from the criteria or just mirroring the code? scope respected?
Merge is your call, always.

### 5. If it lands on `agent:needs-human`

Read the logs comment on the issue and `.worktrees/issue-42/.agent/NOTES.md`.
Then either fix the issue (split it, tighten criteria), fix the finish line
(verify.sh gap), or fix the prompt (new failure pattern → new standing rule in
`.agent/PROMPT.template.md`). Re-label `agent-ready` and run again.

## Tuning: the actual job

The prompt template and `AGENT.md` accumulate rules the way a workshop accumulates
warning signs — each one marks a place someone got hurt. When the agent misbehaves
in a way the current rules don't cover, add one short rule naming the exact failure.
Expect the first several issues to produce mostly *prompt improvements*; that is the
system being built, not the system failing.

## Safety notes

- `run-issue.sh` invokes `claude -p --dangerously-skip-permissions` so the loop can
  run unattended within a turn. The blast radius is the issue worktree — but the
  agent can still push branches and open PRs on the remote. It cannot merge to
  `main`; keep branch protection on if you want that enforced by GitHub, not by
  convention.
- **The dispute reviewer does NOT get `--dangerously-skip-permissions`.** It is
  invoked with `--tools Read,Write,Edit,Bash`, `--permission-mode dontAsk`, and
  an explicit `--disallowedTools "Read(src/**)"` plus the notes/prompt/log
  files. This is enforced by `scripts/fencing-check.sh` running in verify.sh
  layer 1 — if someone weakens the fence, verify fails.
- Cost: each turn is a full agent session. Expect dollars per issue, not cents.
  `MAX_ITERATIONS` is your hard ceiling per run. The runtime fencing canary
  (`VERIFY_FENCING_RUNTIME=1 ./scripts/verify.sh`) spawns claude and is gated;
  run it during the initial self-test and after any change to the reviewer.
- One run at a time (lockfile). If a run dies uncleanly, delete `.agent/run.lock`
  in the repo root after confirming no `claude` process is actually running.

## Disputes

If the loop's implementing agent thinks a failing test contradicts the
criterion (rather than the code being wrong), it writes `.agent/DISPUTE.md`
and ends the turn. Next iteration, `run-issue.sh` invokes
`scripts/review-dispute.sh` INSTEAD of another agent turn:

- **TEST_WRONG** → reviewer commits a minimal test correction; loop resumes.
- **DEV_WRONG** → reviewer's verdict is prepended to `.agent/NOTES.md`; loop
  resumes; a *second* dispute on the same issue triggers immediate escalation
  to `agent:needs-human` (bounded arbitration, §8.9).
- **AMBIGUOUS** → both files posted as an issue comment; label
  `agent:needs-human`; loop exits.

Read `.agent/DISPUTES/turn-K/` to inspect prior disputes on an issue.

## Troubleshooting

| Problem | Action |
|---|---|
| `run-issue.sh` refuses: "lacks label agent-ready" | `gh issue edit N --add-label agent-ready` |
| "another run is active" but nothing is running | remove stale `.agent/run.lock` |
| verify fails on e2e only, "browser not found" | `npx playwright install chromium` |
| verify fails on `static/fencing` | someone weakened `scripts/review-dispute.sh`; restore fencing flags per `scripts/fencing-check.sh` |
| Agent's PR missed the point | the criteria were loose — rewrite them, close PR, re-run |
| Reviewer keeps returning `AMBIGUOUS` | rule 4 wording in `.agent/REVIEW.template.md` may be weakened; grep confirms exact phrasing |
| You want to stop a run mid-loop | Ctrl-C; the issue stays `agent:in-progress` — relabel manually |
