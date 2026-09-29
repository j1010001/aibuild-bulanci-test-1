# Browser Party Shooter — Design Specification

Date: 2026-09-15
Status: approved (design review). Revised 2026-09-29: server authority moved into v1
scope (§3, §4, §12, §14). The sequencing plan is `spec/2026-09-29-v1-milestones.md`.

## 1. Overview

A 3D-rendered browser multiplayer party shooter played on a flat plane. Players are
visually identical shapes (a tomato with a dress) distinguished only by skin color. Each
player moves axis-aligned and carries a gun that shoots along the same world axes; a
single hit kills. A match is a score race of rounds.

The deliverable has two integrated pieces:

1. **Game** — real-time multiplayer; a player creates a room on the game server, which
   issues a short room code that friends use to join.
2. **Level editor** — built into the same app; author maps with predefined primitives,
   save them locally (immediately available in the game's map picker), and share them via
   JSON import/export.

## 2. Terms

Canonical vocabulary used consistently throughout.

- **Primitive** — a predefined obstacle kind: `cube`, `cone`, `donut`, or `arch`. Each
  primitive defines how its authoring params derive real 3D collision geometry (§7) —
  not a 2D approximation of one.
- **Obstacle** — a placed instance of a primitive: `{ id, type, pos, ...params }`. The
  actual collision shape is not stored on the obstacle — it's built once at load time as
  a real 3D collider in the physics world (§7), from the same numbers the renderer uses.
- **Axis-aligned** — constrained to the four world directions `+X, −X, +Y, −Y`. No
  diagonal movement or shooting.
- **Direction** — one of `+X, −X, +Y, −Y`. A player's `facing` and a bullet's travel
  direction are both directions.
- **Facing** — a player's current direction; the gun fires along it. Set by the latest
  non-idle movement, random at spawn.
- **Gun** — the barrel a player carries, pointing along `facing`: a thin barrel from the
  edge of the player's body (`R` from center) to the **muzzle** (`muzzleOffset` from
  center), at bullet height. It collides exactly where it is drawn (§7): it is blocked by
  walls and bodies that reach bullet height, and passes over anything lower.
- **Bullet height (`H`)** — the fixed world height at which a bullet travels; a bullet is
  a point at this elevation, moving through real 3D space (§7).
- **Player height** — the real collision height of a player's body (a cylinder, §7),
  strictly greater than `H` (so a bullet always passes through a player's body,
  guaranteeing a hit — §5) and otherwise a normal piece of 3D geometry, exactly like an
  obstacle's.
- **Solid** — no longer a stored per-obstacle flag (there is no `solidToPlayers`/
  `solidToBullets` data). Whether something is blocked at a given point is whatever the
  real 3D collider says at that entity's actual height range — a cube's low wall blocks a
  player (whose body starts at the ground) but not a bullet flying above its top,
  purely because that's what the real geometry is at each entity's height, not because
  of two parallel per-obstacle shapes kept in sync by hand.
- **Footprint** — an obstacle's full horizontal (X/Y) extent irrespective of height.
- **Hole** — a genuine gap in an obstacle's 3D geometry that admits passage — the donut's
  is a real hole a bullet or a short-enough body can pass through; an arch's is the space
  between its pillars, open at every height below the lintel (or all the way up, if there
  is no lintel).
- **State** — the authoritative game state owned by the simulation (see Data model).
- **Snapshot** — a broadcast `{ type:'snapshot', seq, state }` from the server to clients,
  carrying only dynamic state (the static map is sent once, in `matchStart` — §12).
- **Server** — the game server process. It is the authority: it runs the simulation for
  every room. Clients never simulate; they send input and render snapshots.
- **Room** — one lobby-then-match session on the server, identified by its room code.
- **Room owner** — the player who created the room (or inherited it, §14). Chooses the
  map and config and starts the match. Has no simulation role; the server is the authority.
- **Server authority** — the simulation runs on the server, not in any player's browser
  (in scope for v1 since the 2026-09-29 revision; see §4 for why).

## 3. Scope

### In scope (v1)

- Server-authoritative multiplayer: a game server runs the simulation for every room;
  browsers are thin clients. Built and tested against a local server first, deployed
  only once it works (§4 isolation rule).
- Solo practice runs entirely in the browser, with no server.
- Play vs bots runs entirely in the browser too: the human against 1–7 computer
  opponents, all at one chosen difficulty (Easy / Normal / Hard), free-for-all (§12).
- Real-time, axis-aligned movement and shooting.
- One-hit-kill traveling bullets with a fire cadence.
- Four primitives (cube, cone, donut, arch), each a real 3D collision shape (§7) able to
  carry genuine holes — gaps a bullet may cross but a player cannot (or both, as real
  geometry dictates, not a hand-authored per-obstacle rule).
- Score-race match structure with rounds and a round time limit.
- Fixed tilted 3/4 camera.
- Integrated level editor with local save and JSON share.
- Predefined skin colors only (not importable, no patterns in v1).

### Out of scope (v1)

- Board/camera rotation — deferred (was discussed; removed to reduce scope).
- Client-side prediction / rollback — clients render snapshots only. (With server
  authority every player's input waits a round trip to the server; if that feels laggy
  in playtests, predicting only the local player's own movement is the first addition.)
- Peer-to-peer / WebRTC networking — replaced by server authority (§4).
- Teams, respawn deathmatch, power-ups, projectiles with varying height, destructible
  obstacles.
- Custom skin assets or patterns (colors only).

## 4. Units (architecture)

Each unit has one job and a well-defined interface.

| Unit | Responsibility | Depends on |
|---|---|---|
| **Simulation core (`sim`)** | TypeScript. Owns game state, applies inputs per tick, emits events. No DOM, no three.js rendering, no networking. Deterministic given the same physics world contents (see below). | `physics` |
| **Physics world (`physics`)** | A real 3D collision world (Rapier — see §7) built once per game from the map's obstacles. Answers every collision question `sim` asks: can this player move this far, does the gun fit, what does this bullet hit. The one genuinely stateful, non-serializable part of an otherwise-plain `State` (excluded from `GameApi.getState()`'s snapshot). | nothing (a pure geometry/query engine) |
| **Session (`session`)** | The `Room`: lobby state (roster, owner, skins, ready flags, map, config, start gate), the match lifecycle, per-player input with shoot edges latched until the next tick, disconnect/reconnect and ownership transfer. Drives `sim` through `GameApi`. Its output is a stream of protocol messages (§12). Environment-free: time is injected (it never owns a timer), so the same class runs on the server, in tests, and in the browser for local games (practice and play vs bots). | sim |
| **Server (`server/`)** | A thin Node shell around `session`: HTTP + WebSocket, the room-code registry, the fixed-rate 60 Hz tick timer, the process entry point. The only unit allowed to use Node APIs. Never imports client/UI code. | session |
| **Network client** | Browser WebSocket client: sends input, receives snapshots/events, drops stale snapshots, interpolates between snapshots for the renderer. Never touches game rules. | session protocol types |
| **Renderer** | three.js scene. Pure function of a `RenderState` (the static `matchStart` data plus one dynamic snapshot, built by the client view model): plane, obstacles, players, bullets. Obstacle meshes are built from the same `buildObstacleGeometry` output `physics` turns into colliders (§7, §11) — not a separately-tuned visual model. Frees GPU buffers of meshes it removes; all bullets share one geometry and material. | geometry, client view-model types (read-only) |
| **Input** | Keyboard → normalized `{ moveDir, shoot }`. Holds no state. | — |
| **Editor** | Author maps; persist locally; JSON import/export. Shares primitive definitions with `sim`. | sim definitions |
| **Control surface (`GameApi`)** | The one entry point that drives `sim`: roster, `start`/`reset`, input (`setMoveDir`/`pressShoot`), advancing time (`tick`/`runTicks`), and introspection (`getState`/`getEvents`). An AI/test harness calls the *same* methods a Room does — there is no UI-only path. In the page it is exposed as `window.GameAPI` during a local game only (practice or play vs bots: the local room's game; `null` otherwise, since a multiplayer game runs on the server). `start()` is async — the physics engine's WASM module needs one await the first time it's used per page/process; every other call, including `tick()`/`runTicks()`, is synchronous after that. | sim |

`sim` exposes `step(state, inputs, dt) → { state, events }` and
`createGame(RAPIER, config, map, roster, seed) → { state, events }`. Given the same
`(state, inputs, dt)` *and* the same physics-world contents (obstacles never change after
load; only kinematic player positions move), it is deterministic — real-3D collision
queries replaced hand-rolled 2D math (§7), not the "pure function of its arguments"
property that makes `step` unit-testable and portable to a server process unchanged.

**All sim randomness comes from a seed** (`src/sim/rng.ts`): the PRNG state lives in
`State.rngState` as a plain number, so it is cloned by `step` and carried in snapshots,
and no sim state depends on `Math.random` (`step` never calls it; `createGame` reaches it
only through three.js, which uses it for geometry object UUIDs, not game state). This
matters because a round transition inside
`step` re-runs spawn placement (§10) — before the seed existed, any replay that crossed a
round boundary diverged. `State.seed` records the seed a game was created with;
`GameApi.start(config, map, { seed })` accepts one, and picks and records one when none is
given, so any run (an AI test, a bug report) can be replayed exactly from its seed. The
seed must be an integer; it is stored as the 32-bit value actually used (`seed >>> 0`), so
`State.seed` always replays the run.

**Two harness surfaces in the page.** `window.GameClient` drives the game exactly as the
UI does: `send(ClientMessage)` in, `view()` (the ClientView the screens render) out, plus
`startPractice`, `startLocalMatch({ bots, difficulty, mapId?, targetScore?, roundTime?,
seed? })`, `playAgain`, `leave`, and for local games `pause`/`resume`/`runTicks(n)`, which
tick the local room (and step its bots) so its snapshots flow through the same path the
UI reads. A match starts asynchronously, so a harness waits for `view().screen ===
'match'` before relying on `runTicks`. `window.GameAPI` (local games only) gives direct
access to the simulation for introspection. The page loop stops ticking a local game
while either `GameClient.pause()` or `GameAPI.pause()` is in effect.

`GameApi.tick()`/`runTicks(n)` advance the sim on demand, independent of real time or a
render frame — the point is that an AI harness can fast-forward a game far faster than
real-time play, and get identical results run to run. This only holds if nothing else is
also advancing the same state concurrently: the live page drives its own real-time loop
(`main.ts`, a `requestAnimationFrame` fixed-timestep loop calling `tick()`), and if a
script calls `runTicks()` against that same live `window.GameAPI` instance, both loops
advance the same state at once, corrupting the fast-forward's determinism. `GameApi.pause()`/`resume()` exist for exactly this: `pause()` tells the live loop to stop
calling `tick()` on its own (rendering continues, so the harness's explicit ticks are
still visible) without disabling `tick()`/`runTicks()` themselves, which always run when
called. A harness driving the live page should call `pause()` first; a harness driving a
freshly-constructed `GameApi` (e.g. in a test) never needs to, since nothing else is
ticking it.

### Why server authority (revised 2026-09-29)

v1 originally had the host's browser run the simulation, connected to peers over WebRTC,
with a signaling server brokering connections. Since a server was needed anyway, it now
runs the simulation itself:

- It removes WebRTC entirely, and with it STUN/TURN and the NAT-traversal failures that
  were the riskiest part of the networking work.
- No host advantage: in the browser-host model the host played with zero latency and
  everyone else didn't.
- A match no longer has to end when one particular player leaves (§14).

Accepted costs:
- Every player's input waits a round trip to the server (no prediction in v1, §3).
- WebSocket runs over TCP, so one lost packet stalls the snapshots queued behind it. The
  transport sits behind an interface so WebTransport can replace it if playtests show
  stalls.
- Hosting cost grows with concurrent matches (one 60 Hz simulation per active room).

### Isolation rule (so the server can move to any host unchanged)

- `sim`, `physics`, `geometry` and `session` are **shared, environment-free code**: no DOM,
  no Node APIs, and time is injected rather than read. (`three` is used only for pure
  geometry math, which runs in Node.)
- `server/` is the **only** place Node APIs are allowed, and it never imports client/UI
  code.
- Enforced by compilation, not convention, with one tsconfig per environment:
  `tsconfig.core.json` compiles the shared core (and the DOM-free client model) with
  neither DOM nor Node types, so a `document` or `process` there fails; `tsconfig.json`
  (browser) has no Node types; `server/tsconfig.json` has Node but no DOM. A unit test
  additionally checks that no `server/` file imports browser-side code (`src/client`,
  `src/ui`, the renderer, input, camera). `npm run build` runs the core and server checks
  first; `npm run typecheck` runs all four configs.
- The client finds the server through one setting, `VITE_SERVER_URL`. When unset it
  defaults to port 8787 on the host that served the page (`ws://<page host>:8787`, `wss`
  under https), so other devices on the same network can join a locally hosted game.
  Moving the server to a real host means setting that value and deploying; no code
  changes.
- The same `Room` runs behind the WebSocket adapter on the server, behind an in-memory
  adapter in tests, and in-process in the browser for practice.

## 5. Coordinate system and world units

- The board is a bounded rectangle in the horizontal X/Y plane; Z (called Y in the
  physics/render code, which follow three.js's Y-up convention) is "up" and is **not**
  visual-only — it's a real collision axis (§7): obstacles, the player's body, and a
  bullet's fixed travel height all occupy real, meaningful vertical extents.
- Movement and shooting are axis-aligned (X/Y only — no vertical movement, no jumping);
  positions are continuous floating-point world units (pixel/sub-pixel accurate — no
  coarse grid).

Defaults (tuning constants; refined in playtesting):

| Constant | Default | Meaning |
|---|---|---|
| `playerRadius` `R` | 0.5 | player's real collision cylinder radius |
| `playerHeight` | 1.2 | player's real collision cylinder height, resting on the ground |
| `muzzleOffset` | 0.8 | distance from a player's center to the muzzle; must exceed `R` |
| `bulletHeight` `H` | 0.9 | height at which bullets travel, as a real 3D point |
| `playerSpeed` | 6 units/s | axis-aligned movement speed |
| `bulletSpeed` | 18 units/s | bullet travel speed (3× player) |
| `cadence` | 800 ms | minimum delay between shots |
| `targetScore` | 3 | round wins needed to win the match |
| `roundTime` | 60 s | after which a round is a draw |
| `maxPlayers` | 8 (also the cap) | players per room; one per palette skin color, since skins are unique per room |
| `practice` | false | solo mode (§14); exempts the match from the two-contender rule (§10) |
| `spawnSeparation` | 5 units | minimum distance between spawn points |
| `spawnEdgeMargin` | 2 units | min distance of a spawn point from board edges |

`H` must be strictly less than `playerHeight`, so a bullet always passes through a
living player's real body and a hit is guaranteed whenever a bullet's path reaches
one — the one deliberate exception to "everything is real, ungimmicked 3D geometry"
(§7): player-vs-player hit detection stays a 2D, height-agnostic horizontal-distance
test (bullet path within `R` of the player's `(x,y)`), not a literal 3D body
intersection, because requiring precise vertical alignment for a kill — on a fixed
tilted camera where judging height is hard — would make hits feel arbitrary rather than
skill-based. `H` and `playerHeight` are real collision constants everywhere else: an
obstacle's geometry decides independently, at each of these two heights, whether a
bullet or a player's body is blocked there.

## 6. Data model

```
State = {
  config,            // tuning table above + board bounds + maxPlayers
  phase,             // round | matchEnd (the match is over — see §10)
  roundNumber,
  scores: PlayerId → int,
  players: Player[],
  obstacles: ObstacleDef[],
  bullets: Bullet[],
  seed,              // the seed this game was created with (§4) — replaying with it reproduces the run
  rngState,          // current PRNG state, advanced by every random draw (spawns)
  physics,           // live handle into the real 3D collision world (§7) — NOT plain
                      // data; excluded from GameApi.getState()'s JSON-safe snapshot
}

Player     = { id, name, skinId, pos:{x,y}, facing, lastShotAt, alive, connected }
Bullet     = { id, ownerId, pos:{x,y}, dir }          // a point on the plane at bullet height H
ObstacleDef = { id, type, pos:{x,y}, ...params }       // authoring params only
```

- A player's `facing` is set by the latest non-idle movement, or at spawn a random direction
  in which the gun fits (§10). Shooting fires along `facing`; a player may shoot while moving.
- An `ObstacleDef`'s authoring params are the only thing stored — there is no
  `solidToPlayers`/`solidToBullets` shape data on it. The real 3D collider is built once
  from `type + params` at load time (§7), same timing as before ("derived
  deterministically... never computed per-tick"), just built into the physics world
  instead of stored as 2D shape data on the obstacle.

## 7. Collision model

**Every collision question is answered by a real 3D physics world (Rapier), against
real geometry — never a hand-derived 2D approximation.** This replaced an earlier v1
implementation that modeled each obstacle as a pair of 2D shapes (`solidToPlayers`/
`solidToBullets`, floor-level and bullet-height cross-sections respectively). That
approach shipped three separate visual/collision mismatch bugs in a row (the donut's
rendered shape kept drifting out of sync with its hand-derived hitbox) before being
replaced outright, rather than patched a fourth time — see the regression notes in
`src/render.ts`, `src/geometry/donutMesh.ts`, and `src/physics/world.ts` for the
specifics. The fix was architectural, not a bug fix: **the renderer and the physics
world both build their geometry from the same function**
(`buildObstacleGeometry`, §11), so a mesh and its hitbox cannot drift apart — there is
only one set of numbers, not two kept in sync by hand.

Why a physics engine and not hand-rolled 3D math: this project's own attempts at
hand-rolling 2D collision math shipped bugs three times running. General convex-shape
collision (GJK for overlap/distance, EPA for penetration depth, shape-casting for
continuous/swept collision) is a well-known hard-to-get-right problem — mature,
heavily-tested libraries exist precisely because subtle numerical edge cases in this
domain don't crash, they silently misbehave in exactly the way that already happened
here. [Rapier](https://rapier.rs) (`@dimforge/rapier3d-compat`, WASM) was chosen over
hand-rolling for this reason, and over other JS physics options because it directly
supports everything this game needs: native convex primitives (cuboid, cylinder, cone),
static trimesh colliders for concave/hollow shapes, shape-casting and ray-casting
queries, and synchronous operation after one `await`-once WASM init. Rapier is used
purely as a **collision query engine** here — no gravity, no dynamics, no forces; every
player is a manually-positioned kinematic body, and every obstacle is `fixed` (static,
never moves after load).

- **Static vs. dynamic geometry.** Every obstacle in this game is static (placed once,
  never moves). This matters because *only dynamic (movable) bodies need convex or
  convex-decomposed collision shapes* — real physics engines (Rapier included) let a
  **static** body use an exact, possibly-concave triangle mesh directly, because a
  static-vs-moving query can walk the mesh's actual triangles instead of needing a
  well-defined convex Minkowski difference on both sides. This is what makes the
  donut's real hole possible at all without approximation (see below): its collider is
  the literal mesh, not a decomposition of it.
- **The player's shape comes from one definition**, `buildPlayerGeometry`
  (`src/geometry/playerGeometry.ts`), consumed by both the physics world and the
  renderer — the obstacle rule (§11) applied to players. It returns convex parts in the
  player's local frame (ground-level origin, facing +Z): the body, drawn as a tomato in a
  dress but in outline exactly one cylinder of radius `R` from the ground to
  `playerHeight` (two stacked cylinders), and the gun, a thin box at bullet height from
  `R` to `muzzleOffset`. Parts must be convex — players move, and a moving shape can only
  be swept against the static donut trimesh if it is convex — so a future detailed model
  becomes several convex pieces or a convex hull. Body parts must also be symmetric about
  the vertical axis (cylinders or cones centered on it), because the body's colliders
  don't turn with the facing; the gun is the part that turns (`orientPart`, which applies
  exactly the renderer's rotation). Changing how a player looks and collides means
  changing that one function.
- **Player movement**: the player's real body — a cylinder of radius `R` and height
  `playerHeight`, resting on the ground — is shape-cast along the movement direction;
  the swept distance to first contact (against any obstacle or any other living
  player's body) clamps how far it actually moves this tick. Movement stays
  axis-aligned-only, so this never needs "slide along the wall" logic — a blocked axis
  just stops there, not deflects into an axis that was never being tried.
- **Gun**: the barrel part, turned to `facing`, is shape-cast alongside the body, and
  movement clamps at whichever part makes contact first. Since `muzzleOffset > R`, the
  gun leads wherever something stands at bullet height; over a wall lower than that, the
  gun passes over and the body is what stops. Each player's gun is also a collider,
  turned with the facing, and solid to other players' *bodies*: a body walking into
  someone's barrel from any side stops against it, so a gun never ends up inside another
  player. Bullets pass through guns (a hit is a hit on the body), and guns are never
  checked against other guns — two barrels may cross. (Until M0 task 2 the gun
  collided as an invisible slab from the ground to `playerHeight` while being drawn as a
  thin barrel — a visual/collision mismatch of exactly the kind §11 forbids.)
- **Turning**: an instantaneous 90°/180° facing change re-checks only the gun (the body
  doesn't move) via an overlap test at the new orientation, not a sweep — if the gun's
  box would overlap any obstacle, any other player's body, or leave the board, the turn
  is refused (§8).
- **Bullet**: a ray at fixed height `bulletHeight`, cast from the bullet's current
  position along `dir` for this tick's travel distance, against *every* collider in the
  world at once — obstacles and every living player's body together — so "what does
  this bullet hit first" is a single query, not "check walls, then separately check
  players, then compare." A bullet's own path is nudged forward by a tiny epsilon
  before casting, purely to avoid the "is a ray starting exactly on its own shooter's
  boundary inside or outside" ambiguity a solid raycast would otherwise resolve
  arbitrarily — not to grant the shooter immunity (§9 — there is still no ownerId
  special case in the hit result itself).
- **Bullet vs bullet**: no collision — they pass through each other (bullets are never
  colliders in the physics world; only obstacles and player bodies are).

### Primitive → collider table

| Primitive | Authoring params | Collider |
|---|---|---|
| **cube** | footprint w×d, height h | native cuboid, exact dimensions, resting on the ground |
| **cone** | base radius, height | native cone, apex up / base down — confirmed to match three.js's `ConeGeometry` convention exactly |
| **arch** | footprint w×d, door width, door height, `axis` (`x` or `y`) | two native cuboids (the pillars, full height, always solid) + a third (the lintel) only if `doorHeight` is less than the wall's full height — see Arch orientation |
| **donut** | footprint w×d, hole radius `r`, `axis` (`x` or `y`) | a single **static trimesh** — a literal "washer" mesh (a short hollow cylinder: outer radius = `hubHeight`, inner radius = `r`, extruded to the along-axis thickness), the exact same vertex/index buffers the renderer draws (§11) |

The donut is a real, hollow 3D shape with a genuine hole — not a rectangle with a
hand-coded "is there a gap at this column" rule. A mathematically round-tubed torus was
tried first for the collider/mesh and rejected: matching an authored thickness that's
large relative to the hole's rim width needs a non-uniform scale on the tube so extreme
it produces a degenerate, unreliable mesh. The washer (straight cylindrical walls, not
a curved tube) has no such failure mode at any radius/thickness ratio.

### Arch orientation

An arch's `axis` is the world axis a player or bullet moves **along** to pass through
it — restricted to `x` or `y`, matching the two axes anything can travel.

- The footprint's extent **across** `axis` is where the door gap is cut — the wall's
  length. Its extent **along** `axis` is the wall's thickness: how deep you walk or
  shoot through it. So `axis: "y"` with `w=6, d=1` is a six-wide wall one unit deep,
  crossed by moving north–south: the door gap is cut into the across-axis extent `w`,
  and `d` is how deep the doorway is front-to-back.
- The two pillars sit on either side of a `doorWidth`-wide gap centered in the
  across-axis extent; each pillar keeps the full along-axis extent (the wall's
  thickness) and the wall's full height (always solid to everything, regardless of
  `doorHeight`). The gap between them has no collider *at all* at any height below the
  lintel — not "open to players, closed to bullets": genuinely open, to anything short
  enough to fit.
- The lintel exists only when `doorHeight` is less than the pillars' full height, and
  spans from `doorHeight` up to that full height, across the door gap — a real box, at
  the real height where it would actually block something, not a `doorHeight > H`
  boolean.
- `axis` is optional and defaults to `"y"`, matching the donut's default and keeping
  maps authored before the field existed valid. The editor always writes it explicitly
  — the same rule as the donut's `axis` (§13).

### Donut orientation and height

A donut always stands **vertically**, like a wheel resting on the board, so its hole
faces sideways and a bullet can travel through it. A flat-lying donut would point its
hole at the sky, where no bullet can use it, which would make the donut a cube for
every shooting purpose.

- `axis` is the world axis the hole runs along, restricted to `x` or `y`. A bullet
  moving parallel to `axis`, whose height falls within the hole's real vertical span at
  that point, passes cleanly through — this is a consequence of the real mesh, not a
  rule checked separately from the geometry.
- The footprint's extent **across** `axis` is the wheel's diameter; its extent **along**
  `axis` is the wheel's thickness. So `axis: "y"` with `w=5, d=1` is a five-wide wheel
  one unit thick, facing north–south.
- The wheel rests on the ground, so its hub (and the collider's true outer radius) sits
  at `hubHeight = (across-axis extent) / 2` — derived, never authored, and now exactly
  equal to the mesh's actual outer radius, not an independent approximation of it.
- Constraint: `r < hubHeight`, or there is no rim left to block anything.

Emergent cases from these rules — all now genuine consequences of real 3D geometry
and real body/bullet heights, not hand-coded per-case booleans:

- **Low wall** (cube/cone shorter than `bulletHeight`): a player's body starts at the
  ground and is blocked by any positive height of solid material there, however short;
  a bullet flying at `bulletHeight`, above the wall's top, passes over. Cover from
  people, none from gunfire. The gun barrel (a thin box around `bulletHeight`, 0.08 tall)
  passes over it too — except a wall within the barrel's half-thickness of
  `bulletHeight` (about 0.86–0.9 at the defaults), which the barrel catches although a
  bullet still clears it.
- **Low slot** (an arch whose `doorHeight` is strictly between `bulletHeight` and
  `playerHeight`): the opposite of what v1 originally called a "low tunnel." A real
  gap that low lets a bullet fly under the lintel but is too short for a full-height
  player's body to fit through — a mail-slot, not a place to duck through. (The
  original "low tunnel: blocks bullets, always walkable by players regardless of
  height" rule could not survive real 3D player-body collision: if a doorway is short
  enough to block a bullet at `bulletHeight`, and a player's body genuinely occupies
  real space up to `playerHeight` — which must exceed `bulletHeight`, per §5 — then
  that doorway is necessarily too short for the player too. There is no gimmick left to
  preserve the old asymmetric rule once collision is real; a "low slot" is the closest
  honest equivalent, and a genuinely useful, different mechanic in its own right.)
- **Donut always blocks a ground-standing player at its center**, regardless of
  `axis`/hole size: the wheel's material touches the ground only directly below the
  hub, and a real body starting at ground level always overlaps some solid material
  there — this now emerges from the mesh and `playerHeight` rather than being a
  hand-coded "donut always solid to players" rule. (A sufficiently tall wheel *can* let
  a player pass near the very edges of its footprint, where the rim has curved up above
  head height — a real, if narrow, consequence of the same real geometry, not
  something to special-case away.)
- **Blocked donut** (the hole's real vertical span misses `bulletHeight`): a bullet at
  that height hits solid rim material regardless of which side it approaches from,
  because the mesh simply has no hole there. The default 40×40-board sizing does not
  produce a shootable donut by accident — a usable window has to be authored as a low,
  fat wheel.
- "Arch big enough" = `doorWidth > 2R` (player) and `doorHeight > bulletHeight`
  (bullet); crossing it at all (player or bullet) requires moving parallel to the
  arch's `axis`.
- "Donut big enough" = `axis` matches the shot's direction **and** the hole's real
  vertical span includes `bulletHeight` at that point.

Nothing at runtime does per-tick mesh math — obstacle geometry (colliders and render
meshes alike) is built once at map load (§6), same timing as the v1 2D shapes this
replaced.

## 8. Movement and input

- Input keys: **arrows** or **IJKL** = move, **Space** = shoot. Keys typed into a text
  field (a player name, a room code) are text, never movement, and leaving the window
  releases every held direction. Modifier chords (Cmd/Ctrl/Alt + key) are never movement,
  since the browser may not deliver their keyup. Outside a match the keys are tracked but
  never swallowed, so Space still presses a focused button and arrows still scroll; a
  direction already held when a match starts takes effect immediately.
- Keyboard input goes to an `InputSender`, which sends an `input` message (§12) only when
  the direction changes or on a shot, with a strictly increasing `seq`. It is active only
  on the match screen.
- Input is normalized: `moveDir ∈ {+X,−X,+Y,−Y, none}`, `shoot` is an edge (key-down),
  not held state.
- **Arrow-key/IJKL directions are screen-relative, not fixed world-axis labels.** Up
  must move the player up on screen, right must move it right, and so on — that is the
  entire point of physical directional keys. Which world `Direction` (`+X`/`−X`/`+Y`/`−Y`)
  counts as "up" depends on the camera's azimuth (§11) and is derived from it, not
  chosen independently. An implementation must compute the four key→`Direction`
  mappings from the camera's actual orientation (one source of truth) rather than
  hand-write both the camera azimuth and the key mapping as separate constants that can
  drift out of sync — that drift previously shipped as a bug (arrow-up did not move the
  player up) and is covered by a regression test (§15).
- Movement is strictly axis-aligned and continuous; changing direction is an instantaneous
  90° switch between directions.
- Players cannot enter solid obstacle geometry (real 3D colliders, §7) or overlap other
  players' bodies.
- A direction change swings the gun with it instantly. If the gun would not fit in the
  new direction — overlapping an obstacle, another player's body, or leaving the board
  — the turn is refused for that tick: `facing` and position stay unchanged. This
  applies equally to a 180° reversal. A player therefore cannot come closer than
  `muzzleOffset` to anything that reaches bullet height, whether approaching head-on or
  turning toward it from alongside; a wall lower than bullet height lets the gun pass
  over it, so the body can come right up to it.

## 9. Shooting

- On `shoot` edge, if `now − lastShotAt ≥ cadence`, spawn a `Bullet` at the muzzle
  (`muzzleOffset` from the player's center along `facing`) moving at `bulletSpeed` along
  `facing`.
- The bullet's first-tick ray starts at the edge of the shooter's body, not at the
  muzzle, so nothing between the body and the muzzle can be skipped. Since the gun is
  the barrel at bullet height and movement and turning never let it overlap anything at
  that height (§7, §8), that stretch is always clear of obstacles and other players'
  bodies.
- **Players are not immune to their own bullets.** The bullet-vs-player test applies to
  every living player, the shooter included — the collision query itself has no
  `ownerId` branch (§7); a bullet's own path is nudged forward by a tiny epsilon purely
  to resolve the boundary ambiguity of a ray starting exactly on its own shooter, not to
  grant immunity. In v1 geometry the shooter cannot actually be struck by their own
  bullet — it starts outside them and travels straight away at 3× their speed — so the
  rule's force is that collision code has no ownership special case, and any later
  change (ricochet, slower bullets, faster players) inherits self-hits by default.
- The bullet travels until it (a) hits solid obstacle geometry at `bulletHeight`, (b)
  its horizontal path comes within `R` of a living player's `(x,y)` (spec §5 — this one
  test stays height-agnostic), or (c) it exits the board bounds — in all cases the
  bullet is consumed.
- A bullet meeting a living player kills that player (one-hit-kill) and is consumed.
- Firing uses the player's `facing` regardless of whether they are moving.

## 10. Death, rounds, and match

- **Round** = one life per player, last-man-standing wins.
- **Round win**: when exactly one player remains alive → that player scores `+1`, next
  round begins.
- **Round draw**: when `roundTime` elapses with 2+ players alive → nobody scores, next
  round begins (time limit is pure anti-stall).
- **Match win**: first player to reach `targetScore` round wins. `phase` becomes `matchEnd`.
- **Match over without a winner**: a match needs at least two connected players to be a
  contest. If the number of connected players drops below two, the match ends immediately —
  `phase` becomes `matchEnd` with no winner, and the scores from the rounds already played
  stand and are shown. This is deliberately *not* a draw: a draw resolves a **round**, and
  resolving an empty round as a draw would begin another empty round, forever. `matchEnd`
  therefore means "the match is over", with a winner when someone reached `targetScore` and
  without one when the players left.
  Solo **practice** is exempt: a game created with `config.practice = true` is a declared
  one-player mode (§14) and never ends for want of opponents.
- **Spawns**: random (drawn from the game's seed, §4) with fairness each round — each spawn point is non-solid (a real
  player-body-sized query against the physics world, §7, comes back clear), mutually
  separated by at least `spawnSeparation`, and pulled in from
  board edges by at least `spawnEdgeMargin`, and admits at least one facing in which the gun
  fits (§8); the spawn facing is chosen at random among those. Fairness is validated/rejected if infeasible
  (see Level editor).
- **Disconnect**: a disconnected player is inert (not a target) and cannot score. If that
  leaves fewer than two connected players, the match ends without a winner, as above — the
  round is not resolved as a draw, because another round would have nobody in it.
  The **room** (`session`, running on the server) is what marks a player disconnected: the
  server tells it when a player's connection drops, since it's the only component that
  knows. The room sets `connected` to false on the state it holds and calls `step` as usual;
  `sim` applies every consequence above. The fact comes from the room, the rules stay in
  `sim` — which is why `sim` needs no function for this, and why the rules are not
  duplicated in two places that can drift apart.

## 11. Rendering

- three.js, **fixed tilted perspective camera** (fixed azimuth and polar angle). No
  interactive rotation/zoom in v1 — the player never controls the camera. Distance is not
  a hardcoded constant: it is computed once per map load from board bounds and viewport
  size (see acceptance criterion below), then held fixed for the session.
- **Azimuth must be cardinal** (a multiple of 90°), not a diagonal "corner" 3/4 angle.
  A cardinal azimuth is what makes each world `Direction` project to exactly one screen
  direction (up/down/left/right) — required by §8's screen-relative input mapping. A
  diagonal azimuth (the original v1 choice, 45°) makes every axis-aligned move look like
  it's angling sideways on screen, which reads as broken controls even though the
  underlying movement is correct. This is why the "3/4" in the camera's name is now just
  "tilted": the tilt (polar angle) still gives the game depth and readability; the
  azimuth no longer contributes a diagonal viewing angle.
- **A rendered obstacle's mesh and its physics collider are built from the same
  function, `buildObstacleGeometry` (`src/geometry/obstacleGeometry.ts`) — not two
  independently-tuned representations.** What a player sees *is* what's solid, exactly,
  because both come from one call: a box spec becomes a `THREE.BoxGeometry` mesh *and* a
  Rapier `Cuboid` collider with identical dimensions/position (cube, arch's pillars and
  lintel); a cone spec becomes a `THREE.ConeGeometry` mesh *and* a Rapier `Cone`
  collider; a donut spec carries a literal `THREE.BufferGeometry` (the washer mesh, §7)
  that becomes both the render mesh *and* the vertex/index buffers fed to Rapier's
  static trimesh collider — the same hole is what's drawn and what's solid, because it's
  the same buffer. `render.ts`'s `buildObstacleMesh` and `physics/obstacles.ts`'s
  `addObstacleToWorld` are the only two places this geometry is consumed, and
  `obstacleMesh.test.ts` checks the render side against the shared spec directly —
  three.js geometry objects are pure JS, so this is inspectable in a unit test without a
  canvas.
- **Regression history — do not re-introduce an obstacle mesh that isn't built this
  way.** The donut went through three rounds of visual/collision mismatch before this
  architecture existed, each one a symptom patch rather than removing the class of bug:
  a stylized torus sized independently of its footprint "by eye" (first too small, a
  player stopped by an invisible corner; then re-sized from the footprint's diagonal
  while ignoring `hubHeight`, producing a wildly oversized ring sinking through the
  floor); then a plain box matching the collision rectangle exactly but with no visible
  hole at all — collision-accurate but not what a "donut" should look or behave like;
  then a translucent ground decal added *underneath* a still-wrong mesh, which just
  leaves two disagreeing visual representations on screen. The fix that actually held
  was architectural: give the donut a genuinely correct 3D shape (the washer, §7) and
  make the renderer and the physics world consume the *exact same* geometry data,
  so there is nothing left for either side to get wrong independently of the other.
- **An arch's lintel (§7) renders exactly as opaque as a pillar — there is no
  translucent "ghost" material for it, and there must never be one again.** An earlier
  attempt rendered the lintel semi-transparent, reasoning that it was "solid to bullets
  but never to players" and that opaque paint there would read as clipping through a
  wall. That reasoning was a holdover from the abandoned "low tunnel" concept (§7's
  regression note) and is false under real 3D collision: since `bulletHeight` is always
  less than `playerHeight`, a lintel is either genuinely solid to the player's real
  body (whenever `doorHeight < playerHeight` — the low slot and closed cases alike,
  where the player is stopped by it exactly like a pillar) or sits entirely above the
  player's rendered height and is never reached at all (`doorHeight >= playerHeight`).
  There is no configuration where a player would ever clip through or duck under it —
  "solid to bullets, not to players" is mathematically impossible once bulletHeight <
  playerHeight, so there is nothing left for translucency to signal. Rendering it
  translucent anyway just made a genuinely solid wall look like it might not be one —
  the same class of visual/collision mismatch this whole architecture exists to
  eliminate, reintroduced by hand in the one place a role-based special case survived.
- Scene built from each snapshot: ground plane sized to board bounds; one mesh per
  obstacle from its primitive type (box / cone / box-with-cutout for arch / washer for
  donut); players drawn part for part from `buildPlayerGeometry` (§7): the body's upper
  part tinted by `skinId`, the lower part as the dress, and the gun barrel along
  `facing` at height `H`, so bullets visibly leave it; bullets = thin tracers whose tip is
  the bullet's point position at height `H` (a bullet collides as a point), with a short
  streak trailing along the path, so the tilt makes hole-crossing visually true.
- Fixed lighting; subtle floor grid/hint for spatial reading. No post-processing in v1.
- Round parts (cylinders, cones) are drawn as 64-sided polygons inscribed in the exact
  circle the collider uses, so the drawn outline is within 0.12% of the collider's; the
  donut's washer mesh is the collider itself.
- **HUD** (DOM overlay, derived from the ClientView by `src/client/hud.ts`): round number
  and a countdown from `roundTime`; each player's color, name ("you" marked) and score,
  highest first, dimmed when dead and struck through when disconnected; a two-second
  "X wins round N" / "Round N: draw" banner after each round; a Leave button.
- **Screens** (`src/ui/app.ts`): Home (name, Practice, Play vs bots, Create game, Join by
  code, Level editor) → Lobby (room code, players, colors, ready, owner's settings and
  Start) → Match → Match end (winner or "no winner", final scores, Back to lobby / Leave).
  Practice skips the lobby and never reaches Match end (§10). Play vs bots opens a setup
  screen (bots 1–7, difficulty, map, round wins to win; the last choices are remembered),
  then skips the lobby; its Match end offers Play again / Home. Every screen transition is decided by the
  pure view model (`src/client/model.ts`); player names are only ever inserted as text.
- Skins: a fixed, predefined palette of distinct colors (not user-importable, no patterns
  in v1). Uniqueness of `skinId` is enforced in the lobby. Skins are static client-side
  data; rendering only.

### Acceptance criteria

- **Board framing**: given any valid board `width × height` (editor-authored, including
  the 40×40 default) and the browser's current viewport size, the camera distance shall be
  computed on scene load so that:
  1. The entire board (all four edges) is contained within the viewport at the fixed
     azimuth and polar angle — no edge clipped off-screen, at any supported viewport size.
  2. Unused space (viewport area outside the board's rendered footprint) is minimized
     subject to (1) — i.e., the board is framed as large as it can be without clipping,
     not placed at an arbitrary conservative distance.
  3. Azimuth and polar angle stay exactly as specified elsewhere in this section — only
     distance (zoom) varies to satisfy (1) and (2); the camera never rotates to fit.
  - Re-evaluated on map load and on viewport resize; not re-evaluated per-tick during
    play.
- **Input/screen alignment**: for the shipped azimuth, each world `Direction` classifies
  as exactly one of up/down/left/right on screen (§8), and the keyboard mapping is
  derived from that classification rather than duplicated by hand. Verified by
  `tests/unit/camera.test.ts`, which also asserts a diagonal azimuth is rejected rather
  than silently producing an unclassifiable direction.

## 12. Networking

The server is authoritative (§4). Every client holds one WebSocket connection to it; there
is no peer-to-peer traffic.

### Rooms and flow

1. **Create**: "Create game" → the client sends `createRoom`. The server creates a `Room`,
   makes the creator its **owner**, and replies with a short room code (5–6 characters from
   an unambiguous alphabet), the creator's `playerId` and a `reconnectToken`.
2. **Join**: "Join game" → enter the code → `joinRoom`. The server replies with a
   `playerId` and `reconnectToken`, or rejects the join if the code is unknown, the room is
   full (`maxPlayers`), or a match is in progress.
3. **Lobby**: the room keeps the roster, skin choices (unique per room), ready flags, map and
   config, and broadcasts them as a `lobby` message on every change. **No game exists
   yet**: `createGame` is not called until the owner starts the match, so there is no
   `State` and nothing to snapshot. The lobby is a room, not a game.
   - Each joiner gets the first free palette skin; `setSkin` refuses a skin outside the
     palette or one another player has.
   - Only the owner changes the map and config and starts the match. The map is chosen
     **by id from a built-in catalog** (`src/session/maps.ts`), so no client-supplied map
     data reaches the server until the editor (§13) adds validated custom maps. A client
     may set only `targetScore` (integer 1–10) and `roundTime` (integer seconds 10–300);
     physics tuning is never client-settable.
   - **Start gate**: at least two connected players, and every player except the owner has
     set ready (the owner's "start" is their ready). A practice room holds exactly one
     player and can always start.
   - A player who leaves the lobby is removed outright (there is no score to keep); their
     reconnect token stops working. The owner role passes on as in §14.
   - Player names are trimmed and stripped of control and format characters (zero-width,
     bidirectional overrides), and must be 1–20 characters long, counted in characters.
   - A refused action is answered with an `error` message to that player only.
4. **Play**: on start, the room calls `createGame` with the final roster and the
   catalog map, and sends `matchStart` with the map and config once. Every map, the catalog's included,
   is validated by the map loader on the way in (§13, via `GameApi.start`); custom maps
   from the editor (M3) will go through the same check. A start that fails is reported to the owner as an `error` and the room stays in
   the lobby; a player who disconnects while the match is starting is treated as having
   dropped from the match, not the lobby. **The roster is fixed from this moment.** Nobody joins a match in
   progress; a player who drops is marked disconnected (§10) rather than removed, so their
   score survives, and they can return with their `reconnectToken` (`rejoin`) to get the
   same `playerId` back.
5. **After the match**: when `phase` becomes `matchEnd`, the room returns to the lobby with
   the same roster (minus anyone who left), so the owner can start a rematch.

### Authority and timing

- The server runs each room's `sim` at a **60 Hz fixed timestep** (a drift-corrected
  timer in `server/`; the room itself never owns a timer). Snapshots are sent at
  **30 Hz** (every second tick).
- Clients **render snapshots only** — no client-side simulation and no prediction in v1.
  The client interpolates positions between the last two snapshots for smoothness
  (`src/client/interpolate.ts`): it draws from the previous snapshot toward the latest over
  one snapshot interval (33 ms) after the latest arrives, never interpolating across a new
  round or for a player not alive in both, so respawns snap instead of sliding.
- Determinism serves unit-testability and reliable replays (AI testing); it is not needed
  for client correctness, because only the server simulates.
- Solo **practice** runs a `Room` in-process in the browser, driven by the page's own
  loop, with no server and no network.
- **Play vs bots** (`src/client/localMatchSession.ts`) is the same, with normal rules: a
  `LocalMatchSession` runs a non-practice `Room` in the page with the human (its owner)
  and 1–7 `BotPlayer`s, each on its own `InProcessSession`, so bots join, ready up and
  play through exactly the messages a remote player sends. Its `tick()` is the only clock:
  it steps the bots on simulated time, then ticks the room, so with a seed a local match
  is reproducible whichever loop drives it. Bots are named "Bot N (Level)". It starts by
  itself once every bot is ready, and again only when `playAgain()` is called after a
  match (ignored mid-match). Settings outside the room limits are refused up front.

### The server process (`server/`)

- One port serves both HTTP (`GET`/`HEAD /health` → `200 ok`; other methods `405`) and
  the WebSocket. Port from `SERVER_PORT` (default 8787); a port already in use makes
  startup fail with an error rather than crash. `npm run dev` starts it alongside Vite;
  `npm run server` starts it alone.
- Capacity limits: at most 500 connections (more are closed with 1013) and 200 rooms (a
  `createRoom` beyond that is answered `joinRejected: serverFull`). A 30 s ping heartbeat
  terminates half-open connections, so a vanished player doesn't keep a room alive.
- A room whose tick throws is closed and removed; the loop and every other room carry on.
- A single drift-corrected 60 Hz loop ticks every room (`server/loop.ts`): ticks are due
  at absolute times, so late timer wake-ups catch up rather than slowing the game, and
  after a long stall it catches up at most 5 ticks and resyncs instead of spiralling.
- Rooms live in a registry (`server/rooms.ts`) keyed by a 5-character code from an
  alphabet without look-alikes (no `0/O`, `1/I/L`); a room is disposed and removed as soon
  as nobody is connected.
- Each socket gets a `ConnectionHandler` (`server/connection.ts`): before joining it
  accepts only `createRoom`/`joinRoom`/`rejoin`; afterwards everything goes to its room.
  Per-connection limits: messages over 4 KB (bytes) close the socket (1009), binary
  frames close it (1003), more than 30 messages per second sustained (burst 60) closes it
  (1008), and so do more than 5 rejected joins (so room codes can't be enumerated from
  one socket); invalid JSON or messages are ignored. After `leave`, the socket is unbound
  from its player and may create or join again. When a rejoin replaces a connection, the
  old one receives `{ type: 'replaced' }`, its socket is closed (4000), and its close does
  *not* disconnect the player.

### Headless bots

`BotPlayer` (`src/client/botPlayer.ts`) plays through any `Session` with the same view
model and `InputSender` the UI uses. In the lobby a guest readies itself; an owner with
host settings applies them and starts a match whenever the start gate opens, so after
each match the bots return to the lobby and play another. In a match its `BotBrain`
(`src/client/bots/brain.ts`) decides every input, from what a player can see — the
snapshot, the map, the config, never hidden state — using standard game-AI techniques (no
learning, no language model):

- **Navigation** (`src/client/bots/navigation.ts`): a grid over the board (0.5 cells) of
  where the whole player fits — body from the ground to `playerHeight`, and the gun,
  which must fit when turned into each move and along it — built from the same obstacle
  geometry the physics collides with, and shared by all bots on a map. A* over (cell,
  heading) with a turn penalty gives axis-aligned paths with few turns; a path starts with
  one or two exact single-axis legs from the bot's real position, so a bot resting
  against a wall can always leave. A goal nobody fits in, or (when chasing) one no path
  reaches, is replaced by the reachable place nearest it. Arch doors narrower than
  `MIN_BOT_DOOR_WIDTH` (1.7) may be unplannable wherever they sit on the grid.
- **Decisions — utility AI**: every `thinkMs` it scores dodge 1.0 · evade 0.95 · attack
  0.9 · chase 0.5 · wander 0.1 and does the best available. *Dodge*: step aside from the
  soonest bullet that will pass through it (one roll and one side per bullet — the side
  it is already on when there's room — stepping just far enough to clear the path, and not
  walking back into it until the bullet has passed). *Evade*: step out of an enemy's firing line when it can't fire
  first. *Attack*: lined up on a target within its aim and with a clear line of fire
  (walls lower than bullet height don't count), face it — backing off first when the gun
  wouldn't fit on the turn — then fire after a reaction delay, when its gun is ready by
  the snapshot's clock. *Chase*: follow a path toward the chosen target. *Wander*: no
  one to hunt. When trying to move but getting nowhere it escapes in a random other
  direction; a new round resets its plans.
- **Difficulty** (`src/client/bots/difficulty.ts`) changes settings, not logic: how often
  it re-decides, the reaction delay, how precisely it lines up (aim), how often it dodges
  and evades, and how it picks targets (nearest · one it can shoot now · the most exposed).
  Easy: slow, sloppy, never dodges. Hard: quick, precise, usually dodges.
- All its randomness is seeded; it sends stops immediately and throttles other input
  (only a sent change restarts the 50 ms interval) to stay far below the server's rate
  limit; it records each finished match in `results` and why its session closed. `InProcessSession` attaches any number of bots (or a practice
player) to an in-memory `Room`; `NetSession` attaches them to the real server.
`npm run bot -- --create --count 3 --target-score 1 --once` fills a room on a running
server and prints the winner; options are validated before connecting, and a lost
connection fails the run at once with its reason.

### Protocol

All messages travel over the one WebSocket, which is reliable and ordered (TCP). Message
types live in `src/session/protocol.ts`, shared by client and server.

| Direction | Message | When |
|---|---|---|
| client → server | `createRoom`, `joinRoom { code }`, `rejoin { code, reconnectToken }` | connecting |
| client → server | `setSkin`, `setReady`, `leave`; owner only: `setMap { mapId }`, `setConfig { targetScore?, roundTime? }`, `startMatch` | lobby (`leave` any time) |
| client → server | `{ type:'input', seq, moveDir, shoot }` | match |
| server → client | `roomJoined { code, playerId, reconnectToken }` or `joinRejected { reason: notFound \| full \| inProgress \| badToken \| serverFull }` | connecting |
| server → client | `{ type:'lobby', code, ownerId, players, settings: { mapId, targetScore, roundTime }, maps, canStart, practice }` | lobby, on every change that changes something |
| server → client | `{ type:'matchStart', map, config, players, seed }` — the static data, sent once per match (and again to a player who rejoins) | match start |
| server → client | `{ type:'snapshot', seq, state }` — dynamic state only (players, bullets, scores, phase, round, time) | 30 Hz during the match |
| server → client | `{ type:'event', event }`: the sim's events (`playerKilled`, `roundStart`, `roundEnd`, `matchEnd`, `turnRefused`, `spawnFairnessFailed`) plus session events (`playerJoined`, `playerLeft`, `ownerChanged`) | as they happen |
| server → client | `{ type:'error', message }` — a refused action, to that player only | any time |
| server → client | `{ type:'replaced' }` — to an old connection when the same token rejoins from a new one; nothing follows | on rejoin |

Every client message goes through `parseClientMessage` (`src/session/protocol.ts`) first,
the trust boundary: anything malformed is dropped, names are trimmed to 1–20 characters,
room codes are upper-cased and must be 5–6 characters, and unknown fields are stripped.

- Clients discard snapshots with `seq` older than the latest received (defensive; TCP keeps
  order, but a reconnect can replay).
- `shoot` is an edge and the room latches it until the next tick, so no trigger is lost
  even when an input message arrives between ticks.
- Input is sent only when it changes.
- A rejoin with a token whose player is still connected replaces the old connection: the
  old one receives `replaced` and nothing more, and the server adapter closes it.
- The room never re-broadcasts the lobby for a change that changes nothing (same ready
  flag, same skin). Limiting message rate and size per connection is the server
  adapter's job (M2), not the room's.

## 13. Level editor

- A separate mode of the same SPA, two panes: **2D top-down authoring surface** plus a
  **live 3D tilted preview**.
- Operations: place primitive, move (continuous, axis-aligned), resize (per-type params),
  delete; set board width/height.
- The 2D authoring surface renders each obstacle's true footprint (including a donut's
  hole and an arch's door gap) directly from the same params the real 3D collider is
  built from at load time (§7), so holes are legible while authoring, not a separately
  hand-tuned preview shape.
- Constraints: obstacles lie fully inside board bounds. Soft warnings: board too small or
  too blocked for N fair spawns; arch door too narrow for a player (legal, but flagged).
- Save: to local storage as a named preset → immediately available in the create-game map
  picker, no manual import.
- Share: JSON export (download) / import (file).

### Map JSON schema (versioned)

```json
{
  "version": 1,
  "board": { "width": 40, "height": 40 },
  "obstacles": [
    { "id": "o1", "type": "arch", "pos": { "x": 10, "y": 5 },
      "params": { "w": 3, "d": 1, "doorWidth": 1.5, "doorHeight": 1.5, "axis": "y" } },
    { "id": "o2", "type": "donut", "pos": { "x": 20, "y": 12 },
      "params": { "w": 5, "d": 1, "holeRadius": 1.6, "axis": "y" } },
    { "id": "o3", "type": "cube", "pos": { "x": 8, "y": 30 }, "params": { "w": 4, "d": 1, "h": 0.6 } },
    { "id": "o4", "type": "cone", "pos": { "x": 32, "y": 8 }, "params": { "radius": 2.5, "height": 3 } }
  ]
}
```

This is exactly the in-memory `MapDef` shape (`src/sim/types.ts`), so a map serializes as
plain JSON. `w` × `d` is the footprint's x × y extent. Only authoring params are stored;
the real 3D collider and render mesh are both derived from them on load (§6, §7).
Default board is 40×40 units.

**Loader and validator** (`parseMap` / `serializeMap`, `src/sim/mapFormat.ts`): the single
entry point for every map — built-in, a saved preset, an imported file, one received by
the server. `GameApi.start` runs every map through it, so no invalid map can reach a
game. It treats input as untrusted:
- `version` must be 1; unknown fields are dropped; only an object's own fields count.
- The board is 10–200 units on each side, and a game's board is always the map's (a
  config override is refused), since every obstacle was checked against it.
- At most 200 obstacles, each with a unique `id` of 1–64 characters (no control or
  formatting characters) and a known `type`.
- Every size at least 0.1 (smaller is too thin to see) and finite; heights at most 20 —
  including a donut's wheel, whose height is its diameter.
- An arch always stands 3 units tall (`ARCH_HEIGHT`), so `doorHeight` is at most 3 (a
  door that high has no lintel); `doorWidth` must leave both pillars at least 0.1 wide.
- A donut's `holeRadius` must leave a rim at least 0.1 thick (`hubHeight - holeRadius`).
- Every obstacle lies fully inside the board (cone: its base circle's bounding square).
- `axis` (arch and donut) is `"x"` or `"y"`, optional, and defaults to `"y"`, so maps
  authored before the field existed stay valid. `serializeMap` always writes it — the
  editor never relies on the default.
- A rejected map yields every problem found, each naming its obstacle — including
  duplicates of an invalid obstacle and obstacles past the count limit.
- `serializeMap` validates too, and writes every field explicitly.

## 14. Edge cases and error handling

- **Room owner leaves**: ownership passes to the first connected player *after* the owner
  in join order (wrapping around), and the room emits `ownerChanged`; a match in progress
  continues. With nobody connected there is no owner until someone joins or rejoins. The §10 rule still
  applies: if fewer than two connected players remain, the match ends without a winner.
  (This replaces v1's original "host leaves → everyone returns home", which only existed
  because the host's browser ran the simulation.)
- **Everyone leaves**: the server discards the room once no player is connected, calling
  `Room.dispose()`, which ends any running match and frees its physics world. (A practice
  room would otherwise never end on its own.)
- **Server unreachable or connection lost**: while connecting, the client shows
  "Connecting to the game server…" with Cancel, and gives up after 5 s ("could not reach
  the game server"; a malformed server address is reported the same way instead of
  throwing). A drop after connecting returns to the home screen with "Disconnected:
  connection lost". The room code and reconnect token are kept per tab
  (`sessionStorage`, validated when read back), so the home screen offers "Rejoin room
  CODE" — also after a page reload. If the seat no longer exists (the player dropped out
  of the lobby, or the match ended without them) the rejoin is refused with `badToken`
  and the client joins the same room afresh instead. `notFound`, leaving on purpose, or
  being replaced by another tab ("This game was opened in another tab or window.")
  forget the room. Note that in a two-player match a drop ends the match at once (§10);
  with three or more players the match continues and the rejoin restores the player,
  score and all.
- **No fair-spawn board**: editor blocks/warns at save. At runtime, a player with no fair
  spot gets the best spot the board has: clear of obstacles, far enough from everyone
  already placed that nobody starts inside another's body or gun reach, with a facing
  where the gun fits, and as far from the others as possible. Only a board with no such
  spot at all falls back to a corner.
- **More than 8 players**: `GameApi.start` refuses a roster over 8 (the room cap, §5).
- **Shoot before any move**: use the spawn default facing.
- **Concurrent same-tick deaths**: all resolved in one tick, no ordering bias.
- **<2 connected players**: the owner cannot start the match; solo play is "practice",
  which runs in the browser without a room on the server.
- **Empty map**: valid; spawn fairness still applies on the open plane.
- **Bullet vs bullet**: no interaction.
- **Turning into a wall or player**: refused while the gun would not fit (§8).
- **Own bullet**: hits the shooter like anyone else (§9).

## 15. Testing

- **`physics/world` unit tests** (`physicsWorld.test.ts`) — the real 3D collision layer
  tested directly, no sim/game-rules layer involved: a donut's hole is genuinely
  shootable/blocked along the correct axis, and always blocks a ground-standing player
  at its center (both properties emerge from real mesh geometry, not a hand-coded axis
  rule, so there is nothing here to keep in sync by hand); an arch's `doorHeight`
  threshold across all three real regimes — open (bullet and player both pass), low
  slot (bullet passes under, player is too tall to fit), closed (both blocked) — plus
  its pillars always blocking regardless of `doorHeight`; a cube wall stopping a player
  at the leading gun, not the body (the muzzle's own shapecast, swept alongside the
  body's); no tunneling through a thin wall even at a huge requested distance. Each
  scenario is set up with real `ObstacleDef`s and asserted via `raycastBullet`/
  `moveDistance` — the same calls `sim` uses — so a regression here is a regression in
  the actual collision engine, not a reference implementation of it.
- **`sim` (pure) unit tests** (`sim.test.ts`) — everything layered on top of the
  physics world: movement clamped at board edges; the gun leads the body and blocks
  turns it doesn't fit; a bullet spawns at the muzzle and is consumed by the first real
  hit (wall, player, or board exit); no owner immunity (a bullet already overlapping its
  owner still resolves correctly, via a start-position nudge rather than excluding the
  shooter's collider, §7); a stationary target is hit at its real, not stale, position
  (regression coverage for a bug where only actively-moving players had their physics
  collider re-synced from logical `.pos` each tick — `step()` now syncs every
  connected player's position unconditionally before resolving movement); single and
  concurrent deaths; round win/draw transitions; match-end; spawn fairness (non-solid,
  min separation, gun fits); deterministic replay (same inputs → same state, run
  against two independently-constructed games/physics worlds, since a `PhysicsWorld` is
  a live mutable handle and reusing one across two replay runs would apply both input
  sequences to the same world sequentially rather than test two independent trials).
- **Seeded determinism** (`determinism.test.ts`): the PRNG is reproducible per seed; the
  same seed gives identical spawns and a different seed different ones; a replay is
  identical across several round boundaries (each re-runs spawn placement); `step` never
  calls `Math.random`, and no load-time state changes when `Math.random` does; a seed that
  can't be replayed is rejected and an out-of-range one is recorded as the value used;
  `GameApi` picks a fresh seed per unseeded start, records it, and a run replays exactly
  from it.
- **Player shape** (`playerGeometry.test.ts`, `physicsWorld.test.ts`): only convex parts;
  the body is exactly one cylinder from the ground to `playerHeight`; the gun is a thin
  barrel at bullet height from `R` to `muzzleOffset`; the shape follows the config;
  `buildPlayerMesh` draws exactly those parts. In physics: the gun passes over a low wall
  (the body stops), a turn toward a wall closer than the muzzle is allowed over a low
  wall and refused into a tall one, the gun is still blocked by other bodies, and a
  disabled player is inert in every part.
- **Rendering/collision fidelity** (pure, unit-tested despite being about rendering,
  because it's the correctness property behind §11's "built from the same function as
  the collider" rule, not a look-and-feel one — three.js geometry objects are
  inspectable without a canvas): `buildObstacleMesh`'s output is checked against
  `buildObstacleGeometry`'s output directly — dimensions and position for cube, cone,
  and arch (both pillars, both `axis` orientations); vertex and index buffer contents
  (not object identity — physics and render each call `buildObstacleGeometry`
  independently and get numerically-identical but distinct objects) for the donut, both
  axes — plus a direct regression guard that the donut's geometry is the washer
  (a real hollow shape), not a box or an undistorted-but-wrong torus
  (`obstacleMesh.test.ts`).
- **Editor**: map round-trip (`save → export → import` ⇒ identical params).
- **Map loader** (`mapFormat.test.ts`): built-in maps pass unchanged and round-trip;
  `axis` defaults and unknown fields are dropped; every rule in §13 rejects what it
  should, naming the obstacle and reporting all problems; `GameApi.start` refuses an
  invalid map.
- **Session** (`protocol.test.ts`, `roomLobby.test.ts`, `roomMatch.test.ts`): the
  client-message parser rejects anything malformed; the room's lobby rules (owner, unique
  skins, owner-only settings with limits, start gate, leaving and ownership transfer);
  the match lifecycle driven by injected ticks (matchStart once, dynamic-only snapshots at
  30 Hz, input latching and stale-seq rejection, event forwarding, seeded determinism,
  disconnect/rejoin by token, owner transfer mid-match, match end back to the lobby with
  the final snapshot first, practice never ending).
- **Server** (`serverLoop.test.ts`, `serverRooms.test.ts`, `serverConnection.test.ts`):
  the tick loop under a fake clock (60 Hz, no drift with late wakes, bounded catch-up);
  room codes, lookup, ticking and empty-room disposal; the connection handler with fake
  sockets (routing, rejections, size and rate limits, replaced connections).
- **Networking**:
  - Real-socket integration (`tests/integration/server.test.ts`) against a server started
    in the test: health check, create → join → ready → start with ~30 Hz snapshots, a
    dropped socket reported to the others, replaced sockets, frame limits, connection
    cap, port in use, heartbeat, shutdown.
  - `NetSession` against the real server (`tests/integration/netSession.test.ts`).
  - **Bots** (`bot.test.ts`, `botPlayer.test.ts`, `tests/integration/bots.test.ts`): the
    strategy's decisions (including backing off at close range); bots readying, hosting
    and starting; two bots playing an in-memory match to an agreed winner; the rate
    limit respected; seeded reaction delays; three bots over real sockets; the CLI end
    to end.
  - **Bot AI** (`navigation.test.ts`, `botBrain.test.ts`, `botMatches.test.ts`,
    `localMatch.test.ts`): paths walkable by the real physics from arbitrary starts
    (doors, low slots, lintels, low walls, unreachable goals, speed); each behavior on
    scripted snapshots; whole seeded bot matches on every map at every level finish with
    a winner and no round running out the clock; the difficulty ranking over 30 seeded
    matches per pair (hard > normal > easy, each in nearly all); the local match's setup,
    auto-start, play, replay and teardown.
  - Play vs bots end to end (`tests/e2e/local.spec.ts`): Home → setup → a match with the
    keyboard → match end → Play again → Home, the remembered setup, and
    `GameClient.startLocalMatch` for a harness.
  - Two-browser smoke test (`tests/e2e/multiplayer.spec.ts`, `npm run test:e2e`,
    Playwright): two separate browser contexts create a room, join it by code, ready,
    set the map and score, start, and one player kills the other with real key presses
    (decisions from the bots' strategy) until both screens show the same winner; then
    back to the lobby; no page errors. Plus practice moving with real keys. The test
    starts its own game server and Vite on dedicated ports (8797 / 5197).
  - The server compiles under its own no-DOM tsconfig (the §4 isolation rule).
- **Camera/input alignment** (pure, unit-tested — the one part of "rendering" that isn't
  just a visual smoke test, because it's a correctness property, not a look-and-feel
  one): every world `Direction` classifies as exactly one screen direction under the
  shipped camera azimuth; the keyboard mapping matches that classification; a diagonal
  azimuth is rejected rather than silently accepted. Regression coverage for the
  shipped arrow-up-didn't-move-up bug (`camera.test.ts`).
- **`GameApi` pause/resume** (`api.test.ts`): `tick()`/`runTicks()` advance the sim
  identically whether paused or not — `pause()` only stops `main.ts`'s automatic rAF
  loop from self-driving, never the explicit calls an AI/test harness makes.
- **Rendering**: manual/visual smoke test (fixed camera, correct priming, bullet at `H`,
  the donut's hole actually visible, every arch part — pillars and lintel alike —
  rendering opaque), not unit-tested.
