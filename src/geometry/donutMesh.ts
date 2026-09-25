// The one place a donut's vertex data is generated. render.ts (the visual mesh) and
// physics/obstacles.ts (the Rapier trimesh collider) both call this and both get the
// literal same THREE.BufferGeometry — there is no second, independently-sized
// representation of a donut anywhere in the codebase, which is the whole point: what a
// player sees and what they collide with cannot drift apart, because they're the same
// vertex buffer, not two things kept in sync by hand.
//
// Modeled as a "washer": a short cylinder of outerRadius = hubHeight (spec §7: the
// wheel rests on the ground, so its radius is its own hub height) with a concentric
// cylindrical hole of holeRadius drilled through it along the local Z axis, extruded to
// exactly the authored along-axis thickness. A mathematically round-tubed torus was
// tried first and rejected: matching an authored thickness that's large relative to the
// hole's rim width requires a non-uniform scale so extreme it produces a degenerate,
// unreliable collision mesh (confirmed while investigating a real bug — see git
// history). A washer has no such failure mode at any radius/thickness ratio, because
// its wall is a literal straight cylinder, not a scaled circular tube.

import * as THREE from 'three';

const SEGMENTS = 32;

export function buildDonutGeometry(hubHeight: number, holeRadius: number, alongExtent: number): THREE.BufferGeometry {
  const outerR = hubHeight;
  const innerR = holeRadius;
  const halfH = alongExtent / 2;

  const positions: number[] = [];
  let nextIndex = 0;
  function vertex(x: number, y: number, z: number): number {
    positions.push(x, y, z);
    return nextIndex++;
  }

  const outerBottom: number[] = [];
  const outerTop: number[] = [];
  const innerBottom: number[] = [];
  const innerTop: number[] = [];

  for (let i = 0; i < SEGMENTS; i++) {
    const theta = (i / SEGMENTS) * Math.PI * 2;
    const cx = Math.cos(theta);
    const cy = Math.sin(theta);
    outerBottom.push(vertex(outerR * cx, outerR * cy, -halfH));
    outerTop.push(vertex(outerR * cx, outerR * cy, halfH));
    innerBottom.push(vertex(innerR * cx, innerR * cy, -halfH));
    innerTop.push(vertex(innerR * cx, innerR * cy, halfH));
  }

  const indices: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const j = (i + 1) % SEGMENTS;

    // Outer wall — normal faces outward (away from the local Z axis).
    indices.push(outerBottom[i]!, outerBottom[j]!, outerTop[j]!);
    indices.push(outerBottom[i]!, outerTop[j]!, outerTop[i]!);

    // Inner wall (the hole's surface) — normal faces inward, opposite winding to outer.
    indices.push(innerBottom[i]!, innerTop[j]!, innerBottom[j]!);
    indices.push(innerBottom[i]!, innerTop[i]!, innerTop[j]!);

    // Top annular cap (z = +halfH) — normal faces +Z.
    indices.push(outerTop[i]!, outerTop[j]!, innerTop[j]!);
    indices.push(outerTop[i]!, innerTop[j]!, innerTop[i]!);

    // Bottom annular cap (z = -halfH) — normal faces -Z, opposite winding to the top cap.
    indices.push(outerBottom[i]!, innerBottom[j]!, outerBottom[j]!);
    indices.push(outerBottom[i]!, innerBottom[i]!, innerBottom[j]!);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
