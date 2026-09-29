# Browser Party Shooter

- Design authority: `spec/2026-09-15-browser-party-shooter-design.md`. Read the relevant sections before changing behavior; keep it in sync with the code.
- Work plan and milestone order: `spec/2026-09-29-v1-milestones.md`. Each numbered item in a milestone is one task.
- Components and how they interact: `spec/architecture.md`. Update it when a milestone adds or changes a component.

## Development process (every task)

1. **Tests first.** Before any implementation, write tests that express the task's acceptance criteria, derived from the plan and the spec, not from code. Run them and confirm they fail for the expected reason. Commit them on their own (`test: …`) so the history shows tests before code. Then implement until the full suite passes.
2. **Changing a test later is allowed, with a justification.** Give the reason in the commit message (for example `test: relax X because spec §9 says Y`) and in the end-of-task report. Never weaken a test just to make the implementation pass.
3. **Independent review when the task is done.** Run the review in a fresh subagent (the `/code-review` skill, or an `Agent` call with a self-contained brief) so it doesn't share your reasoning. Give it only the task's acceptance criteria, the relevant spec sections and the diff since the task started. Ask it to check that:
   - the tests truly cover the criteria
   - the implementation is correct against the spec
   - every test change is justified
   - the spec and regression tests were updated

   Fix each finding or reject it with a reason, and report both in the end-of-task summary.
4. Bug fixes follow `/project_update` (`.claude/commands/project_update.md`).
5. Never commit or push unless asked. Tag a milestone only when all of its tasks are done.

## Verify before calling anything done

- `npx tsc --noEmit`
- `npx vitest run`: the full suite, not just new tests
- `npm run build`
- For anything observable in the running app: check the live dev server (the `dev` config in `.claude/launch.json`) through `window.GameAPI`, not by eye alone. Call `GameAPI.pause()` before driving it with `runTicks()`.

## Architecture rules that have regressed before

- **What you see is what's solid.** Render meshes and physics colliders come from the same geometry function (`src/geometry/`), never two hand-kept copies. See spec §7 and §11 for the history.
- **One source of truth for values that must agree.** For example, the keyboard mapping is derived from the camera azimuth (`src/camera.ts` → `src/input.ts`).
- **API-first.** Anything the UI can do, `GameApi` (and later the `Room` and editor APIs) can do headlessly. There is no UI-only path.
- **Server isolation** (spec §4). `src/sim`, `src/physics`, `src/geometry` and `src/session` are environment-free: no DOM, no Node APIs, time is injected. Node APIs are allowed only in `server/`, which never imports client code.
