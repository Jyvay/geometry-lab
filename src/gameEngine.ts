// src/gameEngine.ts

export type Geometry = "euclidean" | "spherical" | "hyperbolic" | "cylindrical";

export interface GameSettings {
  geom: Geometry;
  mysteryMode: boolean;
  mysteryGeom: Geometry;
  baseSpeed: number;
  slopeAngle: number;
  slopeStrength: number;
  showLocalGrid: boolean;
  localGridCell: number;
  localGridRadius: number;
  trailEnabled: boolean;
}

export interface GameCommands {
  clearMarkers: boolean;
  clearTrail: boolean;
}

const WORLD_SIZE = 2000;
const VIEW_W = 900;
const VIEW_H = 560;
const MINIMAP_W = 180;
const MINIMAP_H = 180;
const HYP_SCALE = 1 / 400; // controls how fast hyperbolic coords approach boundary

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const mod = (n: number, m: number) => ((n % m) + m) % m;

/* =====================  SPHERICAL HELPERS  ===================== */

// Map projection for spherical: lon/lat -> "world" map coords
function sphToMapXY(lon: number, lat: number): { x: number; y: number } {
  // lon in [-π, π], lat in [-π/2, π/2]
  const x = ((lon + Math.PI) / (2 * Math.PI)) * WORLD_SIZE;
  const y = ((Math.PI / 2 - lat) / Math.PI) * WORLD_SIZE; // north at y=0
  return { x, y };
}

// Inverse projection: world map coords -> lon/lat
function mapXYToSph(x: number, y: number): { lon: number; lat: number } {
  const lon = (x / WORLD_SIZE) * 2 * Math.PI - Math.PI;
  const lat = Math.PI / 2 - (y / WORLD_SIZE) * Math.PI;
  return { lon, lat };
}

function sphToCartesian(lon: number, lat: number) {
  const clat = Math.cos(lat);
  return {
    x: clat * Math.cos(lon),
    y: clat * Math.sin(lon),
    z: Math.sin(lat),
  };
}

// tangent unit vectors for east and north at (lon, lat)
function sphericalBasis(lon: number, lat: number) {
  const east = {
    x: -Math.sin(lon),
    y: Math.cos(lon),
    z: 0,
  };
  const north = {
    x: -Math.sin(lat) * Math.cos(lon),
    y: -Math.sin(lat) * Math.sin(lon),
    z: Math.cos(lat),
  };
  return { east, north };
}

function projectToLocalSphTangent(
  frogLon: number,
  frogLat: number,
  pointLon: number,
  pointLat: number
): { u: number; v: number } {
  const F = sphToCartesian(frogLon, frogLat);
  const P = sphToCartesian(pointLon, pointLat);
  const { east, north } = sphericalBasis(frogLon, frogLat);

  const vx = P.x - F.x;
  const vy = P.y - F.y;
  const vz = P.z - F.z;

  const u = vx * east.x + vy * east.y + vz * east.z;
  const v = vx * north.x + vy * north.y + vz * north.z;

  return { u, v };
}

/* =====================  CYLINDRICAL HELPERS  ===================== */

// Cylinder coords: (theta, z) -> world map
function cylToMapXY(theta: number, z: number): { x: number; y: number } {
  // horizontal: infinite z, centered at WORLD_SIZE/2
  const x = WORLD_SIZE / 2 + z;
  // vertical: theta wraps into [0, WORLD_SIZE]
  const y = ((theta / (2 * Math.PI)) % 1 + 1) % 1 * WORLD_SIZE;
  return { x, y };
}

function mapXYToCyl(x: number, y: number): { theta: number; z: number } {
  const theta = (y / WORLD_SIZE) * 2 * Math.PI;
  const z = x - WORLD_SIZE / 2;
  return { theta, z };
}

function cylToCartesian(theta: number, z: number) {
  const R = 1;
  return {
    x: R * Math.cos(theta),
    y: R * Math.sin(theta),
    z,
  };
}

// tangent directions: around the cylinder and along axis
function cylindricalBasis(theta: number, _z: number) {
  const circ = {
    x: -Math.sin(theta),
    y: Math.cos(theta),
    z: 0,
  };
  const axial = {
    x: 0,
    y: 0,
    z: 1,
  };
  return { circ, axial };
}

function projectToLocalCylTangent(
  frogTheta: number,
  frogZ: number,
  pointTheta: number,
  pointZ: number
): { u: number; v: number } {
  const F = cylToCartesian(frogTheta, frogZ);
  const P = cylToCartesian(pointTheta, pointZ);
  const { circ, axial } = cylindricalBasis(frogTheta, frogZ);

  const vx = P.x - F.x;
  const vy = P.y - F.y;
  const vz = P.z - F.z;

  const u = vx * circ.x + vy * circ.y + vz * circ.z; // around circumference
  const v = vx * axial.x + vy * axial.y + vz * axial.z; // along axis

  return { u, v };
}

/* =====================  HYPERBOLIC HELPERS (PSEUDO)  ===================== */

// Intrinsic hyperbolic coords (u,v) <-> world coords via tanh
function hypToMapXY(u: number, v: number): { x: number; y: number } {
  const sx = Math.tanh(u * HYP_SCALE);
  const sy = Math.tanh(v * HYP_SCALE);
  const x = (sx + 1) / 2 * WORLD_SIZE;
  const y = (sy + 1) / 2 * WORLD_SIZE;
  return { x, y };
}

function atanhSafe(x: number): number {
  const eps = 1e-9;
  const clamped = Math.max(-1 + eps, Math.min(1 - eps, x));
  return 0.5 * Math.log((1 + clamped) / (1 - clamped));
}

function mapXYToHyp(x: number, y: number): { u: number; v: number } {
  const sx = 2 * (x / WORLD_SIZE) - 1;
  const sy = 2 * (y / WORLD_SIZE) - 1;
  const u = atanhSafe(sx) / HYP_SCALE;
  const v = atanhSafe(sy) / HYP_SCALE;
  return { u, v };
}

/* =====================  INPUT & DRAWING  ===================== */

function createKeyState() {
  const keys: Record<string, boolean> = {};

  const down = (e: KeyboardEvent) => {
    keys[e.key.toLowerCase()] = true;
  };
  const up = (e: KeyboardEvent) => {
    keys[e.key.toLowerCase()] = false;
  };

  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);

  return {
    keys,
    dispose() {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    },
  };
}

function drawGrid(ctx: CanvasRenderingContext2D, camX: number, camY: number, cell = 100) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#e5e7eb";
  const startX = -((camX % cell) + cell) % cell;
  const startY = -((camY % cell) + cell) % cell;
  for (let x = startX; x < w; x += cell) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = startY; y < h; y += cell) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLocalGrid(
  ctx: CanvasRenderingContext2D,
  frogX: number,
  frogY: number,
  cell = 80,
  radiusCells = 4
) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#cbd5e1";

  const left = frogX - radiusCells * cell;
  const right = frogX + radiusCells * cell;
  const top = frogY - radiusCells * cell;
  const bottom = frogY + radiusCells * cell;

  ctx.fillStyle = "rgba(148,163,184,0.08)";
  ctx.fillRect(left, top, right - left, bottom - top);

  for (let x = Math.floor(left / cell) * cell; x <= right; x += cell) {
    ctx.globalAlpha = 0.9 - Math.min(0.7, Math.abs(x - frogX) / (radiusCells * cell));
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let y = Math.floor(top / cell) * cell; y <= bottom; y += cell) {
    ctx.globalAlpha = 0.9 - Math.min(0.7, Math.abs(y - frogY) / (radiusCells * cell));
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawSlopeVector(ctx: CanvasRenderingContext2D, angle: number, strength: number) {
  const w = ctx.canvas.width;
  const cx = w - 80;
  const cy = 60;
  const len = 40;
  const dx = Math.cos(angle) * len;
  const dy = Math.sin(angle) * len;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#0ea5e9";
  ctx.fillStyle = "#0ea5e9";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dx, cy + dy);
  ctx.stroke();
  const ang = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.moveTo(cx + dx, cy + dy);
  ctx.lineTo(
    cx + dx - Math.cos(ang - Math.PI / 6) * 10,
    cy + dy - Math.sin(ang - Math.PI / 6) * 10
  );
  ctx.lineTo(
    cx + dx - Math.cos(ang + Math.PI / 6) * 10,
    cy + dy - Math.sin(ang + Math.PI / 6) * 10
  );
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#334155";
  ctx.font = "12px ui-sans-serif, system-ui, -apple-system";
  ctx.fillText("slope", cx - 18, cy + 20);
  ctx.fillText(`k=${strength.toFixed(2)}`, cx - 20, cy + 36);
  ctx.restore();
}

function mapCamera(pos: { x: number; y: number }, geom: Geometry) {
  let camX = pos.x - VIEW_W / 2;
  let camY = pos.y - VIEW_H / 2;
  if (geom === "spherical" || geom === "cylindrical" || geom === "hyperbolic") {
    // clamp to a reasonable box around [0, WORLD_SIZE]
    camX = clamp(camX, -WORLD_SIZE, 2 * WORLD_SIZE - VIEW_W);
    camY = clamp(camY, -WORLD_SIZE, 2 * WORLD_SIZE - VIEW_H);
  }
  return { camX, camY };
}

function drawFrog(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.font = "28px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("🐸", x, y);
  ctx.restore();
}

function drawRoomBounds(
  ctx: CanvasRenderingContext2D,
  geom: Geometry,
  camX: number,
  camY: number
) {
  if (geom === "spherical" || geom === "cylindrical" || geom === "hyperbolic") {
    ctx.save();
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 2;
    ctx.strokeRect(-camX, -camY, WORLD_SIZE, WORLD_SIZE);
    ctx.restore();
  }
}

/* =====================  MINIMAP  ===================== */

function minimapProject(
  pos: { x: number; y: number },
  geom: Geometry,
  sph?: { lon: number; lat: number },
  cyl?: { theta: number; z: number },
  hyp?: { u: number; v: number }
): [number, number] {
  if (geom === "spherical") {
    if (!sph) return [0.5, 0.5];
    const { lon, lat } = mapXYToSph(pos.x, pos.y);
    const local = projectToLocalSphTangent(sph.lon, sph.lat, lon, lat);
    const scale = 2.0;
    const nx = 0.5 + local.u * scale;
    const ny = 0.5 - local.v * scale;
    return [nx, ny];
  }

  if (geom === "cylindrical") {
    if (!cyl) return [0.5, 0.5];
    const { theta, z } = mapXYToCyl(pos.x, pos.y);
    const local = projectToLocalCylTangent(cyl.theta, cyl.z, theta, z);
    // local.u, local.v are in 3D cylinder units; scale to [0,1]
    const scaleU = 0.4; // around
    const scaleV = 1 / (WORLD_SIZE / 4); // along axis (z in pixels)
    const nx = 0.5 + local.u * scaleU;
    const ny = 0.5 - local.v * scaleV;
    return [nx, ny];
  }

  if (geom === "hyperbolic") {
    if (!hyp) return [0.5, 0.5];
    const { u, v } = mapXYToHyp(pos.x, pos.y);
    const du = u - hyp.u;
    const dv = v - hyp.v;
    const scale = 0.05; // hyperbolic coords can be large
    const nx = 0.5 + du * scale;
    const ny = 0.5 - dv * scale;
    return [nx, ny];
  }

  // Euclidean: simple tanh window around origin
  const scale = 1 / 1600;
  const sx = Math.tanh(pos.x * scale);
  const sy = Math.tanh(pos.y * scale);
  return [(sx + 1) / 2, (sy + 1) / 2];
}

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  pos: { x: number; y: number },
  geom: Geometry,
  markers: { x: number; y: number }[],
  trail: { x: number; y: number }[],
  sph?: { lon: number; lat: number },
  cyl?: { theta: number; z: number },
  hyp?: { u: number; v: number }
) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#475569";
  ctx.lineWidth = 2;
  ctx.strokeRect(6, 6, w - 12, h - 12);

  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const gx = 6 + ((w - 12) * i) / 4;
    const gy = 6 + ((h - 12) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(gx, 6);
    ctx.lineTo(gx, h - 6);
    ctx.moveTo(6, gy);
    ctx.lineTo(w - 6, gy);
    ctx.stroke();
  }

  // frog
  {
    const [mx, my] = minimapProject(pos, geom, sph, cyl, hyp);
    const px = 6 + mx * (w - 12);
    const py = 6 + my * (h - 12);
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // trail
  if (trail.length > 1) {
    ctx.save();
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    trail.forEach((p, i) => {
      const [tx, ty] = minimapProject(p, geom, sph, cyl, hyp);
      const tpx = 6 + tx * (w - 12);
      const tpy = 6 + ty * (h - 12);
      if (i === 0) ctx.moveTo(tpx, tpy);
      else ctx.lineTo(tpx, tpy);
    });
    ctx.stroke();
    ctx.restore();
  }

  // markers
  markers.forEach((m) => {
    const [mx2, my2] = minimapProject(m, geom, sph, cyl, hyp);
    const mpx = 6 + mx2 * (w - 12);
    const mpy = 6 + my2 * (h - 12);
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(mpx, mpy, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = "#e5e7eb";
  ctx.font = "12px ui-sans-serif, system-ui";
  ctx.fillText("minimap", 10, h - 10);
  ctx.restore();
}

function backgroundPattern(ctx: CanvasRenderingContext2D, geom: Geometry) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.save();
  if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, w, h);

  ctx.globalAlpha = 0.06;
  if (geom === "euclidean") ctx.fillStyle = "#93c5fd";
  if (geom === "spherical") ctx.fillStyle = "#f9a8d4";
  if (geom === "hyperbolic") ctx.fillStyle = "#67e8f9";
  if (geom === "cylindrical") ctx.fillStyle = "#6ee7b7";
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* =====================  MAIN ENGINE  ===================== */

export function startGame(
  canvas: HTMLCanvasElement,
  minimapCanvas: HTMLCanvasElement | null,
  settingsRef: { current: GameSettings },
  commandsRef: { current: GameCommands }
): () => void {
  let lastGeom: Geometry = settingsRef.current.geom;
  const ctx = canvas.getContext("2d");
  const minimapCtx = minimapCanvas ? minimapCanvas.getContext("2d") : null;
  if (!ctx) return () => {};

  const keyState = createKeyState();

  let last = performance.now();
  let animId = 0;

  // common world position (map coords)
  let pos = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  let markers: { x: number; y: number }[] = [];
  let trail: { x: number; y: number }[] = [];

  // intrinsic coordinates per geometry
  let sph = { lon: 0, lat: 0 };
  let cyl = { theta: 0, z: 0 };
  let hyp = { u: 0, v: 0 };

  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const settings = settingsRef.current;
    const commands = commandsRef.current;
    const geom: Geometry = settings.mysteryMode
      ? settings.mysteryGeom
      : settings.geom;

    // geometry change/reset
    if (geom !== lastGeom) {
      if (geom === "spherical") {
        sph = { lon: 0, lat: 0 };
        pos = sphToMapXY(sph.lon, sph.lat);
      } else if (geom === "cylindrical") {
        cyl = { theta: 0, z: 0 };
        pos = cylToMapXY(cyl.theta, cyl.z);
      } else if (geom === "hyperbolic") {
        hyp = { u: 0, v: 0 };
        pos = hypToMapXY(hyp.u, hyp.v);
      } else {
        pos = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
      }
      trail = [];
      markers = [];
      lastGeom = geom;
    }

    const slopeVec = {
      x: Math.cos(settings.slopeAngle),
      y: Math.sin(settings.slopeAngle),
    };

    // UI commands
    if (commands.clearMarkers) {
      markers = [];
      commands.clearMarkers = false;
    }
    if (commands.clearTrail) {
      trail = [];
      commands.clearTrail = false;
    }

    // input
    let ix = 0,
      iy = 0;
    const keys = keyState.keys;
    if (keys["arrowleft"] || keys["a"]) ix -= 1;
    if (keys["arrowright"] || keys["d"]) ix += 1;
    if (keys["arrowup"] || keys["w"]) iy -= 1;
    if (keys["arrowdown"] || keys["s"]) iy += 1;

    // marker with M
    if (keys["m"]) {
      markers.push({ x: pos.x, y: pos.y });
      keys["m"] = false;
    }

    // Toggle trail with T key
    if (keys["t"]) {
      settingsRef.current.trailEnabled = !settingsRef.current.trailEnabled;
      keys["t"] = false;
    }

    let len = Math.hypot(ix, iy);
    let dx = 0,
      dy = 0;
    if (len > 0) {
      dx = ix / len;
      dy = iy / len;
    }

    // base speed + slope effect (only in Euclidean)
    let speed = settings.baseSpeed;
    if (geom === "euclidean") {
      const proj = dx * slopeVec.x + dy * slopeVec.y;
      const factor = 1 + settings.slopeStrength * proj;
      speed = Math.max(60, settings.baseSpeed * factor);
    }

    // ---- POSITION UPDATE ----
    if (geom === "spherical") {
      const { east, north } = sphericalBasis(sph.lon, sph.lat);
      let tx = east.x * dx + north.x * -dy;
      let ty = east.y * dx + north.y * -dy;
      let tz = east.z * dx + north.z * -dy;

      const tLen = Math.hypot(tx, ty, tz);
      if (tLen > 0) {
        tx /= tLen;
        ty /= tLen;
        tz /= tLen;

        const angle = (speed / WORLD_SIZE) * 2 * Math.PI * dt;

        let { x: px, y: py, z: pz } = sphToCartesian(sph.lon, sph.lat);
        px += tx * angle;
        py += ty * angle;
        pz += tz * angle;
        const pLen = Math.hypot(px, py, pz);
        px /= pLen;
        py /= pLen;
        pz /= pLen;

        sph.lat = Math.asin(pz);
        sph.lon = Math.atan2(py, px);
      }
      pos = sphToMapXY(sph.lon, sph.lat);

    } else if (geom === "cylindrical") {
      // interpret dx along z, dy around theta
      cyl.z += dx * speed * dt;
      cyl.theta += -dy * speed * dt * (1 / 200); // 200 is arbitrary radius-scale for feel
      pos = cylToMapXY(cyl.theta, cyl.z);

    } else if (geom === "hyperbolic") {
      // intrinsic coords (u,v) change linearly, but map to screen with tanh
      hyp.u += dx * speed * dt;
      hyp.v += dy * speed * dt;
      pos = hypToMapXY(hyp.u, hyp.v);

    } else {
      // Euclidean
      let nx = pos.x + dx * speed * dt;
      let ny = pos.y + dy * speed * dt;
      pos = { x: nx, y: ny };
    }

    // ---- TRAIL UPDATE ----
    if (settings.trailEnabled) {
      trail.push({ x: pos.x, y: pos.y });
      if (trail.length > 1500) trail.shift();
    }

    // ---- RENDER ----
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    backgroundPattern(ctx, geom);

    const { camX, camY } = mapCamera(pos, geom);
    ctx.save();
    ctx.translate(-camX, -camY);

    drawGrid(ctx, camX, camY, 120);
    drawRoomBounds(ctx, geom, camX, camY);

    // trail
    if (trail.length > 1) {
      ctx.save();
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 4;
      ctx.beginPath();
      trail.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.restore();
    }

    // markers
    markers.forEach((m) => {
      ctx.save();
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(m.x, m.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    if (settings.showLocalGrid) {
      drawLocalGrid(ctx, pos.x, pos.y, settings.localGridCell, settings.localGridRadius);
    }

    drawFrog(ctx, pos.x, pos.y);

    ctx.restore();

    drawSlopeVector(ctx, settings.slopeAngle, settings.slopeStrength);

    if (minimapCtx) {
      minimapCtx.canvas.width = MINIMAP_W;
      minimapCtx.canvas.height = MINIMAP_H;
      drawMinimap(
        minimapCtx,
        pos,
        geom,
        markers,
        trail,
        geom === "spherical" ? sph : undefined,
        geom === "cylindrical" ? cyl : undefined,
        geom === "hyperbolic" ? hyp : undefined
      );
    }

    animId = requestAnimationFrame(loop);
  };

  animId = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(animId);
    keyState.dispose();
  };
}
