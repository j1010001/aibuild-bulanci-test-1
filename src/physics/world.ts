// The authoritative 3D physics world: every collision question in the game (can this
// player move this far; does the gun fit; what does this bullet hit) is answered by a
// real Rapier query against real geometry — the same geometry the renderer draws
// (src/geometry/obstacleGeometry.ts) — never by a hand-derived 2D approximation.
//
// World axes: game (x, y_game) is the horizontal ground plane, mapped to Rapier/three.js
// (x, z); height is Rapier/three.js y. No gravity — this is a flat, axis-aligned arena,
// not a physical simulation of falling bodies; Rapier is used here purely for its
// robust convex/trimesh collision queries (shape-casting, ray-casting), not dynamics.

import type { Collider, RigidBody, Shape, World } from '@dimforge/rapier3d-compat';
import { buildObstacleGeometry } from '../geometry/obstacleGeometry';
import { buildPlayerGeometry, orientPart as orient, type ConvexPart, type PlayerGeometry, type PlayerShapeConfig } from '../geometry/playerGeometry';
import {
  addObstacleToWorld,
  buildColliderDesc,
  groupsBitmask,
  GUN_COLLISION_GROUP,
  OBSTACLE_COLLISION_GROUP,
  PLAYER_COLLISION_GROUP,
} from './obstacles';
import type { Rapier } from './rapier';
import type { Direction, MapDef, PlayerId, Vec2 } from '../sim/types';
import { DIR_VECTOR } from '../sim/types';

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
const SKIN = 0.001; // small safety margin so a shapecast's "safe" advance never ends in exact contact

// What each query tests against (collision-group filters). Guns are colliders so that a
// body stops against another player's gun (what you see is what's solid), but bullets
// pass through guns and guns are never checked against other guns (spec §7).
const BODY_QUERY = groupsBitmask(0xffff, OBSTACLE_COLLISION_GROUP | PLAYER_COLLISION_GROUP | GUN_COLLISION_GROUP);
const GUN_QUERY = groupsBitmask(0xffff, OBSTACLE_COLLISION_GROUP | PLAYER_COLLISION_GROUP);
const BULLET_QUERY = GUN_QUERY;

type Vec3 = { x: number; y: number; z: number };

function dirToVelocity(dir: Direction): Vec3 {
  const v = DIR_VECTOR[dir];
  return { x: v.x, y: 0, z: v.y };
}

export type BulletHit = { distance: number; hitPlayerId: PlayerId | null };

export class PhysicsWorld {
  private readonly RAPIER: Rapier;
  private readonly world: World;
  private readonly shape: PlayerGeometry;
  private readonly playerBodies = new Map<PlayerId, RigidBody>();
  private readonly playerColliders = new Map<PlayerId, Collider[]>();
  private readonly playerGuns = new Map<PlayerId, { facing: Direction; colliders: Collider[] }>();
  private readonly playerEnabled = new Map<PlayerId, boolean>();
  private readonly colliderOwner = new Map<number, PlayerId>(); // collider handle -> player id
  readonly board: { width: number; height: number };

  /** `player` is the player shape config; the shape itself comes from buildPlayerGeometry. */
  constructor(RAPIER: Rapier, map: MapDef, player: PlayerShapeConfig) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.shape = buildPlayerGeometry(player);
    this.board = { ...map.board };

    for (const def of map.obstacles) {
      const geometry = buildObstacleGeometry(def);
      addObstacleToWorld(RAPIER, this.world, geometry);
    }
    this.world.step(); // seed the query pipeline so casts/intersections see the obstacles immediately
  }

  addPlayer(id: PlayerId, pos: Vec2): void {
    // The body's origin is the player's footprint center on the ground; each body part is
    // a collider at its local offset. The gun's colliders are rebuilt whenever the facing
    // changes (setPlayerFacing); they start facing +X, as createGame does.
    const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, 0, pos.y));
    const colliders = this.shape.body.map(({ part }) =>
      this.world.createCollider(buildColliderDesc(this.RAPIER, part).setCollisionGroups(groupsBitmask(PLAYER_COLLISION_GROUP, 0xffff)), body),
    );
    this.playerBodies.set(id, body);
    this.playerColliders.set(id, colliders);
    this.playerEnabled.set(id, true);
    for (const c of colliders) this.colliderOwner.set(c.handle, id);
    this.playerGuns.set(id, { facing: '+X', colliders: this.createGunColliders(body, '+X') });
    this.world.step();
  }

  /** Turns the player's gun collider to `dir` (a no-op when it already faces that way). */
  setPlayerFacing(id: PlayerId, dir: Direction): void {
    const body = this.playerBodies.get(id);
    const gun = this.playerGuns.get(id);
    if (!body || !gun || gun.facing === dir) return;
    for (const c of gun.colliders) this.world.removeCollider(c, false);
    const colliders = this.createGunColliders(body, dir);
    for (const c of colliders) c.setEnabled(this.playerEnabled.get(id) ?? true);
    this.playerGuns.set(id, { facing: dir, colliders });
    this.world.step();
  }

  private createGunColliders(body: RigidBody, dir: Direction): Collider[] {
    return this.shape.gun.map(({ part }) =>
      this.world.createCollider(
        buildColliderDesc(this.RAPIER, orient(part, dir).part).setCollisionGroups(groupsBitmask(GUN_COLLISION_GROUP, 0xffff)),
        body,
      ),
    );
  }

  removePlayer(id: PlayerId): void {
    const body = this.playerBodies.get(id);
    if (!body) return;
    for (const c of this.playerColliders.get(id) ?? []) this.colliderOwner.delete(c.handle);
    this.world.removeRigidBody(body); // also removes its body and gun colliders
    this.playerBodies.delete(id);
    this.playerColliders.delete(id);
    this.playerGuns.delete(id);
    this.playerEnabled.delete(id);
  }

  /** Dead or disconnected players are inert (spec §10) — excluded from every query
   * (movement blocking, gun-fit, bullet hits) without removing their body/state. */
  setPlayerEnabled(id: PlayerId, enabled: boolean): void {
    for (const c of [...(this.playerColliders.get(id) ?? []), ...(this.playerGuns.get(id)?.colliders ?? [])]) c.setEnabled(enabled);
    this.playerEnabled.set(id, enabled);
    this.world.step(); // queries only see the change once the query pipeline is updated
  }

  setPlayerPosition(id: PlayerId, pos: Vec2): void {
    const body = this.playerBodies.get(id);
    if (!body) return;
    body.setTranslation({ x: pos.x, y: 0, z: pos.y }, true);
    this.world.step();
  }

  getPlayerPosition(id: PlayerId): Vec2 {
    const body = this.playerBodies.get(id);
    if (!body) throw new Error(`PhysicsWorld: unknown player ${id}`);
    const t = body.translation();
    return { x: t.x, y: t.z };
  }

  /**
   * Sweeps every part of the player — body and the gun, facing `dir` — along `dir` and
   * returns the distance clear to travel (0..distance): movement clamps at the first
   * contact of any part (spec §7). Since the muzzle reaches past the body, the gun leads
   * wherever something stands at gun height; over a low wall, the body is what stops.
   * The body stops against other players' guns too; the gun ignores other guns.
   */
  moveDistance(id: PlayerId, dir: Direction, distance: number): number {
    if (distance <= 0) return 0;
    const body = this.requireBody(id);
    const pos = body.translation();
    const vel = dirToVelocity(dir);
    let advance = distance;
    const parts = [...this.shape.body.map((p) => ({ ...p, query: BODY_QUERY })), ...this.shape.gun.map((p) => ({ ...p, query: GUN_QUERY }))];
    for (const { part, query } of parts) {
      const o = orient(part, dir);
      const center = { x: pos.x + o.offset.x, y: o.offset.y, z: pos.z + o.offset.z };
      const hit = this.world.castShape(center, IDENTITY_ROTATION, vel, this.rapierShape(o.part), 0, distance, true, undefined, query, undefined, body);
      if (hit) advance = Math.min(advance, Math.max(0, hit.time_of_impact - SKIN));
    }
    return advance;
  }

  /** Applies a movement of `distance` along `dir` (caller has already clamped it via moveDistance). */
  applyMove(id: PlayerId, dir: Direction, distance: number): void {
    if (distance <= 0) return;
    const body = this.playerBodies.get(id);
    if (!body) return;
    const pos = body.translation();
    const vel = dirToVelocity(dir);
    body.setTranslation({ x: pos.x + vel.x * distance, y: pos.y, z: pos.z + vel.z * distance }, true);
    this.world.step();
  }

  /**
   * Would the player fit facing `dir` at `pos` — i.e. does the gun, turned that way, overlap
   * nothing (any obstacle or another player's body)? The player's own colliders are
   * excluded; board bounds are checked separately by the caller.
   */
  gunFits(id: PlayerId, pos: Vec2, dir: Direction): boolean {
    const body = this.playerBodies.get(id);
    return this.shape.gun.every(({ part }) => {
      const o = orient(part, dir);
      const center = { x: pos.x + o.offset.x, y: o.offset.y, z: pos.y + o.offset.z };
      return this.world.intersectionWithShape(center, IDENTITY_ROTATION, this.rapierShape(o.part), undefined, GUN_QUERY, undefined, body) === null;
    });
  }

  /**
   * Casts a bullet ray at fixed height `bulletHeight` from `startPos` along `dir` for
   * `distance`. Returns the earliest thing hit (obstacle or a living player, whichever
   * is closer) or null if nothing is hit within `distance`. Deliberately does NOT
   * exclude the shooter's own collider — spec §9 requires no ownerId special case in
   * the hit test, only geometry: `startPos` is already the edge of the shooter's own
   * circle (see step.ts), so it's nudged forward by an epsilon here purely to resolve
   * the "is a point exactly on the boundary inside or outside" ambiguity a solid
   * raycast would otherwise hit against its own origin collider — not to grant
   * immunity. A bullet whose path genuinely re-enters its owner (see the "no
   * owner-immunity" test) is still hit normally.
   */
  raycastBullet(startPos: Vec2, dir: Direction, distance: number, bulletHeight: number): BulletHit | null {
    const v = DIR_VECTOR[dir];
    const nudged = { x: startPos.x + v.x * SKIN, y: startPos.y + v.y * SKIN };
    const ray = new this.RAPIER.Ray({ x: nudged.x, y: bulletHeight, z: nudged.y }, { x: v.x, y: 0, z: v.y });
    const hit = this.world.castRay(ray, Math.max(0, distance - SKIN), true, undefined, BULLET_QUERY);
    if (!hit) return null;
    const hitPlayerId = this.colliderOwner.get(hit.collider.handle) ?? null;
    return { distance: hit.timeOfImpact + SKIN, hitPlayerId };
  }

  /** Is a player's body at `pos` clear of every obstacle (used for spawn placement)? */
  isFreeOfObstacles(pos: Vec2): boolean {
    return this.shape.body.every(({ part }) => {
      const o = orient(part, '+Y');
      const center = { x: pos.x + o.offset.x, y: o.offset.y, z: pos.y + o.offset.z };
      return (
        this.world.intersectionWithShape(center, IDENTITY_ROTATION, this.rapierShape(o.part), undefined, groupsBitmask(0xffff, OBSTACLE_COLLISION_GROUP)) === null
      );
    });
  }

  private requireBody(id: PlayerId): RigidBody {
    const body = this.playerBodies.get(id);
    if (!body) throw new Error(`PhysicsWorld: unknown player ${id}`);
    return body;
  }

  private rapierShape(part: ConvexPart): Shape {
    if (part.kind === 'box') return new this.RAPIER.Cuboid(part.width / 2, part.height / 2, part.depth / 2);
    if (part.kind === 'cylinder') return new this.RAPIER.Cylinder(part.height / 2, part.radius);
    return new this.RAPIER.Cone(part.height / 2, part.radius);
  }

  dispose(): void {
    this.world.free();
  }
}
