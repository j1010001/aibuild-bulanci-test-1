# Browser Party Shooter — Design Specification

Date: 2026-09-15
Status: approved (design review)

## 1. Overview

A 3D-rendered browser multiplayer party shooter played on a flat plane. Players are
visually identical shapes (a tomato with a dress) distinguished only by skin color. Each
player moves axis-aligned and carries a gun that shoots along the same world axes; a
single hit kills. A match is a score race of rounds.

The deliverable has two integrated pieces:

1. **Game** — real-time multiplayer; a host generates a short room code that friends use
   to join.
2. **Level editor** — built into the same app; author maps with predefined primitives,
   save them locally (immediately available in the game's map picker), and share them via
   JSON import/export.

## 2. Terms

Canonical vocabulary used consistently throughout.

- **Primitive** — a predefined obstacle kind: `cube`, `cone`, `donut`, or `arch`. Each
  primitive defines how its authoring params derive the two collision shapes.
- **Obstacle** — a placed instance of a primitive:
  `{ id, type, pos, ...params, groundShape, bulletShape }`.
- **Axis-aligned** — constrained to the four world directions `+X, −X, +Y, −Y`. No
  diagonal movement or shooting.
- **Direction** — one of `+X, −X, +Y, −Y`. A player's `facing` and a bullet's travel
  direction are both directions.
- **Facing** — a player's current direction; the gun fires along it. Set by the latest
  non-idle movement, random at spawn.
- **Bullet height (`H`)** — the fixed world constant at which bullets travel; a bullet is
  a point on the plane at this elevation.
- **Ground shape** — an obstacle's region of the plane at floor level; blocks player
  movement.
- **Bullet shape** — an obstacle's region of the plane at bullet height `H`; kills a
  bullet on contact.
- **Cross-section** — the 2D region of an obstacle at a given height. The ground shape and
  bullet shape are the two cross-sections the game logic cares about.
- **Footprint** — an obstacle's full horizontal (X/Y) extent irrespective of height.
- **Hole** — a gap in an obstacle's ground shape or bullet shape that admits passage: a
  player through the ground shape, a bullet through the bullet shape.
- **State** — the authoritative game state owned by the simulation (see Data model).
- **Snapshot** — a broadcast `{ type:'snapshot', seq, state }` from the host to clients.
- **Host** — the authority that runs the simulation; v1 this is the host's browser.
- **Server authority** — the later relocation of the simulation to a server process (out
  of scope v1).

## 3. Scope

### In scope (v1)

- Host-authoritative multiplayer (the host's browser runs the simulation).
- Real-time, axis-aligned movement and shooting.
- One-hit-kill traveling bullets with a fire cadence.
- Four primitives (cube, cone, donut, arch), each able to carry holes — gaps a bullet may
  cross but a player cannot (or both, as geometry dictates).
- Score-race match structure with rounds and a round time limit.
- Fixed tilted 3/4 camera.
- Integrated level editor with local save and JSON share.
- Predefined skin colors only (not importable, no patterns in v1).

### Out of scope (v1)

- Board/camera rotation — deferred (was discussed; removed to reduce scope).
- Server authority — deferred. The design keeps the simulation core portable so a server
  can replace the browser host later without rewriting game logic.
- Client-side prediction / rollback — clients render snapshots only.
- Teams, respawn deathmatch, power-ups, projectiles with varying height, destructible
  obstacles.
- Custom skin assets or patterns (colors only).

## 4. Units (architecture)

Each unit has one job and a well-defined interface.

| Unit | Responsibility | Depends on |
|---|---|---|
| **Simulation core (`sim`)** | Pure TypeScript. Owns game state, applies inputs per tick, emits events. No DOM, no three.js, no WebRTC. Deterministic. | nothing |
| **Session host** | Runs `sim`, ingests inputs from clients, broadcasts snapshots and events. v1 = the host's browser; later = a server process running the same `sim`. | sim |
| **Networking** | WebRTC data channels between host and peers, plus a thin stateless signaling service that maps the room code to the room. Never touches game state. | — |
| **Renderer** | three.js scene. Pure function of a state snapshot: plane, obstacles, players, bullets. | sim (read-only) |
| **Input** | Keyboard → normalized `{ moveDir, shoot }`. Holds no state. | — |
| **Editor** | Author maps; persist locally; JSON import/export. Shares primitive definitions with `sim`. | sim definitions |

`sim` exposes `step(state, inputs, dt) → { state, events }` and
`createGame(config, map) → state`. It is a pure, deterministic function of its inputs so
it can be unit-tested and later relocated to a server process unchanged.

## 5. Coordinate system and world units

- The board is a bounded rectangle in the horizontal X/Y plane; Z is "up" (visual only).
- Movement and shooting are axis-aligned; positions are continuous floating-point world
  units (pixel/sub-pixel accurate — no coarse grid).
- The only vertical distinction game logic makes is **bullet height `H`**; everything
  else is treated as floor-level (see Terms).

Defaults (tuning constants; refined in playtesting):

| Constant | Default | Meaning |
|---|---|---|
| `playerRadius` `R` | 0.5 | player's circle collision radius |
| `bulletHeight` `H` | 1.0 | height above the floor at which bullets travel |
| `playerSpeed` | 6 units/s | axis-aligned movement speed |
| `bulletSpeed` | 18 units/s | bullet travel speed (3× player) |
| `cadence` | 800 ms | minimum delay between shots |
| `targetScore` | 3 | round wins needed to win the match |
| `roundTime` | 60 s | after which a round is a draw |
| `maxPlayers` | 4 (cap 8) | players per room |
| `spawnSeparation` | 5 units | minimum distance between spawn points |
| `spawnEdgeMargin` | 2 units | min distance of a spawn point from board edges |

`H` is chosen so a bullet intersects the tomato's body (0 < `H` < player height), so any
bullet reaching a player's circle always kills.

## 6. Data model

```
State = {
  config,            // tuning table above + board bounds + maxPlayers
  phase,             // lobby | round | matchEnd (matchEnd = a player reached targetScore)
  roundNumber,
  scores: PlayerId → int,
  players: Player[],
  obstacles: Obstacle[],
  bullets: Bullet[],
}

Player  = { id, name, skinId, pos:{x,y}, facing, lastShotAt, alive, connected }
Bullet  = { id, ownerId, pos:{x,y}, dir }          // a point on the plane at bullet height H
Obstacle = { id, type, pos:{x,y}, ...params, groundShape, bulletShape }
```

- A player's `facing` is set by the latest non-idle movement, or a random direction at
  spawn. Shooting fires along `facing`; a player may shoot while moving.
- `groundShape` and `bulletShape` are 2D polygon regions, derived deterministically from
  `type + params` at load time. They are **data**, never computed per-tick.

## 7. Collision model

Collision queries run against the union of all obstacles' ground shapes (player movement)
and bullet shapes (bullets), plus circle tests for player-vs-player and bullet-vs-player.
All hand-rolled, deterministic, continuous — the axis constraint keeps each query to one
dimension:

- **Player movement**: swept circle-vs-polygon along the current direction; clamp to first
  contact. Also circle-vs-circle against other players (no overlap).
- **Bullet**: segment-vs-polygon from previous to new position along its direction; plus
  segment-vs-circle against each living player.
- **Bullet vs bullet**: no collision — they pass through each other.

### Primitive → cross-section table

| Primitive | Authoring params | Ground shape | Bullet shape |
|---|---|---|---|
| **cube** | footprint w×d, height h | full footprint | full footprint if `h > H`, else empty (**low wall**) |
| **cone** | base radius, height | full base disc | concentric disc of radius `base·(1 − H/height)` if height > H, else empty |
| **donut** | footprint, hole radius | full footprint | footprint minus central hole (hole = horizontal tunnel centered at H) |
| **arch** | footprint, door width, door height | two side pillars (central door gap) | footprint minus door gap if `doorHeight > H`, else full footprint (**low tunnel**) |

Emergent cases from these rules:

- **Low wall** (cube/cone with height ≤ H): blocks players, bullets fly over.
- **Low tunnel** (arch with `doorHeight ≤ H`): players walk under, bullets are blocked.
- "Arch big enough" = `doorWidth > 2R` (player) and `doorHeight > H` (bullet).
- "Hole big enough for a bullet" = the gap exists in the bullet shape at that column.

Nothing at runtime does mesh math; the editor computes the two shapes from params once.

## 8. Movement and input

- Input keys: **arrows** or **IJKL** = move, **Space** = shoot.
- Input is normalized: `moveDir ∈ {+X,−X,+Y,−Y, none}`, `shoot` is an edge (key-down),
  not held state.
- Movement is strictly axis-aligned and continuous; changing direction is an instantaneous
  90° switch between directions.
- Players cannot enter ground shape regions or overlap other players.

## 9. Shooting

- On `shoot` edge, if `now − lastShotAt ≥ cadence`, spawn a `Bullet` at the player's
  center (slightly forward along `facing`) moving at `bulletSpeed` along `facing`.
- The bullet travels until it (a) enters a bullet shape region, (b) intersects a living
  player's circle, or (c) exits the board bounds — in all cases the bullet is consumed.
- A bullet intersecting a living player kills that player (one-hit-kill) and is consumed.
- Firing uses the player's `facing` regardless of whether they are moving.

## 10. Death, rounds, and match

- **Round** = one life per player, last-man-standing wins.
- **Round win**: when exactly one player remains alive → that player scores `+1`, next
  round begins.
- **Round draw**: when `roundTime` elapses with 2+ players alive → nobody scores, next
  round begins (time limit is pure anti-stall).
- **Match win**: first player to reach `targetScore` round wins.
- **Spawns**: random with fairness each round — each spawn point is non-solid (not inside
  a ground shape), mutually separated by at least `spawnSeparation`, and pulled in from
  board edges by at least `spawnEdgeMargin`. Fairness is validated/rejected if infeasible
  (see Level editor).
- **Disconnect**: a disconnected player is inert (not a target) and cannot score; if a
  round can no longer produce a winner (all remaining alive players disconnected), it is
  resolved as a draw.

## 11. Rendering

- three.js, **fixed tilted 3/4 perspective camera** (fixed azimuth and polar angle, fixed
  distance). No rotation/zoom in v1.
- Scene built from each snapshot: ground plane sized to board bounds; one mesh per
  obstacle from its primitive type (box / cone / torus / box-with-cutout for arch);
  players = tomato sphere + skirt cone tinted by `skinId`; bullets = small sphere
  explicitly floating at bullet height `H` so the tilt makes hole-crossing visually true.
- Fixed lighting; subtle floor grid/hint for spatial reading. No post-processing in v1.
- Skins: a fixed, predefined palette of distinct colors (not user-importable, no patterns
  in v1). Uniqueness of `skinId` is enforced in the lobby. Skins are static client-side
  data; rendering only.

## 12. Networking

### Rooms and flow

1. Host: "Create game" → choose map + config → app requests a short room code (5–6 chars)
   from the signaling service.
2. Peers: "Join game" → enter code → signaling brokers WebRTC SDP/ICE between each peer
   and host.
3. Lobby: player list, skin choice, ready flags ride the snapshot channel as a distinct
   `phase`. Host starts the match when ready.
4. Play: host's `sim` is authoritative; peers render snapshots only.

### Authority and timing

- Host runs `sim` at a **60 Hz fixed timestep**. Snapshots broadcast at **30 Hz**.
- Clients **render snapshots only** — no client-side simulation and no prediction in v1.
  Client interpolates positions between snapshots for smoothness.
- Determinism requirement serves unit-testability and the later server-authority swap; it
  is not needed for client correctness because only the host simulates.

### Protocol

| Direction | Message | Channel |
|---|---|---|
| client → host | `{ type:'input', seq, moveDir, shoot }` | reliable, ordered |
| host → clients | `{ type:'snapshot', seq, state }` | unreliable, ordered |
| host → clients | `{ type:'event', kind }`, `kind ∈ {playerJoined, playerLeft, roundStart, roundEnd, matchEnd, hostLeft}` | reliable |

- Clients discard snapshots with `seq` older than the latest received.
- `shoot` as an edge guarantees no trigger is lost.

## 13. Level editor

- A separate mode of the same SPA, two panes: **2D top-down authoring surface** plus a
  **live 3D tilted preview**.
- Operations: place primitive, move (continuous, axis-aligned), resize (per-type params),
  delete; set board width/height.
- The two cross-sections are overlaid on the surface as the designer works, so holes are
  legible while authoring.
- Constraints: obstacles lie fully inside board bounds. Soft warnings: board too small or
  too blocked for N fair spawns; arch door too narrow for a player (legal, but flagged).
- Save: to local storage as a named preset → immediately available in the create-game map
  picker, no manual import.
- Share: JSON export (download) / import (file).

### Map JSON schema (versioned)

```json
{
  "version": 1,
  "board": { "width": 40.0, "height": 40.0 },
  "obstacles": [
    { "id": "o1", "type": "arch", "pos": { "x": 10.0, "y": 5.0 },
      "footprint": { "w": 3.0, "d": 1.0 }, "doorWidth": 1.5, "doorHeight": 1.5 }
  ]
}
```

Rules: only authoring params (`type`, `pos`, type-specific params) are stored; the two
shapes are derived on load (see Data model). Default board is 40×40 units.

## 14. Edge cases and error handling

- **Host leaves**: emit `hostLeft`; show notice; return to home. Accepted v1 tradeoff
  (server authority is the later fix).
- **No fair-spawn board**: editor blocks/warns at save; runtime falls back to edge-margin
  placement rather than hanging.
- **Shoot before any move**: use the spawn default facing.
- **Concurrent same-tick deaths**: all resolved in one tick, no ordering bias.
- **<2 connected peers**: host cannot start unless "practice" (solo) is selected.
- **Empty map**: valid; spawn fairness still applies on the open plane.
- **Bullet vs bullet**: no interaction.

## 15. Testing

- **`sim` (pure) unit tests**: movement clamped at polygon edges; swept collision;
  bullet-through-hole vs blocked; low-wall/low-tunnel derivation; single and concurrent
  deaths; round win/draw transitions; match-end; spawn fairness (non-solid, min
  separation); deterministic replay (same inputs → same state).
- **Editor**: map round-trip (`save → export → import` ⇒ identical params);
  shape-derivation correctness for all four primitives + emergent cases.
- **Networking**: two-tab smoke test — create code → join → shoot → death → round →
  match.
- **Rendering**: manual/visual smoke test (fixed camera, correct priming, bullet at `H`),
  not unit-tested.
