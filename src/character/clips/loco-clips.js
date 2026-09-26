// Locomotion clip entries. Owner: animation (A).
// Locomotion is procedural (clips/locomotion.js): these entries exist for the CLIPS contract (names + meta, e.g.
// the nominal cycle length at the reference speed) and for previews. play('walk') etc. simply returns to
// locomotion; drive it with anim.setLocomotion().
import { IDLE, STANCE } from './poses.js';

const loco = (duration, extra = {}) => ({ meta: { duration, loop: true, type: 'loco', ...extra }, base: IDLE, keys: [] });

export const LOCOMOTION_CLIPS = {
  idle: loco(4.0, { speed: 0 }),
  combatIdle: { ...loco(3.0, { speed: 0 }), base: STANCE },
  walk: loco(0.875, { speed: 1.6 }),        // cycle = 2 steps × 0.70 m / 1.6 m/s
  run: loco(0.577, { speed: 5.2 }),         // 2 × 1.50 m / 5.2 m/s, contact 0.16 s
  sprint: loco(0.553, { speed: 8.5 }),      // 2 × 2.35 m / 8.5 m/s (轻功: long floating strides, contact 0.1 s)
  walkBack: { ...loco(0.585, { speed: 1.4 }), base: STANCE },
  strafeL: { ...loco(0.54, { speed: 1.8 }), base: STANCE },
  strafeR: { ...loco(0.54, { speed: 1.8 }), base: STANCE },
};
