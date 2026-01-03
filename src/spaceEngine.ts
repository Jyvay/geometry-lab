// src/spaceEngine.ts
export type SpaceId = "E" | "H" | "S";

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export type Shape =
  | { kind: "polyline"; pts: Vec2[]; color: string; width: number }
  | { kind: "marker"; p: Vec2; color: string };

export type InProgress =
  | { kind: "polyline"; pts: Vec2[]; color: string; width: number }
  | null;
export type LogEntry =
  | { t: number; type: "ADVANCE"; dist: number }
  | { t: number; type: "TURN"; deg: number }
  | { t: number; type: "TRACE_LINE"; length: number }
  | { t: number; type: "TRACE_CIRCLE"; radius: number }
  | { t: number; type: "TRIANGLE_CREATED"; labels: string[]; points: { x: number; y: number }[] }
  | { t: number; type: "MEASURE_ANGLE"; valueDeg: number; A: Vec2; B: Vec2; C: Vec2 }
  | { t: number; type: "COPY_TO_SPACE"; from: SpaceId; to: SpaceId; what: string }
  | { t: number; type: "OBS"; title: string; data: Record<string, unknown> };



export interface EngineState {
  space: SpaceId;

  // Euclid
  e_pos: Vec2;
  e_theta: number;

  // Hyperbolic (Poincaré disk)
  h_pos: Vec2;
  h_theta: number;

  // Sphere
  s_p: Vec3;
  s_t: Vec3;

  // drawings
  shapes: Shape[];
  inProgress: InProgress;
  log: LogEntry[];
  // animation
  anim: {
    active: boolean;
    path: Vec2[];     // world points the frog should follow (external view coords)
    i: number;        // current segment index
    t: number;        // segment interpolation [0..1]
    speed: number;    // world-units per second (roughly)
    addToTrace: boolean; // if true, we append visited points to inProgress polyline
    rotate?: { from: number; to: number; elapsed: number; duration: number }; // turning animation for E/H
    // For sphere turning: we handle by incremental rotation per frame in App (simpler)
  };
}

// --------- vector helpers ----------
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hypot2 = (v: Vec2) => Math.hypot(v.x, v.y);
const add2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const mul2 = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot2 = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const norm2 = (a: Vec2) => {
  const n = hypot2(a);
  return n > 0 ? mul2(a, 1 / n) : { x: 1, y: 0 };
};

const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const hypot3 = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const mul3 = (v: Vec3, k: number): Vec3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const norm3 = (v: Vec3): Vec3 => {
  const n = hypot3(v);
  return n > 0 ? mul3(v, 1 / n) : { x: 1, y: 0, z: 0 };
};
const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

// --------- “space formulas” (no names) ----------
export function spaceFormula(space: SpaceId): { title: string; formula: string } {
  if (space === "E") return { title: "Espace A", formula: "ds² = dx² + dy²" };
  if (space === "H") return { title: "Espace B", formula: "ds² = 4(dx²+dy²)/(1−x²−y²)²   (x²+y²<1)" };
  return { title: "Espace C", formula: "x²+y²+z²=1  ;  ds² = dθ² + sin²(θ)dφ²" };
}

// --------- initial ----------
export function createInitialState(space: SpaceId): EngineState {
  const s_p = norm3({ x: 0, y: 0, z: 1 });
  const s_t = norm3({ x: 1, y: 0, z: 0 });
  return {
    space,
    e_pos: { x: 0, y: 0 },
    e_theta: 0,
    h_pos: { x: 0, y: 0 },
    h_theta: 0,
    s_p,
    s_t,
    shapes: [],
    inProgress: null,
    log: [],
    anim: { active: false, path: [], i: 0, t: 0, speed: 0.6, addToTrace: false },
  };
}

export function reset(state: EngineState, space: SpaceId): EngineState {
  return createInitialState(space);
}

export function clearShapes(state: EngineState): EngineState {
  return { ...state, shapes: [], inProgress: null };
}

// --------- frog current position in “external view world coords” ----------
function sphereToWorld2(p: Vec3): Vec2 {
  return { x: p.x, y: p.y };
}

export function frogWorldPos(state: EngineState): Vec2 {
  if (state.space === "E") return state.e_pos;
  if (state.space === "H") return state.h_pos;
  return sphereToWorld2(state.s_p);
}

export function frogHeadingWorldDir(state: EngineState): Vec2 {
  if (state.space === "E") return { x: Math.cos(state.e_theta), y: Math.sin(state.e_theta) };
  if (state.space === "H") return { x: Math.cos(state.h_theta), y: Math.sin(state.h_theta) };
  return norm2(sphereToWorld2(state.s_t));
}

// ---------- hyperbolic Poincaré disk helpers ----------
function mobiusAdd(a: Vec2, b: Vec2): Vec2 {
  const a2 = dot2(a, a);
  const b2 = dot2(b, b);
  const ab = dot2(a, b);
  const denom = 1 + 2 * ab + a2 * b2;
  return {
    x: ((1 + 2 * ab + b2) * a.x + (1 - a2) * b.x) / denom,
    y: ((1 + 2 * ab + b2) * a.y + (1 - a2) * b.y) / denom,
  };
}

function tanh(x: number) {
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

function hyperbolicDirectionAtOrigin(p: Vec2, dir: Vec2): Vec2 {
  const eps = 1e-4;
  const safeDir = norm2(dir);
  let q = add2(p, mul2(safeDir, eps));
  const q2 = dot2(q, q);
  if (q2 >= 0.9999) q = mul2(norm2(q), 0.999);
  const Tp = (x: Vec2) => mobiusAdd({ x: -p.x, y: -p.y }, x);
  const p0 = Tp(p);
  const q0 = Tp(q);
  return norm2(sub2(q0, p0));
}

export function hyperbolicGeodesicPoints(a: Vec2, b: Vec2, n = 140): Vec2[] {
  const cross = a.x * b.y - a.y * b.x;
  if (Math.abs(cross) < 1e-6) {
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = add2(mul2(a, 1 - t), mul2(b, t));
      const r2 = dot2(p, p);
      pts.push(r2 < 0.999 ? p : mul2(norm2(p), 0.999));
    }
    return pts;
  }

  const A1 = a.x, A2 = a.y;
  const B1 = b.x, B2 = b.y;
  const rhsA = (dot2(a, a) + 1) / 2;
  const rhsB = (dot2(b, b) + 1) / 2;
  const det = A1 * B2 - A2 * B1;
  const cx = (rhsA * B2 - A2 * rhsB) / det;
  const cy = (A1 * rhsB - rhsA * B1) / det;
  const r = Math.hypot(a.x - cx, a.y - cy);

  const angA = Math.atan2(a.y - cy, a.x - cx);
  const angB = Math.atan2(b.y - cy, b.x - cx);

  let d = angB - angA;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;

  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const ang = angA + d * t;
    const p = { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) };
    const r2 = dot2(p, p);
    pts.push(r2 < 0.999 ? p : mul2(norm2(p), 0.999));
  }
  return pts;
}

// ---------- sphere helpers ----------
function sphericalBasis(lon: number, lat: number) {
  const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
  const north = { x: -Math.sin(lat) * Math.cos(lon), y: -Math.sin(lat) * Math.sin(lon), z: Math.cos(lat) };
  return { east, north };
}

function sphToCartesian(lon: number, lat: number) {
  const clat = Math.cos(lat);
  return { x: clat * Math.cos(lon), y: clat * Math.sin(lon), z: Math.sin(lat) };
}

// Move along great circle
function sphereAdvance(p: Vec3, t: Vec3, arc: number): { p: Vec3; t: Vec3 } {
  const cp = Math.cos(arc);
  const sp = Math.sin(arc);
  const p2 = add3(mul3(p, cp), mul3(t, sp));
  const t2 = add3(mul3(t, cp), mul3(p, -sp));
  return { p: norm3(p2), t: norm3(t2) };
}

function sphereTurn(p: Vec3, t: Vec3, ang: number): Vec3 {
  const axis = p;
  const cp = Math.cos(ang);
  const sp = Math.sin(ang);
  const axt = cross3(axis, t);
  return norm3(add3(add3(mul3(t, cp), mul3(axt, sp)), mul3(axis, dot3(axis, t) * (1 - cp))));
}

function greatCirclePath(p: Vec3, t: Vec3, arcLen: number, n = 220): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (arcLen * i) / n;
    const { p: pi } = sphereAdvance(p, t, s);
    pts.push(sphereToWorld2(pi));
  }
  return pts;
}

function sphereCirclePoints(center: Vec3, radiusArc: number, n = 260): Vec2[] {
  let u = cross3(center, { x: 0, y: 0, z: 1 });
  if (hypot3(u) < 1e-6) u = cross3(center, { x: 0, y: 1, z: 0 });
  u = norm3(u);
  const v = norm3(cross3(center, u));

  const pts: Vec2[] = [];
  const cr = Math.cos(radiusArc);
  const sr = Math.sin(radiusArc);
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    const dir = add3(mul3(u, Math.cos(a)), mul3(v, Math.sin(a)));
    const p = add3(mul3(center, cr), mul3(dir, sr));
    pts.push(sphereToWorld2(norm3(p)));
  }
  return pts;
}

// ---------- build paths for actions ----------
export function buildAdvancePath(state: EngineState, dist: number): { path: Vec2[]; next: EngineState } {
  if (state.space === "E") {
    const A = state.e_pos;
    const dir = { x: Math.cos(state.e_theta), y: Math.sin(state.e_theta) };
    const B = add2(A, mul2(dir, dist));
    const path = [A, B];
    return { path, next: { ...state, e_pos: B } };
  }

  if (state.space === "H") {
    const p = state.h_pos;
    const dirLocal = { x: Math.cos(state.h_theta), y: Math.sin(state.h_theta) };
    const d0 = hyperbolicDirectionAtOrigin(p, dirLocal);
    const t = tanh(dist / 2);
    const step0 = mul2(d0, t);
    let p2 = mobiusAdd(p, step0);
    const r2 = dot2(p2, p2);
    if (r2 >= 0.9999) p2 = mul2(norm2(p2), 0.999);
    const path = hyperbolicGeodesicPoints(p, p2, 180);
    return { path, next: { ...state, h_pos: p2 } };
  }

  // Sphere: dist is arc length (radians)
  const path = greatCirclePath(state.s_p, state.s_t, dist, 260);
  const { p: p2, t: t2 } = sphereAdvance(state.s_p, state.s_t, dist);
  return { path, next: { ...state, s_p: p2, s_t: t2 } };
}

export function buildTurnAnim(state: EngineState, deg: number, duration = 0.35): EngineState {
  const ang = (deg * Math.PI) / 180;
  if (state.space === "E") {
    const from = state.e_theta;
    const to = from + ang;
    return {
      ...state,
      anim: { ...state.anim, active: true, path: [], i: 0, t: 0, addToTrace: false, rotate: { from, to, elapsed: 0, duration } },
    };
  }
  if (state.space === "H") {
    const from = state.h_theta;
    const to = from + ang;
    return {
      ...state,
      anim: { ...state.anim, active: true, path: [], i: 0, t: 0, addToTrace: false, rotate: { from, to, elapsed: 0, duration } },
    };
  }
  // Sphere turning handled incrementally in stepAnimation (rotate tangent)
  // We'll store rotate as "from/to" but apply via sphereTurn each frame
  return {
    ...state,
    anim: { ...state.anim, active: true, path: [], i: 0, t: 0, addToTrace: false, rotate: { from: 0, to: ang, elapsed: 0, duration } },
  };
}

export function buildGeodesicTrace(state: EngineState, length: number): { path: Vec2[]; next: EngineState; traceColor: string } {
  // A traced geodesic is just an advance path, but we set addToTrace = true and keep position at end.
  const { path, next } = buildAdvancePath(state, length);
  return { path, next, traceColor: "#16a34a" };
}

export function buildCircleTrace(state: EngineState, radius: number): { path: Vec2[]; next: EngineState; traceColor: string } {
  if (state.space === "E") {
    const C = state.e_pos;
    const n = 260;
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (2 * Math.PI * i) / n;
      pts.push({ x: C.x + radius * Math.cos(a), y: C.y + radius * Math.sin(a) });
    }
    // frog ends at last point
    const last = pts[pts.length - 1];
    return { path: pts, next: { ...state, e_pos: last }, traceColor: "#2563eb" };
  }

  if (state.space === "H") {
    // hyperbolic circle centered at p in disk coords (visual circle)
    const p = state.h_pos;
    const p2 = dot2(p, p);
    const t = tanh(radius / 2);
    const rho = (t * (1 - p2)) / (1 - p2 * t * t);

    const n = 280;
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (2 * Math.PI * i) / n;
      const q = { x: p.x + rho * Math.cos(a), y: p.y + rho * Math.sin(a) };
      const r2 = dot2(q, q);
      pts.push(r2 < 0.999 ? q : mul2(norm2(q), 0.999));
    }
    const last = pts[pts.length - 1];
    return { path: pts, next: { ...state, h_pos: last }, traceColor: "#2563eb" };
  }

  // sphere: circle at fixed spherical distance radius around current point
  const pts = sphereCirclePoints(state.s_p, radius, 320);
  const last = pts[pts.length - 1];
  // We can’t fully reconstruct sphere tangent from 2D point; but for visual tracing it’s fine.
  // We'll keep s_p/s_t unchanged for now, and just move frog along path by overriding world position each frame.
  // So the frog “walks” the circle visually; after completion we leave sphere state unchanged.
  return { path: pts, next: state, traceColor: "#2563eb" };
}

// ---------- animation step (called each frame) ----------
export function stepAnimation(state: EngineState, dt: number): EngineState {
  if (!state.anim.active) return state;

  // turning animation
  if (state.anim.rotate) {
    const r = state.anim.rotate;
    const elapsed = r.elapsed + dt;
    const u = clamp(elapsed / r.duration, 0, 1);

    if (state.space === "E") {
      const theta = r.from + (r.to - r.from) * u;
      const done = u >= 1;
      return {
        ...state,
        e_theta: theta,
        anim: done
          ? { active: false, path: [], i: 0, t: 0, speed: state.anim.speed, addToTrace: false }
          : { ...state.anim, rotate: { ...r, elapsed } },
      };
    }

    if (state.space === "H") {
      const theta = r.from + (r.to - r.from) * u;
      const done = u >= 1;
      return {
        ...state,
        h_theta: theta,
        anim: done
          ? { active: false, path: [], i: 0, t: 0, speed: state.anim.speed, addToTrace: false }
          : { ...state.anim, rotate: { ...r, elapsed } },
      };
    }

    // sphere: rotate tangent progressively by total angle r.to over duration
    const dAng = (r.to * dt) / r.duration;
    const t2 = sphereTurn(state.s_p, state.s_t, dAng);
    const done = u >= 1;
    return {
      ...state,
      s_t: t2,
      anim: done
        ? { active: false, path: [], i: 0, t: 0, speed: state.anim.speed, addToTrace: false }
        : { ...state.anim, rotate: { ...r, elapsed } },
    };
  }

  const path = state.anim.path;
  if (path.length < 2) {
    return { ...state, anim: { ...state.anim, active: false } };
  }

  // Move along polyline at roughly constant speed in world units.
  let i = state.anim.i;
  let t = state.anim.t;
  let remaining = state.anim.speed * dt;

  let currentPos = frogWorldPos(state);

  while (remaining > 0 && i < path.length - 1) {
    const A = path[i];
    const B = path[i + 1];
    const seg = sub2(B, A);
    const segLen = hypot2(seg);
    const cur = add2(A, mul2(seg, t));
    currentPos = cur;

    const left = segLen * (1 - t);
    if (left >= remaining) {
      t += remaining / segLen;
      remaining = 0;
      currentPos = add2(A, mul2(seg, t));
      break;
    } else {
      remaining -= left;
      i += 1;
      t = 0;
      currentPos = B;
    }
  }

  // Update frog position in the correct space (visual external coords):
  let nextState = state;

  if (state.space === "E") nextState = { ...nextState, e_pos: currentPos };
  else if (state.space === "H") nextState = { ...nextState, h_pos: currentPos };
  else {
    // sphere: we cannot fully invert 2D->3D uniquely; for smooth visual trace we just “display” via e_pos-like.
    // But to keep frogWorldPos using s_p, we approximate lifting to front hemisphere.
    const r2 = currentPos.x * currentPos.x + currentPos.y * currentPos.y;
    const z = Math.sqrt(Math.max(0, 1 - r2));
    nextState = { ...nextState, s_p: norm3({ x: currentPos.x, y: currentPos.y, z }) };
  }

  // Append to inProgress trace if requested
  if (state.anim.addToTrace && nextState.inProgress?.kind === "polyline") {
    const pts = nextState.inProgress.pts;
    const last = pts[pts.length - 1];
    if (!last || hypot2(sub2(currentPos, last)) > 0.002) {
      nextState = {
        ...nextState,
        inProgress: { ...nextState.inProgress, pts: [...pts, currentPos] },
      };
    }
  }

  const done = i >= path.length - 1;

  return {
    ...nextState,
    anim: done ? { active: false, path: [], i: 0, t: 0, speed: state.anim.speed, addToTrace: false } : { ...state.anim, i, t },
  };
}

// ---------- tracing session helpers ----------
export function startTracing(state: EngineState, color: string, width: number): EngineState {
  return { ...state, inProgress: { kind: "polyline", pts: [frogWorldPos(state)], color, width } };
}

export function finishTracing(state: EngineState): EngineState {
  if (!state.inProgress) return state;
  const poly = state.inProgress;
  if (poly.pts.length < 2) return { ...state, inProgress: null };
  return { ...state, shapes: [...state.shapes, poly], inProgress: null };
}

// ---------- schedule a path animation (optionally with tracing) ----------
export function animatePath(state: EngineState, path: Vec2[], speed = 0.7, addToTrace = false): EngineState {
  return {
    ...state,
    anim: { active: true, path, i: 0, t: 0, speed, addToTrace },
  };
}

// ---------- angle measurement (unchanged, but compatible) ----------
export function angleAt(space: SpaceId, A: Vec2, B: Vec2, C: Vec2): number {
  if (space === "E") {
    const u = norm2(sub2(A, B));
    const v = norm2(sub2(C, B));
    const d = clamp(dot2(u, v), -1, 1);
    return Math.acos(d);
  }
  if (space === "H") {
    const ptsBA = hyperbolicGeodesicPoints(B, A, 30);
    const ptsBC = hyperbolicGeodesicPoints(B, C, 30);
    const d1 = norm2(sub2(ptsBA[1], ptsBA[0]));
    const d2 = norm2(sub2(ptsBC[1], ptsBC[0]));
    const d = clamp(dot2(d1, d2), -1, 1);
    return Math.acos(d);
  }
  // sphere: lift to front hemisphere
  const lift = (p: Vec2): Vec3 => {
    const r2 = p.x * p.x + p.y * p.y;
    const z = Math.sqrt(Math.max(0, 1 - r2));
    return norm3({ x: p.x, y: p.y, z });
  };
  const a3 = lift(A), b3 = lift(B), c3 = lift(C);
  const n1 = cross3(b3, a3);
  const n2 = cross3(b3, c3);
  const t1 = cross3(n1, b3);
  const t2 = cross3(n2, b3);
  const d = clamp(dot3(norm3(t1), norm3(t2)), -1, 1);
  return Math.acos(d);
}



// --------- export builders for shapes ----------

export function pushLog(state: EngineState, entry: LogEntry): EngineState {
  return { ...state, log: [...state.log, entry] };
}

// ====== Exact geodesics & lines utilities (ADD AT END OF FILE) ======

export function geodesicBetween(space: SpaceId, p: Vec2, q: Vec2, steps = 260): Vec2[] {
  if (space === "E") return [p, q];
  if (space === "H") return geodesicPoincareSegment(p, q, steps);
  if (space === "S") return geodesicSphereProjectedSegment(p, q, steps);
  return [p, q];
}

// “Droite” complète passant par p et q (pas seulement le segment)
export function geodesicLineThrough(space: SpaceId, p: Vec2, q: Vec2, steps = 520): Vec2[] {
  if (space === "E") {
    // line in view box: extend a lot
    const dx = q.x - p.x, dy = q.y - p.y;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    const big = 5; // large extent in world units
    return [
      { x: p.x - ux * big, y: p.y - uy * big },
      { x: p.x + ux * big, y: p.y + uy * big },
    ];
  }
  if (space === "H") {
    return geodesicPoincareFullLine(p, q, steps);
  }
  if (space === "S") {
    // full great circle loop projected => ellipse/circle without corners and “goes around”
    return greatCircleProjectedClosed(p, q, steps);
  }

  return [p, q];
}

// ---------------- Hyperbolic (Poincaré disk) ----------------

type Circle = { c: Vec2; r: number; aP: number; aQ: number }; // angles of p & q around center

function normalizeAngle(a: number) {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

function clampNum(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function poincareCircleThroughPQ(p: Vec2, q: Vec2): Circle | null {
  const eps = 1e-10;
  const cross = p.x * q.y - p.y * q.x;
  if (Math.abs(cross) < 1e-7) {
    // diameter case handled elsewhere
    return null;
  }

  const pp = p.x * p.x + p.y * p.y;
  const qq = q.x * q.x + q.y * q.y;
  const b1 = (pp + 1) / 2;
  const b2 = (qq + 1) / 2;

  const det = p.x * q.y - p.y * q.x;
  if (Math.abs(det) < eps) return null;

  const cx = (b1 * q.y - p.y * b2) / det;
  const cy = (p.x * b2 - b1 * q.x) / det;

  const r2 = cx * cx + cy * cy - 1;
  if (r2 <= 1e-10) return null;

  const r = Math.sqrt(r2);
  const aP = Math.atan2(p.y - cy, p.x - cx);
  const aQ = Math.atan2(q.y - cy, q.x - cx);

  return { c: { x: cx, y: cy }, r, aP, aQ };
}

function circleCircleIntersections(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  // intersection of two circles
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  const eps = 1e-10;
  if (d < eps) return [];

  // no intersection
  if (d > r1 + r2 + 1e-9) return [];
  if (d < Math.abs(r1 - r2) - 1e-9) return [];

  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  if (h2 < -1e-9) return [];
  const h = Math.sqrt(Math.max(0, h2));

  const xm = c1.x + (a * dx) / d;
  const ym = c1.y + (a * dy) / d;

  const rx = -dy * (h / d);
  const ry = dx * (h / d);

  const p1 = { x: xm + rx, y: ym + ry };
  const p2 = { x: xm - rx, y: ym - ry };
  if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < 1e-9) return [p1];
  return [p1, p2];
}

function sampleArcThroughAngles(c: Vec2, r: number, aStart: number, aEnd: number, mustContain: number, steps: number): Vec2[] {
  // choose arc aStart->aEnd that contains mustContain
  const d = normalizeAngle(aEnd - aStart);
  const dAlt = d - Math.sign(d || 1) * 2 * Math.PI;

  const mid1 = aStart + d * 0.5;
  const mid2 = aStart + dAlt * 0.5;

  const contains = (a: number, from: number, delta: number) => {
    // check if angle a lies on arc from 'from' length 'delta' (mod 2π)
    const x = normalizeAngle(a - from);
    const L = normalizeAngle(delta);
    if (L >= 0) return x >= 0 && x <= L + 1e-9;
    return x <= 0 && x >= L - 1e-9;
  };

  const useDelta = contains(mustContain, aStart, d) ? d : dAlt;

  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = aStart + useDelta * t;
    pts.push({ x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) });
  }
  return pts;
}

function geodesicPoincareSegment(p: Vec2, q: Vec2, steps: number): Vec2[] {
  // diameter (collinear with origin) -> straight chord
  const cross = p.x * q.y - p.y * q.x;
  if (Math.abs(cross) < 1e-7) return [p, q];

  const circ = poincareCircleThroughPQ(p, q);
  if (!circ) return [p, q];

  // arc from p to q inside disk
  const pts = sampleArcThroughAngles(circ.c, circ.r, circ.aP, circ.aQ, circ.aP, steps);
  pts[0] = p;
  pts[pts.length - 1] = q;
  return pts;
}

function geodesicPoincareFullLine(p: Vec2, q: Vec2, steps: number): Vec2[] {
  // Full geodesic = arc between boundary intersection points (ideal endpoints)
  const cross = p.x * q.y - p.y * q.x;
  if (Math.abs(cross) < 1e-7) {
    // diameter: direction u = normalize(p) or normalize(q)
    const d = Math.hypot(p.x, p.y) > 1e-8 ? p : q;
    const L = Math.hypot(d.x, d.y) || 1;
    const ux = d.x / L, uy = d.y / L;
    return [{ x: -ux, y: -uy }, { x: ux, y: uy }];
  }

  const circ = poincareCircleThroughPQ(p, q);
  if (!circ) return [p, q];

  const inter = circleCircleIntersections(circ.c, circ.r, { x: 0, y: 0 }, 1);
  if (inter.length < 2) return [p, q];

  const a1 = Math.atan2(inter[0].y - circ.c.y, inter[0].x - circ.c.x);
  const a2 = Math.atan2(inter[1].y - circ.c.y, inter[1].x - circ.c.x);
  const aP = circ.aP;

  const pts = sampleArcThroughAngles(circ.c, circ.r, a1, a2, aP, steps);

  // trim to inside disk with tolerance
  const inside: Vec2[] = [];
  for (const s of pts) {
    if (s.x * s.x + s.y * s.y <= 1 + 1e-6) inside.push(s);
  }
  return inside.length >= 2 ? inside : pts;
}

// Parallel-limiting line through point P sharing an ideal endpoint with base line (p,q)
export function hyperbolicParallelThroughPoint(baseP: Vec2, baseQ: Vec2, through: Vec2, whichEnd: 0 | 1, steps = 520): Vec2[] {
  // Compute ideal endpoints A,B of base line
  const base = geodesicPoincareFullLine(baseP, baseQ, 520);
  if (base.length < 2) return [];

  const A = base[0];
  const B = base[base.length - 1];
  const E = whichEnd === 0 ? A : B;

  // Center c solves: c·E = 1 and c·through = (|through|^2 + 1)/2
  const ex = E.x, ey = E.y;
  const px = through.x, py = through.y;
  const rhs1 = 1;
  const rhs2 = (px * px + py * py + 1) / 2;

  const det = ex * py - ey * px;
  if (Math.abs(det) < 1e-10) {
    // fallback: diameter
    const L = Math.hypot(px, py) || 1;
    return [{ x: -px / L, y: -py / L }, { x: px / L, y: py / L }];
  }

  const cx = (rhs1 * py - ey * rhs2) / det;
  const cy = (ex * rhs2 - rhs1 * px) / det;

  const r2 = cx * cx + cy * cy - 1;
  if (r2 <= 1e-10) return [];
  const r = Math.sqrt(r2);

  // circle boundary intersections
  const inter = circleCircleIntersections({ x: cx, y: cy }, r, { x: 0, y: 0 }, 1);
  if (inter.length < 2) return [];

  const aE = Math.atan2(E.y - cy, E.x - cx);
  const aOther = Math.atan2(inter[0].y - cy, inter[0].x - cx);
  const aOther2 = Math.atan2(inter[1].y - cy, inter[1].x - cx);

  // choose other endpoint not equal to E
  const d0 = (inter[0].x - E.x) ** 2 + (inter[0].y - E.y) ** 2;
  const other = d0 > 1e-6 ? inter[0] : inter[1];
  const aO = Math.atan2(other.y - cy, other.x - cx);

  const aP = Math.atan2(through.y - cy, through.x - cx);
  const pts = sampleArcThroughAngles({ x: cx, y: cy }, r, aE, aO, aP, steps);
  return pts;
}

// Perpendicular hyperbolic through point P to base line (p,q)
export function hyperbolicPerpendicularThroughPoint(baseP: Vec2, baseQ: Vec2, through: Vec2, steps = 520): Vec2[] {
  // base line circle/diameter
  const cross = baseP.x * baseQ.y - baseP.y * baseQ.x;
  if (Math.abs(cross) < 1e-7) {
    // base is diameter along direction u
    const d = Math.hypot(baseP.x, baseP.y) > 1e-8 ? baseP : baseQ;
    const L = Math.hypot(d.x, d.y) || 1;
    const ux = d.x / L, uy = d.y / L;

    // perpendicular at origin is diameter rotated 90, but we need through arbitrary point
    // Use numeric search over direction θ (tangent direction at through) to satisfy circle orthogonality
  }

  // Get circle of base geodesic if not diameter
  const baseCirc = poincareCircleThroughPQ(baseP, baseQ);
  if (!baseCirc) {
    // handle diameter base with numeric below (still works)
    return hyperbolicPerpNumeric(baseP, baseQ, through, steps);
  }

  // Solve for geodesic through 'through' whose circle is orthogonal to base circle:
  // We param by direction u at through; build circle from through+u; impose |cG-cB|^2 = rG^2 + rB^2
  return hyperbolicPerpUsingOrthogonality(baseCirc.c, baseCirc.r, through, steps);
}

function hyperbolicPerpUsingOrthogonality(baseC: Vec2, baseR: number, P: Vec2, steps: number): Vec2[] {
  const N = 240; // search samples
  let bestTheta = 0;
  let bestErr = Infinity;

  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * i) / N;
    const u = { x: Math.cos(th), y: Math.sin(th) };

    const circ = poincareCircleFromPointDir(P, u);
    if (!circ) continue;

    const dcx = circ.c.x - baseC.x;
    const dcy = circ.c.y - baseC.y;
    const err = Math.abs(dcx * dcx + dcy * dcy - (circ.r * circ.r + baseR * baseR));
    if (err < bestErr) {
      bestErr = err;
      bestTheta = th;
    }
  }

  // refine locally
  for (let k = 0; k < 6; k++) {
    const step = (Math.PI / 180) * (10 / (k + 1));
    for (const s of [-2, -1, 1, 2]) {
      const th = bestTheta + s * step;
      const u = { x: Math.cos(th), y: Math.sin(th) };
      const circ = poincareCircleFromPointDir(P, u);
      if (!circ) continue;

      const dcx = circ.c.x - baseC.x;
      const dcy = circ.c.y - baseC.y;
      const err = Math.abs(dcx * dcx + dcy * dcy - (circ.r * circ.r + baseR * baseR));
      if (err < bestErr) {
        bestErr = err;
        bestTheta = th;
      }
    }
  }

  const uBest = { x: Math.cos(bestTheta), y: Math.sin(bestTheta) };
  const best = poincareCircleFromPointDir(P, uBest);
  if (!best) return [];

  const inter = circleCircleIntersections(best.c, best.r, { x: 0, y: 0 }, 1);
  if (inter.length < 2) return [];

  const a1 = Math.atan2(inter[0].y - best.c.y, inter[0].x - best.c.x);
  const a2 = Math.atan2(inter[1].y - best.c.y, inter[1].x - best.c.x);
  const aP = Math.atan2(P.y - best.c.y, P.x - best.c.x);

  return sampleArcThroughAngles(best.c, best.r, a1, a2, aP, steps);
}

function poincareCircleFromPointDir(P: Vec2, u: Vec2): { c: Vec2; r: number } | null {
  // tangent direction u at P; radius direction is normal n
  const n = { x: -u.y, y: u.x };
  const pn = P.x * n.x + P.y * n.y;
  if (Math.abs(pn) < 1e-10) return null; // avoid division by 0 (would be diameter case)
  const t = (1 - (P.x * P.x + P.y * P.y)) / (2 * pn);
  const c = { x: P.x + t * n.x, y: P.y + t * n.y };
  const r = Math.abs(t);
  if (c.x * c.x + c.y * c.y <= 1 + 1e-9) return null; // center must be outside disk for orthogonal circle
  return { c, r };
}

function hyperbolicPerpNumeric(baseP: Vec2, baseQ: Vec2, P: Vec2, steps: number): Vec2[] {
  // fallback: approximate base circle endpoints and use orthogonality search against it
  const base = geodesicPoincareFullLine(baseP, baseQ, 520);
  if (base.length < 2) return [];
  // Approx base as polyline; perpendicular exact is hard here; return best approx using diameter trick
  // Use direction from origin to closest point on base and make circle through P orthogonal to that diameter
  const u = { x: -P.y, y: P.x };
  const circ = poincareCircleFromPointDir(P, u);
  if (!circ) return [];
  const inter = circleCircleIntersections(circ.c, circ.r, { x: 0, y: 0 }, 1);
  if (inter.length < 2) return [];
  const a1 = Math.atan2(inter[0].y - circ.c.y, inter[0].x - circ.c.x);
  const a2 = Math.atan2(inter[1].y - circ.c.y, inter[1].x - circ.c.x);
  const aP = Math.atan2(P.y - circ.c.y, P.x - circ.c.x);
  return sampleArcThroughAngles(circ.c, circ.r, a1, a2, aP, steps);
}

// ---------------- Sphere (upper hemisphere projected to disk) ----------------

function v3dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function v3cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function v3norm(a: Vec3) {
  return Math.hypot(a.x, a.y, a.z);
}
function v3scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function v3add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function v3unit(a: Vec3): Vec3 {
  const L = v3norm(a) || 1;
  return { x: a.x / L, y: a.y / L, z: a.z / L };
}

function liftToUpperHemisphere(p: Vec2): Vec3 {
  const r2 = p.x * p.x + p.y * p.y;
  const z = Math.sqrt(Math.max(0, 1 - r2));
  return v3unit({ x: p.x, y: p.y, z });
}

function greatCircleProjectedClosed(p: Vec2, q: Vec2, steps: number): Vec2[] {
  const a = liftToUpperHemisphere(p);
  const b = liftToUpperHemisphere(q);

  const n = v3cross(a, b);
  const nL = v3norm(n);
  if (nL < 1e-10) return geodesicSphereProjectedSegment(p, q, steps);

  const nn = v3unit(n);

  // basis u,v spanning plane orthogonal to nn
  const proj = v3scale(nn, v3dot(a, nn));
  let u = v3unit(v3add(a, v3scale(proj, -1)));
  let v = v3unit(v3cross(nn, u));

  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const X = v3unit({
      x: u.x * Math.cos(t) + v.x * Math.sin(t),
      y: u.y * Math.cos(t) + v.y * Math.sin(t),
      z: u.z * Math.cos(t) + v.z * Math.sin(t),
    });
    // IMPORTANT: we project both hemispheres => ellipse/circle fully closed in 2D
    pts.push({ x: X.x, y: X.y });
  }
  return pts;
}


function geodesicSphereProjectedSegment(p: Vec2, q: Vec2, steps: number): Vec2[] {
  const a = liftToUpperHemisphere(p);
  const b = liftToUpperHemisphere(q);
  const dot = clampNum(v3dot(a, b), -1, 1);
  const omega = Math.acos(dot);
  if (omega < 1e-8) return [p, q];
  const sinOm = Math.sin(omega);

  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s1 = Math.sin((1 - t) * omega) / sinOm;
    const s2 = Math.sin(t * omega) / sinOm;
    const x = s1 * a.x + s2 * b.x;
    const y = s1 * a.y + s2 * b.y;
    const z = s1 * a.z + s2 * b.z;
    const u = v3unit({ x, y, z });
    if (u.z >= -1e-10) pts.push({ x: u.x, y: u.y });
  }
  if (pts.length) {
    pts[0] = p;
    pts[pts.length - 1] = q;
  }
  return pts.length >= 2 ? pts : [p, q];
}

function greatCircleFullProjected(p: Vec2, q: Vec2, steps: number): Vec2[] {
  const a = liftToUpperHemisphere(p);
  const b = liftToUpperHemisphere(q);
  const n = v3cross(a, b);
  const nL = v3norm(n);
  if (nL < 1e-10) return geodesicSphereProjectedSegment(p, q, steps);

  const nn = v3unit(n);

  // Orthonormal basis u,v spanning the plane orthogonal to nn
  const proj = v3scale(nn, v3dot(a, nn));
  let u = v3unit(v3add(a, v3scale(proj, -1)));
  let v = v3unit(v3cross(nn, u));

  // We want only the visible part on the upper hemisphere: z(t) >= 0
  // z(t) = u.z cos t + v.z sin t = A cos(t - phi)
  const Az = Math.hypot(u.z, v.z);

  let t0 = 0;
  let t1 = 2 * Math.PI;

  if (Az > 1e-12) {
    const phi = Math.atan2(v.z, u.z);
    t0 = phi - Math.PI / 2;
    t1 = phi + Math.PI / 2;
  } else {
    // Great circle lies on equator (z=0 everywhere): fully visible on boundary
    t0 = 0;
    t1 = 2 * Math.PI;
  }

  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const X = v3unit({
      x: u.x * Math.cos(t) + v.x * Math.sin(t),
      y: u.y * Math.cos(t) + v.y * Math.sin(t),
      z: u.z * Math.cos(t) + v.z * Math.sin(t),
    });
    // For numerical stability, keep only upper hemisphere
    if (X.z >= -1e-10) pts.push({ x: X.x, y: X.y });
  }

  return pts.length >= 2 ? pts : geodesicSphereProjectedSegment(p, q, steps);
}


// Perpendicular great circle through 'through' to base great circle defined by (p,q)
export function sphericalPerpendicularGreatCircleThroughPoint(baseP: Vec2, baseQ: Vec2, through: Vec2, steps = 520): Vec2[] {
  const a = liftToUpperHemisphere(baseP);
  const b = liftToUpperHemisphere(baseQ);
  const nBase = v3unit(v3cross(a, b));

  const P = liftToUpperHemisphere(through);

  // normal for perpendicular great circle plane: nPerp = normalize(P × nBase)
  const nPerp = v3cross(P, nBase);
  if (v3norm(nPerp) < 1e-10) {
    // through is on base plane; choose another perpendicular by using P×(some axis)
    const alt = v3cross(P, { x: 1, y: 0, z: 0 });
    if (v3norm(alt) < 1e-10) return [];
    return greatCircleFromNormalAndPoint(v3unit(alt), through, steps);
  }
  return greatCircleFromNormalAndPoint(v3unit(nPerp), through, steps);
}

function greatCircleFromNormalAndPoint(n: Vec3, through: Vec2, steps: number): Vec2[] {
  // plane: n·X=0 ; must pass through lifted(through)
  const P = liftToUpperHemisphere(through);

  // basis u,v in plane orthogonal to n, with u aligned to P projected into plane
  const proj = v3scale(n, v3dot(P, n));
  let u = v3unit(v3add(P, v3scale(proj, -1)));
  let v = v3unit(v3cross(n, u));

  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const X = v3unit({
      x: u.x * Math.cos(t) + v.x * Math.sin(t),
      y: u.y * Math.cos(t) + v.y * Math.sin(t),
      z: u.z * Math.cos(t) + v.z * Math.sin(t),
    });
    if (X.z >= -1e-10) pts.push({ x: X.x, y: X.y });
  }
  return pts;
}
