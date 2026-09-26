// Demo autopilot (?demo=1): plays the swordsman through the virtual input so harness screenshots and soak tests
// show real combat. Seeks and locks the nearest bandit, fights in short combos, parries telegraphed strikes (most
// of the time, timed ~90 ms before impact), dodges unblockable heavies, blocks some, uses heavies and the sword-qi
// special when focus is full. It only presses buttons — every rule of the game still applies. Owner: gameplay (P).
import { makeRng, wrapAngle, yawOf } from './util.js';

export class Autopilot {
  constructor(game, { seed = 99, skill = 0.8 } = {}) {
    this.game = game;
    this.rng = makeRng(seed);
    this.skill = skill;
    this.t = 0;
    this.nextAttack = 0;
    this.comboLeft = 0;
    this.backoff = 0;
    this.plan = null;          // pending defence { at, kind, until }
    this.holdBlockUntil = -1;
    this.holdLightUntil = -1;
    this.lastEnemyClip = new Map();
    this.strafe = 1; this.strafeT = 0;
    this.target = null;
    game.input.virtual.active = true;
  }

  stop() { const v = this.game.input.virtual; v.clear(); v.active = false; }

  update(dt) {
    const g = this.game, v = g.input.virtual, P = g.player;
    this.t += dt;
    v.active = true;
    v.setMove(0, 0);
    if (g.state === 'title') { if (this.t > 1.2) v.press('start'); return; }
    if (!P.alive || g.state !== 'playing') { v.hold('block', false); v.hold('light', false); return; }
    // let the wave-intro shot play out (a human skips it by moving)
    if (g.camera.mode === 'intro' || g.director.state === 'prewave') return;

    // releases of timed holds
    if (this.holdBlockUntil >= 0 && this.t >= this.holdBlockUntil) { v.hold('block', false); this.holdBlockUntil = -1; }
    if (this.holdLightUntil >= 0 && this.t >= this.holdLightUntil) { v.hold('light', false); this.holdLightUntil = -1; }

    // target: the nearest live enemy, preferring the ones toward the sun (the demo keeps its fights contre-jour)
    const sunH = g.camera.sunHeading;
    let tgt = null, best = Infinity, bestScore = Infinity;
    for (const e of g.enemies) {
      if (!e.alive || !e.active) continue;
      const d = P.distTo(e);
      // hysteresis: the current target keeps a 2.5 m bonus so the lock does not flicker between bandits
      const score = d + Math.abs(wrapAngle(yawOf(e.pos.x - P.pos.x, e.pos.z - P.pos.z) - sunH)) * 1.6 - (e === this.target ? 2.5 : 0);
      if (score < bestScore) { bestScore = score; tgt = e; }
      best = Math.min(best, d);
    }
    this.target = tgt;
    best = tgt ? P.distTo(tgt) : best;
    if (!tgt) { if (P.lock) v.press('lock'); return; }
    // lock-on: the Q press for a fresh lock; switching targets goes straight through lockOn (a human double-taps Q)
    if (!P.lock && best < 20 && P.drawn) v.press('lock');
    else if (P.lock && P.lock !== tgt && best < 20) P.lockOn(tgt);

    // ---- defence: read the most imminent incoming strike
    let threat = null, eta = Infinity;
    for (const e of g.enemies) {
      if (!e.alive || e.state !== 'attack' || !e.strike) continue;
      const t = e.strikeETA();
      if (t < 0) continue;
      if (P.distTo(e) > (e.strike.reach ?? 2) + 2.2) continue;
      if (t < eta) { eta = t; threat = e; }
    }
    if (threat) {
      const key = threat.id + ':' + threat.swingId;
      if (this.plan?.key !== key) {
        const r = this.rng.next();
        const kind = threat.strike.unblockable ? 'dodge' : r < this.skill * 0.8 ? 'parry' : r < 0.9 ? 'block' : 'dodge';
        this.plan = { key, kind, done: false };
      }
      const pl = this.plan;
      if (!pl.done) {
        if (pl.kind === 'parry' && eta <= 0.09 + this.rng.range(-0.02, 0.03)) {
          v.hold('block', true); this.holdBlockUntil = this.t + 0.22; pl.done = true;
        } else if (pl.kind === 'block' && eta <= 0.35) {
          v.hold('block', true); this.holdBlockUntil = this.t + 0.6; pl.done = true;
        } else if (pl.kind === 'dodge' && eta <= 0.22) {
          // sidestep across the strike line
          const side = this.rng.sign();
          v.setMove(side, -0.3);
          v.press('dodge'); pl.done = true;
        }
      }
      if (eta < 0.5) return; // stand ready, don't walk into it
    }

    // ---- offence
    const d = P.distTo(tgt);
    const facingErr = Math.abs(wrapAngle(yawOf(tgt.pos.x - P.pos.x, tgt.pos.z - P.pos.z) - (g.camera.heading)));
    if (this.backoff > 0) {
      this.backoff -= dt;
      v.setMove(this.strafe * 0.6, -0.7);
      return;
    }
    if (P.focus >= 100 && d < 9 && P.state === 'loco') { v.press('special'); return; }
    if (d > 2.4) {
      const sprint = d > 10;
      v.setMove(0, 1);
      if (facingErr > 0.6 && !P.lock) v.setMove(Math.sign(wrapAngle(yawOf(tgt.pos.x - P.pos.x, tgt.pos.z - P.pos.z) - g.camera.heading)) * -0.6, 0.8);
      v.hold('sprint', sprint);
      if (d < 3.6 && this.t > this.nextAttack && tgt.state !== 'block' && this.rng.chance(0.03)) { v.press('light'); this.nextAttack = this.t + 0.6; }
      return;
    }
    v.hold('sprint', false);
    // in range: short combos with pauses; mix in heavies against guards and staggered foes
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafe = this.rng.sign(); this.strafeT = this.rng.range(1, 2.5); }
    if (this.t < this.nextAttack) {
      // between combos, circle so the target drifts toward the sun (strafing right raises its bearing)
      const off = wrapAngle(sunH - yawOf(tgt.pos.x - P.pos.x, tgt.pos.z - P.pos.z));
      v.setMove(Math.abs(off) > 0.35 ? Math.sign(off) * 0.55 : this.strafe * 0.35, 0);
      return;
    }
    if (tgt.state === 'stagger' || tgt.state === 'block') {
      v.hold('light', true); this.holdLightUntil = this.t + 0.55; this.nextAttack = this.t + 1.3; return;
    }
    if (this.comboLeft <= 0) this.comboLeft = 2 + Math.floor(this.rng.next() * 3);
    if (P.state === 'loco' || (P.state === 'attack' && P.clipU > 0.3)) {
      v.press('light');
      this.comboLeft--;
      this.nextAttack = this.t + (this.comboLeft > 0 ? 0.26 : 0.9);
      if (this.comboLeft <= 0 && this.rng.chance(0.35)) this.backoff = 0.5;
    }
  }
}
