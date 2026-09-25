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
import type { BoxSpec, ConeSpec, PartSpec, TrimeshSpec } from './geometry/obstacleGeometry';
import type { CubeParams, DonutParams, ObstacleDef, Player, PublicState } from './sim';
import { DIR_VECTOR } from './sim';

const VFOV_DEG = 45;
const SOLID_COLOR = 0x8a6d3b; // solid to bullets (or: always solid, for plain terrain)
const POROUS_COLOR = 0x5a7a8a; // bullets pass over/through (low wall, blocked-looking variants)

function facingAngle(dir: keyof typeof DIR_VECTOR): number {
  const v = DIR_VECTOR[dir];
  return Math.atan2(v.x, v.y); // three.js Y-axis rotation, world (x,y) -> three (x,z)
}

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private hud: HTMLElement | null;

  private cameraDir = new THREE.Vector3(0, 1, 0);
  private cameraTarget = new THREE.Vector3();
  private boardSize = { width: 40, height: 40 };

  private playerGroups = new Map<string, THREE.Group>();
  private bulletMeshes = new Map<string, THREE.Mesh>();
  private obstacleGroup = new THREE.Group();
  private loadedObstacleSignature = '';

  constructor(canvas: HTMLCanvasElement, hud: HTMLElement | null) {
    this.canvas = canvas;
    this.hud = hud;
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
  loadMap(state: PublicState): void {
    const sig = `${state.config.board.width}x${state.config.board.height}:${state.obstacles.map((o) => o.id).join(',')}`;
    if (sig === this.loadedObstacleSignature) return;
    this.loadedObstacleSignature = sig;

    this.boardSize = { ...state.config.board };
    while (this.obstacleGroup.children.length) this.obstacleGroup.remove(this.obstacleGroup.children[0]!);

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

  render(state: PublicState): void {
    this.loadMap(state);
    this.syncPlayers(state);
    this.syncBullets(state);
    this.renderer.render(this.scene, this.camera);
    if (this.hud) this.hud.textContent = buildHud(state);
  }

  private syncPlayers(state: PublicState): void {
    const seen = new Set<string>();
    for (const p of state.players) {
      seen.add(p.id);
      let group = this.playerGroups.get(p.id);
      if (!group) {
        group = buildPlayerGroup(state.config.muzzleOffset, state.config.playerRadius, state.config.playerHeight, state.config.bulletHeight);
        this.playerGroups.set(p.id, group);
        this.scene.add(group);
      }
      group.visible = p.alive && p.connected;
      group.position.set(p.pos.x, 0, p.pos.y);
      group.rotation.y = facingAngle(p.facing);
      const body = group.userData.body as THREE.Mesh;
      const mat = body.material as THREE.MeshStandardMaterial;
      mat.color.set(p.skinId);
    }
    for (const [id, group] of this.playerGroups) {
      if (!seen.has(id)) {
        this.scene.remove(group);
        this.playerGroups.delete(id);
      }
    }
  }

  private syncBullets(state: PublicState): void {
    const seen = new Set<string>();
    for (const b of state.bullets) {
      seen.add(b.id);
      let mesh = this.bulletMeshes.get(b.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.15, 12, 12),
          new THREE.MeshStandardMaterial({ color: 0xfff3b0, emissive: 0x554400 }),
        );
        this.bulletMeshes.set(b.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(b.pos.x, state.config.bulletHeight, b.pos.y);
    }
    for (const [id, mesh] of this.bulletMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.bulletMeshes.delete(id);
      }
    }
  }
}

function buildHud(state: PublicState): string {
  const lines = [`round ${state.roundNumber}  phase:${state.phase}${state.winnerId ? `  winner:${state.winnerId}` : ''}`];
  for (const p of state.players) {
    const status = !p.connected ? 'disconnected' : p.alive ? 'alive' : 'dead';
    lines.push(`${p.name.padEnd(10)} score:${state.scores[p.id] ?? 0}  ${status}  facing:${p.facing}`);
  }
  return lines.join('\n');
}

function buildPlayerGroup(muzzleOffset: number, playerRadius: number, playerHeight: number, bulletHeight: number): THREE.Group {
  const group = new THREE.Group();

  // A tomato-ish body approximating the real collision cylinder's height, not an
  // independently-chosen size — see spec §11's rendering-fidelity rule.
  const bodyRadius = Math.min(playerRadius * 0.9, playerHeight * 0.45);
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(bodyRadius, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  );
  body.position.y = playerHeight - bodyRadius;
  group.add(body);
  group.userData.body = body;

  const skirt = new THREE.Mesh(
    new THREE.ConeGeometry(playerRadius, Math.max(0.1, playerHeight - bodyRadius), 16),
    new THREE.MeshStandardMaterial({ color: 0x2f7a3d }),
  );
  skirt.position.y = (playerHeight - bodyRadius) / 2;
  group.add(skirt);

  const gunLength = Math.max(0.05, muzzleOffset - playerRadius);
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.08, gunLength),
    new THREE.MeshStandardMaterial({ color: 0x333333 }),
  );
  gun.position.set(0, Math.min(bulletHeight, playerHeight * 0.9), playerRadius + gunLength / 2);
  group.add(gun);

  return group;
}

function meshFromPart(part: PartSpec, material: THREE.Material): THREE.Mesh {
  const geometry =
    part.kind === 'box'
      ? new THREE.BoxGeometry(part.width, part.height, part.depth)
      : part.kind === 'cone'
        ? new THREE.ConeGeometry(part.radius, part.height, 24)
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
