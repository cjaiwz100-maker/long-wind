// Terrain field: the analytic height function (bible §4.1), the road spline + distance queries, and the separable
// mesh grid that the renderer, the bakes and heightAt() all share. Owner: world (W). Internal to terrain*.js;
// other areas use the public API re-exported by world/terrain.js.
//
//   heightAnalytic(x, z)   pure analytic height (what the mesh vertices sample)
//   heightAt(x, z)         EXACT height of the rendered mesh (triangle interpolation of the vertex grid, same
//                          checkerboard diagonals), analytic fallback outside ±1.5 km
//   normalAt(x, z, out)    smooth normal: bilinear of the grid's central-difference normals (= the mesh shading normal)
//   roadQuery(x, z)        → shared {d, sd, s, grade} (unsigned / signed distance to the road centreline, arclength)
//   grid()                 → {xs, n, H, N}  built synchronously the first time a height query needs it, unless
//                          ensureGrid() (parallel, Web Workers) already did it
// PURE module (no three.js import) so terrain-worker.js can evaluate rows off the main thread.
import { noise } from '../core/noise.js';
import { LAYOUT, onLayoutReset } from './layout.js';

const { simplex2 } = noise;

// ---------------------------------------------------------------- small math
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** GLSL-style smoothstep that also works with reversed edges (e0 > e1). */
export function sstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
export const mix = (a, b, t) => a + (b - a) * t;

/** Normalised simplex fBm (reference `Ln`), ~±0.5 typical. */
export function Ln(x, z, oct = 4) {
  let s = 0, a = 1, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += a * simplex2(x * f + o * 17.13, z * f - o * 9.71); n += a; a *= 0.5; f *= 2.0; }
  return s / n;
}
/** Ridged multifractal (reference `Cf`, Musgrave feedback), range [0, 1]. */
export function Cf(x, z, oct = 5) {
  let s = 0, a = 0.5, f = 1, w = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    let h = 1 - Math.abs(simplex2(x * f + o * 17.3, z * f - o * 9.1));
    h *= h; h *= w; w = Math.min(1, h * 1.6);
    s += h * a; n += a; a *= 0.5; f *= 2.03;
  }
  return s / n;
}

// ---------------------------------------------------------------- road spline (Catmull-Rom → 0.5 m LUT)
const ROAD_STEP = 0.5;
const road = { n: 0, x: null, z: null, s: null, grade: null, length: 0, ready: false };
const BUCKET = 8, MARGIN = 24;  // bucket cell (m) and the distance up to which queries are exact
let bk = null;                  // { x0, z0, nx, nz, start: Int32Array, idx: Int32Array }
let coarse = null;              // every 32nd LUT point, brute-force fallback for far queries

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function buildRoadLUT() {
  const P = LAYOUT.road;
  const dense = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(8, Math.ceil(segLen / 0.1));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      dense.push(catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t));
    }
  }
  dense.push(P[P.length - 1][0], P[P.length - 1][1]);
  // resample by arclength
  const xs = [], zs = [], ss = [];
  let acc = 0, next = 0;
  for (let i = 0; i < dense.length / 2 - 1; i++) {
    const ax = dense[i * 2], az = dense[i * 2 + 1], bx = dense[i * 2 + 2], bz = dense[i * 2 + 3];
    const l = Math.hypot(bx - ax, bz - az);
    while (next <= acc + l) {
      const t = l > 0 ? (next - acc) / l : 0;
      xs.push(ax + (bx - ax) * t); zs.push(az + (bz - az) * t); ss.push(next);
      next += ROAD_STEP;
    }
    acc += l;
  }
  road.n = xs.length;
  road.x = Float32Array.from(xs); road.z = Float32Array.from(zs); road.s = Float32Array.from(ss);
  road.length = acc;
  // grade: pre-road height along the spline, 12 m box filter
  const raw = new Float32Array(road.n);
  for (let i = 0; i < road.n; i++) raw[i] = heightPreRoad(road.x[i], road.z[i]);
  const half = Math.round(6 / ROAD_STEP);
  road.grade = new Float32Array(road.n);
  for (let i = 0; i < road.n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(road.n - 1, i + half); j++) { s += raw[j]; c++; }
    road.grade[i] = s / c;
  }
  // bucket segments (every 2nd LUT point → 1 m segments) into 8 m cells, registered within MARGIN
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < road.n; i++) { minX = Math.min(minX, road.x[i]); maxX = Math.max(maxX, road.x[i]); minZ = Math.min(minZ, road.z[i]); maxZ = Math.max(maxZ, road.z[i]); }
  const x0 = minX - MARGIN - BUCKET, z0 = minZ - MARGIN - BUCKET;
  const nx = Math.ceil((maxX - minX + 2 * MARGIN + 2 * BUCKET) / BUCKET), nz = Math.ceil((maxZ - minZ + 2 * MARGIN + 2 * BUCKET) / BUCKET);
  const lists = new Array(nx * nz);
  for (let i = 0; i + 2 < road.n; i += 2) {
    const ax = road.x[i], az = road.z[i], bx = road.x[i + 2], bz = road.z[i + 2];
    const cx0 = Math.floor((Math.min(ax, bx) - MARGIN - x0) / BUCKET), cx1 = Math.floor((Math.max(ax, bx) + MARGIN - x0) / BUCKET);
    const cz0 = Math.floor((Math.min(az, bz) - MARGIN - z0) / BUCKET), cz1 = Math.floor((Math.max(az, bz) + MARGIN - z0) / BUCKET);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const k = cz * nx + cx; (lists[k] || (lists[k] = [])).push(i);
    }
  }
  const start = new Int32Array(nx * nz + 1); let total = 0;
  for (let k = 0; k < nx * nz; k++) { start[k] = total; total += lists[k] ? lists[k].length : 0; }
  start[nx * nz] = total;
  const idx = new Int32Array(total);
  for (let k = 0; k < nx * nz; k++) if (lists[k]) idx.set(lists[k], start[k]);
  bk = { x0, z0, nx, nz, start, idx };
  const cx = [], cz = [], ci = [];
  for (let i = 0; i < road.n; i += 32) { cx.push(road.x[i]); cz.push(road.z[i]); ci.push(i); }
  coarse = { x: cx, z: cz, i: ci };
  road.ready = true;
}

const RQ = { d: 1e9, sd: 1e9, s: 0, grade: 0 };
/** Distance query against the road centreline. Returns a SHARED object (copy what you need).
 *  exactFar=false skips the (slower) coarse search beyond MARGIN and reports d = 1e9 there. */
export function roadQuery(x, z, exactFar = true) {
  if (!road.ready) buildRoadLUT();
  let best = Infinity, bi = -1, bt = 0, bsd = 1;
  const cx = Math.floor((x - bk.x0) / BUCKET), cz = Math.floor((z - bk.z0) / BUCKET);
  if (cx >= 0 && cz >= 0 && cx < bk.nx && cz < bk.nz) {
    const k = cz * bk.nx + cx;
    for (let j = bk.start[k]; j < bk.start[k + 1]; j++) {
      const i = bk.idx[j];
      const ax = road.x[i], az = road.z[i], dx = road.x[i + 2] - ax, dz = road.z[i + 2] - az;
      const px = x - ax, pz = z - az;
      const t = clamp((px * dx + pz * dz) / (dx * dx + dz * dz), 0, 1);
      const ex = px - dx * t, ez = pz - dz * t, d2 = ex * ex + ez * ez;
      if (d2 < best) { best = d2; bi = i; bt = t; bsd = dx * pz - dz * px; }
    }
  }
  if (bi < 0) {
    if (!exactFar) { RQ.d = 1e9; RQ.sd = 1e9; RQ.s = 0; RQ.grade = 0; return RQ; }
    // far from the road: coarse polyline (≈16 m segments), good enough beyond MARGIN
    for (let j = 0; j + 1 < coarse.x.length; j++) {
      const ax = coarse.x[j], az = coarse.z[j], dx = coarse.x[j + 1] - ax, dz = coarse.z[j + 1] - az;
      const px = x - ax, pz = z - az;
      const t = clamp((px * dx + pz * dz) / (dx * dx + dz * dz), 0, 1);
      const ex = px - dx * t, ez = pz - dz * t, d2 = ex * ex + ez * ez;
      if (d2 < best) { best = d2; bi = coarse.i[j]; bt = t * 32 / 2; bsd = dx * pz - dz * px; }
    }
    const d = Math.sqrt(best);
    RQ.d = d; RQ.sd = bsd >= 0 ? d : -d;
    const li = Math.min(road.n - 1, bi + Math.round(bt * 2));
    RQ.s = road.s[li]; RQ.grade = road.grade[li];
    return RQ;
  }
  const d = Math.sqrt(best);
  RQ.d = d; RQ.sd = bsd >= 0 ? d : -d;
  const f = bi + bt * 2, i0 = Math.min(road.n - 1, Math.floor(f)), i1 = Math.min(road.n - 1, i0 + 1), ft = f - Math.floor(f);
  RQ.s = mix(road.s[i0], road.s[i1], ft);
  RQ.grade = mix(road.grade[i0], road.grade[i1], ft);
  return RQ;
}
export function roadLUT() { if (!road.ready) buildRoadLUT(); return road; }

// ---------------------------------------------------------------- analytic height (bible §4.1)
let KN = LAYOUT.knoll, PV = LAYOUT.pavilion, TP = LAYOUT.terrain;
let Hc = null;
// a level switch (layout.js applyLevelLayout) drops everything derived from the old layout
onLayoutReset(() => { KN = LAYOUT.knoll; PV = LAYOUT.pavilion; TP = LAYOUT.terrain; Hc = null; SW0 = null; road.ready = false; });

/** Rolling steppe before site edits: swells, undulation, hummocks, the knoll and the far ridged rim.
 *  Around the duel site (r < 150 m) the swell is relaxed toward its value at the origin and the undulation damped,
 *  so the knoll reads as a gentle rise on a broad plateau (the default camera sees over it to the horizon), and a
 *  low ridge on the sun side lets bandits crest into view as silhouettes. */
const SUNX = -0.6 / Math.hypot(0.6, 0.78), SUNZ = -0.78 / Math.hypot(0.6, 0.78);
let SW0 = null;
function H0(x, z) {
  const r = Math.hypot(x, z);
  const T = TP;
  const far = sstep(250, 480, r), site = sstep(150, 45, r);
  let swell = T.swell * Ln(x * T.swellFreq, z * T.swellFreq, 4);
  if (site > 0) {
    if (SW0 === null) SW0 = T.swell * Ln(0, 0, 4);
    swell = mix(swell, SW0 + (swell - SW0) * 0.3, site);
  }
  let h = swell
        + T.undul * (1 - T.siteFlatten * site) * (1 - 0.55 * far) * Ln(x * T.undulFreq + 31.7, z * T.undulFreq - 12.3, 2)
        + (far < 1 ? T.hummock * (1 - far) * Ln(x * 0.07 - 5.1, z * 0.07 + 8.9, 2) : 0);
  const kr = Math.hypot(x - KN.x, z - KN.z);
  h += T.knollH * Math.exp(-(kr / T.knollR) * (kr / T.knollR));
  if (T.sunRidge > 0 && r > 40 && r < 160) {
    const cs = (x * SUNX + z * SUNZ) / r;
    h += T.sunRidge * Math.exp(-((r - 88) / 17) * ((r - 88) / 17)) * sstep(0.45, 0.85, cs);
  }
  if (r > 340) {
    // rolling foothills rising beyond play: ridged + smooth blend; the finest octave fades where the grid is coarse
    const k = sstep(340, 1150, r);
    // broad steppe swells and long ridgelines (not a dune field): low-frequency ridged + smooth blend
    let rim = (0.42 * Cf(x * 0.0021 + 3.3, z * 0.0021 - 7.7, 2) + 0.58 * (0.5 + Ln(x * 0.0011 - 1.1, z * 0.0011 + 2.2, 2))) * T.rim * k;
    const S = 70 + 30 * Ln(x * 0.002, z * 0.002, 2);
    if (rim > 0.7 * S) rim = 0.7 * S + (rim - 0.7 * S) * 0.35;
    h += rim;
  }
  return h;
}

/** Height with the site edits that the road grade is computed from (crest pad, pavilion rise). */
function heightPreRoad(x, z) {
  if (Hc === null) Hc = H0(KN.x, KN.z);
  let h = H0(x, z);
  const kr = Math.hypot(x - KN.x, z - KN.z);
  if (kr < 16) h = mix(h, Hc + 0.03 * Ln(x * 0.5, z * 0.5, 1), sstep(16, KN.padR, kr));
  // old grave mounds (坟包): slumped, grass-grown domes behind their headstones
  for (const g of LAYOUT.graves) {
    const gd2 = (x - g.x) * (x - g.x) + (z - g.z) * (z - g.z);
    if (gd2 < 16) h += 0.46 * Math.exp(-gd2 / 1.25);
  }
  // pavilion: a low rise with a flat pad (the stone platform sits on it)
  const pd = Math.hypot(x - PV.x, z - PV.z);
  if (pd < 40) {
    h += 1.3 * Math.exp(-(pd / 15) * (pd / 15));
    if (pd < 9) {
      const hp = H0(PV.x, PV.z) + 1.3;
      h = mix(h, hp, sstep(8.5, PV.r + 1.2, pd));
    }
  }
  return h;
}

/** Full analytic height (what every mesh vertex samples). */
export function heightAnalytic(x, z) {
  let h = heightPreRoad(x, z);
  const q = roadQuery(x, z, false);
  if (q.d < 4.5) h = mix(h, q.grade, sstep(4.5, 1.6, q.d) * 0.85);
  const r = Math.hypot(x, z);
  if (r > 170) h += TP.edgeRise * sstep(170, 240, r) * (0.6 + 0.4 * Ln(x * 0.01, z * 0.01, 1));
  // town (levels/town.js): a canal crossing the street, the street arching over it as a stone bridge
  const TW = LAYOUT.town;
  if (TW?.canal) {
    const C = TW.canal, dx = Math.abs(x - C.x), half = C.width * 0.5, sw = TW.street.width * 0.5 + 0.6;
    if (dx < half + 2.5 && Math.abs(z) < 260) {
      const bed = sstep(half + 2.5, half - 0.6, dx);                 // stone-lined banks, a flat bed
      const deck = sstep(sw + 1.2, sw, Math.abs(z));                  // no canal under the bridge walkway
      h -= C.depth * bed * (1 - deck);
    }
    const B = TW.bridge;
    if (B && Math.abs(x - B.x) < B.span * 0.5 && Math.abs(z) < sw + 1.2) {
      const u = (x - B.x) / (B.span * 0.5), c = Math.cos(u * Math.PI * 0.5);
      h += B.rise * c * c * sstep(sw + 1.2, sw, Math.abs(z));
    }
  }
  return h;
}

// ---------------------------------------------------------------- mesh grid (bible §4.2)
export const GRID = { spacing: 0.75, coreSteps: 213, grow: 1.045, edge: 1500 };
let G_ = null;

export function buildAxis() {
  const pos = [0];
  let x = 0, step = GRID.spacing;
  for (let i = 0; i < GRID.coreSteps; i++) { x += step; pos.push(x); }
  while (x < GRID.edge - 1e-3) { step *= GRID.grow; x = Math.min(GRID.edge, x + step); if (GRID.edge - x < step * 0.35) x = GRID.edge; pos.push(x); }
  const neg = pos.slice(1).reverse().map(v => -v);
  return Float64Array.from([...neg, ...pos]);
}

/** Heights of grid rows [j0, j1) (used by the main thread and by terrain-worker.js). */
export function gridRows(j0, j1, xs = buildAxis()) {
  const n = xs.length, out = new Float32Array((j1 - j0) * n);
  for (let j = j0; j < j1; j++) { const z = xs[j], o = (j - j0) * n; for (let i = 0; i < n; i++) out[o + i] = heightAnalytic(xs[i], z); }
  return out;
}

function finalizeGrid(xs, H) {
  const n = xs.length;
  const N = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const dx = (H[j * n + i1] - H[j * n + i0]) / (xs[i1] - xs[i0]);
      const dz = (H[j1 * n + i] - H[j0 * n + i]) / (xs[j1] - xs[j0]);
      const il = 1 / Math.sqrt(dx * dx + 1 + dz * dz), k = (j * n + i) * 3;
      N[k] = -dx * il; N[k + 1] = il; N[k + 2] = -dz * il;
    }
  }
  const coreStart = (n - 1) / 2 - GRID.coreSteps, coreHalf = GRID.coreSteps * GRID.spacing;
  G_ = { xs, n, H, N, coreStart, coreHalf };
  return G_;
}

/** Vertex grid: xs (both axes), n per axis, H heights [j*n+i], N normals xyz. Synchronous build if needed. */
export function grid() {
  if (G_) return G_;
  const xs = buildAxis();
  return finalizeGrid(xs, gridRows(0, xs.length, xs));
}

/** Install a grid computed elsewhere (worker pool / another thread). */
export function setGrid(xs, H) { return finalizeGrid(xs instanceof Float64Array ? xs : Float64Array.from(xs), H); }
export function hasGrid() { return !!G_; }

/** Build the grid with a worker pool (see terrain-pool.js); falls back to the synchronous build. */
export async function ensureGrid(pool) {
  if (G_) return G_;
  const xs = buildAxis(), n = xs.length;
  if (!pool || pool.size <= 1) return grid();
  try {
    const H = new Float32Array(n * n);
    const per = Math.ceil(n / pool.size);
    await Promise.all(Array.from({ length: pool.size }, (_, w) => {
      const j0 = w * per, j1 = Math.min(n, j0 + per);
      if (j0 >= j1) return null;
      return pool.run({ type: 'grid', j0, j1 }).then((d) => H.set(d.rows, j0 * n));
    }));
    if (G_) return G_;   // a synchronous caller got there first
    return finalizeGrid(xs, H);
  } catch (err) {
    console.warn('[terrain] worker grid build failed, building on the main thread', err);
    return grid();
  }
}

// cell lookup: returns cell index and writes the fraction into LOC.f
const LOC = { i: 0, f: 0 };
function locate(v, g) {
  if (v >= -g.coreHalf && v <= g.coreHalf) {
    const t = (v + g.coreHalf) / GRID.spacing;
    let i = Math.floor(t); if (i >= GRID.coreSteps * 2) i = GRID.coreSteps * 2 - 1;
    LOC.i = i + g.coreStart; LOC.f = t - i; return LOC;
  }
  const xs = g.xs;
  let lo = 0, hi = g.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= v) lo = m; else hi = m; }
  LOC.i = lo; LOC.f = (v - xs[lo]) / (xs[lo + 1] - xs[lo]); return LOC;
}

/** Exact rendered-mesh height (same triangles as the index buffer). */
export function heightAt(x, z) {
  const g = G_ || grid();
  if (x <= -GRID.edge || x >= GRID.edge || z <= -GRID.edge || z >= GRID.edge) return heightAnalytic(x, z);
  const lx = locate(x, g), i = lx.i, fx = lx.f;
  const lz = locate(z, g), j = lz.i, fz = lz.f;
  const n = g.n, H = g.H, k = j * n + i;
  const h00 = H[k], h10 = H[k + 1], h01 = H[k + n], h11 = H[k + n + 1];
  if (((i + j) & 1) === 0) {           // diagonal v00–v11
    return fx >= fz ? h00 + fx * (h10 - h00) + fz * (h11 - h10) : h00 + fz * (h01 - h00) + fx * (h11 - h01);
  }
  // diagonal v10–v01
  return fx + fz <= 1 ? h00 + fx * (h10 - h00) + fz * (h01 - h00) : h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
}

/** Smooth surface normal (bilinear of the vertex normals) written into out.{x,y,z}; returns out. */
export function normalInto(x, z, out) {
  const g = G_ || grid();
  let nx, ny, nz;
  if (x <= -GRID.edge || x >= GRID.edge || z <= -GRID.edge || z >= GRID.edge) {
    const e = 1.0;
    nx = heightAnalytic(x - e, z) - heightAnalytic(x + e, z); ny = 2 * e; nz = heightAnalytic(x, z - e) - heightAnalytic(x, z + e);
  } else {
    const lx = locate(x, g), i = lx.i, fx = lx.f;
    const lz = locate(z, g), j = lz.i, fz = lz.f;
    const N = g.N, n = g.n, k0 = (j * n + i) * 3, k1 = k0 + 3, k2 = k0 + n * 3, k3 = k2 + 3;
    const w0 = (1 - fx) * (1 - fz), w1 = fx * (1 - fz), w2 = (1 - fx) * fz, w3 = fx * fz;
    nx = N[k0] * w0 + N[k1] * w1 + N[k2] * w2 + N[k3] * w3;
    ny = N[k0 + 1] * w0 + N[k1 + 1] * w1 + N[k2 + 1] * w2 + N[k3 + 1] * w3;
    nz = N[k0 + 2] * w0 + N[k1 + 2] * w1 + N[k2 + 2] * w2 + N[k3 + 2] * w3;
  }
  const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
  out.x = nx * il; out.y = ny * il; out.z = nz * il;
  return out;
}

/** Terrain mesh arrays from the grid: positions, normals, checkerboard-diagonal Uint32 index. */
export function buildGeometryArrays() {
  const g = grid(), n = g.n, xs = g.xs;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    pos[k * 3] = xs[i]; pos[k * 3 + 1] = g.H[k]; pos[k * 3 + 2] = xs[j];
  }
  const nrm = g.N.slice();
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const v00 = j * n + i, v10 = v00 + 1, v01 = v00 + n, v11 = v01 + 1;
    if (((i + j) & 1) === 0) { idx[o++] = v00; idx[o++] = v01; idx[o++] = v11; idx[o++] = v00; idx[o++] = v11; idx[o++] = v10; }
    else { idx[o++] = v00; idx[o++] = v01; idx[o++] = v10; idx[o++] = v10; idx[o++] = v01; idx[o++] = v11; }
  }
  return { pos, nrm, idx, n };
}
