// Head wear and hair (owner: character C). Pure geometry, worker-safe.
//   hairCap / hairTail / topknot    black hair: skull cap with a hairline, strand bundles on cloth chains
//   douli                           conical woven bamboo hat (斗笠) with rim roll, finial, headband ring, chin cord
//   ragHat                          torn, smaller straw hat for bandits
//   headwrap / headband             bandit cloth wraps with knot tails (cloth chains)
//   mask                            the swordmaster's lacquer face mask
// Head items are authored in HEAD-LOCAL coordinates at scale 1 (same frame as humanoid.js headPrimitives:
// +y up from the head joint, +z forward) and mapped to bind space with toBind(ctx).
import * as THREE from 'three';
import { BONE_INDEX } from './humanoid.js';
import { ellipsoid, roundCone } from './humanoidSdf.js';
import { COL } from './cloth.js';
import { V, clamp, sstep, mix, vnoise3, inflate, garmentSDF, shell, paint, hem, skinRigid, skinExplicit, sdfAO, tube, lathe, merge, xform } from './outfitsKit.js';
import { ribbon } from './outfits.js';

const TAU = Math.PI * 2;
const scale3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Head-local (scale 1) → bind space matrix. */
export function headMatrix(ctx) {
  return new THREE.Matrix4().compose(ctx.J.head, ctx.bind.Q.head, V(ctx.s, ctx.s, ctx.s));
}
const hp = (ctx, x, y, z) => V(x, y, z).applyMatrix4(headMatrix(ctx));

/** The cranium primitives (head-local), matching humanoid.js. */
function skull() {
  const c = ellipsoid(V(0, 0.074, -0.014), V(0.076, 0.09, 0.097)); c.k = 0;
  const f = ellipsoid(V(0, 0.07, 0.036), V(0.066, 0.056, 0.058)); f.k = 0.03;
  const n = roundCone(V(0, -0.115, -0.022), V(0, 0.02, -0.018), 0.057, 0.052); n.k = 0.03;
  return { c, f, n };
}

// ---------------------------------------------------------------------------------------------------------------
// hair
// ---------------------------------------------------------------------------------------------------------------

/** Skull cap of hair with a hairline. o = { color, t, bun: [y, z, r] | null, hairline: 'natural'|'high' } */
export function hairCap(ctx, o) {
  const { c, f } = skull();
  const t = o.t ?? 0.008;
  const items = [inflate(c, t, 0), inflate(f, t * 0.7, 0.03)];
  if (o.bun) { const b = ellipsoid(V(0, o.bun[0], o.bun[1]), V(o.bun[2], o.bun[2] * 0.85, o.bun[2])); items.push({ d: b.d, k: 0.02 }); }
  // strand grooves: fine ridges flowing back from the hairline
  const disp = (x, y, z) => 0.0012 * Math.sin(Math.atan2(x, y - 0.02) * 60 + z * 40);
  const sdf = garmentSDF(items, 0.02, disp, 0.0015);
  const high = o.hairline === 'high' ? 0.02 : 0;
  const clip = (x, y, z) => {
    // hairline: forehead, temples, above the ears, nape
    const line = z > 0 ? 0.078 + high + 0.34 * z : 0.078 + high + 1.15 * z;
    let cc = line - y;
    const ear = Math.abs(x) > 0.055 && y < 0.075 && z > -0.045 && z < 0.035;
    if (ear) cc = Math.max(cc, 0.004);
    return cc;
  };
  let m = shell({ sdf, box: [V(-0.11, -0.05, -0.14), V(0.11, 0.2, 0.13)], voxel: 0.0055, tris: 3000, clip });
  const ao = sdfAO(m, sdf, { dist: 0.02 });
  paint(m, { color: (x, y, z) => scale3(o.color, 0.85 + 0.3 * vnoise3(x * 60, y * 60, z * 60)), color2: scale3(o.color, 0.6), cloth: (x, y, z, v) => [0.5, 0, 1, ao[v]] });
  m = hem(m, 0.002, 0.004);
  xform(m, headMatrix(ctx));
  skinRigid(m, BONE_INDEX.head);
  ctx.asm.add('hair', m, { uvScale: 12 });
}

/**
 * Hair tail: `strands` flattened tubes on one cloth chain hanging from `root` (head-local). o = { color, root,
 * length, n, strands, width, dir (head-local), name, tie (colour of the binding) }
 */
export function hairTail(ctx, o) {
  const s = ctx.s;
  const root = hp(ctx, ...o.root);
  const n = o.n ?? 8, L = (o.length ?? 0.42) * s;
  const dir = V(...(o.dir ?? [0, -1, -0.22])).normalize();
  // nodes curve slightly away from the back
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const p = root.clone().addScaledVector(dir, L * u);
    p.z -= (o.bow ?? 0.03) * s * Math.sin(u * Math.PI * 0.8);
    nodes.push(p.toArray());
  }
  const c = ctx.rig.chain({
    name: o.name ?? 'hair', parent: 'head', nodes, pin: [1, 0.3], side: [1, 0, 0], radius: o.radius ?? 0.018,
    mask: COL.TORSO | COL.HEAD, drag: 1.4, stiff: 0.45, flutter: 0.6, gravity: 1,
  });
  const pts = nodes.map(p => V(...p));
  const parts = [];
  const nS = o.strands ?? 3;
  for (let k = 0; k < nS; k++) {
    const off = (k - (nS - 1) / 2);
    const sp = pts.map((p, i) => { const u = i / (n - 1); return [p.x + off * 0.011 * s * (1 + u * 0.8) + Math.sin(u * 5 + k) * 0.003 * s, p.y - Math.abs(off) * 0.01 * s * u, p.z - 0.004 * s * Math.cos(k * 2.1)]; });
    const len = 1 - Math.abs(off) * 0.12;
    const cut = sp.slice(0, Math.max(3, Math.round(n * len)));
    const m = tube(cut, (t) => (o.width ?? 0.012) * s * (1 - t * 0.78) * (t < 0.05 ? 0.8 + t * 4 : 1), { sides: 6, flat: 0.55, up: [0, 0, 1], samples: cut.length * 4, caps: true, twist: 0.8 * off });
    parts.push(m);
  }
  // binding at the root
  const ringPts = [];
  for (let i = 0; i <= 12; i++) { const a = i / 12 * TAU; ringPts.push([root.x + Math.sin(a) * 0.013 * s, root.y - 0.012 * s + Math.cos(a) * 0.004 * s, root.z + Math.cos(a) * 0.009 * s]); }
  const tie = tube([[root.x, root.y + 0.004 * s, root.z], [root.x, root.y - 0.028 * s, root.z - 0.004 * s]], 0.0125 * s, { sides: 8, caps: true });
  paint(tie, { color: o.tie ?? [0.02, 0.018, 0.02], color2: o.tie ?? [0.02, 0.018, 0.02], cloth: [0, 0, 1, 0.9] });
  const m = merge(parts);
  paint(m, { color: (x, y, z) => scale3(o.color, 0.8 + 0.4 * vnoise3(x * 90, y * 20, z * 90)), color2: scale3(o.color, 0.7), cloth: [0.6, 1, 1, 1] });
  // weights: along the chain by projected parameter
  const P0 = pts[0];
  skinExplicit(m, (x, y, z) => {
    // nearest segment
    let best = 1e9, bi = 0, bt = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
      const t = clamp(((x - a.x) * bx + (y - a.y) * by + (z - a.z) * bz) / (bx * bx + by * by + bz * bz), 0, 1);
      const d = Math.hypot(x - a.x - bx * t, y - a.y - by * t, z - a.z - bz * t);
      if (d < best) { best = d; bi = i; bt = t; }
    }
    return [[c.bone0 + bi, 1 - bt], [c.bone0 + bi + 1, bt]];
  });
  ctx.asm.add('hair', m, { uvScale: 20 });
  skinRigid(tie, BONE_INDEX.head);
  ctx.asm.add('cloth', tie, { uvScale: 20 });
  return c;
}

// ---------------------------------------------------------------------------------------------------------------
// douli (斗笠)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Conical woven bamboo hat on the 'hat' bone. o = { R, h, color, rim, torn (0..1 ragged rim), cord: colour|null,
 * tilt: [x, z] radians, y (hat-local offset) }
 */
export function douli(ctx, o) {
  const s = ctx.s;
  const R = o.R ?? 0.3, h = o.h ?? 0.135, yRim = o.yRim ?? -0.058, p = o.p ?? 1.25;
  const apex = yRim + h;
  const topY = (r) => apex - h * Math.pow(r / R, p);
  const thick = (r) => 0.011 - 0.004 * (r / R);
  const prof = [];
  const NR = 15;
  // underside from the axis outward, rim roll, top from the rim to the apex
  for (let i = 0; i <= NR; i++) { const r = 0.012 + (R - 0.012) * (i / NR); prof.push([r, topY(r) - thick(r)]); }
  const rr = 0.0065;
  for (let i = 1; i < 6; i++) { const a = -Math.PI / 2 + i / 6 * Math.PI; prof.push([R + rr * 0.6 + Math.cos(a) * rr, topY(R) - thick(R) * 0.5 + Math.sin(a) * rr]); }
  for (let i = NR; i >= 0; i--) { const r = 0.012 + (R - 0.012) * (i / NR); prof.push([r, topY(r)]); }
  const nUnder = NR + 1, nRoll = 5;
  const SEG = 72;
  let m = lathe(prof, SEG, { uRep: 3 });
  // uv: v = radius (rings), u = around
  const P = m.positions;
  for (let v = 0; v < P.length / 3; v++) { const r = Math.hypot(P[v * 3], P[v * 3 + 2]); m.uvs[v * 2 + 1] = r / R * 1.0; }
  // ragged rim for torn hats: pull random sectors of the brim inward
  if (o.torn) {
    for (let v = 0; v < P.length / 3; v++) {
      const x = P[v * 3], z = P[v * 3 + 2], r = Math.hypot(x, z);
      if (r < R * 0.6) continue;
      const a = Math.atan2(x, z);
      const tear = Math.max(0, vnoise3(Math.cos(a) * 4, Math.sin(a) * 4, 3.3) - 0.55) * 2.2 * o.torn * sstep(R * 0.6, R, r);
      const k = 1 - tear * 0.25;
      P[v * 3] *= k; P[v * 3 + 2] *= k; P[v * 3 + 1] -= tear * 0.012;
    }
  }
  const straw = o.color ?? [1.25, 1.2, 1.1];
  paint(m, {
    color: (x, y, z, v) => {
      const r = Math.hypot(x, z) / R;
      const row = Math.floor(v / (SEG + 1));
      const under = row < nUnder, roll = row >= nUnder && row < nUnder + nRoll;
      if (roll) return o.rim ?? [0.16, 0.1, 0.05];
      const age = 0.8 + 0.2 * sstep(0.1, 0.9, r) + 0.1 * (vnoise3(x * 30, z * 30, 1) - 0.5);
      return scale3(straw, under ? age * 0.62 : age);
    },
    color2: scale3(straw, 0.5),
    cloth: (x, y, z, v) => { const row = Math.floor(v / (SEG + 1)); return [1, 0, 1, row < nUnder ? 0.6 + 0.4 * sstep(0.2, 1, Math.hypot(x, z) / R) : 1]; },
  });
  // finial at the apex
  const fin = lathe([[0.0, apex + 0.03], [0.008, apex + 0.028], [0.013, apex + 0.02], [0.012, apex + 0.012], [0.017, apex + 0.004], [0.02, apex - 0.004]], 16);
  paint(fin, { color: o.rim ?? [0.16, 0.1, 0.05], color2: [0.1, 0.06, 0.03], cloth: [0, 0, 1, 1] });
  // headband ring inside the crown
  const band = lathe([[0.086, -0.052], [0.088, -0.04], [0.087, -0.026]], 32, { uRep: 4 });
  for (let v = 0; v < band.positions.length / 3; v++) band.positions[v * 3 + 2] *= 1.17;
  paint(band, { color: [0.06, 0.045, 0.03], color2: [0.04, 0.03, 0.02], cloth: [0, 0, 1, 0.6] });
  const hat = merge([m, fin, band]);
  // hat-local → bind (hat bone), optional tilt
  const T = new THREE.Matrix4().compose(ctx.J.hat.clone().add(V(0, (o.y ?? 0) * s, 0)), new THREE.Quaternion().setFromEuler(new THREE.Euler(o.tilt?.[0] ?? 0, 0, o.tilt?.[1] ?? 0)), V(s, s, s));
  xform(hat, T);
  skinRigid(hat, BONE_INDEX.hat);
  ctx.asm.add('straw', hat);
  // chin cord (head-local)
  if (o.cord) {
    const path = [[0.08, 0.098, 0.0], [0.081, 0.05, 0.012], [0.071, -0.005, 0.036], [0.044, -0.05, 0.063], [0.0, -0.068, 0.072], [-0.044, -0.05, 0.063], [-0.071, -0.005, 0.036], [-0.081, 0.05, 0.012], [-0.08, 0.098, 0.0]];
    const cm = tube(path, 0.0022, { sides: 5, samples: 40, caps: false });
    const bead = tube([[0, -0.068, 0.072], [0, -0.09, 0.07]], (t) => 0.004 * (1 - t * 0.5), { sides: 6 });
    const cc = merge([cm, bead]);
    paint(cc, { color: o.cord, color2: o.cord, cloth: [0, 0, 1, 0.8] });
    xform(cc, headMatrix(ctx));
    skinRigid(cc, BONE_INDEX.head);
    ctx.asm.add('cloth', cc, { uvScale: 30 });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// bandit headwear
// ---------------------------------------------------------------------------------------------------------------

/** Cloth head wrap covering the skull, knotted at the back with two short tails. o = { color, tails, name } */
export function headwrap(ctx, o) {
  const { c, f } = skull();
  const items = [inflate(c, 0.017, 0), inflate(f, 0.014, 0.03)];
  const knot = ellipsoid(V(0, 0.06, -0.12), V(0.028, 0.024, 0.022)); items.push({ d: knot.d, k: 0.015 });
  const disp = (x, y, z) => 0.003 * Math.sin(Math.atan2(x, z) * 7 + y * 40) + 0.002 * Math.sin(y * 110 + x * 30);
  const sdf = garmentSDF(items, 0.02, disp, 0.005);
  const clip = (x, y, z) => (z > -0.02 ? 0.082 + 0.22 * z - y : 0.03 + 0.4 * (z + 0.02) - y) + (Math.abs(x) > 0.06 && y < 0.07 && z > -0.04 && z < 0.04 ? 0.005 : 0);
  let m = shell({ sdf, box: [V(-0.12, -0.03, -0.16), V(0.12, 0.21, 0.14)], voxel: 0.006, tris: 2600, clip });
  const ao = sdfAO(m, sdf, { dist: 0.025 });
  paint(m, { color: (x, y, z) => scale3(o.color, 0.85 + 0.3 * vnoise3(x * 30, y * 30, z * 30)), color2: scale3(o.color, 0.6), cloth: (x, y, z, v) => [0.6, 0, 1, ao[v]] });
  m = hem(m, 0.003, 0.008);
  xform(m, headMatrix(ctx));
  skinRigid(m, BONE_INDEX.head);
  ctx.asm.add('cloth', m, { uvScale: 5 });
  if (o.tails) {
    for (let i = 0; i < 2; i++) {
      const start = hp(ctx, (i ? 1 : -1) * 0.012, 0.05, -0.135);
      ribbon(ctx, {
        name: `${o.name ?? 'wrap'}Tail${i}`, parent: 'head', start, dir: V((i ? 1 : -1) * 0.25, -1, -0.35).normalize(), length: (o.tails[i] ?? 0.2) * ctx.s,
        n: 5, width: 0.045 * ctx.s, side: V(1, 0, 0), color: o.color, mask: COL.TORSO | COL.HEAD, radius: 0.015, drag: 2.2, flutter: 1, fringe: false, taper: 0.4,
      });
    }
  }
}

/** Forehead band (抹额) with optional tails. o = { color, width, tails, name } */
export function headband(ctx, o) {
  const { c, f } = skull();
  const items = [inflate(c, 0.006, 0), inflate(f, 0.006, 0.03)];
  const sdf = garmentSDF(items, 0.02);
  const w = o.width ?? 0.03;
  const lineY = (z) => (z > 0 ? 0.085 + 0.2 * z : 0.085 + 0.25 * z);
  const clip = (x, y, z) => Math.abs(y - lineY(z)) - w * 0.5;
  let m = shell({ sdf, box: [V(-0.11, 0.0, -0.14), V(0.11, 0.17, 0.13)], voxel: 0.004, tris: 1500, clip });
  // push the band out a little so it sits on the hair/skin
  const P = m.positions, N = m.normals;
  for (let v = 0; v < P.length; v += 3) { P[v] += N[v] * 0.004; P[v + 1] += N[v + 1] * 0.004; P[v + 2] += N[v + 2] * 0.004; }
  paint(m, { color: (x, y, z) => scale3(o.color, 0.9 + 0.2 * vnoise3(x * 40, y * 40, z * 40)), color2: scale3(o.color, 0.6), cloth: [0.5, 0, 1, 1] });
  m = hem(m, 0.002, 0.005);
  xform(m, headMatrix(ctx));
  skinRigid(m, BONE_INDEX.head);
  ctx.asm.add('cloth', m, { uvScale: 6 });
  if (o.tails) {
    for (let i = 0; i < 2; i++) {
      const start = hp(ctx, (i ? 1 : -1) * 0.01, lineY(-0.11), -0.112);
      ribbon(ctx, {
        name: `${o.name ?? 'band'}Tail${i}`, parent: 'head', start, dir: V((i ? 1 : -1) * 0.2, -1, -0.4).normalize(), length: (o.tails[i] ?? 0.3) * ctx.s,
        n: 6, width: w * ctx.s, side: V(1, 0, 0), color: o.color, mask: COL.TORSO | COL.HEAD, radius: 0.012, drag: 2.4, flutter: 1.1, fringe: false, taper: 0.2,
      });
    }
  }
}

/** Topknot: bun on the crown with a pin (and a crown cap for the swordmaster). o = { color, cap, pin } */
export function topknot(ctx, o) {
  const bun = ellipsoid(V(0, 0.19, -0.02), V(0.026, 0.03, 0.028));
  const sdf = garmentSDF([{ d: bun.d, k: 0 }], 0.01, (x, y, z) => 0.0015 * Math.sin(Math.atan2(x, z) * 16 + y * 80), 0.002);
  let m = shell({ sdf, box: [V(-0.05, 0.14, -0.07), V(0.05, 0.24, 0.03)], voxel: 0.004, tris: 900 });
  paint(m, { color: o.color, color2: o.color, cloth: [0.5, 0, 1, 0.9] });
  const parts = [m];
  xform(m, headMatrix(ctx));
  skinRigid(m, BONE_INDEX.head);
  ctx.asm.add('hair', m, { uvScale: 20 });
  if (o.cap) {
    const cap = lathe([[0.0, 0.232], [0.016, 0.23], [0.026, 0.215], [0.03, 0.19], [0.028, 0.175]], 16);
    xform(cap, new THREE.Matrix4().makeTranslation(0, 0, -0.02));
    paint(cap, { color: o.cap, color2: o.cap, cloth: [0, 0, 1, 1] });
    xform(cap, headMatrix(ctx)); skinRigid(cap, BONE_INDEX.head);
    ctx.asm.add(o.capMat ?? 'lacquer', cap);
  }
  if (o.pin) {
    const pin = tube([[-0.06, 0.205, -0.02], [0.06, 0.2, -0.02]], (t) => 0.0025 * (1 - 0.5 * t), { sides: 6 });
    paint(pin, { color: o.pin, color2: o.pin, cloth: [0, 0, 1, 1] });
    xform(pin, headMatrix(ctx)); skinRigid(pin, BONE_INDEX.head);
    ctx.asm.add('bronze', pin);
  }
  return parts;
}

/** Lacquer face mask with eye slits (head-local). o = { color, pattern, mat } */
export function mask(ctx, o) {
  // face surface: inflate the head's facial primitives
  const items = [];
  const add = (p, k) => items.push({ d: p.d, k });
  add(ellipsoid(V(0, 0.07, 0.036), V(0.07, 0.06, 0.066)), 0);
  add(ellipsoid(V(0, 0.01, 0.07), V(0.062, 0.06, 0.05)), 0.03);
  add(ellipsoid(V(0, -0.035, 0.072), V(0.045, 0.035, 0.035)), 0.03);
  add(roundCone(V(0, 0.046, 0.1), V(0, 0.008, 0.118), 0.012, 0.016), 0.02);
  for (const sx of [1, -1]) add(ellipsoid(V(sx * 0.05, 0.02, 0.064), V(0.03, 0.03, 0.03)), 0.03);
  const disp = (x, y, z) => 0.003 * Math.exp(-((Math.abs(x) - 0.03) ** 2 + (y - 0.058) ** 2) / 0.0004); // brow ridges
  const sdf = garmentSDF(items, 0.02, (x, y, z) => 0.012 + disp(x, y, z), 0.016);
  const clip = (x, y, z) => {
    let c = Math.max(0.035 - z, y - 0.105, -0.075 - y);
    const eye = ((Math.abs(x) - 0.033) / 0.02) ** 2 + ((y - 0.036 + 0.004 * Math.abs(x) * 20) / 0.0085) ** 2 - 1;
    return Math.max(c, -eye * 0.01);
  };
  let m = shell({ sdf, box: [V(-0.1, -0.1, 0.0), V(0.1, 0.13, 0.15)], voxel: 0.0035, tris: 2200, clip });
  paint(m, {
    color: (x, y, z) => {
      const line = Math.exp(-((Math.abs(x) - 0.045 - 0.25 * (y - 0.02)) ** 2) / 0.00002) * sstep(0.08, 0.0, y) * sstep(-0.06, -0.02, y);
      const mouth = Math.exp(-((y + 0.022) ** 2) / 0.00001) * sstep(0.03, 0.0, Math.abs(x));
      return mix3(o.color, o.pattern ?? [0.35, 0.02, 0.015], Math.min(1, line + mouth));
    },
    color2: [0.05, 0.03, 0.02], cloth: [0, 0, 1, 1],
  });
  m = hem(m, 0.003, 0.004);
  xform(m, headMatrix(ctx));
  skinRigid(m, BONE_INDEX.head);
  ctx.asm.add(o.mat ?? 'lacquer', m);
}

/** Short beard / moustache shell for the heavy bandit. o = { color } */
export function beard(ctx, o) {
  const items = [];
  items.push({ d: ellipsoid(V(0, -0.045, 0.07), V(0.04, 0.032, 0.03)).d, k: 0 });
  for (const sx of [1, -1]) items.push({ d: roundCone(V(sx * 0.058, 0.01, 0.0), V(sx * 0.022, -0.047, 0.07), 0.021, 0.018).d, k: 0.02 });
  items.push({ d: roundCone(V(-0.02, -0.012, 0.102), V(0.02, -0.012, 0.102), 0.007, 0.007).d, k: 0.015 });
  const disp = (x, y, z) => 0.004 + 0.002 * Math.sin(x * 300 + y * 50) + 0.003 * (vnoise3(x * 80, y * 80, z * 80) - 0.5);
  const sdf = garmentSDF(items, 0.02, disp, 0.008);
  const clip = (x, y, z) => Math.max(y - (z > 0.08 ? 0.0 : 0.02), -0.1 - y, -z - 0.01, -(Math.abs(y + 0.012) > 0.009 || Math.abs(x) > 0.026 || z < 0.09 ? 1 : -1) * 0 - 0.0);
  let m = shell({ sdf, box: [V(-0.1, -0.11, -0.03), V(0.1, 0.05, 0.13)], voxel: 0.004, tris: 1600, clip });
  paint(m, { color: (x, y, z) => scale3(o.color, 0.7 + 0.5 * vnoise3(x * 120, y * 120, z * 120)), color2: o.color, cloth: [0.4, 0, 1, 0.85] });
  xform(m, headMatrix(ctx));
  skinRigid(m, BONE_INDEX.head);
  ctx.asm.add('hair', m, { uvScale: 20 });
}
