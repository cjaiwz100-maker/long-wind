// Rock placement plan (seed 777, bible §4.6): WHERE every scanned rock goes, computed from the layout and the terrain
// field only (no meshes needed), so the terrain bake can carve dirt rings / kill grass under rocks before rocks.js has
// loaded a single model. Owner: world (W). PURE module (no three.js).
//
//   rockPlan() → [{ kind, model, piece, x, z, size, yScale, rotY, sink, align, r, collide }]
//     kind     'hero' | 'debris' | 'standing' | 'scatter' | 'outcrop'
//     model    Poly Haven model id;  piece = mesh index inside it (-1 → pick by hash at build time)
//     size     target largest horizontal extent (m);  yScale = extra vertical stretch;  sink = fraction of height buried
//     align    0..1 how much the rock's up axis follows the terrain normal;  r = ground footprint radius (m)
//     h        (standing stones) target height: the builder stands the model on its longest axis
import { mulberry32 } from '../core/noise.js';
import { LAYOUT } from './layout.js';
import { heightAt, normalInto, roadQuery } from './terrain-field.js';

// Hero boulder prototypes (piece counts from the glTFs).
export const HERO_MODELS = [
  { model: 'rock_moss_set_01', pieces: 6, w: 3 },
  { model: 'rock_moss_set_02', pieces: 7, w: 2 },
  { model: 'boulder_01', pieces: 1, w: 2 },
  { model: 'namaqualand_boulder_02', pieces: 1, w: 1.5 },
  { model: 'namaqualand_boulder_05', pieces: 1, w: 1 },
];
export const DEBRIS_MODELS = [
  { model: 'stone_01', pieces: 1, w: 2 },
  { model: 'rock_07', pieces: 1, w: 2 },
  { model: 'rock_09', pieces: 1, w: 1 },
  { model: 'rock_moss_set_02', pieces: 7, w: 1.5 },
];

let PLAN = null;
const _n = { x: 0, y: 1, z: 0 };

function pick(list, rng) {
  let tot = 0; for (const m of list) tot += m.w;
  let v = rng() * tot;
  for (const m of list) { if ((v -= m.w) <= 0) return m; }
  return list[list.length - 1];
}

/** Places a rock must avoid (fighting pad, stele, pavilion pad, graves, tree trunk, road). */
function keepOut(x, z, r) {
  const k = LAYOUT.knoll, s = LAYOUT.stele, p = LAYOUT.pavilion, t = LAYOUT.oldTree;
  if (Math.hypot(x - k.x, z - k.z) < k.padR + 2.5 + r) return true;
  if (Math.hypot(x - s.x, z - s.z) < 3 + r) return true;
  if (Math.hypot(x - p.x, z - p.z) < p.r + 4 + r) return true;
  if (Math.hypot(x - t.x, z - t.z) < 3.5 + r) return true;
  for (const g of LAYOUT.graves) if (Math.hypot(x - g.x, z - g.z) < 2.2 + r) return true;
  if (Math.hypot(x - LAYOUT.cairn.x, z - LAYOUT.cairn.z) < 1.8 + r) return true;
  if (Math.hypot(x - LAYOUT.playerSpawn.x, z - LAYOUT.playerSpawn.z) < 4 + r) return true;
  if (roadQuery(x, z, false).d < LAYOUT.roadWidth * 0.5 + 1.2 + r) return true;
  return false;
}

export function rockPlan() {
  if (PLAN) return PLAN;
  const out = [];
  const add = (o) => { out.push(o); return o; };

  const debrisAround = (hx, hz, hsize, rng, count) => {
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2, d = hsize * (0.45 + rng() * 0.75) + rng() * 1.2;
      const x = hx + Math.cos(a) * d, z = hz + Math.sin(a) * d;
      const size = 0.10 + Math.pow(rng(), 2.2) * 0.42 * Math.min(1.4, 0.5 + hsize * 0.3);
      if (keepOut(x, z, size * 0.5)) continue;
      const m = pick(DEBRIS_MODELS, rng);
      add({ kind: 'debris', model: m.model, piece: m.pieces > 1 ? (rng() * m.pieces) | 0 : 0, x, z, size, yScale: 0.7 + rng() * 0.5,
        rotY: rng() * Math.PI * 2, sink: 0.3 + rng() * 0.3, align: 0.9, r: size * 0.45, collide: false });
    }
  };

  // 1) outcrop clusters from the layout (hero boulders + debris)
  LAYOUT.rockOutcrops.forEach((o, k) => {
    const rng = mulberry32(777 + k * 101);
    for (let b = 0; b < (o.n || 1); b++) {
      let x = o.x, z = o.z, tries = 0, size = o.size * (b === 0 ? 1 : 0.45 + rng() * 0.45);
      if (b > 0) {
        do { const a = rng() * Math.PI * 2, d = o.r * (0.35 + rng() * 0.65); x = o.x + Math.cos(a) * d; z = o.z + Math.sin(a) * d; }
        while (keepOut(x, z, size * 0.5) && ++tries < 12);
      }
      if (keepOut(x, z, size * 0.4) && b > 0) continue;
      normalInto(x, z, _n);
      if (_n.y < 0.72 && b > 0) continue;
      const m = pick(HERO_MODELS, rng);
      add({ kind: 'hero', model: m.model, piece: m.pieces > 1 ? (rng() * m.pieces) | 0 : 0, x, z, size,
        yScale: 0.85 + rng() * 0.45, rotY: rng() * Math.PI * 2, sink: 0.16 + rng() * 0.16, align: 0.55,
        r: size * 0.42, collide: size > 0.7 });
      debrisAround(x, z, size, rng, 3 + ((rng() * 7) | 0));
    }
  });

  // 2) standing stones by the road (tall, weathered, slightly leaning)
  LAYOUT.standingStones.forEach((s, k) => {
    const rng = mulberry32(9100 + k * 7);
    // stood on end: the builder turns the model's longest axis vertical and scales it to height h
    add({ kind: 'standing', model: k % 2 ? 'namaqualand_boulder_02' : 'boulder_01', piece: 0, x: s.x, z: s.z, size: s.h * 0.45, h: s.h,
      yScale: 1.25, rotY: rng() * Math.PI * 2, sink: 0.14, align: 0.1, r: s.h * 0.22, collide: true, lean: (rng() - 0.5) * 0.14 });
    debrisAround(s.x, s.z, 1.0, rng, 3);
  });

  // 3) scattered single boulders on the plain (40–460 m), avoiding the default duel sight line
  {
    const rng = mulberry32(7771);
    let placed = 0;
    for (let i = 0; i < 400 && placed < 46; i++) {
      const a = rng() * Math.PI * 2, d = 40 + Math.pow(rng(), 0.8) * 420;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const size = 1.1 + Math.pow(rng(), 1.8) * 3.4;
      if (keepOut(x, z, size)) continue;
      if (Math.abs(x) < 7 && z > 5 && z < 60) continue; // keep the hero view line clear
      normalInto(x, z, _n);
      if (_n.y < 0.8) continue;
      const m = pick(HERO_MODELS, rng);
      add({ kind: 'scatter', model: m.model, piece: m.pieces > 1 ? (rng() * m.pieces) | 0 : 0, x, z, size,
        yScale: 0.7 + rng() * 0.5, rotY: rng() * Math.PI * 2, sink: 0.2 + rng() * 0.18, align: 0.7, r: size * 0.42, collide: size > 0.9 });
      if (rng() < 0.6) debrisAround(x, z, size, rng, 2 + ((rng() * 4) | 0));
      placed++;
    }
  }

  // 4) rock-face outcrops on steep rim slopes (300–1100 m), aligned to the slope
  {
    const rng = mulberry32(7779);
    let placed = 0;
    for (let i = 0; i < 5000 && placed < 60; i++) {
      const a = rng() * Math.PI * 2, d = 280 + rng() * 820;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      normalInto(x, z, _n);
      if (_n.y > 0.86) continue;
      const size = 6 + rng() * 12;
      add({ kind: 'outcrop', model: rng() < 0.6 ? 'rock_face_01' : 'rock_moss_set_01', piece: -1, x, z, size, yScale: 0.8 + rng() * 0.6,
        rotY: rng() * Math.PI * 2, sink: 0.35, align: 0.85, r: size * 0.4, collide: false, nx: _n.x, ny: _n.y, nz: _n.z });
      placed++;
    }
  }

  for (const o of out) o.y = heightAt(o.x, o.z);
  PLAN = out;
  return out;
}
