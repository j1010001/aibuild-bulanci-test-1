---
description: Kick off a local agent-loop run against a free-form task description. Distills pass/fail criteria, gets approval, then invokes ./scripts/run-issue.sh --local.
---

# /new-task — start a local agent-loop run

The operator's request (free-form) follows below as `$ARGUMENTS`. Your job in
this session is to turn it into a pass/fail task the loop can verify, get the
operator's approval, materialize the task file, and hand off to
`./scripts/run-issue.sh --local <slug>`. Everything runs locally. No GitHub
issue is created; no PR is opened. The operator promotes later via
`/promote-task`.

## What the operator typed

$ARGUMENTS

## Step-by-step

1. **Understand the request.** Read `AGENT.md`, `BUILD-SYSTEM-README.md`, and
   any relevant sections of `spec/` referenced by the request. If the request
   is too vague to state as one or more observable outcomes, ask the operator
   for clarification with `AskUserQuestion` — do not invent criteria.

2. **Distill acceptance criteria.** One Given/When/Then per criterion,
   describing observable behavior only. No test framework names. No file
   paths. No vague adjectives ("properly", "responsive", "gracefully",
   "fast"). If you cannot phrase a criterion as pass/fail, that is a signal
   the request itself is under-specified — go back to step 1.

3. **Draft the title and slug.** Title is a short imperative phrase
   (e.g. "Home page footer with version tag"). Slug is kebab-case, 1–30 chars,
   `[a-z0-9-]`, unique against `.agent/tasks/` — check first with `ls
   .agent/tasks/`. If the slug already exists, propose a variant.

4. **Confirm with the operator.** Use `AskUserQuestion` with a single
   question showing the drafted title, slug, and each criterion on its own
   line. Give the operator options: **approve**, **edit criteria**,
   **cancel**. Iterate until approve or cancel.

5. **Write the task file.** On approval, create `.agent/tasks/<slug>.md`
   with this shape:

   ```markdown
   ---
   title: <title>
   slug: <slug>
   created: <ISO 8601 timestamp>
   ---

   ## Summary
   <one paragraph, taken from or expanded from the operator's request>

   ## Acceptance criteria
   - <criterion 1>
   - <criterion 2>
   ```

   Do not commit this file. `.agent/tasks/` is gitignored.

6. **Invoke the loop in the foreground.** Run
   `./scripts/run-issue.sh --local <slug>` via the Bash tool. Stream output
   as it comes. Do NOT run in the background — the operator has explicitly
   said early runs should be watched.

7. **Report the outcome.**

   - **Green:** the script prints how to preview and promote. Repeat that to
     the operator in your own words, plus links (`file://…`) to key artifacts
     inside `.worktrees/local-<slug>/.agent/` — `NOTES.md`, `last-verify.log`,
     any e2e screenshots.
   - **Failed (exhausted):** point at `.worktrees/local-<slug>/.agent/NOTES.md`
     and offer to help distill what to tighten (criterion or prompt rule).
   - **Failed (dispute AMBIGUOUS or bounded-arbitration):** artifacts under
     `.worktrees/local-<slug>/.agent/DISPUTES/turn-K/` — read them and
     explain to the operator what the reviewer said.

## Rules (do not violate)

- **Never skip step 4 (approval).** The whole point of criteria is that the
  operator sees and agrees with the finish line before the loop starts. Even
  when the request is clear, confirm.
- **Never modify `.agent/tasks/<slug>.md` after the loop starts.** The task
  file is the frozen criterion set for this run. If the operator wants to
  change it, cancel the run and start over.
- **Never invoke `run-issue.sh --local` with a slug that already has a
  running worktree unless the operator explicitly asks to resume.** Detect
  with `git worktree list | grep local-<slug>`.
- **Preserve the fencing/protected-paths guards.** Nothing in this command
  changes them; they run on every verify inside the loop.
