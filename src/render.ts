// three.js renderer: a pure function of a state snapshot (spec §11). Read-only — never
// mutates sim state, never drives input. Fixed tilted camera; only distance (zoom) is
// computed, to frame the board without clipping (acceptance criteria in §11).
//
// Every obstacle mesh is built from buildObstacleGeometry (src/geometry) — the exact
// same box/cone/trimesh data physics/obstacles.ts turns into Rapier colliders. There is
// no separate "how big should this look" computation anywhere in this file.

import * as THREE from 'three';
import { AZIMUTH, computeCameraBasis, POLAR_FROM_VERTICAL } from './camera';
import { buildObstacleGeometry } from './geometry/obstacleGeometry';
import { buildPlayerGeometry, type PlayerShapeConfig } from './geometry/playerGeometry';
import type { BoxSpec, ConeSpec, PartSpec, TrimeshSpec } from './geometry/obstacleGeometry';
import type { RenderState } from './client/model';
import type { CubeParams, DonutParams, ObstacleDef, Player } from './sim';
import { DIR_VECTOR } from './sim';

const VFOV_DEG = 45;
const SOLID_COLOR = 0x8a6d3b; // solid to bullets (or: always solid, for plain terrain)
const POROUS_COLOR = 0x5a7a8a; // bullets pass over/through (low wall, blocked-looking variants)

// A bullet collides as a point (a ray at bullet height), so it is drawn as a thin tracer:
// its tip is the bullet's position and a short streak trails behind along its path.
// One geometry + material is shared by every bullet (they come and go many times a second).
const TRACER_LENGTH = 0.6;
const BULLET_GEOMETRY = new THREE.BoxGeometry(0.04, 0.04, TRACER_LENGTH).translate(0, 0, -TRACER_LENGTH / 2);
const BULLET_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xfff3b0 });
const DRESS_COLOR = 0x2f7a3d;
const GUN_COLOR = 0x333333;

/** Frees the GPU buffers of everything under `root` (removing from the scene alone does not). */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      if (obj.geometry !== BULLET_GEOMETRY) obj.geometry.dispose();
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) if (m !== BULLET_MATERIAL) m.dispose();
    } else if (obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
}

function facingAngle(dir: keyof typeof DIR_VECTOR): number {
  const v = DIR_VECTOR[dir];
  return Math.atan2(v.x, v.y); // three.js Y-axis rotation, world (x,y) -> three (x,z)
}

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;

  private cameraDir = new THREE.Vector3(0, 1, 0);
  private cameraTarget = new THREE.Vector3();
  private boardSize = { width: 40, height: 40 };

  private playerGroups = new Map<string, THREE.Group>();
  private bulletMeshes = new Map<string, THREE.Mesh>();
  private obstacleGroup = new THREE.Group();
  private loadedObstacleSignature = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(VFOV_DEG, 1, 0.1, 1000);
    this.scene.add(this.obstacleGroup);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(10, 20, 6);
    this.scene.add(ambient, sun);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applyCameraFraming();
  }

  private applyCameraFraming(): void {
    const { width, height } = this.boardSize;
    const { forward, right, up } = computeCameraBasis(AZIMUTH, POLAR_FROM_VERTICAL);

    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const tanV = Math.tan(vFov / 2);
    const tanH = tanV * this.camera.aspect;

    const target = new THREE.Vector3(width / 2, 0, height / 2);
    const corners = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(width, 0, 0),
      new THREE.Vector3(0, 0, height),
      new THREE.Vector3(width, 0, height),
    ];

    let minD = 0.5;
    for (const c of corners) {
      const rel = c.clone().sub(target);
      const depth0 = rel.dot(forward);
      const rightComp = rel.dot(right);
      const upComp = rel.dot(up);
      const dH = Math.abs(rightComp) / tanH - depth0;
      const dV = Math.abs(upComp) / tanV - depth0;
      minD = Math.max(minD, dH, dV);
    }
    const distance = minD * 1.01; // tiny safety margin against float/edge clipping

    this.cameraDir = forward.clone().negate();
    this.cameraTarget = target;
    this.camera.position.copy(target).addScaledVector(this.cameraDir, distance);
    this.camera.lookAt(target);
  }

  /** Rebuilds ground + obstacle meshes and reframes the camera. Cheap to call on map load. */
  loadMap(state: RenderState): void {
    const sig = `${state.config.board.width}x${state.config.board.height}:${state.obstacles.map((o) => o.id).join(',')}`;
    if (sig === this.loadedObstacleSignature) return;
    this.loadedObstacleSignature = sig;

    this.boardSize = { ...state.config.board };
    for (const child of [...this.obstacleGroup.children]) {
      this.obstacleGroup.remove(child);
      disposeTree(child);
    }

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(state.config.board.width, state.config.board.height),
      new THREE.MeshStandardMaterial({ color: 0x2b3542 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(state.config.board.width / 2, 0, state.config.board.height / 2);
    this.obstacleGroup.add(ground);

    const grid = new THREE.GridHelper(
      Math.max(state.config.board.width, state.config.board.height),
      Math.max(state.config.board.width, state.config.board.height),
      0x475363,
      0x3a4552,
    );
    grid.position.set(state.config.board.width / 2, 0.01, state.config.board.height / 2);
    this.obstacleGroup.add(grid);

    for (const o of state.obstacles) this.obstacleGroup.add(buildObstacleMesh(o, state.config.bulletHeight));

    this.applyCameraFraming();
  }

  render(state: RenderState): void {
    this.loadMap(state);
    this.syncPlayers(state);
    this.syncBullets(state);
    this.renderer.render(this.scene, this.camera);
  }

  private syncPlayers(state: RenderState): void {
    const seen = new Set<string>();
    for (const p of state.players) {
      seen.add(p.id);
      let group = this.playerGroups.get(p.id);
      if (!group) {
        group = buildPlayerMesh(state.config);
        this.playerGroups.set(p.id, group);
        this.scene.add(group);
      }
      group.visible = p.alive && p.connected;
      group.position.set(p.pos.x, 0, p.pos.y);
      group.rotation.y = facingAngle(p.facing);
      (group.userData.skin as THREE.MeshStandardMaterial).color.set(p.skinId);
    }
    for (const [id, group] of this.playerGroups) {
      if (!seen.has(id)) {
        this.scene.remove(group);
        disposeTree(group);
        this.playerGroups.delete(id);
      }
    }
  }

  private syncBullets(state: RenderState): void {
    const seen = new Set<string>();
    for (const b of state.bullets) {
      seen.add(b.id);
      let mesh = this.bulletMeshes.get(b.id);
      if (!mesh) {
        mesh = new THREE.Mesh(BULLET_GEOMETRY, BULLET_MATERIAL);
        this.bulletMeshes.set(b.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(b.pos.x, state.config.bulletHeight, b.pos.y);
      mesh.rotation.y = facingAngle(b.dir); // the streak trails behind the tip, along the path
    }
    for (const [id, mesh] of this.bulletMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.bulletMeshes.delete(id);
      }
    }
  }
}

/** Exported for testing: the player drawn from exactly the parts the physics world
 * collides with (buildPlayerGeometry), in the player's local frame facing +Z. */
export function buildPlayerMesh(config: PlayerShapeConfig): THREE.Group {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xffffff }); // tinted per player each frame
  const materials = {
    skin,
    dress: new THREE.MeshStandardMaterial({ color: DRESS_COLOR }),
    gun: new THREE.MeshStandardMaterial({ color: GUN_COLOR }),
  };
  const g = buildPlayerGeometry(config);
  for (const { part, role } of [...g.body, ...g.gun]) group.add(meshFromPart(part, materials[role]));
  group.userData.skin = skin;
  return group;
}

function meshFromPart(part: PartSpec, material: THREE.Material): THREE.Mesh {
  const geometry =
    part.kind === 'box'
      ? new THREE.BoxGeometry(part.width, part.height, part.depth)
      : part.kind === 'cone'
        ? new THREE.ConeGeometry(part.radius, part.height, 24)
        : part.kind === 'cylinder'
          ? new THREE.CylinderGeometry(part.radius, part.radius, part.height, 24)
          : part.geometry;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(part.center.x, part.center.y, part.center.z);
  if (part.kind === 'trimesh') {
    mesh.rotation.x = part.rotationX;
    mesh.rotation.y = part.rotationY;
  }
  return mesh;
}

/** Exported for testing: pure three.js object construction (no canvas/WebGL needed to
 * inspect it), so "render == physics collider, exactly" is checkable directly. */
export function buildObstacleMesh(def: ObstacleDef, bulletHeight: number): THREE.Object3D {
  const geometry = buildObstacleGeometry(def);

  if (def.type === 'cube') {
    const p = def.params as CubeParams;
    const color = p.h > bulletHeight ? SOLID_COLOR : POROUS_COLOR;
    return meshFromPart(geometry.parts[0]!, new THREE.MeshStandardMaterial({ color }));
  }

  if (def.type === 'cone') {
    return meshFromPart(geometry.parts[0]!, new THREE.MeshStandardMaterial({ color: SOLID_COLOR }));
  }

  if (def.type === 'donut') {
    const p = def.params as DonutParams;
    const acrossExtent = p.axis === 'x' ? p.d : p.w;
    const hubHeight = acrossExtent / 2;
    // Cosmetic only — actual collision comes from the real mesh regardless of this
    // color choice; this just hints at whether the hole spans bulletHeight.
    const shootable = hubHeight - p.holeRadius <= bulletHeight && bulletHeight <= hubHeight + p.holeRadius;
    const color = shootable ? SOLID_COLOR : 0xa04040;
    return meshFromPart(geometry.parts[0]! as TrimeshSpec, new THREE.MeshStandardMaterial({ color }));
  }

  // arch — pillars and the lintel render with the same opaque material. There is no
  // configuration where the lintel is solid to a bullet but not a player (that would
  // need doorHeight <= bulletHeight < playerHeight <= doorHeight, impossible since
  // bulletHeight < playerHeight always, spec §7): whenever doorHeight < playerHeight
  // the lintel genuinely blocks the player's real body (low slot and closed cases
  // alike), and whenever doorHeight >= playerHeight it sits entirely above the
  // player's rendered height and is never reached at all. Either way it's exactly as
  // solid as it looks — nothing here to signal as translucent.
  const solidMat = new THREE.MeshStandardMaterial({ color: SOLID_COLOR });
  const group = new THREE.Group();
  for (const part of geometry.parts) {
    group.add(meshFromPart(part as BoxSpec, solidMat));
  }
  return group;
}

export function playerColorOf(p: Player): string {
  return p.skinId;
}
