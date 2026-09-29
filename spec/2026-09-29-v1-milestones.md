# Plan: what's left before v1 of the Browser Party Shooter, in milestones

Date: 2026-09-29
Status: approved. The design authority is still `spec/2026-09-15-browser-party-shooter-design.md`; this document sequences the work.

## Progress

| Milestone | State |
|---|---|
| M0 | Done: seeded RNG; player shape from one definition (gun collides where drawn, and is solid to other bodies); map loader and validator (every map enters a game through it); spec cleanup, with rooms capped at 8 players (operator decision). |
| M1 | Done: shared `Room` + protocol (`src/session`), client view model, practice via `LocalSession`, screens and HUD. |
| M2 | Done: authoritative server (`server/`), `NetSession` + interpolation + rejoin in the browser, headless bots + `npm run bot`, two-browser Playwright smoke test. |
| M2.5 | Not started (added 2026-09-29): local play against bots with difficulty levels. |
| M3, M4 | Not started. |

Deviation from the plan: until M3 (editor) exists, a room's map is chosen **by id from a built-in catalog** (`src/session/maps.ts`), so no client-supplied map data reaches the server. Every map, catalog maps included, already passes through the map loader in `GameApi.start`; custom maps will too.

## Context

v0.1.0 (tag `v0.1.0`, commit 884b449) is a **single-browser simulation**. It has:
- the real 3D collision rebuild (Rapier)
- the full rules for movement, the gun, turning, bullets, rounds, match and spawns
- the headless `GameApi` / `window.GameAPI`
- keyboard input and the fixed tilted camera
- a debug-text HUD

`main.ts` hardcodes two players ("You" and an idle "Player 2") and starts straight away.

The spec (`spec/2026-09-15-browser-party-shooter-design.md`) describes two deliverables: **real-time multiplayer with room codes**, and **an integrated level editor**. Neither exists yet. This plan lists every gap, orders them into milestones, and adopts one decision made while reviewing this plan: **the simulation runs on a server (server authority) rather than in a host's browser.** It's built and fully tested against a local server first, and deployed only once it works. The server component must stay isolated so it can move to a real host without code changes.

Every milestone ends in something shippable and tagged, and keeps the API-first rule: anything a human can do through the UI, an AI or test harness can do headlessly through the same API.

## Decision: server authority instead of a browser host

**Why it's the better architecture here:**
- A server was needed anyway (for signaling). Making it authoritative removes WebRTC entirely, and with it STUN/TURN and the NAT-traversal failures. Those were the riskiest items in the old plan.
- No host advantage: in the browser-host model the host plays with zero latency and everyone else doesn't.
- No "host left, match over" (§14's accepted v1 tradeoff goes away).
- The design already anticipated it. §3 lists server authority as the planned later move, and `sim` is DOM-free and deterministic. Rapier runs in Node: the entire test suite already runs it under Node in vitest.

**Costs, stated plainly:**
1. **Every player pays a round trip to the server**, and v1 has no client-side prediction (§3). Input lag is roughly the round-trip time plus up to one snapshot interval (33 ms). With a nearby region that's fine for a party game; players on another continent will feel it. A later fix, if needed, is predicting only the local player's own movement.
2. **WebSocket runs over TCP.** One lost packet stalls the snapshots behind it (head-of-line blocking), which unreliable WebRTC channels would have avoided. Many browser .io games accept this. The transport sits behind an interface, so WebTransport can replace it later if playtests show stalls.
3. **Server CPU per room**: a 60 Hz Rapier sim for each active match. That's small for 2–8 players on tiny maps, but hosting cost now grows with concurrent matches rather than staying near zero.
4. **No play without the server**, except Practice, which keeps running fully in the browser (below).

**The isolation rule** (so the server can move easily):
- `src/sim`, `src/physics`, `src/geometry` and the new `src/session` are **shared, environment-free code**: no DOM, no Node APIs, and time is injected rather than read. `three` is only used for pure geometry math, which runs in Node.
- `server/` is a **thin Node shell** and the only place Node APIs are allowed: HTTP and WebSocket (`ws` package), the room-code registry, the fixed-rate tick timer, and the process entry point. It never imports client/UI code.
- Enforced by compilation, not convention:
  - `server/tsconfig.json` uses `lib: ["ES2022"]` with **no `dom`**, and includes only `server/` plus the shared folders, so any accidental DOM or client import fails to compile.
  - The client tsconfig excludes `server/`.
- The client finds the server through **one setting**: `VITE_SERVER_URL`, defaulting to `ws://localhost:8787`. Moving to a real host means changing that value and running one deploy.
- The same `Room` class runs on the server (behind the WebSocket adapter), in tests (behind an in-memory adapter) and in the browser for Practice (in-process). The game logic never knows where it runs.

**One open design choice, with a recommendation:** when the room owner (the player who created the room) leaves, **ownership passes to the next connected player and the match continues**, instead of today's "host left → everyone goes home". With server authority there's no longer any technical reason to end the match. The §10 rule that a match ends with no winner when fewer than 2 players remain still applies.

## Development process: test-first, then an independent review (written instructions only)

No hooks, guard scripts or phase state. The rules are written into a checked-in **project `CLAUDE.md`**, which every session loads automatically, including after context compaction and in new sessions. The builder follows them for every task. (Each numbered item in a milestone below is one task.)

1. **Tests first.** Before writing any implementation for a task, write the tests that express its acceptance criteria, derived from this plan and the spec rather than from code. Run them and confirm they fail for the expected reason, then commit them on their own (`test: …`) so the history shows tests before code. Only then implement until the full suite passes.
2. **Changing a test after that is allowed, but must be justified.** State the reason in the commit message (for example `test: relax X because spec §9 says Y`) and in the task's end-of-task report. Never weaken a test just to make the implementation pass.
3. **Independent review when the task is done.**
   - Run a review in a **fresh subagent**, using the `/code-review` skill or an `Agent` call with a self-contained brief, so it doesn't share the builder's reasoning.
   - Give it only the task's acceptance criteria, the relevant spec sections and the diff since the task started.
   - Ask it to check four things: do the tests truly cover the criteria, is the implementation correct against the spec, is each test change justified, and were the spec and regression tests updated.
   - Fix the findings, or explicitly reject one with a reason. Report both in the end-of-task summary.
4. The existing `/project_update` rules still apply to bug fixes. `.claude/commands/project_update.md` gets one change: write the failing regression test **before** the fix, not after.

## Gap inventory (spec section → what's missing)

| Spec | Gap |
|---|---|
| §4, §10 determinism | Spawns use `Math.random()` inside `step()`, so a replay that crosses a round boundary isn't deterministic. That blocks reliable AI replays and server/test parity. |
| §11 "what you see is what's solid" | The gun collider is an invisible slab, 0.1 wide and the full 1.2 height, standing on the ground, but it's drawn as a thin barrel at bullet height. The body collider is a cylinder but it's drawn as a sphere on a cone. The bullet is drawn as a 0.15 sphere but collides as a point ray. |
| §13 map schema | The spec's JSON (`footprint` nested) differs from the code (`params`). There's no loader or validator, no `version` check, no `axis` default, and no constraint checks. |
| §5 config | `maxPlayers` is 4 (cap 8) in the spec but 8 in the code, and nothing enforces it. |
| Spec text that's out of date | The §4 `createGame` signature; the §9 wording about the gun overlapping geometry; the inverted `playerHeight` comment in `types.ts`. §3, §4, §12 and §14 need rewriting for server authority. |
| App flow (§12, §14) | No home screen, map picker, config choice, lobby (roster, unique skins, ready flags), start gate ("fewer than 2 players only with Practice"), match-end screen, or back-to-lobby. |
| §11 HUD | Only a debug text dump. Missing: scores, round timer, round and match banners, final scores. |
| §12 networking | Everything: room codes, the room lifecycle, the input/lobby/snapshot/event protocol, 60 Hz sim with 30 Hz snapshots, stale-snapshot discard, client interpolation, disconnect/reconnect to the same PlayerId, no mid-match joins. |
| §13 editor | Everything: the 2D surface with true footprints, the 3D preview, editing operations, validation and warnings, local presets, JSON import/export. |
| §15 testing | No end-to-end multiplayer smoke test (Playwright was removed) and no editor round-trip test. |
| Not in the spec | The bundle is 4.8 MB because Rapier's WASM is inlined as base64. |

## Milestones

### M0 — Foundation hardening → `v0.1.1` (small)
1. **Seeded RNG in `State`** (a small PRNG in `src/sim/rng.ts`). `spawn.ts` uses it instead of `Math.random()`, and `GameApi.start({seed})` accepts a seed. Regression test: a replay across round boundaries produces identical state.
2. **Player shape from one shared, replaceable definition.**
   - New `src/geometry/playerGeometry.ts`, with `buildPlayerGeometry(config)` returning a list of **convex** parts (body, gun barrel). Both `render.ts` and `physics/world.ts` consume it, like `buildObstacleGeometry`.
   - Parts must be convex because players move: a moving shape can't be swept against the static donut trimesh unless it's convex. A future player model therefore becomes a convex hull (`convexHull(points)`) or several convex pieces. Nothing else changes when the shape does.
   - `moveDistance` becomes "the minimum sweep over all parts", and `gunFits` becomes "the gun part overlaps nothing".
   - Colliders follow the visuals: the gun collider is the visible barrel at bullet height, and the body is a cylinder drawn as a tomato that fills it. **Gameplay change:** a gun can poke over a low wall. Update spec Terms, §7, §8 and §9.
   - The bullet is drawn as a point-sized tracer, so what you see matches its point-ray collision.
   - Test: the player's render parts equal its physics parts, the same way `obstacleMesh.test.ts` checks obstacles.
3. **Map loader and validator** (`src/sim/mapFormat.ts`): the single entry point for every map, whether built-in, a local preset, an imported file, or one received by the server. It checks the version, defaults `axis`, and enforces hard constraints. Keep the internal `params` shape and rewrite the spec §13 example to match it.
4. Spec cleanup: the §4 signature, the §9 wording, `maxPlayers` = 4 (cap 8), the `types.ts` comment.

### M1 — Shared session model and local game flow → `v0.2.0` (medium)
The full game loop in one browser via Practice. The UI and room model built here are exactly what M2 reuses.
- **`src/session/room.ts`** (shared, environment-free): the room model and its lifecycle.
  - Lobby state: roster, owner, `maxPlayers`, unique skins from the palette, ready flags, map and config, and the start gate.
  - `start()` creates the game through `GameApi`.
  - `tick()` advances the game; it is called by an injected timer, never a timer the room owns itself.
  - Per-player input with shoot edges latched until the next tick.
  - Disconnect and reconnect, and ownership transfer.
  - Output is a stream of protocol messages (`lobby`, `matchStart` with the validated map, `snapshot`, `event`).
  - Pure, so it's fully unit-testable.
- **`src/session/protocol.ts`**: message types shared by client and server.
- **Screens** (`src/ui/`, plain DOM): Home → Practice / Create / Join / Editor → Lobby → Match → Match end → Lobby or Home. Join is disabled until M2, and Editor until M3.
- **Real HUD**: scores, round number, countdown, banners, final scores.
- **Practice** runs a `Room` in-process in the browser, with no server.
- Tests: room unit tests (skin uniqueness, `maxPlayers`, start gate, ownership transfer, disconnect/reconnect), plus a headless full practice match.

### M2 — Authoritative local server → `v0.3.0` (medium)
- **`server/`** (Node only, isolated as described above):
  - HTTP plus WebSocket on `:8787`
  - a room registry that issues 5–6 character codes (unambiguous alphabet) and rejects mid-match joins and joins over `maxPlayers`
  - a fixed-rate 60 Hz loop driving `Room.tick()`, with drift correction
  - snapshots every second tick (30 Hz)
  - a reconnect token so a returning player gets the same PlayerId
  - empty-room cleanup
- **`src/net/client.ts`**: a WebSocket client that sends input only when it changes, drops snapshots with an older `seq`, and interpolates between the last two snapshots for the renderer.
- **Protocol amendment (spec §12):** the map is sent once in `matchStart`, not in every snapshot. Snapshots carry only the dynamic state.
- **Dev ergonomics:** `npm run dev` starts both Vite and the server (the server via `tsx watch`). A single command gives a working multiplayer setup locally.
- **Headless bot client** (`scripts/bot.ts`): drives a player over a real WebSocket using the same protocol. An AI can fill a room and play full matches against the real server with no browser, which is the multiplayer counterpart of `runTicks`.
- Tests:
  - **in-memory adapter integration**: several clients through join → lobby → shoot → death → round → match; disconnect/reconnect; owner leaves; delayed and duplicated snapshots
  - **real-socket integration** against a server started in the test (`ws` on an ephemeral port)
  - **Playwright** two-tab smoke test (§15) against the local server
  - **isolation check**: compiling the server with its own tsconfig is part of `npm run build`

### M2.5 — Local play vs bots → `v0.3.5` (medium–large)
Play in the browser against N computer opponents, all free-for-all (bots fight each other and you). Also the best tool yet for testing the game: seeded, reproducible bot matches on every map. Decisions (operator, 2026-09-29): **one difficulty level for all bots in a game** (Easy / Normal / Hard); **local only** for now (bots in online rooms can come later — same brain, same Room).

How the AI works (no LLM, no learning — standard game-AI techniques):
- **Perception, honest by construction**: a bot sees only what a player sees (the snapshot, the map, events) and acts only through the same input messages (`InputSender`). It derives what it needs: who's alive and where, who's lined up with whom, whether a wall blocks a shot (line of fire), which bullets are heading its way.
- **Navigation**: a grid over the board marking where a player's body fits (computed once per map, from the physics world), and A* pathfinding over it, so bots route around walls instead of walking into them.
- **Decisions — utility AI**: on a short timer each bot scores a few behaviors and does the best one: *attack* (line up with a target that has a clear line of fire, fire), *chase* (path toward the chosen target), *dodge* (step out of an incoming bullet's line), *take cover* (break line of fire behind a wall when threatened), *wander* (no target known).
- **Difficulty = the same brain with different settings**: reaction delay before firing, how often it re-decides, how precisely it lines up before firing (aim), how often it dodges, and how it picks targets. Easy: slow, sloppy, never dodges. Hard: quick, precise, usually dodges.

Tasks:
1. **Navigation grid + A\*** (`src/client/bots/navigation.ts`, pure): walkable cells from the map (a player's body fits), shortest axis-aligned path, path smoothing into straight runs. Tests: paths around walls and through arch doors, no path through low slots, unreachable targets handled.
2. **Bot brain** (`src/client/bots/brain.ts`): perception helpers, the five behaviors with utility scores, difficulty profiles (`easy` / `normal` / `hard`), replacing today's chase-and-shoot inside `BotPlayer` (keeping its seeded randomness, throttling and lobby behavior). Tests per behavior with scripted snapshots (like the existing `ScriptedSession` tests).
3. **Local match**: a `LocalMatchSession` (in-page Room with the human plus N bots through `InProcessSession`; the page loop ticks the room and steps the bots), normal round and match rules. Headless use: the same setup runs in tests and via `window.GameClient`.
4. **UI**: Home → "Play vs bots" → a setup screen (bot count 1–7, difficulty, map, target score) → match; bots named e.g. "Bot 2 (Hard)" in the HUD; match end → play again / home.
5. **Tests**: navigation and behavior units; every map, every difficulty: seeded bot-only matches finish with a winner; **difficulty ranking**: over 20 seeded matches, hard bots beat easy bots in most of them (a measurable check that the levels mean something); a Playwright test that plays a local match against bots to the end.

### M3 — Level editor → `v0.4.0` (medium–large)
- **Headless `EditorApi`** (`src/editor/model.ts`): place, move, resize, set axis, delete, and set board size, on immutable drafts.
- 2D top-down surface whose footprints (including the donut hole and door gap) are derived from `buildObstacleGeometry`, plus a live 3D preview via `Renderer.loadMap`.
- Validation through the M0 loader. The fair-spawn feasibility warning runs `assignSpawns` with a fixed seed against a `PhysicsWorld` built from the draft. Saving is blocked when no fair spawn exists (§14). There's also a warning when an arch's door is narrower than a player.
- Named local-storage presets appear in the map picker; JSON export and import. A custom map is sent to the server as part of room creation and validated there with the same loader.
- Tests: save → export → import round-trip, validator cases, spawn-feasibility warning, and a match on an editor-authored map.

### M4 — Deploy and polish → `v1.0.0` (small–medium)
- Deploy the server as a real service, only after M2 and M3 are green locally. Moving it means changing `VITE_SERVER_URL` and running one deploy (below).
- Bundle: switch to the non-`compat` Rapier build (a separate `.wasm` file) and code-split the editor.
- Playtest tuning of the §5 constants, over real network latency.
- A final pass so every §15 test exists and passes.

**Order rationale:**
- M2.5 (local play vs bots) goes before the editor at the operator's request: it adds a playable mode without a server, and seeded bot matches become the main way to test game rules and, later, editor-made maps.
- M0 comes first because the seeded RNG and the map loader are prerequisites for both the server (maps arrive over the network, and replays must match) and the editor (feasibility checks must be deterministic).
- M1 builds the room model in shared code, which makes M2 mostly transport.
- The editor is independent of the server, so M2 and M3 can swap or run in parallel.

## Deployment (for M4)
The server is a single stateless Node process with no database: setup is about 15–30 minutes once, then one command per deploy.
- **Recommended: Fly.io.** One app serves the built static client and the WebSocket, so there's one URL and no CORS setup. The VM stays on (no cold start), and you pick a region close to your players, which matters more now that every input makes a round trip. `fly deploy` builds `server/Dockerfile`.
- Alternatives: **Render** (its free tier sleeps, so the first room waits tens of seconds for a cold start) or **Railway** (similarly simple, usage-based pricing).
- TURN is no longer needed, because there's no WebRTC.

## Files touched per milestone
- M0: new `src/sim/rng.ts`, `src/geometry/playerGeometry.ts`, `src/sim/mapFormat.ts`; changes to `src/sim/{spawn,state,types}.ts`, `src/physics/world.ts`, `src/render.ts`, `src/api.ts`, the spec, and `tests/unit/*`.
- M1: new `src/session/{room,protocol}.ts`, `src/ui/*`; changes to `src/main.ts`, `index.html`, `src/render.ts`.
- M2: new `server/{index,rooms,wsAdapter,loop}.ts`, `server/tsconfig.json`, `server/Dockerfile`, `scripts/bot.ts`, `src/net/client.ts`, `playwright.config.ts`, `tests/e2e/*`, `tests/integration/*`; changes to `package.json` scripts.
- M3: new `src/editor/{model,surface,validate}.ts` and the editor screens.
- Reused throughout: `buildObstacleGeometry`, `PhysicsWorld`, `assignSpawns`, `Renderer.loadMap`, `GameApi`, and the camera-derived key mapping (`src/camera.ts`, `src/input.ts`).

## First steps once this plan is approved
Make one commit containing:
- this plan, saved as `spec/2026-09-29-v1-milestones.md`
- the design-spec changes for server authority:
  - §3 moves server authority into scope
  - §4 makes the server the session host and adds the isolation rule
  - §12 replaces WebRTC and signaling with the WebSocket protocol and `matchStart`
  - §14 replaces "host leaves" with ownership transfer
- a new project `CLAUDE.md` holding the development-process rules above, plus a pointer to the spec and this plan
- the one-line change to `.claude/commands/project_update.md` (regression test before the fix)

Then start M0, task 1.

## Verification (every milestone)
- `npx tsc --noEmit` (client and server tsconfigs), `npx vitest run` (the full suite), `npm run build`.
- A headless, API-driven scenario for each milestone:
  - M0: a replay across rounds
  - M1: a full match through a `Room`
  - M2: bots through the real local server
  - M3: an `EditorApi`-authored map, then a match on it
- A live Browser-pane check (plus the M2 Playwright two-tab test).
- Each task: tests committed before its implementation; an independent subagent review; findings fixed or rejected with a reason. Tag the milestone once every task in it is done.
