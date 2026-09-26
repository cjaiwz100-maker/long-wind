// Townsfolk clips (world/citizens.js). Owner: animation (A) vocabulary, authored for the crowd.
//
//   cower   drop into a crouch facing a wall, head tucked, both hands clasped over the back of the head (held: the
//           citizen stays down until gameplay calls anim.stop()). meta.hold keeps the last pose; breathing still runs.
//   cowerUp a quick look up out of the crouch (upper body only; played while cowering to break the stillness)
import { NEUTRAL, K, hand, nrm } from './poses.js';

// head over the knees: pelvis low and pitched, spine rounded, neck bowed
const CROUCH = {
  ...NEUTRAL,
  hip: [0, -0.46, -0.06], pel: [24, 0, 0], sp: [12, 0, 0], ch: [10, 0, 0], nk: [14, 0, 0], hd: [22, 0, 0],
  lf: [0.17, 0, 0.04, 18, 0, 0], rf: [-0.16, 0, -0.05, -16, 0, 0], lk: [1, 1], el: [10, 10], tw: 0,
  lh: hand([0.07, 0.94, 0.36], nrm([-0.55, -0.2, 0.8]), nrm([0.1, -0.8, 0.55])),
  rh: hand([-0.07, 0.94, 0.36], nrm([0.55, -0.2, 0.8]), nrm([-0.1, -0.8, 0.55])),
};
// the first flinch: shoulders up, arms coming over the head, knees already giving
const DUCK = {
  ...CROUCH,
  hip: [0, -0.26, -0.02], pel: [18, 0, 0], sp: [10, 0, 0], ch: [8, 0, 0], nk: [8, 0, 0], hd: [12, 0, 0],
  lh: hand([0.12, 1.42, 0.2], nrm([-0.5, 0.3, 0.8]), nrm([0.2, -0.7, 0.6])),
  rh: hand([-0.12, 1.42, 0.2], nrm([0.5, 0.3, 0.8]), nrm([-0.2, -0.7, 0.6])),
};

export const CITIZEN_CLIPS = {
  cower: {
    meta: { duration: 0.75, type: 'misc', hold: true, look: 0.2, autoStep: false },
    keys: [
      K(0, NEUTRAL, {}),
      K(0.2, DUCK, {}),
      K(0.5, CROUCH, { hip: [0, -0.49, -0.06] }),
      K(0.75, CROUCH, {}, 'flat'),
    ],
  },
  cowerUp: {
    meta: { duration: 1.6, type: 'misc', hold: true, look: 0.2, autoStep: false },
    keys: [
      K(0, CROUCH, {}),
      K(0.35, CROUCH, { nk: [-6, 0, 0], hd: [-12, 18, 0], ch: [6, 6, 0], lh: hand([0.1, 0.98, 0.3], nrm([-0.3, -0.2, 0.9]), nrm([0.2, -0.8, 0.4])) }),
      K(1.0, CROUCH, { nk: [-4, 0, 0], hd: [-10, -14, 0], ch: [6, -4, 0] }),
      K(1.6, CROUCH, {}, 'flat'),
    ],
  },
};
