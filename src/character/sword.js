// Weapons and scabbards (owner: character C). Pure geometry, worker-safe.
//
// Weapon-local frame = the weapon.R socket frame (skeleton.js): origin at the grip centre, blade along +Z, edges
// ±Y (single-edged blades: edge −Y, spine +Y), flats ±X. Every weapon returns
//   { parts: [{ mat, mesh }], base, tip (z of the blade segment for hits/trails), tassel?: {...},
//     sheath: { mount: bone name, frame: Matrix4 (weapon frame in the mount's bind-local space), parts } }
// Blades are built facet by facet (duplicated vertices at every crease) so ridges, bevels and the fuller catch the
// sun as crisp lines; the jian has a diamond section with a shallow fuller, the dao a wedge with a flat spine.
import * as THREE from 'three';
import { ellipsoid, roundBox, roundCone, unionSDF, meshSDF, computeNormals } from './humanoidSdf.js';
import { V, clamp, sstep, mix, vnoise3, tube, lathe, merge, xform, paint } from './outfitsKit.js';

const TAU = Math.PI * 2;
const scale3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// ---------------------------------------------------------------------------------------------------------------
// blade builder
// ---------------------------------------------------------------------------------------------------------------

/**
 * Build a blade from cross-section facets. section(z, out) → array of polylines [[x, y], ...] for the +X half
 * (each polyline = one smooth facet group; creases between polylines). Mirrored to −X. rows = samples along z.
 * edgeCol(u01 across, z) → colour multiplier (polished edge band).
 */
function bladeFromSections(z0, z1, rows, section, { color = [0.62, 0.63, 0.64], edge = null } = {}) {
  const parts = [];
  const zs = [];
  for (let i = 0; i < rows; i++) { const u = i / (rows - 1); zs.push(z0 + (z1 - z0) * (1 - Math.pow(1 - u, 1.15))); }
  const secs = zs.map(z => section(z));
  const nF = secs[0].length;
  for (const mirror of [1, -1]) {
    for (let f = 0; f < nF; f++) {
      const P = [], I = [], C = [];
      const K = secs[0][f].length;
      for (let r = 0; r < rows; r++) {
        const pl = secs[r][f];
        for (let k = 0; k < K; k++) {
          const [x, y] = pl[k];
          P.push(x * mirror, y, zs[r]);
          const m = edge ? edge(f, k / (K - 1), zs[r]) : 1;
          C.push(color[0] * m, color[1] * m, color[2] * m);
        }
      }
      for (let r = 0; r < rows - 1; r++) for (let k = 0; k < K - 1; k++) {
        const a = r * K + k, b = a + 1, c = a + K + 1, d = a + K;
        if (mirror > 0) I.push(a, c, b, a, d, c); else I.push(a, b, c, a, c, d);
      }
      const m = { positions: new Float32Array(P), normals: new Float32Array(P.length), indices: new Uint32Array(I), extra: {} };
      computeNormals(m);
      // outward check: normals should point away from the blade plane on this side
      let s = 0; for (let v = 0; v < m.normals.length; v += 3) s += m.normals[v] * mirror;
      if (s < 0 && f !== -1) { for (let t = 0; t < I.length; t += 3) { const tmp = m.indices[t + 1]; m.indices[t + 1] = m.indices[t + 2]; m.indices[t + 2] = tmp; } computeNormals(m); }
      m.extra.color = { size: 3, array: new Float32Array(C) };
      parts.push(m);
    }
  }
  const out = merge(parts);
  // blade uv: u across (x), v along z (brushing streaks run along the blade)
  out.uvs = new Float32Array(out.positions.length / 3 * 2);
  for (let v = 0; v < out.positions.length / 3; v++) { out.uvs[v * 2] = out.positions[v * 3 + 1] * 8 + 0.5; out.uvs[v * 2 + 1] = out.positions[v * 3 + 2] * 1.2; }
  return out;
}

/** Straight double-edged jian blade with a diamond section and a fuller. */
function jianBlade(z0 = 0.1, L = 0.76) {
  const z1 = z0 + L;
  const tipL = 0.055;
  const wAt = (z) => {
    const u = (z - z0) / L;
    let w = mix(0.0172, 0.0138, u);
    const tz = z1 - z;
    if (tz < tipL) w *= Math.sqrt(Math.max(0, tz / tipL)) * (0.35 + 0.65 * tz / tipL) + 0.0;
    return Math.max(w, 0.00025);
  };
  const tAt = (z) => { const u = (z - z0) / L; const tz = z1 - z; return mix(0.0031, 0.0021, u) * (tz < tipL ? 0.3 + 0.7 * tz / tipL : 1); };
  const section = (z) => {
    const w = wAt(z), tr = tAt(z), te = 0.00025;
    const bv = Math.min(0.0028, w * 0.3);
    const u = (z - z0) / L;
    const fw = w * 0.22 * sstep(0.62, 0.5, u) * sstep(0.0, 0.03, u);    // fuller half-width (fades out toward the tip)
    const fd = tr * 0.28 * (fw > 1e-5 ? 1 : 0);
    const xb = te + (tr - te) * (bv / w) * 1.9;                           // bevel break
    const xAt = (y) => te + (tr - te) * (1 - Math.abs(y) / w);           // main flat
    const up = [[te, w], [xb, w - bv]];
    const flatA = [[xb, w - bv], [xAt(fw * 1.6), fw * 1.6]];
    const fuller = [[xAt(fw * 1.6), fw * 1.6], [xAt(fw) - fd * 0.6, fw * 0.7], [xAt(0) - fd, 0], [xAt(fw) - fd * 0.6, -fw * 0.7], [xAt(fw * 1.6), -fw * 1.6]];
    const flatB = [[xAt(fw * 1.6), -fw * 1.6], [xb, -(w - bv)]];
    const dn = [[xb, -(w - bv)], [te, -w]];
    return [up, flatA, fuller, flatB, dn];
  };
  return bladeFromSections(z0, z1, 48, section, {
    color: [0.6, 0.62, 0.64],
    edge: (f, k) => (f === 0 || f === 4 ? 1.12 : f === 2 ? 0.86 : 1.0), // polished edge bevels, darker fuller
  });
}

/** Single-edged dao blade: spine +Y, edge −Y, curving toward the spine; widening toward the tip. */
function daoBlade({ z0 = 0.09, L = 0.72, h0 = 0.034, h1 = 0.048, curve = 0.045, spine = 0.0032, tipL = 0.12, rings = 0 } = {}) {
  const z1 = z0 + L;
  const cAt = (z) => curve * Math.pow((z - z0) / L, 2);
  const section = (z) => {
    const u = (z - z0) / L, tz = z1 - z;
    const ys = cAt(z) + 0.004;                  // spine line
    let H = mix(h0, h1, Math.pow(u, 1.4));      // full blade height
    if (tz < tipL) H *= Math.max(0.02, Math.pow(tz / tipL, 0.7));
    const ye = ys - H;
    const ts = spine * mix(1, 0.7, u) * (tz < tipL ? 0.3 + 0.7 * tz / tipL : 1);
    const bv = Math.min(0.004, H * 0.25);
    const top = [[0.0002, ys], [ts * 0.8, ys - 0.0005], [ts, ys - 0.0015]];
    const flat = [[ts, ys - 0.0015], [ts * 0.55, ye + bv]];
    const edge = [[ts * 0.55, ye + bv], [0.00025, ye]];
    return [top, flat, edge];
  };
  return bladeFromSections(z0, z1, 44, section, { color: [0.5, 0.5, 0.5], edge: (f, k) => (f === 2 ? 1.25 : f === 0 ? 0.85 : 1) });
}

/** Leaf-shaped spear head along +Z from z0. */
function spearHead(z0, L = 0.26) {
  const z1 = z0 + L;
  const section = (z) => {
    const u = (z - z0) / L;
    const w = 0.028 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15 + 0.02)), 0.8) * (1 - Math.pow(u, 6)) + 0.0006;
    const tr = 0.006 * (1 - u * 0.7), te = 0.0004;
    return [[[te, w], [tr, 0], [te, -w]]];
  };
  return bladeFromSections(z0, z1, 30, section, { color: [0.48, 0.48, 0.48] });
}

// ---------------------------------------------------------------------------------------------------------------
// fittings
// ---------------------------------------------------------------------------------------------------------------

/** Lathe about +Z (profile [[r, z], ...]). */
function latheZ(profile, segs = 20, sx = 1, sy = 1) {
  const m = lathe(profile.map(([r, z]) => [r, z]), segs);
  // lathe is around +Y: rotate so +Y → +Z, then squash the section
  xform(m, new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const P = m.positions;
  for (let v = 0; v < P.length; v += 3) { P[v] *= sx; P[v + 1] *= sy; }
  computeNormals(m);
  return m;
}

/** Cord-wrapped grip (diamond wrap bumps), oval section. */
function wrappedGrip(z0, z1, r, { flat = 0.82, turns = 9, color = [0.05, 0.03, 0.02], bulge = 0.06 } = {}) {
  const NU = 24, NV = Math.round((z1 - z0) / 0.0025);
  const P = [], I = [], C = [];
  for (let j = 0; j <= NV; j++) {
    const v = j / NV, z = mix(z0, z1, v);
    const belly = 1 + bulge * Math.sin(v * Math.PI);
    for (let i = 0; i <= NU; i++) {
      const a = i / NU * TAU;
      const h1 = Math.sin(a * 2 + v * turns * TAU), h2 = Math.sin(a * 2 - v * turns * TAU);
      const bump = 0.0011 * (Math.max(Math.abs(h1), Math.abs(h2)) - 0.6);
      const rr = r * belly + bump;
      P.push(Math.cos(a) * rr * flat, Math.sin(a) * rr, z);
      const shade = 0.75 + 0.35 * (Math.max(Math.abs(h1), Math.abs(h2)) - 0.5);
      C.push(color[0] * shade, color[1] * shade, color[2] * shade);
    }
  }
  const row = NU + 1;
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) { const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row; I.push(a, b, c, a, c, d); }
  const m = { positions: new Float32Array(P), normals: new Float32Array(P.length), indices: new Uint32Array(I), extra: { color: { size: 3, array: new Float32Array(C) } } };
  computeNormals(m);
  let s = 0; for (let v = 0; v < P.length; v += 3) s += m.normals[v] * P[v] + m.normals[v + 1] * P[v + 1];
  if (s < 0) { for (let t = 0; t < I.length; t += 3) { const tmp = m.indices[t + 1]; m.indices[t + 1] = m.indices[t + 2]; m.indices[t + 2] = tmp; } computeNormals(m); }
  return m;
}

/** Small SDF solid (guards, pommels) → mesh. */
function sdfPart(items, box, voxel = 0.0012, tris = 700) {
  const f = unionSDF(items, 0.003);
  return meshSDF(f, box[0], box[1], voxel, tris);
}

/** Jian guard: bronze bar with swept wings toward the blade and a central ridge. */
function jianGuard(z) {
  const items = [];
  const b = roundBox(V(0, 0, z), V(0.012, 0.036, 0.009), 0.004); b.k = 0; items.push(b);
  for (const sy of [1, -1]) {
    const w = ellipsoid(V(0, sy * 0.034, z + 0.006), V(0.011, 0.014, 0.012), new THREE.Quaternion().setFromEuler(new THREE.Euler(sy * 0.5, 0, 0))); w.k = 0.006; items.push(w);
  }
  const c = ellipsoid(V(0, 0, z + 0.01), V(0.013, 0.02, 0.012)); c.k = 0.006; items.push(c);
  return sdfPart(items, [V(-0.03, -0.06, z - 0.02), V(0.03, 0.06, z + 0.035)]);
}

/** Jian pommel: flattened lotus bulb with a ring for the tassel. */
function jianPommel(z) {
  const items = [];
  const a = ellipsoid(V(0, 0, z - 0.012), V(0.013, 0.019, 0.014)); a.k = 0; items.push(a);
  const n = roundCone(V(0, 0, z + 0.004), V(0, 0, z - 0.004), 0.012, 0.014); n.k = 0.004; items.push(n);
  const t = roundCone(V(0, 0, z - 0.024), V(0, 0, z - 0.03), 0.006, 0.004); t.k = 0.004; items.push(t);
  return sdfPart(items, [V(-0.03, -0.035, z - 0.045), V(0.03, 0.035, z + 0.02)]);
}

function ringTorus(c, R, r, axis = 'x', segs = 14) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const a = i / segs * TAU;
    const p = axis === 'x' ? [c[0], c[1] + Math.cos(a) * R, c[2] + Math.sin(a) * R] : axis === 'y' ? [c[0] + Math.cos(a) * R, c[1], c[2] + Math.sin(a) * R] : [c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R, c[2]];
    pts.push(p);
  }
  return tube(pts, r, { sides: 6, caps: false });
}

/** Tassel on a chain hanging from the pommel. Returns { chain spec pieces, mesh builder }. */
function tasselSpec(anchor, len, color, bushy = 1) {
  const n = 6;
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push([anchor[0], anchor[1] - len * i / (n - 1), anchor[2] - 0.01 * Math.sin(i / (n - 1) * 2)]);
  return { nodes, len, color, bushy };
}

/** Tassel mesh (weapon-local), weighted along the chain nodes (bone0 = first node bone). */
export function tasselMesh(spec, bone0) {
  const pts = spec.nodes.map(p => V(...p));
  const n = pts.length;
  const L = spec.len;
  const parts = [];
  const cordEnd = 0.3;
  const sample = (u) => {
    const f = u * (n - 1), i = Math.min(Math.floor(f), n - 2), t = f - i;
    return pts[i].clone().lerp(pts[i + 1], t);
  };
  const cordPts = []; for (let k = 0; k <= 8; k++) cordPts.push(sample(k / 8 * cordEnd).toArray());
  parts.push(tube(cordPts, 0.0022 * spec.bushy, { sides: 5, caps: false }));
  const kc = sample(cordEnd);
  parts.push(tube([[kc.x, kc.y + 0.006, kc.z], [kc.x, kc.y - 0.012, kc.z]], (t) => 0.0065 * spec.bushy * Math.sin(Math.PI * (0.15 + 0.7 * t)), { sides: 8 }));
  const NS = Math.round(10 * spec.bushy);
  for (let k = 0; k < NS; k++) {
    const a = k / NS * TAU, spread = 0.0045 * spec.bushy;
    const sp = [];
    for (let j = 0; j <= 8; j++) {
      const u = cordEnd + (1 - cordEnd) * j / 8;
      const p = sample(Math.min(u, 1));
      const fan = spread * (0.6 + 1.2 * (j / 8));
      sp.push([p.x + Math.cos(a) * fan, p.y - (u > 0.99 ? 0.004 * Math.sin(k * 3.7) : 0), p.z + Math.sin(a) * fan]);
    }
    parts.push(tube(sp, (t) => 0.0014 * spec.bushy * (1 - 0.5 * t), { sides: 3, caps: false }));
  }
  const m = merge(parts);
  paint(m, { color: (x, y, z) => scale3(spec.color, 0.85 + 0.3 * vnoise3(x * 200, y * 200, z * 200)), color2: scale3(spec.color, 0.7), cloth: [1, 1, 1, 1] });
  // weights by nearest parameter along the node polyline
  const SI = new Float32Array(m.positions.length / 3 * 4), SW = new Float32Array(m.positions.length / 3 * 4);
  for (let v = 0; v < m.positions.length / 3; v++) {
    const x = m.positions[v * 3], y = m.positions[v * 3 + 1], z = m.positions[v * 3 + 2];
    let best = 1e9, bi = 0, bt = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
      const t = clamp(((x - a.x) * bx + (y - a.y) * by + (z - a.z) * bz) / (bx * bx + by * by + bz * bz), 0, 1);
      const d = Math.hypot(x - a.x - bx * t, y - a.y - by * t, z - a.z - bz * t);
      if (d < best) { best = d; bi = i; bt = t; }
    }
    SI[v * 4] = bone0 + bi; SW[v * 4] = 1 - bt; SI[v * 4 + 1] = bone0 + bi + 1; SW[v * 4 + 1] = bt;
  }
  m.extra.skinIndex = { size: 4, array: SI };
  m.extra.skinWeight = { size: 4, array: SW };
  return m;
}

/** Sheathed weapon frame (weapon-local → mount-local): throat point, blade direction; the guard front sits at the throat. */
function sheathFrame(throat, dir, guardZ, s = 1, edgeUp = false) {
  const Z = V(...dir).normalize();
  const Y = V(0, edgeUp ? -1 : 1, 0).addScaledVector(Z, edgeUp ? Z.y : -Z.y).normalize();
  const X = Y.clone().cross(Z);
  const o = V(...throat).multiplyScalar(s).addScaledVector(Z, -guardZ);
  return new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(o);
}

/** Lacquered scabbard in the (sheathed) weapon frame from z0 to z1, oval section, bronze fittings. */
function scabbard(z0, z1, { w0 = 0.024, w1 = 0.019, t0 = 0.0115, t1 = 0.0095, curve = 0, color = [0.05, 0.018, 0.014], fittings = [0.1, 0.22, 0.38], chape = 0.06, bronze = true } = {}) {
  const pts = [];
  const N = 30;
  for (let i = 0; i <= N; i++) { const z = mix(z0, z1, i / N); pts.push([0, curve * Math.pow((z - z0) / (z1 - z0), 2), z]); }
  const body = tube(pts, (t) => mix(w0, w1, t), { sides: 14, flat: mix(t0, t1, 0.5) / mix(w0, w1, 0.5), up: [1, 0, 0], caps: true, samples: 0 });
  // tube() puts the flattened axis along B; make the wide axis Y (edges) and the thin axis X (flats)
  paint(body, { color: (x, y, z) => scale3(color, 0.85 + 0.3 * vnoise3(x * 50, y * 50, z * 20)), color2: color, cloth: [0, 0, 1, 1] });
  const parts = { lacquer: [body], bronze: [] };
  if (bronze) {
    const band = (za, zb, grow = 1.12) => {
      const p2 = []; for (let i = 0; i <= 4; i++) { const z = mix(za, zb, i / 4); p2.push([0, curve * Math.pow((z - z0) / (z1 - z0), 2), z]); }
      const u0 = (za - z0) / (z1 - z0), u1 = (zb - z0) / (z1 - z0);
      const b = tube(p2, (t) => mix(w0, w1, mix(u0, u1, t)) * grow, { sides: 14, flat: mix(t0, t1, 0.5) / mix(w0, w1, 0.5), up: [1, 0, 0], caps: false });
      paint(b, { color: [0.36, 0.3, 0.17], color2: [0.2, 0.16, 0.1], cloth: [0, 0, 1, 1] });
      parts.bronze.push(b);
    };
    band(z0 - 0.002, z0 + 0.035, 1.14);                        // throat
    for (const f of fittings.slice(1)) {
      band(z0 + f, z0 + f + 0.012, 1.1);
      const yy = curve * Math.pow(f / (z1 - z0), 2) + mix(w0, w1, f / (z1 - z0)) * 1.1 + 0.006;
      const r = ringTorus([0, yy, z0 + f + 0.006], 0.007, 0.0017, 'x');
      paint(r, { color: [0.36, 0.3, 0.17], color2: [0.2, 0.16, 0.1], cloth: [0, 0, 1, 1] });
      parts.bronze.push(r);
    }
    band(z1 - chape, z1 + 0.004, 1.1);                          // chape
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------------------------
// weapons
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {'jian'|'katana'|'dao'|'dao_heavy'|'spear'|'miaodao'} type
 * @param {{ s?: number, tasselColor?, gripColor?, scabbardColor?, rng? }} o
 */
export function buildWeapon(type, o = {}) {
  const s = o.s ?? 1;
  const out = { type, parts: [], base: 0.1, tip: 0.86, tassel: null, sheath: null };
  const P = (mat, mesh) => { if (mesh) out.parts.push({ mat, mesh }); };
  if (type === 'jian') {
    P('steel', jianBlade(0.1, 0.76));
    P('bronze', paintAll(jianGuard(0.088), [0.34, 0.37, 0.27]));
    P('leather', wrappedGrip(-0.078, 0.078, 0.0148, { color: o.gripColor ?? [0.03, 0.022, 0.018] }));
    P('bronze', paintAll(latheZ([[0.0158, 0.078], [0.0172, 0.08], [0.0165, 0.086], [0.0, 0.087]], 18, 0.85, 1), [0.34, 0.37, 0.27]));      // ferrule
    P('bronze', paintAll(jianPommel(-0.082), [0.34, 0.37, 0.27]));
    out.base = 0.1; out.tip = 0.86;
    out.tassel = tasselSpec([0, -0.004, -0.114], 0.25, o.tasselColor ?? [0.45, 0.02, 0.02], 1);
    const sc = scabbard(0.1, 0.9, { color: o.scabbardColor ?? [0.045, 0.02, 0.016] });
    out.sheath = { mount: 'sheath', frame: sheathFrame([0.014, 0.05, 0.1], [0.1, -0.55, -0.83], 0.1, s), parts: [['lacquer', merge(sc.lacquer)], ['bronze', merge(sc.bronze)]] };
    out.hangers = true;
  } else if (type === 'dao' || type === 'dao_heavy') {
    const heavy = type === 'dao_heavy';
    const L = heavy ? 0.68 : 0.7;
    P('steel', daoBlade(heavy ? { z0: 0.09, L, h0: 0.07, h1: 0.1, curve: 0.02, spine: 0.0045, tipL: 0.14 } : { z0: 0.09, L, h0: 0.034, h1: 0.046, curve: 0.05, spine: 0.0032 }));
    // disc guard (iron)
    P('bronze', paintAll(latheZ([[0.0, 0.074], [0.03, 0.074], [0.036, 0.078], [0.036, 0.084], [0.03, 0.088], [0.0, 0.088]], 20, 0.8, 1), [0.12, 0.11, 0.1]));
    const gz0 = heavy ? -0.16 : -0.09;
    P('leather', wrappedGrip(gz0, 0.072, heavy ? 0.017 : 0.0145, { color: o.gripColor ?? [0.2, 0.06, 0.03], turns: heavy ? 14 : 9, bulge: 0.03 }));
    // ring pommel (环首)
    const ring = ringTorus([0, 0, gz0 - 0.028], heavy ? 0.03 : 0.024, heavy ? 0.006 : 0.0045, 'x', 18);
    paintAll(ring, [0.12, 0.11, 0.1]);
    P('bronze', ring);
    if (heavy) {
      // nine rings through the spine
      const rings = [];
      for (let i = 0; i < 6; i++) {
        const z = 0.16 + i * 0.075;
        const u = (z - 0.09) / L;
        const y = 0.02 * u * u + 0.004 - 0.012;
        rings.push(ringTorus([0.0, y + 0.01, z], 0.012, 0.0022, 'x', 12));
      }
      P('bronze', paintAll(merge(rings), [0.2, 0.17, 0.12]));
    }
    out.base = 0.1; out.tip = 0.09 + L;
    out.sheath = heavy
      ? { mount: 'back', frame: sheathFrame([-0.05, 0.1, -0.08], [0.55, -0.8, -0.1], 0.2, s), parts: [] }
      : { mount: 'sheath', frame: sheathFrame([0.03, 0.06, 0.1], [0.12, -0.5, -0.86], 0.09, s), parts: [] };
    if (!heavy && o.scabbard) {
      const sc = scabbard(0.09, 0.09 + L + 0.02, { w0: 0.03, w1: 0.036, t0: 0.012, t1: 0.011, curve: 0.05, color: o.scabbardColor ?? [0.08, 0.05, 0.03], bronze: false });
      out.sheath.parts.push(['leather', merge(sc.lacquer)]);
    }
  } else if (type === 'spear') {
    const shaft = tube([[0, 0, -1.0], [0, 0, 0.96]], (t) => 0.0155 - 0.003 * t, { sides: 10, caps: true });
    paint(shaft, { color: (x, y, z) => scale3([0.2, 0.12, 0.06], 0.8 + 0.4 * vnoise3(x * 400, y * 400, z * 6)), color2: [0.1, 0.06, 0.03], cloth: [0, 0, 1, 1] });
    P('leather', shaft);
    P('bronze', paintAll(latheZ([[0.0, 0.93], [0.016, 0.93], [0.016, 0.975], [0.011, 1.0], [0.004, 1.01]], 14), [0.14, 0.13, 0.12]));
    P('bronze', paintAll(latheZ([[0.0, -1.02], [0.017, -1.015], [0.017, -0.98], [0.015, -0.97]], 14), [0.14, 0.13, 0.12]));
    P('steel', spearHead(1.0, 0.26));
    out.base = 1.0; out.tip = 1.26;
    out.twoHandGap = 0.5;                                  // the left fist half a metre down the shaft
    out.tassel = tasselSpec([0, -0.005, 0.965], 0.16, o.tasselColor ?? [0.38, 0.03, 0.02], 2.2);
    out.sheath = { mount: 'back', frame: sheathFrame([0.0, 0.0, -0.09], [0.45, 0.87, -0.05], 0.0, s), parts: [] };
  } else if (type === 'katana') {
    // 打刀: shallow koshi-zori, small kissaki, brass habaki, round iron tsuba, long black ito-wrapped tsuka for two
    // hands (right hand at the tsuba, left hand at the kashira), black lacquered saya worn edge-up through the obi.
    const L = 0.72;
    // edge on +Y (the knuckle side of the weapon frame): a katana cuts with the edge that leads the fist
    P('steel', flipY(daoBlade({ z0: 0.062, L, h0: 0.031, h1: 0.025, curve: 0.026, spine: 0.0036, tipL: 0.055 })));
    P('bronze', paintAll(latheZ([[0.0, 0.046], [0.0175, 0.046], [0.0175, 0.068], [0.0, 0.07]], 12, 0.62, 1.2), [0.46, 0.36, 0.14]));   // habaki
    P('bronze', paintAll(latheZ([[0.0, 0.038], [0.039, 0.038], [0.0415, 0.0405], [0.0415, 0.0445], [0.039, 0.047], [0.0, 0.047]], 32, 0.9, 1), [0.07, 0.065, 0.06]));  // tsuba
    P('bronze', paintAll(latheZ([[0.0, 0.028], [0.0165, 0.028], [0.0175, 0.032], [0.0175, 0.038], [0.0, 0.038]], 16, 0.8, 1), [0.3, 0.24, 0.12]));   // fuchi
    P('leather', wrappedGrip(-0.215, 0.03, 0.0142, { color: o.gripColor ?? [0.022, 0.02, 0.03], turns: 12, bulge: 0.035 }));
    P('bronze', paintAll(latheZ([[0.0162, -0.215], [0.0168, -0.222], [0.0145, -0.232], [0.0, -0.235]], 16, 0.8, 1), [0.07, 0.065, 0.06]));   // kashira
    out.base = 0.08; out.tip = 0.062 + L;
    out.twoHandGap = 0.165;
    const sc = scabbard(0.05, 0.83, { w0: 0.021, w1: 0.018, t0: 0.0125, t1: 0.011, curve: -0.026, color: o.scabbardColor ?? [0.012, 0.011, 0.012], fittings: [0.1], chape: 0.035 });
    out.sheath = { mount: 'sheath', frame: sheathFrame([0.014, 0.05, 0.1], [0.1, -0.55, -0.83], 0.05, s), parts: [['lacquer', merge(sc.lacquer)], ['bronze', merge(sc.bronze)]] };
  } else if (type === 'miaodao') {
    P('steel', daoBlade({ z0: 0.075, L: 0.96, h0: 0.031, h1: 0.029, curve: 0.05, spine: 0.0034, tipL: 0.09 }));
    P('bronze', paintAll(latheZ([[0.0, 0.062], [0.036, 0.062], [0.04, 0.066], [0.04, 0.071], [0.036, 0.075], [0.0, 0.075]], 24, 0.85, 1), [0.3, 0.27, 0.18]));
    P('leather', wrappedGrip(-0.2, 0.06, 0.0145, { color: o.gripColor ?? [0.32, 0.03, 0.025], turns: 16, bulge: 0.02 }));
    P('bronze', paintAll(latheZ([[0.0, -0.225], [0.016, -0.222], [0.017, -0.2], [0.015, -0.196]], 16, 0.85, 1), [0.3, 0.27, 0.18]));
    out.base = 0.09; out.tip = 1.03;
    const sc = scabbard(0.075, 1.06, { w0: 0.024, w1: 0.021, t0: 0.012, t1: 0.011, curve: 0.05, color: o.scabbardColor ?? [0.02, 0.016, 0.016], fittings: [0.1, 0.18, 0.34], chape: 0.07 });
    out.sheath = { mount: 'sheath', frame: sheathFrame([0.02, 0.06, 0.12], [0.1, -0.6, -0.8], 0.075, s), parts: [['lacquer', merge(sc.lacquer)], ['bronze', merge(sc.bronze)]] };
    out.hangers = true;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// off-hand gear (bow, shield): rigid on an 'offhand' extra bone. Mesh coordinates are in the parent bone's local
// frame, which equals the character axes in the rest (T) pose: for the left hand / forearm, +X runs along the arm
// toward the fingers, −Y is the palm side, +Z the thumb side.
// ---------------------------------------------------------------------------------------------------------------

/** Frame from local axes (columns) + origin. */
function basis(x, y, z, o = [0, 0, 0]) {
  return new THREE.Matrix4().makeBasis(V(...x), V(...y), V(...z)).setPosition(V(...o));
}

/** Ear points of the recurve bow in the offhand bone's frame (for the live string): [top, bottom]. */
export function bowEars(s = 1) {
  const half = 0.62 * s, tipZ = (0.075 * Math.sin(0.82 * Math.PI) - 0.06) * s;
  // bow frame (0, ±half, tipZ) → bone frame via basis([0,1,0],[0,0,1],[1,0,0]): (z, x, y)
  return [[tipZ, 0, half], [tipZ, 0, -half]];
}

/** Recurve horse bow (角弓), built with the grip at the origin, limbs along ±Y, the belly bowing toward +Z. */
function recurveBow(s = 1) {
  const half = 0.62 * s;
  const limb = (sg) => {
    const pts = [];
    for (let i = 0; i <= 14; i++) {
      const u = i / 14, y = sg * (0.05 + u * (half - 0.05));
      // working limb curves forward, the ears recurve back past the string line
      const z = 0.075 * Math.sin(u * Math.PI * 0.82) - 0.06 * Math.pow(Math.max(0, u - 0.78) / 0.22, 2);
      pts.push([0, y, z]);
    }
    return pts;
  };
  const parts = [];
  for (const sg of [1, -1]) {
    const m = tube(limb(sg), (t) => (0.0125 - 0.0065 * t) * s, { sides: 8, flat: 0.62, up: [1, 0, 0], samples: 28 });
    paint(m, { color: (x, y, z) => scale3([0.16, 0.085, 0.035], 0.75 + 0.5 * vnoise3(x * 90, y * 30, z * 90)), color2: [0.05, 0.03, 0.02], cloth: [0, 0, 1, 1] });
    parts.push(['leather', m]);
  }
  // riser + leather grip wrap
  const riser = tube([[0, -0.07 * s, 0], [0, 0.07 * s, 0]], 0.016 * s, { sides: 10, flat: 0.8, up: [1, 0, 0] });
  paintAll(riser, [0.035, 0.022, 0.016]);
  parts.push(['leather', riser]);
  // the string is drawn live by gameplay (enemy.js bowString) so it can be pulled to the archer's jaw
  return parts;
}

/** Round rattan shield (藤牌): a shallow dome facing +Z, woven rings, a painted crimson rim and an iron boss. */
function rattanShield(s = 1) {
  const R = 0.32 * s, H = 0.07 * s;
  const prof = [];
  for (let i = 0; i <= 12; i++) { const u = i / 12; prof.push([u * R, H * (1 - u * u)]); }
  prof.push([R * 1.02, -0.012 * s], [R * 0.96, -0.02 * s], [0.0, -0.01 * s]);
  const m = latheZ(prof.map(([r, z]) => [r, z]), 40);
  paint(m, {
    color: (x, y, z) => {
      const r = Math.hypot(x, y) / R, a = Math.atan2(y, x);
      const weave = 0.8 + 0.25 * Math.sin(r * 90) * Math.sin(a * 24 + r * 30);
      if (r > 0.88) return [0.24, 0.03, 0.02];                                    // lacquered rim
      if (r > 0.5 && r < 0.56) return [0.03, 0.025, 0.02];                         // black ring
      if (r < 0.2) return [0.3, 0.04, 0.025];                                      // red centre
      return scale3([0.36, 0.26, 0.12], weave * (0.85 + 0.3 * vnoise3(x * 40, y * 40, 0)));
    },
    color2: [0.2, 0.14, 0.07], cloth: [0, 0, 1, 0.9],
  });
  const boss = latheZ([[0.0, H + 0.03 * s], [0.045 * s, H + 0.018 * s], [0.06 * s, H], [0.058 * s, H - 0.01 * s]], 20);
  paintAll(boss, [0.09, 0.085, 0.08]);
  return [['leather', m], ['bronze', boss]];
}

/**
 * @param {'bow'|'shield'} type
 * @returns {{ parent: string, parts: [{mat, mesh}] }}   meshes in the parent bone's local frame
 */
export function buildOffhand(type, { s = 1 } = {}) {
  const out = { type, parent: 'weapon.L', parts: [] };
  if (type === 'bow') {
    // limbs along the thumb (+Z), belly bowing toward the fingers (+X, away from the archer)
    const M = basis([0, 1, 0], [0, 0, 1], [1, 0, 0], [0.0, 0.0, 0.0]);
    for (const [mat, mesh] of recurveBow(s)) { xform(mesh, M); out.parts.push({ mat, mesh }); }
  } else if (type === 'shield') {
    // strapped on the forearm, the face out along the back of the arm (+Y)
    out.parent = 'lowerArm.L';
    const M = basis([1, 0, 0], [0, 0, -1], [0, 1, 0], [0.13 * s, 0.05 * s, 0.0]);
    for (const [mat, mesh] of rattanShield(s)) { xform(mesh, M); out.parts.push({ mat, mesh }); }
  }
  return out;
}

/** Mirror a mesh across y = 0 (normals and winding follow). */
function flipY(m) {
  const P = m.positions, N = m.normals, I = m.indices;
  for (let v = 1; v < P.length; v += 3) { P[v] = -P[v]; N[v] = -N[v]; }
  for (let t = 0; t < I.length; t += 3) { const k = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = k; }
  return m;
}

function paintAll(mesh, color) {
  if (!mesh.extra?.color) paint(mesh, { color, color2: scale3(color, 0.7), cloth: [0, 0, 1, 1] });
  else if (!mesh.extra.color2) paint(mesh, { color2: scale3(color, 0.7), cloth: [0, 0, 1, 1] });
  if (!mesh.extra.cloth) paint(mesh, { cloth: [0, 0, 1, 1] });
  return mesh;
}
export { paintAll };
