import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  SpaceId,
  EngineState,
  Vec2,
  createInitialState,
  reset,
  clearShapes,
  frogWorldPos,
  frogHeadingWorldDir,
  spaceFormula,
  animatePath,
  stepAnimation,
  startTracing,
  finishTracing,
  buildCircleTrace,
  geodesicBetween,
  geodesicLineThrough,
  hyperbolicParallelThroughPoint,
  hyperbolicPerpendicularThroughPoint,
} from "./spaceEngine";

import "./App.css";

/* ---------------- View mapping ---------------- */
function makeViewport(w: number, h: number, R = 1.25) {
  const s = Math.min(w, h) / (2 * R);
  return { R, cx: w / 2, cy: h / 2, scale: s };
}
function worldToScreen(vp: any, p: Vec2): Vec2 {
  return { x: vp.cx + p.x * vp.scale, y: vp.cy - p.y * vp.scale };
}
function screenToWorld(vp: any, p: Vec2): Vec2 {
  return { x: (p.x - vp.cx) / vp.scale, y: (vp.cy - p.y) / vp.scale };
}

/* ---------------- Helpers ---------------- */
function roundTriangleAnglesTo180(degs: number[]) {
  // degs: [A,B,C] en degrés (flottants)
  const floors = degs.map(Math.floor);
  let sum = floors[0] + floors[1] + floors[2];
  let need = 180 - sum;

  const frac = degs.map((d, i) => ({ i, f: d - floors[i] }));
  // si on doit ajouter, on donne aux plus grosses fractions
  // si on doit enlever, on retire aux plus petites fractions
  frac.sort((a, b) => (need >= 0 ? b.f - a.f : a.f - b.f));

  const ints = [...floors];
  while (need !== 0) {
    const k = Math.abs(need) > 3 ? 0 : 0; // simple, on boucle sur frac
    const idx = frac[(Math.abs(need) - 1) % 3].i;
    ints[idx] += need > 0 ? 1 : -1;
    need += need > 0 ? -1 : 1;
  }
  return ints;
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const dist2 = (a: Vec2, b: Vec2) => {
  const dx = a.x - b.x,
    dy = a.y - b.y;
  return dx * dx + dy * dy;
};
function distPointToSegment(p: Vec2, a: Vec2, b: Vec2) {
  const abx = b.x - a.x,
    aby = b.y - a.y;
  const apx = p.x - a.x,
    apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = (apx * abx + apy * aby) / ab2;
  t = clamp(t, 0, 1);
  const q = { x: a.x + t * abx, y: a.y + t * aby };
  return Math.hypot(p.x - q.x, p.y - q.y);
}
const euclidLen = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);
const dot2 = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const norm2 = (a: Vec2) => Math.hypot(a.x, a.y) || 1;
const mobiusAdd = (a: Vec2, b: Vec2): Vec2 => {
  const a2 = dot2(a, a);
  const b2 = dot2(b, b);
  const ab = dot2(a, b);
  const denom = 1 + 2 * ab + a2 * b2;
  return {
    x: ((1 + 2 * ab + b2) * a.x + (1 - a2) * b.x) / denom,
    y: ((1 + 2 * ab + b2) * a.y + (1 - a2) * b.y) / denom,
  };
};
const normalize2 = (a: Vec2) => {
  const n = norm2(a);
  return { x: a.x / n, y: a.y / n };
};
const perp2 = (a: Vec2) => ({ x: -a.y, y: a.x });
const cross2 = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;

function rotate2D(v: Vec2, deg: number) {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t),
    s = Math.sin(t);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

const angleBetweenDirs = (u: Vec2, v: Vec2) => {
  const nu = Math.hypot(u.x, u.y) || 1;
  const nv = Math.hypot(v.x, v.y) || 1;
  const ux = u.x / nu, uy = u.y / nu;
  const vx = v.x / nv, vy = v.y / nv;
  const dot = clamp(ux * vx + uy * vy, -1, 1);
  const crs = ux * vy - uy * vx;
  return Math.atan2(Math.abs(crs), dot); // rad
};

function hyperbolicGeodesicCircleCenter(A: Vec2, B: Vec2): Vec2 | null {
  // Cas dégénéré : A,B quasi alignés avec l'origine => géodésique = diamètre (droite)
  const det = A.x * B.y - A.y * B.x;
  if (Math.abs(det) < 1e-10) return null;

  // Solve:
  // A·c = (1+|A|^2)/2
  // B·c = (1+|B|^2)/2
  const aR = (1 + (A.x*A.x + A.y*A.y)) / 2;
  const bR = (1 + (B.x*B.x + B.y*B.y)) / 2;

  const cx = (aR * B.y - bR * A.y) / det;
  const cy = (-aR * B.x + bR * A.x) / det;
  return { x: cx, y: cy };
}

function hyperbolicTangentAtVertex(vertex: Vec2, other: Vec2): Vec2 {
  // Tangente à la géodésique (vertex<->other) au point vertex
  const c = hyperbolicGeodesicCircleCenter(vertex, other);
  if (!c) {
    // diamètre : géodésique = droite euclidienne, tangente = direction du segment
    return { x: other.x - vertex.x, y: other.y - vertex.y };
  }
  // cercle orthogonal au bord : tangente ⟂ (vertex - centre)
  const r = { x: vertex.x - c.x, y: vertex.y - c.y };
  return { x: -r.y, y: r.x };
}


// --- Complex helpers for Poincaré disk (hyperbolic circles) ---
type Cpx = { x: number; y: number };
const cAdd = (a: Cpx, b: Cpx): Cpx => ({ x: a.x + b.x, y: a.y + b.y });
const cSub = (a: Cpx, b: Cpx): Cpx => ({ x: a.x - b.x, y: a.y - b.y });
const cMul = (a: Cpx, b: Cpx): Cpx => ({ x: a.x * b.x - a.y * b.y, y: a.x * b.y + a.y * b.x });
const cConj = (a: Cpx): Cpx => ({ x: a.x, y: -a.y });
const cAbs2 = (a: Cpx) => a.x * a.x + a.y * a.y;
const cDiv = (a: Cpx, b: Cpx): Cpx => {
  const d = cAbs2(b) || 1e-12;
  const num = cMul(a, cConj(b));
  return { x: num.x / d, y: num.y / d };
};

// Hyperbolic circle (geodesic radius R) in Poincaré disk, starting at user point P
function buildHyperbolicCirclePath(center: Vec2, through: Vec2, R: number, samples = 720, overlapFrac = 0.06): Vec2[] {
  const c: Cpx = center;
  const p: Cpx = through;

  // u = tanh(R/2) : radius in the "moved-to-origin" disk
  const u = Math.tanh(R / 2);

  // Möbius isometry φ_c(z) = (z - c) / (1 - conj(c) z)
  // angle of w0 = φ_c(p) gives start direction for the param circle
  const denom0 = cSub({ x: 1, y: 0 }, cMul(cConj(c), p));
  const w0 = cDiv(cSub(p, c), denom0);
  const theta0 = Math.atan2(w0.y, w0.x);

  const total = 2 * Math.PI * (1 + overlapFrac);
  const pts: Vec2[] = [];

  for (let i = 0; i <= samples; i++) {
    const th = theta0 + (total * i) / samples;
    const w: Cpx = { x: u * Math.cos(th), y: u * Math.sin(th) };

    // inverse φ_c^{-1}(w) = (c + w) / (1 + conj(c) w)
    const denom = cAdd({ x: 1, y: 0 }, cMul(cConj(c), w));
    const z = cDiv(cAdd(c, w), denom);

    // tiny numeric safety: keep inside disk
    const r2 = z.x * z.x + z.y * z.y;
    if (r2 >= 0.999999) {
      const s = 0.999999 / Math.sqrt(r2);
      pts.push({ x: z.x * s, y: z.y * s });
    } else {
      pts.push({ x: z.x, y: z.y });
    }
  }

  // Force exact start at P to guarantee passing through the user point
  pts[0] = through;
  return pts;
}



/**
 * Cercle sphérique géodésique complet (devant + derrière), avec z signé.
 * Renvoie la projection (x,y) + le tableau z (même longueur).
 * Le chemin commence en 'through2' et repasse légèrement sur le début via overlapFrac.
 */
function buildSphericalCirclePath3D(center2: Vec2, through2: Vec2, R: number, samples = 720, overlapFrac = 0.06) {
  const c0 = normalize3v(liftSphereUpper(center2));
  const p0 = normalize3v(liftSphereUpper(through2));

  // direction u dans le plan tangent en c0 vers p0
  const proj = dot3(p0, c0);
  let u = { x: p0.x - proj * c0.x, y: p0.y - proj * c0.y, z: p0.z - proj * c0.z };
  u = normalize3v(u);

  // v orthonormal dans le plan tangent
  let v = cross3(c0, u);
  v = normalize3v(v);

  const total = 2 * Math.PI * (1 + overlapFrac);
  const xy: Vec2[] = [];
  const z: number[] = [];

  for (let i = 0; i <= samples; i++) {
    const th = (total * i) / samples;

    const cosR = Math.cos(R), sinR = Math.sin(R);
    const ct = Math.cos(th), st = Math.sin(th);

    const q3 = {
      x: cosR * c0.x + sinR * (ct * u.x + st * v.x),
      y: cosR * c0.y + sinR * (ct * u.y + st * v.y),
      z: cosR * c0.z + sinR * (ct * u.z + st * v.z),
    };

    xy.push({ x: q3.x, y: q3.y });
    z.push(q3.z);
  }

  // départ exact sur le point utilisateur
  xy[0] = through2;
  z[0] = liftSphereUpper(through2).z;

  return { xy, z };
}



/** Perpendiculaire sphérique à la droite (baseP,baseQ) passant par pointP : xy + z signé */


function cross3(a: any, b: any) {
  return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x };
}
function normalize3v(v: any) {
  const n = norm3(v) || 1;
  return { x: v.x/n, y: v.y/n, z: v.z/n };
}

/** Grande-cercle (droite sphérique) passant par A,B : renvoie xy + z signé */
function buildSphericalGreatCirclePath3D(A2: Vec2, B2: Vec2, samples = 720, overlapFrac = 0.06) {
  const A = normalize3v(liftSphereUpper(A2));
  const B = normalize3v(liftSphereUpper(B2));

  let n = cross3(A, B);
  const nn = norm3(n);
  if (nn < 1e-10) {
    // A et B quasi identiques/antipodaux : fallback simple
    n = { x: 0, y: 0, z: 1 };
  } else {
    n = normalize3v(n);
  }

  // base (u,v) dans le plan du grand cercle
  let u = A; // A est déjà dans le plan
  u = normalize3v(u);
  let v = cross3(n, u);
  v = normalize3v(v);

  const total = 2 * Math.PI * (1 + overlapFrac);
  const xy: Vec2[] = [];
  const z: number[] = [];

  for (let i = 0; i <= samples; i++) {
    const th = (total * i) / samples;
    const q = {
      x: Math.cos(th)*u.x + Math.sin(th)*v.x,
      y: Math.cos(th)*u.y + Math.sin(th)*v.y,
      z: Math.cos(th)*u.z + Math.sin(th)*v.z,
    };
    xy.push({ x: q.x, y: q.y });
    z.push(q.z);
  }

  xy[0] = A2; // départ exact
  return { xy, z };
}

/** Perpendiculaire sphérique à la droite (baseP,baseQ) passant par pointP */
function buildSphericalPerpendicularGreatCirclePath3D(baseP: Vec2, baseQ: Vec2, pointP: Vec2, samples = 720, overlapFrac = 0.06) {
  const A = normalize3v(liftSphereUpper(baseP));
  const B = normalize3v(liftSphereUpper(baseQ));
  const P = normalize3v(liftSphereUpper(pointP));

  // normale du plan de la droite de base
  let n0 = cross3(A, B);
  n0 = normalize3v(n0);

  // normale du plan perpendiculaire : orthogonale à n0 et à P
  let n1 = cross3(n0, P);
  const nn = norm3(n1);
  if (nn < 1e-10) {
    // point P aligné avec n0 -> cas dégénéré
    n1 = cross3(P, { x: 1, y: 0, z: 0 });
  }
  n1 = normalize3v(n1);

  // base (u,v) du grand cercle perpendiculaire, en partant de P
  let u = P;
  u = normalize3v(u);
  let v = cross3(n1, u);
  v = normalize3v(v);

  const total = 2 * Math.PI * (1 + overlapFrac);
  const xy: Vec2[] = [];
  const z: number[] = [];

  for (let i = 0; i <= samples; i++) {
    const th = (total * i) / samples;
    const q = {
      x: Math.cos(th)*u.x + Math.sin(th)*v.x,
      y: Math.cos(th)*u.y + Math.sin(th)*v.y,
      z: Math.cos(th)*u.z + Math.sin(th)*v.z,
    };
    xy.push({ x: q.x, y: q.y });
    z.push(q.z);
  }

  xy[0] = pointP;
  return { xy, z };
}


/* ---------- Exact distances ---------- */
function liftSphereUpper(p: Vec2) {
  const r2 = p.x * p.x + p.y * p.y;
  const z = Math.sqrt(Math.max(0, 1 - r2));
  return { x: p.x, y: p.y, z };
}
function dot3(a: any, b: any) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function norm3(a: any) {
  return Math.hypot(a.x, a.y, a.z);
}

function distanceExact(space: SpaceId, A: Vec2, B: Vec2) {
  if (space === "E") return euclidLen(A, B);
  if (space === "H") {
    // hyperbolic distance in Poincaré disk (exact)
    const a2 = A.x * A.x + A.y * A.y;
    const b2 = B.x * B.x + B.y * B.y;
    const dx = A.x - B.x;
    const dy = A.y - B.y;
    const d2 = dx * dx + dy * dy;
    const denom = (1 - a2) * (1 - b2);
    if (denom <= 0) return Infinity;
    const arg = 1 + (2 * d2) / denom;
    return Math.acosh(Math.max(1, arg));
  }
  // sphere: angle on unit sphere (exact)
  const a = liftSphereUpper(A);
  const b = liftSphereUpper(B);
  const da = norm3(a) || 1;
  const db = norm3(b) || 1;
  const cos = clamp(dot3(a, b) / (da * db), -1, 1);
  return Math.acos(cos); // radians on unit sphere
}

function geodesicMidpointExact(space: SpaceId, A: Vec2, B: Vec2): Vec2 {
  if (space === "E") {
    return { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  }

  if (space === "H") {
    const b0 = mobiusAdd({ x: -A.x, y: -A.y }, B);
    const r = Math.hypot(b0.x, b0.y);
    if (r < 1e-12) return A;

    const u = { x: b0.x / r, y: b0.y / r };
    const rr = Math.min(r, 0.999999);
    const rho = Math.tanh(0.5 * Math.atanh(rr));
    const m0 = { x: u.x * rho, y: u.y * rho };
    const M = mobiusAdd(A, m0);
    const m2 = M.x * M.x + M.y * M.y;
    if (m2 >= 0.999999) {
      const s = 0.999999 / Math.sqrt(m2);
      return { x: M.x * s, y: M.y * s };
    }
    return M;
  }

  const a = liftSphereUpper(A);
  const b = liftSphereUpper(B);
  const sum = { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  const n = norm3(sum);
  if (n < 1e-10) {
    const pts = geodesicBetween(space, A, B, 800);
    return pts[Math.floor(pts.length / 2)] ?? { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  }
  return { x: sum.x / n, y: sum.y / n };
}

function angleHand(space: SpaceId, A: Vec2, B: Vec2, C: Vec2) {
  if (space === "S") {
    // spherical angle at B via tangents in tangent plane at B
    const b3 = liftSphereUpper(B);
    const a3 = liftSphereUpper(A);
    const c3 = liftSphereUpper(C);

    const projTangent = (p3: any) => {
      const k = dot3(p3, b3) / (dot3(b3, b3) || 1);
      const t = { x: p3.x - k * b3.x, y: p3.y - k * b3.y, z: p3.z - k * b3.z };
      const n = norm3(t) || 1;
      return { x: t.x / n, y: t.y / n, z: t.z / n };
    };

    const u = projTangent(a3);
    const v = projTangent(c3);
    const cos = clamp(dot3(u, v), -1, 1);
    return Math.acos(cos);
  }

  if (space === "H") {
    const t1 = hyperbolicTangentAtVertex(B, A);
    const t2 = hyperbolicTangentAtVertex(B, C);
    return angleBetweenDirs(t1, t2);
  }

  // Euclid:
  const u = { x: A.x - B.x, y: A.y - B.y };
  const v = { x: C.x - B.x, y: C.y - B.y };
  return angleBetweenDirs(u, v);
}

function cloneAny<T>(x: T): T {
  // @ts-ignore
  if (typeof structuredClone === "function") return structuredClone(x);
  return JSON.parse(JSON.stringify(x));
}

/* ---------------- Persistent objects ---------------- */
type GeoPoint = { id: string; label: string; p: Vec2 };
type SegmentMeta = {
  id: string;
  A: string;
  B: string;
  a: Vec2;
  b: Vec2;
  poly: Vec2[];
};
type CircleMeta = {
  id: string;
  center: GeoPoint;
  point: GeoPoint;
  radius: number;
  poly: Vec2[];
  z?: number[];   // <-- ajouté
};
type TriangleType = "ANY" | "ISOSCELES" | "EQUILATERAL" | "RIGHT";
type TriangleMeta = {
  id: string;
  type: TriangleType;
  A: GeoPoint;
  B: GeoPoint;
  C: GeoPoint;
};


/* ---------------- Stored lines (true geodesic lines) ---------------- */
type LineObject = {
  id: string;
  pts: Vec2[];
  baseP: Vec2;
  baseQ: Vec2;
  space: SpaceId;
  z?: number[]; // pour l'espace S : signe z (même longueur que pts)
};

type PointMode = "EXISTING" | "NEW";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /* engine */
  const [space, setSpace] = useState<SpaceId>("E");
  const stateRef = useRef<EngineState>(createInitialState("E"));
  const [renderState, setRenderState] = useState<EngineState>(() => stateRef.current);

  /* UI params */
  const [animSpeed, setAnimSpeed] = useState(0.9);

  /* sphere display toggle */
  const [sphereInDegrees, setSphereInDegrees] = useState(true);

  /* Commands UI */
  const [pointMode, setPointMode] = useState<PointMode>("NEW");

  const [lineCmd, setLineCmd] = useState<"LINE_2PTS" | "PARALLEL" | "PERPENDICULAR">("LINE_2PTS");

  const [figureCmd, setFigureCmd] = useState<"TRIANGLE" | "CIRCLE">("TRIANGLE");
  const [triangleType, setTriangleType] = useState<TriangleType>("ANY");

  const [segmentCmd, setSegmentCmd] = useState<"SEGMENT" | "SPECIAL" | "MIDPOINT">("SEGMENT");
  const [segmentSpecial, setSegmentSpecial] = useState<"ALTITUDE" | "RADIUS" | "DIAMETER">("RADIUS");
  const [showLengths, setShowLengths] = useState(false);
  // layout des étiquettes de longueur (recalculé à l’activation de "Afficher toutes les longueurs")
  const [lenLabelPos, setLenLabelPos] = useState<Record<string, Vec2>>({});

  const [angleDeg, setAngleDeg] = useState(60);
  const [showAngles, setShowAngles] = useState(false);

  // Recalcule une disposition lisible des étiquettes lorsqu’on active l’affichage des longueurs.
  // (L’utilisateur peut décocher / recocher pour recalculer.)
  useEffect(() => {
    if (!showLengths) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const vp = makeViewport(canvas.width, canvas.height, 1.25);

    const rects: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const nextPos: Record<string, Vec2> = {};

    const rectIntersects = (a: any, b: any) =>
      !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);

    const distPointToSegScreen = (p: Vec2, a: Vec2, b: Vec2) => {
      const abx = b.x - a.x, aby = b.y - a.y;
      const apx = p.x - a.x, apy = p.y - a.y;
      const ab2 = abx * abx + aby * aby;
      if (ab2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
      let t = (apx * abx + apy * aby) / ab2;
      t = clamp(t, 0, 1);
      const q = { x: a.x + t * abx, y: a.y + t * aby };
      return Math.hypot(p.x - q.x, p.y - q.y);
    };

    // Pré-calcule toutes les polylines segments (en coordonnées écran) pour tester les collisions.
    const segPolysScreen = segments.map((S) => S.poly.map((pt) => worldToScreen(vp, pt)));

    const minDistToAnySegmentPx = (pScreen: Vec2) => {
      let best = Infinity;
      for (const poly of segPolysScreen) {
        for (let i = 0; i < poly.length - 1; i++) {
          const d = distPointToSegScreen(pScreen, poly[i], poly[i + 1]);
          if (d < best) best = d;
        }
      }
      return best;
    };

    // options candidates
    const offs = [0.06, -0.06, 0.10, -0.10, 0.14, -0.14, 0.18, -0.18, 0.22, -0.22];
    const shifts = [0, 0.05, -0.05, 0.10, -0.10];

    // même police que dans drawSegmentLabel
    ctx.font = "14px ui-sans-serif, system-ui";

    for (let si = 0; si < segments.length; si++) {
      const S = segments[si];

      // texte (approx) pour les dimensions
      const d = distanceExact(space, S.a, S.b);
      const textAB = `${S.A}${S.B}`;
      const text = `${textAB} = ${formatDistance(d)}`;
      const w = ctx.measureText(text).width;
      const h = 18; // approx

      const midIdx = Math.floor(S.poly.length / 2);
      const mid = S.poly[midIdx] ?? { x: (S.a.x + S.b.x) / 2, y: (S.a.y + S.b.y) / 2 };

      // tangente locale (si possible)
      const p0 = S.poly[Math.max(0, midIdx - 1)] ?? S.a;
      const p1 = S.poly[Math.min(S.poly.length - 1, midIdx + 1)] ?? S.b;
      const tdir = normalize2({ x: p1.x - p0.x, y: p1.y - p0.y });
      const ndir = perp2(tdir);

      let bestCandidate: { pos: Vec2; cost: number } | null = null;

      for (const o of offs) {
        for (const sh of shifts) {
          const posW = { x: mid.x + ndir.x * o + tdir.x * sh, y: mid.y + ndir.y * o + tdir.y * sh };
          if (!isValidWorldPoint(posW)) continue;

          const s = worldToScreen(vp, posW);

          // bounding box (left aligned, middle baseline)
          const pad = 6;
          const r = { x1: s.x - pad, y1: s.y - h / 2 - pad, x2: s.x + w + pad, y2: s.y + h / 2 + pad };

          // hors-cadre => pénalité
          let cost = 0;
          if (r.x1 < 0 || r.x2 > canvas.width || r.y1 < 0 || r.y2 > canvas.height) cost += 5;

          // chevauchement avec autres labels
          for (const rr of rects) {
            if (rectIntersects(r, rr)) cost += 10;
          }

          // trop près d’un segment
          const center = { x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 };
          const dseg = minDistToAnySegmentPx(center);
          if (dseg < 14) cost += (14 - dseg) / 2;

          if (!bestCandidate || cost < bestCandidate.cost) bestCandidate = { pos: posW, cost };
          if (cost === 0) break;
        }
        if (bestCandidate && bestCandidate.cost === 0) break;
      }

      const chosen = bestCandidate?.pos ?? { x: mid.x + ndir.x * 0.045, y: mid.y + ndir.y * 0.045 };
      nextPos[S.id] = chosen;

      // enregistrer rect final pour éviter chevauchement
      const s = worldToScreen(vp, chosen);
      const pad = 6;
      rects.push({ x1: s.x - pad, y1: s.y - h / 2 - pad, x2: s.x + w + pad, y2: s.y + h / 2 + pad });
    }

    setLenLabelPos(nextPos);
  }, [showLengths]);

  /* HUD */
  const [hudText, setHudText] = useState<string>("");


  /* persistent constructions */
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [lines, setLines] = useState<LineObject[]>([]);
  const [segments, setSegments] = useState<SegmentMeta[]>([]);
  const [circles, setCircles] = useState<CircleMeta[]>([]);
  const [triangles, setTriangles] = useState<TriangleMeta[]>([]);

  const pointsRef = useRef<GeoPoint[]>([]);
  const linesRef = useRef<LineObject[]>([]);
  const segmentsRef = useRef<SegmentMeta[]>([]);
  const circlesRef = useRef<CircleMeta[]>([]);
  const trianglesRef = useRef<TriangleMeta[]>([]);

  useEffect(() => void (pointsRef.current = points), [points]);
  useEffect(() => void (linesRef.current = lines), [lines]);
  useEffect(() => void (segmentsRef.current = segments), [segments]);
  useEffect(() => void (circlesRef.current = circles), [circles]);
  useEffect(() => void (trianglesRef.current = triangles), [triangles]);

  const formula = useMemo(() => spaceFormula(space), [space]);

  const isValidWorldPoint = (w: Vec2) => {
    if (space === "H") return w.x * w.x + w.y * w.y < 1;
    if (space === "S") return w.x * w.x + w.y * w.y <= 1;
    return true;
  };

  const formatDistance = (d: number) => {
    if (!isFinite(d)) return "∞";
    if (space === "S") {
      return `${(d * 10).toFixed(2)} cm`;
    }
    return `${d.toFixed(2)} cm`;
  };

  const speakThen = (fn: () => void) => {
    if (stateRef.current.anim.active) return;
    fn();
  };

  /* (c) Correct cursor mapping under CSS scaling */
  const eventToWorld = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;
    const vp = makeViewport(canvas.width, canvas.height, 1.25);
    const w = screenToWorld(vp, { x: px, y: py });
    return { w, vp };
  };

  /* ---------------- History (undo) ---------------- */
  type Snapshot = {
    engine: EngineState;
    points: GeoPoint[];
    lines: LineObject[];
    segments: SegmentMeta[];
    circles: CircleMeta[];
    triangles: TriangleMeta[];
  };
  const historyRef = useRef<Snapshot[]>([]);

  const pushSnapshot = (override?: Partial<Snapshot>) => {
    const snap: Snapshot = {
      engine: cloneAny(stateRef.current),
      points: cloneAny(pointsRef.current),
      lines: cloneAny(linesRef.current),
      segments: cloneAny(segmentsRef.current),
      circles: cloneAny(circlesRef.current),
      triangles: cloneAny(trianglesRef.current),
      ...override,
    };
    historyRef.current = [...historyRef.current, snap];
  };

  const restoreSnapshot = (snap: Snapshot) => {
    stateRef.current = cloneAny(snap.engine);
    setRenderState(stateRef.current);
    setPoints(cloneAny(snap.points));
    setLines(cloneAny(snap.lines));
    setSegments(cloneAny(snap.segments));
    setCircles(cloneAny(snap.circles));
    setTriangles(cloneAny(snap.triangles));
    setHudText("");
  };

  const undoLast = () => {
    const h = historyRef.current;
    if (h.length <= 1) return;
    const next = h.slice(0, h.length - 1);
    historyRef.current = next;
    restoreSnapshot(next[next.length - 1]);
  };

  const clearAll = () => {
    if (stateRef.current.anim.active) return;
    stateRef.current = clearShapes(stateRef.current);
    setRenderState(stateRef.current);
    setPoints([]);
    setLines([]);
    setSegments([]);
    setCircles([]);
    setTriangles([]);
    setHudText("");
    historyRef.current = [];
    pushSnapshot({ engine: cloneAny(stateRef.current), points: [], lines: [], segments: [], circles: [], triangles: [] });
  };

  /* ---------------- Reset on space change ---------------- */
  useEffect(() => {
    stateRef.current = reset(stateRef.current, space);
    setRenderState(stateRef.current);
    setHudText("");

    magicLineRef.current = null;
    setLineOpSession(null);

    setPoints([]);
    setLines([]);
    setSegments([]);
    setCircles([]);
    setTriangles([]);

    historyRef.current = [];
    pushSnapshot({ engine: cloneAny(stateRef.current), points: [], lines: [], segments: [], circles: [], triangles: [] });
  }, [space]);

  /* ---------------- Main loop ---------------- */
  const magicLineRef = useRef<{
    active: boolean;
    pts: Vec2[];
    t: number;
    finalLine?: LineObject;
  } | null>(null);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;

      const s0 = stateRef.current;
      const s1 = stepAnimation(s0, dt);
      stateRef.current = s1;

      const ml = magicLineRef.current;
      if (ml && ml.active) {
        ml.t = clamp(ml.t + dt / 0.45, 0, 1);
        if (ml.t >= 1) {
          ml.active = false;
          if (ml.finalLine) {
            setLines((prev) => {
              const next = [...prev, ml.finalLine!];
              // snapshot after commit
              pushSnapshot({ lines: cloneAny(next) });
              return next;
            });
          }
        }
      }

      setRenderState(s1);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ---------------- Points ---------------- */
  const pointLabelCounterRef = useRef(0);
  const nextPointLabel = () => {
    const n = pointLabelCounterRef.current++;
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (n < 26) return letters[n];
    const base = letters[n % 26];
    const k = Math.floor(n / 26);
    return `${base}${k}`;
  };

  const pickPointAt = (w: Vec2) => {
    const thr2 = 0.0025; // ~0.05^2
    let best: { p: GeoPoint; d2: number } | null = null;
    for (const P of pointsRef.current) {
      const d = dist2(P.p, w);
      if (d < thr2 && (!best || d < best.d2)) best = { p: P, d2: d };
    }
    return best?.p ?? null;
  };

  const createPoint = (p: Vec2) => {
    const pt: GeoPoint = { id: `P_${Date.now()}_${Math.random()}`, label: nextPointLabel(), p };
    setPoints((prev) => [...prev, pt]);
    return pt;
  };

  const getOrCreatePoint = (w: Vec2, allowCreate: boolean) => {
    const picked = pickPointAt(w);
    if (picked) return picked;
    if (!allowCreate) return null;
    return createPoint(w);
  };

  /* ---------------- Point input session ---------------- */
  type PointSession = {
    needed: number;
    allowCreate: boolean;
    collected: GeoPoint[];
    createdIds: Set<string>;
    onDone: (pts: GeoPoint[], createdIds: Set<string>) => void;
  };
  const pointSessionRef = useRef<PointSession | null>(null);
  const [isPointInput, setIsPointInput] = useState(false);

  const startPointSession = (needed: number, allowCreate: boolean, hud: string, onDone: PointSession["onDone"]) => {
    if (stateRef.current.anim.active) return;
    pointSessionRef.current = { needed, allowCreate, collected: [], createdIds: new Set(), onDone };
    setIsPointInput(true);
    setHudText(hud);
  };
  const stopPointSession = () => {
    pointSessionRef.current = null;
    setIsPointInput(false);
    setHudText("");
  };

  /* ---------------- Line operation session ---------------- */
  type LineOp = "PARALLEL" | "PERPENDICULAR";
  type LineOpSession = {
    op: LineOp;
    step: 1 | 2;
    allowCreate: boolean;
    baseLine: LineObject | null;
  };
  const [lineOpSession, setLineOpSession] = useState<LineOpSession | null>(null);

  const pickLineAt = (w: Vec2) => {
    const thr = 0.035;
    let best: { line: LineObject; d: number } | null = null;
    for (const L of linesRef.current) {
      if (L.space !== space) continue;
      const pts = L.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distPointToSegment(w, pts[i], pts[i + 1]);
        if (d < thr && (!best || d < best.d)) best = { line: L, d };
      }
    }
    return best?.line ?? null;
  };

  /* ---------------- Segment picking (for midpoint split) ---------------- */
  const pickSegmentMetaAt = (w: Vec2) => {
    const thr = 0.035;
    let best: { seg: SegmentMeta; d: number } | null = null;

    for (const S of segmentsRef.current) {
      const pts = S.poly;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distPointToSegment(w, pts[i], pts[i + 1]);
        if (d < thr && (!best || d < best.d)) best = { seg: S, d };
      }
    }
    return best?.seg ?? null;
  };

  /* ---------------- Drawing helpers (actions) ---------------- */
  const traceSingleGeodesic = (a: Vec2, b: Vec2, onDone: () => void) => {
    const frog = frogWorldPos(stateRef.current);
    // Move to start without trace
    stateRef.current = animatePath(stateRef.current, [frog, a], animSpeed, false);

    const path = geodesicBetween(space, a, b, 260);

    const timer = window.setInterval(() => {
      if (stateRef.current.anim.active) return;

      // IMPORTANT: on ne doit démarrer le tracé qu'une seule fois
      window.clearInterval(timer);

      stateRef.current = startTracing(stateRef.current, "#0f172a", 3);
      stateRef.current = animatePath(stateRef.current, path, animSpeed, true);

      const t2 = window.setInterval(() => {
        if (stateRef.current.anim.active) return;
        window.clearInterval(t2);
        stateRef.current = finishTracing(stateRef.current);
        setRenderState(stateRef.current);
        onDone();
      }, 25);
    }, 25);
  };

  const tracePolylineClosed = (pts: Vec2[], onDone: () => void) => {
    if (pts.length < 2) return;
    const frog = frogWorldPos(stateRef.current);
    stateRef.current = animatePath(stateRef.current, [frog, pts[0]], animSpeed, false);

    const closed = [...pts, pts[0]];
    let phase: "MOVE" | "TRACE" = "MOVE";
    let i = 0;

    const timer = window.setInterval(() => {
      if (stateRef.current.anim.active) return;

      if (phase === "MOVE") {
        stateRef.current = startTracing(stateRef.current, "#0f172a", 3);
        phase = "TRACE";
      }

      if (i >= closed.length - 1) {
        stateRef.current = finishTracing(stateRef.current);
        setRenderState(stateRef.current);
        window.clearInterval(timer);
        onDone();
        return;
      }

      const a = closed[i];
      const b = closed[i + 1];
      const path = geodesicBetween(space, a, b, 260);
      stateRef.current = animatePath(stateRef.current, path, animSpeed, true);
      i++;
    }, 25);
  };

  const createSegmentMeta = (A: GeoPoint, B: GeoPoint, poly: Vec2[]) => {
    const id = `S_${Date.now()}_${Math.random()}`;
    const meta: SegmentMeta = { id, A: A.label, B: B.label, a: A.p, b: B.p, poly };
    setSegments((prev) => [...prev, meta]);
    return meta;
  };

  const createTriangleMeta = (type: TriangleType, A: GeoPoint, B: GeoPoint, C: GeoPoint) => {
    const t: TriangleMeta = { id: `T_${Date.now()}_${Math.random()}`, type, A, B, C };
    setTriangles((prev) => [...prev, t]);
    return t;
  };

  const createCircleMeta = (
    center: GeoPoint,
    point: GeoPoint,
    radius: number,
    poly: Vec2[],
    z?: number[]
  ) => {
    const c: CircleMeta = { id: `C_${Date.now()}_${Math.random()}`, center, point, radius, poly, z };
    setCircles((prev) => [...prev, c]);
    return c;
  };

  /* ---------------- On canvas click ---------------- */
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { w } = eventToWorld(e);
    if (!isValidWorldPoint(w)) return;

    // Point input session
    if (isPointInput && pointSessionRef.current) {
      const sess = pointSessionRef.current;
      const picked = pickPointAt(w);
      let pt: GeoPoint | null = picked;

      if (!pt) {
        if (!sess.allowCreate) return;
        pt = createPoint(w);
        sess.createdIds.add(pt.id);
      }

      if (sess.collected.some((x) => x.id === pt!.id)) return;
      sess.collected.push(pt);

      setHudText(`${sess.collected.length}/${sess.needed} point(s) sélectionné(s)`);

      if (sess.collected.length >= sess.needed) {
        const pts = [...sess.collected];
        const created = new Set(sess.createdIds);
        const cb = sess.onDone;
        stopPointSession();
        cb(pts, created);
      }
      return;
    }

    // Line operation session (parallel/perp)
    if (lineOpSession) {
      if (lineOpSession.step === 1) {
        const L = pickLineAt(w);
        if (!L) return;
        setLineOpSession({ ...lineOpSession, step: 2, baseLine: L });
        setHudText("Étape 2 : clique un point (ou un point existant).");
        return;
      }

      const base = lineOpSession.baseLine;
      if (!base) return;

      const P = getOrCreatePoint(w, lineOpSession.allowCreate);
      if (!P) return;

      speakThen(() => {
        const target = P.p;
        const frog = frogWorldPos(stateRef.current);
        stateRef.current = animatePath(stateRef.current, [frog, target], animSpeed, false);

        const timer = window.setInterval(() => {
          if (stateRef.current.anim.active) return;

          let pts: Vec2[] = [];
          let zLine: number[] | undefined = undefined;
          if (space === "E") {
            const d = { x: base.baseQ.x - base.baseP.x, y: base.baseQ.y - base.baseP.y };
            const u = normalize2(d);

            if (lineOpSession.op === "PERPENDICULAR") {
              const n = perp2(u);
              const big = 5;
              pts = [
                { x: target.x - n.x * big, y: target.y - n.y * big },
                { x: target.x + n.x * big, y: target.y + n.y * big },
              ];
            } else {
              const big = 5;
              pts = [
                { x: target.x - u.x * big, y: target.y - u.y * big },
                { x: target.x + u.x * big, y: target.y + u.y * big },
              ];
            }
          } else if (space === "H") {
            if (lineOpSession.op === "PERPENDICULAR") {
              pts = hyperbolicPerpendicularThroughPoint(base.baseP, base.baseQ, target, 560);
            } else {
              pts = hyperbolicParallelThroughPoint(base.baseP, base.baseQ, target, 0, 560);
            }
          } else {
            if (lineOpSession.op === "PERPENDICULAR") {
              const out = buildSphericalPerpendicularGreatCirclePath3D(base.baseP, base.baseQ, target, 720, 0.06);
              pts = out.xy;
              zLine = out.z;
            } else {
              // Not supported on sphere in this version
              setHudText("Parallèle non disponible dans l’espace C.");
              setLineOpSession(null);
              window.clearInterval(timer);
              return;
            }
          }

          if (pts.length < 2) {
            setHudText("Opération impossible à l’endroit indiqué.");
            setLineOpSession(null);
            window.clearInterval(timer);
            return;
          }

          const id = `Op_${Date.now()}`;
          magicLineRef.current = {
            active: true,
            pts,
            t: 0,
            finalLine: { id, pts, baseP: pts[0], baseQ: pts[pts.length - 1], space, z: zLine },
          };

          setLineOpSession(null);
          setHudText("");
          window.clearInterval(timer);
        }, 25);
      });

      return;
    }

    // Segment midpoint split picking
    if (segmentCmd === "MIDPOINT" && hudText.startsWith("Clique un segment")) {
      const S = pickSegmentMetaAt(w);
      if (!S) return;

      // Create intrinsic midpoint on the geodesic segment
      const mid = geodesicMidpointExact(space, S.a, S.b);
      if (!isValidWorldPoint(mid)) return;

      const M = createPoint(mid);

      // Replace meta by two metas (labels may overlap, but it matches "scinder")
      const A = pointsRef.current.find((p) => p.label === S.A);
      const B = pointsRef.current.find((p) => p.label === S.B);
      if (A && B) {
        const poly1 = geodesicBetween(space, A.p, M.p, 160);
        const poly2 = geodesicBetween(space, M.p, B.p, 160);
        setSegments((prev) => {
          const without = prev.filter((x) => x.id !== S.id);
          const s1: SegmentMeta = { id: `S_${Date.now()}_${Math.random()}`, A: A.label, B: M.label, a: A.p, b: M.p, poly: poly1 };
          const s2: SegmentMeta = { id: `S_${Date.now()}_${Math.random()}`, A: M.label, B: B.label, a: M.p, b: B.p, poly: poly2 };
          const next = [...without, s1, s2];
          return next;
        });
      }

      pushSnapshot();
      setHudText("");
      return;
    }
  };

  /* ---------------- Actions triggered by UI ---------------- */
  const validateLines = () => {
    const allowCreate = pointMode === "NEW";

    if (lineCmd === "LINE_2PTS") {
      startPointSession(2, allowCreate, "Droite : sélectionne 2 points.", (pts) => {
        speakThen(() => {
          const [A, B] = pts;
          const mid = { x: (A.p.x + B.p.x) / 2, y: (A.p.y + B.p.y) / 2 };
          const frog = frogWorldPos(stateRef.current);
          stateRef.current = animatePath(stateRef.current, [frog, mid], animSpeed, false);

          const timer = window.setInterval(() => {
            if (stateRef.current.anim.active) return;

            let poly: Vec2[] = [];
            let zLine: number[] | undefined = undefined;

            if (space === "S") {
              const out = buildSphericalGreatCirclePath3D(A.p, B.p, 720, 0.06);
              poly = out.xy;
              zLine = out.z;
            } else {
              poly = geodesicLineThrough(space, A.p, B.p, 720);
            }
            const id = `L_${Date.now()}`;
            magicLineRef.current = {
              active: true,
              pts: poly,
              t: 0,
              finalLine: { id, pts: poly, baseP: A.p, baseQ: B.p, space, z: zLine },
            };

            window.clearInterval(timer);
          }, 25);
        });
      });
      return;
    }

    // Parallel / perpendicular
    const op: LineOp = lineCmd === "PARALLEL" ? "PARALLEL" : "PERPENDICULAR";
    setLineOpSession({ op, step: 1, allowCreate, baseLine: null });
    setHudText("Étape 1 : clique une droite existante.");
  };

  const applyTriangleType = (type: TriangleType, A: GeoPoint, B: GeoPoint, C: GeoPoint, createdIds: Set<string>) => {
    // Only move C if it was created during this command (to avoid moving an existing point unexpectedly)
    const canMoveC = createdIds.has(C.id);
    if (!canMoveC) return C;

    const a = A.p,
      b = B.p,
      c0 = C.p;

    let c = c0;

    if (type === "ISOSCELES") {
      // project onto perpendicular bisector of AB (Euclidean in model coords)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = { x: b.x - a.x, y: b.y - a.y };
      const n = perp2(d);
      const nn = dot2(n, n) || 1;
      const t = dot2({ x: c0.x - mid.x, y: c0.y - mid.y }, n) / nn;
      c = { x: mid.x + n.x * t, y: mid.y + n.y * t };
    } else if (type === "EQUILATERAL") {
      const ab = { x: b.x - a.x, y: b.y - a.y };
      const c1 = { x: a.x + rotate2D(ab, 60).x, y: a.y + rotate2D(ab, 60).y };
      const c2 = { x: a.x + rotate2D(ab, -60).x, y: a.y + rotate2D(ab, -60).y };
      // choose side based on click (c0)
      const side = Math.sign(cross2(ab, { x: c0.x - a.x, y: c0.y - a.y })) || 1;
      c = side >= 0 ? c1 : c2;
      if (!isValidWorldPoint(c)) c = side >= 0 ? c2 : c1;
    } else if (type === "RIGHT") {
      if (space === "E") {
        // --- ton ancien code euclidien (Thalès) ---
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const r = euclidLen(a, b) / 2;
        const dir = normalize2({ x: c0.x - mid.x, y: c0.y - mid.y });
        c = { x: mid.x + dir.x * r, y: mid.y + dir.y * r };
      } else {
        // --- H ou S : on ajuste C pour que l'angle A C B = 90° (intrinsèque) ---
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

        let dir = { x: c0.x - mid.x, y: c0.y - mid.y };
        const nd = Math.hypot(dir.x, dir.y);
        if (nd < 1e-8) {
          // si l'utilisateur clique pile sur le milieu, on prend une direction perpendiculaire à AB
          const ab = { x: b.x - a.x, y: b.y - a.y };
          dir = perp2(ab);
        }
        dir = normalize2(dir);

        // borne max t pour rester dans le domaine (disque / hémisphère)
        const r2max = space === "H" ? 0.9995 : 1.0; // marge sécurité en H
        const mm = mid.x * mid.x + mid.y * mid.y;
        const md = mid.x * dir.x + mid.y * dir.y;
        const disc = md * md + (r2max - mm);
        if (disc <= 0) return C; // pas de place

        const tMax = Math.max(0.001, -md + Math.sqrt(disc));

        const f = (t: number) => {
          const Ct = { x: mid.x + dir.x * t, y: mid.y + dir.y * t };
          if (!isValidWorldPoint(Ct)) return NaN;
          // angle au sommet C : angleHand calcule l'angle au 2e argument
          const ang = angleHand(space, a, Ct, b);
          return ang - Math.PI / 2;
        };

        // on cherche un intervalle [lo,hi] où f change de signe
        let lo = 0.001;
        let hi = tMax;
        let flo = f(lo);
        let fhi = f(hi);

        // si pas de changement de signe, on échantillonne pour trouver un bracket
        if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) {
          let found = false;
          const N = 40;
          let prevT = lo;
          let prevF = flo;
          for (let i = 1; i <= N; i++) {
            const t = lo + ((hi - lo) * i) / N;
            const ft = f(t);
            if (isFinite(prevF) && isFinite(ft) && prevF * ft <= 0) {
              lo = prevT; flo = prevF;
              hi = t;     fhi = ft;
              found = true;
              break;
            }
            prevT = t;
            prevF = ft;
          }
          if (!found) {
            // fallback : on garde le point euclidien "à peu près"
            const guess = { x: mid.x + dir.x * (tMax * 0.6), y: mid.y + dir.y * (tMax * 0.6) };
            c = isValidWorldPoint(guess) ? guess : c0;
          } else {
            // bisection
            for (let it = 0; it < 45; it++) {
              const m = 0.5 * (lo + hi);
              const fm = f(m);
              if (!isFinite(fm)) { hi = m; continue; }
              if (flo * fm <= 0) { hi = m; fhi = fm; }
              else { lo = m; flo = fm; }
            }
            c = { x: mid.x + dir.x * hi, y: mid.y + dir.y * hi };
          }
        } else {
          // bracket direct, bisection
          for (let it = 0; it < 45; it++) {
            const m = 0.5 * (lo + hi);
            const fm = f(m);
            if (!isFinite(fm)) { hi = m; continue; }
            if (flo * fm <= 0) { hi = m; fhi = fm; }
            else { lo = m; flo = fm; }
          }
          c = { x: mid.x + dir.x * hi, y: mid.y + dir.y * hi };
        }
      }
    }

    if (!isValidWorldPoint(c)) return C;

    // update stored point position
    setPoints((prev) => prev.map((p) => (p.id === C.id ? { ...p, p: c } : p)));
    return { ...C, p: c };
  };

  const validateFigures = () => {
    const allowCreate = pointMode === "NEW";

    if (figureCmd === "CIRCLE") {
      startPointSession(
        2,
        allowCreate,
        "Cercle : sélectionne 2 points (centre O, puis point P sur le cercle).",
        (pts) => {
          speakThen(() => {
            const [O, P] = pts;
            const R = distanceExact(space, O.p, P.p);

            // 1) Aller au centre (sans tracer)
            const frog = frogWorldPos(stateRef.current);
            stateRef.current = animatePath(stateRef.current, [frog, O.p], animSpeed, false);

            const tCenter = window.setInterval(() => {
              if (stateRef.current.anim.active) return;
              window.clearInterval(tCenter);

              // On génère un cercle "complet" via buildCircleTrace (autour de O)
              const { path, traceColor } = buildCircleTrace(stateRef.current, R);

              // 2) Extraire la partie "cercle" (distance intrinsèque ~ R), PAS le rayon
              const dToCenter = path.map((pt) => distanceExact(space, O.p, pt));
              const thr = R * 0.985;

              let startIdx = dToCenter.findIndex((d) => d >= thr);
              if (startIdx < 0) startIdx = 0;

              let endIdx = path.length - 1;
              while (endIdx > startIdx && dToCenter[endIdx] < thr) endIdx--;

              let circleRaw = path.slice(startIdx, endIdx + 1);
              if (circleRaw.length < 8) circleRaw = path.slice(); // fallback

              // 3) Faire commencer le cercle au point P (au plus proche)
              let bestI = 0;
              let bestD = Infinity;
              for (let i = 0; i < circleRaw.length; i++) {
                const d = dist2(circleRaw[i], P.p);
                if (d < bestD) {
                  bestD = d;
                  bestI = i;
                }
              }
              const circleRot = [...circleRaw.slice(bestI), ...circleRaw.slice(0, bestI)];

              // 4) Chemin de tracé :
              //    - commence EXACTEMENT en P
              //    - fait un tour complet
              //    - repasse légèrement sur le début (overlap)
              const overlapN = Math.min(12, Math.max(2, Math.floor(circleRot.length * 0.05)));

              // --- À partir d'ici, on construit tracePath différemment selon l'espace ---
              
              let tracePath: Vec2[] = [];
              let circleZ: number[] | undefined = undefined;

              if (space === "H") {
                // ✅ vrai cercle hyperbolique (distance géodésique constante), qui passe par P
                tracePath = buildHyperbolicCirclePath(O.p, P.p, R, 720, 0.06);
              } else if (space === "S") {
                // ✅ cercle sphérique géodésique complet (devant + derrière) + z pour pointillés
                const sph = buildSphericalCirclePath3D(O.p, P.p, R, 720, 0.06);
                tracePath = sph.xy;
                circleZ = sph.z;
              } else {
                // espace euclidien : cercle du moteur, réordonné pour commencer sur P + overlap
                tracePath = [P.p, ...circleRot, P.p, ...circleRot.slice(0, overlapN)];
              }
// 5) Aller en P sans tracer (pour "démarrer au point donné")
              stateRef.current = animatePath(stateRef.current, [O.p, P.p], animSpeed, false);

              const tToP = window.setInterval(() => {
                if (stateRef.current.anim.active) return;
                window.clearInterval(tToP);

                // 6) Tracer uniquement le cercle (pas de rayon)
                if (space === "S") {
                  // en sphère : pas de tracé engine (pour pouvoir faire pointillés derrière)
                  stateRef.current = animatePath(stateRef.current, tracePath, animSpeed, false);
                } else {
                  stateRef.current = startTracing(stateRef.current, traceColor, 3);
                  stateRef.current = animatePath(stateRef.current, tracePath, animSpeed, true);
                }

                const tDone = window.setInterval(() => {
                  if (stateRef.current.anim.active) return;
                  window.clearInterval(tDone);

                  if (space !== "S") {
                    stateRef.current = finishTracing(stateRef.current);
                  }
                  setRenderState(stateRef.current);

                  if (space === "S") createCircleMeta(O, P, R, tracePath, circleZ);
                  else createCircleMeta(O, P, R, tracePath);

                  pushSnapshot();
                }, 25);
              }, 25);
            }, 25);
          });
        }
      );
      return;
    }

    // Triangle
    startPointSession(3, allowCreate, "Triangle : sélectionne 3 points (A, B, C).", (pts, created) => {
      speakThen(() => {
        let [A, B, C] = pts;
        // apply triangle type by adjusting C when possible
        const C2 = applyTriangleType(triangleType, A, B, C, created);
        C = C2;

        const polyPts = [A.p, B.p, C.p];

        // Build segment metas (for lengths) and triangle meta
        createTriangleMeta(triangleType, A, B, C);
        createSegmentMeta(A, B, geodesicBetween(space, A.p, B.p, 260));
        createSegmentMeta(B, C, geodesicBetween(space, B.p, C.p, 260));
        createSegmentMeta(C, A, geodesicBetween(space, C.p, A.p, 260));

        tracePolylineClosed(polyPts, () => {
          pushSnapshot();
        });
      });
    });
  };

  const validateSegments = () => {
    const allowCreate = pointMode === "NEW";

    if (segmentCmd === "MIDPOINT") {
      setHudText("Clique un segment existant pour créer son milieu.");
      return;
    }

    if (segmentCmd === "SEGMENT") {
      startPointSession(2, allowCreate, "Segment : sélectionne 2 points (A, B).", (pts) => {
        speakThen(() => {
          const [A, B] = pts;
          const poly = geodesicBetween(space, A.p, B.p, 260);
          createSegmentMeta(A, B, poly);
          traceSingleGeodesic(A.p, B.p, () => pushSnapshot());
        });
      });
      return;
    }

    // SPECIAL
    if (segmentSpecial === "ALTITUDE") {
      startPointSession(3, allowCreate, "Hauteur : sélectionne 3 points (A, B, C). La hauteur sera issue de C sur (AB).", (pts) => {
        speakThen(() => {
          const [A, B, C] = pts;
          // Euclidean foot of perpendicular from C to line AB (in model coords)
          const ab = { x: B.p.x - A.p.x, y: B.p.y - A.p.y };
          const t = dot2({ x: C.p.x - A.p.x, y: C.p.y - A.p.y }, ab) / (dot2(ab, ab) || 1);
          const Fp = { x: A.p.x + ab.x * t, y: A.p.y + ab.y * t };
          if (!isValidWorldPoint(Fp)) {
            setHudText("Hauteur impossible à cet endroit.");
            return;
          }
          const F = createPoint(Fp);
          const poly = geodesicBetween(space, C.p, F.p, 260);
          createSegmentMeta(C, F, poly);
          traceSingleGeodesic(C.p, F.p, () => pushSnapshot());
        });
      });
      return;
    }

    if (segmentSpecial === "RADIUS") {
      startPointSession(2, allowCreate, "Rayon : sélectionne 2 points (centre O, point P).", (pts) => {
        speakThen(() => {
          const [O, P] = pts;
          const poly = geodesicBetween(space, O.p, P.p, 260);
          createSegmentMeta(O, P, poly);
          traceSingleGeodesic(O.p, P.p, () => pushSnapshot());
        });
      });
      return;
    }

    if (segmentSpecial === "DIAMETER") {
      startPointSession(2, allowCreate, "Diamètre : sélectionne 2 points (centre O, point P).", (pts) => {
        speakThen(() => {
          const [O, P] = pts;
          const Qp = { x: 2 * O.p.x - P.p.x, y: 2 * O.p.y - P.p.y };
          if (!isValidWorldPoint(Qp)) {
            setHudText("Diamètre impossible à cet endroit.");
            return;
          }
          const Q = createPoint(Qp);
          const poly = geodesicBetween(space, P.p, Q.p, 260);
          createSegmentMeta(P, Q, poly);
          traceSingleGeodesic(P.p, Q.p, () => pushSnapshot());
        });
      });
      return;
    }
  };

  const validateAngles = () => {
    const allowCreate = pointMode === "NEW";

    startPointSession(2, allowCreate, "Angle : sélectionne A puis B (sommet). C sera construit automatiquement.", (pts) => {
      speakThen(() => {
        const [A, B] = pts;

        const BA = { x: A.p.x - B.p.x, y: A.p.y - B.p.y };
        const u0 = normalize2(BA);

        const dir = rotate2D(u0, angleDeg);
        const L = Math.max(0.45, euclidLen(A.p, B.p)); // visual length in model coords
        const Cp = { x: B.p.x + dir.x * L, y: B.p.y + dir.y * L };

        if (!isValidWorldPoint(Cp)) {
          setHudText("Construction de l’angle impossible à cet endroit.");
          return;
        }

        const C = createPoint(Cp);

        // store segment metas (for lengths)
        createSegmentMeta(B, A, geodesicBetween(space, B.p, A.p, 260));
        createSegmentMeta(B, C, geodesicBetween(space, B.p, C.p, 260));

        // Trace rays: B->A then B->C
        const frog = frogWorldPos(stateRef.current);
        stateRef.current = animatePath(stateRef.current, [frog, B.p], animSpeed, false);

        let phase: "MOVE" | "TRACE_BA" | "MOVE_BACK" | "TRACE_BC" = "MOVE";

        const timer = window.setInterval(() => {
          if (stateRef.current.anim.active) return;

          if (phase === "MOVE") {
            stateRef.current = startTracing(stateRef.current, "#0f172a", 3);
            phase = "TRACE_BA";
            return;
          }

          if (phase === "TRACE_BA") {
            const pathBA = geodesicBetween(space, B.p, A.p, 260);
            stateRef.current = animatePath(stateRef.current, pathBA, animSpeed, true);
            phase = "MOVE_BACK";
            return;
          }

          if (phase === "MOVE_BACK") {
            // move back to B without tracing
            stateRef.current = finishTracing(stateRef.current);
            stateRef.current = animatePath(stateRef.current, [A.p, B.p], animSpeed, false);
            phase = "TRACE_BC";
            return;
          }

          if (phase === "TRACE_BC") {
            const pathBC = geodesicBetween(space, B.p, C.p, 260);
            stateRef.current = startTracing(stateRef.current, "#0f172a", 3);
            stateRef.current = animatePath(stateRef.current, pathBC, animSpeed, true);

            window.clearInterval(timer); // IMPORTANT: sinon ça relance TRACE_BC en boucle

            const t2 = window.setInterval(() => {
              if (stateRef.current.anim.active) return;
              window.clearInterval(t2);
              stateRef.current = finishTracing(stateRef.current);
              setRenderState(stateRef.current);
              pushSnapshot();
            }, 25);
          }
        }, 25);
      });
    });
  };

  /* ---------------- Mouse move (optional hover hints) ---------------- */
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // We keep this empty for now (no hover UI requested).
    void e;
  };

  /* ---------------- Angle display for line intersections ---------------- */
  const computeLineIntersections = () => {
    const res: {
      p: Vec2;
      u1: Vec2;
      u2: Vec2;
      thetaDeg: number;
    }[] = [];

    const Ls = linesRef.current;
    if (Ls.length < 2) return res;

    const dedupThr2 = 0.0009;

    const add = (p: Vec2, u1: Vec2, u2: Vec2) => {
      // dedup
      if (res.some((x) => dist2(x.p, p) < dedupThr2)) return;
      // approximate tangent points for spherical angle
      const eps = 0.02;
      const A = { x: p.x + u1.x * eps, y: p.y + u1.y * eps };
      const C = { x: p.x + u2.x * eps, y: p.y + u2.y * eps };
      const ang = angleHand(space, A, p, C);
      const thetaDeg = (ang * 180) / Math.PI;
      res.push({ p, u1, u2, thetaDeg });
    };

    // segment-segment intersection in 2D
    const segIntersect = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
      const r = { x: b.x - a.x, y: b.y - a.y };
      const s = { x: d.x - c.x, y: d.y - c.y };
      const rxs = cross2(r, s);
      const q_p = { x: c.x - a.x, y: c.y - a.y };
      const qpxr = cross2(q_p, r);

      if (Math.abs(rxs) < 1e-10) return null; // parallel
      const t = cross2(q_p, s) / rxs;
      const u = qpxr / rxs;

      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return { x: a.x + t * r.x, y: a.y + t * r.y };
      }
      return null;
    };

    for (let i = 0; i < Ls.length; i++) {
      for (let j = i + 1; j < Ls.length; j++) {
        const A = Ls[i].pts;
        const B = Ls[j].pts;

        // find first intersection among polyline segments (good enough)
        outer: for (let a = 0; a < A.length - 1; a++) {
          for (let b = 0; b < B.length - 1; b++) {
            const p = segIntersect(A[a], A[a + 1], B[b], B[b + 1]);
            if (!p) continue;

            const u1 = normalize2({ x: A[a + 1].x - A[a].x, y: A[a + 1].y - A[a].y });
            const u2 = normalize2({ x: B[b + 1].x - B[b].x, y: B[b + 1].y - B[b].y });
            add(p, u1, u2);
            break outer;
          }
        }
      }
    }

    return res;
  };

  /* ---------------- Drawing ---------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const st = renderState;
    const vp = makeViewport(canvas.width, canvas.height, 1.25);
    const drawPolylineZ = (pts: Vec2[], z: number[] | undefined, color: string, width: number) => {
      if (pts.length < 2) return;

      const JUMP = 0.35; // même seuil que drawPolyline

      for (let i = 0; i < pts.length - 1; i++) {
        // éviter les segments parasites en cas de discontinuité
        if (euclidLen(pts[i], pts[i + 1]) > JUMP) continue;

        const A = worldToScreen(vp, pts[i]);
        const B = worldToScreen(vp, pts[i + 1]);

        const zmid = z ? (z[i] + z[i + 1]) * 0.5 : 1;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        if (zmid < 0) ctx.setLineDash([8, 8]); // derrière => pointillés
        else ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
        ctx.restore();
      }
    };
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const drawDiskBoundary = () => {
      if (st.space !== "H" && st.space !== "S") return;
      const c = worldToScreen(vp, { x: 0, y: 0 });
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, vp.scale * 1.0, 0, Math.PI * 2);
      ctx.stroke();

      if (st.space === "S") {
        ctx.fillStyle = "rgba(15,23,42,0.03)";
        ctx.beginPath();
        ctx.arc(c.x, c.y, vp.scale * 1.0, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const withDiskClip = (fn: () => void) => {
      if (st.space !== "H" && st.space !== "S") {
        fn();
        return;
      }
      ctx.save();
      const c = worldToScreen(vp, { x: 0, y: 0 });
      ctx.beginPath();
      ctx.arc(c.x, c.y, vp.scale * 1.0, 0, Math.PI * 2);
      ctx.clip();
      fn();
      ctx.restore();
    };

    const drawPolyline = (pts: Vec2[], color: string, width: number) => {
      if (pts.length < 2) return;

      const JUMP = 0.35; // seuil en coords monde (à ajuster si besoin)

      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();

      for (let i = 0; i < pts.length; i++) {
        const p = worldToScreen(vp, pts[i]);

        if (i === 0) {
          ctx.moveTo(p.x, p.y);
          continue;
        }

        const d = euclidLen(pts[i - 1], pts[i]);
        if (d > JUMP) {
          // discontinuité => on ne relie pas par un segment droit
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }

      ctx.stroke();
    };

    const drawPoint = (pW: Vec2, label: string, color: string) => {
      const s = worldToScreen(vp, pW);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#0f172a";
      ctx.font = "12px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(label, s.x + 10, s.y - 10);
    };

    const drawSegmentLabel = (S: SegmentMeta) => {
      const mid = S.poly[Math.floor(S.poly.length / 2)] ?? { x: (S.a.x + S.b.x) / 2, y: (S.a.y + S.b.y) / 2 };
      const u = normalize2({ x: S.b.x - S.a.x, y: S.b.y - S.a.y });
      const n = perp2(u);
      const pos = lenLabelPos[S.id] ?? { x: mid.x + n.x * 0.045, y: mid.y + n.y * 0.045 };

      const s = worldToScreen(vp, pos);

      const d = distanceExact(space, S.a, S.b);
      const textAB = `${S.A}${S.B}`;
      const text = `${textAB} = ${formatDistance(d)}`;

      ctx.save();
      ctx.font = "14px ui-sans-serif, system-ui";
      ctx.fillStyle = "#0f172a";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      ctx.fillText(text, s.x, s.y);

      // Draw overline over AB
      const wAB = ctx.measureText(textAB).width;
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 10);
      ctx.lineTo(s.x + wAB, s.y - 10);
      ctx.stroke();

      ctx.restore();
    };

    drawDiskBoundary();

    withDiskClip(() => {
      // Custom geodesic lines
      for (const L of lines) {
        if (L.space !== space) continue;
        // Si on est en sphérique et qu’on a z[], on dessine plein/pointillé selon z
        if (space === "S" && (L as any).z) {
          drawPolylineZ(L.pts, (L as any).z, "#0f172a", 3);
        } else {
          drawPolyline(L.pts, "#0f172a", 3);
        }


      // Spherical circles: full circle with front/back (z) => pointillés derrière
      if (space === "S") {
        for (const C of circles) {
          if (C.z) drawPolylineZ(C.poly, C.z, "#0f172a", 3);
        }
      }
      }

      // Engine shapes (segments/circles/triangles traced by frog)
      const shapes: any[] = st.shapes as any[];
      for (let si = 0; si < shapes.length; si++) {
        const sh = shapes[si];
        if (sh.kind === "polyline") drawPolyline(sh.pts, sh.color, sh.width);
        if (sh.kind === "marker") {
          const p = worldToScreen(vp, sh.p);
          ctx.fillStyle = sh.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (st.inProgress?.kind === "polyline") {
        const sh: any = st.inProgress;
        drawPolyline(sh.pts, sh.color, sh.width);
      }

      // magic reveal for lines
      const ml = magicLineRef.current;
      if (ml && ml.pts.length >= 2) {
        const t = clamp(ml.t, 0, 1);
        const k = Math.max(2, Math.floor(t * ml.pts.length));
        drawPolyline(ml.pts.slice(0, k), "#0f172a", 3);
      }

      // Points
      points.forEach((p) => drawPoint(p.p, p.label, "#2563eb"));

      // Length labels
      if (showLengths) {
        segments.forEach(drawSegmentLabel);
      }

      // Angles
      if (showAngles) {
        // Triangle angles (one per vertex)
        ctx.save();
        ctx.font = "14px ui-sans-serif, system-ui";
        ctx.fillStyle = "#0f172a";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const T of triangles) {
          const A = T.A.p,
            B = T.B.p,
            C = T.C.p;

          const angleAt = (P: Vec2, Q: Vec2, R: Vec2) => {
            const ang = angleHand(space, P, Q, R);
            return (ang * 180) / Math.PI;
          };

          const showAt = (vertex: Vec2, dir: Vec2, degInt: number) => {
            const v = { x: vertex.x + dir.x * 0.11, y: vertex.y + dir.y * 0.11 };
            const s = worldToScreen(vp, v);
            ctx.fillText(`${degInt}°`, s.x, s.y);
          };

          const uAB = normalize2({ x: A.x - B.x, y: A.y - B.y });
          const uCB = normalize2({ x: C.x - B.x, y: C.y - B.y });
          const bisB = normalize2({ x: uAB.x + uCB.x, y: uAB.y + uCB.y });

          const uBA = normalize2({ x: B.x - A.x, y: B.y - A.y });
          const uCA = normalize2({ x: C.x - A.x, y: C.y - A.y });
          const bisA = normalize2({ x: uBA.x + uCA.x, y: uBA.y + uCA.y });

          const uAC = normalize2({ x: A.x - C.x, y: A.y - C.y });
          const uBC = normalize2({ x: B.x - C.x, y: B.y - C.y });
          const bisC = normalize2({ x: uAC.x + uBC.x, y: uAC.y + uBC.y });

          const degB = angleAt(A, B, C);
          const degA = angleAt(B, A, C);
          const degC = angleAt(A, C, B);

          const raw = [degA, degB, degC];
          const shown = space === "E" ? roundTriangleAnglesTo180(raw) : raw.map((x) => Math.round(x));

          // puis tu affiches en utilisant shown[]
          showAt(A, bisA, shown[0]);
          showAt(B, bisB, shown[1]);
          showAt(C, bisC, shown[2]);
        }
        ctx.restore();

        // 4 angles at line intersections
        const ints = computeLineIntersections();
        ctx.save();
        ctx.font = "13px ui-sans-serif, system-ui";
        ctx.fillStyle = "#0f172a";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        for (const it of ints) {
          const p = it.p;
          const u1 = it.u1;
          const u2 = it.u2;

          const rawTheta = clamp(it.thetaDeg, 0, 180);
          const theta = Math.abs(rawTheta - 90) <= 1 ? 90 : rawTheta;
          const other = 180 - theta;

          const b1 = normalize2({ x: u1.x + u2.x, y: u1.y + u2.y });
          const b2 = normalize2({ x: u1.x - u2.x, y: u1.y - u2.y });
          const b3 = normalize2({ x: -u1.x + u2.x, y: -u1.y + u2.y });
          const b4 = normalize2({ x: -u1.x - u2.x, y: -u1.y - u2.y });

          const r = 0.12;

          const drawVal = (dir: Vec2, val: number) => {
            const q = { x: p.x + dir.x * r, y: p.y + dir.y * r };
            const s = worldToScreen(vp, q);
            ctx.fillText(`${val.toFixed(0)}°`, s.x, s.y);
          };

          drawVal(b1, theta);
          drawVal(b4, theta);
          drawVal(b2, other);
          drawVal(b3, other);
        }
        ctx.restore();
      }
    });

    // Frog AFTER clip
    const fw = frogWorldPos(st);
    const fp = worldToScreen(vp, fw);

    ctx.font = "30px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#0f172a";
    ctx.fillText("🐸", fp.x, fp.y);

    // HUD overlay
    if (hudText) {
      ctx.save();
      ctx.font = "14px ui-sans-serif, system-ui";
      ctx.fillStyle = "rgba(15,23,42,0.75)";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(hudText, 14, 14);
      ctx.restore();
    }
  }, [renderState, space, points, lines, circles, segments, triangles, showLengths, lenLabelPos, showAngles,  hudText, animSpeed, sphereInDegrees]);

  /* UI */
  const CANVAS_W = 1320;
  const CANVAS_H = 820;

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <h1>Laboratoire de géométrie</h1>
        </div>

        <div className="space-select">
          <label>Choisir un espace</label>
          <select value={space} onChange={(e) => setSpace(e.target.value as SpaceId)}>
            <option value="E">Espace A</option>
            <option value="H">Espace B</option>
            <option value="S">Espace C</option>
          </select>

          {space === "S" && (
            <label className="tiny">
              <input type="checkbox" checked={sphereInDegrees} onChange={(e) => setSphereInDegrees(e.target.checked)} />
              Afficher les longueurs sphériques en degrés (sinon radians)
            </label>
          )}
        </div>
      </header>

      <div className="main-layout">
        <div className="left-col">
          <div className="canvas-panel">
            <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} onClick={onCanvasClick} onMouseMove={onMouseMove} />
          </div>
        </div>

        <aside className="controls-panel">

          <section className="section">
            <h2>Réglages</h2>
            <label>
              Animation : {animSpeed.toFixed(2)}
              <input type="range" min={0.4} max={2.0} step={0.05} value={animSpeed} onChange={(e) => setAnimSpeed(parseFloat(e.target.value))} />
            </label>

            <div className="card">
              <div className="tiny">Options de points</div>
              <label className="tiny">
                <input type="radio" name="pmode" checked={pointMode === "EXISTING"} onChange={() => setPointMode("EXISTING")} />
                À partir de points existants
              </label>
              <label className="tiny">
                <input type="radio" name="pmode" checked={pointMode === "NEW"} onChange={() => setPointMode("NEW")} />
                Je souhaite créer de nouveaux points
              </label>
            </div>
          </section>

          <section className="section">
            <h2>Droites</h2>
            <div className="card">
              <label>Commande</label>
              <select value={lineCmd} onChange={(e) => setLineCmd(e.target.value as any)}>
                <option value="LINE_2PTS">Tracer une droite à partir de deux points</option>
                <option value="PARALLEL">Tracer la parallèle d'une droite passant par un point</option>
                <option value="PERPENDICULAR">Tracer la perpendiculaire d'une droite passant par un point</option>
              </select>

              <button className="btn purple" onClick={validateLines}>
                Validez la commande
              </button>

              <div className="tiny">
                Pour parallèle/perpendiculaire : il faut d'abord avoir tracé une droite, puis cliquer dessus.
              </div>
            </div>
          </section>

          <section className="section">
            <h2>Figures</h2>
            <div className="card">
              <label>Commande</label>
              <select value={figureCmd} onChange={(e) => setFigureCmd(e.target.value as any)}>
                <option value="TRIANGLE">Tracer un triangle</option>
                <option value="CIRCLE">Tracer un cercle (centre puis point)</option>
              </select>

              {figureCmd === "TRIANGLE" && (
                <>
                  <label>Type de triangle</label>
                  <select value={triangleType} onChange={(e) => setTriangleType(e.target.value as any)}>
                    <option value="ISOSCELES">Triangle isocèle</option>
                    <option value="EQUILATERAL">Triangle équilatéral</option>
                    <option value="RIGHT">Triangle rectangle</option>
                    <option value="ANY">Triangle quelconque</option>
                  </select>
                  <div className="tiny">
                    Remarque : les points crées peuvent être ajustés automatiquement pour respecter la demande.
                  </div>
                </>
              )}

              <button className="btn purple" onClick={validateFigures}>
                Validez la commande
              </button>
            </div>
          </section>

          <section className="section">
            <h2>Segments</h2>
            <div className="card">
              <label>Commande</label>
              <select value={segmentCmd} onChange={(e) => setSegmentCmd(e.target.value as any)}>
                <option value="SEGMENT">Tracer un segment</option>
                <option value="SPECIAL">Tracer un segment spécial</option>
                <option value="MIDPOINT">Scinder un segment en son milieu</option>
              </select>

              {segmentCmd === "SPECIAL" && (
                <>
                  <label>Type</label>
                  <select value={segmentSpecial} onChange={(e) => setSegmentSpecial(e.target.value as any)}>
                    <option value="ALTITUDE">Hauteur d'un triangle</option>
                    <option value="RADIUS">Rayon d'un cercle</option>
                    <option value="DIAMETER">Diamètre d'un cercle</option>
                  </select>
                </>
              )}

              <label className="tiny">
                <input type="checkbox" checked={showLengths} onChange={(e) => setShowLengths(e.target.checked)} />
                Afficher toutes les longueurs
              </label>

              <button className="btn purple" onClick={validateSegments}>
                Validez la commande
              </button>
            </div>
          </section>

          <section className="section">
            <h2>Angles</h2>
            <div className="card">
              <label>Tracer un angle de mesure : {angleDeg}°</label>
              <input type="range" min={0} max={180} step={5} value={angleDeg} onChange={(e) => setAngleDeg(parseInt(e.target.value, 10))} />

              <label className="tiny">
                <input type="checkbox" checked={showAngles} onChange={(e) => setShowAngles(e.target.checked)} />
                Afficher toutes les mesures d'angles
              </label>

              <button className="btn purple" onClick={validateAngles}>
                Validez la commande
              </button>

              <div className="tiny">La grenouille construit un angle ABC : clique A puis B (sommet). C est créé automatiquement.</div>
            </div>
          </section>

          <section className="section">
            <h2>Effacer</h2>
            <div className="row">
              <button className="btn gray" onClick={undoLast}>
                Effacer le dernier tracé
              </button>
              <button className="btn gray" onClick={clearAll}>
                Effacer tout
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
