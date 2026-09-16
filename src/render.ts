// Three.js render bootstrap. Walking skeleton: empty scene with a floor plane,
// fixed tilted 3/4 camera per game spec §11.
//
// Renderer is a pure function of a state snapshot; gameplay issues extend
// `renderState` to draw players, obstacles, and bullets. The skeleton only
// proves the canvas paints something non-blank so verify.sh's pixel check
// passes.

import * as THREE from "three";
import type { State } from "./sim/state";

export interface Renderer {
  update(state: State): void;
  dispose(): void;
}

export function mountRenderer(container: HTMLElement): Renderer {
  const width = container.clientWidth;
  const height = container.clientHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121a2c);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
  // Fixed tilted 3/4 camera; angles will be tuned per game spec §11.
  camera.position.set(20, 20, 20);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const boardSize = 40;
  const floorGeom = new THREE.PlaneGeometry(boardSize, boardSize, 8, 8);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a3554, wireframe: false });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(boardSize, boardSize, 0x4a5a80, 0x1e2a44);
  scene.add(grid);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  const directional = new THREE.DirectionalLight(0xffffff, 0.8);
  directional.position.set(10, 20, 10);
  scene.add(ambient, directional);

  const onResize = (): void => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);

  let running = true;
  let rafId: number | null = null;
  const tick = (): void => {
    if (!running) return;
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return {
    update(_state: State) {
      // Skeleton: nothing to draw beyond the floor yet.
    },
    dispose() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      floorGeom.dispose();
      floorMat.dispose();
      container.removeChild(renderer.domElement);
    },
  };
}
