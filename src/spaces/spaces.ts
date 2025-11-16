import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'

export type SpaceKind = "euclidean" | "torus" | "hyperbolic";

export interface SpaceAPI {
  update: (
    camera: THREE.PerspectiveCamera,
    controls: PointerLockControls,
    inputDir: THREE.Vector3,
    dt: number
  ) => void;
  dispose: () => void;
}

// ---------- Helpers ----------
function makeRoom(size = 10) {
  const g = new THREE.BoxGeometry(size, size, size);
  const m = new THREE.MeshStandardMaterial({
    color: 0x152238,
    side: THREE.BackSide,
    roughness: 0.9,
  });
  const room = new THREE.Mesh(g, m);
  room.position.set(0, size / 2, 0);
  return room;
}

function addReference(scene: THREE.Scene) {
  const grid = new THREE.GridHelper(20, 20, 0x5472d3, 0x203060);
  grid.position.y = 0;
  scene.add(grid);

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b })
  );
  box.position.set(0, 0.5, -3);
  scene.add(box);
}

// ---------- Euclidean ----------
export function createEuclideanSpace(scene: THREE.Scene): SpaceAPI {
  const room = makeRoom(12);
  scene.add(room);
  addReference(scene);
  const speed = 4;

  return {
    update(camera, controls, input, dt) {
      if (!controls.isLocked) return;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const move = new THREE.Vector3();
      move.addScaledVector(dir, input.z);
      move.addScaledVector(right, input.x);
      move.addScaledVector(up, input.y);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);
      camera.position.add(move);
      controls.getObject().position.copy(camera.position);
    },
    dispose() {},
  };
}

// ---------- Torus (space wraps around) ----------
export function createTorusSpace(scene: THREE.Scene): SpaceAPI {
  const L = 12;
  const half = L / 2;
  const room = makeRoom(L);
  scene.add(room);
  addReference(scene);
  const speed = 4;

  function wrap(v: THREE.Vector3) {
    if (v.x > half) v.x -= L;
    else if (v.x < -half) v.x += L;
    if (v.z > half) v.z -= L;
    else if (v.z < -half) v.z += L;
  }

  return {
    update(camera, controls, input, dt) {
      if (!controls.isLocked) return;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const move = new THREE.Vector3();
      move.addScaledVector(dir, input.z);
      move.addScaledVector(right, input.x);
      move.addScaledVector(up, input.y);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);
      camera.position.add(move);
      wrap(camera.position);
      controls.getObject().position.copy(camera.position);
    },
    dispose() {},
  };
}

// ---------- Hyperbolic (Poincaré ball model) ----------
export function createHyperbolicSpace(scene: THREE.Scene): SpaceAPI {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    new THREE.MeshBasicMaterial({
      color: 0x88aaff,
      wireframe: true,
      transparent: true,
      opacity: 0.25,
    })
  );
  sphere.scale.setScalar(5);
  scene.add(sphere);

  const speed = 1.5;
  const scale = 3;
  const x = new THREE.Vector3(0, 0, 0);

  function mobiusAdd(x: THREE.Vector3, y: THREE.Vector3) {
    const xy = x.dot(y);
    const x2 = x.lengthSq();
    const y2 = y.lengthSq();
    const num = x
      .clone()
      .multiplyScalar(1 + 2 * xy + y2)
      .add(y.clone().multiplyScalar(1 - x2));
    const den = 1 + 2 * xy + x2 * y2;
    return num.multiplyScalar(1 / den);
  }

  function expMap(x: THREE.Vector3, v: THREE.Vector3) {
    const vx = v.clone();
    const vnorm = vx.length();
    if (vnorm < 1e-6) return x.clone();
    const lam = 2 / (1 - x.lengthSq());
    const t = Math.tanh((lam * vnorm) / 2);
    const u = vx.multiplyScalar(1 / vnorm).multiplyScalar(t);
    return mobiusAdd(x, u);
  }

  return {
    update(camera, controls, input, dt) {
      if (!controls.isLocked) return;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const tang = new THREE.Vector3();
      tang.addScaledVector(dir, input.z);
      tang.addScaledVector(right, input.x);
      tang.addScaledVector(up, input.y);
      if (tang.lengthSq() > 0) tang.normalize();

      const step = speed * dt;
      const v = tang.multiplyScalar(step);
      const xn = expMap(x, v);
      if (xn.length() < 0.999) x.copy(xn);

      camera.position.set(x.x * scale, x.y * scale + 1.6, x.z * scale);
      controls.getObject().position.copy(camera.position);

      const d = 1 - x.length();
      const fog = THREE.MathUtils.clamp(1 - d * 2, 0, 1);
      scene.fog = new THREE.FogExp2(0x0b1220, 0.04 * fog);
    },
    dispose() {},
  };
}
