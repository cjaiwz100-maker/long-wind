// Defensive moves: 轻功 gliding sidesteps, back-hop, forward dash, block (jian held diagonally), block impact,
// parry (crisp deflection with a wrist turn) and being parried. Owner: animation (A).
//
// Dodges are authored in the clip-start frame (`frame: 'start'`, root = pelvis travel): feet keep their numbers
// while planted and the root motion is exactly the body's travel, so gameplay can warp the distance (meta.lunge is
// the authored travel; gameplay scales it to its dodge length). Hands ride in chest space so the guard stays with
// the torso through leans. i-frames cover the fast part of the move; cancel opens once the weight is caught.
import { STANCE, K, R, HERO_ST, BANDIT_ST, sw, hand, nrm, chestSpace, SW_DRAG, LH_READY, L_TUCK, L_OPEN_BACK } from './poses.js';

const S = STANCE;
const C = (spec, torso = S) => chestSpace(spec, torso);

// chest-space hand vocabulary for dodges
const G_TUCK = C(sw([-0.14, 1.12, 0.28], [0.06, 0.45, 0.89], [0.2, -0.88, 0.42]));   // guard pulled in
const G_TRAIL = C(sw([-0.34, 1.02, -0.06], [-0.35, -0.2, -0.92], [0.1, -0.95, 0.3]));  // blade trailing (dash)
const L_READY = C(LH_READY);                                                        // the free hand hangs (ready stance)
const L_JZ = L_TUCK;                                                                 // gathered in during the move (收)
const L_OUT = C(hand([0.62, 1.3, 0.02], [0.9, 0.35, 0.1], [0, -0.3, 1]));             // left arm out for balance
const L_BACK = L_OPEN_BACK;                                                          // free arm flung open behind
const R_OUT = C(sw([-0.6, 1.24, 0.1], [0.1, 0.62, 0.78], [-0.3, -0.75, 0.55]));        // sword arm out (right glide)

const DODGE = { type: 'dodge', damage: 0, posture: 0, reach: 0, autoStep: true };

// ============================== dodgeL · gliding sidestep to the left (+X) ==============================
const dodgeL = {
  meta: { ...DODGE, duration: 0.58, iframes: [0.03, 0.3], cancel: 0.36, lunge: 2.6 },
  frame: 'start', root: 'hip', space: { L: 'chest', R: 'chest' },
  keys: [
    K(0, S, { sw: C(SW_DRAG), lh: L_READY }),
    // load: weight drops onto the right leg, pelvis tips toward the push
    K(0.06, S, { hip: [-0.03, -0.125, 0.0], pel: [6, 24, 5], sp: [4, -8, 2], ch: [3, -7, -2], hd: [-5, -3, -3],
      sw: G_TUCK, lh: L_JZ, lk: [1, 1] }, 'flat'),
    // push-off: right leg drives (heel up), left foot reaches wide and low, torso leans into the travel
    K(0.13, S, { hip: [0.42, -0.14, 0.0], pel: [4, 20, -7], sp: [4, -6, -4], ch: [2, -5, -3], nk: [-2, -3, 3], hd: [-5, -3, 7],
      lf: [0.72, 0.07, -0.16, 32, 12, 0], rf: [-0.12, 0, 0.26, 4, -30, 0], lk: [0, 1], sw: G_TUCK, lh: L_OUT }),
    // glide: the left foot skims down, the right trails off the ground; the body skates, calm and level
    K(0.2, S, { hip: [1.15, -0.15, 0.0], pel: [3, 22, -3], sp: [4, -7, -1], ch: [2, -6, -1], nk: [-2, -3, 1], hd: [-5, -3, 3],
      lf: [1.32, 0.0, -0.16, 30, 0, 0], rf: [0.66, 0.06, 0.22, 0, -18, 0], lk: [0, 0], sw: G_TUCK, lh: L_OUT }),
    K(0.3, S, { hip: [2.0, -0.145, 0.0], pel: [4, 23, 0], sp: [4, -8, 0], ch: [3, -7, 0], hd: [-5, -3, 0],
      lf: [2.2, 0.0, -0.18, 36, 0, 0], rf: [1.76, 0.02, 0.24, 2, -6, 0], lk: [0, 0], sw: G_TUCK, lh: L_OUT }),
    // catch: both feet bite, the body's momentum carries the pelvis a little past and the torso tips back
    K(0.38, S, { hip: [2.52, -0.125, 0.0], pel: [5, 24, 4], sp: [4, -8, 2], ch: [3, -7, 2], hd: [-5, -3, -2],
      lf: [2.72, 0, -0.2, 40, 0, 0], rf: [2.4, 0, 0.26, 4, 0, 0], lk: [1, 1], sw: G_TUCK, lh: L_JZ }),
    K(0.46, S, { hip: [2.63, -0.1, 0.0], pel: [5, 24, 1], lf: [2.72, 0, -0.2, 40, 0, 0], rf: [2.4, 0, 0.26, 4, 0, 0], lk: [1, 1], sw: C(SW_DRAG), lh: L_READY }),
    K(0.58, S, { hip: [2.6, -0.085, 0.0], lf: [2.75, 0, -0.2, 40, 0, 0], rf: [2.46, 0, 0.26, 4, 0, 0], lk: [1, 1], sw: C(SW_DRAG), lh: L_READY }, 'flat'),
  ],
  events: [{ t: 0.1, type: 'whoosh', speed: 0.5 }],
};

// ============================== dodgeR · gliding sidestep to the right (−X) ==============================
const dodgeR = {
  meta: { ...DODGE, duration: 0.58, iframes: [0.03, 0.3], cancel: 0.36, lunge: -2.6 },
  frame: 'start', root: 'hip', space: { L: 'chest', R: 'chest' },
  keys: [
    K(0, S, { sw: C(SW_DRAG), lh: L_READY }),
    K(0.06, S, { hip: [0.06, -0.125, 0.0], pel: [6, 24, -5], sp: [4, -8, -2], ch: [3, -7, 2], hd: [-5, -3, 3],
      sw: G_TUCK, lh: L_JZ, lk: [1, 1] }, 'flat'),
    // push off the (rear) left leg, the lead right foot opens and reaches right
    K(0.13, S, { hip: [-0.4, -0.14, 0.0], pel: [4, 26, 7], sp: [4, -8, 4], ch: [2, -7, 3], nk: [-2, -3, -3], hd: [-5, -3, -7],
      rf: [-0.7, 0.07, 0.2, -18, 12, 0], lf: [0.17, 0, -0.2, 40, -30, 0], lk: [1, 0], sw: R_OUT, lh: L_JZ }),
    K(0.2, S, { hip: [-1.12, -0.15, 0.0], pel: [3, 25, 3], sp: [4, -8, 1], ch: [2, -7, 1], nk: [-2, -3, -1], hd: [-5, -3, -3],
      rf: [-1.3, 0.0, 0.22, -10, 0, 0], lf: [-0.64, 0.06, -0.16, 36, -18, 0], lk: [0, 0], sw: R_OUT, lh: L_BACK }),
    K(0.3, S, { hip: [-1.98, -0.145, 0.0], pel: [4, 24, 0], sp: [4, -8, 0], ch: [3, -7, 0], hd: [-5, -3, 0],
      rf: [-2.12, 0.0, 0.25, 0, 0, 0], lf: [-1.7, 0.02, -0.2, 40, -6, 0], lk: [0, 0], sw: R_OUT, lh: L_BACK }),
    K(0.38, S, { hip: [-2.5, -0.125, 0.0], pel: [5, 24, -4], sp: [4, -8, -2], ch: [3, -7, -2], hd: [-5, -3, 2],
      rf: [-2.62, 0, 0.26, 4, 0, 0], lf: [-2.33, 0, -0.2, 40, 0, 0], lk: [1, 1], sw: G_TUCK, lh: L_JZ }),
    K(0.46, S, { hip: [-2.6, -0.1, 0.0], pel: [5, 24, -1], rf: [-2.62, 0, 0.26, 4, 0, 0], lf: [-2.33, 0, -0.2, 40, 0, 0], lk: [1, 1], sw: C(SW_DRAG), lh: L_READY }),
    K(0.58, S, { hip: [-2.58, -0.085, 0.0], rf: [-2.72, 0, 0.26, 4, 0, 0], lf: [-2.43, 0, -0.2, 40, 0, 0], lk: [1, 1], sw: C(SW_DRAG), lh: L_READY }, 'flat'),
  ],
  events: [{ t: 0.1, type: 'whoosh', speed: 0.5 }],
};

// ============================== dodgeB · back-hop ==============================
const dodgeB = {
  meta: { ...DODGE, duration: 0.6, iframes: [0.03, 0.3], cancel: 0.38, lunge: -2.3 },
  frame: 'start', root: 'hip', space: { L: 'chest', R: 'chest' },
  keys: [
    K(0, S, { sw: C(SW_DRAG), lh: L_READY }),
    // dip and a hint of forward weight: the spring loads
    K(0.06, S, { hip: [0.02, -0.15, 0.04], pel: [10, 24, 0], sp: [6, -8, 0], ch: [4, -7, 0], hd: [-9, -3, 0],
      sw: G_TUCK, lh: L_JZ, lk: [1, 1] }, 'flat'),
    // take-off: both feet push through the balls, the pelvis flies back and up
    K(0.13, S, { hip: [0.02, -0.06, -0.3], pel: [4, 22, 0], sp: [2, -8, 0], ch: [0, -7, 0], hd: [-2, -3, 0],
      lf: [0.17, 0.02, -0.3, 40, -34, 0], rf: [-0.12, 0.03, 0.08, 4, -38, 0], lk: [0, 0], sw: G_TUCK, lh: L_OUT }),
    // airborne: knees tucked, torso stays forward (eyes on the enemy), robe and arms trail forward
    K(0.22, S, { hip: [0.02, 0.0, -1.25], pel: [9, 22, 0], sp: [6, -8, 0], ch: [4, -7, 0], hd: [-8, -3, 0],
      lf: [0.17, 0.16, -1.42, 38, -10, 0], rf: [-0.12, 0.2, -1.02, 4, -14, 0], lk: [0, 0], sw: G_TUCK, lh: L_OUT }),
    // the rear (left) foot reaches for the ground first
    K(0.3, S, { hip: [0.02, -0.06, -1.95], pel: [8, 23, 0], sp: [5, -8, 0], ch: [3, -7, 0], hd: [-7, -3, 0],
      lf: [0.17, 0.0, -2.2, 40, -16, 0], rf: [-0.12, 0.1, -1.74, 4, 6, 0], lk: [0, 0], sw: G_TUCK, lh: L_OUT }),
    // land and absorb: deep knees, weight forward over the front foot
    K(0.37, S, { hip: [0.02, -0.17, -2.26], pel: [12, 24, 0], sp: [6, -8, 0], ch: [4, -7, 0], hd: [-10, -3, 0],
      lf: [0.17, 0, -2.5, 40, 0, 0], rf: [-0.12, 0, -2.04, 4, 0, 0], lk: [1, 1], sw: G_TUCK, lh: L_JZ }),
    K(0.47, S, { hip: [0.02, -0.11, -2.3], pel: [6, 24, 0], lf: [0.17, 0, -2.5, 40, 0, 0], rf: [-0.12, 0, -2.04, 4, 0, 0], lk: [1, 1], sw: C(SW_DRAG), lh: L_READY }),
    K(0.6, S, { hip: [0.02, -0.085, -2.3], lf: [0.17, 0, -2.5, 40, 0, 0], rf: [-0.12, 0, -2.04, 4, 0, 0], lk: [1, 1], sw: C(SW_DRAG), lh: L_READY }, 'flat'),
  ],
  events: [{ t: 0.1, type: 'whoosh', speed: 0.45 }, { t: 0.33, type: 'land' }],
};

// ============================== dodgeF · 轻功 forward dash, low and skimming ==============================
const dodgeF = {
  meta: { ...DODGE, duration: 0.62, iframes: [0.04, 0.32], cancel: 0.4, lunge: 3.2 },
  frame: 'start', root: 'hip', space: { L: 'chest', R: 'chest' },
  keys: [
    K(0, S, { sw: C(SW_DRAG), lh: L_READY }),
    K(0.06, S, { hip: [0.02, -0.13, -0.04], pel: [8, 24, 0], sp: [5, -8, 0], ch: [3, -7, 0], hd: [-6, -3, 0],
      sw: G_TUCK, lh: L_JZ, lk: [1, 1] }, 'flat'),
    // launch off the rear leg, the chest drops forward, blade swept back and low (streamlined)
    K(0.13, S, { hip: [0.0, -0.16, 0.42], pel: [22, 12, 0], sp: [10, -4, 0], ch: [6, -4, 0], nk: [-10, -2, 0], hd: [-14, -2, 0],
      rf: [-0.1, 0.08, 0.74, 0, 10, 0], lf: [0.17, 0, -0.2, 40, -34, 0], lk: [1, 0], sw: G_TRAIL, lh: L_BACK }),
    // skimming: long flat glide, feet barely clear the grass
    K(0.22, S, { hip: [0.0, -0.17, 1.35], pel: [24, 10, 0], sp: [10, -4, 0], ch: [6, -4, 0], nk: [-12, -2, 0], hd: [-16, -2, 0],
      rf: [-0.1, 0.0, 1.58, 0, 0, 0], lf: [0.12, 0.08, 0.86, 20, -20, 0], lk: [0, 0], sw: G_TRAIL, lh: L_BACK }),
    K(0.32, S, { hip: [0.0, -0.16, 2.38], pel: [20, 14, 0], sp: [9, -5, 0], ch: [5, -5, 0], nk: [-10, -2, 0], hd: [-14, -2, 0],
      rf: [-0.1, 0.0, 2.64, 2, 0, 0], lf: [0.15, 0.03, 2.02, 34, -8, 0], lk: [0, 0], sw: G_TRAIL, lh: L_BACK }),
    // brake: the front foot plants, the torso rises back over the hips, guard returns
    K(0.41, S, { hip: [0.02, -0.12, 2.92], pel: [4, 24, 0], sp: [2, -8, 0], ch: [1, -7, 0], hd: [-3, -3, 0],
      rf: [-0.12, 0, 3.16, 4, 0, 0], lf: [0.17, 0, 2.7, 40, 0, 0], lk: [1, 1], sw: G_TUCK, lh: L_JZ }),
    K(0.5, S, { hip: [0.02, -0.1, 2.98], rf: [-0.12, 0, 3.16, 4, 0, 0], lf: [0.17, 0, 2.7, 40, 0, 0], lk: [1, 1], sw: C(SW_DRAG), lh: L_READY }),
    K(0.62, S, { hip: [0.02, -0.085, 2.96], rf: [-0.12, 0, 3.22, 4, 0, 0], lf: [0.17, 0, 2.76, 40, 0, 0], lk: [1, 1], sw: C(SW_DRAG), lh: L_READY }, 'flat'),
  ],
  events: [{ t: 0.11, type: 'whoosh', speed: 0.6 }],
};

// ============================== block · blade held diagonally, off hand bracing the flat ==============================
// Low, square, compact; loops with a slow breath so a long guard is never frozen. Stance-relative (poses.R), so the
// bandits get the same guard from their own stance (`block@bandit`, `blockHit@bandit`).
const BLOCK_SW = sw([-0.2, 1.16, 0.32], nrm([0.74, 0.6, 0.3]), nrm([-0.1, -0.25, 0.96]));
const BLOCK_LH = hand([0.1, 1.33, 0.4], nrm([0.3, 0.9, 0.2]), nrm([-0.15, -0.1, -1]));
const BLOCK_D = { hip: [-0.02, -0.03, -0.02], pel: [1, -8, 0], sp: [1, 4, 0], ch: [1, 1, 0], nk: [4, 1, 0], hd: [-1, 1, 0],
  bf: [0.02, 0, 0.02, -6, 0, 0], ff: [0.01, 0, -0.02, -2, 0, 0], lk: [1, 1], sw: BLOCK_SW, lh: BLOCK_LH };
const add = (a, b) => a.map((v, i) => v + (b[i] ?? 0));
/** BLOCK deltas plus extra deltas (hands absolute). */
const bd = (x = {}) => {
  const o = { ...BLOCK_D };
  for (const [k, v] of Object.entries(x)) o[k] = Array.isArray(v) && Array.isArray(BLOCK_D[k]) && k !== 'lk' ? add(BLOCK_D[k], v) : v;
  return o;
};
function makeBlockClips(st) {
  const block = {
    meta: { duration: 1.6, loop: true, type: 'block', damage: 0, posture: 0, reach: 0, cancel: 0, layer: 'upper' },
    keys: [
      R(0, st, bd()),
      R(0.8, st, bd({ hip: [0, -0.008, -0.005], ch: [1, 0, 0], hd: [1, 0, 0],
        sw: sw([-0.2, 1.155, 0.325], nrm([0.73, 0.61, 0.3]), nrm([-0.1, -0.25, 0.96])) })),
      R(1.6, st, bd()),
    ],
  };
  // the blow lands on the guard: blade driven back toward the shoulder, torso rocks back, a skid back
  const blockHit = {
    meta: { duration: 0.4, type: 'block', damage: 0, posture: 0, reach: 0, cancel: 0.22, lunge: -0.16 },
    frame: 'start', root: 'hip',
    keys: [
      R(0, st, bd()),
      R(0.05, st, bd({ hip: [0, -0.015, -0.08], pel: [-6, 0, 2], sp: [-7, 0, 0], ch: [-9, -2, 2], nk: [2, 0, 0], hd: [-4, -1, 3],
        sw: sw([-0.24, 1.22, 0.2], nrm([0.7, 0.66, 0.26]), nrm([-0.1, -0.25, 0.96])), lh: hand([0.05, 1.37, 0.28], nrm([0.3, 0.9, 0.2]), nrm([-0.15, -0.1, -1])),
        ff: [0, 0, 0, 0, 8, 0] }), 'flat'),
      R(0.14, st, bd({ hip: [0, -0.015, -0.15], pel: [-3, 0, 1], sp: [-3, 0, 0], ch: [-3, -1, 1], hd: [-1, 0, 1],
        bf: [0, 0, -0.12], ff: [0, 0, -0.1], lk: [0.2, 1] })),
      R(0.26, st, bd({ hip: [0, -0.003, -0.15], bf: [0, 0, -0.14], ff: [0, 0, -0.16] })),
      R(0.4, st, bd({ hip: [0, 0, -0.14], bf: [0, 0, -0.14], ff: [0, 0, -0.16] }), 'flat'),
    ],
    events: [{ t: 0.0, type: 'impact' }],
  };
  return { block, blockHit };
}
const { block, blockHit } = makeBlockClips(HERO_ST);
const BLOCK = { ...R(0, HERO_ST, BLOCK_D) }; delete BLOCK.t;

// ============================== parry · crisp deflection with a wrist turn ==============================
// From the guard the jian meets the incoming blade near the hilt, the wrist rolls over and flicks the attack out
// past the right shoulder (the tip draws a tight circle), then snaps back on line — pointed at the opponent's
// throat for the riposte.
const parry = {
  meta: { duration: 0.46, type: 'parry', damage: 0, posture: 0, reach: 0, active: [0, 0.18], perfect: 0.12, cancel: 0.12, lunge: 0.12 },
  frame: 'start', root: 'hip',
  keys: [
    K(0, BLOCK, {}),
    // meet: blade across, edge out, weight settles forward into it
    K(0.04, BLOCK, { hip: [0.0, -0.12, 0.02], pel: [6, 20, 0], ch: [4, -2, 0],
      sw: sw([-0.12, 1.22, 0.4], nrm([0.8, 0.55, 0.22]), nrm([-0.15, -0.2, 0.97])) }, 'flat'),
    // wrist turn: the blade pivots around the grip, sweeping the attack out to the right (tip circles over)
    K(0.08, BLOCK, { hip: [0.0, -0.118, 0.06], pel: [6, 8, 0], sp: [5, -8, 0], ch: [3, -12, 0], hd: [-6, 4, 0],
      sw: sw([-0.2, 1.3, 0.42], nrm([0.05, 0.95, 0.3]), nrm([-0.95, 0.05, 0.3])),
      lh: hand([0.14, 1.28, 0.3], nrm([0.2, 0.9, 0.4]), nrm([-0.8, -0.1, -0.5])) }),
    K(0.12, BLOCK, { hip: [0.0, -0.112, 0.1], pel: [6, 6, 0], sp: [5, -10, 0], ch: [3, -14, 0], hd: [-6, 8, 0],
      sw: sw([-0.36, 1.3, 0.36], nrm([-0.75, 0.55, 0.3]), nrm([-0.4, -0.75, 0.5])),
      lh: LH_READY, rf: [-0.13, 0, 0.3, 2, 0, 0], lk: [1, 0.3] }),
    // recover on line: point at the throat, 剑指 at the chest (riposte-ready)
    K(0.22, S, { hip: [0.02, -0.095, 0.12], pel: [5, 20, 0], sp: [4, -7, 0], ch: [3, -7, 0],
      sw: sw([-0.2, 0.98, 0.34], nrm([-0.1, -0.2, 0.97]), nrm([0.05, -0.97, -0.2])),   // point low on line, then settles to the ready
      lf: [0.19, 0, -0.18, 36, 0, 0], rf: [-0.12, 0, 0.36, 4, 0, 0], lk: [1, 1] }),
    K(0.46, S, { hip: [0.02, -0.085, 0.12], lf: [0.19, 0, -0.1, 38, 0, 0], rf: [-0.12, 0, 0.36, 4, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.0, type: 'impact' }, { t: 0.08, type: 'whoosh', speed: 0.6 }],
};

export const DEFENSE_CLIPS = { dodgeL, dodgeR, dodgeB, dodgeF, block, blockHit, parry };
const BB = makeBlockClips(BANDIT_ST);
/** Bandit variants (same names + '@bandit', same meta). */
export const DEFENSE_CLIPS_BANDIT = { 'block@bandit': BB.block, 'blockHit@bandit': BB.blockHit };
export { BLOCK };
