// World bakes (bible §4.3): 2048² over ±512 m (0.5 m texels), computed on the CPU from the terrain field, the road,
// the rock plan and the layout, then uploaded once. Owner: world (W).
//   height  Float32 (R32F)  exact mesh height at texel centres (heightAt = triangle interpolation of the grid)
//   splat   RGBA8           R lush, G dry thatch, B rock, A dirt/road           (weights sum to 1)
//   ground  RGBA8           R grass density, G grass height factor, B late-green species weight (0 golden … 1 green),
//                           A cavity AO (≈0.45 in hollows … 1 on ridges; rock/tree occlusion included)
//   aux     RGBA8           R road weight, G signed road distance (sd/8 + 0.5, i.e. ±4 m), B tree proximity
//                           (leaf carpet / canopy), A packed-earth pads (knoll crest, props)
// The bake runs in horizontal bands: each band evaluates its own heights (+ margin rows for the cavity term), its
// 2 m noise-field rows and its rasters, so bands are independent and run in parallel workers (terrain-pool.js).
// PURE module (no three.js) so the worker can import it.
import { LAYOUT } from './layout.js';
import { grid, roadLUT, sstep, clamp, Ln } from './terrain-field.js';
import { noise } from '../core/noise.js';

// Golden-hour key direction (globals.SUN_DIR) — duplicated so this module stays three-free for the worker.
const SUN_DIR = { x: -0.6, y: 0.165, z: -0.78 };

export const BAKE_N = 2048, BAKE_HALF = 512, BAKE_TEXEL = (2 * BAKE_HALF) / BAKE_N;
const NF = 512, NF_CH = 7, NF_STEP = (2 * BAKE_HALF) / NF;   // noise fields: 2 m texels
const MARGIN = 24;                                            // extra height rows for the ±11 m cavity taps

const toTex = (w) => (w + BAKE_HALF) / BAKE_TEXEL - 0.5;      // world → texel coordinate
const toWorld = (t) => -BAKE_HALF + (t + 0.5) * BAKE_TEXEL;

/** Noise-field rows [f0, f1) (7 interleaved low-frequency fields at 2 m). */
function noiseRows(f0, f1) {
  const out = new Float32Array((f1 - f0) * NF * NF_CH);
  for (let j = f0; j < f1; j++) {
    const z = -BAKE_HALF + (j + 0.5) * NF_STEP;
    for (let i = 0; i < NF; i++) {
      const x = -BAKE_HALF + (i + 0.5) * NF_STEP, o = ((j - f0) * NF + i) * NF_CH;
      out[o] = noise.simplex2(x * 0.06, z * 0.06);          // O   boundary jitter (~17 m)
      out[o + 1] = Ln(x * 0.017 + 5.3, z * 0.017, 3);       // L   dirt patches
      out[o + 2] = Ln(x * 0.012, z * 0.012 - 7.1, 3);       // dry patches
      out[o + 3] = Ln(x * 0.05 - 2.2, z * 0.05 + 1.7, 2);   // grass density
      out[o + 4] = Ln(x * 0.02 + 9.9, z * 0.02 + 3.3, 2);   // grass height
      out[o + 5] = Ln(x * 0.01 - 4.4, z * 0.01 + 6.6, 2);   // moisture
      out[o + 6] = Ln(x * 0.045 + 1.9, z * 0.045 - 8.8, 3); // species patches (15–35 m, ragged edges)
    }
  }
  return out;
}

/** Exact mesh heights for bake rows [r0, r1) (rows clamped to the texture). */
function heightRows(r0, r1) {
  const g = grid(), n = g.n, H = g.H, xs = g.xs, N = BAKE_N;
  const ci = new Int32Array(N), cf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = toWorld(i);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= v) lo = m; else hi = m; }
    ci[i] = lo; cf[i] = (v - xs[lo]) / (xs[lo + 1] - xs[lo]);
  }
  const out = new Float32Array((r1 - r0) * N);
  for (let r = r0; r < r1; r++) {
    const jz = r < 0 ? 0 : r >= N ? N - 1 : r;
    const j = ci[jz], fz = cf[jz], row = j * n, o = (r - r0) * N;
    for (let ix = 0; ix < N; ix++) {
      const i = ci[ix], fx = cf[ix], k = row + i;
      const h00 = H[k], h10 = H[k + 1], h01 = H[k + n], h11 = H[k + n + 1];
      let h;
      if (((i + j) & 1) === 0) h = fx >= fz ? h00 + fx * (h10 - h00) + fz * (h11 - h10) : h00 + fz * (h01 - h00) + fx * (h11 - h01);
      else h = fx + fz <= 1 ? h00 + fx * (h10 - h00) + fz * (h01 - h00) : h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
      out[o + ix] = h;
    }
  }
  return out;
}

/** Bake rows [j0, j1). Requires the grid (grid()/setGrid) and the rock plan (plain objects). */
export function bakeBand({ j0, j1, plan }) {
  const N = BAKE_N, T = BAKE_TEXEL, rows = j1 - j0, NB = rows * N;
  const TR = LAYOUT.oldTree, P = LAYOUT.pavilion, S = LAYOUT.stele;
  // heights with margin
  const hb = heightRows(j0 - MARGIN, j1 + MARGIN), HW = N;
  const height = hb.slice(MARGIN * N, (MARGIN + rows) * N);
  // noise-field rows covering the band (+1 for bilinear)
  const zLo = toWorld(j0), zHi = toWorld(j1 - 1);
  const f0 = clamp(Math.floor((zLo + BAKE_HALF) / NF_STEP - 0.5), 0, NF - 1), f1 = clamp(Math.floor((zHi + BAKE_HALF) / NF_STEP - 0.5) + 2, 1, NF);
  const fields = noiseRows(f0, f1), fRows = f1 - f0;

  // ---- band rasters
  const inBand = (j) => j >= j0 && j < j1;
  const stamp = (x, z, rad, fn) => {
    const i0 = Math.max(0, Math.floor(toTex(x - rad))), i1 = Math.min(N - 1, Math.ceil(toTex(x + rad)));
    const ja = Math.max(j0, Math.floor(toTex(z - rad))), jb = Math.min(j1 - 1, Math.ceil(toTex(z + rad)));
    for (let j = ja; j <= jb; j++) {
      const wz = toWorld(j) - z;
      for (let i = i0; i <= i1; i++) {
        const wx = toWorld(i) - x, d = Math.sqrt(wx * wx + wz * wz);
        if (d <= rad) fn((j - j0) * N + i, d);
      }
    }
  };
  const roadD = new Float32Array(NB).fill(99), roadSD = new Float32Array(NB).fill(99);
  {
    const R = roadLUT(), W = 6;
    for (let s = 0; s + 1 < R.n; s++) {
      const ax = R.x[s], az = R.z[s], bx = R.x[s + 1], bz = R.z[s + 1];
      const i0 = Math.max(0, Math.floor(toTex(Math.min(ax, bx) - W))), i1 = Math.min(N - 1, Math.ceil(toTex(Math.max(ax, bx) + W)));
      const ja = Math.max(j0, Math.floor(toTex(Math.min(az, bz) - W))), jb = Math.min(j1 - 1, Math.ceil(toTex(Math.max(az, bz) + W)));
      if (i0 > i1 || ja > jb) continue;
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      for (let j = ja; j <= jb; j++) {
        const pz = toWorld(j) - az;
        for (let i = i0; i <= i1; i++) {
          const px = toWorld(i) - ax;
          let t = (px * dx + pz * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - dx * t, ez = pz - dz * t, d = Math.sqrt(ex * ex + ez * ez), k = (j - j0) * N + i;
          if (d < roadD[k]) { roadD[k] = d; roadSD[k] = (dx * pz - dz * px) >= 0 ? d : -d; }
        }
      }
    }
  }
  const mRock = new Float32Array(NB), mDirt = new Float32Array(NB), mAO = new Float32Array(NB).fill(1);
  const mKill = new Float32Array(NB).fill(1), mTall = new Float32Array(NB), mPad = new Float32Array(NB);
  for (const r of plan) {
    if (Math.abs(r.x) > BAKE_HALF + 20 || Math.abs(r.z) > BAKE_HALF + 20) continue;
    const small = r.kind === 'debris';
    const w = clamp(0.35 + r.r * 0.9, 0.3, 2.4);
    stamp(r.x, r.z, r.r + w * 1.6 + 0.5, (k, dist) => {
      const d = dist - r.r;
      if (d < 0) mKill[k] = 0; else mKill[k] = Math.min(mKill[k], sstep(-0.05, w * 0.5, d));
      mDirt[k] = Math.max(mDirt[k], sstep(w, 0, d) * (small ? 0.45 : 0.8));
      if (!small) { mRock[k] = Math.max(mRock[k], sstep(w * 0.55, -0.3, d) * 0.55); mTall[k] = Math.max(mTall[k], sstep(w * 1.4, 0, d)); }
      mAO[k] *= 1 - (small ? 0.18 : 0.4) * sstep(w * 1.5, -0.2, d);
    });
  }
  const pad = (x, z, rKill, rDirt, dirt, padAmt = 1) => stamp(x, z, rDirt, (k, d) => {
    if (d < rKill) mKill[k] = 0; else mKill[k] = Math.min(mKill[k], sstep(rKill, rKill + 0.6, d));
    mDirt[k] = Math.max(mDirt[k], sstep(rDirt, rKill, d) * dirt);
    mPad[k] = Math.max(mPad[k], sstep(rDirt, rKill, d) * padAmt);
  });
  if (LAYOUT.biome.props.pavilion) pad(P.x, P.z, P.r * 0.95, P.r + 3.2, 0.85);
  if (LAYOUT.biome.props.stele) pad(S.x, S.z, 0.95, 2.6, 0.6);
  for (const g of LAYOUT.graves) {   // headstone in front of each (grass-grown) mound
    pad(g.x + Math.sin(g.yaw) * 1.25, g.z + Math.cos(g.yaw) * 1.25, 0.34, 1.1, 0.3, 0.2);
  }
  if (LAYOUT.biome.props.cairn) pad(LAYOUT.cairn.x, LAYOUT.cairn.z, LAYOUT.cairn.r, LAYOUT.cairn.r + 1.4, 0.55);
  for (const m of LAYOUT.roadMarkers) pad(m.x, m.z, 0.35, 1.0, 0.4);
  if (LAYOUT.biome.heroTree) pad(TR.x, TR.z, TR.r + 0.35, TR.r + 2.2, 0.5, 0.4);

  // ---- per texel
  const splat = new Uint8Array(NB * 4), ground = new Uint8Array(NB * 4), aux = new Uint8Array(NB * 4);
  const sl = Math.sqrt(SUN_DIR.x * SUN_DIR.x + SUN_DIR.z * SUN_DIR.z), sux = SUN_DIR.x / sl, suz = SUN_DIR.z / sl;
  const stats = { green: 0, dens: 0, dry: 0, rock: 0, dirt: 0, n: 0 };
  const halfRoad = LAYOUT.roadWidth * 0.5, kx = LAYOUT.knoll.x, kz = LAYOUT.knoll.z, crown = TR.crown;
  const BI = LAYOUT.biome, LC = BI.leafCarpet, TW = BI.town ? LAYOUT.town : null;
  const mix1 = (a, b, t) => a + (b - a) * t;
  const F = new Float32Array(NF_CH);
  const hx = (i, jr) => hb[jr * HW + (i < 0 ? 0 : i >= N ? N - 1 : i)];  // jr = band-local row incl. margin

  for (let j = j0; j < j1; j++) {
    const z = toWorld(j), jr = j - j0 + MARGIN;
    let fzt = (z + BAKE_HALF) / NF_STEP - 0.5 - f0; fzt = fzt < 0 ? 0 : fzt > fRows - 1.001 ? fRows - 1.001 : fzt;
    const fj = Math.floor(fzt), fzf = fzt - fj;
    for (let i = 0; i < N; i++) {
      const x = toWorld(i), kb = (j - j0) * N + i, h = hb[jr * HW + i];
      let fxt = (x + BAKE_HALF) / NF_STEP - 0.5; fxt = fxt < 0 ? 0 : fxt > NF - 1.001 ? NF - 1.001 : fxt;
      const fi = Math.floor(fxt), fxf = fxt - fi;
      const b00 = (fj * NF + fi) * NF_CH, b10 = b00 + NF_CH, b01 = b00 + NF * NF_CH, b11 = b01 + NF_CH;
      const w00 = (1 - fxf) * (1 - fzf), w10 = fxf * (1 - fzf), w01 = (1 - fxf) * fzf, w11 = fxf * fzf;
      for (let c = 0; c < NF_CH; c++) F[c] = fields[b00 + c] * w00 + fields[b10 + c] * w10 + fields[b01 + c] * w01 + fields[b11 + c] * w11;
      const O = F[0], L = F[1], nDry = F[2], nDens = F[3], nH = F[4], nMoist = F[5], nSpec = F[6];

      // slope from ±1 m differences
      const dhx = (hx(i + 2, jr) - hx(i - 2, jr)) / (4 * T), dhz = (hb[(jr + 2) * HW + i] - hb[(jr - 2) * HW + i]) / (4 * T);
      const il = 1 / Math.sqrt(dhx * dhx + 1 + dhz * dhz), nx = -dhx * il, nz = -dhz * il;
      const slope = 1 - il;
      // two-scale cavity (±3.5 m, ±11 m)
      const a1 = (hx(i + 7, jr) + hx(i - 7, jr) + hb[(jr + 7) * HW + i] + hb[(jr - 7) * HW + i]) * 0.25;
      const a2 = (hx(i + 22, jr) + hx(i - 22, jr) + hb[(jr + 22) * HW + i] + hb[(jr - 22) * HW + i]) * 0.25;
      let ao = 1 - clamp((a1 - h) * 0.2 + (a2 - h) * 0.035, 0, 0.55);
      const hollow = (1 - ao) / 0.55;

      const dxk = x - kx, dzk = z - kz, r0 = Math.sqrt(dxk * dxk + dzk * dzk);
      const knollPad = sstep(18, 8, r0);
      const dxt = x - TR.x, dzt = z - TR.z, dT = Math.sqrt(dxt * dxt + dzt * dzt);
      let treeProx = sstep(crown * 1.25, crown * 0.3, dT);
      // forest-floor litter (bamboo level): the leaf-carpet channel rises away from the clearing, ragged edge
      if (LC) treeProx = Math.max(treeProx, LC.amount * sstep(LC.inner, LC.inner + 8, r0 + O * 6) * sstep(LC.outer, LC.outer - 40, r0));
      const rd = roadD[kb];
      const roadW = sstep(halfRoad + 1.8, halfRoad - 0.2, rd + O * 0.45);

      // splat, in priority order (rock > dirt > dry > lush)
      const R = Math.max(sstep(0.26 + 0.08 * O, 0.45, slope), mRock[kb]);
      let D = Math.max(roadW, mDirt[kb], knollPad * 0.42 * (0.5 + L), treeProx * 0.28);
      D = clamp(D + (L - 0.25) * 0.25 * knollPad, 0, 1);
      D = clamp(D + BI.dirt * (0.6 + L), 0, 1);
      let Y = clamp(BI.drySpread + 1.3 * nDry + 1.1 * (nx * sux + nz * suz) - 0.6 * hollow, 0, 1);
      D *= 1 - R; Y *= (1 - R) * (1 - D);
      const lush = (1 - R) * (1 - D) * (1 - Y);
      const inv = 255 / (R + D + Y + lush), k4 = kb * 4;
      splat[k4] = lush * inv + 0.5; splat[k4 + 1] = Y * inv + 0.5; splat[k4 + 2] = R * inv + 0.5; splat[k4 + 3] = D * inv + 0.5;

      // ground info
      ao *= (1 - 0.35 * treeProx) * mAO[kb];
      const moist = clamp(hollow * 0.9 + 0.9 * nMoist - Y * 0.3 + 0.12 + treeProx * 0.25, 0, 1);
      const green = sstep(0.12, 0.62, nSpec * 1.7 + moist * 0.55 - Y * 0.2);
      let dens = (1 - R) * (1 - sstep(0.3, 0.7, D)) * (0.62 + 0.38 * clamp(0.5 + nDens * 1.6, 0, 1));
      dens *= mKill[kb] * (1 - 0.35 * treeProx) * (LC ? mix1(1, BI.grassDensity, sstep(LC.inner, LC.inner + 6, r0)) : BI.grassDensity);
      // town: no grass on the paving, under the houses or in the canal (only weeds in the gaps beyond the rows)
      if (TW) {
        const inRows = x > TW.street.x0 - 4 && x < TW.street.x1 + 4 && Math.abs(z) < TW.frontage + TW.depth + 1.5;
        const inPlaza = Math.abs(x - TW.plaza.x) < TW.plaza.w * 0.5 + TW.depth && Math.abs(z - TW.plaza.z) < TW.plaza.d * 0.5 + TW.depth;
        const inCanal = TW.canal && Math.abs(x - TW.canal.x) < TW.canal.width * 0.5 + 3;
        if (inRows || inPlaza || inCanal) dens = 0;
      }
      let gh = 0.35 + 0.65 * sstep(-0.25, 0.45, nH * 1.4 + moist * 0.4);
      gh *= (1 - 0.7 * knollPad) * (0.55 + 0.45 * sstep(halfRoad, halfRoad + 4, rd));
      gh = clamp(gh + 0.25 * mTall[kb] + 0.3 * sstep(160, 210, Math.sqrt(x * x + z * z)), 0, 1);
      ground[k4] = dens * 255 + 0.5; ground[k4 + 1] = gh * 255 + 0.5;
      ground[k4 + 2] = green * 255 + 0.5; ground[k4 + 3] = clamp(ao, 0, 1) * 255 + 0.5;

      aux[k4] = roadW * 255 + 0.5;
      aux[k4 + 1] = clamp(roadSD[kb] / 8 + 0.5, 0, 1) * 255 + 0.5;
      aux[k4 + 2] = treeProx * 255 + 0.5;
      aux[k4 + 3] = Math.max(mPad[kb], knollPad * 0.8) * 255 + 0.5;

      if ((i & 7) === 0 && (j & 7) === 0 && r0 < 300) {
        stats.n++; stats.green += green; stats.dens += dens; stats.dry += Y * inv / 255; stats.rock += R * inv / 255; stats.dirt += D * inv / 255;
      }
    }
  }
  return { j0, j1, height, splat, ground, aux, stats };
}

/** Full bake. With a worker pool the bands run in parallel; otherwise synchronously on this thread. */
export async function bakeWorld({ pool, plan }) {
  const N = BAKE_N, NN = N * N;
  const out = { height: new Float32Array(NN), splat: new Uint8Array(NN * 4), ground: new Uint8Array(NN * 4), aux: new Uint8Array(NN * 4), stats: null };
  const acc = { green: 0, dens: 0, dry: 0, rock: 0, dirt: 0, n: 0 };
  const put = (b) => {
    out.height.set(b.height, b.j0 * N); out.splat.set(b.splat, b.j0 * N * 4);
    out.ground.set(b.ground, b.j0 * N * 4); out.aux.set(b.aux, b.j0 * N * 4);
    for (const k in acc) acc[k] += b.stats[k];
  };
  const planData = plan.map(({ kind, x, z, r }) => ({ kind, x, z, r }));
  const bands = pool ? pool.size * 2 : 1, per = Math.ceil(N / bands);
  if (pool) {
    const g = grid();
    try {
      await Promise.all(Array.from({ length: bands }, (_, b) => {
        const j0 = b * per, j1 = Math.min(N, j0 + per);
        if (j0 >= j1) return null;
        return pool.run({ type: 'bake', j0, j1, plan: planData, xs: g.xs, H: g.H }).then(put);
      }));
    } catch (err) {
      console.warn('[terrain] worker bake failed, baking on the main thread', err);
      for (const k in acc) acc[k] = 0;
      put(bakeBand({ j0: 0, j1: N, plan: planData }));
    }
  } else put(bakeBand({ j0: 0, j1: N, plan: planData }));
  const n = acc.n; delete acc.n;
  for (const k in acc) acc[k] = +(acc[k] / n).toFixed(3);
  out.stats = acc;
  return out;
}
