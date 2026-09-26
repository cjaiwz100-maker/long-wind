// Player: the swordsman's controller and combat state machine, driven by CLIPS meta. Owner: gameplay (P).
//
// States: loco · draw · sheathe · attack · charge · dodge · block · parry · react · special · dead · victory
//  - camera-relative movement with acceleration and turn rate; walk 1.6 / run 5.2 / light-foot sprint 8.5 m/s
//  - light combo attack1→2→3→4 with a 0.4 s input buffer and CLIPS combo windows; LMB hold → heavy charge (leap
//    cleave); sprint/dodge + LMB → thrust; E → sword-qi special when focus is full
//  - dodge with i-frames (meta.iframes), cancels after meta.cancel; block (RMB hold) and perfect parry (RMB pressed
//    ≤ 150 ms before impact); hit reactions, guard break, death; draw/sheathe (attacking while sheathed draws first)
// Displacement for attacks/dodges/reactions is gameplay-driven from meta.lunge (target-aware magnetism), so combat
// stays consistent whatever the animator does with root motion.
import * as THREE from 'three';
import { Actor, meta, hitWindow } from './actor.js';
import { clamp, wrapAngle, yawOf, expK, stepAngle } from './util.js';
import { bus } from '../core/bus.js';

export const PLAYER = {
  hp: 120, posture: 100, focusMax: 100,
  walk: 1.6, run: 5.2, combatRun: 4.4, sprint: 8.5,
  accel: 11, decel: 14, turnRate: 13, lockTurnRate: 10,
  holdHeavy: 0.24,         // LMB held this long → heavy charge
  buffer: 0.42,            // input buffer (sim s)
  parryWindow: 0.15,       // RMB press within this before impact = perfect parry
  dodgeDist: { dodgeF: 3.6, dodgeB: 3.0, dodgeL: 3.1, dodgeR: 3.1 },
  combo: ['attack1', 'attack2', 'attack3', 'attack4'],
  // the 4th light alternates finishers so chains don't repeat; the aerial flurry chains into the somersault cleave
  finishers: ['attack4', 'airFlurry'],
  chain: { airFlurry: 'flipCleave' },
  magnet: 5.0,             // soft-target radius for attacks
  gap: 1.4,                // ideal distance to the target at impact (blade-length spacing reads best)
};

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _fwd = new THREE.Vector3();

export class Player extends Actor {
  constructor(game, ch) {
    super(game, ch, { id: 'player', kind: 'hero', team: 0, hp: PLAYER.hp, posture: PLAYER.posture, radius: 0.4 });
    this.state = 'loco';
    this.drawn = true;
    this.comboIdx = -1;
    this.clock = 0;
    this.buf = { light: -9, heavy: -9, dodge: -9, special: -9, thrust: -9 };
    this.lightArmed = false;
    this.blockPressT = -9;
    this.blocking = false;
    this.iframes = false;
    this.focus = 0;
    this.sprinting = false;
    this.moveDir = new THREE.Vector3();
    this.moveMag = 0;
    this.lastDodgeEnd = -9;
    this.after = null;             // action queued after draw
    this.chargeT = 0; this.chargeLevel = 0; this.chargeReadyFx = false;
    this.lock = null;              // locked enemy (Actor) or null
    this.attackTarget = null;
    this.strike = null;            // active strike description (read by combat)
    this.riposte = 0;              // sim time until which attacks get the riposte bonus
    this.inCombat = false;
    this.controlEnabled = true;
    this.invulnerable = false;     // cinematic / debug
  }

  setDrawn(v) {
    this.drawn = v;
    try { this.ch.sword.setDrawn(v); } catch { /* optional */ }
    try { this.anim.setArmed?.(v); } catch { /* optional */ }
  }

  gainFocus(v) {
    const before = this.focus;
    this.focus = clamp(this.focus + v, 0, PLAYER.focusMax);
    if (this.focus !== before) bus.emit('player:focus', { value: this.focus, max: PLAYER.focusMax });
  }

  // ------------------------------------------------------------------------------------------------------------
  /** Read input, run the state machine, set velocity / facing / locomotion. */
  think(dt, input) {
    this.clock += dt;
    const b = input.b;
    const ctl = this.controlEnabled && this.state !== 'dead' && this.state !== 'victory';
    if (ctl) {
      if (b.light.pressed) { this.lightArmed = true; }
      if (this.lightArmed) {
        if (!b.light.down) { this.lightArmed = false; this.buf.light = this.clock; }
        else if (b.light.held >= PLAYER.holdHeavy) { this.lightArmed = false; this.buf.heavy = this.clock; this.heavyHold = true; }
      }
      if (b.heavy.pressed) { this.buf.heavy = this.clock; this.heavyHold = b.heavy.down; }
      if (b.dodge.pressed) this.buf.dodge = this.clock;
      if (b.special.pressed) this.buf.special = this.clock;
      if (b.block.pressed) this.blockPressT = this.clock;
    }
    this._readMove(input);
    this.sprinting = false;
    switch (this.state) {
      case 'loco': this._loco(dt, input); break;
      case 'draw': case 'sheathe': this._drawing(dt, input); break;
      case 'attack': this._attack(dt, input); break;
      case 'charge': this._charge(dt, input); break;
      case 'dodge': this._dodge(dt, input); break;
      case 'block': this._block(dt, input); break;
      case 'parry': this._parry(dt, input); break;
      case 'react': this._react(dt, input); break;
      case 'special': this._special(dt, input); break;
      case 'execute': this._execute(dt, input); break;
      case 'dead': this._brake(dt); this._endAt(null); break;
      case 'victory': this._brake(dt); this._victory(dt); break;
    }
    this.iframes = this.state === 'dodge' && this._inIframes();
    const turn = this.turnRate(dt);
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.setLocomotion(sp, this.vel.x, this.vel.z, this.drawn, turn);
  }

  want(k, win = PLAYER.buffer) { return this.clock - this.buf[k] <= win; }
  consume(k) { this.buf[k] = -9; }

  _readMove(input) {
    const h = this.game.camera?.heading ?? this.yaw;
    const mx = input.move.x, my = input.move.y;
    const fx = Math.sin(h), fz = Math.cos(h), rx = -Math.cos(h), rz = Math.sin(h);
    this.moveDir.set(fx * my + rx * mx, 0, fz * my + rz * mx);
    this.moveMag = Math.min(1, this.moveDir.length());
    if (this.moveMag > 1e-3) this.moveDir.divideScalar(this.moveDir.length() || 1);
    if (!this.controlEnabled) this.moveMag = 0;
  }

  _brake(dt, rate = PLAYER.decel) {
    const k = expK(rate, dt);
    this.vel.x -= this.vel.x * k; this.vel.z -= this.vel.z * k;
  }

  _steer(dt, maxSpeed, input, { allowSprint = true, faceMove = true } = {}) {
    const mag = this.moveMag;
    let speed = 0;
    if (mag > 0.05) {
      const run = this.inCombat || this.lock ? PLAYER.combatRun : PLAYER.run;
      speed = mag < 0.6 ? PLAYER.walk * mag / 0.6 : PLAYER.walk + (run - PLAYER.walk) * (mag - 0.6) / 0.4;
      if (allowSprint && input.b.sprint.down && mag > 0.5) { speed = PLAYER.sprint; this.sprinting = true; }
      speed = Math.min(speed, maxSpeed);
    }
    const tx = this.moveDir.x * speed, tz = this.moveDir.z * speed;
    const accel = speed > Math.hypot(this.vel.x, this.vel.z) ? PLAYER.accel : PLAYER.decel;
    const k = expK(this.sprinting ? 6 : accel, dt);
    this.vel.x += (tx - this.vel.x) * k; this.vel.z += (tz - this.vel.z) * k;
    // facing
    if (this.lock && !this.sprinting && this.lock.alive) {
      this.faceTowards(this.lock.pos.x, this.lock.pos.z, PLAYER.lockTurnRate, dt);
    } else if (faceMove && speed > 0.2) {
      const target = yawOf(this.moveDir.x, this.moveDir.z);
      this.yaw = stepAngle(this.yaw, target, PLAYER.turnRate * dt * (this.sprinting ? 0.7 : 1));
    }
  }

  // ---------------------------------------------------------------- states
  _loco(dt, input) {
    this._steer(dt, 99, input);
    this._tryActions(input, true);
  }

  /** Start whatever the buffered input asks for. Returns true if an action started. */
  _tryActions(input, fromLoco) {
    const b = input.b;
    if (this.want('dodge', 0.25)) { this.consume('dodge'); this.startDodge(); return true; }
    if (this.drawn && this.want('light')) { const ex = this.executableTarget(); if (ex) { this.consume('light'); this.startExecute(ex); return true; } }
    if (this.want('special', 0.3) && this.focus >= PLAYER.focusMax) {
      this.consume('special');
      if (!this.drawn) return this.startDraw('special'), true;
      this.startSpecial(); return true;
    }
    if (this.want('heavy')) {
      this.consume('heavy');
      if (!this.drawn) return this.startDraw(this.heavyHold ? 'charge' : 'heavy'), true;
      if (this.heavyHold && (b.light.down || b.heavy.down)) this.startCharge();
      else this.startHeavy(0);
      return true;
    }
    if (this.want('light')) {
      this.consume('light');
      if (!this.drawn) { this.startDraw('light'); return true; }
      const dashAttack = (fromLoco && Math.hypot(this.vel.x, this.vel.z) > 6.5) || this.clock - this.lastDodgeEnd < 0.35;
      this.startAttack(dashAttack ? 'thrust' : PLAYER.combo[0]);
      return true;
    }
    if (b.block.down) {
      if (!this.drawn) { this.startDraw('block'); return true; }
      this.startBlock(); return true;
    }
    if (b.draw.pressed) {
      if (this.drawn) this.startSheathe(); else this.startDraw(null);
      return true;
    }
    return false;
  }

  _endAt(next = 'loco') {
    if (!this.clipMeta || this.clipLoop) return false;
    if (this.clipT >= this.clipMeta.duration) {
      if (next) { this.state = next; this.stopAction(0.2); this.strike = null; }
      return true;
    }
    return false;
  }

  // draw / sheathe --------------------------------------------------------------------------------------------
  startDraw(after = null) {
    this.after = after;
    this.state = 'draw';
    this.play('draw', { fade: 0.08, speed: after ? 1.8 : 1.15 });
  }
  startSheathe() {
    this.after = null;
    this.state = 'sheathe';
    this.play('sheathe', { fade: 0.12, speed: 1 });
    this.lockOn(null);
  }
  _drawing(dt, input) {
    this._steer(dt, PLAYER.walk, input, { allowSprint: false });
    this._brake(dt, 6);
    const u = this.clipU;
    if (this.state === 'draw' && !this.drawn && u >= 0.42) this.setDrawn(true);
    if (this.state === 'sheathe' && this.drawn && u >= 0.68) this.setDrawn(false);
    if (this.state === 'draw' && this.after && u >= 0.62) {
      const a = this.after; this.after = null;
      if (!this.drawn) this.setDrawn(true);
      if (a === 'light') return this.startAttack(PLAYER.combo[0]);
      if (a === 'heavy') return this.startHeavy(0);
      if (a === 'charge') return (input.b.light.down || input.b.heavy.down) ? this.startCharge() : this.startHeavy(0);
      if (a === 'special') return this.startSpecial();
      if (a === 'block') return input.b.block.down ? this.startBlock() : this._toLoco();
    }
    if (this.want('dodge', 0.2) && u > 0.3) { this.consume('dodge'); if (this.state === 'draw') this.setDrawn(true); return this.startDodge(); }
    this._endAt('loco');
  }
  _toLoco() { this.state = 'loco'; this.stopAction(0.18); this.strike = null; }

  // attacks ---------------------------------------------------------------------------------------------------
  /** Soft target: the lock target, else the best enemy in the input/facing cone within the magnet radius. */
  pickTarget(maxDist = PLAYER.magnet) {
    if (this.lock?.alive && !this.lock.hidden && this.distTo(this.lock) < maxDist + 2) return this.lock;
    const dirYaw = this.moveMag > 0.3 ? yawOf(this.moveDir.x, this.moveDir.z) : this.yaw;
    let best = null, bestScore = Infinity;
    for (const e of this.game.enemies) {
      if (!e.alive || !e.active || e.hidden) continue;
      const d = this.distTo(e);
      if (d > maxDist) continue;
      const a = Math.abs(wrapAngle(yawOf(e.pos.x - this.pos.x, e.pos.z - this.pos.z) - dirYaw));
      if (a > 1.6) continue;
      const score = d + a * 2.2;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  startAttack(name, { speed = 1, dmgMul = 1 } = {}) {
    const m = meta(name);
    if (!m) return this._toLoco();
    const target = this.pickTarget();
    this.attackTarget = target;
    if (target) {
      // snap most of the turn immediately (readable), finish it during the startup
      const want = yawOf(target.pos.x - this.pos.x, target.pos.z - this.pos.z);
      this.yaw = stepAngle(this.yaw, want, 1.2);
    } else if (this.moveMag > 0.3) {
      this.yaw = stepAngle(this.yaw, yawOf(this.moveDir.x, this.moveDir.z), 1.4);
    }
    this.state = 'attack';
    this.comboIdx = PLAYER.finishers.includes(name) ? PLAYER.combo.length - 1 : PLAYER.combo.indexOf(name);
    this.play(name, { fade: 0.06, speed });
    // airborne moves: gameplay hop over the authored leap span
    this.leap = m.leap && m.leap.h > 0.2 ? { t0: m.leap.t0, t1: m.leap.t1, h: m.leap.h } : null;
    const hw = m.hit?.[0] ?? [m.duration * 0.3, m.duration * 0.45];
    let lunge = m.lunge ?? 0.5;
    if (target) {
      const d = this.distTo(target);
      const gap = PLAYER.gap + (m.type === 'thrust' ? 0.35 : 0);
      if (d < 6) lunge = clamp(d - gap, 0, Math.max(lunge * 1.8, 2.2));
    }
    this.startLunge(this.forward(_fwd), lunge, 0, hw[0] + 0.03, target?.pos ?? null, 1.15);
    this.vel.multiplyScalar(0.3);
    this._makeStrike(name, m, dmgMul);
    bus.emit('player:attack', { clip: name, heavy: m.type === 'heavy' });
  }

  startHeavy(level = 0) {
    const m = meta('heavy');
    const target = this.pickTarget(6.5);
    this.attackTarget = target;
    if (target) this.yaw = yawOf(target.pos.x - this.pos.x, target.pos.z - this.pos.z);
    this.state = 'attack';
    this.comboIdx = -1;
    this.play('heavy', { fade: 0.06, speed: 1 });
    const hw = m.hit?.[0] ?? [0.3, 0.45];
    let lunge = Math.max(m.lunge ?? 1.6, 2.5);
    if (target) lunge = clamp(this.distTo(target) - PLAYER.gap, 0, 3.4);
    this.startLunge(this.forward(_fwd), lunge, 0.02, hw[0], target?.pos ?? null, 1.15);
    const lh = m.leap?.h ?? 0.55;   // the 居合 draw-cut is a low dash, not a leap
    this.leap = { t0: 0.04, t1: hw[0], h: lh + (lh > 0.2 ? 0.15 * level : 0.02 * level) };
    this.vel.set(0, 0, 0);
    this._makeStrike('heavy', m, 1 + 0.45 * level);
    this.strike.charge = level;
    bus.emit('player:attack', { clip: 'heavy', heavy: true, charge: level });
  }

  startCharge() {
    this.state = 'charge';
    this.chargeT = 0; this.chargeReadyFx = false;
    this.play('heavyCharge', { fade: 0.1, loop: true });
    this.strike = null;
  }

  _charge(dt, input) {
    this._brake(dt, 10);
    this.chargeT += dt;
    const tgt = this.lock?.alive ? this.lock : this.pickTarget(7);
    if (tgt) this.faceTowards(tgt.pos.x, tgt.pos.z, 4, dt);
    else if (this.moveMag > 0.3) this.yaw = stepAngle(this.yaw, yawOf(this.moveDir.x, this.moveDir.z), 3 * dt);
    if (!this.chargeReadyFx && this.chargeT > 0.75) {
      this.chargeReadyFx = true;
      this.game.combat?.chargeReady(this);
    }
    const held = input.b.light.down || input.b.heavy.down;
    if (!held || this.chargeT > 1.6) this.startHeavy(clamp((this.chargeT - 0.15) / 0.6, 0, 1));
    else if (this.want('dodge', 0.2)) { this.consume('dodge'); this.startDodge(); }
  }

  _makeStrike(name, m, dmgMul = 1) {
    this.swingId++;
    this.hitSet.clear();
    const kind = m.type === 'heavy' ? 'heavy' : m.type === 'thrust' ? 'thrust' : m.type === 'special' ? 'special' : 'light';
    const riposte = this.clock < this.riposte;
    this.strike = {
      clip: name, kind, windows: m.hit ?? [], damage: (m.damage || 18) * dmgMul * (riposte ? 1.35 : 1),
      posture: (m.posture || 12) * dmgMul * (riposte ? 1.6 : 1), reach: m.reach || 2, arc: kind === 'thrust' ? 0.55 : kind === 'light' ? 0.95 : 1.15,
      unblockable: !!m.unblockable, bladeR: kind === 'heavy' ? 0.1 : 0.075, swing: this.swingId, contacts: 0, riposte,
      whoosh: false, trail: false, cutFrom: null,
    };
  }

  _attack(dt, input) {
    this._brake(dt, 12);
    const m = this.clipMeta;
    if (!m) return this._toLoco();
    const hw = m.hit?.[0] ?? [m.duration * 0.3, m.duration * 0.45];
    const tgt = this.attackTarget;
    // track the target during the startup (committed once the blade is live)
    if (tgt?.alive && this.clipT < hw[0]) this.faceTowards(tgt.pos.x, tgt.pos.z, 9, dt);
    // heavy leap
    if (this.leap && (this.clip === 'heavy' || this.clipMeta?.leap)) {
      const L = this.leap;
      const u = clamp((this.clipT - L.t0) / (L.t1 - L.t0), 0, 1);
      this.hop = u > 0 && u < 1 ? L.h * 4 * u * (1 - u) : 0;
      if (u >= 1) { this.leap = null; this.hop = 0; this.game.combat?.heavyLanding(this); }
    }
    // combo chaining (buffered presses, CLIPS combo window)
    const c = m.combo;
    if (this.want('light') && this.clipT >= (c?.[0] ?? m.cancel ?? 0)) {
      const ex = this.executableTarget();
      if (ex) { this.consume('light'); return this.startExecute(ex); }
    }
    if (c && this.clipT >= c[0] && this.clipT <= c[1] + 0.08) {
      if (this.want('light')) {
        this.consume('light');
        const chained = PLAYER.chain[this.clip];
        if (chained) return this.startAttack(chained);
        const i = this.clip === 'thrust' ? 1 : this.comboIdx;
        let next = PLAYER.combo[Math.min(i + 1, PLAYER.combo.length - 1)];
        if (i + 1 === PLAYER.combo.length - 1) next = PLAYER.finishers[this.finisherN = ((this.finisherN ?? -1) + 1) % PLAYER.finishers.length];
        if (i >= 0 && i < PLAYER.combo.length - 1) return this.startAttack(next);
        if (this.clip === 'thrust') return this.startAttack('attack3');
      }
      if (this.want('heavy')) { this.consume('heavy'); return this.heavyHold && (input.b.light.down || input.b.heavy.down) ? this.startCharge() : this.startHeavy(0.3); }
    }
    // cancels
    const cancel = m.cancel ?? m.duration;
    if (this.clipT >= cancel) {
      if (this.want('dodge', 0.3)) { this.consume('dodge'); return this.startDodge(); }
      if (input.b.block.down) return this.startBlock();
      if (this.want('special', 0.3) && this.focus >= PLAYER.focusMax) { this.consume('special'); return this.startSpecial(); }
      if ((!c || this.clipT > c[1]) && this.want('light')) { this.consume('light'); return this.startAttack(PLAYER.combo[0]); }
      if (this.moveMag > 0.4 && this.clipT >= cancel + 0.12) { this._toLoco(); return; }
    } else if (this.clipT < hw[0] - 0.06 && this.want('dodge', 0.12) && this.clipT < 0.1) {
      // very early startup can still be dodge-cancelled (feint)
      this.consume('dodge'); return this.startDodge();
    }
    if (this._endAt('loco')) { this.comboIdx = -1; this.hop = 0; this.leap = null; }
  }

  // special: sword-qi wave -------------------------------------------------------------------------------------
  startSpecial() {
    this.focus = 0;
    bus.emit('player:focus', { value: 0, max: PLAYER.focusMax });
    const target = this.pickTarget(14);
    if (target) this.yaw = yawOf(target.pos.x - this.pos.x, target.pos.z - this.pos.z);
    this.attackTarget = target;
    this.state = 'special';
    const m = meta('special');
    this.play('special', { fade: 0.08 });
    this._makeStrike('special', m, 1);
    this.strike.qiFired = false;
    this.startLunge(this.forward(_fwd), Math.min(m.lunge ?? 0.5, 0.8), 0, (m.hit?.[0]?.[0] ?? 0.45));
    this.vel.set(0, 0, 0);
    bus.emit('player:attack', { clip: 'special', heavy: true });
    this.game.combat?.specialStart(this);
  }
  _special(dt) {
    this._brake(dt, 12);
    const m = this.clipMeta;
    const h0 = m?.hit?.[0]?.[0] ?? 0.45;
    if (this.strike && !this.strike.qiFired && this.clipT >= h0) {
      this.strike.qiFired = true;
      this.game.combat?.fireQi(this);
    }
    this._endAt('loco');
  }

  // execution (处决) ---------------------------------------------------------------------------------------------
  /** A posture-broken (staggered) enemy in reach in front of the hero, if any. */
  executableTarget() {
    let best = null, bd = 2.8;
    for (const e of this.game.enemies) {
      if (!e.alive || !e.active || e.state !== 'stagger') continue;
      const d = this.distTo(e);
      if (d < bd && Math.abs(this.angleTo(e)) < 1.4) { best = e; bd = d; }
    }
    return best;
  }

  startExecute(e) {
    const g = this.game;
    this.state = 'execute';
    this.execTarget = e;
    this.yaw = yawOf(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
    // pin the victim in front of the blade, facing the hero
    const f = this.forward(_v);
    e.pos.x = this.pos.x + f.x * 1.15; e.pos.z = this.pos.z + f.z * 1.15;
    e.yaw = this.yaw + Math.PI; e.vel.set(0, 0, 0); e.knock.set(0, 0, 0);
    e.state = 'executing'; e.strike = null; e.chain = null;
    g.coordinator?.release(e);
    this.play('execute', { fade: 0.06 });
    this.vel.set(0, 0, 0);
    this.strike = null;
    this.invulnerable = true;
    this.execStabbed = false;
    g.camera.setMode('kill', { victim: e.pos.clone(), duration: 1.7, blend: 1.4 });
    g.combat?.slowmo(0.6, 0.3, 0.05, 0.2);
    bus.emit('player:attack', { clip: 'execute', heavy: true });
    g.log('execute', e.id);
  }

  _execute(dt) {
    this._brake(dt, 16);
    const e = this.execTarget;
    if (e && !this.execStabbed && e.active) { e.vel.set(0, 0, 0); }
    if (this._endAt('loco')) { this.invulnerable = false; this.execTarget = null; }
  }

  // dodge -----------------------------------------------------------------------------------------------------
  startDodge() {
    let dir = _v.copy(this.moveDir);
    const hasDir = this.moveMag > 0.25;
    let clip;
    const locked = this.lock?.alive;
    if (!hasDir) { dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); clip = 'dodgeB'; }
    else if (!locked && !this.inCombat) { this.yaw = yawOf(dir.x, dir.z); clip = 'dodgeF'; }
    else {
      // directional clips relative to the facing (keep facing the fight)
      const a = wrapAngle(yawOf(dir.x, dir.z) - this.yaw);
      if (Math.abs(a) < Math.PI / 4) clip = 'dodgeF';
      else if (Math.abs(a) > Math.PI * 3 / 4) clip = 'dodgeB';
      else clip = a > 0 ? 'dodgeL' : 'dodgeR';
      if (!locked && clip === 'dodgeF') this.yaw = yawOf(dir.x, dir.z);
    }
    const m = meta(clip);
    this.state = 'dodge';
    this.play(clip, { fade: 0.05 });
    const iw = m?.iframes ?? [0.03, 0.32];
    this.startLunge(dir, PLAYER.dodgeDist[clip] ?? 3, 0, iw[1] + 0.1);
    this.dodgeClip = clip;
    this.vel.multiplyScalar(0.2);
    this.strike = null;
    this.hop = 0; this.leap = null;
    bus.emit('player:dodge', { dir: { x: dir.x, z: dir.z }, clip });
    this.game.combat?.dodgeFx(this, dir);
  }
  _inIframes() {
    const iw = this.clipMeta?.iframes ?? [0.03, 0.32];
    return this.clipT >= iw[0] && this.clipT <= iw[1];
  }
  _dodge(dt, input) {
    this._brake(dt, 10);
    const m = this.clipMeta;
    const cancel = m?.cancel ?? 0.4;
    if (this.clipT >= cancel) {
      if (this.want('light', 0.3)) { this.consume('light'); this.lastDodgeEnd = this.clock; return this.startAttack('thrust'); }
      if (this.want('dodge', 0.2)) { this.consume('dodge'); return this.startDodge(); }
      if (this.want('heavy', 0.3)) { this.consume('heavy'); return this.startHeavy(0); }
      if (input.b.block.down) return this.startBlock();
      if (this.moveMag > 0.4 && this.clipT > cancel + 0.05) { this.lastDodgeEnd = this.clock; return this._toLoco(); }
    }
    if (this._endAt('loco')) this.lastDodgeEnd = this.clock;
  }

  // block / parry ---------------------------------------------------------------------------------------------
  startBlock() {
    this.state = 'block';
    this.blocking = true;
    this.play('block', { fade: 0.07, loop: true });
    this.strike = null;
    bus.emit('player:block', { on: true });
  }
  _stopBlock() {
    this.blocking = false;
    bus.emit('player:block', { on: false });
  }
  _block(dt, input) {
    this._brake(dt, 12);
    const tgt = this.lock?.alive ? this.lock : this.pickTarget(6);
    if (tgt) this.faceTowards(tgt.pos.x, tgt.pos.z, 6, dt);
    // blockHit reaction plays inside the block state, then returns to the guard loop
    if (this.clip === 'blockHit' && this.clipT >= (this.clipMeta?.duration ?? 0.35)) {
      if (input.b.block.down) this.play('block', { fade: 0.1, loop: true });
      else { this._stopBlock(); return this._toLoco(); }
    }
    if (!input.b.block.down && this.clip !== 'blockHit') { this._stopBlock(); return this._toLoco(); }
    if (this.want('dodge', 0.2)) { this.consume('dodge'); this._stopBlock(); return this.startDodge(); }
    if (this.want('light', 0.2) && this.clip !== 'blockHit') { this.consume('light'); this._stopBlock(); return this.startAttack(PLAYER.combo[0]); }
  }
  /** Called by combat on a successful normal block. */
  onBlocked() {
    this.play('blockHit', { fade: 0.04 });
  }
  /** Called by combat on a perfect parry. */
  onParry() {
    this.blocking = false;
    this.state = 'parry';
    this.play('parry', { fade: 0.03 });
    this.riposte = this.clock + 1.1;
    this.strike = null;
  }
  _parry(dt, input) {
    this._brake(dt, 12);
    const tgt = this.lock?.alive ? this.lock : this.pickTarget(6);
    if (tgt) this.faceTowards(tgt.pos.x, tgt.pos.z, 8, dt);
    if (this.clipT > 0.1) {
      if (this.want('light', 0.3)) { this.consume('light'); return this.startAttack(PLAYER.combo[0], { speed: 1.1 }); }
      if (this.want('heavy', 0.3)) { this.consume('heavy'); return this.startHeavy(0.5); }
      if (this.want('dodge', 0.2)) { this.consume('dodge'); return this.startDodge(); }
      // a second strike in a combo can be parried again: re-arm the window on a new press
      if (input.b.block.pressed) { this.blockPressT = this.clock; }
    }
    if (this._endAt(null)) {
      if (input.b.block.down) this.startBlock();
      else this._toLoco();
    }
  }

  // hit reactions / death -------------------------------------------------------------------------------------
  /** Called by combat when the player takes a hit. */
  onHurt({ damage, dirX, dirZ, heavy, knockdown }) {
    if (this.state === 'dead') return;
    this.hp = Math.max(0, this.hp - damage);
    if (this.blocking) this._stopBlock();
    this.strike = null; this.hop = 0; this.leap = null;
    if (this.hp <= 0) return this.die(dirX, dirZ);
    const fromBehind = (Math.sin(this.yaw) * -dirX + Math.cos(this.yaw) * -dirZ) < -0.2;
    // a big blow (a quarter of the bar, or an unblockable heavy) drops him to one knee before he pushes back up
    const kneel = !knockdown && !fromBehind && (damage >= 25 || (heavy && damage >= 18));
    const clip = knockdown ? 'knockdown' : kneel ? 'hurtKneel' : heavy ? 'hitHeavy' : fromBehind ? 'hitBack' : 'hitFront';
    this.state = 'react';
    this.play(clip, { fade: 0.04 });
    this.applyKnock(dirX, dirZ, knockdown ? 5.5 : heavy ? 4.2 : 2.6);
    this.vel.multiplyScalar(0.1);
  }
  onGuardBreak(dirX, dirZ) {
    this._stopBlock();
    this.state = 'react';
    this.play('stagger', { fade: 0.05 });
    this.applyKnock(dirX, dirZ, 2.4);
    this.posture = 0;
  }
  onParried() {
    // the swordmaster turned the blade: recoil, open for a counter
    this.state = 'react';
    this.strike = null;
    this.play('parried', { fade: 0.04 });
    this.hop = 0; this.leap = null;
  }
  _react(dt, input) {
    this._brake(dt, 8);
    const m = this.clipMeta;
    if (!m) return this._toLoco();
    // escape: dodge-cancel the late part of light reactions
    if ((this.clip === 'hitFront' || this.clip === 'hitBack' || this.clip === 'blockHit' || (this.clip === 'hurtKneel' && this.clipU > 0.5)) && this.clipU > 0.55 && this.want('dodge', 0.25)) {
      this.consume('dodge'); return this.startDodge();
    }
    if (this.clipT >= m.duration) {
      if (this.clip === 'knockdown') { this.play('getUp', { fade: 0.1 }); return; }
      this._toLoco();
    }
  }

  die(dirX = 0, dirZ = 1) {
    this.state = 'dead';
    this.alive = false;
    this.strike = null; this.blocking = false;
    const fromBehind = (Math.sin(this.yaw) * -dirX + Math.cos(this.yaw) * -dirZ) < -0.2;
    this.play(fromBehind ? 'death' : 'deathBack', { fade: 0.06 });
    this.applyKnock(dirX, dirZ, 3);
    this.lockOn(null);
    bus.emit('player:death', {});
  }

  celebrate() {
    this.state = 'victory';
    this.strike = null;
    this.lockOn(null);
    this.victoryStage = 0;
    this.victoryT = 0;
  }
  _victory(dt) {
    this.victoryT += dt;
    if (this.victoryStage === 0 && this.victoryT > 0.9) {
      this.victoryStage = 1;
      if (this.drawn) this.play('sheathe', { fade: 0.15, speed: 0.8 });
    }
    if (this.victoryStage === 1 && this.clip === 'sheathe' && this.clipU > 0.68 && this.drawn) this.setDrawn(false);
    if (this.victoryStage === 1 && (!this.clip || this.clipT >= (this.clipMeta?.duration ?? 0))) {
      this.victoryStage = 2;
      if (this.drawn) this.setDrawn(false);
      this.play('victory', { fade: 0.25 });
    }
    if (this.victoryStage === 2 && this.clip && this.clipT >= this.clipMeta.duration) { this.stopAction(0.4); this.victoryStage = 3; }
  }

  /** Full reset for a (re)started wave. */
  revive() {
    this.hp = this.maxHp; this.alive = true; this.posture = 0;
    this.state = 'loco'; this.strike = null; this.blocking = false; this.iframes = false; this.hop = 0; this.leap = null;
    this.frozenPose = false;
    this.stopAction(0.1);
    bus.emit('player:hp', { hp: this.hp, max: this.maxHp });
    bus.emit('player:focus', { value: this.focus, max: PLAYER.focusMax });
  }

  lockOn(target) {
    if (target === this.lock) return;
    this.lock = target;
    bus.emit('lockon', { id: target ? target.id : null });
  }

  /** Q/Tab: toggle lock on the enemy nearest the camera's forward direction. */
  toggleLock() {
    if (this.lock) { this.lockOn(null); return; }
    this.lockOn(this.bestLockCandidate());
  }
  bestLockCandidate(exclude = null) {
    const h = this.game.camera?.heading ?? this.yaw;
    let best = null, bestScore = Infinity;
    for (const e of this.game.enemies) {
      if (!e.alive || !e.active || e.hidden || e === exclude) continue;
      const d = this.distTo(e);
      if (d > 28) continue;
      const a = Math.abs(wrapAngle(yawOf(e.pos.x - this.pos.x, e.pos.z - this.pos.z) - h));
      const score = d * 0.15 + a * 2.5;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }
}

export { hitWindow };
