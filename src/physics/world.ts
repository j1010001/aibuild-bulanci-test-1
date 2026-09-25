// The authoritative 3D physics world: every collision question in the game (can this
// player move this far; does the gun fit; what does this bullet hit) is answered by a
// real Rapier query against real geometry — the same geometry the renderer draws
// (src/geometry/obstacleGeometry.ts) — never by a hand-derived 2D approximation.
//
// World axes: game (x, y_game) is the horizontal ground plane, mapped to Rapier/three.js
// (x, z); height is Rapier/three.js y. No gravity — this is a flat, axis-aligned arena,
// not a physical simulation of falling bodies; Rapier is used here purely for its
// robust convex/trimesh collision queries (shape-casting, ray-casting), not dynamics.

import type { Collider, Cuboid, RigidBody, World } from '@dimforge/rapier3d-compat';
import { buildObstacleGeometry } from '../geometry/obstacleGeometry';
import { addObstacleToWorld, groupsBitmask, OBSTACLE_COLLISION_GROUP, PLAYER_COLLISION_GROUP } from './obstacles';
import type { Rapier } from './rapier';
import type { Direction, MapDef, PlayerId, Vec2 } from '../sim/types';
import { DIR_VECTOR } from '../sim/types';

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
const SKIN = 0.001; // small safety margin so a shapecast's "safe" advance never ends in exact contact

function dirToVelocity(dir: Direction): { x: number; y: number; z: number } {
  const v = DIR_VECTOR[dir];
  return { x: v.x, y: 0, z: v.y };
}

export type BulletHit = { distance: number; hitPlayerId: PlayerId | null };

export class PhysicsWorld {
  private readonly RAPIER: Rapier;
  private readonly world: World;
  private readonly playerBodies = new Map<PlayerId, RigidBody>();
  private readonly playerColliders = new Map<PlayerId, Collider>();
  private readonly colliderOwner = new Map<number, PlayerId>(); // collider handle -> player id
  readonly playerRadius: number;
  readonly playerHeight: number;
  readonly board: { width: number; height: number };

  constructor(RAPIER: Rapier, map: MapDef, opts: { playerRadius: number; playerHeight: number }) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.playerRadius = opts.playerRadius;
    this.playerHeight = opts.playerHeight;
    this.board = { ...map.board };

    for (const def of map.obstacles) {
      const geometry = buildObstacleGeometry(def);
      addObstacleToWorld(RAPIER, this.world, geometry);
    }
    this.world.step(); // seed the query pipeline so casts/intersections see the obstacles immediately
  }

  addPlayer(id: PlayerId, pos: Vec2): void {
    const body = this.world.createRigidBody(
      this.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, this.playerHeight / 2, pos.y),
    );
    const collider = this.world.createCollider(
      this.RAPIER.ColliderDesc.cylinder(this.playerHeight / 2, this.playerRadius).setCollisionGroups(
        groupsBitmask(PLAYER_COLLISION_GROUP, 0xffff),
      ),
      body,
    );
    this.playerBodies.set(id, body);
    this.playerColliders.set(id, collider);
    this.colliderOwner.set(collider.handle, id);
    this.world.step();
  }

  removePlayer(id: PlayerId): void {
    const body = this.playerBodies.get(id);
    if (!body) return;
    const collider = this.playerColliders.get(id);
    if (collider) this.colliderOwner.delete(collider.handle);
    this.world.removeRigidBody(body);
    this.playerBodies.delete(id);
    this.playerColliders.delete(id);
  }

  /** Dead or disconnected players are inert (spec §10) — excluded from every query
   * (movement blocking, gun-fit, bullet hits) without removing their body/state. */
  setPlayerEnabled(id: PlayerId, enabled: boolean): void {
    const collider = this.playerColliders.get(id);
    if (collider) collider.setEnabled(enabled);
  }

  setPlayerPosition(id: PlayerId, pos: Vec2): void {
    const body = this.playerBodies.get(id);
    if (!body) return;
    body.setTranslation({ x: pos.x, y: this.playerHeight / 2, z: pos.y }, true);
    this.world.step();
  }

  getPlayerPosition(id: PlayerId): Vec2 {
    const body = this.playerBodies.get(id);
    if (!body) throw new Error(`PhysicsWorld: unknown player ${id}`);
    const t = body.translation();
    return { x: t.x, y: t.z };
  }

  /**
   * Sweeps the player's real cylinder AND its leading gun (spec §7: "the gun always
   * leads... movement clamps at the first contact of either the circle or the muzzle")
   * along `dir`; returns the distance actually clear to travel (0..distance).
   */
  moveDistance(id: PlayerId, dir: Direction, distance: number, muzzleOffset: number): number {
    if (distance <= 0) return 0;
    const body = this.playerBodies.get(id);
    const collider = this.playerColliders.get(id);
    if (!body || !collider) throw new Error(`PhysicsWorld: unknown player ${id}`);
    const pos = body.translation();
    const vel = dirToVelocity(dir);

    const bodyShape = new this.RAPIER.Cylinder(this.playerHeight / 2, this.playerRadius);
    const bodyHit = this.world.castShape(pos, IDENTITY_ROTATION, vel, bodyShape, 0, distance, true, undefined, undefined, collider);
    const bodyAdvance = bodyHit ? Math.max(0, bodyHit.time_of_impact - SKIN) : distance;

    const { shape: gunShape, center: gunCenter } = this.gunShapeAndCenter({ x: pos.x, y: pos.z }, dir, muzzleOffset);
    const gunHit = this.world.castShape(gunCenter, IDENTITY_ROTATION, vel, gunShape, 0, distance, true, undefined, undefined, collider);
    const gunAdvance = gunHit ? Math.max(0, gunHit.time_of_impact - SKIN) : distance;

    return Math.min(bodyAdvance, gunAdvance);
  }

  /** The gun as a thin box spanning playerRadius..muzzleOffset along `dir`, at the same
   * height range as the body (spec §7: "treated as floor-level, like the body"). Shared
   * by moveDistance (the gun leads the body when moving) and gunFits (turning). */
  private gunShapeAndCenter(pos: Vec2, dir: Direction, muzzleOffset: number): { shape: Cuboid; center: { x: number; y: number; z: number } } {
    const v = DIR_VECTOR[dir];
    const mid = (this.playerRadius + muzzleOffset) / 2;
    const halfLen = (muzzleOffset - this.playerRadius) / 2;
    const center = { x: pos.x + v.x * mid, y: this.playerHeight / 2, z: pos.y + v.y * mid };
    const shape =
      dir === '+X' || dir === '-X'
        ? new this.RAPIER.Cuboid(halfLen, this.playerHeight / 2, 0.05)
        : new this.RAPIER.Cuboid(0.05, this.playerHeight / 2, halfLen);
    return { shape, center };
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
   * Would the gun fit facing `dir` from `pos`? Modeled as a thin box spanning
   * playerRadius..muzzleOffset along `dir`, at the SAME height range as the body (spec
   * §7: "the gun is part of the player's body for collision... treated as floor-level"),
   * so it is blocked by exactly the same real geometry the body is, excluding the
   * player's own collider and board bounds (checked separately by the caller).
   */
  gunFits(id: PlayerId, pos: Vec2, dir: Direction, muzzleOffset: number): boolean {
    const collider = this.playerColliders.get(id);
    const { shape, center } = this.gunShapeAndCenter(pos, dir, muzzleOffset);
    const hit = this.world.intersectionWithShape(center, IDENTITY_ROTATION, shape, undefined, undefined, collider);
    return hit === null;
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
    const hit = this.world.castRay(ray, Math.max(0, distance - SKIN), true);
    if (!hit) return null;
    const hitPlayerId = this.colliderOwner.get(hit.collider.handle) ?? null;
    return { distance: hit.timeOfImpact + SKIN, hitPlayerId };
  }

  /** Is a player-sized circle at `pos` free of every obstacle (used for spawn placement)? */
  isFreeOfObstacles(pos: Vec2): boolean {
    const shape = new this.RAPIER.Cylinder(this.playerHeight / 2, this.playerRadius);
    const center = { x: pos.x, y: this.playerHeight / 2, z: pos.y };
    const hit = this.world.intersectionWithShape(
      center,
      IDENTITY_ROTATION,
      shape,
      undefined,
      groupsBitmask(0xffff, OBSTACLE_COLLISION_GROUP),
    );
    return hit === null;
  }

  dispose(): void {
    this.world.free();
  }
}
