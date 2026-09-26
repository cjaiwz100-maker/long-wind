// Townsfolk (level 3 · 长街灯火): a crowd of procedural citizens who stroll the street and the plaza edges, browse the
// shop fronts and chat in pairs; when the fighting starts they scream, run for the alleys and house fronts and cower
// against the walls, and a while after it ends they get up and go back to the market. Not combat targets.
//
//   const crowd = await createCitizens(app, { count = 28, town = LAYOUT.town, avoid = () => [{x, z, r}] })
//   crowd.list                 [{ ch, anim, pos, yaw, state, look }]
//   crowd.setPanic(k)          0..1 (1 = everyone within ~35 m of the plaza flees; also driven by the bus)
//   crowd.update(dt)           registered with app.add (do not call twice)
//   crowd.stats()              { count, visible, ticks, cloth, ms, panic, states }
//   crowd.dispose()
//
// Bus: listens wave:start → panic 1, wave:clear → panic decays over ~6 s, game:state title → calm.
//      emits 'crowd' { calm 0..1, panic 0..1, scream 0..1, pos, call } ~4×/s for the audio crowd bed (audio/crowd.js).
//
// Bodies: the procedural character pipeline (createCharacter) with the citizen_* kinds (outfitsRecipes.js); a fixed
// set of LOOKS (kind, seed) is built once each and instanced across the crowd (the geometry cache is per kind:seed).
// Cost control: every citizen's animator + bones run on a tick whose rate falls with camera distance (every frame
// < 10 m, every 2nd < 22 m, every 3rd < 36 m, every 4th beyond, hidden > 46 m, off-screen at most every 4th; standing still: half that rate); the cloth sim runs only for the nearest few and while
// a crouching citizen's robe settles, otherwise the cloth is rigid (rest pose on the hips) or frozen in place.
import * as THREE from 'three';
import { bus } from '../core/bus.js';
import { LAYOUT } from './layout.js';
import { createCharacter, prefetchCharacters } from '../character/character.js';
import { Animator } from '../character/animator.js';
import { windVector } from '../core/wind.js';
import { mulberry32 } from '../core/noise.js';

/** The distinct bodies (kind, seed): ~10 builds, instanced across the crowd. */
// (four body builds: citizen_m and citizen_s share one; seeds picked for distinct variants — see recipe.info)
export const LOOKS = [
  { kind: 'citizen_m', seed: 3 },      // labourer, narrow sleeves, headband over a topknot
  { kind: 'citizen_m', seed: 4 },      // vendor with an apron and a head wrap
  { kind: 'citizen_m', seed: 15 },     // labourer in a straw hat
  { kind: 'citizen_f', seed: 1 },      // headscarf
  { kind: 'citizen_f', seed: 2 },      // hair in a low bun, hairpin
  { kind: 'citizen_f', seed: 5 },
  { kind: 'citizen_s', seed: 1 },      // scholar 书生: wide sleeves, long robe, black cap
  { kind: 'citizen_old', seed: 1 },    // grey robe, grey hair, beard
  { kind: 'citizen_child', seed: 1 },
];
// crowd mix: which look each citizen wears (children are few; men and women dominate)
const MIX = [3, 0, 4, 1, 6, 5, 2, 7, 3, 8, 0, 4, 1, 5, 6, 2, 3, 7, 0, 4, 5, 1, 6, 8, 2, 3, 7, 4, 0, 5, 1, 2];

/** Start building the crowd's bodies early (call while the level loads; createCitizens reuses the cache). */
export function prefetchCitizens() { prefetchCharacters(LOOKS); }

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _w2 = new THREE.Vector2(), _v = new THREE.Vector3();

// distance tiers (m): animator tick interval by camera distance, cloth, visibility
const TIER = [10, 22, 36];
const HIDE = 46, SHOW = 43;
const CLOTH_N = 2, CLOTH_R = 14;           // cloth sim for the nearest few inside this radius (full quality < 7 m)
const SETTLE = 1.8;                         // s of cloth sim after a citizen stops (a crouch lets the robe fall)
const NO_CLOTH = typeof location !== 'undefined' && new URLSearchParams(location.search).get('cloth') === '0';   // debug: rigid cloth
const CLOTH_ALL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('cloth') === 'all';

export async function createCitizens(app, opts = {}) {
  const T = opts.town ?? LAYOUT.town;
  const count = opts.count ?? 28;
  const avoid = opts.avoid ?? (() => []);
  const heightAt = app.world.heightAt, normalAt = app.world.normalAt;
  const rng = mulberry32(7331);
  const R = (a, b) => a + (b - a) * rng();
  const t0 = performance.now();

  // ------------------------------------------------------------------------------------------------------------
  // the town's walkable space: the street band, the plaza, the alley corridors (never the canal)
  // ------------------------------------------------------------------------------------------------------------
  const st = T.street, pl = T.plaza, F = T.frontage, cn = T.canal;
  const ZS = F - 0.55;                                   // street band half-width for walking
  const XMIN = Math.max(st.x0 + 4, -95), XMAX = Math.min(st.x1 - 4, 110);   // the crowd's stretch of street
  const BRIDGE_Z = Math.min(st.width / 2 - 0.7, ZS);
  const canalHalf = cn ? cn.width / 2 + 0.6 : 0;
  const PW = pl.w / 2, PD = pl.d / 2;
  const alleys = T.alleys ?? [];
  const inPlaza = (x, z, m = 0.8) => Math.abs(x - pl.x) <= PW - m && Math.abs(z - pl.z) <= PD - m;
  const inCanal = (x, z) => cn && Math.abs(x - cn.x) < canalHalf && Math.abs(z) > BRIDGE_Z;
  const alleyAt = (x) => { for (const a of alleys) if (Math.abs(x - a) < 0.9) return a; return null; };
  /** Project a point into the walkable space (in place). deep: allow the alley corridors (fleeing). */
  function walkClamp(p, deep = false) {
    const x = p.x, z = p.z;
    if (inPlaza(x, z, 0.6)) return p;
    const a = deep ? alleyAt(x) : null;
    const zMax = a !== null ? F + 4.5 : ZS;
    let bx = clamp(x, XMIN, XMAX), bz = clamp(z, -zMax, zMax);
    if (inCanal(bx, bz)) {
      // off the canal: back onto the bridge walkway or out of the canal band, whichever is nearer
      const dz = Math.abs(bz) - BRIDGE_Z, dx = canalHalf - Math.abs(bx - cn.x);
      if (dz < dx) bz = Math.sign(bz) * BRIDGE_Z; else bx = cn.x + Math.sign(bx - cn.x || 1) * canalHalf;
    }
    // or the plaza, if that is nearer
    const px = clamp(x, pl.x - PW + 0.6, pl.x + PW - 0.6), pz = clamp(z, pl.z - PD + 0.6, pl.z + PD - 0.6);
    if ((px - x) ** 2 + (pz - z) ** 2 < (bx - x) ** 2 + (bz - z) ** 2) { p.x = px; p.z = pz; } else { p.x = bx; p.z = bz; }
    return p;
  }

  // static colliders (town.js pushes house circles into app.world.colliders): uniform grid, rebuilt when it changes
  let grid = null, gridN = -1;
  const CELL = 4;
  const key = (ix, iz) => (ix * 73856093) ^ (iz * 19349663);
  function colGrid() {
    const cols = app.world.colliders ?? [];
    if (grid && gridN === cols.length) return grid;
    grid = new Map(); gridN = cols.length;
    for (const c of cols) {
      const r = (c.r ?? 1) + 0.5;
      for (let ix = Math.floor((c.x - r) / CELL); ix <= Math.floor((c.x + r) / CELL); ix++) {
        for (let iz = Math.floor((c.z - r) / CELL); iz <= Math.floor((c.z + r) / CELL); iz++) {
          const k = key(ix, iz); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(c);
        }
      }
    }
    return grid;
  }
  function collide(p, r) {
    const l = colGrid().get(key(Math.floor(p.x / CELL), Math.floor(p.z / CELL)));
    if (!l) return;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      const dx = p.x - c.x, dz = p.z - c.z, Rr = (c.r ?? 1) + r;
      const d2 = dx * dx + dz * dz;
      if (d2 < Rr * Rr && d2 > 1e-8) { const d = Math.sqrt(d2), k = (Rr - d) / d; p.x += dx * k; p.z += dz * k; }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // places: stroll targets, shop fronts to browse, refuges to cower in
  // ------------------------------------------------------------------------------------------------------------
  const nearAlley = (x, m) => alleys.some((a) => Math.abs(x - a) < m);
  function streetPoint(hx, span = 22) {
    for (let i = 0; i < 12; i++) {
      const x = clamp(hx + R(-span, span), XMIN, XMAX), z = R(-ZS + 0.4, ZS - 0.4);
      if (!inCanal(x, z) && !(cn && Math.abs(x - cn.x) < canalHalf + 1)) return { x, z };
    }
    return { x: clamp(hx, XMIN, XMAX), z: 0 };
  }
  function plazaEdgePoint() {
    // along the plaza's rim (2–4 m in from its edges), rarely across the middle
    if (rng() < 0.15) return { x: pl.x + R(-PW + 3, PW - 3), z: pl.z + R(-PD + 3, PD - 3) };
    const inset = R(1.6, 4), side = Math.floor(rng() * 4);
    if (side < 2) return { x: pl.x + R(-PW + inset, PW - inset), z: pl.z + (side ? 1 : -1) * (PD - inset) };
    return { x: pl.x + (side === 2 ? 1 : -1) * (PW - inset), z: pl.z + R(-PD + inset, PD - inset) };
  }
  // shop fronts along both facades of the street (not at alleys, the canal or the plaza mouth)
  const shops = [];
  for (let x = XMIN + 2; x < XMAX - 2; x += 2.6) {
    if (Math.abs(x - pl.x) < PW + 2 || nearAlley(x, 2.2) || (cn && Math.abs(x - cn.x) < canalHalf + 2.5)) continue;
    for (const sd of [-1, 1]) shops.push({ x: x + R(-0.4, 0.4), z: sd * (F - 0.95), yaw: sd > 0 ? 0 : Math.PI, used: 0 });
  }
  // refuges: alley mouths (a few places each, facing the alley's side walls), wall spots along the facades, the
  // plaza's rim (buildings stand back from it; they crouch against the stage and the house fronts)
  const refuges = [];
  for (const a of alleys) for (const sd of [-1, 1]) {
    // in the alley, crouched facing away from the street (one behind the other)
    for (let k = 0; k < 3; k++) refuges.push({ x: a + (k & 1 ? 0.25 : -0.25), z: sd * (F + 0.7 + k * 1.1), yaw: sd > 0 ? 0 : Math.PI, used: 0, alley: a });
  }
  for (let x = XMIN + 1; x < XMAX - 1; x += 1.6) {
    if (Math.abs(x - pl.x) < PW || nearAlley(x, 1.4) || (cn && Math.abs(x - cn.x) < canalHalf + 1.2)) continue;
    for (const sd of [-1, 1]) refuges.push({ x, z: sd * (F - 0.7), yaw: sd > 0 ? 0 : Math.PI, used: 0 });
  }
  for (let x = pl.x - PW + 1.5; x < pl.x + PW - 1.5; x += 1.6) {
    for (const sd of [-1, 1]) if (Math.abs(x - pl.x) > 3 || sd > 0) refuges.push({ x, z: pl.z + sd * (PD - 0.75), yaw: sd > 0 ? 0 : Math.PI, used: 0, plaza: true });
  }
  // (drop the spots a stall, a pillar or a house already occupies; shop fronts too)
  const freeSpot = (x, z, m) => { const l = colGrid().get(key(Math.floor(x / CELL), Math.floor(z / CELL))); return !l || l.every((c) => (c.x - x) ** 2 + (c.z - z) ** 2 > ((c.r ?? 1) + m) ** 2); };
  for (const A of [refuges, shops]) for (let k = A.length - 1; k >= 0; k--) if (!freeSpot(A[k].x, A[k].z, 0.45)) A.splice(k, 1);

  // ------------------------------------------------------------------------------------------------------------
  // bodies
  // ------------------------------------------------------------------------------------------------------------
  const scene = app.scene;
  const specs = [];
  for (let i = 0; i < count; i++) specs.push(LOOKS[MIX[i % MIX.length] % LOOKS.length]);
  let buildMs = -1, loading = true, disposed = false, readyN = 0;
  const tCreate = performance.now();

  const list = [];
  let plazaN = 0;
  for (let i = 0; i < count; i++) {
    const kind = specs[i].kind;
    const old = kind === 'citizen_old', child = kind === 'citizen_child';
    // the record lives (and walks) from the start; its body is attached when the build finishes, and shown then
    // (while loading) or as soon as the camera isn't looking at its spot (no pop-in in plain view)
    const c = {
      i, spec: specs[i], ch: null, anim: null, pending: false, kind, old, child,
      pos: new THREE.Vector3(), yaw: 0, vx: 0, vz: 0, yawRate: 0,
      state: 'stand', timer: 0, target: { x: 0, z: 0 }, legs: [], face: null, look: null, lookV: new THREE.Vector3(),
      stroll: old ? R(0.75, 0.95) : child ? R(1.1, 1.3) : R(1.0, 1.4),
      run: old ? R(2.4, 2.9) : child ? R(3.4, 3.9) : R(3.5, 4.5),
      home: 0, plaza: false, partner: null, parent: null, refuge: null, shop: null,
      fear: R(0.0, 0.7),             // reaction delay (s) when panic hits
      calmDelay: R(1.5, 5),          // how long after the panic ends before they get up
      frozeAt: { x: 0, z: 0, yaw: 0 }, acc: 0, tickN: 1, phase: i, hidden: false, dist: 0, still: 0, clothMode: 'rigid', settle: 0, clothSim: false,
      panicked: false, scream: 0, cowerT: 0,
    };
    // home: a stretch of street, or the plaza
    c.plaza = plazaN < count * 0.4 && rng() < 0.55;
    if (c.plaza) plazaN++;
    c.home = c.plaza ? pl.x : clamp(R(-60, 95), XMIN, XMAX);
    list.push(c);
  }
  // children walk with a grown-up (a woman if there is one)
  for (const c of list) if (c.child) {
    const p = list.find((o) => !o.child && !o.childOf && o.kind === 'citizen_f') ?? list.find((o) => !o.child && !o.childOf);
    if (p) { c.parent = p; p.childOf = c; c.plaza = p.plaza; c.home = p.home; }
  }

  // initial placement: spread out, some pairs chatting, some browsing, the rest strolling
  const placed = [];
  for (const c of list) {
    let p = null;
    if (c.parent && c.parent.placed) p = { x: c.parent.pos.x + 0.7, z: c.parent.pos.z + 0.4 };
    for (let k = 0; !p && k < 30; k++) {
      const q = c.plaza ? plazaEdgePoint() : streetPoint(c.home, 30);
      walkClamp(q);
      if (placed.every((o) => (o.x - q.x) ** 2 + (o.z - q.z) ** 2 > 2.2 * 2.2)) p = q;
    }
    p ??= walkClamp(c.plaza ? plazaEdgePoint() : streetPoint(c.home, 30));
    placed.push(p);
    c.pos.set(p.x, heightAt(p.x, p.z), p.z);
    c.yaw = R(0, TAU);
    c.placed = true;
  }
  // pairs: neighbours who face each other and talk
  for (const c of list) {
    if (c.partner || c.child || c.childOf || rng() > 0.35) continue;
    let best = null, bd = 9;
    for (const o of list) {
      if (o === c || o.partner || o.child || o.childOf) continue;
      const d = (o.pos.x - c.pos.x) ** 2 + (o.pos.z - c.pos.z) ** 2;
      if (d < bd) { bd = d; best = o; }
    }
    if (best) { c.partner = best; best.partner = c; startChat(c, best); }
  }
  for (const c of list) if (c.state === 'stand' && !c.partner) { if (rng() < 0.5) startWalk(c); else c.timer = R(1, 6); }

  // one material set for the whole crowd (the first body's): the garments' colours live in the vertex colours, so
  // every citizen can share it — ~60 draws then run on a handful of materials instead of 28 × 9 (uniform uploads).
  // Its per-character uniforms (ground contact, wind in body space) follow the citizen nearest the camera.
  let shared = null;
  function shareMaterials(meshes) {
    for (const m of meshes) { const sm = shared.M[m.name.slice(5)]; if (sm && m.material !== sm) m.material = sm; }
  }
  // skeletons re-upload their bone textures only on the frames their citizen was posed (three.js would otherwise
  // recompute and upload ~150 bone matrices per visible body every frame, ticked or not)
  function gateSkeleton(c) {
    const sk = c.ch.rig.skeleton, orig = sk.update.bind(sk);
    c.skDirty = true;
    sk.update = () => { if (c.skDirty) { c.skDirty = false; orig(); } };
  }
  function attach(c, ch) {
    c.ch = ch;
    if (!shared) {
      shared = { M: ch.materials, U: ch.uniforms };
      // a crowd seen at a few metres and more: drop the sheen / anisotropy lobes (cheaper fragment programs)
      for (const k of ['cloth', 'skin', 'hair']) { const m = shared.M[k]; if (m) { if ('sheen' in m) m.sheen = 0; if ('anisotropy' in m) m.anisotropy = 0; } }
    } else shareMaterials(ch.meshes);
    gateSkeleton(c);
    c.anim = new Animator(ch.rig, { heightAt, normalAt, style: c.kind === 'citizen_m' ? 'bandit' : 'hero', kind: c.kind });
    c.anim.setArmed(false);
    ch.sword.setDrawn(false);
    ch.group.visible = false;
    ch.group.position.copy(c.pos);
    ch.group.rotation.y = c.yaw;
    ch.group.updateMatrixWorld(true);
    ch.resetCloth();
    scene.add(ch.group);
    if (c.state === 'cower') c.anim.play('cower', { fade: 0 });
    c.pending = true;
    readyN++;
  }
  function reveal(c) {
    c.pending = false; c.fresh = true; c.acc = 1 / 60; c.skDirty = true;
    c.ch.group.visible = !c.hidden;
  }
  const builds = specs.map((s, k) => createCharacter(s).then((ch) => {
    if (disposed) { ch.dispose(); return; }
    attach(list[k], ch);
  }).catch((e) => console.warn('[citizens] build failed', s, e)));
  const allBuilt = Promise.all(builds).then(() => { buildMs = Math.round(performance.now() - tCreate); });

  // ------------------------------------------------------------------------------------------------------------
  // behaviours
  // ------------------------------------------------------------------------------------------------------------
  function setTarget(c, x, z, deep = false) {
    const q = walkClamp({ x, z }, deep);
    c.legs.length = 0;
    // leaving the plaza for the street (or coming back): through the plaza's mouth, not through the houses
    const fromPlaza = inPlaza(c.pos.x, c.pos.z, 0.2), toPlaza = inPlaza(q.x, q.z, 0.2);
    if (fromPlaza !== toPlaza) {
      const sx = Math.sign((fromPlaza ? q.x : c.pos.x) - pl.x) || 1;
      c.legs.push({ x: pl.x + sx * (PW - 1.0), z: clamp(fromPlaza ? c.pos.z : q.z, -ZS + 0.6, ZS - 0.6) });
    }
    // into an alley: first to its mouth on the street
    const a = deep ? alleyAt(q.x) : null;
    if (a !== null && Math.abs(q.z) > ZS) c.legs.push({ x: a, z: Math.sign(q.z) * (ZS - 0.3) });
    c.legs.push(q);
    c.target = c.legs[0];
  }
  function startWalk(c) {
    c.state = 'walk'; c.face = null; c.look = null; c.shop = release(c.shop);
    if (c.parent) return;
    // a third of the strolls end at a shop front
    if (!c.plaza && rng() < 0.35) {
      const cands = shops.filter((s) => !s.used && Math.abs(s.x - c.home) < 30);
      if (cands.length) { const s = cands[Math.floor(rng() * cands.length)]; s.used = 1; c.shop = s; setTarget(c, s.x, s.z); return; }
    }
    const q = c.plaza && rng() < 0.85 ? plazaEdgePoint() : streetPoint(c.home);
    setTarget(c, q.x, q.z);
  }
  function startChat(a, b) {
    for (const [c, o] of [[a, b], [b, a]]) {
      c.state = 'chat'; c.timer = R(8, 20); c.face = Math.atan2(o.pos.x - c.pos.x, o.pos.z - c.pos.z); c.look = o;
    }
    // stand a comfortable distance apart
    const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz) || 1;
    const want = 1.15, k = (d - want) / 2 / d;
    for (const [c, s] of [[a, 1], [b, -1]]) { c.target = { x: c.pos.x + dx * k * s, z: c.pos.z + dz * k * s }; c.legs = [c.target]; }
  }
  function release(o) { if (o) o.used = Math.max(0, o.used - 1); return null; }

  let panic = 0, panicTarget = 0, decay = 0;
  const danger = [];
  const plazaC = { x: pl.x, z: pl.z };
  function refreshDanger() {
    danger.length = 0;
    let pts = null;
    try { pts = avoid(); } catch { pts = null; }
    if (pts) for (const p of pts) if (p && Number.isFinite(p.x)) danger.push(p);
  }
  function nearestDanger(x, z) {
    let best = 1e9;
    for (const d of danger) { const q = Math.hypot(d.x - x, d.z - z) - (d.r ?? 4); if (q < best) best = q; }
    return best;
  }
  function pickRefuge(c) {
    let best = null, bc = 1e9;
    // the danger's centre of mass (the plaza in a wave)
    let cx = plazaC.x, cz = plazaC.z, n = 1;
    for (const d of danger) { cx += d.x; cz += d.z; n++; }
    cx /= n; cz /= n;
    const ax = cx - c.pos.x, az = cz - c.pos.z, al = Math.hypot(ax, az) || 1;
    for (const r of refuges) {
      if (r.used >= 1) continue;
      const dx = r.x - c.pos.x, dz = r.z - c.pos.z, d = Math.hypot(dx, dz) || 1;
      if (d > 45) continue;
      const dc = Math.hypot(r.x - cx, r.z - cz);
      let cost = d + Math.max(0, 16 - dc) * 2.2 + (r.alley !== undefined ? -2.5 : 0) + (r.plaza ? 4 : 0);
      const toward = (dx * ax + dz * az) / (d * al);
      if (toward > 0.3 && d > 3) cost += 12 * toward;                   // never run past the fight
      if (nearestDanger(r.x, r.z) < 3) cost += 40;
      cost += rng() * 3;
      if (cost < bc) { bc = cost; best = r; }
    }
    return best;
  }
  function flee(c) {
    c.shop = release(c.shop);
    c.refuge = release(c.refuge);
    if (c.partner) { c.partner.partner = null; c.partner = null; }
    const r = c.parent?.refuge && c.parent.state === 'flee' ? null : pickRefuge(c);
    if (c.parent && c.parent.refuge) {
      const p = c.parent.refuge;
      c.target = { x: p.x + Math.sin(p.yaw + Math.PI / 2) * 0.55, z: p.z + Math.cos(p.yaw + Math.PI / 2) * 0.55 };
      setTarget(c, c.target.x, c.target.z, true);
      c.refugeYaw = p.yaw;
    } else if (r) {
      r.used++; c.refuge = r; c.refugeYaw = r.yaw;
      setTarget(c, r.x, r.z, true);
    } else {
      // nowhere left: away from the plaza along the street
      const sx = Math.sign(c.pos.x - pl.x) || 1;
      setTarget(c, c.pos.x + sx * 18, Math.sign(c.pos.z || 1) * (ZS - 0.2));
      c.refugeYaw = c.pos.z > 0 ? 0 : Math.PI;
    }
    if (c.state === 'cower') c.anim?.stop(0.2);
    c.state = 'flee'; c.face = null; c.look = null; c.panicked = true; c.fleeT = 0; c.fleeBest = undefined; c.fleeProg = 0;
    c.scream = 1;
  }
  function cower(c) {
    c.state = 'cower'; c.face = c.refugeYaw ?? c.yaw; c.look = null;
    c.anim?.play('cower', { fade: 0.18 });
    c.cowerT = R(3, 7); c.settle = SETTLE;
  }
  function getUp(c) {
    c.anim?.stop(0.5);
    c.refuge = release(c.refuge);
    c.panicked = false;
    c.state = 'stand'; c.timer = R(2, 4); c.face = null;
    c.look = { x: plazaC.x, z: plazaC.z };          // a wary look back at the plaza
  }

  function think(c, dt) {
    const d = nearestDanger(c.pos.x, c.pos.z);
    const dPl = Math.hypot(c.pos.x - pl.x, c.pos.z - pl.z) - Math.min(PW, PD);
    const threatened = panic > 0.05 && (dPl < 35 * panic || d < 1.5);
    switch (c.state) {
      case 'stand': case 'chat': case 'browse': case 'walk': {
        if (threatened) {
          c.fearT = (c.fearT ?? c.fear) - dt;
          if (c.fearT <= 0) { c.fearT = undefined; flee(c); }
          else if (c.state !== 'walk') c.look = plazaC;    // they turn toward the commotion first
          break;
        }
        if (c.state === 'walk') {
          // a fight on: the ones further off don't stroll toward it — they stop and watch
          if (panic > 0.3 && !c.parent && Math.hypot(c.target.x - pl.x, c.target.z - pl.z) < Math.hypot(c.pos.x - pl.x, c.pos.z - pl.z) - 2) {
            c.state = 'stand'; c.timer = R(3, 7); c.look = plazaC; c.legs.length = 0; c.shop = release(c.shop);
          }
          break;
        }
        c.timer -= dt;
        if (c.timer <= 0) {
          if (c.state === 'chat' && c.partner) { const o = c.partner; c.partner = null; o.partner = null; if (o.state === 'chat') { o.timer = R(0.5, 2); o.state = 'stand'; o.look = null; } }
          if (c.parent) { c.timer = 1; break; }
          startWalk(c);
        }
        break;
      }
      case 'flee': {
        // stuck (a crowd in a doorway, a collider in the way) or running too long: cower where they are
        c.fleeT = (c.fleeT ?? 0) + dt;
        const g = Math.hypot(c.target.x - c.pos.x, c.target.z - c.pos.z);
        if (g < (c.fleeBest ?? 1e9) - 0.3) { c.fleeBest = g; c.fleeProg = c.fleeT; }
        if (c.fleeT > 14 || c.fleeT - (c.fleeProg ?? 0) > 2.5) {
          c.fleeT = 0; c.fleeBest = undefined; c.fleeProg = 0; c.legs.length = 0;
          if (c.refuge === null && c.refugeYaw === undefined) c.refugeYaw = c.pos.z > 0 ? 0 : Math.PI;
          cower(c);
        }
        break;
      }
      case 'cower': {
        if (d < 1.2 && panic > 0.2) { flee(c); break; }            // the fight came to them: run again
        c.cowerT -= dt;
        if (c.cowerT <= 0 && panic > 0.3) { c.anim?.play('cowerUp', { fade: 0.25 }); c.cowerT = R(4, 9); }
        if (panic < 0.15) { c.calmT = (c.calmT ?? c.calmDelay) - dt; if (c.calmT <= 0) { c.calmT = undefined; getUp(c); } }
        else c.calmT = undefined;
        break;
      }
      default: break;
    }
  }

  // arrival and steering
  function arrive(c) {
    if (c.legs.length > 1) { c.legs.shift(); c.target = c.legs[0]; return false; }
    switch (c.state) {
      case 'walk':
        if (c.shop) { c.state = 'browse'; c.face = c.shop.yaw; c.timer = R(4, 12); c.look = { x: c.shop.x, z: c.shop.z + (c.shop.yaw === 0 ? 3 : -3), y: 1.2 }; }
        else { c.state = 'stand'; c.timer = R(1.5, 6); c.look = rng() < 0.4 ? plazaC : null; }
        break;
      case 'flee': cower(c); break;
      default: break;
    }
    return true;
  }

  function steer(c, dt) {
    let wantV = 0, dx = 0, dz = 0;
    const moving = c.state === 'walk' || c.state === 'flee' || (c.state === 'chat' && c.legs.length);
    if (c.parent && (c.state === 'stand' || c.state === 'walk')) {
      // a child keeps to the parent's side
      const p = c.parent;
      const sx = Math.cos(p.yaw), sz = -Math.sin(p.yaw);
      c.target = { x: p.pos.x + sx * 0.6 - Math.sin(p.yaw) * 0.25, z: p.pos.z + sz * 0.6 - Math.cos(p.yaw) * 0.25 };
      const gx = c.target.x - c.pos.x, gz = c.target.z - c.pos.z, g = Math.hypot(gx, gz);
      if (g > 0.35) { wantV = clamp(g * 1.4, 0.3, 2.2); dx = gx / g; dz = gz / g; c.state = 'walk'; }
      else { c.state = 'stand'; c.timer = 1; c.face = p.yaw; }
    } else if (moving && c.target) {
      const gx = c.target.x - c.pos.x, gz = c.target.z - c.pos.z, g = Math.hypot(gx, gz);
      const spd = c.state === 'flee' ? c.run : c.state === 'chat' ? 0.6 : c.stroll;
      if (g < (c.state === 'flee' ? 0.35 : 0.5)) {
        if (arrive(c)) { if (c.state === 'chat') c.legs.length = 0; }
      } else {
        wantV = spd * clamp(g / (c.state === 'flee' ? 0.8 : 1.2), 0.25, 1); dx = gx / g; dz = gz / g;
      }
    }
    let vx = dx * wantV, vz = dz * wantV;
    // keep clear of the fight (hero, enemies): a strong push out of their radius, a soft one around it
    for (const d of danger) {
      const ex = c.pos.x - d.x, ez = c.pos.z - d.z, e = Math.hypot(ex, ez) || 1e-3, r = d.r ?? 4;
      if (e < r + 1.5) {
        const k = e < r ? (r - e) * 2.2 + 0.8 : (r + 1.5 - e) * 0.6;
        vx += ex / e * k; vz += ez / e * k;
      }
    }
    // soft separation from the others
    for (const o of list) {
      if (o === c) continue;
      const ex = c.pos.x - o.pos.x, ez = c.pos.z - o.pos.z, e2 = ex * ex + ez * ez;
      const rr = c.state === 'flee' || o.state === 'flee' ? 0.75 : 0.9;
      if (e2 < rr * rr && e2 > 1e-6) {
        if ((c.partner === o || c.parent === o || o.parent === c) && e2 > 0.3) continue;
        const e = Math.sqrt(e2), k = (rr - e) / rr * (c.state === 'cower' ? 0.3 : 1.3);
        vx += ex / e * k; vz += ez / e * k;
      }
    }
    // velocity response: brisk when fleeing, lazy when strolling
    const resp = 1 - Math.exp(-dt * (c.state === 'flee' ? 7 : 3.5));
    if (c.state === 'cower') { vx *= 0.3; vz *= 0.3; }
    c.vx += (vx - c.vx) * resp; c.vz += (vz - c.vz) * resp;
    const sp = Math.hypot(c.vx, c.vz), vmax = c.state === 'flee' ? c.run * 1.1 : Math.max(c.stroll, 1.6);
    if (sp > vmax) { c.vx *= vmax / sp; c.vz *= vmax / sp; }
    c.pos.x += c.vx * dt; c.pos.z += c.vz * dt;
    collide(c.pos, 0.32);
    walkClamp(c.pos, c.state === 'flee' || c.state === 'cower');
    c.pos.y = heightAt(c.pos.x, c.pos.z);
    // facing: along the motion while moving, else toward the face target
    const moveSp = Math.hypot(c.vx, c.vz);
    c.stillT = moveSp < 0.15 && c.state !== 'flee' ? (c.stillT ?? 0) + dt : 0;
    let yawT = c.yaw;
    if (moveSp > 0.25 && c.state !== 'cower') yawT = Math.atan2(c.vx, c.vz);
    else if (c.face !== null && c.face !== undefined) yawT = c.face;
    else if (c.look && c.state !== 'walk') yawT = Math.atan2(c.look.x - c.pos.x, c.look.z - c.pos.z);
    const dy = wrapA(yawT - c.yaw);
    const rate = c.state === 'flee' ? 7 : moveSp > 0.25 ? 3.2 : 2.2;
    const step = clamp(dy, -rate * dt, rate * dt) * (moveSp > 0.25 || Math.abs(dy) > 0.35 || c.state === 'cower' ? 1 : 0.25);
    c.yaw = wrapA(c.yaw + step);
    c.yawRate = dt > 0 ? step / dt : 0;
    return moveSp;
  }

  // ------------------------------------------------------------------------------------------------------------
  // per-frame
  // ------------------------------------------------------------------------------------------------------------
  let frame = 0, ms = 0, ticks = 0, clothN = 0, visibleN = 0;
  const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere(new THREE.Vector3(), 1.3);
  const prof = { anim: 0, cloth: 0, n: 0 };
  const cam = app.camera.position;
  const byDist = [];
  const t = { now: 0 };
  let crowdT = 0;
  const crowdEv = { calm: 0, panic: 0, scream: 0, pos: new THREE.Vector3(), call: null, callPos: new THREE.Vector3(), n: 0 };

  function update(dt) {
    const tStart = performance.now();
    frame++;
    t.now += dt;
    // panic: follows the target up at once, decays after a wave
    if (decay > 0) { panicTarget = Math.max(0, panicTarget - dt / decay); if (panicTarget === 0) decay = 0; }
    panic += (panicTarget - panic) * (panicTarget > panic ? 1 : Math.min(1, dt * 3));
    refreshDanger();
    // distance to the camera; the nearest few get cloth
    byDist.length = 0;
    for (const c of list) {
      c.dist = Math.hypot(c.pos.x - cam.x, c.pos.z - cam.z);
      c.clothSim = false;
      byDist.push(c);
    }
    byDist.sort((a, b) => a.dist - b.dist);
    for (let k = 0; k < Math.min(CLOTH_ALL ? 99 : CLOTH_N, byDist.length); k++) if (byDist[k].dist < CLOTH_R || CLOTH_ALL) byDist[k].clothSim = true;

    // bodies finished after the load: shown once the camera isn't looking at their spot (or after a while anyway)
    app.camera.updateMatrixWorld();
    const frustum = _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(app.camera.projectionMatrix, app.camera.matrixWorldInverse));
    for (const c of list) {
      _sph.center.set(c.pos.x, c.pos.y + 0.9, c.pos.z);
      c.inView = frustum.intersectsSphere(_sph);
      if (!c.pending) continue;
      if (loading || c.dist > 42 || !frustum.intersectsSphere(_sph) || performance.now() - tCreate > 25000) reveal(c);
    }

    ticks = 0; clothN = 0; visibleN = 0;
    for (const c of list) {
      c.acc += dt;
      // tick interval by distance (staggered by index); standing citizens tick at half that rate
      let n = c.dist < TIER[0] ? 1 : c.dist < TIER[1] ? 2 : c.hidden ? 8 : c.dist < TIER[2] ? 3 : 4;
      if (c.stillT > 0.6 && !c.hidden) n = Math.min(6, n * 2);
      if (!c.inView && c.dist > 5) n = Math.max(n, 4);
      if ((frame + c.phase) % n !== 0 && c.acc < 0.25) continue;
      const h = c.acc; c.acc = 0;
      if (h <= 0) continue;
      think(c, h);
      const sp = steer(c, h);
      if (!c.ch || c.pending) continue;
      // visibility with hysteresis
      const hide = c.hidden ? c.dist > SHOW : c.dist > HIDE;
      if (hide !== c.hidden) { c.hidden = hide; c.ch.group.visible = !hide; if (!hide) c.fresh = true; }
      if (c.hidden) continue;
      ticks++;
      pose(c, h, sp);
    }
    for (const c of list) if (c.ch && !c.pending && !c.hidden) visibleN++;

    // crowd audio state ~4×/s
    crowdT += dt;
    if (crowdT > 0.25) { crowdT = 0; emitCrowd(); }
    const took = performance.now() - tStart;
    ms = ms * 0.95 + took * 0.05;
    prof.total = (prof.total ?? 0) + took; prof.n++;
  }

  function pose(c, h, sp) {
    const { ch, anim } = c;
    const g = ch.group;
    g.position.copy(c.pos);
    g.rotation.y = c.yaw;
    // locomotion: the animator's gait follows the body speed (forward travel; turns in place while standing)
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
    const lx = c.vx * cy - c.vz * sy, lz = c.vx * sy + c.vz * cy;   // world → local (+z fwd, +x left)
    const l = Math.hypot(lx, lz) || 1;
    anim.setLocomotion({ speed: sp < 0.12 ? 0 : sp, dirX: sp < 0.12 ? 0 : lx / l, dirZ: sp < 0.12 ? 1 : lz / l, combat: false, turn: c.yawRate });
    if (c.look && c.dist < 30) {
      const L = c.look;
      if (L.pos) c.lookV.set(L.pos.x, L.pos.y + 1.5 * (L.ch?.scale ?? 1), L.pos.z);
      else c.lookV.set(L.x, (L.y ?? 1.5) + c.pos.y, L.z);
      anim.lookAt(c.lookV);
    } else anim.lookAt(null);
    // far citizens: no ground tilt for the feet
    anim.feet.normalAt = c.dist < TIER[0] ? normalAt : null;
    const q0 = performance.now();
    anim.update(h, g);
    g.updateMatrixWorld(true);
    const q1 = performance.now();
    prof.anim += q1 - q0;
    // cloth: full sim for the nearest few; a settle period after stopping (a crouch lets the robe fall), then frozen
    // in place while they stay still; rigid on the hips while they move out of the sim set
    const still = sp < 0.15;
    if (!still) c.settle = 0;
    else if (c.clothMode === 'rigid') c.settle = Math.max(c.settle, c.state === 'cower' ? SETTLE : 0.6);
    let mode;
    if (c.fresh || NO_CLOTH) { mode = 'reset'; c.fresh = false; }
    else if (c.clothSim) mode = 'sim';
    else if (still && c.settle > 0) { mode = 'sim'; c.settle -= h; }
    else if (still && (c.clothMode === 'sim' || (c.clothMode === 'frozen' && Math.abs(c.pos.x - c.frozeAt.x) + Math.abs(c.pos.z - c.frozeAt.z) < 0.04 && Math.abs(wrapA(c.yaw - c.frozeAt.yaw)) < 0.04))) mode = 'frozen';
    else mode = 'rigid';
    const cl = ch.cloth;
    // (a settling robe steps at most one 60 Hz substep per tick: cloth.step subdivides long ticks, and the far
    // citizens tick every 2nd/3rd frame; the fall just takes a little longer)
    if (mode === 'sim') { if (c.clothMode === 'rigid' || c.clothMode === 'reset') cl.reset(); cl.step(c.clothSim ? h : Math.min(h, 1 / 60), t.now, c.clothSim && c.dist < 7 ? 1 : 0.5); clothN++; }
    else if (mode === 'frozen') {
      // still: the particles and the node bones stay where the sim left them (until the body moves or turns)
      // (one last step on the way in: it also catches a teleport since the last sim step)
      if (c.clothMode !== 'frozen') { cl.step(Math.min(h, 1 / 60), t.now, 0.5); c.frozeAt.x = c.pos.x; c.frozeAt.z = c.pos.z; c.frozeAt.yaw = c.yaw; }
    }
    else { cl.reset(); cl.writeBones(); }
    c.clothMode = mode;
    prof.cloth += performance.now() - q1;
    // mesh LOD (the ~28% build beyond 9 m) and the character material uniforms (ground contact, wind)
    const lod = ch.lod;
    if (lod?.meshes) {
      const far = lod.on ? c.dist > 7 : c.dist > 9;   // (earlier than the actors' 14 m: a crowd is many bodies)
      if (far !== lod.on) { lod.on = far; for (const m of ch.meshes) m.visible = !far; for (const m of lod.meshes) m.visible = far; }
    }
    // shadows only near the camera (the near shadow map covers ±20 m of the action anyway)
    const shadow = c.dist < 16;
    if (shadow !== c.shadow) { c.shadow = shadow; for (const m of ch.meshes) m.castShadow = shadow; for (const m of lod?.meshes ?? []) m.castShadow = shadow; }
    if (lod?.meshes && !c.lodShared) { c.lodShared = true; if (ch.materials !== shared.M) shareMaterials(lod.meshes); }
    c.skDirty = true;
    if (c === byDist[0]) {
      const U = shared.U;
      U.uContact.value.x = c.pos.y;
      windVector(c.pos.x, c.pos.z, t.now, _w2);
      const cc = Math.cos(-c.yaw), sn = Math.sin(-c.yaw);
      U.uWindLocal.value.set(_w2.x * cc + _w2.y * sn, 0, -_w2.x * sn + _w2.y * cc);
    }
  }

  // the crowd as the audio hears it: calm murmur near the listener, the panic (running, screaming), a vendor's call
  function emitCrowd() {
    let calm = 0, pan = 0, w = 0, scream = 0;
    const P = crowdEv.pos.set(0, 0, 0);
    let callC = null, callD = 1e9;
    for (const c of list) {
      if (!c.ch || c.pending) continue;
      const k = 1 / (1 + Math.max(0, c.dist - 4) * 0.12);   // nearby voices count most
      const calmK = c.state === 'flee' || c.state === 'cower' ? 0 : 1;
      calm += k * calmK;
      if (c.state === 'flee') pan += k;
      else if (c.state === 'cower') pan += k * 0.25;
      if (c.scream > 0) { scream = Math.max(scream, k); c.scream = 0; }
      P.x += c.pos.x * k; P.z += c.pos.z * k; w += k;
      if (calmK && !c.child && (c.state === 'browse' || c.state === 'stand' || c.state === 'chat') && c.dist < callD && c.dist > 3) { callD = c.dist; callC = c; }
    }
    if (w > 0) P.multiplyScalar(1 / w);
    P.y = heightAt(P.x, P.z) + 1.5;
    crowdEv.calm = clamp(calm / 6, 0, 1);
    crowdEv.panic = clamp(pan / 3, 0, 1);
    crowdEv.scream = scream;
    crowdEv.n = list.length;
    if (callC) { crowdEv.callPos.set(callC.pos.x, callC.pos.y + 1.5, callC.pos.z); crowdEv.call = crowdEv.callPos; crowdEv.callKind = callC.kind; }
    else crowdEv.call = null;
    bus.emit('crowd', crowdEv);
  }

  // ------------------------------------------------------------------------------------------------------------
  // panic control + bus
  // ------------------------------------------------------------------------------------------------------------
  function setPanic(k) { panicTarget = clamp(+k || 0, 0, 1); decay = 0; if (panicTarget > panic) panic = panicTarget; }
  const offs = [
    bus.on('wave:start', () => setPanic(1)),
    bus.on('wave:clear', () => { decay = 6; }),
    bus.on('game:state', (p) => { if (p?.state === 'title') { panicTarget = 0; panic = 0; decay = 0; } }),
  ];

  const sys = {
    list, LOOKS, whenBuilt: allBuilt,
    setPanic,
    get panic() { return panic; },
    update,
    stats() {
      const states = {};
      for (const c of list) states[c.state] = (states[c.state] ?? 0) + 1;
      const pr = { anim: +(prof.anim / Math.max(1, prof.n)).toFixed(3), cloth: +(prof.cloth / Math.max(1, prof.n)).toFixed(3), total: +((prof.total ?? 0) / Math.max(1, prof.n)).toFixed(3) };
      prof.anim = prof.cloth = prof.total = 0; prof.n = 0;
      return { prof: pr, count: list.length, ready: readyN, visible: visibleN, ticks, cloth: clothN, ms: +ms.toFixed(3), panic: +panic.toFixed(2), states, buildMs, loadMs: sys.loadMs, looks: LOOKS.length };
    },
    dispose() {
      disposed = true;
      offs.forEach((f) => f());
      app.remove(sys);
      for (const c of list) c.ch?.dispose();
      list.length = 0;
    },
  };
  app.add(sys);
  // wait a little for the bodies (the loader is still up); the rest arrive in the background (see reveal)
  const maxWait = opts.maxWait ?? 2500;
  await Promise.race([allBuilt, new Promise((r) => setTimeout(r, maxWait))]);
  loading = false;
  for (const c of list) if (c.pending) reveal(c);
  sys.loadMs = Math.round(performance.now() - t0);
  return sys;
}
