// Enemy actors: bandit, bandit_heavy, spearman, archer, shieldman, swordmaster. The body/reaction layer (attack execution, telegraph, hit and
// posture reactions, death, corpse sinking) lives here; decisions live in ai.js. Owner: gameplay (P).
import * as THREE from 'three';
import { Actor, meta } from './actor.js';
import { clamp, yawOf } from './util.js';
import { bus } from '../core/bus.js';
import { bowEars } from '../character/sword.js';

/** Per-kind tuning. attacks: combo chains (arrays of enemy clips) picked at random by the AI. */
export const KINDS = {
  bandit: {
    hp: 70, posture: 70, radius: 0.42, walk: 1.45, run: 4.2, strafe: 1.3, turn: 7.5, animSpeed: 1,
    attacks: [['enemyAttack1'], ['enemyAttack2'], ['enemyThrust'], ['enemyAttack1', 'enemyAttack2']],
    blockChance: 0.22, parryChance: 0, poise: 0, dmgMul: 1, circle: [3.8, 5.4], cooldown: [1.4, 3.2], reachMul: 1,
  },
  bandit_heavy: {
    hp: 150, posture: 125, radius: 0.5, walk: 1.15, run: 3.3, strafe: 0.9, turn: 4.5, animSpeed: 0.92,
    attacks: [['enemyHeavy'], ['enemyAttack1', 'enemyHeavy'], ['enemyHeavy'], ['enemyAttack2']],
    blockChance: 0.1, parryChance: 0, poise: 1, dmgMul: 1.3, circle: [3.3, 4.6], cooldown: [1.8, 3.6], reachMul: 1.08,
  },
  // long reach: holds a wider ring and punishes a slow approach with the low sweep
  spearman: {
    hp: 80, posture: 75, radius: 0.42, walk: 1.4, run: 4.0, strafe: 1.2, turn: 6.5, animSpeed: 1,
    attacks: [['spearJab2'], ['spearSweep'], ['enemyThrust'], ['spearJab2', 'spearSweep']],
    blockChance: 0.12, parryChance: 0, poise: 0.2, dmgMul: 1, circle: [4.6, 6.2], cooldown: [1.5, 3.2], reachMul: 1,
  },
  // keeps his distance and shoots (the draw is the telegraph); kicks you off him when you close in
  archer: {
    hp: 55, posture: 50, radius: 0.4, walk: 1.5, run: 4.6, strafe: 1.6, turn: 7, animSpeed: 1,
    attacks: [['enemyKick']], ranged: { clip: 'bowShot', range: [5, 22], cooldown: [2.4, 4.2] }, kite: 4.5, sheathed: true,
    blockChance: 0, parryChance: 0, poise: 0, dmgMul: 1, circle: [9, 13], cooldown: [1.2, 2.4], reachMul: 1,
  },
  // the rattan shield turns every light cut from the front: break it with a heavy, or go round it
  shieldman: {
    hp: 110, posture: 110, radius: 0.48, walk: 1.2, run: 3.6, strafe: 1.0, turn: 5, animSpeed: 0.95, shield: true,
    attacks: [['shieldBash'], ['enemyAttack1'], ['shieldBash', 'enemyAttack2'], ['enemyAttack2']],
    blockChance: 0, parryChance: 0, poise: 0.6, dmgMul: 1.1, circle: [3.2, 4.4], cooldown: [1.6, 3.2], reachMul: 1,
  },
  // 夜枭: the bamboo grove's boss. Quick, light on his feet; melts into the rain and strikes from behind
  // (assassinBlink), throws dart fans (dartThrow). Phase 2 vanishes far more often.
  assassin: {
    hp: 700, posture: 190, radius: 0.4, walk: 1.9, run: 5.6, strafe: 2.2, turn: 10, animSpeed: 1.12, slip: 0.3,
    attacks: [['enemyAttack1', 'enemyAttack2'], ['bossFlurry'], ['dartThrow'], ['enemyThrust', 'enemyAttack1'], ['bossDash'], ['assassinBlink']],
    attacks2: [['assassinBlink'], ['bossFlurry', 'enemyThrust'], ['dartThrow'], ['assassinBlink'], ['bossDash', 'bossFlurry'], ['enemyAttack2', 'enemyAttack1', 'enemyThrust']],
    blockChance: 0.2, parryChance: 0.22, poise: 0.35, dmgMul: 1.15, circle: [4.0, 6.0], cooldown: [0.6, 1.5], reachMul: 1.05,
    boss: true, name: '夜枭', sub: 'The Night Owl',
  },
  swordmaster: {
    hp: 650, posture: 220, radius: 0.42, walk: 1.7, run: 5.0, strafe: 1.7, turn: 9, animSpeed: 1.1,
    attacks: [['enemyAttack1', 'enemyAttack2', 'enemyThrust'], ['bossFlurry'], ['enemyAttack2', 'enemyAttack1'],
      ['enemyAttack1', 'enemyAttack2', 'enemyHeavy'], ['bossDash'], ['bossFlurry', 'enemyHeavy']],
    // phase 2 (below half health): the leap, the 居合 dash and the qi wave join in, chains get longer
    attacks2: [['bossFlurry', 'bossDash'], ['bossLeap'], ['bossQi'], ['enemyAttack1', 'bossFlurry'], ['bossDash', 'enemyHeavy'], ['bossQi', 'bossLeap']],
    leap: { min: 5.5, max: 9, chance: 0.35 },
    blockChance: 0.34, parryChance: 0.3, poise: 0.5, dmgMul: 1.3, circle: [3.4, 5.0], cooldown: [0.7, 1.8], reachMul: 1.05,
    boss: true, name: '断刀客', sub: 'The Broken-Blade Master',
  },
};

const _v = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

export class Enemy extends Actor {
  constructor(game, ch, kind, index) {
    const K = KINDS[kind] ?? KINDS.bandit;
    super(game, ch, { id: `${kind}-${index}`, kind, team: 1, hp: K.hp, posture: K.posture, radius: K.radius });
    this.K = K;
    this.slot = index;           // interaction actor slot / trail id
    this.state = 'inactive';
    this.active = false;
    this.alive = false;
    this.brain = null;           // AI scratch state (ai.js)
    this.strike = null;
    this.chain = null; this.chainIdx = 0;
    this.phase = 1;
    this.deadT = 0; this.sink = 0;
    this.blockUntil = 0;
    this.stunUntil = 0;
    this.telegraphed = false;
    this.hitFlashT = 0;
    this.clock = 0;
    this.speedMul = 1;
    this.token = false;
    this.holdUntil = 0;          // approach starts after this (sim clock), set by the director
  }

  pose(dt, t) {
    const ev = super.pose(dt, t);
    if (this.K.ranged) this._bowString();
    return ev;
  }

  /** The archer's string: ear → nock → ear, the nock pulled to the drawing hand through the draw, snapping back on release. */
  _bowString() {
    const g = this.ch.group;
    if (!this._str) {
      // two thin shaded cylinders (a GL line breaks the deferred passes), on the main-view layer
      const geo = new THREE.CylinderGeometry(0.0016, 0.0016, 1, 4, 1, true).translate(0, 0.5, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0x9a8f78, roughness: 0.8 });
      this._str = [0, 1].map(() => { const m = new THREE.Mesh(geo, mat); m.layers.set(2); m.frustumCulled = false; m.castShadow = false; g.add(m); return m; });
      this._ears = bowEars(this.ch.scale ?? 1).map((p) => new THREE.Vector3(...p));
      this._sa = new THREE.Vector3(); this._sb = new THREE.Vector3(); this._sn = new THREE.Vector3();
    }
    const b = g.getObjectByName?.('offhand');
    const on = !!b && this.active;
    for (const m of this._str) m.visible = on;
    if (!on) return;
    const top = g.worldToLocal(this._sa.copy(this._ears[0]).applyMatrix4(b.matrixWorld));
    const bot = g.worldToLocal(this._sb.copy(this._ears[1]).applyMatrix4(b.matrixWorld));
    const nock = this._sn.copy(top).add(bot).multiplyScalar(0.5);
    let k = 0;
    if (this.clip === 'bowShot' && this.alive) {
      const u = this.clipT;
      k = u < 0.5 ? 0 : u < 0.9 ? (u - 0.5) / 0.4 : u < 1.12 ? 1 : 0;
      k = k * k * (3 - 2 * k);
    }
    if (k > 0) nock.lerp(g.worldToLocal(this.ch.rig.bones['hand.R'].getWorldPosition(_v)), k);
    const seg = (m, a, c) => {
      _v.copy(c).sub(a);
      const len = _v.length() || 1e-4;
      m.position.copy(a);
      m.quaternion.setFromUnitVectors(_UP, _v.divideScalar(len));
      m.scale.set(1, len, 1);
    };
    seg(this._str[0], top, nock);
    seg(this._str[1], nock, bot);
  }

  /** World position of the off-hand gear (bow grip / shield), falling back to the left hand. */
  offhandPos(out) {
    const B = this.ch.rig?.bones;
    const b = this.ch.group.getObjectByName?.('offhand') ?? B?.['hand.L'];
    if (b) return b.getWorldPosition(out);
    return this.chest(out);
  }

  get guarding() { return this.state === 'block' && this.alive; }

  /** Authoritative hp/posture for the HUD marks (bus 'enemy:state'). */
  emitState() {
    bus.emit('enemy:state', { id: this.id, hp: this.hp, hpMax: this.maxHp, posture: this.posture, postureMax: this.maxPosture });
    this._stateHp = this.hp; this._statePo = this.posture;
  }
  get boss() { return !!this.K.boss; }

  /** (Re)spawn from the pool. */
  spawn(x, z, yaw) {
    const K = this.K;
    this.maxHp = K.hp; this.hp = K.hp; this.posture = 0; this.alive = true; this.active = true;
    this.state = 'approach'; this.strike = null; this.chain = null; this.phase = 1; this.speedMul = 1;
    this.deadT = 0; this.sink = 0; this.frozenPose = false; this.brain = null; this.token = false;
    this.lift = 0; this.liftV = 0; this.airPitch = 0; this.fell = false; this.hidden = false;
    this.place(x, z, yaw);
    this.stopAction(0);
    this.ch.setVisible(true);
    try { this.ch.sword.setDrawn(!K.sheathed); } catch { /* optional */ }
    try { this.anim.setArmed?.(!K.sheathed); } catch { /* optional */ }
    this.shotCool = 0; this.shot = null;
    // pos is the live position vector: the HUD keeps its marks attached to it
    bus.emit('enemy:spawn', { id: this.id, kind: this.kind, pos: this.pos, boss: this.boss, hp: this.hp, hpMax: this.maxHp,
      name: this.nameOverride?.name ?? this.K.name, sub: this.nameOverride?.sub ?? this.K.sub });
    this.emitState();
  }

  despawn() {
    this.active = false; this.alive = false; this.state = 'inactive';
    this.strike = null;
    this.ch.setVisible(false);
    this.game.coordinator?.release(this);
  }

  // ------------------------------------------------------------------------------------------------ attacks
  /** Begin a combo chain (array of clip names). */
  beginChain(chain) {
    this.chain = chain; this.chainIdx = 0;
    this.startStrike(chain[0]);
  }

  startStrike(name) {
    const m = meta(name);
    if (!m) { this.state = 'circle'; return; }
    const player = this.game.player;
    this.state = 'attack';
    const speed = this.K.animSpeed * this.speedMul;
    this.play(name, { fade: 0.1, speed });
    const hw = m.hit?.[0] ?? [m.duration * 0.5, m.duration * 0.62];
    this.swingId++; this.hitSet.clear();
    this.telegraphed = false;
    this.strike = {
      clip: name, kind: m.unblockable ? 'heavy' : m.type === 'thrust' || name === 'enemyThrust' ? 'thrust' : 'enemy',
      windows: m.hit ?? [], damage: (m.damage || 14) * this.K.dmgMul, posture: (m.posture || 20) * this.K.dmgMul,
      reach: (m.reach || 2) * this.K.reachMul, arc: name === 'enemyThrust' ? 0.5 : 0.95, unblockable: !!m.unblockable,
      bladeR: m.unblockable ? 0.1 : 0.075, swing: this.swingId, contacts: 0, telegraphAt: Math.max(0.04, hw[0] - 0.38 * speed),
      whoosh: false, trail: false, windup: m.windup ?? hw[0], knock: m.knock ?? 0,
    };
    // lunge into range, stopping at a fair gap from the player (so a sidestep makes it whiff)
    const d = this.distTo(player);
    const lunge = clamp(d - 1.4, 0, Math.max(m.lunge ?? 1, 0.5) * 1.35);
    this.startLunge(this.forward(_v), lunge, 0.1 * speed, hw[0] + 0.02, player.pos, 1.2);
    this.vel.set(0, 0, 0);
  }

  /** A ranged move (bow shot, boss qi): no blade windows; the clip's 'shoot' event spawns the projectile. */
  startShot(name) {
    const m = meta(name);
    if (!m) { this.state = 'circle'; return; }
    this.state = 'shoot';
    const speed = this.K.animSpeed * this.speedMul;
    this.play(name, { fade: 0.12, speed });
    this.telegraphed = false;
    this.strike = null;
    this.shot = { clip: name, telegraphAt: Math.max(0.05, (m.shootAt ?? m.duration * 0.6) - 0.45 * speed), fired: false };
    this.vel.set(0, 0, 0);
  }

  /** While shooting: track the target until the release, telegraph the draw. Returns false when done. */
  updateShot(dt) {
    const m = this.clipMeta, s = this.shot;
    if (!m || !s) { this.state = 'recover'; return false; }
    const player = this.game.player;
    if (player.alive && !s.fired) this.faceTowards(player.pos.x, player.pos.z, this.K.turn, dt);
    if (!this.telegraphed && this.clipT >= s.telegraphAt) { this.telegraphed = true; this.game.combat?.telegraph(this, { ranged: true }); }
    if (this.clipT >= m.duration) { this.shot = null; this.stopAction(0.2); this.state = 'recover'; return false; }
    return true;
  }

  /** Shield up (upper-body guard layered over the walk) while circling / closing / backing off. */
  setShield(up) {
    if (!this.K.shield) return;
    if (up && this.clip !== 'shieldGuard') this.play('shieldGuard', { fade: 0.18, loop: true });
    else if (!up && this.clip === 'shieldGuard') this.stopAction(0.15);
  }
  /** The shield is raised (any other action — attack, reaction, stagger — has replaced the guard layer). */
  get shieldUp() { return !!this.K.shield && this.alive && this.clip === 'shieldGuard'; }

  /** Sim seconds until the current strike's first hit frame (−1 if none pending). */
  strikeETA() {
    if (this.state !== 'attack' || !this.strike || !this.clipMeta) return -1;
    const hw = this.strike.windows[0];
    if (!hw) return -1;
    const left = (hw[0] - this.clipT) / (this.clipSpeed || 1);
    return left >= -0.02 ? Math.max(0, left) : -1;
  }

  /** Called each frame while attacking: tracking, telegraph, chaining. Returns true while still attacking. */
  updateAttack(dt) {
    const s = this.strike, m = this.clipMeta;
    if (!s || !m) { this.state = 'recover'; return false; }
    const player = this.game.player;
    // track until the telegraph, then commit (a late sidestep beats the strike)
    const rate = this.telegraphed ? 1.1 : this.K.turn;
    if (player.alive) this.faceTowards(player.pos.x, player.pos.z, rate, dt);
    if (!this.telegraphed && this.clipT >= s.telegraphAt) {
      this.telegraphed = true;
      this.game.combat?.telegraph(this);
    }
    if (this.clipT >= m.duration) {
      // chain the next strike of the combo if the player is still in reach
      if (this.chain && this.chainIdx < this.chain.length - 1 && player.alive && this.distTo(player) < s.reach + 2.2) {
        this.chainIdx++;
        this.startStrike(this.chain[this.chainIdx]);
        return true;
      }
      this.strike = null; this.chain = null;
      this.stopAction(0.2);
      this.state = 'recover';
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------------ reactions
  startBlock(seconds) {
    if (!this.alive) return;
    this.state = 'block';
    this.blockUntil = this.clock + seconds;
    this.play('block', { fade: 0.08, loop: true });
    this.strike = null;
  }

  /** Blade met our guard. Returns true if the guard broke. */
  onBlocked(posture, dirX, dirZ) {
    const broke = this.addPosture(posture);
    if (broke) { this.stagger(dirX, dirZ, 1.5); return true; }
    this.play('blockHit', { fade: 0.04 });
    this.applyKnock(dirX, dirZ, 1.6);
    this.blockUntil = Math.max(this.blockUntil, this.clock + 0.45);
    return false;
  }

  /** A clean hit. `interrupt` false keeps an attack going (hyper-armour). side: +1 the blade came from his right. */
  onHit({ damage, posture, dirX, dirZ, heavy, knock = 2.2, side = 0, high = false, floor = false }) {
    this.hp = Math.max(0, this.hp - damage);
    if (this.hp <= 0) return 'kill';
    // on the ground: the cut lands, he stays down
    if (this.state === 'down') { this.applyKnock(dirX, dirZ, knock * 0.3); return 'down'; }
    // a big blow on a grunt knocks him flat (he gets up again)
    if (floor && !this.boss && this.K.poise < 0.9) { this.knockDown(dirX, dirZ); return 'down'; }
    const broke = this.addPosture(posture);
    if (broke) { this.stagger(dirX, dirZ, 1.6); return 'stagger'; }
    // hyper armour: heavies keep swinging through light hits once committed
    const armoured = this.state === 'attack' && this.K.poise > 0 && !heavy && this.clipT > (this.strike?.windup ?? 0) * (1 - this.K.poise * 0.8);
    this.applyKnock(dirX, dirZ, armoured ? knock * 0.3 : knock);
    if (armoured) return 'armour';
    // 夜枭 doesn't stand and take a combo: a light cut may be the moment he slips into the rain (and comes back behind)
    if (this.K.slip && !heavy && this.state !== 'attack' && this.state !== 'stagger'
      && Math.random() < this.K.slip * (this.phase === 2 ? 1.5 : 1) && this.clock > (this._slipT ?? 0)) {
      this._slipT = this.clock + 2.5;
      this.strike = null; this.chain = null;
      this.beginChain(['assassinBlink']);
      return 'slip';
    }
    const fromBehind = (Math.sin(this.yaw) * -dirX + Math.cos(this.yaw) * -dirZ) < -0.2;
    this.strike = null; this.chain = null;
    this.state = 'react';
    // the blow turns him: spun away from the side the edge came from (the AI turns him back), a head cut snaps the head
    if (side) this.spin(-side * (heavy ? 5.2 : 3.4));
    this.play(heavy || high ? 'hitHeavy' : fromBehind ? 'hitBack' : 'hitFront', { fade: 0.04 });
    this.game.coordinator?.release(this);
    return 'react';
  }

  /** Knocked flat by a finisher: thrown back off his feet, lies a moment, gets up (ai 'down'). */
  knockDown(dirX, dirZ) {
    this.strike = null; this.chain = null;
    this.state = 'down';
    this.play('knockdown', { fade: 0.05 });
    this.applyKnock(dirX, dirZ, 4.8);
    this.launch(2.2);
    this.tiltAxis.set(dirZ, 0, -dirX).normalize();
    if (this.brain) this.brain.downHold = 0.35 + Math.random() * 0.5;
    this.game.coordinator?.release(this);
    if (this.game.player.lock === this) { /* keep the lock: he is getting up */ }
  }

  stagger(dirX, dirZ, seconds = 1.2) {
    this.unhide();
    this.state = 'stagger';
    this.strike = null; this.chain = null;
    this.stunUntil = this.clock + seconds;
    // the dazed clip spans the whole stun (it used to end early and snap back into guard while still open to 处决)
    this.play('stagger', { fade: 0.05, speed: clamp((meta('stagger')?.duration ?? 1.5) / Math.max(0.6, seconds), 0.7, 1.4) });
    this.applyKnock(dirX, dirZ, 2.2);
    this.game.coordinator?.release(this);
    bus.emit('enemy:posture', { id: this.id, broken: true });
  }

  onParried(dirX, dirZ) {
    // the player turned our blade: recoil + heavy posture damage
    this.strike = null; this.chain = null;
    const broke = this.addPosture(this.maxPosture * (this.boss ? 0.28 : 0.45));
    if (broke) { this.stagger(dirX, dirZ, this.boss ? 1.4 : 1.8); return; }
    // bandits are thrown off balance by any perfect parry (the riposte window); the master only recoils
    if (!this.boss) { this.stagger(dirX, dirZ, 0.85); return; }
    this.state = 'react';
    this.play('parried', { fade: 0.03 });
    this.applyKnock(dirX, dirZ, 1.8);
    this.game.coordinator?.release(this);
  }

  /** The assassin's vanish (clip event): gone from sight and from blades until blink(). */
  vanish() {
    if (this.hidden) return;
    this.hidden = true;
    this.ch.setVisible(false);
    if (this.game.player.lock === this) this.game.player.lockOn(null);
    this.game.combat?.vanishFx?.(this);
  }
  /** Reappear behind the hero (clip event 'blink'): placed ~2.2 m behind him, facing him. */
  blink() {
    const P = this.game.player;
    if (P.alive) {
      const bx = P.pos.x - Math.sin(P.yaw) * 2.2, bz = P.pos.z - Math.cos(P.yaw) * 2.2;
      const { x, z } = this.game.clampToArena(bx, bz, 2);
      this.place(x, z, Math.atan2(P.pos.x - x, P.pos.z - z));
    }
    this.unhide();
    this.game.combat?.blinkFx?.(this);
  }
  unhide() { if (!this.hidden) return; this.hidden = false; this.ch.setVisible(true); }

  die(dirX, dirZ, launch = 0) {
    this.unhide();
    this.alive = false;
    this.state = 'dead';
    this.strike = null; this.chain = null;
    this.deadT = 0; this.fell = false;
    const fromBehind = (Math.sin(this.yaw) * -dirX + Math.cos(this.yaw) * -dirZ) < -0.2;
    const thrown = launch > 3;
    this.play(thrown ? 'deathLaunch' : fromBehind ? 'death' : 'deathBack', { fade: thrown ? 0.03 : 0.05 });
    this.applyKnock(dirX, dirZ, 5.0 + launch * 0.6);
    // a finishing blow throws the body: up and back, the torso pitched over by the blow while it flies
    if (launch > 0) {
      this.launch(launch);
      this.tiltAxis.set(dirZ, 0, -dirX).normalize();
      this.airFlip = thrown ? 0.75 : 0.25;
    }
    this.game.coordinator?.release(this);
    if (this.game.player.lock === this) this.game.player.lockOn(null);
  }

  /** Touching down after a launch (alive: a stumble; dead: the body lands). */
  onLand(v) {
    if (!this.alive) { this._fall(v); return; }
    this.game.combat?.landDust?.(this, this.state === 'down' ? 1 : 0.5);
    if (this.state === 'down') bus.emit('enemy:fall', { id: this.id, pos: this.pos.clone(), kind: this.kind, weight: 0.9, weapon: false });
    else if (v > 6) bus.emit('enemy:fall', { id: this.id, pos: this.pos.clone(), kind: this.kind, weight: 0.55, weapon: false });   // dropped from the eaves
  }
  _fall(v = 4) {
    if (this.fell) return;
    this.fell = true;
    const w = this.kind === 'bandit_heavy' || this.boss ? 1.3 : 1;
    this.game.combat?.landDust?.(this, Math.min(1.4, 0.6 + v * 0.1) * w);
    bus.emit('enemy:fall', { id: this.id, pos: this.pos.clone(), kind: this.kind, weight: w * Math.min(1.3, 0.8 + v * 0.06) });
  }

  /** Corpse: hold the last frame of the death clip, then sink into the grass and return to the pool. */
  updateDead(dt) {
    this.deadT += dt;
    // flying: pitch over with the arc; on the ground the death clip's collapse lands ~0.68 s in
    if (this.lift > 0) this.airPitch = this.airFlip * Math.min(1, this.deadT / 0.18);
    else if (this.airPitch) { this.airPitch *= Math.exp(-14 * dt); if (Math.abs(this.airPitch) < 1e-3) this.airPitch = 0; }
    else if (!this.fell && this.deadT > 0.68 / (this.clipSpeed || 1)) this._fall(3);
    // freeze a little before the clip ends: the animator returns to locomotion on its last frame
    if (!this.frozenPose && this.clipMeta && this.clipT >= this.clipMeta.duration - 0.07 * (this.clipSpeed || 1)) this.frozenPose = true;
    if (this.deadT > 7) {
      this.sink += dt * 0.12;
      this.hop = -this.sink;
      if (this.sink > 0.55) this.despawn();
    }
  }
}

export { yawOf };
