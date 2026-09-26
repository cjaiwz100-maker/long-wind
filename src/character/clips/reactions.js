// Hit reactions, stagger, parried, knockdown → get-up, and the two deaths. Owner: animation (A).
//
// Authored RELATIVE to a stance (poses.R: torso deltas, feet by role — front/back foot), so the same reaction
// drives the hero (right foot forward, jian) and the bandits (left foot forward, dao): `makeReactions(HERO_ST)`
// is the default set, `makeReactions(BANDIT_ST)` is registered as `<name>@bandit` (the animator picks the variant
// matching its style; the meta — timing, cancel — is shared). Lying poses are absolute.
//
// All in the clip-start frame with the root following the pelvis, so recoil steps are real steps (a planted foot
// never slides) and gameplay knockback simply adds to the travel. Reactions snap in fast (the blow lands on frame
// 2–3: the snap is what sells the hit), then take their time coming back — weight, overlap (head and arms lag the
// chest), and a settle. Deaths hold their last frame (meta.type 'death').
import { STANCE, HERO_ST, BANDIT_ST, R, K, sw, hand, nrm } from './poses.js';

const S = STANCE;
const START = { frame: 'start', root: 'hip' };

/** Channels with the pelvis and both feet shifted along z (clip-start frame travel). */
function shifted(ch, dz, dx = 0) {
  const o = { ...ch };
  if (ch.hip) o.hip = [ch.hip[0] + dx, ch.hip[1], ch.hip[2] + dz];
  if (ch.lf) o.lf = [ch.lf[0] + dx, ch.lf[1], ch.lf[2] + dz, ...ch.lf.slice(3)];
  if (ch.rf) o.rf = [ch.rf[0] + dx, ch.rf[1], ch.rf[2] + dz, ...ch.rf.slice(3)];
  return o;
}

// weapon arm flung out by a blow / hanging dazed (right hand for every style)
const SW_FLUNG = sw([-0.56, 1.08, 0.12], nrm([-0.5, -0.25, 0.83]), nrm([-0.4, -0.9, -0.1]));
const SW_HIGH = sw([-0.6, 1.36, 0.02], nrm([-0.6, 0.45, 0.66]));
const SW_BACK = sw([-0.5, 1.6, -0.14], nrm([-0.3, 0.75, -0.6]));
const SW_DROOP = sw([-0.3, 0.9, 0.16], nrm([-0.15, -0.8, 0.58]), nrm([0.05, -0.6, -0.8]));
const LH_FLUNG = hand([0.42, 1.36, 0.08], nrm([0.6, 0.6, 0.4]), nrm([0.3, -0.5, 0.8]));
const LH_UP = hand([0.5, 1.52, 0.06], nrm([0.5, 0.8, 0.2]), nrm([0.3, -0.3, 0.9]));
const LH_OUT = hand([0.46, 1.2, 0.18], nrm([0.8, -0.3, 0.5]), nrm([0, -1, 0.2]));
const LH_LOW = hand([0.3, 0.95, 0.12], nrm([0.2, -0.9, 0.3]), nrm([-0.9, 0, 0.3]));

// ---------------------------------------------------------------------------------------------------------
// Lying poses (rig space, pelvis at the root)
// ---------------------------------------------------------------------------------------------------------
/** Flat on the back, knees half up, sword arm out on the grass, head rolled aside. */
export const LYING_BACK = {
  ...S,
  hip: [0.02, -0.83, 0.0], pel: [-84, 6, 4], sp: [-2, -3, 0], ch: [-3, -4, 2], nk: [16, 4, 0], hd: [8, 26, -6],
  shL: [0, 0, 0], shR: [0, 0, 0],
  lf: [0.24, 0, 0.62, 30, 70, 8], rf: [-0.18, 0, 0.5, -12, 20, 0], lk: [0, 0],
  sw: sw([-0.62, 0.05, -0.24], nrm([-0.5, 0.0, 0.86]), nrm([-0.86, 0.02, -0.5])),
  lh: hand([0.56, 0.05, -0.36], nrm([0.6, 0, 0.8]), nrm([0, 1, 0])), tw: 0,
};
/** Face down, legs long behind, sword arm reaching forward, cheek on the ground. */
export const LYING_FRONT = {
  ...S,
  hip: [0.02, -0.83, 0.0], pel: [85, -4, -3], sp: [2, 2, 0], ch: [0, 3, 0], nk: [-12, 0, 0], hd: [-14, 48, 12],
  lf: [0.2, 0, -0.9, 8, -80, 0], rf: [-0.16, 0, -0.86, -10, -78, 0], lk: [0, 0],
  sw: sw([-0.46, 0.05, 0.7], nrm([-0.3, 0.0, 0.95]), nrm([-0.95, 0.0, -0.3])),
  lh: hand([0.34, 0.05, 0.26], nrm([0.1, 0, 1]), nrm([0, -1, 0])), tw: 0,
};

export function makeReactions(st) {
  // a blow that flings the arms apart breaks the two-handed grip: keys that place the free hand let go of the tsuka
  const r = (t, d = {}, tan) => { const k = R(t, st, d, tan); if (d.lh && d.tw === undefined) k.tw = 0; return k; };

  // ============================== hitFront ==============================
  const hitFront = {
    meta: { duration: 0.55, type: 'react', cancel: 0.34, lunge: -0.27 },
    ...START,
    keys: [
      r(0),
      // the snap: chest driven back, head whips (lags a frame), guard blown open
      r(0.05, { hip: [0, -0.015, -0.07], pel: [-9, 3, -3], sp: [-10, 2, -2], ch: [-13, 3, -3], nk: [4, 8, 0], hd: [-1, 9, -3], sw: SW_FLUNG, lh: LH_FLUNG }, 'flat'),
      r(0.1, { hip: [0, -0.02, -0.12], pel: [-8, 3, -2], sp: [-9, 2, -1], ch: [-11, 2, -2], nk: [6, 12, 0], hd: [-7, 15, -5], sw: SW_FLUNG, lh: LH_FLUNG }),
      // the back foot catches the weight
      r(0.17, { hip: [0, -0.025, -0.2], pel: [-5, 2, -1], sp: [-6, 1, 0], ch: [-8, 1, -1], nk: [4, 10, 0], hd: [-5, 11, -3],
        bf: [0.01, 0.07, -0.2, 0, 8, 0], lk: [1, 0], sw: SW_FLUNG, lh: LH_FLUNG }),
      r(0.25, { hip: [0, -0.025, -0.25], pel: [-2, 1, 0], sp: [-3, 1, 0], ch: [-4, 1, 0], hd: [-2, 7, 0],
        bf: [0.01, 0, -0.32], ff: [0, 0, -0.08, 0, -6, 0], lk: [0, 1] }),
      // the front foot drags back in, guard returns
      r(0.36, { hip: [0, -0.015, -0.27], bf: [0.01, 0, -0.32], ff: [0, 0, -0.24], lk: [1, 1] }),
      r(0.55, { hip: [0, 0, -0.27], bf: [0.01, 0, -0.32], ff: [0, 0, -0.24], lk: [1, 1] }, 'flat'),
    ],
  };

  // ============================== hitBack ==============================
  const hitBack = {
    meta: { duration: 0.55, type: 'react', cancel: 0.34, lunge: 0.3 },
    ...START,
    keys: [
      r(0),
      // struck between the shoulders: hips shoved forward, back arches, head snaps back
      r(0.05, { hip: [0, -0.005, 0.08], pel: [-11, -2, 2], sp: [-12, 0, 0], ch: [-11, 1, 1], nk: [-4, 2, 0], hd: [-5, 0, 2], sw: SW_FLUNG, lh: LH_FLUNG }, 'flat'),
      // pitched forward, the front foot has to step
      r(0.13, { hip: [0, -0.025, 0.18], pel: [5, -2, 1], sp: [4, 0, 0], ch: [3, 1, 0], nk: [8, 2, 0], hd: [7, 0, 0],
        ff: [0, 0.08, 0.2, 0, 10, 0], lk: [0, 1], sw: SW_DROOP, lh: LH_LOW }),
      r(0.22, { hip: [0, -0.035, 0.28], pel: [3, -1, 0], sp: [2, 0, 0], ch: [1, 0, 0], hd: [3, 0, 0],
        ff: [0, 0, 0.36], bf: [0, 0, 0.08, 0, -10, 0], lk: [1, 0] }),
      r(0.34, { hip: [0, -0.015, 0.3], ff: [0, 0, 0.36], bf: [0, 0, 0.32], lk: [1, 1] }),
      r(0.55, { hip: [0, 0, 0.3], ff: [0, 0, 0.36], bf: [0, 0, 0.34], lk: [1, 1] }, 'flat'),
    ],
  };

  // ============================== hitHeavy · blown back two steps ==============================
  const hitHeavy = {
    meta: { duration: 0.95, type: 'react', cancel: 0.7, lunge: -0.68 },
    ...START,
    keys: [
      r(0),
      r(0.06, { hip: [0, -0.005, -0.12], pel: [-13, 4, -4], sp: [-14, 2, -3], ch: [-17, 5, -4], nk: [2, 12, 0], hd: [-3, 13, -4], sw: SW_HIGH, lh: LH_UP }, 'flat'),
      // both feet shoved back, the back foot reaching to catch
      r(0.18, { hip: [0, -0.035, -0.36], pel: [-11, 4, -3], sp: [-11, 2, -2], ch: [-13, 4, -3], nk: [6, 14, 0], hd: [-9, 15, -6],
        bf: [0.02, 0.06, -0.3, 0, 10, 0], ff: [0, 0, -0.12, 0, -8, 0], lk: [0, 0], sw: SW_HIGH, lh: LH_FLUNG }),
      r(0.3, { hip: [0, -0.055, -0.56], pel: [-5, 2, -1], sp: [-6, 1, 0], ch: [-7, 1, -1], hd: [-3, 9, -2],
        bf: [0.02, 0, -0.66], ff: [0, 0.06, -0.32, 0, -20, 0], lk: [0, 1], sw: SW_FLUNG, lh: LH_FLUNG }),
      // second step: the front foot comes back, the body folds over to absorb
      r(0.44, { hip: [0, -0.095, -0.66], pel: [11, 0, 0], sp: [6, 1, 0], ch: [5, 1, 0], nk: [6, 2, 0], hd: [3, 0, 0],
        bf: [0.02, 0, -0.66], ff: [0, 0, -0.6], lk: [1, 1], sw: SW_DROOP, lh: LH_LOW }),
      r(0.62, { hip: [0, -0.055, -0.68], pel: [5, 0, 0], sp: [2, 0, 0], ch: [1, 0, 0], hd: [-1, 0, 0], bf: [0.02, 0, -0.66], ff: [0, 0, -0.6], lk: [1, 1] }),
      r(0.95, { hip: [0, 0, -0.68], bf: [0.02, 0, -0.66], ff: [0, 0, -0.6], lk: [1, 1] }, 'flat'),
    ],
    events: [{ t: 0.3, type: 'plant' }],
  };

  // ============================== stagger · posture broken, dazed ==============================
  const stagger = {
    meta: { duration: 1.5, type: 'react', cancel: 1.15, lunge: -0.42 },
    ...START,
    keys: [
      r(0),
      r(0.06, { hip: [0, -0.015, -0.08], pel: [-11, 6, -3], sp: [-12, 4, -2], ch: [-13, 7, -3], nk: [2, 14, 0], hd: [-3, 17, -4],
        sw: sw([-0.66, 1.18, 0.02], nrm([-0.7, -0.1, 0.7]), nrm([-0.2, -0.97, 0.1])), lh: LH_FLUNG }, 'flat'),
      r(0.2, { hip: [0, -0.035, -0.26], pel: [-7, 4, -2], sp: [-8, 3, -1], ch: [-9, 5, -2], nk: [6, 14, 0], hd: [-5, 15, -6],
        ff: [0, 0.08, -0.24, 0, 6, 0], lk: [0, 1], sw: SW_FLUNG, lh: LH_FLUNG }),
      // sag: guard gone, head hangs, knees soft
      r(0.42, { hip: [-0.02, -0.065, -0.36], pel: [9, -4, 4], sp: [6, 2, 3], ch: [7, 3, 3], nk: [16, 4, 0], hd: [15, -1, 8],
        ff: [0, 0, -0.38, -4, 0, 0], lk: [1, 1], sw: SW_DROOP, lh: LH_LOW }),
      // sway, a shuffle of the back foot to keep balance
      r(0.72, { hip: [0.04, -0.055, -0.4], pel: [7, -6, -5], sp: [5, 4, -3], ch: [6, 5, -4], nk: [14, 7, 0], hd: [13, 9, -8],
        bf: [0.07, 0.05, -0.14, -4, 0, 0], ff: [0, 0, -0.38, -4, 0, 0], lk: [1, 0], sw: SW_DROOP, lh: LH_LOW }),
      r(0.95, { hip: [0.01, -0.055, -0.42], pel: [5, -2, 1], sp: [4, 2, 0], ch: [4, 2, 0], nk: [10, 4, 0], hd: [9, -3, 4],
        bf: [0.05, 0, -0.3, -2, 0, 0], ff: [0, 0, -0.38, -4, 0, 0], lk: [1, 1], sw: SW_DROOP, lh: LH_LOW }),
      // gather: head comes up, the weapon finds the line again
      r(1.2, { hip: [0, -0.025, -0.42], pel: [2, -1, 0], sp: [1, 1, 0], ch: [1, 0, 0], hd: [1, 0, 0], bf: [0.03, 0, -0.32], ff: [0, 0, -0.38], lk: [1, 1] }),
      r(1.5, { hip: [0, 0, -0.42], bf: [0.03, 0, -0.32], ff: [0, 0, -0.36], lk: [1, 1] }, 'flat'),
    ],
  };

  // ============================== parried · the attack is turned, thrown off balance ==============================
  const parried = {
    meta: { duration: 0.85, type: 'react', cancel: 0.6, lunge: -0.46 },
    ...START,
    keys: [
      r(0),
      // the weapon arm is flung up and back, the chest opens, head snaps back
      r(0.07, { hip: [0, 0.005, -0.06], pel: [-7, -6, 3], sp: [-10, -4, 2], ch: [-13, -11, 4], nk: [-2, 10, 0], hd: [-3, 11, 4], sw: SW_BACK, lh: LH_OUT }, 'flat'),
      // stumble: the front foot gives way backward, the body tips further
      r(0.2, { hip: [0, -0.015, -0.3], pel: [-9, -4, 4], sp: [-10, -4, 3], ch: [-11, -11, 4], nk: [0, 10, 0], hd: [-1, 11, 2],
        ff: [0, 0.1, -0.3, 2, 10, 0], lk: [0, 1], sw: SW_BACK, lh: LH_OUT }),
      r(0.34, { hip: [0, -0.035, -0.44], pel: [-3, -2, 2], sp: [-4, -2, 1], ch: [-5, -5, 2], hd: [-1, 7, 0],
        ff: [0, 0, -0.6, 2, 0, 0], lk: [1, 1], sw: sw([-0.44, 1.36, 0.0], nrm([-0.2, 0.55, 0.8])) }),
      // regain the stance: the back foot re-sets behind
      r(0.55, { hip: [0, -0.015, -0.44], ff: [0, 0, -0.6, 2, 0, 0], bf: [0, 0.05, -0.32, 0, 0, 0], lk: [1, 0] }),
      r(0.85, { hip: [0, 0, -0.46], ff: [0, 0, -0.46], bf: [0, 0, -0.46], lk: [1, 1] }, 'flat'),
    ],
    events: [{ t: 0.0, type: 'impact' }],
  };

  // ============================== knockdown · swept off the feet onto the back ==============================
  const KD = -1.1; // travel of the pelvis (m)
  const knockdown = {
    meta: { duration: 1.3, type: 'react', cancel: 1.3, lunge: KD, autoStep: false },
    ...START,
    keys: [
      r(0),
      r(0.05, { hip: [0, -0.015, -0.08], pel: [-15, 2, -3], sp: [-14, 2, -2], ch: [-17, 5, -3], nk: [2, 12, 0], hd: [-3, 13, -4],
        sw: sw([-0.6, 1.4, 0.0], nrm([-0.6, 0.5, 0.6]), nrm([-0.3, -0.8, 0.5])), lh: LH_UP }, 'flat'),
      // feet swept: pelvis tips back, legs fly forward
      r(0.16, { hip: [0, -0.035, -0.3], pel: [-37, -4, -2], sp: [-12, 4, 0], ch: [-11, 5, 0], nk: [12, 10, 0], hd: [5, 11, 0],
        ff: [0, 0.28, 0.09, 0, 30, 0], bf: [0.03, 0.18, 0.2, -10, 30, 0], lk: [0, 0],
        sw: sw([-0.66, 1.28, -0.2], nrm([-0.6, 0.6, 0.5]), nrm([-0.3, -0.8, 0.5])), lh: hand([0.56, 1.36, -0.1], nrm([0.6, 0.6, 0.2]), nrm([0.3, -0.3, 0.9])) }),
      r(0.3, { hip: [0, -0.335, -0.68], pel: [-67, -12, 2], sp: [-8, 4, 0], ch: [-7, 4, 0], nk: [20, 10, 0], hd: [13, 13, 0],
        ff: [0.04, 0.42, -0.26, -10, 40, 0], bf: [0.05, 0.3, 0.14, -10, 50, 0], lk: [0, 0],
        sw: sw([-0.64, 0.8, -0.72], nrm([-0.6, 0.3, 0.74]), nrm([-0.4, -0.9, 0.2])), lh: hand([0.58, 0.8, -0.78], nrm([0.6, 0.3, -0.4]), nrm([0, -1, 0])) }),
      // impact on the back
      K(0.44, S, shifted({ ...LYING_BACK, hip: [0.02, -0.8, 0.0], nk: [22, 2, 0], hd: [12, 8, 0],
        lf: [0.24, 0.1, 0.72, 30, 70, 8], rf: [-0.18, 0.16, 0.66, -12, 50, 0] }, KD + 0.1), 'flat'),
      // slide and bounce, head lolls
      K(0.62, S, shifted({ ...LYING_BACK, nk: [12, 4, 0], hd: [4, 18, -4], lf: [0.24, 0, 0.74, 30, 70, 8], rf: [-0.18, 0, 0.62, -12, 40, 0] }, KD)),
      K(0.95, S, shifted({ ...LYING_BACK }, KD)),
      K(1.3, S, shifted({ ...LYING_BACK, nk: [18, 4, 0], hd: [8, 18, -4] }, KD), 'flat'),
    ],
    events: [{ t: 0.44, type: 'impact', ground: true }],
  };

  // ============================== getUp · sit up, gather the feet, rise into the guard ==============================
  const getUp = {
    meta: { duration: 1.45, type: 'react', cancel: 1.1, autoStep: false },
    keys: [
      K(0, S, { ...LYING_BACK, nk: [18, 4, 0], hd: [8, 18, -4] }),
      // sit up on the left hand, knees come up
      K(0.3, S, { ...LYING_BACK, hip: [0.02, -0.82, 0.0], pel: [-46, 8, 6], sp: [14, -4, 0], ch: [14, -4, 0], nk: [6, 0, 0], hd: [-4, 4, 0],
        lf: [0.22, 0, 0.42, 26, 10, 0], rf: [-0.16, 0, 0.34, -8, 0, 0],
        lh: hand([0.36, 0.06, -0.26], nrm([0.2, 0, -1]), nrm([0, 1, 0])), sw: sw([-0.52, 0.12, 0.1], nrm([-0.3, 0.05, 0.95]), nrm([-0.95, 0.02, -0.3])) }),
      // roll forward over the feet: crouch, the left hand pushes off the ground in front
      r(0.62, { hip: [0, -0.415, -0.02], pel: [37, -8, 0], sp: [10, 2, 0], ch: [7, 1, 0], nk: [-6, 2, 0], hd: [-11, 1, 0],
        ff: [0.02, 0, 0, -4, 0, 0], bf: [0.03, 0, 0.14, -6, 0, 0], lk: [1, 1],
        lh: hand([0.3, 0.06, 0.34], nrm([0.2, 0, 1]), nrm([0, -1, 0])), sw: sw([-0.34, 0.5, 0.36], nrm([-0.2, -0.3, 0.93]), nrm([0.1, -0.9, -0.3])) }),
      // rise, the weapon comes up with the eyes
      r(0.95, { hip: [0, -0.175, -0.02], pel: [17, -4, 0], sp: [6, 0, 0], ch: [3, 0, 0], nk: [-2, 1, 0], hd: [-3, 0, 0],
        bf: [0.03, 0, 0.06, -4, 0, 0], lk: [1, 1], sw: sw([-0.2, 0.95, 0.38], nrm([0.05, 0.1, 0.99]), nrm([0.1, -0.99, 0.1])) }),
      r(1.2, { hip: [0, -0.015, 0], bf: [0.01, 0, 0.02], lk: [1, 1] }),
      r(1.45, {}, 'flat'),
    ],
  };

  // ============================== death · (struck from behind) buckles and falls forward ==============================
  const death = {
    meta: { duration: 2.0, type: 'death', autoStep: false, lunge: 0.38 },
    ...START,
    keys: [
      r(0),
      // arch: the blow from behind throws the chest forward, head back
      r(0.07, { hip: [0, 0.005, 0.08], pel: [-13, -2, 2], sp: [-14, 0, 0], ch: [-13, 1, 1], nk: [-6, 2, 0], hd: [-7, 0, 2], sw: SW_FLUNG, lh: LH_FLUNG }, 'flat'),
      // the strength goes: knees buckle, head drops, arms hang
      r(0.32, { hip: [0, -0.215, 0.14], pel: [7, -4, 3], sp: [6, 2, 2], ch: [7, 3, 2], nk: [18, 4, 0], hd: [19, -1, 4],
        bf: [0, 0, 0, 0, -20, 0], lk: [1, 1], sw: SW_DROOP, lh: LH_LOW }),
      // on the knees
      K(0.62, S, { hip: [0.02, -0.5, 0.1], pel: [6, 14, 4], sp: [12, -4, 2], ch: [12, -3, 2], nk: [20, 0, 0], hd: [16, -6, 6],
        lf: [0.17, 0, -0.52, 30, -72, 0], rf: [-0.13, 0, -0.34, 0, -70, 0], lk: [1, 1],
        sw: sw([-0.4, 0.5, 0.26], nrm([-0.2, -0.85, 0.5]), nrm([0.1, -0.5, -0.86])), lh: hand([0.3, 0.62, 0.2], nrm([0.1, -1, 0.1]), nrm([-1, 0, 0])) }),
      K(0.8, S, { hip: [0.02, -0.52, 0.12], pel: [16, 12, 4], sp: [14, -4, 2], ch: [14, -3, 2], nk: [22, 0, 0], hd: [18, -6, 6],
        lf: [0.17, 0, -0.52, 30, -72, 0], rf: [-0.13, 0, -0.34, 0, -70, 0], lk: [1, 1],
        sw: sw([-0.42, 0.4, 0.34], nrm([-0.2, -0.85, 0.5]), nrm([0.1, -0.5, -0.86])), lh: hand([0.3, 0.5, 0.3], nrm([0.1, -1, 0.1]), nrm([-1, 0, 0])) }),
      // topple forward
      K(1.08, S, { hip: [0.02, -0.66, 0.26], pel: [55, 6, -2], sp: [8, 0, 0], ch: [6, 2, 0], nk: [-4, 0, 0], hd: [-8, 20, 6],
        lf: [0.18, 0, -0.66, 20, -78, 0], rf: [-0.15, 0, -0.56, -6, -76, 0], lk: [0, 0],
        sw: sw([-0.46, 0.2, 0.64], nrm([-0.3, -0.2, 0.93]), nrm([-0.9, -0.1, -0.3])), lh: hand([0.34, 0.22, 0.52], nrm([0.1, -0.3, 1]), nrm([0, -1, 0])) }),
      K(1.26, S, shifted({ ...LYING_FRONT, hip: [0.02, -0.8, 0.0], hd: [-8, 40, 8] }, 0.36), 'flat'),
      K(1.46, S, shifted({ ...LYING_FRONT, hip: [0.02, -0.835, 0.0] }, 0.38)),
      K(2.0, S, shifted({ ...LYING_FRONT }, 0.38), 'flat'),
    ],
    events: [{ t: 0.62, type: 'impact', ground: true, knee: true }, { t: 1.26, type: 'impact', ground: true }],
  };

  // ============================== deathBack · (struck from the front) staggers back and falls ==============================
  const DB = -0.72;
  const deathBack = {
    meta: { duration: 1.9, type: 'death', autoStep: false, lunge: DB },
    ...START,
    keys: [
      r(0),
      r(0.06, { hip: [0, -0.005, -0.08], pel: [-11, 4, -3], sp: [-12, 2, -2], ch: [-15, 5, -3], nk: [2, 12, 0], hd: [-1, 13, -4], sw: SW_FLUNG, lh: LH_FLUNG }, 'flat'),
      // one stumbling step back, the weapon arm goes slack
      r(0.24, { hip: [0, -0.035, -0.26], pel: [-9, 2, -2], sp: [-8, 2, -1], ch: [-9, 4, -2], nk: [8, 12, 0], hd: [1, 15, -6],
        ff: [0, 0.08, -0.26, 0, 10, 0], lk: [0, 1], sw: SW_DROOP, lh: LH_LOW }),
      r(0.42, { hip: [0, -0.095, -0.36], pel: [-17, 0, 0], sp: [-8, 2, 0], ch: [-7, 4, 0], nk: [10, 10, 0], hd: [5, 13, -4],
        ff: [0, 0, -0.46, 0, 0, 0], lk: [1, 1], sw: SW_DROOP, lh: LH_LOW }),
      // knees fold, falling back
      K(0.66, S, { hip: [0.02, -0.46, -0.52], pel: [-40, 16, 2], sp: [-6, -4, 0], ch: [-6, -3, 0], nk: [18, 6, 0], hd: [8, 12, 0],
        lf: [0.18, 0.02, -0.12, 36, 20, 0], rf: [-0.13, 0.04, -0.06, 0, 20, 0], lk: [0, 0],
        sw: sw([-0.62, 0.6, -0.6], nrm([-0.7, 0.1, 0.7]), nrm([-0.3, -0.9, 0.1])), lh: hand([0.6, 0.62, -0.62], nrm([0.6, 0.2, -0.3]), nrm([0, -1, 0])) }),
      // impact on the back, a small rebound
      K(0.86, S, shifted({ ...LYING_BACK, hip: [0.02, -0.8, 0.0], nk: [24, 2, 0], hd: [12, 6, 0], lf: [0.24, 0.12, 0.58, 30, 60, 8], rf: [-0.18, 0.18, 0.5, -12, 40, 0] }, DB + 0.08), 'flat'),
      K(1.04, S, shifted({ ...LYING_BACK, nk: [10, 4, 0], hd: [4, 20, -4], lf: [0.24, 0, 0.66, 30, 70, 8], rf: [-0.18, 0, 0.58, -12, 30, 0] }, DB)),
      // the knees fall aside, head rolls away: stillness
      K(1.4, S, shifted({ ...LYING_BACK, lf: [0.3, 0, 0.72, 40, 75, 20], rf: [-0.24, 0, 0.7, -30, 60, -10], hd: [8, 34, -8] }, DB)),
      K(1.9, S, shifted({ ...LYING_BACK, lf: [0.32, 0, 0.74, 44, 78, 22], rf: [-0.26, 0, 0.74, -34, 66, -12], hd: [8, 36, -8] }, DB), 'flat'),
    ],
    events: [{ t: 0.86, type: 'impact', ground: true }],
  };

  // ============================== hurtKneel · a heavy blow drops him to one knee; a breath; he pushes back up ==============================
  const hurtKneel = {
    meta: { duration: 1.55, type: 'react', cancel: 1.1, lunge: -0.42 },
    ...START,
    keys: [
      r(0),
      r(0.06, { hip: [0, -0.005, -0.12], pel: [-13, 4, -4], sp: [-14, 2, -3], ch: [-17, 5, -4], nk: [2, 12, 0], hd: [-3, 13, -4], sw: SW_HIGH, lh: LH_UP }, 'flat'),
      // shoved back a step, the legs give
      r(0.2, { hip: [0, -0.08, -0.3], pel: [-4, 4, -2], sp: [-6, 2, -1], ch: [-8, 3, -2], nk: [6, 10, 0], hd: [-4, 12, -4],
        bf: [0.02, 0.05, -0.34, 0, 10, 0], lk: [0, 0], sw: SW_FLUNG, lh: LH_FLUNG }),
      // down on the back knee, the free hand slaps the ground, the blade kept up across the body
      r(0.38, { hip: [0, -0.44, -0.36], pel: [30, -6, 0], sp: [12, 2, 0], ch: [10, 1, 0], nk: [-4, 2, 0], hd: [-10, 2, 0],
        ff: [0.02, 0, -0.1, -4, 0, 0], bf: [0.03, 0, -0.62, -6, 0, 0], lk: [1, 1],
        lh: hand([0.3, 0.07, -0.02], nrm([0.2, 0, 1]), nrm([0, -1, 0])), sw: sw([-0.4, 0.42, -0.02], nrm([-0.2, 0.2, 0.96])) }, 'flat'),
      // a breath: head hangs, shoulders heave once
      r(0.62, { hip: [0, -0.46, -0.36], pel: [34, -6, 0], sp: [14, 2, 0], ch: [12, 1, 0], nk: [4, 2, 0], hd: [6, 0, 0],
        ff: [0.02, 0, -0.1, -4, 0, 0], bf: [0.03, 0, -0.62, -6, 0, 0], lk: [1, 1],
        lh: hand([0.3, 0.07, -0.02], nrm([0.2, 0, 1]), nrm([0, -1, 0])), sw: sw([-0.4, 0.4, -0.02], nrm([-0.2, 0.15, 0.97])) }),
      r(0.82, { hip: [0, -0.44, -0.36], pel: [28, -6, 0], sp: [10, 2, 0], ch: [8, 1, 0], nk: [-6, 2, 0], hd: [-10, 0, 0],
        ff: [0.02, 0, -0.1, -4, 0, 0], bf: [0.03, 0, -0.62, -6, 0, 0], lk: [1, 1],
        lh: hand([0.3, 0.1, -0.0], nrm([0.2, 0, 1]), nrm([0, -1, 0])), sw: sw([-0.36, 0.5, 0.0], nrm([-0.1, 0.3, 0.95])) }),
      // push up off the hand, the eyes and the blade come back to the enemy
      r(1.1, { hip: [0, -0.17, -0.38], pel: [14, -4, 0], sp: [6, 0, 0], ch: [3, 0, 0], nk: [-2, 1, 0], hd: [-3, 0, 0],
        ff: [0.02, 0, -0.14, -4, 0, 0], bf: [0.03, 0, -0.52, -4, 0, 0], lk: [1, 1], sw: sw([-0.2, 0.95, 0.0], nrm([0.05, 0.1, 0.99])) }),
      r(1.55, { hip: [0, 0, -0.4], ff: [0, 0, -0.18], bf: [0.02, 0, -0.5], lk: [1, 1] }, 'flat'),
    ],
    events: [{ t: 0.38, type: 'plant' }],
  };

  // thrown by a finishing blow: the same fall, the body already going over (models play their collapse from mid-fall)
  const deathLaunch = { ...deathBack, meta: { ...deathBack.meta, lunge: 0 } };
  return { hitFront, hitBack, hitHeavy, stagger, parried, knockdown, getUp, death, deathBack, deathLaunch, hurtKneel };
}

export const REACTION_CLIPS = makeReactions(HERO_ST);
/** Bandit variants (same names + '@bandit', same meta). */
export const REACTION_CLIPS_BANDIT = Object.fromEntries(Object.entries(makeReactions(BANDIT_ST)).map(([k, v]) => [`${k}@bandit`, v]));
