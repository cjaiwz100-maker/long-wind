// Enemy AI: per-enemy brain + a group coordinator. Owner: gameplay (P).
//
//  approach → circle (strafe on an assigned slot around the player, facing him) → [token] close → attack (telegraph
//  glint, strike, combo chain) → recover (back off) → circle …   plus reactive guard, stagger, reactions, death.
//  The Coordinator hands out attack tokens: at most `maxAttackers` (1–2) enemies commit at once, with a minimum
//  spacing between committed attacks so strikes arrive one after another (readable, parryable) instead of together.
//  Slots spread the ring (±43°) around a bearing on the SUN side of the hero (game.js), so the pack circles into the
//  light: a locked-on camera shoots contre-jour, and attacks come from in front of the lens, never from behind it.
import * as THREE from 'three';
import { clamp, wrapAngle, yawOf, lerp, expK } from './util.js';
import { meta } from './actor.js';

export class Coordinator {
  constructor({ maxAttackers = 2, spacing = 0.7 } = {}) {
    this.max = maxAttackers;
    this.spacing = spacing;
    this.holders = new Set();
    this.lastGrant = -99;
  }
  request(e, now) {
    if (this.holders.has(e)) return true;
    if (this.holders.size >= this.max) return false;
    if (now - this.lastGrant < this.spacing) return false;
    this.holders.add(e); e.token = true; this.lastGrant = now;
    return true;
  }
  release(e) { if (this.holders.delete(e)) e.token = false; }
  reset() { for (const e of this.holders) e.token = false; this.holders.clear(); this.lastGrant = -99; }
  get attackers() { return this.holders.size; }
}

const _v = new THREE.Vector3();

function brainOf(e, rng) {
  if (!e.brain) {
    const K = e.K;
    e.brain = {
      radius: lerp(K.circle[0], K.circle[1], rng.next()),
      dir: rng.sign(),              // strafe direction
      switchT: rng.range(1.5, 3.5),
      cooldown: rng.range(K.cooldown[0], K.cooldown[1]) * 0.6,
      recoverT: 0,
      slotAngle: 0,
      tauntDone: !e.boss,
      jitter: rng.range(0, 10),
      noticed: false,
    };
  }
  return e.brain;
}

/** Assign ring slots: bearings (from the player) spread around `centerHeading` by pool index. */
export function assignSlots(enemies, centerHeading) {
  // enemies are pooled in a fixed order, so pool order == slot order (no sort, no allocation)
  let n = 0;
  for (const e of enemies) if (e.alive && e.active) n++;
  let i = 0;
  for (const e of enemies) {
    if (!e.alive || !e.active) continue;
    const b = e.brain;
    // the ring stays in front of the hero (±50°): attacks come from the lit side, never from behind the camera
    const fan = n <= 2 ? 0.5 : 0.75;
    const spread = n <= 1 ? 0 : lerp(-fan, fan, i / (n - 1));
    i++;
    // slot bearing measured FROM the player
    if (b) b.slotAngle = centerHeading + spread;
  }
}

/**
 * One AI step for enemy `e`. ctx: { player, rng, now, coordinator, dt, heightAt, combat }
 * Sets e.vel / facing / locomotion and starts actions through the Enemy API.
 */
export function think(e, dt, ctx) {
  const { player, rng, coordinator } = ctx;
  e.clock += dt;
  if (!e.active) return;
  if (!e.alive) { e.updateDead(dt); brake(e, dt, 6); e.setLocomotion(0, 0, 0, true); return; }
  const K = e.K;
  const b = brainOf(e, rng);
  const d = e.distTo(player);
  const toPx = player.pos.x - e.pos.x, toPz = player.pos.z - e.pos.z;
  const playerDown = !player.alive;
  let speed = 0, vx = 0, vz = 0, face = true;

  // boss phase 2 at half health: faster, more aggressive (director listens for the phase change)
  if (e.boss && e.phase === 1 && e.hp < e.maxHp * 0.5) {
    e.phase = 2; e.speedMul = 1.12; b.cooldown = Math.min(b.cooldown, 0.4);
    ctx.onPhase?.(e, 2);
  }
  const attacks = e.phase === 2 && K.attacks2 ? K.attacks2 : K.attacks;
  // the shield goes up whenever he is not doing something else
  if (K.shield) e.setShield(e.alive && (e.state === 'circle' || e.state === 'close' || e.state === 'recover' || e.state === 'approach'));

  switch (e.state) {
    case 'approach': {
      if (e.clock < e.holdUntil) { speed = 0; break; }   // staggered start after the wave spawn
      // walk in from the sun side, break into a run when close enough to mean it
      const run = d < 16 && d > K.circle[1] + 1;
      speed = d > K.circle[1] + 0.6 ? (run ? K.run * (e.boss ? 0.45 : 1) : K.walk) : 0;
      if (d <= K.circle[1] + 0.6) {
        if (!b.tauntDone) { b.tauntDone = true; e.state = 'taunt'; e.play(e.boss ? 'bossTaunt' : 'taunt', { fade: 0.2 }); break; }
        e.state = 'circle';
      }
      vx = toPx / (d || 1) * speed; vz = toPz / (d || 1) * speed;
      break;
    }
    case 'taunt': {
      if (e.clipT >= (e.clipMeta?.duration ?? 1)) { e.stopAction(0.25); e.state = 'circle'; b.cooldown = 0.4; }
      break;
    }
    case 'circle': {
      if (playerDown) { speed = 0; break; }
      // preferred point on the ring at the slot bearing, plus a tangential strafe
      b.switchT -= dt;
      if (b.switchT <= 0) { b.dir = rng.chance(0.6) ? -b.dir : b.dir; b.switchT = rng.range(1.4, 3.6); b.radius = lerp(K.circle[0], K.circle[1], rng.next()); }
      // polar steering around the hero: walk AROUND him (never through) toward the slot bearing, hold the ring
      // radius, and idle-strafe a little once on station so the pack keeps breathing
      const a = yawOf(-toPx, -toPz);                       // bearing of this enemy seen from the player
      const da = wrapAngle(b.slotAngle - a);
      const onSlot = Math.abs(da) < 0.25;
      const vt = onSlot ? b.dir * 0.45 + da * 1.6 : clamp(da * 2.2, -1, 1) * (Math.abs(da) > 1 ? 1.7 : 1.15);
      const vr = clamp((b.radius - d) * (K.ranged && d < K.kite ? 2.2 : 0.9), -1.2, K.ranged ? 2.2 : 1.2);   // + = away from the player
      // tangent for increasing bearing = (cos a, −sin a); radial outward = (sin a, cos a)
      let sx = Math.cos(a) * vt + Math.sin(a) * vr, sz = -Math.sin(a) * vt + Math.cos(a) * vr;
      const sl = Math.hypot(sx, sz);
      speed = Math.min(K.strafe * Math.max(1, sl), sl * 1.6);
      if (d > K.circle[1] + 2.5) { speed = K.run * 0.8; sx = toPx; sz = toPz; }
      const n = Math.hypot(sx, sz) || 1;
      vx = sx / n * speed; vz = sz / n * speed;
      // attack decision
      b.cooldown -= dt;
      if (K.ranged) {
        // archers: shoot from the ring; too close → a kick to make room, then back off
        b.shotCool = (b.shotCool ?? rng.range(0.8, 2.0)) - dt;
        if (d < 2.4 && b.cooldown <= 0 && player.state !== 'dead') { e.beginChain(rng.pick(attacks)); b.cooldown = rng.range(K.cooldown[0], K.cooldown[1]); break; }
        if (b.shotCool <= 0 && d > K.ranged.range[0] && d < K.ranged.range[1] && player.state !== 'dead') {
          b.shotCool = rng.range(K.ranged.cooldown[0], K.ranged.cooldown[1]);
          e.startShot(K.ranged.clip);
        }
        break;
      }
      if (b.cooldown <= 0 && player.state !== 'dead' && coordinator.request(e, ctx.now)) {
        // the master leaps in from range (phase 2 more often)
        const L = K.leap;
        if (L && d > L.min && d < L.max && rng.chance(e.phase === 2 ? L.chance * 1.6 : L.chance)) { e.beginChain(['bossLeap']); break; }
        b.chain = rng.pick(attacks);
        const m0 = meta(b.chain[0]);
        if (m0?.ranged) { e.startShot(b.chain[0]); break; }
        e.state = 'close';
      }
      break;
    }
    case 'close': {
      // run in to striking range; give up if it takes too long
      const reach = (meta(b.chain?.[0])?.reach ?? 2) * K.reachMul;
      speed = d > reach + 0.9 ? K.run : K.walk;
      vx = toPx / (d || 1) * speed; vz = toPz / (d || 1) * speed;
      b.closeT = (b.closeT ?? 0) + dt;
      if (d <= reach + 0.55 || (d < reach + 1.6 && b.closeT > 0.4)) {
        b.closeT = 0;
        e.beginChain(b.chain);
        speed = 0; vx = vz = 0;
      } else if (b.closeT > 3.5 || playerDown) {
        b.closeT = 0; coordinator.release(e); e.state = 'circle'; b.cooldown = rng.range(0.5, 1.2);
      }
      break;
    }
    case 'attack': {
      face = false;
      if (!e.updateAttack(dt)) {
        coordinator.release(e);
        b.recoverT = rng.range(0.5, 1.1) * (e.boss ? 0.6 : 1);
        b.cooldown = rng.range(K.cooldown[0], K.cooldown[1]) / (e.phase === 2 ? 1.5 : 1);
      }
      break;
    }
    case 'executing': { face = false; speed = 0; break; }   // pinned on the hero's blade (player.startExecute)
    case 'shoot': {
      face = false;
      if (!e.updateShot(dt)) { coordinator.release(e); b.recoverT = rng.range(0.4, 0.9); b.cooldown = rng.range(K.cooldown[0], K.cooldown[1]) / (e.phase === 2 ? 1.5 : 1); }
      break;
    }
    case 'recover': {
      // step back out of range, still facing the player
      b.recoverT -= dt;
      speed = d < K.circle[0] ? K.walk * 0.9 : 0;
      vx = -toPx / (d || 1) * speed; vz = -toPz / (d || 1) * speed;
      if (b.recoverT <= 0) e.state = 'circle';
      break;
    }
    case 'block': {
      if (e.clip === 'blockHit' && e.clipT >= (e.clipMeta?.duration ?? 0.35)) e.play('block', { fade: 0.1, loop: true });
      if (e.clock > e.blockUntil) {
        e.stopAction(0.18);
        // counter-attack out of a successful guard
        if (e.boss && coordinator.request(e, ctx.now)) { e.beginChain(rng.pick(attacks.filter((c) => !meta(c[0])?.ranged && c[0] !== 'bossLeap'))); break; }
        e.state = 'circle';
      }
      break;
    }
    case 'react': {
      face = false;
      if (e.clipT >= (e.clipMeta?.duration ?? 0.5)) {
        e.stopAction(0.2);
        e.state = e.boss && rng.chance(0.5) ? 'circle' : 'recover';
        b.recoverT = rng.range(0.3, 0.7);
        // the swordmaster answers pressure with an immediate counter
        if (e.boss && rng.chance(0.45) && coordinator.request(e, ctx.now)) e.beginChain(rng.pick(attacks.filter((c) => !meta(c[0])?.ranged && c[0] !== 'bossLeap')));
      }
      break;
    }
    case 'down': {
      // knocked flat: lie there a beat, then the get-up; open to follow-up cuts the whole time
      face = false;
      if (e.clip === 'knockdown' && e.clipT >= (e.clipMeta?.duration ?? 1) + (b.downHold ?? 0)) {
        e.play('getUp', { fade: 0.12 });
      } else if (e.clip === 'getUp' && e.clipT >= (e.clipMeta?.duration ?? 1)) {
        e.stopAction(0.2); e.state = 'recover'; b.recoverT = rng.range(0.3, 0.6);
      } else if (e.clip !== 'knockdown' && e.clip !== 'getUp') { e.stopAction(0.2); e.state = 'recover'; b.recoverT = 0.4; }
      break;
    }
    case 'stagger': {
      face = false;
      if (e.clock > e.stunUntil && (!e.clipMeta || e.clipT >= e.clipMeta.duration * 0.8)) {
        e.stopAction(0.25); e.posture = 0; e.state = 'recover'; b.recoverT = 0.5;
      }
      break;
    }
    default: break;
  }

  // separation from other enemies is handled by the game; here: accelerate toward the chosen velocity
  const k = expK(8, dt);
  e.vel.x += (vx - e.vel.x) * k; e.vel.z += (vz - e.vel.z) * k;
  if (face && player.alive && e.state !== 'approach') e.faceTowards(player.pos.x, player.pos.z, K.turn, dt);
  else if (e.state === 'approach' && speed > 0.1) e.faceTowards(e.pos.x + vx, e.pos.z + vz, K.turn * 0.6, dt);
  const sp = Math.hypot(e.vel.x, e.vel.z);
  e.setLocomotion(sp, e.vel.x, e.vel.z, true, e.turnRate(dt));
}

function brake(e, dt, rate) { const k = expK(rate, dt); e.vel.x -= e.vel.x * k; e.vel.z -= e.vel.z * k; }

/** React to the player starting a swing: guard up (chance), from the front, when free. */
export function onPlayerAttack(e, player, rng) {
  if (!e.alive || !e.active) return;
  if (e.state !== 'circle' && e.state !== 'recover' && e.state !== 'close') return;
  const d = e.distTo(player);
  if (d > 3.6) return;
  const a = Math.abs(e.angleTo(player));
  if (a > 0.9) return;
  const chance = e.K.blockChance * (e.phase === 2 ? 1.3 : 1);
  if (rng.chance(chance)) {
    if (e.token) e.game.coordinator?.release(e);
    e.startBlock(rng.range(0.6, 1.2));
  }
}

export { wrapAngle, yawOf, clamp };
