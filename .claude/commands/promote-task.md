---
description: Promote a completed local agent-loop task to a PR (default) or fast-forward main (opt-in, warned).
---

# /promote-task — turn a green local branch into a PR or a main fast-forward

The operator's arguments follow as `$ARGUMENTS`. Expected shape:

```
/promote-task <slug> [--pr | --main]
```

Your job in this session is to take a `local/<slug>` branch that already
passes `./scripts/verify.sh` and promote it — default is to open a GitHub PR
against `main` and create the tracking issue; `--main` is an opt-in escape
hatch that fast-forwards `main` and bypasses PR review.

## What the operator typed

$ARGUMENTS

## Step-by-step

1. **Parse arguments.** Extract `<slug>` (required) and optional flag
   (`--pr` or `--main`). If no flag, ask via `AskUserQuestion`:
   - **Open PR (recommended, safer)** — creates the GitHub issue, pushes the
     branch, opens the PR with `Closes #N`.
   - **Fast-forward main (bypasses PR review)** — warned. Explain that this
     removes the human-in-the-loop guarantee of the whole design and should
     only be used for trivial changes the operator has personally reviewed.

2. **Sanity checks.**
   - The task file `.agent/tasks/<slug>.md` must exist. If missing, refuse.
   - The branch `local/<slug>` must exist locally. Check with `git show-ref
     --verify --quiet refs/heads/local/<slug>`.
   - The worktree `.worktrees/local-<slug>/` should exist. If not, offer to
     add it.
   - Working tree in that worktree must be clean.
   - Branch must have at least one commit ahead of `main`. Check with
     `git -C .worktrees/local-<slug> log --oneline main..`.

3. **Verify.** Run `./scripts/verify.sh` inside the worktree. If not green,
   refuse the promote — a task that isn't green shouldn't ship. Point the
   operator back at `/new-task` to iterate, or at the worktree to fix by
   hand.

4. **Path A: `--pr`.**
   - Read `.agent/tasks/<slug>.md`; extract title from frontmatter; body is
     everything after the closing `---`.
   - Create the GitHub issue: `gh issue create --title "<title>" --body-file
     <(...)` using the task body verbatim, with a footer noting this was a
     local task promoted at `<ISO timestamp>`.
   - Add the `agent:in-review` label to the new issue.
   - Push the branch: `git push -u origin local/<slug>`. Branch name on the
     remote stays `local/<slug>`.
   - Open the PR: `gh pr create --head local/<slug> --base main --title
     "local/<slug>: <title>" --body "Closes #<new-issue-number>\n\n<task
     body>\n\n## Verify (from worktree)\n\`\`\`\n<tail of last-verify.log>\n\`\`\`"`.
   - Report the issue URL and PR URL back to the operator.

5. **Path B: `--main`.**
   - Warn the operator: this bypasses PR review, which is the design's
     core human-in-the-loop guarantee. Require explicit confirmation via
     `AskUserQuestion` (options: **proceed** vs **switch to --pr**).
   - Fetch: `git fetch origin`.
   - Check that `local/<slug>` is a fast-forward of `origin/main`:
     `git merge-base --is-ancestor origin/main local/<slug>`. If not,
     refuse — the operator needs to rebase or open a PR.
   - Push: `git push origin local/<slug>:main` (fast-forward-only; no `--force`).
   - Report the resulting `main` SHA back to the operator.

6. **Cleanup — offer, do not do automatically.** Ask the operator whether
   to remove the local worktree and branch:
   `git worktree remove .worktrees/local-<slug>` and
   `git branch -D local/<slug>`. Also whether to delete
   `.agent/tasks/<slug>.md`. Default: keep everything, in case they want to
   re-run or reference it.

## Rules (do not violate)

- **Never push `--force` to `main`.** Only fast-forward.
- **Never delete a branch, worktree, or task file without asking.**
- **If verify fails in step 3, do not promote.** Even if the operator says
  the failure is spurious — the whole point of the finish line is that
  bash, not the operator, decides. Refuse and explain.
- **Never skip the warning on `--main`.** Even for the operator's own
  personal projects. The warning is not for them; it is a marker that
  someone reading the git log later can see that a change bypassed review.
