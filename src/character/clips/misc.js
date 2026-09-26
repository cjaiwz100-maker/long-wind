// Draw, sheathe (the signature beat), taunt, victory and in-place turns. Owner: animation (A).
//
// Draw/sheathe place the grip on the scabbard line (poses.SHEATH_HILT / SHEATH_AXIS) at the moment gameplay swaps
// the sword's visibility (draw: u = 0.42, sheathe: u = 0.68), so the swap reads as the blade leaving / entering.
// Events `drawn` / `sheathed` fire at those instants (the animator switches its armed state on them).
import { IDLE, STANCE, BANDIT_STANCE, LH_SHEATH, RH_HANG, K, sw, hand, az, nrm, swSheath } from './poses.js';

const S = STANCE;
/** Relaxed unarmed idle: left hand on the scabbard, right hand hanging. */
export const UNARMED = { ...IDLE, lh: LH_SHEATH, sw: RH_HANG };

// ============================== draw · 拔剑 ==============================
const draw = {
  meta: { duration: 0.9, type: 'draw', cancel: 0.6, look: 0.6, layer: 'upper' },
  keys: [
    K(0, UNARMED, {}),
    // thumb pops the guard, the right hand crosses the belly
    K(0.13, UNARMED, { pel: [2, 10, -2], sp: [2, 4, 1], ch: [0, 4, 1], nk: [2, -6, 0], hd: [-2, -6, 0],
      lh: hand([0.19, 0.97, 0.2], nrm([0.3, -0.5, 0.8]), nrm([-0.9, 0.2, 0.2])),
      sw: hand([0.02, 1.02, 0.27], nrm([0.9, -0.2, 0.3]), nrm([0, -0.6, 0.8])) }),
    // grip the hilt (the sword becomes visible here), torso turned left to bring the shoulder forward
    K(0.28, UNARMED, { hip: [0.0, -0.03, 0.0], pel: [4, 20, 0], sp: [3, 8, 0], ch: [2, 6, 0], nk: [0, -14, 0], hd: [-4, -14, 0],
      lh: hand([0.2, 0.96, 0.16], nrm([0.3, -0.5, 0.8]), nrm([-0.9, 0.2, 0.2])), sw: swSheath(0) }, 'flat'),
    K(0.38, UNARMED, { hip: [0.0, -0.035, 0.0], pel: [4, 22, 0], sp: [3, 9, 0], ch: [2, 7, 0], nk: [0, -16, 0], hd: [-4, -16, 0],
      lh: hand([0.21, 0.96, 0.14], nrm([0.3, -0.5, 0.8]), nrm([-0.9, 0.2, 0.2])), sw: swSheath(0.05) }),
    // the pull: blade slides out along the scabbard, left hand draws the scabbard back
    K(0.5, UNARMED, { hip: [0.0, -0.05, 0.0], pel: [3, 32, 0], sp: [2, 14, 0], ch: [0, 12, 0], nk: [0, -24, 0], hd: [-4, -22, 0],
      lh: hand([0.22, 0.95, 0.02], nrm([0.3, -0.6, 0.7]), nrm([-0.9, 0.2, 0.2])), sw: swSheath(0.46),
      lf: [0.14, 0, -0.02, 20, 0, 0], lk: [0.3, 1] }),
    // clear: the tip whips out and round to the left, the front foot steps into the stance
    K(0.6, S, { hip: [0.01, -0.07, 0.0], pel: [4, 30, 0], sp: [3, 4, 0], ch: [1, 2, 0], nk: [-2, -14, 0], hd: [-4, -14, 0],
      sw: sw([-0.12, 1.4, 0.5], nrm([0.55, 0.1, -0.83]), nrm([0.4, 0.9, 0.1])),
      lh: hand([0.24, 1.08, 0.08], nrm([0.2, 0.3, 0.9]), nrm([-0.9, -0.2, 0.2])),
      lf: [0.16, 0, -0.14, 34, 0, 0], rf: [-0.12, 0.06, 0.14, 0, 0, 0], lk: [1, 0] }),
    K(0.68, S, { hip: [0.02, -0.085, 0.0], pel: [5, 26, 0], sp: [4, -4, 0], ch: [3, -6, 0],
      sw: sw([-0.28, 1.36, 0.42], az(80, 30), az(0, 10)),
      rf: [-0.12, 0, 0.26, 4, 6, 0], lk: [1, 1] }),
    K(0.76, S, { sw: sw([-0.2, 1.18, 0.42], az(8, 20), az(-80, -20)) }),
    K(0.9, S, {}, 'flat'),
  ],
  events: [{ t: 0.378, type: 'drawn' }, { t: 0.56, type: 'whoosh', speed: 0.6 }],
};

// ============================== sheathe · 收剑 (the signature beat) ==============================
const sheathe = {
  meta: { duration: 1.15, type: 'sheathe', cancel: 0.9, look: 0.5, layer: 'upper' },
  keys: [
    K(0, S, {}),
    // 剑花: one slow wheel of the blade outside the wrist, the body rises a little
    K(0.1, S, { hip: [0.02, -0.07, 0.0], sw: sw([-0.24, 1.2, 0.36], nrm([-0.45, -1, 0.15]), nrm([-0.45, 0.05, -1])) }),
    K(0.2, S, { hip: [0.02, -0.06, 0.0], sw: sw([-0.28, 1.26, 0.3], nrm([-0.45, 0.05, -1]), nrm([-0.3, 1, 0.05])) }),
    K(0.3, S, { hip: [0.02, -0.06, 0.0], sw: sw([-0.26, 1.34, 0.34], nrm([-0.3, 1, 0.1]), nrm([0.2, 0.2, 1])) }),
    // bring the blade across: tip to the scabbard mouth, torso turns left, left hand guides the throat
    K(0.46, S, { hip: [0.01, -0.06, 0.0], pel: [4, 30, 0], sp: [2, 14, 0], ch: [0, 12, 0], nk: [2, -18, 0], hd: [2, -18, 0],
      sw: swSheath(0.5),
      lh: hand([0.22, 0.96, 0.1], nrm([0.3, -0.5, 0.8]), nrm([-0.9, 0.2, 0.2])),
      rf: [-0.12, 0, 0.26, 4, 0, 0], lk: [1, 1] }, 'flat'),
    // slide home: fast, then the last centimetres slow — the click
    K(0.66, S, { hip: [0.0, -0.05, 0.0], pel: [4, 26, 0], sp: [2, 12, 0], ch: [0, 10, 0], nk: [4, -14, 0], hd: [6, -14, 0],
      sw: swSheath(0.1), lh: hand([0.21, 0.96, 0.15], nrm([0.3, -0.5, 0.8]), nrm([-0.9, 0.2, 0.2])) }),
    K(0.78, S, { hip: [0.0, -0.04, 0.0], pel: [3, 22, 0], sp: [2, 10, 0], ch: [0, 8, 0], nk: [6, -12, 0], hd: [8, -12, 0],
      sw: swSheath(0), lh: hand([0.2, 0.96, 0.16], nrm([0.3, -0.5, 0.8]), nrm([-0.9, 0.2, 0.2])) }, 'flat'),
    // release: the hand falls away, the stance dissolves into the relaxed idle; head bows a touch
    K(0.92, UNARMED, { hip: [-0.01, -0.03, 0.0], pel: [2, 10, -2], sp: [2, 2, 1], ch: [0, 0, 1], nk: [6, -4, 0], hd: [6, -4, 0],
      sw: hand([-0.12, 0.95, 0.18], nrm([-0.3, -0.9, 0.3]), nrm([0.9, -0.2, 0.3])),
      rf: [-0.1, 0.04, 0.1, -4, 0, 0], lf: [0.14, 0, -0.08, 24, 0, 0], lk: [1, 0] }),
    K(1.15, UNARMED, {}, 'flat'),
  ],
  events: [{ t: 0.12, type: 'whoosh', speed: 0.4 }, { t: 0.782, type: 'sheathed' }],
};

// ============================== taunt · bandit bravado ==============================
const B = BANDIT_STANCE;
const taunt = {
  meta: { duration: 1.7, type: 'taunt', cancel: 0.9 },
  keys: [
    K(0, B, {}),
    // arms spread, chest out, head back — a shout
    K(0.32, B, { hip: [0.0, -0.05, -0.04], pel: [-2, -6, 0], sp: [-6, -2, 0], ch: [-10, -2, 0], nk: [-6, 6, 0], hd: [-12, 6, 0],
      sw: sw([-0.62, 1.52, 0.1], nrm([-0.4, 0.85, 0.3]), nrm([-0.2, -0.3, 0.93])),
      lh: hand([0.62, 1.5, 0.1], nrm([0.5, 0.8, 0.3]), nrm([0.2, -0.3, 0.93])) }, 'flat'),
    K(0.62, B, { hip: [0.0, -0.05, -0.04], pel: [-2, -6, 0], sp: [-6, -2, 0], ch: [-11, -2, 0], nk: [-8, 6, 0], hd: [-14, 4, 3],
      sw: sw([-0.64, 1.56, 0.08], nrm([-0.4, 0.86, 0.3]), nrm([-0.2, -0.3, 0.93])),
      lh: hand([0.64, 1.54, 0.08], nrm([0.5, 0.8, 0.3]), nrm([0.2, -0.3, 0.93])) }),
    // lean in and point the blade at the hero, the off hand beckons
    K(0.9, B, { hip: [0.0, -0.12, 0.06], pel: [12, -18, 0], sp: [8, -6, 0], ch: [6, -8, 0], nk: [-6, 14, 0], hd: [-10, 12, 0],
      sw: sw([-0.2, 1.3, 0.62], az(6, 6), az(90)),
      lh: hand([0.3, 1.2, 0.26], nrm([0.2, 0.6, 0.7]), nrm([0.2, 0.8, -0.5])), lk: [1, 1] }, 'flat'),
    K(1.1, B, { hip: [0.0, -0.12, 0.06], pel: [12, -18, 0], sp: [8, -6, 0], ch: [6, -8, 0], nk: [-4, 14, 0], hd: [-8, 12, 0],
      sw: sw([-0.2, 1.32, 0.64], az(6, 8), az(90)),
      lh: hand([0.3, 1.26, 0.22], nrm([0.2, 0.9, 0.3]), nrm([0.2, 0.3, -0.9])) }),
    K(1.7, B, {}, 'flat'),
  ],
};

// ============================== victory · the hat brim, a breath of stillness ==============================
const victory = {
  meta: { duration: 2.4, type: 'victory', cancel: 2.0, look: 0 },
  keys: [
    K(0, UNARMED, {}),
    K(0.5, UNARMED, { hip: [-0.02, -0.01, 0.0], nk: [4, -2, 0], hd: [6, -2, 0],
      sw: hand([-0.14, 1.66, 0.25], nrm([0.3, 0.3, 0.9]), nrm([0.2, -0.9, 0.3])) }),
    // pull the brim down: the hat hides the eyes
    K(0.85, UNARMED, { hip: [-0.02, -0.012, 0.0], nk: [8, -2, 0], hd: [12, -2, 0],
      sw: hand([-0.13, 1.6, 0.27], nrm([0.3, 0.1, 0.95]), nrm([0.2, -0.95, 0.2])) }, 'flat'),
    K(1.35, UNARMED, { nk: [6, -2, 0], hd: [8, -2, 0], sw: hand([-0.24, 1.0, 0.12], nrm([-0.1, -0.95, 0.25]), nrm([0.95, 0, 0.1])) }),
    K(2.4, UNARMED, {}, 'flat'),
  ],
};

// ============================== turnL / turnR · 90° step-turn in place ==============================
function turn(sign) {
  const Y = 90 * sign;
  const rot = ([x, z], deg) => { const a = deg * Math.PI / 180; return [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)]; };
  const [lx, lz] = rot([0.12, 0.03], Y), [rx, rz] = rot([-0.1, -0.03], Y);
  const pivotL = sign > 0; // turning left pivots on the left foot, the right steps round (and vice versa)
  const I = IDLE;
  return {
    meta: { duration: 0.72, type: 'turn', cancel: 0.5 },
    frame: 'start',
    root: [[0, 0, 0, 0, 'flat'], [0.62, 0, 0, Y, 'flat']],
    keys: [
      K(0, I, {}),
      // eyes and chest lead the turn
      K(0.12, I, { nk: [4, 22 * sign, 0], hd: [-3, 20 * sign, 0], ch: [-2, 10 * sign, 1.8], lk: [1, 1] }, 'flat'),
      K(0.3, I, { pel: [0, 4 + Y * 0.55, -3.5], ch: [-2, 14 * sign, 1.8], nk: [4, 16 * sign, 0], hd: [-3, 12 * sign, 0],
        lf: pivotL ? [0.12, 0, 0.03, 13 + Y * 0.5, 0, 0] : [lx * 0.5 + 0.06, 0.06, lz * 0.5 + 0.02, 13 + Y * 0.6, 0, 0],
        rf: pivotL ? [rx * 0.5 - 0.05, 0.06, rz * 0.5 - 0.02, -6 + Y * 0.6, 0, 0] : [-0.1, 0, -0.03, -6 + Y * 0.5, 0, 0],
        lk: pivotL ? [0, 0] : [0, 0] }),
      K(0.46, I, { pel: [0, 4 + Y, -3.5], ch: [-2, -2 + 4 * sign, 1.8],
        lf: [lx, 0, lz, 13 + Y, 0, 0], rf: [rx, 0, rz, -6 + Y, 0, 0], lk: [1, 1] }),
      K(0.72, I, { pel: [0, 4 + Y, -3.5], lf: [lx, 0, lz, 13 + Y, 0, 0], rf: [rx, 0, rz, -6 + Y, 0, 0], lk: [1, 1] }, 'flat'),
    ],
  };
}

export const MISC_CLIPS = { draw, sheathe, taunt, victory, turnL: turn(1), turnR: turn(-1) };
