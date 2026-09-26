// Combat: hit detection and resolution + all hit feedback. Owner: gameplay (P).
//
//  Detection: while a strike's CLIPS hit window is live, the attacker's blade segment is swept from last frame's
//  base/tip to this frame's (sub-stepped, see util.sweepBladeVsCapsules) against each opponent's hurt capsules.
//  A reach/arc "assist" at the window midpoint guarantees fair hits when a procedural pose narrowly misses.
//  Resolution: dodge i-frames → evade; guard from the front → perfect parry (guard pressed ≤ 150 ms before impact:
//  enemy recoils/staggers, slow-mo pulse) or block (posture; guard break); unblockable heavies ignore guards;
//  enemies may guard (posture) and the swordmaster may turn the player's blade; else damage + posture + reaction.
//  Feedback per bible §6.2.8: hit-stop (app.time.hitstop), slow-mo pulses (app.time.setScale), pipeline kicks /
//  flash / letterbox / slow-mo look, camera shake / FOV punch / micro-zoom, VFX (sparks, blood, glow, dust,
//  clippings, shockwave, trail, qi wave), grass interaction (cut, slash, shock, trample, stain), bus events.
import * as THREE from 'three';
import { bus } from '../core/bus.js';
import { lamps } from '../core/lamps.js';
import { setWindStrength } from '../core/wind.js';
import { sweepBladeVsCapsules, clamp, lerp, pointSegDist2, segSegDist2 } from './util.js';

const _c = { s: 0, index: 0, part: 'torso', point: new THREE.Vector3(), depth: 0 };
const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();
const _uv = { x: 0.5, y: 0.5 };
const WARM = [1.0, 0.62, 0.3];

const COMBO_GAP = 2.2;
// finishers throw the body: a heavy / finishing kill launches the corpse, a heavy hit lifts a grunt off his feet
const LAUNCHERS = new Set(['attack4', 'airFlurry', 'flipCleave', 'heavy', 'special']);

export const FEEL = {
  parryWindow: 0.15,
  hitstop: { light: 0.075, heavy: 0.13, clash: 0.07, parry: 0.13, kill: 0.18 },
  shake: { light: 0.32, heavy: 0.62, clash: 0.34, parry: 0.36, hurt: 0.5, kill: 0.55 },
  focus: { light: 7, heavy: 11, thrust: 8, block: 4, parry: 25, special: 0 },
  assist: true,
};

export class Combat {
  constructor(game) {
    this.game = game;
    this.pulses = [];
    this.qi = [];
    this.arrows = [];
    this.scale = 1; this._written = 1;
    this.paused = false;
    this.windBase = 1;
    this._windRestore = 0;
    this.dustAmt = 0;
  }

  get vfx() { return this.game.vfx; }
  get ix() { return this.game.interaction; }
  get fx() { return this.game.app.pipeline?.fx; }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt, rawDt) {
    const g = this.game, P = g.player;
    if (P.alive || P.strike) this._strike(P, g.enemies, dt);
    const victims = this._victims ??= [P];
    for (const e of g.enemies) if (e.active) this._strike(e, victims, dt);
    this._updateQi(dt);
    this._updateArrows(dt);
    // restore the wind after a spike
    if (this._windRestore > 0) { this._windRestore -= dt; if (this._windRestore <= 0) setWindStrength(this.windBase, 2); }
  }

  /** Real-time pass: slow-mo pulses → app.time scale + pipeline slow-mo look. */
  updateTime(rawDt) {
    let k = 1;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += rawDt;
      let env;
      if (p.t < p.in) env = p.t / p.in;
      else if (p.t < p.in + p.dur) env = 1;
      else env = 1 - (p.t - p.in - p.dur) / p.out;
      if (env <= 0 && p.t > p.in) { this.pulses.splice(i, 1); continue; }
      k = Math.min(k, lerp(1, p.k, clamp(env, 0, 1)));
    }
    this.scale = this.paused ? 0 : k;
    const time = this.game.app.time;
    if (Math.abs(this.scale - this._written) > 1e-4 || Math.abs(time.scale - this.scale) > 1e-4) {
      time.setScale(this.scale, 0);
      this._written = this.scale;
    }
    this.fx?.setSlowmo?.(this.paused ? 0 : clamp((1 - k) / 0.7, 0, 1));
  }

  slowmo(k, seconds, easeIn = 0.05, easeOut = 0.3) { this.pulses.push({ k, dur: seconds, in: easeIn, out: easeOut, t: 0 }); }
  hitstop(s) { this.game.app.time.hitstop?.(s); }
  clearTime() { this.pulses.length = 0; }

  kick({ exposure = 0, ca = 0, radial = 0, at = null, ms = 80 } = {}) {
    const fx = this.fx;
    if (!fx) return;
    let rad = null;
    if (radial && at) { this.game.camera.screenUV(at, _uv); rad = { x: _uv.x, y: _uv.y, strength: radial }; }
    if (typeof fx.kick === 'function') fx.kick({ exposure, ca, radial: rad, ms });
    else {
      if (exposure) fx.flash?.(exposure * 0.35, 0xffe2b8);
      if (radial) fx.impact?.(radial * 30);
    }
  }

  // ------------------------------------------------------------------------------------------ strikes
  _strike(att, targets, dt) {
    const s = att.strike;
    const trail = this._trailFor(att);
    if (!s || !att.alive) {
      if (att._trailOn) { trail?.end?.(); att._trailOn = false; }
      return;
    }
    if (att._trailSwing !== s.swing && att._trailOn) { trail?.end?.(); att._trailOn = false; }
    const W = s.windows;
    if (!W.length) return;
    const wa = W[0][0], wb = W[W.length - 1][1];
    const t = att.clipT;
    // whoosh just before the blade goes live — once per hit window (multi-cut clips swing several times)
    const wn = s.whooshN ?? 0;
    if (wn < W.length && t >= W[wn][0] - 0.06) {
      s.whooshN = wn + 1;
      const heavy = s.kind === 'heavy' || s.kind === 'special';
      bus.emit('sword:whoosh', { speed: (heavy ? 17 : s.kind === 'thrust' ? 11 : 14) * (att.clipSpeed || 1), heavy, pos: att.tip1.clone(), id: att.id,
        team: att.team, actor: att.kind, clip: att.clip, skind: s.kind, win: wn });
    }
    // trail: from shortly before the window until shortly after
    const trailLive = t >= wa - 0.08 && t <= wb + 0.07;
    if (trail) {
      if (trailLive) {
        if (!att._trailOn) { att._trailOn = true; att._trailSwing = s.swing; trail.setIntensity?.(att.team === 0 ? (s.kind === 'heavy' || s.kind === 'special' ? 1.25 : 1) : s.unblockable ? 0.9 : 0.6); }
        trail.push(att.base1, att.tip1, this.game.time);
      } else if (att._trailOn) { trail.end?.(); att._trailOn = false; }
    }
    // hit windows
    let live = false, liveIdx = -1;
    for (let i = 0; i < W.length; i++) if (att.inWindow(W[i][0], W[i][1])) { live = true; liveIdx = i; break; }
    if (live) {
      // multi-cut clips (e.g. airFlurry): every hit window is a fresh cut that may land on the same target again
      if (s.win !== liveIdx) { if (s.win !== undefined) att.hitSet.clear(); s.win = liveIdx; }
      this._grass(att, s, true);
      for (const v of targets) {
        if (!v.alive || !v.active || v.hidden || att.hitSet.has(v)) continue;
        if (att.distTo(v) > s.reach + 2.2) continue;
        let hit = null;
        if (att.bladeValid) hit = sweepBladeVsCapsules(att.base0, att.tip0, att.base1, att.tip1, v.capsules(), s.bladeR, _c);
        if (!hit && FEEL.assist) {
          const [a, b] = W[liveIdx];
          const mid = a + (b - a) * 0.55;
          if (att.crossed(mid) || (att.clipPrevT <= a && att.clipT >= b)) hit = this._assist(att, v, s);
        }
        if (!hit) continue;
        att.hitSet.add(v);
        s.contacts++;
        if (att.team === 0) this.playerHits(att, v, _c.point, _c.part, s);
        else this.enemyHits(att, v, _c.point, _c.part, s);
      }
    } else if (s._grassOn) this._grass(att, s, false);
  }

  _assist(att, v, s) {
    const d = att.distTo(v);
    if (d > s.reach + v.radius * 0.6 + 0.15) return null;
    if (Math.abs(att.angleTo(v)) > s.arc) return null;
    // contact on the victim's torso surface facing the attacker, at blade height
    _c.point.set(att.pos.x - v.pos.x, 0, att.pos.z - v.pos.z).normalize().multiplyScalar(v.radius * 0.6);
    _c.point.add(v.pos);
    _c.point.y = clamp(att.tip1.y, v.pos.y + 0.8, v.pos.y + 1.55);
    _c.part = 'torso'; _c.s = 0.5; _c.index = 0; _c.depth = 0.05;
    return _c;
  }

  /** Blade direction of travel at contact (for blood / sparks). */
  _tangent(att, out) {
    out.copy(att.tip1).sub(att.tip0);
    if (out.lengthSq() < 1e-6) out.set(Math.cos(att.yaw), 0.1, -Math.sin(att.yaw));
    return out.normalize();
  }

  // ------------------------------------------------------------------------------------------ player → enemy
  playerHits(P, e, point, part, s) {
    const g = this.game;
    const dx = e.pos.x - P.pos.x, dz = e.pos.z - P.pos.z;
    const n = Math.hypot(dx, dz) || 1, dirX = dx / n, dirZ = dz / n;
    const tan = this._tangent(P, _t);
    const heavy = s.kind === 'heavy' || s.kind === 'special';
    const facing = Math.abs(e.angleTo(P)) < 1.25;
    // rattan shield: light cuts from the front glance off (the swordsman is thrown back a step); a heavy caves the
    // guard in (long stagger); hits from the side or behind, and anything while he is attacking, get through
    if (e.shieldUp && Math.abs(e.angleTo(P)) < 1.05 && s.kind !== 'special') {
      if (heavy || s.charge > 0.5) {
        e.posture = e.maxPosture;
        e.stagger(dirX, dirZ, 2.0);
        this.clash(point, 1.6, tan);
        this.hitstop(0.1); this.game.camera.shake(0.45);
        this.kick({ exposure: 0.18, ca: 0.012, ms: 100 });
        bus.emit('enemy:shieldbreak', { id: e.id, pos: point.clone() });
        g.log('shield', e.id, 'guard broken');
        return;
      }
      const broke = e.addPosture(s.posture * 0.55);
      this.clash(point, 1.0, tan);
      P.applyKnock(-dirX, -dirZ, 2.2);
      P.gainFocus(FEEL.focus.block * 0.5);
      if (broke) { e.stagger(dirX, dirZ, 1.6); g.log('shield', e.id, 'posture broken'); return; }
      bus.emit('enemy:shieldblock', { id: e.id, pos: point.clone() });
      g.log('shield', e.id, 'blocked');
      return;
    }
    // enemy guard
    if (e.guarding && facing && s.kind !== 'special') {
      const broke = e.onBlocked(s.posture * (heavy ? 1.7 : 1.1) * (s.riposte ? 1.4 : 1), dirX, dirZ);
      this.clash(point, heavy ? 1.2 : 0.8, tan);
      P.gainFocus(FEEL.focus.block);
      if (broke) { this.hitstop(0.08); this.game.camera.shake(0.35); }
      g.log('block', e.id, broke ? 'guard broken' : '');
      return;
    }
    // the swordmaster turns the blade (not during his own swing, not when staggered)
    if (e.boss && s.kind !== 'special' && (e.state === 'circle' || e.state === 'recover' || e.state === 'block' || e.state === 'close')
      && g.rng.chance(e.K.parryChance * (P.comboIdx >= 1 ? 1.4 : 1) * (e.phase === 2 ? 1.25 : 1)) && facing) {
      e.startBlock(0.35);
      e.play('parry', { fade: 0.03 });
      P.onParried();
      this.clash(point, 1.5, tan);
      this.hitstop(FEEL.hitstop.parry);
      this.kick({ exposure: 0.2, ca: 0.012, ms: 90 });
      bus.emit('player:parried', { id: e.id, pos: point.clone() });
      e.brain && (e.brain.cooldown = 0);
      g.log('boss-parry', e.id);
      return;
    }
    const staggered = e.state === 'stagger';
    const damage = s.damage * (staggered ? (e.boss ? 1.2 : 1.5) : 1) * (e.boss && s.kind === 'special' ? 0.5 : 1);
    // which side the edge came from (his right = +1) and whether it took him high: they pick the reaction
    const side = Math.abs(tan.x * Math.cos(e.yaw) - tan.z * Math.sin(e.yaw)) > 0.35 ? Math.sign(tan.x * Math.cos(e.yaw) - tan.z * Math.sin(e.yaw)) : 0;   // tan·right < 0: travelling to his left
    const high = part === 'head' || point.y > e.pos.y + 1.5;
    const floor = LAUNCHERS.has(P.clip) && !e.shieldUp;
    const res = e.onHit({ damage, posture: s.posture, dirX, dirZ, heavy, knock: heavy ? 5.6 : s.kind === 'thrust' ? 4 : 3.0, side, high, floor });
    const kill = res === 'kill';
    P.gainFocus(heavy ? FEEL.focus.heavy : s.kind === 'thrust' ? FEEL.focus.thrust : FEEL.focus.light);
    const combo = this.countHit();
    bus.emit('enemy:hit', { id: e.id, pos: point.clone(), dir: { x: tan.x, y: tan.y, z: tan.z }, damage: Math.round(damage), kill, part,
      hp: e.hp, max: e.maxHp, kind: e.kind, heavy, result: res, combo });
    // a brief warm rim of light, not a white-out (the flash is emissive × 2.5 in the character material)
    try { e.ch.flash(0xffd2a8, heavy ? 0.55 : 0.36); } catch { /* optional */ }
    const big = heavy || LAUNCHERS.has(P.clip);
    this.hitFx(heavy ? 'heavy' : 'light', point, tan, e, kill);
    if (kill) this.kill(e, point, tan, { launch: big ? (e.boss ? 3 : 5.2) : 1.4 });
    else if (big && res === 'react' && !e.boss) e.launch(e.kind === 'bandit_heavy' ? 1.2 : 1.8);   // lifted off his feet
    g.log('hit', e.id, `${Math.round(damage)}${kill ? ' KILL' : ''} ${res}`);
  }

  /** Hits in a row (a gap over COMBO_GAP sim seconds, or getting hurt, resets). Emits 'player:combo'. */
  countHit() {
    const now = this.game.time;
    this.combo = now - (this._comboT ?? -9) < COMBO_GAP ? (this.combo ?? 0) + 1 : 1;
    this._comboT = now;
    bus.emit('player:combo', { n: this.combo });
    return this.combo;
  }
  breakCombo() {
    if (!this.combo) return;
    this.combo = 0; this._comboT = -9;
    bus.emit('player:combo', { n: 0 });
  }

  // ------------------------------------------------------------------------------------------ enemy → player
  enemyHits(e, P, point, part, s) {
    const g = this.game;
    const dx = P.pos.x - e.pos.x, dz = P.pos.z - e.pos.z;
    const n = Math.hypot(dx, dz) || 1, dirX = dx / n, dirZ = dz / n;
    const tan = this._tangent(e, _t);
    if (P.iframes) {
      // clean evade: a breath of slow-mo when the dodge was late (just-frame)
      if (P.clipT < 0.2) { this.slowmo(0.55, 0.12, 0.03, 0.25); bus.emit('player:evade', { id: e.id, perfect: true }); }
      g.log('evade', e.id);
      return;
    }
    const facing = (Math.sin(P.yaw) * -dirX + Math.cos(P.yaw) * -dirZ) > -0.25;
    const guarding = (P.blocking || P.state === 'parry') && facing;
    if (guarding && !s.unblockable) {
      const perfect = P.state === 'parry' || g.player.clock - P.blockPressT <= FEEL.parryWindow;
      if (perfect) return this.perfectParry(P, e, point, tan);
      const broke = P.addPosture(s.posture * 0.8);
      if (broke) P.onGuardBreak(dirX, dirZ); else { P.onBlocked(); P.applyKnock(dirX, dirZ, 1.4); }
      this.clash(point, 0.9, tan);
      P.gainFocus(FEEL.focus.block);
      bus.emit('player:parry', { perfect: false, blocked: true, broke, pos: point.clone() });
      g.log('block', e.id, broke ? 'GUARD BREAK' : '');
      return;
    }
    if (P.invulnerable) return;                      // god mode / cinematics: guards and parries still resolve
    const damage = s.damage;
    const heavy = s.kind === 'heavy';
    P.onHurt({ damage, dirX, dirZ, heavy, knockdown: s.unblockable && damage >= 30 });
    if (s.knock) P.applyKnock(dirX, dirZ, s.knock);
    P.recoil?.(dirX, dirZ, heavy ? 1.4 : 1);
    g.camera.kickDir?.(_t.set(dirX, 0, dirZ).multiplyScalar(heavy ? 0.1 : 0.06), 1);
    this.breakCombo();
    bus.emit('player:hurt', { damage: Math.round(damage), pos: point.clone(), dir: { x: dirX, y: 0, z: dirZ }, id: e.id });
    bus.emit('player:hp', { hp: P.hp, max: P.maxHp });
    try { P.ch.flash(0xff4a2a, 0.26); } catch { /* optional */ }
    this.vfx?.blood?.(point, tan, heavy ? 1.3 : 0.8, false);
    this.hitstop(heavy ? 0.08 : 0.05);
    this.kick({ exposure: -0.12, ca: heavy ? 0.018 : 0.01, radial: heavy ? 0.015 : 0, at: point, ms: 110 });
    this.fx?.flash?.(0.18, 0x8a1a10);
    g.camera.shake(heavy ? 0.6 : FEEL.shake.hurt);
    g.log('hurt', e.id, `${Math.round(damage)} → hp ${Math.round(P.hp)}`);
  }

  perfectParry(P, e, point, tan) {
    const dx = e.pos.x - P.pos.x, dz = e.pos.z - P.pos.z, n = Math.hypot(dx, dz) || 1;
    P.onParry();
    e.onParried(dx / n, dz / n);
    P.gainFocus(FEEL.focus.parry);
    // spark star + white-hot flash, slow-mo pulse, micro-zoom
    _n.copy(tan).negate();
    this.vfx?.sparks?.(point, _n, 2);
    this.vfx?.hitGlow?.(point, 0.6, [1.0, 0.95, 0.85]);
    lamps.flash(point, [1.0, 0.85, 0.6], 9, 0.16);
    this.hitstop(FEEL.hitstop.parry);
    this.slowmo(0.35, 0.4, 0.04, 0.35);
    this.kick({ exposure: 0.25, ca: 0.02, ms: 110 });
    this.fx?.flash?.(0.22, 0xfff0d8);
    this.game.camera.microZoom(0.03, 0.25);
    this.game.camera.shake(FEEL.shake.parry);
    bus.emit('player:parry', { perfect: true, pos: point.clone(), id: e.id });
    bus.emit('enemy:parried', { id: e.id, pos: point.clone() });
    bus.emit('sword:clash', { pos: point.clone(), strength: 1.6, perfect: true });
    this.game.log('PARRY', e.id, 'perfect');
  }

  clash(point, strength = 1, tan = null) {
    _n.copy(tan ?? _q.set(0, 1, 0)).negate();
    this.vfx?.sparks?.(point, _n, strength);
    this.vfx?.hitGlow?.(point, 0.35 * strength, [1.0, 0.75, 0.45]);
    lamps.flash(point, WARM, 5 * strength, 0.12);
    this.hitstop(FEEL.hitstop.clash);
    this.kick({ exposure: 0.15, ms: 80 });
    this.game.camera.shake(FEEL.shake.clash * strength);
    bus.emit('sword:clash', { pos: point.clone(), strength });
  }

  hitFx(kind, point, tan, victim, kill) {
    const heavy = kind === 'heavy';
    const cam = this.game.camera;
    // blood: a spray along the cut + (heavy/kill) an ink bloom; a white-hot core glow and a spark burst at the edge
    this.vfx?.blood?.(point, tan, kill ? 2.6 : heavy ? 2.0 : 1.35, false);
    if (heavy || kill) this.vfx?.blood?.(point, tan, kill ? 1.6 : 1.0, true);
    this.vfx?.hitGlow?.(point, heavy ? 0.55 : 0.38, [1.0, 0.92, 0.8]);
    _n.copy(tan).negate();
    this.vfx?.sparks?.(point, _n, heavy ? 0.9 : 0.5);
    lamps.flash(point, [1.0, 0.55, 0.3], heavy ? 5 : 3.2, 0.12);
    this.hitstop(kill ? FEEL.hitstop.kill : heavy ? FEEL.hitstop.heavy : FEEL.hitstop.light);
    // the victim recoils along the blade; the lens is kicked the same way (a hit reads as a physical blow)
    victim.recoil?.(tan.x, tan.z, heavy ? 1.6 : 1);
    cam.kickDir?.(_t.copy(tan).multiplyScalar(heavy ? 0.09 : 0.055), 1);
    if (heavy) {
      this.kick({ exposure: 0.28, ca: 0.02, radial: 0.03, at: point, ms: 140 });
      cam.punchFov(3);
      this.ix?.shock?.(victim.pos.x, victim.pos.z, 0.7);
    } else this.kick({ exposure: 0.16, ca: 0.008, radial: 0.012, at: point, ms: 80 });
    cam.shake(heavy ? FEEL.shake.heavy : FEEL.shake.light);
    // a beat of slow motion on every kill (the last kill of a wave gets the full cinematic)
    if (kill) this.slowmo(0.45, 0.14, 0.02, 0.2);
  }

  kill(e, point, tan, { launch = 0 } = {}) {
    const g = this.game;
    if (e.alive) {
      const P = g.player, dx = e.pos.x - P.pos.x, dz = e.pos.z - P.pos.z, n = Math.hypot(dx, dz) || 1;
      e.die(dx / n, dz / n, launch);
    }
    bus.emit('enemy:death', { id: e.id, pos: e.pos.clone(), kind: e.kind, boss: e.boss });
    this.ix?.stain?.(e.pos.x + tan.x * 0.6, e.pos.z + tan.z * 0.6, 0.9, 1);
    const last = g.director?.isLastKill?.(e);
    if (last) {
      this.hitstop(FEEL.hitstop.kill);
      this.slowmo(0.25, 0.8, 0.04, 0.6);
      this.kick({ exposure: 0.3, ca: 0.015, ms: 140 });
      this.fx?.letterbox?.(true);
      this.vfx?.blood?.(point, tan, 1.4, true);
      this.vfx?.leafBurst?.(_p.set(e.pos.x, e.pos.y + 1.2, e.pos.z), 40);
      setWindStrength(2.6, 0.4); this._windRestore = 2.2;
      g.camera.setMode('kill', { victim: e.pos.clone(), duration: 2.8, blend: 2.6 });
      g.letterboxT = 3.0;
    } else {
      this.hitstop(0.09);
    }
    g.director?.onKill?.(e, last);
  }

  // ------------------------------------------------------------------------------------------ specials / moves
  telegraph(e, { ranged = false } = {}) {
    const s = e.strike;
    const tip = ranged && e.kind === 'archer' ? e.offhandPos(_p) : e.tip1;
    const red = s?.unblockable;
    this.vfx?.hitGlow?.(tip, red ? 0.5 : 0.3, red ? [1.0, 0.12, 0.05] : [1.0, 0.85, 0.6]);
    lamps.flash(tip, red ? [1.0, 0.1, 0.04] : [1.0, 0.82, 0.55], red ? 4 : 2.5, 0.3);
    bus.emit('enemy:telegraph', { id: e.id, pos: tip.clone(), unblockable: !!red, clip: s?.clip, eta: e.strikeETA() });
  }

  chargeReady(P) {
    this.vfx?.hitGlow?.(P.tip1, 0.4, [1.0, 0.9, 0.7]);
    lamps.flash(P.tip1, [1.0, 0.8, 0.5], 3, 0.25);
    bus.emit('player:charged', { pos: P.tip1.clone() });
  }

  heavyLanding(P) {
    const f = P.forward(_p);
    const x = P.pos.x + f.x * 1.3, z = P.pos.z + f.z * 1.3;
    const y = this.game.heightAt(x, z);
    this.ix?.shock?.(x, z, 1.0);
    this.ix?.trample?.(P.pos.x, P.pos.z, 0.9, 0.9);
    this.ix?.dust?.(x, z, 1.2, 0.8);
    this.vfx?.shockwave?.(x, z, 0.8);
    this.vfx?.dust?.(_q.set(x, y + 0.1, z), 1.4);
    this.game.camera.shake(0.35);
    this.kick({ exposure: 0.08, radial: 0.012, at: _q, ms: 100 });
    bus.emit('player:land', { pos: _q.clone(), heavy: true });
  }

  /** A body landing (launched corpse or grunt): dust, flattened grass, a thump in the lens when close. */
  landDust(a, k = 1) {
    const y = this.game.heightAt(a.pos.x, a.pos.z);
    this.vfx?.dust?.(_q.set(a.pos.x, y + 0.08, a.pos.z), 0.9 * k);
    this.ix?.trample?.(a.pos.x, a.pos.z, 0.9 * k, 0.9);
    this.ix?.dust?.(a.pos.x, a.pos.z, 0.9 * k, 0.6);
    const d = a.distTo(this.game.player);
    if (d < 9) this.game.camera.shake(0.22 * k * (1 - d / 9));
  }

  dodgeFx(P, dir) {
    this.vfx?.dust?.(_q.set(P.pos.x, P.pos.y + 0.08, P.pos.z), 0.8);
    this.ix?.trample?.(P.pos.x, P.pos.z, 0.6, 0.7);
    this.ix?.dust?.(P.pos.x, P.pos.z, 0.8, 0.5);
    this.game.camera.kickFov(3);
    void dir;
  }

  specialStart(P) {
    setWindStrength(2.6, 0.4); this._windRestore = 2.4;
    this.kick({ exposure: 0.12, ms: 200 });
    this.game.camera.shake(0.2);
  }

  fireQi(P) {
    const f = P.forward(_p).clone();
    const origin = P.pos.clone(); origin.y += 1.1; origin.addScaledVector(f, 0.8);
    let handle = null;
    try { handle = this.vfx?.qiWave?.(origin, f) ?? null; } catch (e) { console.warn('[game] qiWave failed', e); }
    this.qi.push({ pos: origin.clone(), prev: origin.clone(), dir: f, speed: 24, life: 0.8, age: 0, hit: new Set(), handle, owner: P });
    this.game.camera.shake(0.5);
    this.game.camera.punchFov(2.5);
    this.kick({ exposure: 0.25, ca: 0.018, radial: 0.02, at: origin, ms: 160 });
    lamps.flash(origin, [1.0, 0.85, 0.55], 8, 0.3);
    bus.emit('special', { pos: origin.clone(), dir: { x: f.x, y: 0, z: f.z } });
    this.game.log('special', 'qi wave');
  }

  _updateQi(dt) {
    for (let i = this.qi.length - 1; i >= 0; i--) {
      const q = this.qi[i];
      q.age += dt;
      q.prev.copy(q.pos);
      q.pos.addScaledVector(q.dir, q.speed * dt);
      q.pos.y = this.game.heightAt(q.pos.x, q.pos.z) + 1.0;
      try { q.handle?.update?.(dt); } catch { q.handle = null; }
      // the travelling wave parts the grass along its path
      this.ix?.slash?.(q.prev.x, q.prev.z, q.pos.x, q.pos.z, 2.0, 1.0);
      this.ix?.cut?.(q.prev.x, q.prev.z, q.pos.x, q.pos.z, 1.0);
      if (q.owner.team === 1) {
        const P = this.game.player;
        if (P.alive && !q.hit.has(P)) {
          _q.set(P.pos.x, q.pos.y, P.pos.z);
          if (pointSegDist2(_q, q.prev, q.pos) < (1.0 + P.radius) ** 2) {
            q.hit.add(P);
            _p.copy(P.pos); _p.y += 1.2;
            this.enemyHits(q.owner, P, _p, 'torso', { damage: 24 * q.owner.K.dmgMul, posture: 40, kind: 'heavy', reach: 99, arc: 9, unblockable: false, knock: 3 });
          }
        }
        if (q.age > q.life) this.qi.splice(i, 1);
        continue;
      }
      for (const e of this.game.enemies) {
        if (!e.alive || !e.active || q.hit.has(e)) continue;
        _q.set(e.pos.x, q.pos.y, e.pos.z);
        const r = 1.1 + e.radius;
        if (pointSegDist2(_q, q.prev, q.pos) > r * r) continue;
        q.hit.add(e);
        const s = { damage: 58, posture: 60, kind: 'special', reach: 99, arc: 9, riposte: false };
        _p.copy(e.pos); _p.y += 1.2;
        this.playerHits(q.owner, e, _p, 'torso', s);
      }
      if (q.age > q.life) { this.qi.splice(i, 1); }
    }
  }

  // ------------------------------------------------------------------------------------------ projectiles
  /** A ranged clip reached its release ('shoot' event): the archer's arrow or the master's qi wave. */
  fireProjectile(e) {
    const P = this.game.player;
    if (e.kind === 'archer') return this.fireArrow(e, P);
    if (e.kind === 'assassin') return this.fireDarts(e, P);
    // the master's 剑气: the player's crescent, turned on him, sliced along the ground toward the hero
    const f = _t.set(P.pos.x - e.pos.x, 0, P.pos.z - e.pos.z).normalize().clone();
    const origin = e.pos.clone(); origin.y += 1.1; origin.addScaledVector(f, 0.8);
    let handle = null;
    try { handle = this.vfx?.qiWave?.(origin, f) ?? null; } catch (err) { console.warn('[game] qiWave failed', err); }
    this.qi.push({ pos: origin.clone(), prev: origin.clone(), dir: f, speed: 17, life: 1.2, age: 0, hit: new Set(), handle, owner: e });
    this.game.camera.shake(0.35);
    this.kick({ exposure: 0.15, ca: 0.012, ms: 120 });
    lamps.flash(origin, [1.0, 0.4, 0.3], 6, 0.3);
    bus.emit('enemy:qi', { id: e.id, pos: origin.clone() });
  }

  /** Three darts in a fan from the assassin's off hand (flat, fast: sidestep between them or block). */
  fireDarts(e, P) {
    const from = e.offhandPos(new THREE.Vector3());
    from.y = Math.max(from.y, e.pos.y + 1.25);
    const base = Math.atan2(P.pos.x - from.x, P.pos.z - from.z);
    for (const off of [-0.16, 0, 0.16]) {
      const to = P.chest(new THREE.Vector3());
      const d = Math.hypot(to.x - from.x, to.z - from.z), a = base + off;
      const vel = new THREE.Vector3(Math.sin(a) * d, to.y - from.y, Math.cos(a) * d).normalize().multiplyScalar(40);
      const mesh = this.vfx?.arrow?.(from, vel, 0.45) ?? null;
      this.arrows.push({ pos: from.clone(), prev: from.clone(), vel, g: 1.5, age: 0, life: 1.6, owner: e, mesh, stuck: 0, damage: 9 });
    }
    bus.emit('enemy:shoot', { id: e.id, pos: from.clone(), darts: true });
  }
  /** Vanish: a burst of spray and leaves where he stood, the rain closes over the spot. */
  vanishFx(e) {
    const p = e.chest(new THREE.Vector3());
    this.vfx?.dust?.(p.setY(e.pos.y + 0.3), 1.2);
    this.vfx?.leafBurst?.(p.setY(e.pos.y + 1.0), 18);
    this.ix?.trample?.(e.pos.x, e.pos.z, 0.8, 0.8);
    bus.emit('enemy:vanish', { id: e.id, pos: e.pos.clone() });
  }
  /** Blink: he is there again, behind the hero — a lightning flash shows him (the telegraph of the stab). */
  blinkFx(e) {
    try { this.game.env?.lightning?.(); } catch { /* optional */ }
    bus.emit('thunder', { delay: 0.35, strength: 0.8, pan: 0 });
    lamps.flash(e.chest(new THREE.Vector3()), [0.7, 0.8, 1.0], 6, 0.25);
    this.vfx?.dust?.(new THREE.Vector3(e.pos.x, e.pos.y + 0.2, e.pos.z), 1.0);
    bus.emit('enemy:blink', { id: e.id, pos: e.pos.clone() });
  }

  /** Loose an arrow at the hero's chest, leading him a little (a straight dodge sideways beats it). */
  fireArrow(e, P) {
    const from = e.offhandPos(new THREE.Vector3());
    from.y = Math.max(from.y, e.pos.y + 1.3);
    const to = P.chest(new THREE.Vector3());
    const speed = 32, d = from.distanceTo(to), tt = d / speed;
    to.x += P.vel.x * tt * 0.55; to.z += P.vel.z * tt * 0.55;
    const g = 5.0;                                          // a little drop: aim above the lead point
    to.y += 0.5 * g * tt * tt;
    const vel = to.sub(from).normalize().multiplyScalar(speed);
    const mesh = this.vfx?.arrow?.(from, vel) ?? null;
    this.arrows.push({ pos: from, prev: from.clone(), vel, g, age: 0, life: 2.4, owner: e, mesh, stuck: 0 });
    bus.emit('enemy:shoot', { id: e.id, pos: from.clone() });
  }

  _updateArrows(dt) {
    const P = this.game.player;
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.age += dt;
      if (a.stuck > 0) {                                   // stuck in the ground: fade out
        a.stuck -= dt;
        if (a.stuck <= 0) { a.mesh?.dispose?.(); this.arrows.splice(i, 1); }
        continue;
      }
      a.prev.copy(a.pos);
      a.vel.y -= a.g * dt;
      a.pos.addScaledVector(a.vel, dt);
      a.mesh?.update?.(a.pos, a.vel);
      // the hero: a capsule from the hips to the head
      if (P.alive && a.owner.team === 1) {
        if (!a.passed) {
          // close fly-by: the whiz, panned to the side it passes on
          const dx = a.pos.x - P.pos.x, dz = a.pos.z - P.pos.z;
          if (dx * dx + dz * dz < 3.2 * 3.2 && (dx * a.vel.x + dz * a.vel.z) > -6) {
            a.passed = true;
            const c = this.game.app?.camera, r = c ? _n.setFromMatrixColumn(c.matrixWorld, 0) : null;
            const side = r ? Math.sign(dx * r.x + dz * r.z) || 1 : 1;
            bus.emit('arrow:pass', { pos: a.pos.clone(), side });
          }
        }
        const top = _q.set(P.pos.x, P.pos.y + 1.55 + P.hop, P.pos.z), bot = _p.set(P.pos.x, P.pos.y + 0.5 + P.hop, P.pos.z);
        if (segSegDist2(a.prev, a.pos, bot, top) < 0.3 * 0.3) { this._arrowHits(a, P); a.mesh?.dispose?.(); this.arrows.splice(i, 1); continue; }
      }
      const gy = this.game.heightAt(a.pos.x, a.pos.z);
      if (a.pos.y < gy + 0.05 || a.age > a.life) {
        if (a.pos.y < gy + 0.05) { a.pos.y = gy + 0.05; a.stuck = 3; bus.emit('arrow:land', { pos: a.pos.clone(), soft: true }); a.mesh?.update?.(a.pos, a.vel); this.ix?.trample?.(a.pos.x, a.pos.z, 0.2, 0.4); continue; }
        a.mesh?.dispose?.(); this.arrows.splice(i, 1);
      }
    }
  }

  _arrowHits(a, P) {
    const g = this.game;
    const dirX = a.vel.x, dirZ = a.vel.z, n = Math.hypot(dirX, dirZ) || 1;
    const point = a.pos.clone();
    const tan = a.vel.clone().normalize();
    if (P.iframes) { g.log('evade', 'arrow'); return; }
    const facing = (Math.sin(P.yaw) * dirX / n + Math.cos(P.yaw) * dirZ / n) < 0.25;
    if ((P.blocking || P.state === 'parry') && facing) {
      const perfect = P.state === 'parry' || P.clock - P.blockPressT <= FEEL.parryWindow;
      // a turned arrow: sparks off the blade, a breath of slow-mo; a blocked one only costs posture
      this.clash(point, perfect ? 1.3 : 0.7, tan);
      if (perfect) { P.gainFocus(FEEL.focus.parry * 0.6); this.slowmo(0.4, 0.25, 0.03, 0.25); bus.emit('player:parry', { perfect: true, pos: point, arrow: true }); g.log('PARRY', 'arrow'); }
      else { const broke = P.addPosture(10); if (broke) P.onGuardBreak(dirX / n, dirZ / n); g.log('block', 'arrow'); }
      return;
    }
    if (P.invulnerable) return;
    const damage = (a.damage ?? 12) * a.owner.K.dmgMul;
    P.onHurt({ damage, dirX: dirX / n, dirZ: dirZ / n, heavy: false });
    this.breakCombo();
    bus.emit('player:hurt', { damage: Math.round(damage), pos: point, dir: { x: dirX / n, y: 0, z: dirZ / n }, id: a.owner.id });
    bus.emit('player:hp', { hp: P.hp, max: P.maxHp });
    try { P.ch.flash(0xff4a2a, 0.22); } catch { /* optional */ }
    this.vfx?.blood?.(point, tan, 0.7, false);
    this.hitstop(0.04);
    g.camera.shake(0.3);
    g.log('hurt', 'arrow', Math.round(damage));
  }

  // ------------------------------------------------------------------------------------------ execution
  /** 处决: the blade goes in (player's 'stab' event). Grunts die; the master loses a third of his life. */
  executeStab(P, e) {
    const g = this.game;
    if (!e?.active) return;
    const point = e.chest(new THREE.Vector3());
    const tan = P.forward(new THREE.Vector3());
    const lethal = !e.boss || e.hp <= e.maxHp * 0.34;
    this.vfx?.blood?.(point, tan, 2.4, false);
    this.vfx?.blood?.(point, tan, 1.6, true);
    lamps.flash(point, [1.0, 0.4, 0.2], 6, 0.2);
    this.hitstop(0.16);
    this.slowmo(0.25, 0.5, 0.02, 0.5);
    this.kick({ exposure: 0.25, ca: 0.02, radial: 0.02, at: point, ms: 160 });
    g.camera.shake(0.5);
    P.gainFocus(20);
    if (lethal) {
      e.hp = 0;
      e.alive = false; e.state = 'dead'; e.strike = null; e.chain = null; e.deadT = 0;
      e.play('executed', { fade: 0.08 });
      this.game.coordinator?.release(e);
      if (P.lock === e) P.lockOn(null);
      bus.emit('enemy:hit', { id: e.id, pos: point.clone(), dir: { x: tan.x, y: tan.y, z: tan.z }, damage: 999, kill: true, part: 'torso', hp: 0, max: e.maxHp, kind: e.kind, heavy: true, result: 'kill', execute: true, combo: this.countHit() });
      this.kill(e, point, tan);
    } else {
      e.hp = Math.max(1, e.hp - e.maxHp * 0.33);
      e.posture = 0;
      e.state = 'react'; e.play('hitHeavy', { fade: 0.05 });
      bus.emit('enemy:hit', { id: e.id, pos: point.clone(), dir: { x: tan.x, y: tan.y, z: tan.z }, damage: Math.round(e.maxHp * 0.33), kill: false, part: 'torso', hp: e.hp, max: e.maxHp, kind: e.kind, heavy: true, result: 'execute' });
    }
    bus.emit('player:execute', { id: e.id, lethal });
    g.log('EXECUTE', e.id, lethal ? 'kill' : '-33%');
  }

  // ------------------------------------------------------------------------------------------ grass
  /** Cut stubble + clippings when the tip passes through the grass; one slash gust per swing window. */
  _grass(att, s, live) {
    const ix = this.ix;
    if (live) {
      if (!s._grassOn) { s._grassOn = true; s._chord0 = att.tip1.clone(); s._hSum = 0; s._hN = 0; s._clip = []; }
      const gy = this.game.heightAt(att.tip1.x, att.tip1.z);
      const h = att.tip1.y - gy;
      s._hSum += h; s._hN++;
      if (h < 0.95 && att.bladeValid) {
        ix?.cut?.(att.tip0.x, att.tip0.z, att.tip1.x, att.tip1.z, 0.3);
        if (s._clip.length < 8) s._clip.push(att.tip1.clone());
      }
      return;
    }
    s._grassOn = false;
    const h = s._hN ? s._hSum / s._hN : 1;
    const strength = s.kind === 'heavy' ? 1.4 : s.kind === 'special' ? 2 : att.team === 0 ? 0.9 : 0.7;
    if (s._chord0) ix?.slash?.(s._chord0.x, s._chord0.z, att.tip1.x, att.tip1.z, strength, clamp(h, 0.2, 1.6));
    if (s._clip?.length) {
      this._tangent(att, _t);
      this.vfx?.clippings?.(s._clip, _t);
    }
  }

  _trailFor(att) {
    if (att._trail === undefined) {
      try { att._trail = this.vfx?.trail?.(att.id) ?? null; } catch { att._trail = null; }
    }
    return att._trail;
  }
}
