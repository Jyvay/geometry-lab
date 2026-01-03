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
  buildAdvancePath,
  buildGeodesicTrace,
  buildCircleTrace,
  startTracing,
  finishTracing,
  animatePath,
  stepAnimation,
  buildTurnAnim,
  geodesicBetween,
  geodesicLineThrough,
  hyperbolicParallelThroughPoint,
  hyperbolicPerpendicularThroughPoint,
  sphericalPerpendicularGreatCircleThroughPoint,
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
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const dist2 = (a: Vec2, b: Vec2) => {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
};
function distPointToSegment(p: Vec2, a: Vec2, b: Vec2) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = (apx * abx + apy * aby) / ab2;
  t = clamp(t, 0, 1);
  const q = { x: a.x + t * abx, y: a.y + t * aby };
  return Math.hypot(p.x - q.x, p.y - q.y);
}
const euclidLen = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

/* ---------- Exact distances (for “mesure à la main”) ---------- */
function liftSphereUpper(p: Vec2) {
  const r2 = p.x * p.x + p.y * p.y;
  const z = Math.sqrt(Math.max(0, 1 - r2));
  return { x: p.x, y: p.y, z };
}
function dot3(a: any, b: any) { return a.x*b.x + a.y*b.y + a.z*b.z; }
function norm3(a: any) { return Math.hypot(a.x, a.y, a.z); }

function distanceExact(space: SpaceId, A: Vec2, B: Vec2) {
  if (space === "E") {
    return euclidLen(A, B);
  }
  if (space === "H") {
    // hyperbolic distance in Poincaré disk (exact)
    const a2 = A.x*A.x + A.y*A.y;
    const b2 = B.x*B.x + B.y*B.y;
    const dx = A.x - B.x;
    const dy = A.y - B.y;
    const d2 = dx*dx + dy*dy;
    const denom = (1 - a2) * (1 - b2);
    if (denom <= 0) return Infinity;
    const arg = 1 + (2 * d2) / denom;
    // arcosh
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

function angleHand(space: SpaceId, A: Vec2, B: Vec2, C: Vec2) {
  if (space === "S") {
    // exact spherical angle at B via tangents in tangent plane at B
    const b3 = liftSphereUpper(B);
    const a3 = liftSphereUpper(A);
    const c3 = liftSphereUpper(C);

    // tangent directions: project A and C onto tangent plane at B
    const projTangent = (p3: any) => {
      // remove normal component along b3
      const k = dot3(p3, b3) / (dot3(b3, b3) || 1);
      const t = { x: p3.x - k*b3.x, y: p3.y - k*b3.y, z: p3.z - k*b3.z };
      const n = norm3(t) || 1;
      return { x: t.x/n, y: t.y/n, z: t.z/n };
    };

    const u = projTangent(a3);
    const v = projTangent(c3);
    const cos = clamp(dot3(u, v), -1, 1);
    return Math.acos(cos);
  }

  // In Poincaré disk H: model is conformal => angles = Euclidean angles in the disk coordinates
  // Euclid: same formula
  const u = { x: A.x - B.x, y: A.y - B.y };
  const v = { x: C.x - B.x, y: C.y - B.y };
  const nu = Math.hypot(u.x, u.y) || 1;
  const nv = Math.hypot(v.x, v.y) || 1;
  const cos = clamp((u.x*v.x + u.y*v.y) / (nu*nv), -1, 1);
  return Math.acos(cos);
}

/* ---------------- Modes ---------------- */
type ToolMode = "NONE" | "PLACE_FIGURE_POINTS" | "PLACE_LINE_2PTS" | "MEASURE";
type LineOpMode = "NONE" | "PARALLEL_0" | "PARALLEL_1" | "PERPENDICULAR";
type HandMeasureMode = "NONE" | "HAND_DIST" | "HAND_ANGLE";

/* ---------------- Objects for selection ---------------- */
type PickedSegment = {
  kind: "segment";
  owner: "engine" | "line";
  id: string;
  a: Vec2;
  b: Vec2;
};
type PickedLine = { kind: "line"; id: string };
type PickedObject = PickedSegment | PickedLine;

type LineObject = {
  id: string;
  pts: Vec2[];
  baseP: Vec2;
  baseQ: Vec2;
  space: SpaceId;
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /* engine */
  const [space, setSpace] = useState<SpaceId>("E");
  const stateRef = useRef<EngineState>(createInitialState("E"));
  const [renderState, setRenderState] = useState<EngineState>(() => stateRef.current);

  /* UI params */
  const [moveDist, setMoveDist] = useState(0.3);
  const [turnDeg, setTurnDeg] = useState(15);
  const [segLen, setSegLen] = useState(1.0);
  const [circleR, setCircleR] = useState(0.6);
  const [animSpeed, setAnimSpeed] = useState(0.9);

  /* sphere degrees toggle */
  const [sphereInDegrees, setSphereInDegrees] = useState(true);
  const toSphereUnit = (v: number) => (sphereInDegrees ? (v * Math.PI) / 180 : v);

  /* tool mode */
  const [toolMode, setToolMode] = useState<ToolMode>("NONE");

  /* figure points */
  const [figPts, setFigPts] = useState<Vec2[]>([]);

  /* line points */
  const [linePts, setLinePts] = useState<Vec2[]>([]);

  /* stored lines (true geodesic lines) */
  const [lines, setLines] = useState<LineObject[]>([]);

  /* measure mode state */
  const [hovered, setHovered] = useState<PickedObject | null>(null);
  const [selected, setSelected] = useState<PickedObject[]>([]);
  const [measurePanelText, setMeasurePanelText] = useState<string>("MODE MESURE : inactif\n");

  /* angle visualization */
  const angleHintRef = useRef<{
    vertex: Vec2;
    v1: Vec2;
    v2: Vec2;
    isObtuse: boolean;
  } | null>(null);

  /* magic reveal (for line drawing) */
  const magicLineRef = useRef<{
    active: boolean;
    pts: Vec2[];
    t: number;
    finalLine?: LineObject;
  } | null>(null);

  /* two-step line operations (parallel/perp) */
  const [lineOpMode, setLineOpMode] = useState<LineOpMode>("NONE");
  const [opPoint, setOpPoint] = useState<Vec2 | null>(null); // (f) point shown for ops

  /* hand measurement mode */
  const [handMode, setHandMode] = useState<HandMeasureMode>("NONE");
  const [handPts, setHandPts] = useState<Vec2[]>([]); // (f) show clicked points

  const formula = useMemo(() => spaceFormula(space), [space]);

  const isValidWorldPoint = (w: Vec2) => {
    if (space === "H") return w.x * w.x + w.y * w.y < 1;
    if (space === "S") return w.x * w.x + w.y * w.y <= 1;
    return true;
  };

  /* (c) Correct cursor mapping under CSS scaling */
  const eventToWorld = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();

    // scale from CSS pixels -> canvas pixels
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;

    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;

    const vp = makeViewport(canvas.width, canvas.height, 1.25);
    const w = screenToWorld(vp, { x: px, y: py });
    return { w, vp };
  };

  /* reset on space change */
  useEffect(() => {
    stateRef.current = reset(stateRef.current, space);
    setRenderState(stateRef.current);
    setToolMode("NONE");
    setLineOpMode("NONE");
    setHandMode("NONE");
    setHandPts([]);
    setOpPoint(null);
    setFigPts([]);
    setLinePts([]);
    setHovered(null);
    setSelected([]);
    setMeasurePanelText("MODE MESURE : inactif\n");
    angleHintRef.current = null;
    magicLineRef.current = null;
    setLines([]);
  }, [space]);

  /* main loop */
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
          if (ml.finalLine) setLines((prev) => [...prev, ml.finalLine!]);
        }
      }

      setRenderState(s1);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ---------- Picking ---------- */
  const pickObjectAt = (w: Vec2): PickedObject | null => {
    const SEG_THR = 0.035;

    // lines (custom)
    let bestLine: { id: string; d: number } | null = null;
    for (const L of lines) {
      const pts = L.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distPointToSegment(w, pts[i], pts[i + 1]);
        if (d < SEG_THR && (!bestLine || d < bestLine.d)) {
          bestLine = { id: L.id, d };
        }
      }
    }
    if (bestLine) return { kind: "line", id: bestLine.id };

    // engine shapes (segment picking)
    const shapes: any[] = renderState.shapes as any[];
    let bestSeg: { id: string; a: Vec2; b: Vec2; d: number } | null = null;

    for (let si = 0; si < shapes.length; si++) {
      const sh = shapes[si];
      if (sh.kind !== "polyline") continue;
      const pts: Vec2[] = sh.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const d = distPointToSegment(w, a, b);
        if (d < SEG_THR && (!bestSeg || d < bestSeg.d)) {
          bestSeg = { id: `engine:${si}:${i}`, a, b, d };
        }
      }
    }
    if (bestSeg) {
      return { kind: "segment", owner: "engine", id: bestSeg.id, a: bestSeg.a, b: bestSeg.b };
    }

    return null;
  };

  const selectedLine = (() => {
    const l = selected.find((s) => s.kind === "line") as PickedLine | undefined;
    if (!l) return null;
    return lines.find((x) => x.id === l.id) || null;
  })();

  const ensureMeasureMode = (msg?: string) => {
    if (toolMode !== "MEASURE") {
      setToolMode("MEASURE");
      setHovered(null);
      setSelected([]);
      angleHintRef.current = null;
    }
    if (msg) setMeasurePanelText(msg);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (toolMode !== "MEASURE") return;
    const { w } = eventToWorld(e);
    if (!isValidWorldPoint(w)) {
      setHovered(null);
      return;
    }
    setHovered(pickObjectAt(w));
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { w } = eventToWorld(e);
    if (!isValidWorldPoint(w)) return;

    /* ----- Hand measures (d,f) ----- */
    if (toolMode === "MEASURE" && handMode !== "NONE") {
      setHandPts((prev) => {
        const next = [...prev, w];

        if (handMode === "HAND_DIST" && next.length === 2) {
          const d = distanceExact(space, next[0], next[1]); // distance géodésique intrinsèque

          if (space === "S") {
            const deg = (d * 180) / Math.PI;
            setMeasurePanelText(
              `MESURE DE DISTANCE À LA MAIN\n` +
              `A=${JSON.stringify(next[0])}\n` +
              `B=${JSON.stringify(next[1])}\n` +
              `d_geo = ${d.toFixed(6)} rad  (= ${deg.toFixed(3)}°)\n`
            );
          } else if (space === "H") {
            setMeasurePanelText(
              `MESURE DE DISTANCE À LA MAIN\n` +
              `A=${JSON.stringify(next[0])}\n` +
              `B=${JSON.stringify(next[1])}\n` +
              `d_geo = ${d.toFixed(6)}\n`
            );
          } else {
            setMeasurePanelText(
              `MESURE DE DISTANCE À LA MAIN\n` +
              `A=${JSON.stringify(next[0])}\n` +
              `B=${JSON.stringify(next[1])}\n` +
              `d_geo = ${d.toFixed(6)}\n`
            );
          }

          setHandMode("NONE");
        }


        if (handMode === "HAND_ANGLE" && next.length === 3) {
          const ang = angleHand(space, next[0], next[1], next[2]); // angle at B=next[1]
          const deg = (ang * 180) / Math.PI;

          const u = { x: next[0].x - next[1].x, y: next[0].y - next[1].y };
          const v = { x: next[2].x - next[1].x, y: next[2].y - next[1].y };
          const nu = Math.hypot(u.x, u.y) || 1;
          const nv = Math.hypot(v.x, v.y) || 1;
          const v1 = { x: u.x / nu, y: u.y / nu };
          const v2 = { x: v.x / nv, y: v.y / nv };
          const isObtuse = deg > 90;
          angleHintRef.current = { vertex: next[1], v1, v2, isObtuse };

          setMeasurePanelText(
            `MESURE À LA MAIN : angle au sommet (B)\nA=${JSON.stringify(next[0])}\nB=${JSON.stringify(next[1])}\nC=${JSON.stringify(next[2])}\nAngle ABC = ${deg.toFixed(3)}° (${isObtuse ? "obtus" : "aigu"})\n`
          );
          setHandMode("NONE");
        }

        return next.slice(0, handMode === "HAND_DIST" ? 2 : 3);
      });
      return;
    }

    /* ----- Two-step line operation (parallel/perp) (f) ----- */
    if (lineOpMode !== "NONE") {
      // step 1: select a line
      const obj = pickObjectAt(w);
      if (obj && obj.kind === "line") {
        setSelected([{ kind: "line", id: obj.id }]);
        setMeasurePanelText(
          "ÉTAPE 2 : clique un point sur l’espace.\nLa grenouille créera la droite.\n"
        );
        return;
      }

      // step 2: click a point
      const base = selectedLine;
      if (!base) {
        setMeasurePanelText("ÉTAPE 1 : sélectionne d’abord une droite.\n");
        return;
      }

      setOpPoint(w); // show op point (f)

      // move frog to point (no trace) then invoke line with magic reveal
      const frog = frogWorldPos(stateRef.current);
      stateRef.current = animatePath(stateRef.current, [frog, w], animSpeed, false);

      const timer = window.setInterval(() => {
        if (stateRef.current.anim.active) return;

        // Build result polyline
        let pts: Vec2[] = [];
        if (space === "E") {
          // Euclid op: directly store (no special curved polyline)
          const d = { x: base.baseQ.x - base.baseP.x, y: base.baseQ.y - base.baseP.y };
          const L = Math.hypot(d.x, d.y) || 1;
          const u = { x: d.x / L, y: d.y / L };

          if (lineOpMode === "PERPENDICULAR") {
            const perp = { x: -u.y, y: u.x };
            const big = 5;
            pts = [
              { x: w.x - perp.x * big, y: w.y - perp.y * big },
              { x: w.x + perp.x * big, y: w.y + perp.y * big },
            ];
          } else {
            const big = 5;
            pts = [
              { x: w.x - u.x * big, y: w.y - u.y * big },
              { x: w.x + u.x * big, y: w.y + u.y * big },
            ];
          }
        } else if (space === "H") {
          if (lineOpMode === "PERPENDICULAR") {
            pts = hyperbolicPerpendicularThroughPoint(base.baseP, base.baseQ, w, 560);
          } else {
            const which: 0 | 1 = lineOpMode === "PARALLEL_0" ? 0 : 1;
            pts = hyperbolicParallelThroughPoint(base.baseP, base.baseQ, w, which, 560);
          }
        } else if (space === "S") {
          if (lineOpMode === "PERPENDICULAR") {
            pts = sphericalPerpendicularGreatCircleThroughPoint(base.baseP, base.baseQ, w, 560);
          } else {
            setMeasurePanelText(
              "OPÉRATION IMPOSSIBLE À L'ENDROIT INDIQUÉ\n"
            );
            setLineOpMode("NONE");
            window.clearInterval(timer);
            return;
          }
        }

        if (pts.length < 2) {
          setMeasurePanelText("OPÉRATION IMPOSSIBLE À L'ENDROIT INDIQUÉ\n");
          setLineOpMode("NONE");
          window.clearInterval(timer);
          return;
        }

        const id = `Op_${Date.now()}`;
        magicLineRef.current = {
          active: true,
          pts,
          t: 0,
          finalLine: { id, pts, baseP: pts[0], baseQ: pts[pts.length - 1], space },
        };

        setMeasurePanelText("OPÉRATION TERMINÉE : droite créée.\n");
        setLineOpMode("NONE");
        window.clearInterval(timer);
      }, 25);

      return;
    }

    /* ----- Measure selection mode ----- */
    if (toolMode === "MEASURE") {
      const obj = pickObjectAt(w);
      if (!obj) return;

      setSelected((prev) => {
        const key = JSON.stringify(obj);
        const exists = prev.some((x) => JSON.stringify(x) === key);
        let next = exists ? prev.filter((x) => JSON.stringify(x) !== key) : [...prev, obj];
        if (next.length > 2) next = next.slice(next.length - 2);
        return next;
      });
      return;
    }

    /* ----- Figure point placement ----- */
    if (toolMode === "PLACE_FIGURE_POINTS") {
      setFigPts((prev) => [...prev, w]);
      return;
    }

    /* ----- Line point placement ----- */
    if (toolMode === "PLACE_LINE_2PTS") {
      setLinePts((prev) => {
        if (prev.length >= 2) return [w];
        return [...prev, w];
      });
      return;
    }
  };

  /* ---------- Drawing ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const st = renderState;
    const vp = makeViewport(canvas.width, canvas.height, 1.25);

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

    drawDiskBoundary();

    const isLineHoveredOrSelected = (id: string) => {
      if (toolMode !== "MEASURE") return false;
      const hoverOK = hovered?.kind === "line" && hovered.id === id;
      const selOK = selected.some((s) => s.kind === "line" && s.id === id);
      return hoverOK || selOK;
    };

    const isEngineSegHoveredOrSelected = (segId: string) => {
      if (toolMode !== "MEASURE") return false;
      const hoverOK = hovered?.kind === "segment" && hovered.id === segId;
      const selOK = selected.some((s) => s.kind === "segment" && s.id === segId);
      return hoverOK || selOK;
    };

    const drawPolyline = (pts: Vec2[], color: string, width: number) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach((pw, i) => {
        const p = worldToScreen(vp, pw);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
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
      ctx.fillText(label, s.x + 10, s.y - 10);
    };

    withDiskClip(() => {
      // custom lines
      for (const L of lines) {
        const active = isLineHoveredOrSelected(L.id);
        const color = toolMode === "MEASURE" ? (active ? "#0f172a" : "#94a3b8") : "#0f172a";
        const width = toolMode === "MEASURE" ? (active ? 3.5 : 2.5) : 3;
        drawPolyline(L.pts, color, width);
      }

      // engine shapes
      const shapes: any[] = st.shapes as any[];
      for (let si = 0; si < shapes.length; si++) {
        const sh = shapes[si];
        if (sh.kind === "polyline") {
          const pts: Vec2[] = sh.pts;
          let color = sh.color;
          let width = sh.width;

          if (toolMode === "MEASURE") {
            let active = false;
            for (let i = 0; i < pts.length - 1; i++) {
              const id = `engine:${si}:${i}`;
              if (isEngineSegHoveredOrSelected(id)) {
                active = true;
                break;
              }
            }
            color = active ? "#0f172a" : "#94a3b8";
            width = active ? Math.max(3, sh.width) : Math.max(2, sh.width - 1);
          }
          drawPolyline(pts, color, width);
        }
        if (sh.kind === "marker") {
          const p = worldToScreen(vp, sh.p);
          ctx.fillStyle = toolMode === "MEASURE" ? "#94a3b8" : sh.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // inProgress
      if (st.inProgress?.kind === "polyline") {
        const sh: any = st.inProgress;
        const color = toolMode === "MEASURE" ? "#94a3b8" : sh.color;
        drawPolyline(sh.pts, color, sh.width);
      }

      // magic reveal
      const ml = magicLineRef.current;
      if (ml && ml.pts.length >= 2) {
        const t = clamp(ml.t, 0, 1);
        const k = Math.max(2, Math.floor(t * ml.pts.length));
        const pts = ml.pts.slice(0, k);
        const color = toolMode === "MEASURE" ? "#94a3b8" : "#0f172a";
        drawPolyline(pts, color, 3);
      }

      // points for modes
      figPts.forEach((p, i) => drawPoint(p, `P${i + 1}`, "#ef4444"));
      linePts.forEach((p, i) => drawPoint(p, `L${i + 1}`, "#ef4444"));

      // (f) op point shown
      if (opPoint) drawPoint(opPoint, "•", "#2563eb");

      // (f) hand measure points
      handPts.forEach((p, i) => drawPoint(p, ["A", "B", "C"][i] ?? `M${i+1}`, "#16a34a"));

      // angle hint
      const hint = angleHintRef.current;
      if (hint) {
        const v = worldToScreen(vp, hint.vertex);
        const r = 34;
        const v1 = worldToScreen(vp, { x: hint.vertex.x + hint.v1.x * 0.22, y: hint.vertex.y + hint.v1.y * 0.22 });
        const v2 = worldToScreen(vp, { x: hint.vertex.x + hint.v2.x * 0.22, y: hint.vertex.y + hint.vertex.y * 0 + hint.v2.y * 0.22 });
        const a1 = Math.atan2(v1.y - v.y, v1.x - v.x);
        const a2 = Math.atan2(v2.y - v.y, v2.x - v.x);
        ctx.strokeStyle = hint.isObtuse ? "#ef4444" : "#16a34a";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(v.x, v.y, r, a1, a2, false);
        ctx.stroke();
      }
    });

    // Frog drawn AFTER clip => never hidden behind disk
    const fw = frogWorldPos(st);
    const fp = worldToScreen(vp, fw);
    ctx.font = "30px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#0f172a";
    ctx.fillText("🐸", fp.x, fp.y);

    const dir = frogHeadingWorldDir(st);
    const tip = worldToScreen(vp, { x: fw.x + dir.x * 0.2, y: fw.y + dir.y * 0.2 });
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(fp.x, fp.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  }, [renderState, space, toolMode, hovered, selected, figPts, linePts, lines, opPoint, handPts]);

  /* ---------- Actions ---------- */
  const doAdvance = () => {
    if (stateRef.current.anim.active) return;
    const d = space === "S" ? toSphereUnit(moveDist) : moveDist;
    const { path, next } = buildAdvancePath(stateRef.current, d);
    stateRef.current = animatePath(stateRef.current, path, animSpeed, false);

    const timer = window.setInterval(() => {
      if (!stateRef.current.anim.active) {
        stateRef.current = next;
        setRenderState(stateRef.current);
        window.clearInterval(timer);
      }
    }, 20);
  };

  const doTurn = () => {
    if (stateRef.current.anim.active) return;
    stateRef.current = buildTurnAnim(stateRef.current, turnDeg, 0.35);
  };

  const doTraceSegment = () => {
    if (stateRef.current.anim.active) return;
    const L = space === "S" ? toSphereUnit(segLen) : segLen;
    const { path, next, traceColor } = buildGeodesicTrace(stateRef.current, L);
    stateRef.current = startTracing(stateRef.current, traceColor, 3);
    stateRef.current = animatePath(stateRef.current, path, animSpeed, true);

    const timer = window.setInterval(() => {
      if (!stateRef.current.anim.active) {
        stateRef.current = finishTracing({ ...next, inProgress: stateRef.current.inProgress });
        setRenderState(stateRef.current);
        window.clearInterval(timer);
      }
    }, 20);
  };

  const doTraceCircle = () => {
    if (stateRef.current.anim.active) return;
    const R = space === "S" ? toSphereUnit(circleR) : circleR;
    const { path, next, traceColor } = buildCircleTrace(stateRef.current, R);
    stateRef.current = startTracing(stateRef.current, traceColor, 3);
    stateRef.current = animatePath(stateRef.current, path, animSpeed, true);

    const timer = window.setInterval(() => {
      if (!stateRef.current.anim.active) {
        stateRef.current = finishTracing({ ...next, inProgress: stateRef.current.inProgress });
        setRenderState(stateRef.current);
        window.clearInterval(timer);
      }
    }, 20);
  };

  const startFigureMode = () => {
    if (stateRef.current.anim.active) return;
    setToolMode("PLACE_FIGURE_POINTS");
    setLineOpMode("NONE");
    setHandMode("NONE");
    setHandPts([]);
    setOpPoint(null);
    setFigPts([]);
    setLinePts([]);
    setHovered(null);
    setSelected([]);
    setMeasurePanelText("MODE FIGURE : place des points puis lance le tracé (fermé).\n");
    angleHintRef.current = null;
  };

  const launchFigureTrace = () => {
    if (stateRef.current.anim.active) return;
    if (figPts.length < 2) return;

    const first = figPts[0];
    const frog = frogWorldPos(stateRef.current);

    // move to first WITHOUT tracing
    stateRef.current = animatePath(stateRef.current, [frog, first], animSpeed, false);

    let phase: "MOVE_TO_FIRST" | "TRACE_EDGES" = "MOVE_TO_FIRST";
    let segIndex = 0;

    // (a) close figure: include last->first
    const closedPts = figPts.length >= 2 ? [...figPts, figPts[0]] : figPts;

    const timer = window.setInterval(() => {
      if (stateRef.current.anim.active) return;

      if (phase === "MOVE_TO_FIRST") {
        stateRef.current = startTracing(stateRef.current, "#0f172a", 3);
        phase = "TRACE_EDGES";
      }

      if (segIndex >= closedPts.length - 1) {
        stateRef.current = finishTracing(stateRef.current);
        setRenderState(stateRef.current);
        window.clearInterval(timer);
        setToolMode("NONE");
        setMeasurePanelText("Traçage terminé.\n");
        return;
      }

      const a = closedPts[segIndex];
      const b = closedPts[segIndex + 1];
      const path = geodesicBetween(space, a, b, 260);
      stateRef.current = animatePath(stateRef.current, path, animSpeed, true);
      segIndex++;
    }, 25);
  };

  const startLineMode = () => {
    if (stateRef.current.anim.active) return;
    setToolMode("PLACE_LINE_2PTS");
    setLineOpMode("NONE");
    setHandMode("NONE");
    setHandPts([]);
    setOpPoint(null);
    setLinePts([]);
    setFigPts([]);
    setHovered(null);
    setSelected([]);
    angleHintRef.current = null;
    setMeasurePanelText("MODE DROITE : place 2 points pour créer la droite.\n");
  };

  const launchMagicLine = () => {
    if (stateRef.current.anim.active) return;
    if (linePts.length !== 2) return;

    const [a, b] = linePts;

    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const frog = frogWorldPos(stateRef.current);
    stateRef.current = animatePath(stateRef.current, [frog, mid], animSpeed, false);

    const timer = window.setInterval(() => {
      if (stateRef.current.anim.active) return;

      const pts = geodesicLineThrough(space, a, b, 720); // bigger sampling helps smoothness
      const id = `L_${Date.now()}`;
      magicLineRef.current = {
        active: true,
        pts,
        t: 0,
        finalLine: { id, pts, baseP: a, baseQ: b, space },
      };

      setToolMode("NONE");
      setMeasurePanelText("Droite tracée.\n");
      window.clearInterval(timer);
    }, 25);
  };

  const startMeasureMode = () => {
    if (stateRef.current.anim.active) return;
    setToolMode("MEASURE");
    setLineOpMode("NONE");
    setHovered(null);
    setSelected([]);
    angleHintRef.current = null;
    setMeasurePanelText(
      "MODE MESURE : actif\n- Survole : sombre\n- Clique : sélection (max 2)\n- Afficher mesures\n- Ou mesures à la main\n"
    );
  };

  const exitMeasureMode = () => {
    setToolMode("NONE");
    setLineOpMode("NONE");
    setHandMode("NONE");
    setHandPts([]);
    setOpPoint(null);
    setHovered(null);
    setSelected([]);
    angleHintRef.current = null;
    setMeasurePanelText("MODE MESURE : inactif\n");
  };

  const showSelectedMeasures = () => {
    angleHintRef.current = null;

    if (selected.length === 0) {
      setMeasurePanelText("MODE MESURE : actif\nAucune sélection.\n");
      return;
    }

    const segs = selected.filter((s) => s.kind === "segment") as PickedSegment[];

    if (segs.length === 1 && selected.length === 1) {
      const s = segs[0];
      const L = euclidLen(s.a, s.b);
      setMeasurePanelText(
        `MODE MESURE : actif\nOBJET : segment (affiché)\nLONGUEUR ${L.toFixed(4)}\n`
      );
      return;
    }

    if (segs.length === 2 && selected.length === 2) {
      const s1 = segs[0], s2 = segs[1];
      const thr2 = 0.0008;
      const endpoints1 = [s1.a, s1.b];
      const endpoints2 = [s2.a, s2.b];

      let vertex: Vec2 | null = null;
      let other1: Vec2 | null = null;
      let other2: Vec2 | null = null;

      for (const e1 of endpoints1) {
        for (const e2 of endpoints2) {
          if (dist2(e1, e2) < thr2) {
            vertex = e1;
            other1 = dist2(e1, s1.a) < dist2(e1, s1.b) ? s1.b : s1.a;
            other2 = dist2(e2, s2.a) < dist2(e2, s2.b) ? s2.b : s2.a;
          }
        }
      }

      if (!vertex || !other1 || !other2) {
        setMeasurePanelText("MODE MESURE : actif\n2 segments sélectionnés mais pas de sommet commun.\n");
        return;
      }

      const u1 = { x: other1.x - vertex.x, y: other1.y - vertex.y };
      const u2 = { x: other2.x - vertex.x, y: other2.y - vertex.y };
      const n1 = Math.hypot(u1.x, u1.y) || 1;
      const n2 = Math.hypot(u2.x, u2.y) || 1;
      const v1 = { x: u1.x / n1, y: u1.y / n1 };
      const v2 = { x: u2.x / n2, y: u2.y / n2 };
      const dot = clamp(v1.x * v2.x + v1.y * v2.y, -1, 1);
      const ang = Math.acos(dot);
      const deg = (ang * 180) / Math.PI;
      const isObtuse = deg > 90;

      angleHintRef.current = { vertex, v1, v2, isObtuse };

      setMeasurePanelText(
        `MODE MESURE : actif\nOBJET : angle entre 2 segments\nANGLE : ${deg.toFixed(2)}°\nTYPE : ${isObtuse ? "obtus" : "aigu"}\n`
      );
      return;
    }

    setMeasurePanelText("MODE MESURE : actif\nSélection non supportée.\n");
  };

  /* line ops: clicking parallel/perp should auto-enable measure mode */
  const beginLineOp = (op: LineOpMode) => {
    if (stateRef.current.anim.active) return;
    ensureMeasureMode(
      "OPÉRATION SUR DROITE :\nÉTAPE 1 : clique une droite (sélection)\n"
    );
    setHandMode("NONE");
    setHandPts([]);
    setOpPoint(null);
    setLineOpMode(op);
    setSelected([]);
  };

  /* hand measures */
  const startHandDistance = () => {
    if (stateRef.current.anim.active) return;
    ensureMeasureMode(
      "MESURE À LA MAIN : DISTANCE\nClique 2 points A puis B.\n"
    );
    setLineOpMode("NONE");
    setOpPoint(null);
    setSelected([]);
    angleHintRef.current = null;
    setHandPts([]);
    setHandMode("HAND_DIST");
  };

  const startHandAngle = () => {
    if (stateRef.current.anim.active) return;
    ensureMeasureMode(
      "MESURE À LA MAIN : ANGLE\nClique 3 points A, B (sommet), C.\n"
    );
    setLineOpMode("NONE");
    setOpPoint(null);
    setSelected([]);
    angleHintRef.current = null;
    setHandPts([]);
    setHandMode("HAND_ANGLE");
  };

  const clearHandPts = () => {
    setHandPts([]);
    angleHintRef.current = null;
    setMeasurePanelText("Points de mesure effacés.\n");
  };

  /* recenter frog */
  const recenterFrog = () => {
    if (stateRef.current.anim.active) return;
    const s = stateRef.current;

    if (space === "E") stateRef.current = { ...s, e_pos: { x: 0, y: 0 } };
    else if (space === "H") stateRef.current = { ...s, h_pos: { x: 0, y: 0 } };
    else stateRef.current = { ...s, s_p: { x: 0, y: 0, z: 1 } };

    setRenderState(stateRef.current);
    setMeasurePanelText("Grenouille recentrée (tracés conservés).\n");
  };

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
              <input
                type="checkbox"
                checked={sphereInDegrees}
                onChange={(e) => setSphereInDegrees(e.target.checked)}
              />
              Distances sphériques en degrés (sinon radians)
            </label>
          )}
        </div>
      </header>

      <div className="main-layout">
        <div className="left-col">
          <div className="canvas-panel">
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              onClick={onCanvasClick}
              onMouseMove={onMouseMove}
            />
            <div className="canvas-hud">
              <div>
                <strong>Mode :</strong>{" "}
                {toolMode === "NONE" && "NORMAL"}
                {toolMode === "PLACE_FIGURE_POINTS" && "TRACER UNE FIGURE"}
                {toolMode === "PLACE_LINE_2PTS" && "TRACER UNE DROITE (2 points)"}
                {toolMode === "MEASURE" && "MESURE / SÉLECTION"}
                {lineOpMode !== "NONE" && ` | OP: ${lineOpMode}`}
                {handMode !== "NONE" && ` | MAIN: ${handMode}`}
              </div>
            </div>
          </div>

          <div className="measure-shell">
            <pre>{measurePanelText}</pre>
          </div>
        </div>

        <aside className="controls-panel">
          <div className="formula-card">
            <div className="formula-title">{formula.title}</div>
            <pre className="formula-text">{formula.formula}</pre>
          </div>

          <section className="section">
            <h2>Vitesse</h2>
            <label>
              Animation : {animSpeed.toFixed(2)}
              <input
                type="range"
                min={0.4}
                max={2.0}
                step={0.05}
                value={animSpeed}
                onChange={(e) => setAnimSpeed(parseFloat(e.target.value))}
              />
            </label>
          </section>

          <section className="section">
            <h2>Actions</h2>

            <div className="grid2">
              <div className="card">
                <label>Avancer</label>
                <input type="number" value={moveDist} onChange={(e) => setMoveDist(parseFloat(e.target.value))} />
                <button className="btn green" onClick={doAdvance}>Avancer</button>
              </div>

              <div className="card">
                <label>Tourner (° ou rad)</label>
                <input type="number" value={turnDeg} onChange={(e) => setTurnDeg(parseFloat(e.target.value))} />
                <button className="btn green" onClick={doTurn}>Tourner</button>
              </div>
            </div>

            <div className="card">
              <label>Tracer un segment de longueur:</label>
              <div className="row">
                <input type="number" value={segLen} onChange={(e) => setSegLen(parseFloat(e.target.value))} />
                <button className="btn blue" onClick={doTraceSegment}>Segment</button>
              </div>
            </div>

            <div className="card">
              <label>Tracer un cercle de rayon:</label>
              <div className="row">
                <input type="number" value={circleR} onChange={(e) => setCircleR(parseFloat(e.target.value))} />
                <button className="btn blue" onClick={doTraceCircle}>Cercle</button>
              </div>
            </div>
          </section>

          <section className="section">
            <h2>Tracer une figure</h2>
            <div className="card">
              <div className="row">
                <button className={`btn ${toolMode === "PLACE_FIGURE_POINTS" ? "dark" : "gray"}`} onClick={startFigureMode}>
                  Mode points
                </button>
                <button className="btn gray" onClick={() => setFigPts([])}>Effacer</button>
              </div>
              <button className="btn purple" onClick={launchFigureTrace}>
                Lancer le tracé (figure fermée)
              </button>
              <div className="tiny">Placer les Points : {figPts.length} (clic sur le canvas)</div>
            </div>
          </section>

          <section className="section">
            <h2>Tracer une droite</h2>
            <div className="card">
              <div className="row">
                <button className={`btn ${toolMode === "PLACE_LINE_2PTS" ? "dark" : "gray"}`} onClick={startLineMode}>
                  Placer les 2 points
                </button>
                <button className="btn gray" onClick={() => setLinePts([])}>Effacer</button>
              </div>
              <button className="btn purple" onClick={launchMagicLine}>
                Créer la droite
              </button>
              <div className="tiny">Points : {linePts.length}/2</div>
            </div>
          </section>

          <section className="section">
            <h2>Mesure</h2>
            <div className="card">
              {toolMode !== "MEASURE" ? (
                <button className="btn purple" onClick={startMeasureMode}>Activer mode mesure</button>
              ) : (
                <button className="btn gray" onClick={exitMeasureMode}>Quitter mode mesure</button>
              )}

              <button className="btn purple" disabled={toolMode !== "MEASURE"} onClick={showSelectedMeasures}>
                Afficher mesures de la sélection
              </button>

              <div className="grid2">
                <button className="btn blue" onClick={startHandDistance}>
                  Distance à partir de 2 points
                </button>
                <button className="btn blue" onClick={startHandAngle}>
                  Angle à partir de 3 points
                </button>
              </div>

              <button className="btn gray" disabled={toolMode !== "MEASURE"} onClick={clearHandPts}>
                Effacer points (main)
              </button>
            </div>

            <div className="card">
              <h3>Opérations sur droites (2 étapes)</h3>
              <div className="tiny">
                1) cliquer une droite<br />
                2) cliquer à l'endroit où la droite doit passer
              </div>

              <div className="grid2">
                <button className="btn blue" onClick={() => beginLineOp("PARALLEL_0")}>
                  Parallèle
                </button>
              </div>

              <button className="btn blue" onClick={() => beginLineOp("PERPENDICULAR")}>
                Perpendiculaire
              </button>
            </div>
          </section>

          <section className="section">
            <h2>Panneau reset</h2>
            <div className="row">
              <button
                className="btn gray"
                onClick={() => {
                  if (stateRef.current.anim.active) return;
                  const ok = window.confirm("Confirmer : effacer tous les tracés?");
                  if (!ok) return;
                  stateRef.current = clearShapes(stateRef.current);
                  setRenderState(stateRef.current);
                  magicLineRef.current = null;
                  setLines([]);
                  setMeasurePanelText("Tracés effacés.\n");
                }}
              >
                Effacer tracés
              </button>

              <button
                className="btn gray"
                onClick={() => {
                  if (stateRef.current.anim.active) return;
                  const ok = window.confirm("Confirmer : reset complet (tracés + position) ?");
                  if (!ok) return;

                  stateRef.current = reset(stateRef.current, space);
                  setRenderState(stateRef.current);
                  setFigPts([]);
                  setLinePts([]);
                  setLines([]);
                  setSelected([]);
                  setHovered(null);
                  magicLineRef.current = null;
                  angleHintRef.current = null;
                  setLineOpMode("NONE");
                  setHandMode("NONE");
                  setHandPts([]);
                  setOpPoint(null);
                  setToolMode("NONE");
                  setMeasurePanelText("Reset effectué.\n");
                }}
              >
                Reset total
              </button>

              <button className="btn gray" onClick={recenterFrog}>
                Recentrer grenouille
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
