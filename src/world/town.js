// 长街灯火 — the Jiangnan market town of level 3 (levels/town.js, LAYOUT.town): two rows of timber-and-plaster
// shophouses along the lantern-lit street, the plaza with the opera stage 戲臺 and the two memorial archways 牌坊,
// the canal with its stone embankments, quays and the arched bridge, canal-side houses, back rows for the skyline,
// stalls, jars, banners, and some four hundred paper lanterns swaying in the wind. Owner: world (W).
//
//   const town = await createTown(app, { town: LAYOUT.town })   (registers itself with app.add)
//     → { root, colliders, lanterns: [{pos: Vector3, kind}], eaves: [{x, y, z, yaw, storeys}], waterY,
//         paved(x, z), built(x, z), covered(x, z), update(dt), stats(), dispose() }
//   eaves      front-eave anchor per street/plaza/canal house (roof-top spawns: spawn.eaves)
//   paved      street / plaza / alley paving · built: under a house block · covered: paved|built|canal band
//              (e.g. grass / flower / citizen keep-out masks)
//   colliders  [{x, z, r}] also pushed into app.world.colliders and app.world.addBlocker (houses: rows of r 2.5
//              circles that fill each block; stalls, stage, archway pillars, bridge parapets, both canal edges)
//   Shared uniforms added to G (town-mat.js): G.tTownLight (R16F baked lantern/shop light field),
//   G.uTownRect (x0, z0, 1/w, 1/d), G.uTownLightCol — other modules (citizens, fx) may sample them.
//
// Draw calls: building · stone · tiles · misc · signs/cloth · paving · water · lanterns (instanced) = 8
// (+ 4 casters in the far sun shadow map when it refreshes). Static: nothing is rebuilt per frame.
import * as THREE from 'three';
import { G, LAYERS } from '../core/globals.js';
import { loadPBR } from '../core/assets.js';
import { mulberry32 } from '../core/noise.js';
import { lamps } from '../core/lamps.js';
import { LAYOUT } from './layout.js';
import { buildAxis } from './terrain-field.js';
import { Builder } from './town-geo.js';
import * as M from './town-mat.js';
import * as A from './town-arch.js';

const LANTERN_KINDS = [
  { R: 0.2, H: 0.34, b: 2.3, light: 0.8 },      // 0 small round (strings, eaves)
  { R: 0.27, H: 0.6, b: 2.7, light: 1.6 },      // 1 shop-front 冬瓜燈
  { R: 0.42, H: 0.82, b: 3.0, light: 2.8 },     // 2 palace lantern (stage, archways)
];

export async function createTown(app, opts = {}) {
  const t0 = performance.now();
  const T = opts.town ?? LAYOUT.town;
  if (!T) throw new Error('createTown: no LAYOUT.town (load with ?level=town)');
  const heightAt = app.world.heightAt;
  const rnd = mulberry32(90210);
  const K = { w: new Builder(), s: new Builder(), t: new Builder(), m: new Builder(), g: new Builder() };
  const hooks = [], lights = [], colliders = [];
  const SX0 = T.street.x0, SX1 = T.street.x1, FR = T.frontage, DEP = T.depth;
  const PL = T.plaza, CA = T.canal, BR = T.bridge;
  const PHX = PL.w / 2 + 4;                        // street rows start this far from the plaza centre
  const WALL_DX = CA.width / 2 + 0.8, QUAY_DX = CA.width / 2 + 2.7;   // canal wall / quay outer edge from the canal axis
  const ALLEY = 1.4;

  // ------------------------------------------------------------------ colliders
  const addC = (x, z, r, h) => colliders.push(h === undefined ? { x: +x.toFixed(2), z: +z.toFixed(2), r } : { x: +x.toFixed(2), z: +z.toFixed(2), r, h });
  /** Fill a rectangular block (facade line → back) with r-circles: sealed front/back/ends, scallops ≤ ~0.15 m. */
  function blockColliders(ax, az, ux, uz, len, depth) {
    // (ax, az) facade start, (ux, uz) unit along the facade, inward normal = (−uz, ux) rotated toward the block
    const r = 2.5, e = 0.35, s = 3.0;
    const nx = -uz, nz = ux;                       // caller passes u so that n points into the block
    const rows = depth > 2 * (r - e) ? [r - e, depth - (r - e)] : [depth / 2];
    const n = Math.max(1, Math.round((len - 2 * (r - e)) / s));
    for (const d of rows) for (let k = 0; k <= n; k++) {
      const t = len <= 2 * (r - e) ? len / 2 : (r - e) + ((len - 2 * (r - e)) * k) / n;
      addC(ax + ux * t + nx * d, az + uz * t + nz * d, r, 9);
    }
  }

  // ------------------------------------------------------------------ house placement
  let signI = 0, bannerI = 0;
  const footY = (cx, cz, yaw, W, D) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let hi = -Infinity, lo = Infinity;
    for (const [lx, lz] of [[-W / 2, 0.4], [0, 0.4], [W / 2, 0.4], [-W / 2, -D], [W / 2, -D], [0, -D / 2]]) {
      const h = heightAt(cx + lx * c + lz * s, cz - lx * s + lz * c);
      if (lz > 0) hi = Math.max(hi, h);
      lo = Math.min(lo, h);
    }
    return { y: hi + 0.14, lo };
  };
  function makeSpec(W, style, gable, extra = {}) {
    const st = style === 'back' ? (rnd() < 0.45 ? 2 : 1) : (rnd() < 0.62 ? 2 : 1);
    const pent = st === 2 && style !== 'back' && rnd() < 0.62;
    const jet = st === 2 && !pent && style !== 'back' && rnd() < 0.6 ? 0.45 : 0;
    const nb = Math.max(1, Math.round(W / 2.1));
    const bays = [];
    for (let k = 0; k < nb; k++) {
      const r = rnd();
      if (style === 'street') bays.push(r < 0.45 ? 'open' : r < 0.62 ? 'boards' : r < 0.86 ? 'lattice' : 'wall');
      else if (style === 'canal') bays.push(r < 0.3 ? 'door' : r < 0.55 ? 'lattice' : r < 0.7 ? 'open' : 'wall');
      else bays.push(r < 0.35 ? 'door' : 'wall');
    }
    if (style === 'street' && !bays.includes('open') && rnd() < 0.6) bays[Math.floor(nb / 2)] = 'open';
    const shop = bays.includes('open');
    const upperR = rnd();
    return {
      W, D: extra.D ?? DEP, st, H1: 3.1 + rnd() * 0.4, H2: 2.55 + rnd() * 0.35, pent, jet, balcony: jet > 0 && rnd() < 0.7,
      ov: 0.9 + rnd() * 0.3, rise: (st === 2 ? 1.8 : 1.55) + rnd() * 0.45, style, bays,
      upper: upperR < 0.55 ? 'lattice' : upperR < 0.85 ? 'plaster' : 'boards',
      wall: rnd() < 0.68 ? 'plaster' : 'boards', gable, corr: style !== 'back', sd: rnd(),
      ridge: style === 'back' ? 'plain' : ['curl', 'curl', 'bird', 'plain'][Math.floor(rnd() * 4)],
      lift: 0.15 + rnd() * 0.18, ridgeShift: (rnd() - 0.5) * 0.6,
      sign: style === 'street' && shop && rnd() < 0.65 ? 'sign' + (signI++ % 8) : null,
      banner: style === 'street' && shop && rnd() < 0.5 ? 'banner' + (bannerI++ % 10) : null, bannerSide: rnd() < 0.5 ? -1 : 1,
      lanterns: style === 'street' ? shop || rnd() < 0.35 : style === 'canal' ? rnd() < 0.55 : false,
      lanternKind: 1, lanternChar: rnd() < 0.55 ? Math.floor(rnd() * 8) : -1,
      eaveString: style !== 'back' && st === 2 && !pent && rnd() < 0.55,
      ...extra,
    };
  }
  const houses = [];
  /** A row of houses along a facade line. (x0, z0) → (x1, z1) in world, yaw = facing; style; end gables. */
  const blocks = [];   // built footprints: facade start (x, z), unit u along it, inward n, length, depth
  function row(xa, za, xb, zb, yaw, style, opt = {}) {
    const len = Math.hypot(xb - xa, zb - za), ux = (xb - xa) / len, uz = (zb - za) / len;
    blocks.push({ x: xa, z: za, ux, uz, nx: -Math.sin(yaw), nz: -Math.cos(yaw), len, d: opt.D ?? DEP });
    // split into 4–7 m houses
    const ws = [];
    let rem = len;
    while (rem > 0.01) {
      let w = opt.fixedW ?? (style === 'back' ? 5 + rnd() * 3 : 4 + rnd() * 3);
      if (rem - w < 3.6) w = rem < 7.8 ? rem : rem / 2;
      ws.push(w); rem -= w;
    }
    let acc = 0;
    ws.forEach((W, i) => {
      const cx = xa + ux * (acc + W / 2), cz = za + uz * (acc + W / 2);
      acc += W;
      // local +x (right, facing the facade) must run along u for the gables to sit at the run ends
      const lx = Math.cos(yaw), lz = -Math.sin(yaw);
      const flip = lx * ux + lz * uz < 0;
      const first = i === 0, last = i === ws.length - 1;
      const endG = () => (rnd() < 0.6 ? 'horse' : 'plain');
      let gl = 'plain', gr = 'plain';
      if (style !== 'back') { if (first) (flip ? (gr = endG()) : (gl = endG())); if (last) (flip ? (gl = endG()) : (gr = endG())); }
      const spec = makeSpec(W, style, [gl, gr], opt.spec?.(i, ws.length) ?? {});
      const { y, lo } = footY(cx, cz, yaw, W, spec.D);
      spec.found = y - lo + 0.45;
      houses.push({ cx, cz, y, yaw, spec });
    });
    if (opt.collide !== false) {
      // inward normal must point into the block: (−uz, ux) · facing < 0
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      let ax = xa, az = za, vx = ux, vz = uz;
      if (-vz * fx + vx * fz > 0) { ax = xb; az = zb; vx = -ux; vz = -uz; }
      blockColliders(ax, az, vx, vz, len, opt.D ?? DEP);
    }
  }

  // street rows: runs between the plaza, the canal quays and the alleys
  const gaps = [[PL.x - PHX, PL.x + PHX], [CA.x - QUAY_DX, CA.x + QUAY_DX], ...T.alleys.map((a) => [a - ALLEY, a + ALLEY])].sort((a, b) => a[0] - b[0]);
  const runs = [];
  let cur = SX0;
  for (const [g0, g1] of gaps) { if (g0 > cur + 3) runs.push([cur, Math.min(g0, SX1)]); cur = Math.max(cur, g1); }
  if (SX1 > cur + 3) runs.push([cur, SX1]);
  for (const [a, b] of runs) {
    row(a, -FR, b, -FR, 0, 'street');                    // north side, facing +z
    row(b, FR, a, FR, Math.PI, 'street');                // south side, facing −z
  }
  // plaza rows: south (teahouse opposite the stage), north (split by the stage)
  const PZ = PL.d / 2;
  row(PL.x + PHX, PZ, PL.x + 5, PZ, Math.PI, 'street');
  row(PL.x + 5, PZ, PL.x - 5, PZ, Math.PI, 'street', { fixedW: 10, spec: () => ({ st: 2, pent: false, jet: 0.6, balcony: true, H1: 3.5, H2: 3.0, rise: 2.4, upper: 'lattice', bays: ['open', 'lattice', 'open', 'lattice', 'open'], sign: 'sign5', lanterns: true, eaveString: true, lanternKind: 1, lanternChar: 1, ridge: 'bird', corr: true }) });
  row(PL.x - 5, PZ, PL.x - PHX, PZ, Math.PI, 'street');
  const SG = T.stage;
  row(PL.x - PHX, -PZ, SG.x - 6.9, -PZ, 0, 'street');
  row(SG.x + 6.9, -PZ, PL.x + PHX, -PZ, 0, 'street');
  // canal-side rows (facing the water across the quay), with an alley every so often
  const CZ0 = FR + DEP, CZ1 = 64;
  for (const sz of [-1, 1]) {
    const segs = [[CZ0, 29], [31.6, CZ1]];
    for (const [z0, z1] of segs) {
      row(CA.x - QUAY_DX, sz * (sz > 0 ? z1 : z0), CA.x - QUAY_DX, sz * (sz > 0 ? z0 : z1), Math.PI / 2, 'canal', { D: 8, spec: () => ({ D: 8 }) });
      row(CA.x + QUAY_DX, sz * (sz > 0 ? z0 : z1), CA.x + QUAY_DX, sz * (sz > 0 ? z1 : z0), -Math.PI / 2, 'canal', { D: 8, spec: () => ({ D: 8 }) });
    }
  }
  // back rows (skyline): behind the street rows, then across a back lane (unreachable: no colliders)
  const canalBand = [CA.x - QUAY_DX - 8.2, CA.x + QUAY_DX + 8.2];
  const backRuns = (from, to) => {
    const out = [];
    let c = from;
    for (const [g0, g1] of [canalBand]) { if (g0 > c + 4) out.push([c, Math.min(to, g0)]); c = Math.max(c, g1); }
    if (to > c + 4) out.push([c, to]);
    return out;
  };
  for (const [a, b] of [...backRuns(SX0, PL.x - PHX), ...backRuns(PL.x + PHX, SX1)]) {
    row(b, -(FR + 2 * DEP), a, -(FR + 2 * DEP), Math.PI, 'back', { collide: false });
    row(a, FR + 2 * DEP, b, FR + 2 * DEP, 0, 'back', { collide: false });
  }
  for (const [a, b] of backRuns(SX0 + 6, SX1 - 6)) {
    row(a, -(FR + 2 * DEP + 4), b, -(FR + 2 * DEP + 4), 0, 'back', { collide: false, D: 8, spec: () => ({ D: 8 }) });
    row(b, FR + 2 * DEP + 4, a, FR + 2 * DEP + 4, Math.PI, 'back', { collide: false, D: 8, spec: () => ({ D: 8 }) });
  }

  const eaves = [];
  for (const h of houses) {
    A.setFrame(K, h.cx, h.y, h.cz, h.yaw);
    const out = { hooks, lights };
    const h0 = hooks.length;
    A.shophouse(K, h.spec, rnd, out);
    for (let k = h0; k < hooks.length; k++) hooks[k].yaw ??= h.yaw;
    h.front = out.front;
    if (h.spec.style !== 'back') {   // eave anchors (front eave line, local centre) for roof-top spawns / cameras
      const c = Math.cos(h.yaw), sn = Math.sin(h.yaw), zE = out.front.zEf - 0.3;
      eaves.push({ x: h.cx + zE * sn, y: h.y + out.front.yE + 0.25, z: h.cz + zE * c, yaw: h.yaw, storeys: h.spec.st });
    }
    // wine jars / baskets at some shop fronts (street side only, off the plaza fighting ground)
    if (h.spec.style === 'street' && out.shop && Math.abs(h.cx - PL.x) > PHX && rnd() < 0.3) {
      const side = rnd() < 0.5 ? -1 : 1, lx = side * (h.spec.W / 2 - 0.9);
      A.setFrame(K, h.cx + lx * Math.cos(h.yaw) + 0.55 * Math.sin(h.yaw), h.y - 0.02, h.cz - lx * Math.sin(h.yaw) + 0.55 * Math.cos(h.yaw), h.yaw);
      A.jars(K, rnd, 2 + Math.floor(rnd() * 3));
      addC(K.m.ox, K.m.oz, 0.75);
    }
  }

  // ------------------------------------------------------------------ opera stage + backstage
  let stageStrings = null;
  {
    const gy = heightAt(SG.x, SG.z);
    A.setFrame(K, SG.x, gy, SG.z, SG.yaw);
    const out = { hooks, lights };
    const h0 = hooks.length;
    A.operaStage(K, SG, out);
    for (let k = h0; k < hooks.length; k++) hooks[k].yaw ??= SG.yaw;
    stageStrings = out.stringFrom;
    const c = Math.cos(SG.yaw), s = Math.sin(SG.yaw);
    const L = (lx, lz) => [SG.x + lx * c + lz * s, SG.z - lx * s + lz * c];
    for (let x = -4.6; x <= 4.61; x += 1.53) { const [px, pz] = L(x, 4.0); addC(px, pz, 0.9); }
    for (const sx of [-1, 1]) for (let z = -3.2; z <= 3.21; z += 1.6) { const [px, pz] = L(sx * 4.8, z); addC(px, pz, 0.9); }
    const [bx, bz] = L(0, -8.5);
    const bs = makeSpec(13.6, 'back', ['horse', 'horse'], { st: 2, D: 6 });
    const f = footY(bx, bz, SG.yaw + Math.PI, 13.6, 6);
    bs.found = f.y - f.lo + 0.45;
    A.setFrame(K, bx, f.y, bz - 3.0 * c, SG.yaw + Math.PI);
    A.shophouse(K, { ...bs, D: 6 }, rnd, { hooks: [], lights: [] });
  }
  // ------------------------------------------------------------------ memorial archways
  T.paifang.forEach((P, i) => {
    const gy = Math.min(heightAt(P.x, P.z - 5), heightAt(P.x, P.z), heightAt(P.x, P.z + 5));
    A.setFrame(K, P.x, gy, P.z, P.yaw);
    const west = P.x < PL.x;
    const h0 = hooks.length;
    A.paifang(K, { front: west ? 'plaque0' : 'plaque3', back: west ? 'plaque3' : 'plaque1' }, { hooks, lights });
    for (let k = h0; k < hooks.length; k++) hooks[k].yaw ??= P.yaw;
    const c = Math.cos(P.yaw), s = Math.sin(P.yaw);
    for (const lx of [-5.6, -2.9, 2.9, 5.6]) addC(P.x + lx * c, P.z - lx * s, 0.62, 7.5);
  });

  // ------------------------------------------------------------------ canal, quays, bridge, boats
  let waterY = Infinity, bedY = Infinity;
  for (let z = -110; z <= 110; z += 4) {
    if (Math.abs(z) < 6) continue;
    waterY = Math.min(waterY, heightAt(CA.x - QUAY_DX - 0.2, z), heightAt(CA.x + QUAY_DX + 0.2, z));
    bedY = Math.min(bedY, heightAt(CA.x, z));
  }
  waterY -= 1.25; bedY -= 0.3;
  const groundAt = (x, z) => heightAt(x + Math.sign(x - CA.x) * 0.3, z);
  A.canalBanks(K, {
    x: CA.x, wallDx: WALL_DX, quayDx: QUAY_DX, z0: 5.9, z1: 112, waterY, bedY, groundAt,
    steps: [{ side: -1, z: 18.5, dir: 1 }, { side: 1, z: -24, dir: -1 }, { side: 1, z: 40, dir: 1 }, { side: -1, z: -44, dir: -1 }],
  });
  { const h0 = hooks.length;
    A.bridge(K, { x: BR.x, half: BR.span / 2, deck: (x) => heightAt(x, 0), waterY, bedY }, { hooks, lights });
    for (let k = h0; k < hooks.length; k++) hooks[k].yaw ??= Math.PI / 2; }
  A.boat(K, CA.x - 2.2, waterY - 0.28, 22.5, 0.04);
  A.boat(K, CA.x + 2.3, waterY - 0.28, -30, Math.PI - 0.06);
  for (const sg of [-1, 1]) {
    for (let x = BR.x - BR.span / 2 - 0.2; x <= BR.x + BR.span / 2 + 0.21; x += 0.72) addC(x, sg * 5.05, 0.5);
    for (const xs of [CA.x - WALL_DX - 0.35, CA.x + WALL_DX + 0.35]) for (let z = 6.4; z <= 36; z += 1.5) addC(xs, sg * z, 0.75);
  }

  // ------------------------------------------------------------------ stalls, nook props
  const stallSpots = [-104, -86, -72, -50, -28, 31, 60, 70, 92, 110];
  stallSpots.forEach((x, i) => {
    const sz = i % 2 ? 1 : -1, z = sz * (FR - 0.95);
    if (T.alleys.some((a) => Math.abs(a - x) < 2.5)) return;
    const yaw = sz > 0 ? Math.PI : 0;
    A.setFrame(K, x, heightAt(x, z), z, yaw);
    const h0 = hooks.length;
    A.stall(K, rnd, { hooks });
    for (let k = h0; k < hooks.length; k++) hooks[k].yaw ??= yaw;
    addC(x - 0.5, z, 0.62, 2.4); addC(x + 0.5, z, 0.62, 2.4);
  });
  // corner nooks by the archways: a well, stacked jars
  {
    const wx = PL.x - PL.w / 2 - 2, wz = PZ - 4;
    A.setFrame(K, wx, heightAt(wx, wz), wz, 0);
    K.s.part(2, 0.3).lathe(0, -0.1, 0, [[0.62, 0], [0.62, 0.62], [0.48, 0.62], [0.48, 0.2]], 16);
    K.w.part(0, 0.4).box(-0.72, 0, -0.05, -0.62, 1.8, 0.05); K.w.box(0.62, 0, -0.05, 0.72, 1.8, 0.05);
    K.w.box(-0.8, 1.7, -0.07, 0.8, 1.84, 0.07);
    K.m.part(6, 0.3).cyl(0, 0.9, 0, 0.012, 0.012, 0.8, 4, false);
    addC(wx, wz, 0.9, 1.9);
    const jx = PL.x + PL.w / 2 + 2, jz = -(PZ - 4);
    A.setFrame(K, jx, heightAt(jx, jz), jz, Math.PI / 2);
    A.jars(K, rnd, 4);
    addC(jx, jz, 1.1);
  }

  // alleys: a lantern on a wall bracket at each mouth, a gate at the far end
  for (const a of T.alleys) for (const sz of [-1, 1]) {
    const x = a + (rnd() < 0.5 ? -1 : 1) * (ALLEY - 0.05), z = sz * (FR + 2.2 + rnd() * 2), y = heightAt(a, z);
    K.w.frame(0, 0, 0, 0).part(0, 0.5).beam([x, y + 3.1, z], [x - Math.sign(x - a) * 0.6, y + 3.1, z], 0.06, 0.06);
    hooks.push({ p: [x - Math.sign(x - a) * 0.55, y + 3.08, z], kind: 0, ch: -1, yaw: Math.PI / 2, tint: rnd() < 0.5 ? 1 : 0 });
    const ze = sz * (FR + DEP - 0.02), ye = heightAt(a, ze);
    K.w.part(10, 0.3).quad(sz > 0 ? [a - 0.6, ye, ze] : [a + 0.6, ye, ze], sz > 0 ? [a + 0.6, ye, ze] : [a - 0.6, ye, ze], sz > 0 ? [a + 0.6, ye + 2.2, ze] : [a - 0.6, ye + 2.2, ze], sz > 0 ? [a - 0.6, ye + 2.2, ze] : [a + 0.6, ye + 2.2, ze]);
    K.w.part(0, 0.3).box(a - 0.75, ye + 2.2, ze - 0.15, a + 0.75, ye + 2.36, ze + 0.15);
    K.m.part(0, 0.3).box(a - 0.95, ye + 2.36, ze - 0.35, a + 0.95, ye + 2.5, ze + 0.35);
  }
  // bridge: small lanterns hanging off both parapets over the water (their light catches the arch)
  for (const sg of [-1, 1]) for (const dx of [-2.2, 2.2]) {
    const x = BR.x + dx, y = heightAt(x, 0) + 0.12;
    K.m.frame(0, 0, 0, 0).part(6, 0.5).beam([x, y + 0.9, sg * 5.05], [x, y + 0.9, sg * 6.3], 0.035, 0.035);
    hooks.push({ p: [x, y + 0.88, sg * 6.25], kind: 0, ch: -1, yaw: sg > 0 ? 0 : Math.PI });
  }

  // ------------------------------------------------------------------ lantern strings (catenaries)
  const catenary = (a, b, sag, n, kind, tint, charEvery = 0) => {
    const P = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
    K.m.frame(0, 0, 0, 0).part(6, 0.5);
    const seg = 14;
    for (let k = 0; k < seg; k++) K.m.beam(P(k / seg), P((k + 1) / seg), 0.02, 0.02);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      hooks.push({ p: P(t), kind, ch: charEvery && k % charEvery === 1 ? Math.floor(rnd() * 8) : -1, tint, yaw: Math.atan2(b[0] - a[0], b[2] - a[2]) + Math.PI / 2 });
    }
  };
  // across the street, every ~10 m (not over the plaza, alleys or the canal)
  for (let x = SX0 + 6; x < SX1 - 4; x += 9 + rnd() * 3) {
    if (Math.abs(x - PL.x) < PHX + 2 || Math.abs(x - CA.x) < QUAY_DX + 1.5 || T.alleys.some((a) => Math.abs(a - x) < ALLEY + 0.8)) continue;
    const y = Math.max(heightAt(x, -4.4), heightAt(x, 4.4)) + 3.55 + rnd() * 0.3;
    const tint = rnd() < 0.18 ? 1 : 0;
    catenary([x, y, -FR + 0.3], [x + (rnd() - 0.5) * 2, y, FR - 0.3], 0.5 + rnd() * 0.25, 6, 0, tint);
  }
  // plaza: from the stage roof across the square to the teahouse and south row eaves
  if (stageStrings) {
    const gz = PZ - 0.9;
    const ends = [-15, -8, 0, 8, 15].map((x) => [PL.x + x, heightAt(PL.x + x, gz) + 3.9, gz]);
    ends.forEach((e, i) => {
      const a = stageStrings[i < 2 ? 0 : i > 2 ? 2 : 1];
      const len = Math.hypot(e[0] - a[0], e[2] - a[2]);
      catenary(a, e, 1.1 + len * 0.02, Math.round(len / 1.6), 0, i % 2, 3);
    });
    // along the plaza's east/west edges, between the archways and the plaza rows
    for (const sx of [-1, 1]) {
      const x = PL.x + sx * (PL.w / 2 - 0.5);
      catenary([x, heightAt(x, -PZ) + 4.2, -PZ + 1.5], [x, heightAt(x, PZ) + 4.2, PZ - 1.2], 0.9, 14, 0, 0, 4);
    }
  }
  // across the canal between the canal-side houses
  for (const z of [-17, 17, -27, 27, -40, 40]) {
    const a = [CA.x - QUAY_DX + 0.7, heightAt(CA.x - QUAY_DX, z) + 3.6, z], b = [CA.x + QUAY_DX - 0.7, heightAt(CA.x + QUAY_DX, z) + 3.6, z + (rnd() - 0.5)];
    catenary(a, b, 0.8, 8, 0, rnd() < 0.3 ? 1 : 0);
  }

  // ------------------------------------------------------------------ paving (street, plaza, alleys; follows the terrain)
  const pave = new Builder();
  let inPaved = null;
  {
    const S = 0.75;
    const axis = buildAxis();
    let N0 = 0; while (axis[N0] < -1e-6) N0++;
    inPaved = (x, z) => {
      const ax = Math.abs(z);
      if (Math.abs(x - CA.x) < WALL_DX + 0.1) return Math.abs(x - BR.x) < BR.span / 2 + 0.6 && ax < 4.5;
      if (x >= SX0 && x <= SX1 && ax < FR + 0.35) return true;
      if (Math.abs(x - PL.x) < PHX && ax < PZ + 0.3) return true;
      if (T.alleys.some((a) => Math.abs(a - x) < ALLEY + 0.4) && ax < FR + DEP + 0.4) return true;
      return false;
    };
    const i0 = Math.floor(SX0 / S) - 1, i1 = Math.ceil(SX1 / S) + 1, j0 = -Math.ceil((FR + DEP + 1) / S), j1 = -j0;
    const nI = i1 - i0 + 1, idx = new Int32Array(nI * (j1 - j0 + 1)).fill(-1);
    const nrm = new THREE.Vector3();
    const vtx = (i, j) => {
      const k = (j - j0) * nI + (i - i0);
      if (idx[k] >= 0) return idx[k];
      const x = i * S, z = j * S;
      app.world.normalAt(x, z, nrm);
      idx[k] = pave.v(x, heightAt(x, z) + 0.035, z, nrm.x, nrm.y, nrm.z, x / 3.2, -z / 3.2);
      return idx[k];
    };
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      if (!inPaved((i + 0.5) * S, (j + 0.5) * S)) continue;
      const a = vtx(i, j), b = vtx(i + 1, j), c = vtx(i, j + 1), d = vtx(i + 1, j + 1);
      // match the terrain triangulation (checkerboard diagonals) so the paving hugs the ground exactly
      if (((N0 + i + N0 + j) & 1) === 0) { pave.tri(a, d, b); pave.tri(a, c, d); }
      else { pave.tri(a, c, b); pave.tri(b, c, d); }
    }
  }
  // ------------------------------------------------------------------ water
  const water = new Builder();
  for (const sz of [-1, 1]) {
    const z0 = sz * 5.3, z1 = sz * 120;
    water.grid(4, 24, (i, j, q) => {
      q.x = CA.x - WALL_DX - 0.05 + (2 * WALL_DX + 0.1) * (i / 4); q.z = z0 + (z1 - z0) * (j / 24); q.y = waterY; q.u = q.x; q.v = q.z;
    }, sz > 0);
  }

  // ------------------------------------------------------------------ lanterns (instanced)
  const lb = new Builder();
  lb.part(1, 0).cyl(0, -0.14, 0, 0.42, 0.42, 0.07, 12, true);
  lb.part(0, 0).lathe(0, 0, 0, Array.from({ length: 9 }, (_, k) => { const t = k / 8; return [Math.max(0.3, Math.sin(Math.PI * t)) * (t === 0 || t === 1 ? 0.42 : 1), -0.12 - t * 1.0]; }).reverse(), 14);
  lb.part(1, 0).cyl(0, -1.16, 0, 0.44, 0.44, 0.07, 12, true);
  lb.part(2, 0).cyl(0, -1.62, 0, 0.1, 0.05, 0.47, 6, false);
  lb.part(2, 0).cyl(0, -0.08, 0, 0.03, 0.03, 0.08, 4, false);
  const lgeo = lb.geometry();
  const N = hooks.length;
  const aLant = new Float32Array(N * 4), aTint = new Float32Array(N);
  const atlas = M.buildAtlas();
  const lmat = M.createLanternMaterial(atlas);
  const lmesh = new THREE.InstancedMesh(lgeo, lmat, N);
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const lanterns = [];
  hooks.forEach((h, i) => {
    const k = LANTERN_KINDS[h.kind] ?? LANTERN_KINDS[0];
    const jitter = 0.9 + rnd() * 0.2;
    const R = k.R * jitter, H = k.H * jitter;
    const yaw = h.yaw ?? 0;
    q4.setFromAxisAngle(up, yaw);
    p3.set(h.p[0], h.p[1], h.p[2]); s3.set(R, H, R);
    m4.compose(p3, q4, s3);
    lmesh.setMatrixAt(i, m4);
    aLant[i * 4] = rnd(); aLant[i * 4 + 1] = h.ch ?? -1; aLant[i * 4 + 2] = k.b * (0.85 + rnd() * 0.3); aLant[i * 4 + 3] = H / R;
    aTint[i] = h.tint ?? 0;
    lanterns.push({ pos: new THREE.Vector3(h.p[0], h.p[1] - H * 0.62, h.p[2]), kind: h.kind });
  });
  lgeo.setAttribute('aLant', new THREE.InstancedBufferAttribute(aLant, 4));
  lgeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(aTint, 1));
  lmesh.instanceMatrix.needsUpdate = true;
  lmesh.computeBoundingSphere();

  // ------------------------------------------------------------------ light field bake + shader lamps
  const srcs = [];
  for (const l of lanterns) {
    const k = LANTERN_KINDS[l.kind] ?? LANTERN_KINDS[0];
    srcs.push({ x: l.pos.x, z: l.pos.z, h: Math.max(0.6, l.pos.y - heightAt(l.pos.x, l.pos.z)), i: k.light });
  }
  for (const L of lights) srcs.push({ x: L.p[0], z: L.p[2], h: Math.max(0.6, L.p[1] - heightAt(L.p[0], L.p[2])), i: L.i });
  M.bakeTownLight(srcs, { x0: SX0 - 12, z0: -72, w: SX1 - SX0 + 24, d: 144 }, 0.5);
  // ≤ 12 key lanterns as real (shader-evaluated) lamps: stage, archways, bridge, plaza strings, the teahouse
  const lampHandles = [];
  const pick = (pred, n) => lanterns.filter(pred).slice(0, n);
  const key = [
    ...pick((l) => l.kind === 2 && Math.abs(l.pos.z - SG.z) < 8, 2),
    ...pick((l) => l.kind === 2 && Math.abs(Math.abs(l.pos.x - PL.x) - Math.abs(T.paifang[0].x - PL.x)) < 3, 4).filter((_, i) => i % 2 === 0),
    ...pick((l) => l.kind === 1 && Math.abs(l.pos.x - BR.x) < 3 && Math.abs(l.pos.z) < 7, 2),
  ];
  const plazaSpots = [[-7, -2], [7, -2], [0, 7], [-12, 10], [12, 10], [0, -9]];
  for (const [x, z] of plazaSpots) {
    let best = null, bd = 1e9;
    for (const l of lanterns) { const d = Math.hypot(l.pos.x - PL.x - x, l.pos.z - PL.z - z); if (d < bd) { bd = d; best = l; } }
    if (best && !key.includes(best)) key.push(best);
  }
  for (const l of key.slice(0, 12)) {
    const w = l.kind === 2 ? 5.0 : l.kind === 1 ? 3.6 : 2.6;
    lampHandles.push(lamps.add({ pos: l.pos, color: [1.0, 0.42, 0.14], weight: w, flicker: 0.08 }));
  }

  // ------------------------------------------------------------------ materials + meshes
  const [stoneSet, woodSet, tileSet] = await Promise.all(['japanese_stone_wall', 'weathered_planks', 'ceramic_roof_01']
    .map((id) => loadPBR(id).catch((e) => { console.warn('[town] texture failed', id, e); return null; })));
  const white = new THREE.DataTexture(new Uint8Array([200, 200, 200, 255]), 1, 1); white.needsUpdate = true;
  const mats = {
    w: M.createBuildingMaterial(woodSet ?? { map: white }),
    s: M.createStoneMaterial(stoneSet, waterY),
    t: M.createTileMaterial(tileSet),
    m: M.createMiscMaterial(),
    g: M.createSignMaterial(atlas),
    pave: M.createPavingMaterial(stoneSet, { plazaW: 2 * PHX, plazaD: PL.d, plazaX: PL.x, plazaZ: PL.z, bridgeX: BR.x, bridgeHalf: BR.span / 2 + 0.3 }),
    water: M.createWaterMaterial(),
  };

  const root = new THREE.Group();
  root.name = 'town';
  const meshes = [];
  const mk = (b, mat, name, { shadow = true, uvScale = 1, order = -2 } = {}) => {
    const g = b.geometry();
    if (uvScale !== 1) { const uv = g.getAttribute('uv'); for (let i = 0; i < uv.array.length; i++) uv.array[i] *= uvScale; }
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name; mesh.castShadow = shadow; mesh.receiveShadow = true;
    mesh.layers.set(LAYERS.WORLD);
    mesh.renderOrder = order;          // before the terrain (0): the ground under the town is early-Z rejected
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    root.add(mesh); meshes.push(mesh);
    return mesh;
  };
  // draw order: roofs first (they hide most of the rest from above), then walls, paving, water; all before the terrain
  mk(K.t, mats.t, 'town:tiles', { order: -4 });
  mk(K.w, mats.w, 'town:building', { order: -3 });
  mk(K.s, mats.s, 'town:stone', { uvScale: 0.45, order: -3 });
  mk(K.m, mats.m, 'town:misc', { order: -3 });
  mk(K.g, mats.g, 'town:signs', { shadow: false, order: -1 }).frustumCulled = false;   // vertex flutter
  mk(pave, mats.pave, 'town:paving', { shadow: false, order: -2 });
  mk(water, mats.water, 'town:water', { shadow: false, order: -1 });
  lmesh.name = 'town:lanterns'; lmesh.layers.set(LAYERS.WORLD); lmesh.renderOrder = -3; lmesh.castShadow = false; lmesh.receiveShadow = false;
  lmesh.frustumCulled = false;
  root.add(lmesh); meshes.push(lmesh);
  root.updateMatrixWorld(true);
  app.scene.add(root);

  // colliders → world
  app.world.colliders ||= [];
  app.world.colliders.push(...colliders);
  if (app.world.addBlocker) for (const c of colliders) app.world.addBlocker(c);

  const buildMs = Math.round(performance.now() - t0);
  const tris = meshes.reduce((s, m) => s + (m.geometry.index ? m.geometry.index.count / 3 : 0) * (m.isInstancedMesh ? m.count : 1), 0);
  /** true when (x, z) is under a building block (any row, incl. the unreachable back rows) */
  const built = (x, z) => {
    for (const b of blocks) {
      const dx = x - b.x, dz = z - b.z, t = dx * b.ux + dz * b.uz, d = dx * b.nx + dz * b.nz;
      if (t >= 0 && t <= b.len && d >= -0.3 && d <= b.d + 0.6) return true;
    }
    return false;
  };
  const sys = {
    root, colliders, lanterns, waterY, meshes, eaves,
    paved: (x, z) => inPaved(x, z),
    built,
    covered: (x, z) => inPaved(x, z) || built(x, z) || Math.abs(x - CA.x) < QUAY_DX,
    update() {},
    stats() {
      return { drawCalls: meshes.length, tris: Math.round(tris), houses: houses.length, lanterns: lanterns.length, lamps: lampHandles.length, colliders: colliders.length, buildMs };
    },
    dispose() {
      app.remove?.(sys);
      app.scene.remove(root);
      for (const m of meshes) { m.geometry.dispose(); }
      for (const k in mats) mats[k].dispose();
      lmat.dispose(); atlas.dispose(); G.tTownLight.value?.dispose();
      for (const h of lampHandles) h.remove();
      const set = new Set(colliders);
      if (app.world.colliders) app.world.colliders = app.world.colliders.filter((c) => !set.has(c));
    },
  };
  app.add?.(sys);
  return sys;
}
