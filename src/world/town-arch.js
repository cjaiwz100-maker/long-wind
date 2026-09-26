// Architecture generators for the town (world/town.js): tiled roofs (gable, pent, hipped with flying corners),
// shophouses, the opera stage 戲臺, the memorial archway 牌坊, the arched canal bridge, canal embankments, stalls
// and street clutter. Every function writes into the shared per-material Builders of world/town-geo.js. Owner: W.
//
// K = { w: building (timber/plaster/paper), s: stone, t: tiles, m: misc, g: signs/cloth } Builders.
// Local frames: x along the facade (right when facing it), +z out of the facade toward the street, y up from the floor.
import { atlasUV } from './town-mat.js';

export const TILE_PERIOD = 0.25;
const TEX_TILE = 4.0;                                       // one ceramic_roof_01 repeat = 16 tile channels
const PROF = [[0, -0.014], [0.28, 0.0], [0.5, 0.052], [0.72, 0.0]];

export function setFrame(K, x, y, z, yaw) { for (const k in K) K[k].frame(x, y, z, yaw); }
export function toWorld(b, x, y, z) { return [b.ox + x * b.c + z * b.s, b.oy + y, b.oz - x * b.s + z * b.c]; }

/** Columns across a roof slope: corrugated (4 per tile channel) or plain. → [{x, dy}] */
function roofCols(xa, xb, corr) {
  const L = xb - xa;
  if (!corr) { const n = Math.max(2, Math.ceil(L / 0.9)); return Array.from({ length: n + 1 }, (_, i) => ({ x: xa + (L * i) / n, dy: 0 })); }
  const n = Math.max(1, Math.round(L / TILE_PERIOD)), P = L / n, out = [];
  for (let k = 0; k < n; k++) for (const [f, dy] of PROF) out.push({ x: xa + (k + f) * P, dy });
  out.push({ x: xb, dy: PROF[0][1] });
  return out;
}

// concave rafter profile (舉折): steep at the ridge, flattening toward the eave
const prof = (s) => 0.42 * s + 0.58 * (1 - (1 - s) * (1 - s));

/**
 * Gable / pent roof, ridge along local x. slopes: [{ zE, yE }] from the ridge line (zR, yR) — one entry = pent roof.
 * o: { xa, xb, zR, yR, slopes, lift, flare, corr, rows, thick, zWall (underside starts there), rafters, ridge }
 * Returns y(z) of the tile underside along the centre (for walls/gables): o.under(z).
 */
export function gableRoof(K, o) {
  const { xa, xb, zR, yR, lift = 0.2, flare = 0, corr = true, rows = 6, thick = 0.14, rafters = true, ridge = 'curl', sd = 0.5 } = o;
  const cols = roofCols(xa, xb, corr);
  const L = xb - xa;
  for (const sl of o.slopes) {
    const { zE, yE } = sl;
    const front = zE > zR, sg = front ? 1 : -1;
    const H = yR - yE;
    const P = (s, t, out, dy = 0, drop = 0) => {
      const e = Math.pow(Math.abs(2 * t - 1), 3);
      out[0] = xa + t * L;
      out[2] = zR + (zE - zR) * s + sg * flare * e * s * s;
      out[1] = yR - H * prof(s) + lift * e * s * s + dy - drop;
      return out;
    };
    const tmp = [0, 0, 0];
    const slopeLen = Math.hypot(zE - zR, H);
    // tiles (top), corrugated
    K.t.part(0, sd).grid(cols.length - 1, rows, (i, j, q) => {
      const c = cols[i], t = (c.x - xa) / L, s = j / rows;
      P(s, t, tmp, c.dy);
      q.x = tmp[0]; q.y = tmp[1]; q.z = tmp[2]; q.u = c.x / TEX_TILE; q.v = (s * slopeLen) / TEX_TILE * 0.9;
    }, front);
    // eave end (瓦當 scallops): corrugated top edge down to the soffit
    K.t.part(1, sd).grid(cols.length - 1, 1, (i, j, q) => {
      const c = cols[i], t = (c.x - xa) / L;
      P(1, t, tmp, j === 0 ? c.dy : 0, j === 0 ? 0 : thick + 0.03);
      q.x = tmp[0]; q.y = tmp[1]; q.z = tmp[2]; q.u = c.x; q.v = tmp[1];
    }, front);
    // verges at both gable ends
    for (const side of [0, 1]) {
      const t = side;
      K.t.part(1, sd).grid(rows, 1, (i, j, q) => {
        const s = i / rows;
        P(s, t, tmp, j === 0 ? PROF[0][1] : 0, j === 0 ? 0 : thick);
        q.x = tmp[0]; q.y = tmp[1]; q.z = tmp[2]; q.u = tmp[2]; q.v = tmp[1];
      }, (side === 0) === front);
    }
    // soffit boards from the wall line out to the eave
    const s0 = o.zWall !== undefined ? Math.max(0, Math.min(1, (o.zWall - zR) / (zE - zR) - 0.02)) : 0;
    const nu = corr ? 12 : 4;
    K.w.part(1, sd).grid(nu, 3, (i, j, q) => {
      const t = i / nu, s = s0 + (1 - s0) * (j / 3);
      P(s, t, tmp, 0, thick);
      q.x = tmp[0]; q.y = tmp[1]; q.z = tmp[2]; q.u = tmp[0]; q.v = tmp[2];
    }, !front);
    if (rafters) {
      const n = Math.floor(L / 0.34);
      const a = [0, 0, 0], b = [0, 0, 0];
      K.w.part(0, sd);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        P(Math.max(s0, 0.02), t, a, 0, thick + 0.045); P(1, t, b, 0, thick + 0.045);
        b[2] -= sg * 0.04;
        K.w.beam(a, b, 0.07, 0.075);
      }
    }
  }
  // ridge 正脊: grey tile ridge on a white lime course, ends curling up (Jiangnan 纹头/甘蔗脊)
  if (ridge !== 'none') {
    const x0 = xa + 0.12, x1 = xb - 0.12;
    K.m.part(7, sd).box(x0, yR - 0.03, zR - 0.17, x1, yR + 0.07, zR + 0.17);
    K.m.part(0, sd).box(x0, yR + 0.07, zR - 0.13, x1, yR + 0.34, zR + 0.13);
    if (ridge === 'curl' || ridge === 'bird') {
      for (const [xe, d] of [[x0, -1], [x1, 1]]) {
        const pts = ridge === 'curl'
          ? [[xe - d * 0.3, yR + 0.2], [xe + d * 0.02, yR + 0.3], [xe + d * 0.22, yR + 0.48], [xe + d * 0.32, yR + 0.74], [xe + d * 0.3, yR + 0.95]]
          : [[xe - d * 0.3, yR + 0.2], [xe + d * 0.05, yR + 0.34], [xe + d * 0.12, yR + 0.62], [xe + d * 0.3, yR + 0.7]];
        for (let k = 0; k < pts.length - 1; k++) {
          const w = 0.24 - k * 0.035;
          K.m.beam([pts[k][0], pts[k][1], zR], [pts[k + 1][0], pts[k + 1][1], zR], 0.2 - k * 0.025, w, [0, 0, 1]);
        }
      }
    }
  }
  return (z, s0 = null) => {  // tile-underside height along the roof at local z (centre)
    for (const sl of o.slopes) {
      const { zE, yE } = sl, front = zE > zR;
      if ((front && z >= zR) || (!front && z <= zR) || o.slopes.length === 1) {
        const s = Math.max(0, Math.min(1, (z - zR) / (zE - zR)));
        return yR - (yR - yE) * prof(s) - thick;
      }
    }
    return yR - thick;
  };
}

/**
 * Hipped roof (庑殿-like) with flying corners, centred at the local origin. o: { hw, hd (eave half extents),
 * yE, yR, rl (ridge half length), lift, flare, corr, rows, thick, soffitPart }
 */
export function hipRoof(K, o) {
  const { hw, hd, yE, yR, rl, lift = 0.6, flare = 0.35, corr = true, rows = 8, thick = 0.2, soffitPart = 7, sd = 0.5 } = o;
  const H = yR - yE;
  // sectors: [ridge a, ridge b, eave a, eave b] in xz, eave corners get lift/flare
  const sect = [
    [[-rl, 0], [rl, 0], [-hw, hd], [hw, hd]],       // front (+z)
    [[rl, 0], [-rl, 0], [hw, -hd], [-hw, -hd]],     // back
    [[rl, 0], [rl, 0], [hw, hd], [hw, -hd]],        // right (+x)
    [[-rl, 0], [-rl, 0], [-hw, -hd], [-hw, hd]],    // left
  ];
  const tmp = [0, 0, 0];
  const P = (S, s, t, out, dy = 0, drop = 0) => {
    const [ra, rb, ea, eb] = S;
    const e = Math.pow(Math.abs(2 * t - 1), 2.4);
    const rx = ra[0] + (rb[0] - ra[0]) * t, rz = ra[1] + (rb[1] - ra[1]) * t;
    let ex = ea[0] + (eb[0] - ea[0]) * t, ez = ea[1] + (eb[1] - ea[1]) * t;
    // flare: corners pushed outward along the diagonal
    const len = Math.hypot(ex, ez) || 1;
    ex += (ex / len) * flare * e; ez += (ez / len) * flare * e;
    const ss = s;
    out[0] = rx + (ex - rx) * ss; out[2] = rz + (ez - rz) * ss;
    out[1] = yR - H * prof(ss) + lift * e * ss * ss * ss + dy - drop;
    return out;
  };
  for (const S of sect) {
    const eLen = Math.hypot(S[3][0] - S[2][0], S[3][1] - S[2][1]);
    const cols = roofCols(0, eLen, corr);
    // tiles
    K.t.part(0, sd).grid(cols.length - 1, rows, (i, j, q) => {
      const t = cols[i].x / eLen, s = 0.03 + 0.97 * (j / rows);
      P(S, s, t, tmp, cols[i].dy * Math.min(1, s * 3));
      q.x = tmp[0]; q.y = tmp[1]; q.z = tmp[2]; q.u = cols[i].x / TEX_TILE; q.v = s * Math.hypot(hd, H) / TEX_TILE;
    }, true);
    K.t.part(1, sd).grid(cols.length - 1, 1, (i, j, q) => {
      const t = cols[i].x / eLen;
      P(S, 1, t, tmp, j === 0 ? cols[i].dy : 0, j === 0 ? 0 : thick + 0.04);
      q.x = tmp[0]; q.y = tmp[1]; q.z = tmp[2]; q.u = cols[i].x; q.v = tmp[1];
    }, true);
    K.w.part(soffitPart, sd).grid(10, 4, (i, j, q) => {
      P(S, 0.25 + 0.75 * (j / 4), i / 10, tmp, 0, thick);
      q.x = tmp[0]; q.y = tmp[1]; q.z = tmp[2]; q.u = tmp[0]; q.v = tmp[2];
    }, false);
  }
  // hip ridges with upturned hooks (戧脊 + 仔角), main ridge with curled ends
  const a = [0, 0, 0], b = [0, 0, 0];
  K.m.part(0, sd);
  for (const S of sect.slice(0, 2)) {
    for (const t of [0, 1]) {
      let prev = null;
      for (let k = 0; k <= 8; k++) {
        const s = 0.04 + 0.96 * (k / 8);
        P(S, s, t, a, 0.1);
        if (prev) K.m.beam(prev, a.slice(), 0.2, 0.2);
        prev = a.slice();
      }
      // hook beyond the corner
      const dx = prev[0], dz = prev[2], l = Math.hypot(dx, dz), ux = dx / l, uz = dz / l;
      const hook = [[prev[0] + ux * 0.3, prev[1] + 0.14, prev[2] + uz * 0.3], [prev[0] + ux * 0.5, prev[1] + 0.42, prev[2] + uz * 0.5], [prev[0] + ux * 0.52, prev[1] + 0.7, prev[2] + uz * 0.52]];
      let p0 = prev;
      hook.forEach((h, k) => { K.m.beam(p0, h, 0.17 - k * 0.03, 0.17 - k * 0.03); p0 = h; });
    }
  }
  K.m.part(7, sd).box(-rl - 0.1, yR - 0.04, -0.2, rl + 0.1, yR + 0.08, 0.2);
  K.m.part(0, sd).box(-rl - 0.1, yR + 0.08, -0.15, rl + 0.1, yR + 0.42, 0.15);
  for (const d of [-1, 1]) {        // 鸱吻-like end ornaments
    const xe = d * (rl + 0.1);
    b[0] = xe; b[1] = yR + 0.1; b[2] = 0;
    K.m.beam([xe - d * 0.2, yR + 0.25, 0], [xe + d * 0.05, yR + 0.55, 0], 0.26, 0.3, [0, 0, 1]);
    K.m.beam([xe + d * 0.05, yR + 0.55, 0], [xe - d * 0.1, yR + 0.95, 0], 0.22, 0.24, [0, 0, 1]);
    K.m.beam([xe - d * 0.1, yR + 0.95, 0], [xe - d * 0.32, yR + 1.05, 0], 0.18, 0.18, [0, 0, 1]);
  }
  return { P: (s, t, k, out) => P(sect[k], s, t, out) };
}

// ------------------------------------------------------------------------------------------------ shophouse
/**
 * h: { W, D, st (1|2), H1, H2, pent, jet, ov, rise, style ('street'|'canal'|'back'), bays [...], upper, gable:[l, r]
 *      ('plain'|'horse'), corr, sd, sign (atlas name|null), banner (atlas name|null), lanterns (bool), wall ('plaster'|'boards'),
 *      found (depth of the plinth below the floor) }
 * out: { hooks: [{p:[x,y,z], kind}], lights: [{x,z,h,i}], eaveY }
 */
export function shophouse(K, h, rnd, out) {
  const { W, D, st, H1, H2 = 2.7, pent, jet = 0, ov = 1.0, rise = 1.9, bays, sd } = h;
  const hw = W / 2;
  const top = st === 2 ? H1 + H2 : H1;
  const back = h.style === 'back';
  const zU = st === 2 ? jet : 0;                                 // upper facade plane
  // --- plinth, front step
  K.s.part(0, sd).box(-hw, -h.found, -D, hw, 0, 0.02, 0);
  if (!back) K.s.part(2, sd).box(-hw + 0.02, -h.found, 0.02, hw - 0.02, -0.12, 0.42);
  // --- main roof (computed first: walls need its underside)
  const zEf = zU + ov, zEb = -D - 0.55;
  const yE = top + 0.14 + (back ? 0 : 0.0);
  const zR = (zEf + zEb) / 2 + (h.ridgeShift ?? 0);
  const yR = yE + rise;
  const [gl, gr] = h.gable;
  const ovL = gl === 'horse' ? 0.02 : 0.32, ovR = gr === 'horse' ? 0.02 : 0.32;
  const under = gableRoof(K, {
    xa: -hw - ovL, xb: hw + ovR, zR, yR, slopes: [{ zE: zEf, yE }, { zE: zEb, yE: yE + (h.backDrop ?? 0) }],
    lift: h.lift ?? 0.22, flare: 0.0, corr: h.corr, rows: h.corr ? 5 : 3, thick: 0.15, zWall: zU, rafters: !back && h.corr,
    ridge: h.ridge ?? 'curl', sd,
  });
  out.eaveY = yE;
  const wallMat = h.wall === 'boards' ? 1 : 2;
  // --- side walls (+ gables up to the roof underside)
  const zs = [];
  const zFront = zU, NZ = 8;
  for (let k = 0; k <= NZ; k++) zs.push(zFront + (-D - zFront) * (k / NZ));
  for (const side of [-1, 1]) {
    const x = side * hw, g = side < 0 ? gl : gr;
    K.w.part(g === 'horse' ? 2 : wallMat, sd);
    // lower rectangle (ground floor, up to the first-floor front plane)
    const q = (za, zb, y0a, y1a, y0b, y1b) => {
      if (side < 0) K.w.quad([x, y0a, za], [x, y0b, zb], [x, y1b, zb], [x, y1a, za]);
      else K.w.quad([x, y0b, zb], [x, y0a, za], [x, y1a, za], [x, y1b, zb]);
    };
    q(-D, 0, 0, top, 0, top);
    if (zU > 0) q(0, zU, H1, top, H1, top);
    if (g !== 'horse') {
      for (let k = 0; k < NZ; k++) {
        const za = Math.min(zs[k + 1], zs[k]), zb = Math.max(zs[k + 1], zs[k]);
        q(za, zb, top, Math.max(top, under(za)), top, Math.max(top, under(zb)));
      }
    } else {
      // 馬頭牆: stepped fire wall above the roof, capped with little tiled copings and upturned end blocks
      const t0 = 0.3, xo = x + side * 0.0;
      const zf = zU + 0.28, zb = -D - 0.3, L = zf - zb;
      const seg = D > 7 ? [[zb, zb + L * 0.3], [zb + L * 0.3, zb + L * 0.7], [zb + L * 0.7, zf]] : [[zb, zb + L * 0.5], [zb + L * 0.5, zf]];
      seg.forEach(([za, zc], k) => {
        const mid = seg.length === 3 ? k === 1 : false;
        const inner = Math.abs(za - zR) < Math.abs(zc - zR) ? za : zc;
        const yTop = mid ? yR + 0.65 : Math.max(under(inner) + 0.7, top + 0.8);
        const xa = side < 0 ? xo - t0 : xo, xb = side < 0 ? xo : xo + t0;
        K.w.part(2, sd).box(xa, 0, za, xb, yTop, zc, 0);
        const xc = (xa + xb) / 2;
        K.m.part(0, sd).box(xc - 0.24, yTop, za - 0.08, xc + 0.24, yTop + 0.08, zc + 0.08);
        K.t.part(0, sd).quad([xc - 0.3, yTop + 0.06, zc + 0.1], [xc - 0.3, yTop + 0.06, za - 0.1], [xc, yTop + 0.24, za - 0.1], [xc, yTop + 0.24, zc + 0.1]);
        K.t.part(0, sd).quad([xc + 0.3, yTop + 0.06, za - 0.1], [xc + 0.3, yTop + 0.06, zc + 0.1], [xc, yTop + 0.24, zc + 0.1], [xc, yTop + 0.24, za - 0.1]);
        K.m.part(0, sd).box(xc - 0.05, yTop + 0.2, za - 0.1, xc + 0.05, yTop + 0.3, zc + 0.1);
        // upturned end block (座頭) at the step's outer end
        const ze = Math.abs(za - zR) > Math.abs(zc - zR) ? za : zc, dz = Math.sign(ze - zR) || 1;
        K.m.beam([xc, yTop + 0.2, ze], [xc, yTop + 0.5, ze + dz * 0.24], 0.2, 0.16, [1, 0, 0]);
      });
    }
  }
  // --- back wall with a few small windows
  const yBack = under(-D) + 0.05;
  K.w.part(back ? 2 : wallMat, sd).quad([hw, 0, -D], [-hw, 0, -D], [-hw, Math.max(top, yBack), -D], [hw, Math.max(top, yBack), -D]);
  const nbw = Math.max(1, Math.floor(W / 3.2));
  for (let k = 0; k < nbw; k++) {
    if (rnd() < 0.35) continue;
    const xc = -hw + (W * (k + 0.5)) / nbw, yb = st === 2 && rnd() < 0.6 ? H1 + 0.9 : 1.4;
    K.w.part(4, rnd()).quad([xc + 0.4, yb, -D - 0.03], [xc - 0.4, yb, -D - 0.03], [xc - 0.4, yb + 0.8, -D - 0.03], [xc + 0.4, yb + 0.8, -D - 0.03]);
    K.w.part(0, sd).box(xc - 0.48, yb - 0.08, -D - 0.08, xc + 0.48, yb, -D);
  }
  // --- posts
  const nb = bays.length, bw = W / nb;
  K.w.part(0, sd);
  for (let k = 0; k <= nb; k++) {
    const x = -hw + k * bw, xi = Math.max(-hw + 0.1, Math.min(hw - 0.1, x));
    K.w.box(xi - 0.1, 0, -0.1, xi + 0.1, st === 2 && !(zU > 0) ? top : H1, 0.1);
    if (st === 2 && zU > 0) K.w.box(xi - 0.09, H1, zU - 0.09, xi + 0.09, top, zU + 0.09);
  }
  // --- ground floor bays
  const zi = -0.06;
  let shop = false;
  bays.forEach((type, k) => {
    const a = -hw + k * bw + 0.1, b = -hw + (k + 1) * bw - 0.1, xc = (a + b) / 2;
    const lintel = () => {
      K.w.part(0, sd).box(a, H1 - 0.44, -0.12, b, H1 - 0.3, 0.06);
      K.w.part(4, sd * 0.5 + rnd() * 0.5).quad([a, H1 - 0.3, zi], [b, H1 - 0.3, zi], [b, H1, zi], [a, H1, zi]);
    };
    if (type === 'open') {
      shop = true;
      const yT = H1 - 0.44;
      K.w.part(1, sd).box(a + 0.04, 0, -0.62, b - 0.04, 0.9, -0.12, 0);
      K.w.part(0, sd).box(a, 0.9, -0.66, b, 0.97, -0.06);
      const s5 = 0.3 + rnd() * 0.7;
      K.w.part(5, s5);
      K.w.quad([a, 0, -2.7], [b, 0, -2.7], [b, yT, -2.7], [a, yT, -2.7]);
      K.w.quad([a, 0, zi], [a, 0, -2.7], [a, yT, -2.7], [a, yT, zi]);
      K.w.quad([b, 0, -2.7], [b, 0, zi], [b, yT, zi], [b, yT, -2.7]);
      K.w.part(9, sd).quad([a, yT, -2.7], [b, yT, -2.7], [b, yT, zi], [a, yT, zi]);
      K.w.quad([a, 0.01, zi], [b, 0.01, zi], [b, 0.01, -2.7], [a, 0.01, -2.7]);
      lintel();
      out.lights.push({ p: toWorld(K.w, xc, 1.2, 0.9), i: 2.4 * (0.6 + s5 * 0.6) });
    } else if (type === 'boards') {
      K.w.part(10, sd).quad([a, 0.08, zi], [b, 0.08, zi], [b, H1 - 0.44, zi], [a, H1 - 0.44, zi]);
      K.w.part(0, sd).box(a, 0, -0.1, b, 0.1, 0.04);
      lintel();
    } else if (type === 'lattice') {
      const lit = rnd();
      const n = Math.max(2, Math.round((b - a) / 0.62));
      K.w.part(1, sd).quad([a, 0.08, zi], [b, 0.08, zi], [b, 0.95, zi], [a, 0.95, zi]);
      K.w.part(4, lit).quad([a, 0.95, zi], [b, 0.95, zi], [b, H1 - 0.44, zi], [a, H1 - 0.44, zi]);
      K.w.part(0, sd);
      for (let i = 0; i <= n; i++) { const x = a + ((b - a) * i) / n; K.w.box(x - 0.035, 0.05, zi - 0.02, x + 0.035, H1 - 0.44, zi + 0.05); }
      K.w.box(a, 0.92, zi - 0.02, b, 1.0, zi + 0.05);
      K.w.box(a, 0, zi - 0.02, b, 0.1, zi + 0.05);
      lintel();
      if (lit > 0.42) out.lights.push({ p: toWorld(K.w, xc, 1.6, 0.6), i: 0.9 });
    } else if (type === 'door') {
      K.w.part(wallMat, sd).quad([a, 0, zi], [b, 0, zi], [b, H1, zi], [a, H1, zi]);
      const dw = Math.min(1.1, (b - a) * 0.6);
      K.w.part(10, sd).quad([xc - dw / 2, 0.05, zi + 0.02], [xc + dw / 2, 0.05, zi + 0.02], [xc + dw / 2, 2.15, zi + 0.02], [xc - dw / 2, 2.15, zi + 0.02]);
      K.w.part(0, sd).box(xc - dw / 2 - 0.1, 2.15, zi, xc + dw / 2 + 0.1, 2.28, zi + 0.1);
      K.w.box(xc - dw / 2 - 0.1, 0, zi, xc - dw / 2, 2.15, zi + 0.08);
      K.w.box(xc + dw / 2, 0, zi, xc + dw / 2 + 0.1, 2.15, zi + 0.08);
    } else { // plaster wall with a small lattice window
      K.w.part(wallMat, sd).quad([a, 0, zi], [b, 0, zi], [b, H1, zi], [a, H1, zi]);
      const ww = Math.min(0.9, (b - a) * 0.5), s4 = rnd();
      K.w.part(4, s4).quad([xc - ww / 2, 1.3, zi + 0.03], [xc + ww / 2, 1.3, zi + 0.03], [xc + ww / 2, 2.1, zi + 0.03], [xc - ww / 2, 2.1, zi + 0.03]);
      K.w.part(0, sd).box(xc - ww / 2 - 0.07, 1.22, zi, xc + ww / 2 + 0.07, 1.3, zi + 0.1);
      K.w.box(xc - ww / 2 - 0.07, 2.1, zi, xc + ww / 2 + 0.07, 2.18, zi + 0.1);
      if (s4 > 0.42) out.lights.push({ p: toWorld(K.w, xc, 1.7, 0.5), i: 0.6 });
    }
  });
  // --- upper storey
  if (st === 2) {
    K.w.part(0, sd).box(-hw, H1 - 0.02, -0.12, hw, H1 + 0.24, zU + 0.08);
    if (zU > 0) { for (let x = -hw + 0.3; x < hw; x += 0.6) K.w.box(x - 0.05, H1 - 0.14, 0, x + 0.05, H1 - 0.02, zU); }
    const zf = zU - 0.05;
    bays.forEach((_, k) => {
      const a = -hw + k * bw + 0.09, b = -hw + (k + 1) * bw - 0.09, xc = (a + b) / 2;
      if (h.upper === 'plaster') {
        K.w.part(wallMat, sd).quad([a, H1 + 0.24, zf], [b, H1 + 0.24, zf], [b, top - 0.25, zf], [a, top - 0.25, zf]);
        const ww = Math.min(1.0, (b - a) * 0.55), s4 = rnd();
        K.w.part(4, s4).quad([xc - ww / 2, H1 + 0.85, zf + 0.03], [xc + ww / 2, H1 + 0.85, zf + 0.03], [xc + ww / 2, H1 + 1.9, zf + 0.03], [xc - ww / 2, H1 + 1.9, zf + 0.03]);
        K.w.part(0, sd).box(xc - ww / 2 - 0.07, H1 + 0.77, zf, xc + ww / 2 + 0.07, H1 + 0.85, zf + 0.1);
        K.w.box(xc - ww / 2 - 0.07, H1 + 1.9, zf, xc + ww / 2 + 0.07, H1 + 1.98, zf + 0.1);
        if (s4 > 0.42) out.lights.push({ p: toWorld(K.w, xc, H1 + 1.4, 0.5), i: 0.5 });
      } else {
        const s4 = rnd();
        K.w.part(h.upper === 'boards' ? 10 : 1, sd).quad([a, H1 + 0.24, zf], [b, H1 + 0.24, zf], [b, H1 + 0.95, zf], [a, H1 + 0.95, zf]);
        K.w.part(4, s4).quad([a, H1 + 0.95, zf], [b, H1 + 0.95, zf], [b, top - 0.25, zf], [a, top - 0.25, zf]);
        K.w.part(0, sd).box(a, H1 + 0.92, zf - 0.02, b, H1 + 1.0, zf + 0.06);
        const n = Math.max(2, Math.round((b - a) / 0.55));
        for (let i = 1; i < n; i++) { const x = a + ((b - a) * i) / n; K.w.box(x - 0.03, H1 + 0.95, zf - 0.02, x + 0.03, top - 0.25, zf + 0.05); }
        if (s4 > 0.42) out.lights.push({ p: toWorld(K.w, xc, H1 + 1.6, 0.6), i: 0.7 });
        if (zU > 0.2 && h.balcony) {            // railing 欄杆 on the jetty
          K.w.part(3, sd).box(a, H1 + 0.9, zU + 0.02, b, H1 + 0.98, zU + 0.1);
          for (let x = a + 0.1; x < b; x += 0.16) K.w.box(x - 0.018, H1 + 0.24, zU + 0.04, x + 0.018, H1 + 0.9, zU + 0.08);
        }
      }
    });
    K.w.part(0, sd).box(-hw, top - 0.28, zU - 0.12, hw, top + 0.1, zU + 0.06);
    if (pent) {
      gableRoof(K, {
        xa: -hw - 0.03, xb: hw + 0.03, zR: zU, yR: H1 + 0.72, slopes: [{ zE: zU + 1.05, yE: H1 + 0.02 }],
        lift: 0.06, corr: h.corr, rows: 3, thick: 0.1, zWall: zU, rafters: h.corr, ridge: 'none', sd,
      });
      K.m.part(0, sd).box(-hw, H1 + 0.62, zU - 0.02, hw, H1 + 0.8, zU + 0.12);
    }
  } else {
    // frieze board between the lintels and the roof
    K.w.part(0, sd).box(-hw, H1 - 0.02, -0.12, hw, Math.max(H1 + 0.2, under(0) + 0.08), 0.04);
  }
  // --- signboard, banner, lanterns
  const hookZ = st === 2 && pent ? zU + 0.8 : zU + ov - 0.25;
  const hookY = st === 2 && pent ? H1 + 0.05 : yE - 0.12;
  if (h.sign) {
    const [u0, v0, u1, v1] = atlasUV(h.sign);
    const w = Math.min(2.4, W * 0.55), hh = w / 4;
    const y0 = st === 2 ? (pent ? H1 + 0.95 : H1 + 0.3) : H1 - 0.5, z = st === 2 ? zU + 0.04 : 0.1;
    const yy = st === 2 && pent ? top - 0.35 - hh : y0;
    K.g.part(0, 0).quad([-w / 2, yy, z], [w / 2, yy, z], [w / 2, yy + hh, z], [-w / 2, yy + hh, z], [u0, v0, u1, v0, u1, v1, u0, v1]);
    K.w.part(0, sd).box(-w / 2 - 0.05, yy - 0.05, z - 0.05, w / 2 + 0.05, yy + hh + 0.05, z - 0.01);
  }
  if (h.banner) {
    const [u0, v0, u1, v1] = atlasUV(h.banner);
    const xb = (h.bannerSide ?? 1) * (hw - 0.25);
    const yA = st === 2 && pent ? H1 - 0.12 : H1 - 0.15;
    const L = 1.25, z0 = 0.3, z1 = 0.9;
    K.w.part(0, sd).beam([xb, yA, -0.05], [xb, yA, 1.12], 0.06, 0.06);
    const ph = rnd() * 6.28 + 100;          // ≥ 100: single-sided (each face reads the right way round)
    for (const flip of [false, true]) {
      K.g.grid(1, 8, (i, j, q) => {
        const t = j / 8;
        q.x = xb; q.y = yA - 0.04 - t * L; q.z = i === 0 ? z1 : z0;
        q.u = (i === 0) !== flip ? u1 : u0; q.v = v1 + (v0 - v1) * t;
        q.p = t; q.s = ph;
      }, flip);
    }
  }
  if (h.lanterns) {
    const kind = h.lanternKind ?? 1;
    const xs = W > 5 ? [-hw + 0.7, hw - 0.7] : [0];
    for (const x of xs) out.hooks.push({ p: toWorld(K.w, x, hookY, hookZ), kind, ch: h.lanternChar ?? -1 });
  }
  if (h.eaveString) {       // small lanterns along the upper eave
    const n = Math.max(2, Math.floor(W / 1.3));
    for (let i = 0; i < n; i++) out.hooks.push({ p: toWorld(K.w, -hw + (W * (i + 0.5)) / n, yE - 0.08, zEf - 0.2), kind: 0, ch: -1 });
  }
  out.shop = shop;
  out.front = { hookY, hookZ, top, yE, yR, zEf };
}

// ------------------------------------------------------------------------------------------------ opera stage 戲臺
export function operaStage(K, o, out) {
  const sd = 0.37;
  const P = 1.25;                                             // platform height
  // stone platform with carved panels, cap slab
  K.s.part(2, sd).box(-5, -0.6, -4, 5, P - 0.12, 4);
  K.s.part(2, sd).box(-5.12, P - 0.14, -4.12, 5.12, P, 4.12);
  K.s.part(0, sd).box(-5.2, -0.6, -4.2, 5.2, 0.12, 4.2);
  for (let k = 0; k < 5; k++) K.s.part(3, sd).box(-4.5 + k * 1.84, 0.3, 4.0, -4.5 + k * 1.84 + 1.5, P - 0.3, 4.04);
  K.w.part(1, sd).box(-4.95, P, -3.95, 4.95, P + 0.05, 3.95);
  const yF = P + 0.05;
  const cols = [[-4.4, 3.5], [-1.85, 3.5], [1.85, 3.5], [4.4, 3.5], [-4.4, -3.5], [4.4, -3.5], [-4.4, 0], [4.4, 0]];
  const yTop = 5.0;
  for (const [x, z] of cols) {
    K.w.part(3, sd).cyl(x, yF, z, 0.17, 0.155, yTop - yF, 12, false);
    K.s.part(2, sd).cyl(x, yF - 0.02, z, 0.27, 0.24, 0.18, 12, true);
  }
  // architraves (painted), lower tie beams, brackets
  const ring = [[-4.4, 3.5, 4.4, 3.5], [4.4, -3.5, -4.4, -3.5], [4.4, 3.5, 4.4, -3.5], [-4.4, -3.5, -4.4, 3.5]];
  for (const [x0, z0, x1, z1] of ring) {
    const dx = Math.sign(x1 - x0) * 0.35, dz = Math.sign(z1 - z0) * 0.35;
    K.w.part(7, sd).beam([x0 - dx, yTop - 0.2, z0 - dz], [x1 + dx, yTop - 0.2, z1 + dz], 0.28, 0.42);
    K.w.part(7, sd).beam([x0, yTop - 0.72, z0], [x1, yTop - 0.72, z1], 0.18, 0.2);
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.round(L / 0.95);
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      K.w.part(8, sd).box(x - 0.16, yTop, z - 0.16, x + 0.16, yTop + 0.16, z + 0.16);
      K.w.part(7, sd).box(x - 0.3, yTop + 0.16, z - 0.12, x + 0.3, yTop + 0.3, z + 0.12);
      K.w.part(8, sd).box(x - 0.12, yTop + 0.3, z - 0.3, x + 0.12, yTop + 0.44, z + 0.3);
    }
  }
  K.w.part(7, sd).box(-4.8, yTop + 0.3, -3.85, 4.8, yTop + 0.5, 3.85, 8);   // ceiling
  // hanging gilt fret 掛落 across the front bays
  for (const [a, b] of [[-4.25, -2.0], [-1.7, 1.7], [2.0, 4.25]]) {
    K.w.part(8, sd).box(a, yTop - 1.02, 3.46, b, yTop - 0.96, 3.54);
    for (let x = a + 0.08; x < b; x += 0.16) K.w.box(x - 0.018, yTop - 0.96, 3.47, x + 0.018, yTop - 0.62, 3.53);
    K.w.box(a, yTop - 0.82, 3.47, b, yTop - 0.79, 3.53);
  }
  // back partition with the backdrop 守舊 and the two doors 出將 / 入相
  K.w.part(0, sd).box(-4.4, yF, -2.75, 4.4, yTop - 0.4, -2.6);
  const q = (name, x0, y0, x1, y1, z, flutter = 0) => {
    const [u0, v0, u1, v1] = atlasUV(name);
    if (!flutter) { K.g.part(0, 0).quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [u0, v0, u1, v0, u1, v1, u0, v1]); return; }
    K.g.grid(6, 5, (i, j, qq) => {
      const s = i / 6, t = j / 5;
      qq.x = x0 + (x1 - x0) * s; qq.y = y1 - (y1 - y0) * t; qq.z = z; qq.u = u0 + (u1 - u0) * s; qq.v = v1 - (v1 - v0) * t;
      qq.p = t * flutter; qq.s = s * 2.0;
    });
  };
  q('backdrop', -2.3, yF + 1.35, 2.3, yF + 1.35 + 1.725, -2.58);
  q('curtain', -2.3, yF, 2.3, yF + 1.35, -2.58);
  q('door0', -3.95, yF, -2.75, yF + 1.8, -2.58, 0.25);
  q('door1', 2.75, yF, 3.95, yF + 1.8, -2.58, 0.25);
  K.w.part(8, sd).box(-2.4, yF + 3.05, -2.6, 2.4, yF + 3.15, -2.5);
  // couplets on the front centre columns, plaque on the front architrave, red valance across the centre bay
  q('banner10', -1.85 - 0.22, 2.2, -1.85 + 0.22, 2.2 + 1.66, 3.5 + 0.185);
  q('banner11', 1.85 - 0.22, 2.2, 1.85 + 0.22, 2.2 + 1.66, 3.5 + 0.185);
  q('plaque2', -0.9, yTop + 0.02, 0.9, yTop + 0.92, 3.9);
  K.w.part(8, sd).box(-0.98, yTop - 0.05, 3.72, 0.98, yTop + 0.99, 3.88);
  q('valance', -1.7, yTop - 1.55, 1.7, yTop - 0.8, 3.58, 0.15);
  // side screens (half walls) at the back half
  for (const s of [-1, 1]) K.w.part(1, sd).box(s * 4.42 - 0.04, yF, -3.5, s * 4.42 + 0.04, yTop - 0.4, 0);
  // roof: hipped, deep eaves, strongly lifted corners
  const roofY = yTop + 0.55;
  const off = (b) => { b.oy += roofY; };
  for (const k in K) off(K[k]);
  hipRoof(K, { hw: 6.1, hd: 5.1, yE: 0.25, yR: 3.2, rl: 3.0, lift: 0.95, flare: 0.5, corr: true, rows: 9, thick: 0.24, sd });
  for (const k in K) K[k].oy -= roofY;
  // lanterns: palace lanterns at the front corners, a row along the architrave
  out.hooks.push({ p: toWorld(K.w, -5.6, roofY - 0.15, 4.6), kind: 2, ch: 0 });
  out.hooks.push({ p: toWorld(K.w, 5.6, roofY - 0.15, 4.6), kind: 2, ch: 1 });
  for (let x = -4.0; x <= 4.01; x += 0.8) if (Math.abs(x) > 0.9) out.hooks.push({ p: toWorld(K.w, x, yTop - 1.0, 3.62), kind: 0, ch: -1 });
  out.stringFrom = [toWorld(K.w, -5.8, roofY + 0.1, 5.4), toWorld(K.w, 0, roofY - 0.05, 5.2), toWorld(K.w, 5.8, roofY + 0.1, 5.4)];
  out.lights.push({ p: toWorld(K.w, 0, 2.6, 2.0), i: 3.0 });
}

// ------------------------------------------------------------------------------------------------ memorial archway 牌坊
export function paifang(K, o, out) {
  const sd = 0.61;
  const pil = [[-2.9, 6.6], [2.9, 6.6], [-5.6, 5.3], [5.6, 5.3]];
  for (const [x, hgt] of pil) {
    K.s.part(2, sd).box(x - 0.24, -0.4, -0.24, x + 0.24, hgt, 0.24);
    K.s.part(2, sd).box(x - 0.5, -0.4, -0.5, x + 0.5, 1.1, 0.5);                 // clamp stones 夾杆石
    K.s.part(2, sd).box(x - 0.56, 1.1, -0.56, x + 0.56, 1.22, 0.56);
    K.s.part(0, sd).box(x - 0.6, -0.4, -0.6, x + 0.6, 0.12, 0.6);
    K.m.part(5, sd).cyl(x, 1.22, 0, 0.18, 0.1, 0.35, 8, true);
  }
  // beams: centre 大額枋 + 小額枋, side beams, painted
  K.w.part(7, sd).box(-3.25, 5.35, -0.23, 3.25, 5.85, 0.23);
  K.w.part(7, sd).box(-3.1, 4.15, -0.2, 3.1, 4.5, 0.2);
  K.w.part(3, sd).box(-3.1, 4.5, -0.12, 3.1, 5.35, 0.12);
  for (const s of [-1, 1]) {
    K.w.part(7, sd).box(s < 0 ? -5.9 : 2.7, 4.35, -0.19, s < 0 ? -2.7 : 5.9, 4.75, 0.19);
    K.w.part(7, sd).box(s < 0 ? -5.8 : 2.8, 3.5, -0.16, s < 0 ? -2.8 : 5.8, 3.75, 0.16);
    K.w.part(1, sd).box(s < 0 ? -5.6 : 2.9, 3.75, -0.08, s < 0 ? -2.9 : 5.6, 4.35, 0.08);
  }
  // plaques on both faces
  for (const [name, z, flip] of [[o.front, 0.25, false], [o.back, -0.25, true]]) {
    const [u0, v0, u1, v1] = atlasUV(name);
    const w = 1.7, y0 = 4.5, y1 = 5.35;
    if (!flip) K.g.part(0, 0).quad([-w / 2, y0, z], [w / 2, y0, z], [w / 2, y1, z], [-w / 2, y1, z], [u0, v0, u1, v0, u1, v1, u0, v1]);
    else K.g.part(0, 0).quad([w / 2, y0, z], [-w / 2, y0, z], [-w / 2, y1, z], [w / 2, y1, z], [u0, v0, u1, v0, u1, v1, u0, v1]);
  }
  // brackets 斗拱 above the beams
  for (let x = -3.0; x <= 3.01; x += 0.6) {
    K.w.part(8, sd).box(x - 0.13, 5.85, -0.2, x + 0.13, 5.98, 0.2);
    K.w.part(7, sd).box(x - 0.22, 5.98, -0.34, x + 0.22, 6.12, 0.34);
    K.w.part(8, sd).box(x - 0.1, 6.12, -0.5, x + 0.1, 6.3, 0.5);
  }
  for (const s of [-1, 1]) for (let x = 3.1; x <= 5.5; x += 0.6) {
    K.w.part(8, sd).box(s * x - 0.12, 4.75, -0.18, s * x + 0.12, 4.88, 0.18);
    K.w.part(7, sd).box(s * x - 0.2, 4.88, -0.32, s * x + 0.2, 5.02, 0.32);
  }
  // roofs: centre (tallest) and the two side roofs
  const roofs = [[0, 6.35, 3.9, 1.15, 2.5, 1.05], [-4.35, 5.05, 1.95, 0.95, 1.0, 0.85], [4.35, 5.05, 1.95, 0.95, 1.0, 0.85]];
  for (const [cx, y, hw, hd, rl, rise] of roofs) {
    for (const k in K) { K[k].ox += cx * K[k].c; K[k].oz -= cx * K[k].s; K[k].oy += y; }
    hipRoof(K, { hw, hd, yE: 0, yR: rise, rl, lift: 0.42, flare: 0.3, corr: true, rows: 5, thick: 0.14, sd });
    for (const k in K) { K[k].ox -= cx * K[k].c; K[k].oz += cx * K[k].s; K[k].oy -= y; }
  }
  for (const x of [-1.45, 1.45]) out.hooks.push({ p: toWorld(K.w, x, 4.12, 0), kind: 2, ch: x < 0 ? 4 : 5 });
  out.lights.push({ p: toWorld(K.w, 0, 3.4, 0), i: 2.5 });
}

// ------------------------------------------------------------------------------------------------ bridge
/** Arched stone bridge over the canal (world frame, street along x). deck(x) = walkway height (terrain). */
export function bridge(K, o, out) {
  const { x: bx, half, deck, waterY, bedY, zFace = 5.9, zBack = 5.3, zRail = 5.05 } = o;
  const xa = bx - half - 0.3, xb = bx + half + 0.3;
  const Ra = 2.75, yc = waterY - 0.55;
  const archY = (x) => { const d = x - bx; return Math.abs(d) < Ra ? yc + Math.sqrt(Ra * Ra - d * d) : -1e9; };
  const top = (x) => deck(x) + 0.02;
  const N = 70;
  const xsamp = [];
  for (let i = 0; i <= N; i++) xsamp.push(xa + ((xb - xa) * i) / N);
  K.s.frame(0, 0, 0, 0); K.m.frame(0, 0, 0, 0); K.w.frame(0, 0, 0, 0);
  for (const sg of [-1, 1]) {
    const z = sg * zFace;
    for (let i = 0; i < N; i++) {
      const x0 = xsamp[i], x1 = xsamp[i + 1];
      const y0a = Math.max(bedY, archY(x0)), y0b = Math.max(bedY, archY(x1));
      const lo0 = archY(x0) > -1e8 ? y0a + 0.0 : bedY, lo1 = archY(x1) > -1e8 ? y0b : bedY;
      K.s.part(2, 0.3);
      if (sg > 0) K.s.quad([x0, lo0, z], [x1, lo1, z], [x1, top(x1), z], [x0, top(x0), z]);
      else K.s.quad([x1, lo1, z], [x0, lo0, z], [x0, top(x0), z], [x1, top(x1), z]);
    }
    // voussoir ring, slightly proud of the face
    const na = 24, zr = z + sg * 0.05;
    for (let k = 0; k < na; k++) {
      const a0 = Math.PI * (k / na), a1 = Math.PI * ((k + 1) / na);
      const p = (a, r) => [bx + Math.cos(a) * r, yc + Math.sin(a) * r, zr];
      const r0 = Ra, r1 = Ra + 0.32;
      const A = p(a0, r0), B = p(a1, r0), C = p(a1, r1), D = p(a0, r1);
      if (A[1] < waterY - 0.3 && B[1] < waterY - 0.3) continue;
      K.s.part(3, 0.8);
      if (sg > 0) K.s.quad(A, D, C, B); else K.s.quad(A, B, C, D);
    }
    // vault (intrados) between the face and the back plate, dark back plate
    K.s.part(3, 0.2).grid(20, 1, (i, j, q) => {
      const a = Math.PI * (i / 20);
      q.x = bx + Math.cos(a) * Ra; q.y = yc + Math.sin(a) * Ra; q.z = sg * (j === 0 ? zFace : zBack);
      q.u = a * Ra; q.v = q.z;
    }, sg < 0);
    K.m.part(9, 0.1);
    const c = [bx, yc, sg * zBack];
    for (let k = 0; k < 20; k++) {
      const a0 = Math.PI * (k / 20), a1 = Math.PI * ((k + 1) / 20);
      const A = [bx + Math.cos(a0) * Ra, yc + Math.sin(a0) * Ra, sg * zBack], B = [bx + Math.cos(a1) * Ra, yc + Math.sin(a1) * Ra, sg * zBack];
      if (sg > 0) K.m.triangle(c, A, B); else K.m.triangle(c, B, A);
    }
    // coping slab along the deck edge, balustrade posts + panels + handrail
    for (let i = 0; i < N; i++) {
      const x0 = xsamp[i], x1 = xsamp[i + 1];
      const za = sg * 4.5, zb = sg * (zFace + 0.12);
      const t0 = top(x0) + 0.1, t1 = top(x1) + 0.1;
      K.s.part(2, 0.5);
      if (sg > 0) {
        K.s.quad([x0, t0, za], [x0, t0, zb], [x1, t1, zb], [x1, t1, za]);
        K.s.quad([x0, t0 - 0.35, zb], [x1, t1 - 0.35, zb], [x1, t1, zb], [x0, t0, zb]);
        K.s.quad([x1, t1 - 0.12, za], [x0, t0 - 0.12, za], [x0, t0, za], [x1, t1, za]);
      } else {
        K.s.quad([x1, t1, za], [x1, t1, zb], [x0, t0, zb], [x0, t0, za]);
        K.s.quad([x1, t1 - 0.35, zb], [x0, t0 - 0.35, zb], [x0, t0, zb], [x1, t1, zb]);
        K.s.quad([x0, t0 - 0.12, za], [x1, t1 - 0.12, za], [x1, t1, za], [x0, t0, za]);
      }
    }
    const np = 10;
    const posts = [];
    for (let k = 0; k <= np; k++) posts.push(xa + 0.35 + ((xb - xa - 0.7) * k) / np);
    for (const x of posts) {
      const y = top(x) + 0.1;
      K.s.part(2, 0.6).box(x - 0.11, y, sg * zRail - 0.11, x + 0.11, y + 0.82, sg * zRail + 0.11);
      K.s.lathe(x, y + 0.82, sg * zRail, [[0.09, 0], [0.12, 0.06], [0.1, 0.14], [0.05, 0.2], [0, 0.23]], 8);
    }
    for (let k = 0; k < np; k++) {
      const x0 = posts[k] + 0.11, x1 = posts[k + 1] - 0.11;
      const a = [x0, top(x0) + 0.1 + 0.33, sg * zRail], b = [x1, top(x1) + 0.1 + 0.33, sg * zRail];
      K.s.part(2, 0.45).beam(a, b, 0.1, 0.5);
      K.s.part(2, 0.55).beam([x0, a[1] + 0.34, sg * zRail], [x1, b[1] + 0.34, sg * zRail], 0.13, 0.08);
    }
    // end scroll stones 抱鼓石
    for (const [x, d] of [[xa - 0.1, -1], [xb + 0.1, 1]]) {
      const y = top(x) + 0.1;
      K.s.part(2, 0.4).box(x - 0.45, y - 0.3, sg * zRail - 0.12, x + 0.45, y + 0.35, sg * zRail + 0.12);
      K.s.cyl(x + d * 0.1, y + 0.35, sg * zRail, 0.34, 0.34, 0.2, 12, true);
    }
  }
  // bridge lamps: two bamboo poles at the crest with a lantern each
  for (const sg of [-1, 1]) {
    const x = bx + sg * 1.4, z = -sg * (zRail + 0.02), y = top(x) + 0.1;
    K.m.part(3, 0.3).cyl(x, y, z, 0.045, 0.04, 2.6, 6, true);
    K.m.part(6, 0.3).beam([x, y + 2.5, z], [x, y + 2.5, z - Math.sign(z) * 0.55], 0.04, 0.04);
    out.hooks.push({ p: [x, y + 2.48, z - Math.sign(z) * 0.5], kind: 1, ch: 7 });
  }
}

// ------------------------------------------------------------------------------------------------ canal embankments
export function canalBanks(K, o) {
  const { x: cx, wallDx, quayDx, z0, z1, waterY, bedY, groundAt, steps = [] } = o;
  K.s.frame(0, 0, 0, 0);
  const dz = 1.5;
  for (const side of [-1, 1]) {
    const xw = cx + side * wallDx, xq = cx + side * quayDx;
    for (const sz of [-1, 1]) {
      for (let z = z0; z < z1; z += dz) {
        const za = sz * z, zb = sz * Math.min(z1, z + dz);
        const ya = groundAt(xq, za) + 0.04, yb = groundAt(xq, zb) + 0.04;
        const lo = Math.min(za, zb), hi = Math.max(za, zb), ylo = lo === za ? ya : yb, yhi = lo === za ? yb : ya;
        // quay top (slabs), canal face (embankment), coping kerb
        K.s.part(0, 0.4);
        if (side < 0) K.s.quad([xq, ylo, lo], [xq, yhi, hi], [xw, yhi, hi], [xw, ylo, lo]);
        else K.s.quad([xw, ylo, lo], [xw, yhi, hi], [xq, yhi, hi], [xq, ylo, lo]);
        K.s.part(1, 0.5);
        if (side > 0) K.s.quad([xw, bedY, hi], [xw, yhi, hi], [xw, ylo, lo], [xw, bedY, lo]);
        else K.s.quad([xw, bedY, lo], [xw, ylo, lo], [xw, yhi, hi], [xw, bedY, hi]);
        K.s.part(2, 0.6).box(Math.min(xw, xw - side * 0.35), Math.min(ylo, yhi) - 0.02, lo, Math.max(xw, xw - side * 0.35) + 0 * side, Math.max(ylo, yhi) + 0.1, hi, FACE_SKIP_Y);
      }
    }
  }
  // stone steps down to the water 河埠頭 (along the wall)
  for (const s of steps) {
    const xw = cx + s.side * wallDx, yT = groundAt(cx + s.side * quayDx, s.z);
    const n = Math.max(3, Math.round((yT - waterY + 0.1) / 0.24));
    for (let k = 0; k < n; k++) {
      const y = yT - (k + 1) * ((yT - waterY + 0.15) / n);
      const za = s.z + s.dir * k * 0.32;
      K.s.part(2, 0.3).box(Math.min(xw, xw - s.side * 1.1), bedY, Math.min(za, za + s.dir * 0.32), Math.max(xw, xw - s.side * 1.1), y, Math.max(za, za + s.dir * 0.32));
    }
  }
}
const FACE_SKIP_Y = 8;   // FACE.NY

// ------------------------------------------------------------------------------------------------ boat 烏篷船
export function boat(K, x, y, z, yaw) {
  for (const k in K) K[k].frame(x, y, z, yaw);
  const L = 7.2;
  K.m.part(8, 0.4).grid(16, 8, (i, j, q) => {
    const u = i / 16, v = j / 8;
    const w = 0.78 * Math.pow(Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, u))), 0.55);
    const a = Math.PI * v;                               // 0: left gunwale → π: right gunwale via the keel
    const gun = 0.35 + 0.35 * Math.pow(Math.abs(2 * u - 1), 3);
    q.x = -Math.cos(a) * w; q.y = gun - Math.sin(a) * 0.5 * (0.4 + 0.6 * Math.sin(Math.PI * u)); q.z = (u - 0.5) * L;
    q.u = q.z; q.v = a;
  }, false);
  K.m.part(8, 0.6).box(-0.7, 0.25, -1.6, 0.7, 0.3, 1.6);
  for (const [zc, len] of [[-0.5, 1.4], [1.0, 1.2]]) {
    K.m.part(9, 0.5).grid(10, 1, (i, j, q) => {
      const a = Math.PI * (i / 10);
      q.x = Math.cos(a) * 0.72; q.y = 0.35 + Math.sin(a) * 0.62; q.z = zc + (j - 0.5) * len; q.u = a; q.v = q.z;
    }, true);
  }
  K.m.part(6, 0.4).beam([0, 0.35, -3.4], [0, 1.6, -4.4], 0.05, 0.05);
}

// ------------------------------------------------------------------------------------------------ market stall
export function stall(K, rnd, out) {
  const sd = rnd();
  K.w.part(1, sd).box(-0.85, 0.74, -0.42, 0.85, 0.8, 0.42);
  K.w.part(0, sd);
  for (const [x, z] of [[-0.78, -0.35], [0.78, -0.35], [-0.78, 0.35], [0.78, 0.35]]) K.w.box(x - 0.035, 0, z - 0.035, x + 0.035, 0.74, z + 0.035);
  // awning on four poles
  for (const [x, z, hgt] of [[-0.9, -0.55, 2.35], [0.9, -0.55, 2.35], [-0.9, 0.6, 2.05], [0.9, 0.6, 2.05]]) K.w.part(0, sd).cyl(x, 0, z, 0.03, 0.025, hgt, 5, false);
  const cl = 'cloth' + Math.floor(rnd() * 8);
  const [u0, v0, u1, v1] = atlasUV(cl);
  const ph = rnd() * 6;
  K.g.grid(4, 3, (i, j, q) => {
    const s = i / 4, t = j / 3;
    q.x = -1.0 + 2.0 * s; q.z = -0.62 + 1.35 * t; q.y = 2.36 - 0.34 * t + 0.05 * Math.sin(Math.PI * s);
    q.u = u0 + (u1 - u0) * s; q.v = v0 + (v1 - v0) * t; q.p = 0.12 * t; q.s = ph;
  }, false);
  // wares: baskets, jars, cloth rolls
  const n = 3 + Math.floor(rnd() * 3);
  for (let k = 0; k < n; k++) {
    const x = -0.6 + (1.2 * k) / Math.max(1, n - 1), z = (rnd() - 0.5) * 0.4;
    const r = rnd();
    if (r < 0.45) K.m.part(3, rnd()).cyl(x, 0.8, z, 0.17, 0.2, 0.12, 10, true);
    else if (r < 0.75) K.m.part(1, rnd()).lathe(x, 0.8, z, [[0.0, 0], [0.09, 0.0], [0.12, 0.08], [0.1, 0.18], [0.05, 0.22], [0.06, 0.25], [0, 0.25]], 8);
    else K.m.part(2, rnd()).box(x - 0.14, 0.8, z - 0.1, x + 0.14, 0.95, z + 0.1);
  }
  // baskets on the ground
  K.m.part(3, rnd()).cyl(-0.5, 0, 0.62, 0.22, 0.26, 0.3, 10, true);
  out.hooks.push({ p: toWorld(K.w, 0.9, 2.02, 0.6), kind: 0, ch: -1 });
}

/** A cluster of wine jars 酒罈 with red paper seals. */
export function jars(K, rnd, n = 4) {
  for (let k = 0; k < n; k++) {
    const x = (k - (n - 1) / 2) * 0.55 + (rnd() - 0.5) * 0.1, z = (rnd() - 0.5) * 0.25, s = 0.85 + rnd() * 0.3;
    K.m.part(1, rnd()).lathe(x, 0, z, [[0, 0], [0.16, 0], [0.24, 0.1], [0.27, 0.3], [0.22, 0.5], [0.12, 0.58], [0.12, 0.62]], 10, s, s);
    K.m.part(2, rnd()).lathe(x, 0.6 * s, z, [[0.14, 0], [0.16, 0.04], [0.12, 0.1], [0, 0.12]], 8, s, s);
  }
}
