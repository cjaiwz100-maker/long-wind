// Gameplay move table: the timing contract gameplay needs from every clip, with the bible §7.3 numbers as the
// fallback. Owner: gameplay (P).
//
// CLIPS[name].meta (animation, A) is authoritative whenever it is authored. While a clip is still a placeholder
// (the animation registry fills missing clips with { type:'misc', duration:1, hit:[] }), gameplay uses the entry
// below instead, so the fight logic keeps working at any stage of the parallel build. Authored metas are also
// completed field-by-field from this table (e.g. dodge i-frames, enemy wind-ups) when A leaves a field out.
//
//   gameMeta(name) → meta object (cached, never null for a known clip)
import { CLIPS } from '../character/animator.js';

// seconds; hit = [[t0, t1], ...] live blade windows; combo = chain input window; cancel = earliest dodge/block cancel
export const FALLBACK = {
  // ---- hero light string (bible: startup / active / recovery)
  attack1: { duration: 0.6, type: 'light', hit: [[0.14, 0.25]], combo: [0.24, 0.52], cancel: 0.32, damage: 18, posture: 12, reach: 2.1, lunge: 0.4 },
  attack2: { duration: 0.58, type: 'light', hit: [[0.12, 0.22]], combo: [0.22, 0.5], cancel: 0.3, damage: 18, posture: 12, reach: 2.1, lunge: 0.35 },
  attack3: { duration: 0.72, type: 'light', hit: [[0.16, 0.26]], combo: [0.27, 0.6], cancel: 0.4, damage: 22, posture: 16, reach: 2.3, lunge: 0.6 },
  attack4: { duration: 0.9, type: 'light', hit: [[0.2, 0.33]], combo: null, cancel: 0.55, damage: 30, posture: 26, reach: 2.3, lunge: 0.7 },
  thrust: { duration: 0.64, type: 'thrust', hit: [[0.16, 0.24]], combo: [0.26, 0.52], cancel: 0.38, damage: 24, posture: 14, reach: 2.7, lunge: 1.8 },
  heavy: { duration: 1.02, type: 'heavy', hit: [[0.36, 0.5]], combo: null, cancel: 0.72, damage: 42, posture: 40, reach: 2.5, lunge: 2.5 },
  heavyCharge: { duration: 1.0, loop: true, type: 'heavy' },
  special: { duration: 1.1, type: 'special', hit: [[0.42, 0.56]], combo: null, cancel: 0.85, damage: 50, posture: 60, reach: 3.0, lunge: 0.6 },
  // ---- defence / movement
  dodgeF: { duration: 0.55, type: 'dodge', iframes: [0.05, 0.3], cancel: 0.38 },
  dodgeB: { duration: 0.55, type: 'dodge', iframes: [0.05, 0.3], cancel: 0.38 },
  dodgeL: { duration: 0.52, type: 'dodge', iframes: [0.05, 0.28], cancel: 0.36 },
  dodgeR: { duration: 0.52, type: 'dodge', iframes: [0.05, 0.28], cancel: 0.36 },
  block: { duration: 1.0, loop: true, type: 'defense' },
  blockHit: { duration: 0.35, type: 'defense' },
  parry: { duration: 0.5, type: 'defense', cancel: 0.12 },
  parried: { duration: 0.85, type: 'reaction' },
  // ---- reactions
  hitFront: { duration: 0.5, type: 'reaction' },
  hitBack: { duration: 0.5, type: 'reaction' },
  hitHeavy: { duration: 0.8, type: 'reaction' },
  stagger: { duration: 1.3, type: 'reaction' },
  knockdown: { duration: 1.5, type: 'reaction' },
  getUp: { duration: 1.0, type: 'reaction' },
  death: { duration: 1.9, type: 'reaction' },
  deathBack: { duration: 1.9, type: 'reaction' },
  // ---- misc
  draw: { duration: 0.5, type: 'misc' },
  sheathe: { duration: 0.65, type: 'misc' },
  taunt: { duration: 1.6, type: 'misc' },
  victory: { duration: 2.6, type: 'misc' },
  turnL: { duration: 0.5, type: 'misc' },
  turnR: { duration: 0.5, type: 'misc' },
  // ---- enemies (long wind-ups: the telegraph glint shows 0.35 s before the first hit frame)
  enemyAttack1: { duration: 1.05, type: 'enemy', hit: [[0.52, 0.64]], damage: 14, posture: 22, reach: 2.1, lunge: 0.9 },
  enemyAttack2: { duration: 1.0, type: 'enemy', hit: [[0.48, 0.6]], damage: 14, posture: 22, reach: 2.1, lunge: 0.8 },
  enemyThrust: { duration: 1.0, type: 'enemy', hit: [[0.5, 0.6]], damage: 16, posture: 24, reach: 2.6, lunge: 1.4 },
  enemyHeavy: { duration: 1.55, type: 'enemy', hit: [[0.88, 1.04]], damage: 30, posture: 45, reach: 2.4, lunge: 1.2, unblockable: true },
};

const DEFAULTS = { duration: 1, loop: false, type: 'misc', hit: [], combo: null, cancel: null, damage: 0, posture: 0, reach: 0, lunge: 0 };
const cache = new Map();

/** Is an animation meta the registry's placeholder for an unauthored clip? */
export function isPlaceholder(m, name) {
  if (!m) return true;
  const fb = FALLBACK[name];
  return !!fb && fb.type !== 'misc' && m.type === 'misc' && m.duration === 1 && !(m.hit?.length) && !m.combo && !m.damage && !m.reach;
}

/** Gameplay meta for a clip (authored animation meta completed from the fallback table). */
export function gameMeta(name) {
  const src = CLIPS[name]?.meta ?? null;
  const hit = cache.get(name);
  if (hit && hit.src === src) return hit.meta;
  const fb = FALLBACK[name];
  let meta = null;
  if (!src && !fb) meta = null;
  else if (!src || isPlaceholder(src, name)) meta = { ...DEFAULTS, ...fb, placeholder: true };
  else {
    meta = { ...DEFAULTS, ...src };
    if (fb) for (const k of Object.keys(fb)) if (meta[k] === undefined || meta[k] === null) meta[k] = fb[k];
    // an attack without authored hit frames still needs windows
    if (fb?.hit && !(meta.hit?.length)) meta.hit = fb.hit;
    if (fb?.iframes && !meta.iframes) meta.iframes = fb.iframes;
  }
  if (meta && (meta.cancel === null || meta.cancel === undefined)) meta.cancel = meta.duration;
  cache.set(name, { src, meta });
  return meta;
}

/** Validate the move table (used by the node tests). Returns a list of problems. */
export function validateMoves() {
  const bad = [];
  for (const [name, m] of Object.entries(FALLBACK)) {
    for (const [a, b] of m.hit ?? []) if (!(a >= 0 && b > a && b <= m.duration)) bad.push(`${name}: hit window ${a}–${b} outside 0–${m.duration}`);
    if (m.combo && !(m.combo[0] < m.combo[1] && m.combo[1] <= m.duration)) bad.push(`${name}: combo window`);
    if (m.iframes && !(m.iframes[0] < m.iframes[1] && m.iframes[1] < m.duration)) bad.push(`${name}: iframes`);
    if (m.type === 'enemy' && m.hit?.length && m.hit[0][0] < 0.4) bad.push(`${name}: wind-up shorter than the 0.35 s telegraph`);
  }
  return bad;
}
