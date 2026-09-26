// Headless gameplay tests (no browser, no GPU): segment/capsule math, the move table, the player state machine,
// enemy AI + the attack coordinator, and combat resolution (hit, block, perfect parry, i-frames, unblockables,
// posture breaks, kills). Owner: gameplay (P).
//
//   node src/game/test/run.mjs            → exit code 0 when every test passes
//
// The real Character/Animator are replaced by light stand-ins (Actor accepts game.AnimatorClass), so these tests
// exercise only gameplay logic and keep passing while the art areas are being rebuilt.
import * as THREE from 'three';
import { closestSegSeg, pointSegDist2, sweepBladeVsCapsules, wrapAngle, toLocal, toWorld, yawOf, makeRng } from '../util.js';
import { gameMeta, validateMoves, FALLBACK } from '../moves.js';
import { CLIP_NAMES } from '../../character/clips/index.js';
import { Player, PLAYER } from '../player.js';
import { Enemy } from '../enemy.js';
import { Coordinator, think } from '../ai.js';
import { Combat, FEEL } from '../combat.js';

// ------------------------------------------------------------------------------------------------ tiny harness
let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ok   ${name}`); }
  catch (e) { failed++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(c, msg = 'assertion failed') { if (!c) throw new Error(msg); }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------------------------------------ geometry
test('segseg: crossing segments meet at distance 0', () => {
  const d2 = closestSegSeg(V(-1, 0, 0), V(1, 0, 0), V(0, -1, 0), V(0, 1, 0));
  assert(near(d2, 0), `d2=${d2}`);
});
test('segseg: skew segments (distance 1 along z)', () => {
  const c1 = V(), c2 = V();
  const d2 = closestSegSeg(V(-1, 0, 0), V(1, 0, 0), V(0, -1, 1), V(0, 1, 1), c1, c2);
  assert(near(d2, 1), `d2=${d2}`);
  assert(c1.distanceTo(V(0, 0, 0)) < 1e-6 && c2.distanceTo(V(0, 0, 1)) < 1e-6, 'closest points');
});
test('segseg: parallel overlapping segments', () => {
  const d2 = closestSegSeg(V(0, 0, 0), V(2, 0, 0), V(1, 0.5, 0), V(3, 0.5, 0));
  assert(near(d2, 0.25), `d2=${d2}`);
});
test('segseg: endpoint-to-endpoint (clamped both)', () => {
  const d2 = closestSegSeg(V(0, 0, 0), V(1, 0, 0), V(2, 1, 0), V(3, 1, 0));
  assert(near(d2, 2), `d2=${d2}`);
});
test('segseg: degenerate (points)', () => {
  assert(near(closestSegSeg(V(0, 0, 0), V(0, 0, 0), V(0, 3, 4), V(0, 3, 4)), 25));
  assert(near(closestSegSeg(V(0, 0, 0), V(0, 0, 0), V(-1, 1, 0), V(1, 1, 0)), 1));
});
test('segseg agrees with brute force on 300 random pairs', () => {
  const rng = makeRng(7);
  const r = () => V(rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2));
  const a = V(), b = V();
  for (let n = 0; n < 300; n++) {
    const p1 = r(), q1 = r(), p2 = r(), q2 = r();
    const d2 = closestSegSeg(p1, q1, p2, q2);
    let best = Infinity;
    for (let i = 0; i <= 60; i++) for (let j = 0; j <= 60; j++) {
      a.lerpVectors(p1, q1, i / 60); b.lerpVectors(p2, q2, j / 60);
      best = Math.min(best, a.distanceToSquared(b));
    }
    assert(d2 <= best + 1e-9 && best - d2 < 0.02, `pair ${n}: ${d2} vs brute ${best}`);
  }
});
test('pointSeg distance', () => {
  assert(near(pointSegDist2(V(0, 1, 0), V(-1, 0, 0), V(1, 0, 0)), 1));
  assert(near(pointSegDist2(V(3, 0, 0), V(-1, 0, 0), V(1, 0, 0)), 4));
});
test('swept blade: a fast swing that tunnels between frames still hits', () => {
  // body capsule at the origin; the blade is on the left last frame and on the right this frame
  const caps = [{ a: V(0, 0.9, 0), b: V(0, 1.5, 0), r: 0.2, part: 'torso' }];
  const out = { point: V() };
  const hit = sweepBladeVsCapsules(V(-1.2, 1.2, 1.0), V(-1.0, 1.2, -0.2), V(1.2, 1.2, 1.0), V(1.0, 1.2, -0.2), caps, 0.05, out);
  assert(hit, 'no contact');
  assert(hit.part === 'torso' && hit.s > 0 && hit.s < 1, `s=${hit?.s}`);
  assert(Math.abs(out.point.x) < 0.35, `contact x=${out.point.x}`);
});
test('swept blade: a swing that passes above the head misses', () => {
  const caps = [{ a: V(0, 0.9, 0), b: V(0, 1.6, 0), r: 0.2, part: 'torso' }];
  const hit = sweepBladeVsCapsules(V(-1.2, 2.2, 1.0), V(-1.0, 2.2, -0.2), V(1.2, 2.2, 1.0), V(1.0, 2.2, -0.2), caps, 0.05, { point: V() });
  assert(!hit, 'unexpected contact');
});
test('swept blade: earliest contact wins among several capsules', () => {
  const caps = [
    { a: V(0.8, 0.9, 0.4), b: V(0.8, 1.5, 0.4), r: 0.15, part: 'arm' },
    { a: V(-0.8, 0.9, 0.4), b: V(-0.8, 1.5, 0.4), r: 0.15, part: 'head' },
  ];
  const hit = sweepBladeVsCapsules(V(-1.5, 1.2, 0), V(-1.5, 1.2, 1.2), V(1.5, 1.2, 0), V(1.5, 1.2, 1.2), caps, 0.05, { point: V() });
  assert(hit && hit.index === 1, `index=${hit?.index}`);
});
test('angles and local/world frames', () => {
  assert(near(wrapAngle(3 * Math.PI), Math.PI) || near(wrapAngle(3 * Math.PI), -Math.PI));
  assert(near(yawOf(0, 1), 0) && near(Math.abs(yawOf(0, -1)), Math.PI));
  const l = toLocal(1, 0, 0.7, new THREE.Vector2());
  const w = toWorld(l.x, l.y, 0.7, new THREE.Vector2());
  assert(near(w.x, 1) && near(w.y, 0), 'round trip');
  // yaw π/2 faces +X: world +X is local forward
  const f = toLocal(1, 0, Math.PI / 2, new THREE.Vector2());
  assert(near(f.y, 1, 1e-9), `forward=${f.y}`);
});

// ------------------------------------------------------------------------------------------------ move table
test('move table is consistent', () => {
  const bad = validateMoves();
  assert(!bad.length, bad.join('; '));
});
test('gameMeta always yields hit windows for attacks', () => {
  for (const n of ['attack1', 'attack2', 'attack3', 'attack4', 'thrust', 'heavy', 'special', 'enemyAttack1', 'enemyAttack2', 'enemyThrust', 'enemyHeavy']) {
    const m = gameMeta(n);
    assert(m && m.hit.length && m.hit[0][1] > m.hit[0][0], `${n}: ${JSON.stringify(m?.hit)}`);
  }
  assert(gameMeta('enemyHeavy').unblockable, 'enemyHeavy must be unblockable');
  for (const d of ['dodgeF', 'dodgeB', 'dodgeL', 'dodgeR']) assert(gameMeta(d).iframes, `${d} i-frames`);
  for (const n of CLIP_NAMES) assert(gameMeta(n), `no gameplay meta for contract clip ${n}`);
  for (const n of Object.keys(FALLBACK)) assert(CLIP_NAMES.includes(n), `fallback for a non-contract clip ${n}`);
});

// ------------------------------------------------------------------------------------------------ fake world
class FakeAnimator {
  constructor() { this.current = null; this.armed = false; this.events = []; }
  play(name) { this.current = name; }
  stop() { this.current = null; }
  setLocomotion() {}
  setArmed(v) { this.armed = v; }
  update() { return { rootMotion: V(), rootYaw: 0, events: [] }; }
}
function fakeCharacter() {
  const group = new THREE.Group();
  const hand = new THREE.Object3D(); hand.position.set(-0.25, 1.2, 0.35); group.add(hand);
  const base = new THREE.Object3D(); base.position.set(0, 0, 0.1); hand.add(base);
  const tip = new THREE.Object3D(); tip.position.set(0, 0, 0.95); hand.add(tip);
  const caps = [['torso', 0.9, 1.5, 0.22], ['head', 1.55, 1.75, 0.12], ['leg', 0.1, 0.85, 0.12]];
  return {
    group, rig: { bones: {} }, sword: { base, tip, setDrawn() {} }, update() {}, flash() {}, setVisible(v) { group.visible = v; },
    hurtCapsules(out = []) {
      out.length = 0;
      group.updateMatrixWorld(true);
      for (const [part, y0, y1, r] of caps) out.push({ a: V(0, y0, 0).applyMatrix4(group.matrixWorld), b: V(0, y1, 0).applyMatrix4(group.matrixWorld), r, part });
      return out;
    },
  };
}
function makeInput() {
  const b = {};
  for (const a of ['light', 'heavy', 'block', 'dodge', 'sprint', 'lock', 'special', 'draw', 'pause', 'start', 'restart']) b[a] = { down: false, pressed: false, released: false, held: 0 };
  return {
    b, move: new THREE.Vector2(), look: new THREE.Vector2(),
    press(a) { b[a].pressed = true; b[a].down = true; b[a].held = 0; },
    release(a) { b[a].down = false; b[a].released = true; b[a].held = 0; },
    endFrame(dt) { for (const k in b) { b[k].pressed = false; b[k].released = false; if (b[k].down) b[k].held += dt; } },
  };
}
function makeGame() {
  const game = {
    AnimatorClass: FakeAnimator,
    heightAt: () => 0, normalAt: (x, z, o = V()) => o.set(0, 1, 0),
    enemies: [], frame: 0, time: 0, rng: makeRng(3), events: [],
    app: { time: { hitstop(s) { game.hitstops.push(s); }, setScale() {}, scale: 1 }, pipeline: null, world: { colliders: [] } },
    hitstops: [],
    camera: { heading: 0, shake() {}, kickFov() {}, punchFov() {}, microZoom() {}, screenUV(p, o) { return o; }, setMode() {} },
    vfx: null, interaction: null, letterboxT: 0,
    director: { isLastKill: () => false, onKill() {} },
    log(...a) { game.events.push(a.join(' ')); },
    collideStatic() {},
  };
  game.coordinator = new Coordinator({ maxAttackers: 2 });
  game.combat = new Combat(game);
  game.player = new Player(game, fakeCharacter());
  game.player.place(0, 0, 0);          // facing +Z
  return game;
}
function addEnemy(game, kind = 'bandit', x = 0, z = 2.2) {
  const e = new Enemy(game, fakeCharacter(), kind, game.enemies.length + 1);
  game.enemies.push(e);
  e.spawn(x, z, Math.PI); // facing the player (−Z)
  return e;
}
const DT = 1 / 60;
/** Advance the whole fight one frame: think → integrate → pose → combat. */
function step(game, input, n = 1) {
  for (let i = 0; i < n; i++) {
    game.frame++; game.time += DT;
    game.player.think(DT, input);
    const ctx = { player: game.player, rng: game.rng, now: game.time, coordinator: game.coordinator };
    for (const e of game.enemies) if (e.active) think(e, DT, ctx);
    game.player.integrate(DT);
    for (const e of game.enemies) if (e.active) e.integrate(DT);
    game.player.pose(DT, game.time);
    for (const e of game.enemies) if (e.active) e.pose(DT, game.time);
    game.combat.update(DT, DT);
    input.endFrame(DT);
  }
}
const runUntil = (game, input, pred, max = 240) => { for (let i = 0; i < max; i++) { if (pred()) return true; step(game, input); } return pred(); };

// ------------------------------------------------------------------------------------------------ player FSM
test('light press starts attack1; a buffered press inside the combo window chains attack2', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  inp.press('light'); step(g, inp); inp.release('light'); step(g, inp);
  assert(P.state === 'attack' && P.clip === 'attack1', `state=${P.state} clip=${P.clip}`);
  const m = gameMeta('attack1');
  runUntil(g, inp, () => P.clipT >= m.combo[0] - 0.1); // press a little BEFORE the window: the buffer keeps it
  inp.press('light'); step(g, inp); inp.release('light');
  runUntil(g, inp, () => P.clip !== 'attack1', 60);
  assert(P.clip === 'attack2', `clip=${P.clip}`);
});
test('combo runs attack1 → 2 → 3 → 4 and returns to locomotion', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  const seen = [];
  for (let k = 0; k < 4; k++) {
    inp.press('light'); step(g, inp); inp.release('light');
    runUntil(g, inp, () => P.clip && !seen.includes(P.clip), 60);
    seen.push(P.clip);
    const m = gameMeta(P.clip);
    if (m.combo) runUntil(g, inp, () => P.clipT >= m.combo[0] + 0.02);
  }
  assert(seen.join() === 'attack1,attack2,attack3,attack4', seen.join());
  runUntil(g, inp, () => P.state === 'loco', 120);
  assert(P.state === 'loco');
});
test('holding light charges, releasing fires a heavy', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  inp.press('light');
  runUntil(g, inp, () => P.state === 'charge', 60);
  assert(P.state === 'charge', `state=${P.state}`);
  step(g, inp, 50);
  inp.release('light'); step(g, inp, 2);
  assert(P.state === 'attack' && P.clip === 'heavy' && P.strike.charge > 0.3, `state=${P.state} clip=${P.clip}`);
});
test('dodge grants i-frames inside the window only', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  inp.move.set(1, 0);
  inp.press('dodge'); step(g, inp); inp.release('dodge');
  assert(P.state === 'dodge', `state=${P.state}`);
  const iw = gameMeta(P.clip).iframes;
  let sawI = false, sawAfter = false;
  for (let i = 0; i < 60 && P.state === 'dodge'; i++) {
    step(g, inp);
    if (P.clipT > iw[0] + 0.02 && P.clipT < iw[1] - 0.02) sawI ||= P.iframes;
    if (P.clipT > iw[1] + 0.02) sawAfter ||= P.iframes;
  }
  assert(sawI && !sawAfter, `in=${sawI} after=${sawAfter}`);
});
test('the special needs a full focus meter', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  inp.press('special'); step(g, inp); inp.release('special'); step(g, inp);
  assert(P.state === 'loco', 'special fired without focus');
  P.focus = PLAYER.focusMax;
  inp.press('special'); step(g, inp); inp.release('special'); step(g, inp);
  assert(P.state === 'special' && P.focus === 0, `state=${P.state} focus=${P.focus}`);
});
test('attacking while sheathed draws first, then swings', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  P.setDrawn(false);
  inp.press('light'); step(g, inp); inp.release('light'); step(g, inp);
  assert(P.state === 'draw', `state=${P.state}`);
  runUntil(g, inp, () => P.state === 'attack', 90);
  assert(P.drawn && P.clip === 'attack1', `drawn=${P.drawn} clip=${P.clip}`);
});

// ------------------------------------------------------------------------------------------------ AI
test('coordinator hands out at most N tokens, spaced in time', () => {
  const c = new Coordinator({ maxAttackers: 2, spacing: 0.5 });
  const a = { token: false }, b = { token: false }, d = { token: false };
  assert(c.request(a, 0) && !c.request(b, 0.1) && c.request(b, 0.6) && !c.request(d, 5), 'grant pattern');
  c.release(a);
  assert(c.request(d, 6) && c.attackers === 2);
});
test('three bandits: never more than two committed attackers', () => {
  const g = makeGame(), inp = makeInput();
  g.player.invulnerable = true;
  for (let k = 0; k < 3; k++) addEnemy(g, 'bandit', Math.sin(k * 2) * 5, Math.cos(k * 2) * 5);
  let maxAtk = 0, attacks = 0, prev = new Set();
  for (let i = 0; i < 60 * 20; i++) {
    step(g, inp);
    let n = 0;
    for (const e of g.enemies) if (e.state === 'attack' || e.state === 'close') { n++; if (!prev.has(e) && e.state === 'attack') attacks++; }
    prev = new Set(g.enemies.filter((e) => e.state === 'attack'));
    maxAtk = Math.max(maxAtk, n);
  }
  assert(maxAtk <= 2, `max attackers ${maxAtk}`);
  assert(attacks >= 4, `only ${attacks} attacks in 20 s`);
});
test('enemy strikes telegraph ≥ 0.3 s before the first hit frame', () => {
  const g = makeGame(), inp = makeInput();
  g.player.invulnerable = true;
  const e = addEnemy(g, 'bandit', 0, 2.0);
  let tele = -1, lead = -1;
  const off = [];
  g.combat.telegraph = (en) => { tele = g.time; lead = en.strikeETA(); off.push(lead); };
  e.state = 'circle'; e.brain = null; step(g, inp);
  e.beginChain(['enemyAttack1']);
  runUntil(g, inp, () => tele > 0, 120);
  assert(tele > 0 && lead >= 0.3, `lead=${lead}`);
});

// ------------------------------------------------------------------------------------------------ combat resolution
function strikePlayer(g, e, clip = 'enemyAttack1') {
  e.state = 'circle'; e.brain ??= { cooldown: 99, radius: 3, dir: 1, switchT: 9, slotAngle: 0, tauntDone: true };
  e.brain.cooldown = 99;
  e.beginChain([clip]);
}
test('an unguarded strike hurts the player', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  const e = addEnemy(g, 'bandit', 0, 1.8);
  strikePlayer(g, e);
  runUntil(g, inp, () => P.hp < P.maxHp, 120);
  assert(P.hp < P.maxHp && P.state === 'react', `hp=${P.hp} state=${P.state}`);
});
test('holding block (pressed early) blocks: posture, no damage', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  const e = addEnemy(g, 'bandit', 0, 1.8);
  inp.press('block'); step(g, inp);
  assert(P.state === 'block');
  strikePlayer(g, e);
  runUntil(g, inp, () => P.posture > 0 || P.hp < P.maxHp, 120);
  assert(P.hp === P.maxHp && P.posture > 0, `hp=${P.hp} posture=${P.posture}`);
});
test('block pressed just before impact is a perfect parry (enemy recoils, focus gained)', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  const e = addEnemy(g, 'bandit', 0, 1.8);
  strikePlayer(g, e);
  runUntil(g, inp, () => e.strikeETA() >= 0 && e.strikeETA() <= 0.08, 120);
  inp.press('block');
  runUntil(g, inp, () => P.state === 'parry' || P.hp < P.maxHp, 30);
  assert(P.state === 'parry' && P.hp === P.maxHp, `state=${P.state} hp=${P.hp}`);
  assert(e.state === 'react' || e.state === 'stagger', `enemy=${e.state}`);
  assert(P.focus >= FEEL.focus.parry, `focus=${P.focus}`);
});
test('a dodge through the strike evades it (i-frames)', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  const e = addEnemy(g, 'bandit', 0, 1.8);
  strikePlayer(g, e);
  runUntil(g, inp, () => e.strikeETA() >= 0 && e.strikeETA() <= 0.1, 120);
  inp.press('dodge'); step(g, inp); inp.release('dodge');
  step(g, inp, 30);
  assert(P.hp === P.maxHp, `hp=${P.hp}`);
});
test('unblockable heavies go through a guard', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  const e = addEnemy(g, 'bandit_heavy', 0, 1.9);
  inp.press('block'); step(g, inp);
  strikePlayer(g, e, 'enemyHeavy');
  runUntil(g, inp, () => P.hp < P.maxHp, 180);
  assert(P.hp < P.maxHp, 'guard held against an unblockable');
});
test('player blade hits a bandit in reach; kills put it in the dead state', () => {
  const g = makeGame(), inp = makeInput(), P = g.player;
  const e = addEnemy(g, 'bandit', 0, 1.6);
  e.state = 'recover'; e.brain = { recoverT: 99, cooldown: 99 };
  inp.press('light'); step(g, inp); inp.release('light');
  runUntil(g, inp, () => e.hp < e.maxHp, 60);
  assert(e.hp < e.maxHp, 'no hit');
  e.hp = 1;
  runUntil(g, inp, () => P.state === 'loco', 90);
  inp.press('light'); step(g, inp); inp.release('light');
  runUntil(g, inp, () => !e.alive, 60);
  assert(!e.alive && e.state === 'dead', `alive=${e.alive} state=${e.state}`);
});
test('posture break staggers, and staggered enemies take bonus damage', () => {
  const g = makeGame(), P = g.player;
  const e = addEnemy(g, 'bandit', 0, 1.6);
  const res = e.onHit({ damage: 1, posture: e.maxPosture + 1, dirX: 0, dirZ: 1 });
  assert(res === 'stagger' && e.state === 'stagger', `res=${res}`);
  const hp = e.hp;
  g.combat.playerHits(P, e, V(0, 1.2, 1.4), 'torso', { damage: 10, posture: 0, kind: 'light', reach: 2, arc: 1 });
  assert(near(hp - e.hp, 15), `damage ${hp - e.hp}`);
});

// ------------------------------------------------------------------------------------------------ report
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
