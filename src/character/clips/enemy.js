// Bandit attacks (dao / spear): big, readable windups that hold at the top (the telegraph glint lands in the hold),
// one explosive strike with a committed step, and heavy follow-through that leaves them open. Owner: animation (A).
//
// Timing: gameplay telegraphs at hit[0] − 0.38 s, so every windup is fully "loaded" by then and creeps (tension)
// until the strike. `windup` = the committed moment (hyper-armour starts relative to it).
import { BANDIT_STANCE, K, sw, hand, az, nrm } from './poses.js';

const B = BANDIT_STANCE;
const START = { frame: 'start', root: 'hip' };
const ENEMY = { type: 'enemy', combo: null };

// ============================== enemyAttack1 · diagonal overhead slash, high right → low left ==============================
const enemyAttack1 = {
  meta: { ...ENEMY, duration: 1.32, hit: [[0.66, 0.78]], windup: 0.62, cancel: 1.0, damage: 14, posture: 20, reach: 2.0, lunge: 0.8 },
  ...START,
  keys: [
    K(0, B, {}),
    K(0.12, B, { hip: [0.0, -0.11, 0.02], ch: [5, -8, 0] }),
    // the raise: blade high over the right shoulder, body coiled right and leaning back, off hand aims
    K(0.42, B, { hip: [-0.04, -0.1, -0.08], pel: [2, -30, 0], sp: [-2, -10, 0], ch: [-6, -14, 0], nk: [-2, 26, 0], hd: [-8, 24, 0],
      sw: sw([-0.3, 1.76, -0.02], az(-165, -40)),
      lh: hand([0.26, 1.36, 0.46], nrm([0.1, 0.3, 0.95]), nrm([0.1, -0.2, 0.97])),
      lf: [0.16, 0, 0.18, 18, -10, 0], lk: [1, 1] }, 'flat'),
    // tension: the coil tightens a touch (this is where the glint lands)
    K(0.58, B, { hip: [-0.05, -0.11, -0.1], pel: [2, -34, 0], sp: [-3, -12, 0], ch: [-7, -17, 0], nk: [-2, 30, 0], hd: [-8, 28, 0],
      sw: sw([-0.3, 1.78, -0.05], az(-170, -45)),
      lh: hand([0.26, 1.36, 0.48], nrm([0.1, 0.3, 0.95]), nrm([0.1, -0.2, 0.97])),
      lf: [0.16, 0, 0.18, 18, -14, 0], lk: [1, 1] }, 'flat'),
    // the strike: lead foot stamps forward, blade comes over the top
    K(0.66, B, { hip: [-0.02, -0.12, 0.34], pel: [8, -8, 0], sp: [2, -4, 0], ch: [0, -4, 0], nk: [-2, 8, 0], hd: [-8, 8, 0],
      sw: sw([-0.28, 1.76, 0.32], az(-25, 58), az(20, -30)),
      lh: hand([0.34, 1.2, 0.3], nrm([0.4, 0, 0.9]), nrm([0, -1, 0])),
      lf: [0.16, 0.06, 0.6, 18, 10, 0], rf: [-0.18, 0, -0.18, -32, -24, 0], lk: [0, 1] }),
    K(0.72, B, { hip: [0.0, -0.15, 0.6], rf: [-0.18, 0.03, 0.12, -32, -12, 0], pel: [16, 12, 0], sp: [6, 6, 0], ch: [4, 8, 0], nk: [-4, -10, 0], hd: [-8, -10, 0],
      sw: sw([0.0, 1.2, 0.66], az(30, -22), az(110, -50)),
      lh: hand([0.4, 1.12, 0.1], nrm([0.6, -0.2, 0.7]), nrm([0, -1, 0])),
      lf: [0.16, 0, 0.94, 18, 8, 0], lk: [1, 0] }),
    // heavy follow-through: folded over the front knee, blade low left
    K(0.8, B, { hip: [0.02, -0.2, 0.74], pel: [24, 32, 0], sp: [10, 12, 0], ch: [8, 14, 0], nk: [-6, -24, 0], hd: [-10, -22, 0],
      sw: sw([0.34, 0.8, 0.42], az(125, -40)),
      lh: hand([0.46, 1.1, -0.12], nrm([0.6, -0.3, -0.5]), nrm([0, -1, 0])),
      lf: [0.16, 0, 0.94, 18, 0, 0], rf: [-0.18, 0, 0.4, -32, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.0, B, { hip: [0.02, -0.18, 0.76], pel: [20, 30, 0], sp: [8, 10, 0], ch: [6, 12, 0], nk: [-6, -20, 0], hd: [-10, -18, 0],
      sw: sw([0.3, 0.86, 0.44], az(120, -34)),
      lf: [0.16, 0, 0.94, 18, 0, 0], rf: [-0.18, 0.04, 0.5, -32, -10, 0], lk: [1, 0] }),
    K(1.32, B, { hip: [0.0, -0.1, 0.76], lf: [0.16, 0, 0.94, 18, 0, 0], rf: [-0.18, 0, 0.58, -32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.62, type: 'whoosh', speed: 1.1 }],
};

// ============================== enemyAttack2 · backhand horizontal sweep, left → right ==============================
const enemyAttack2 = {
  meta: { ...ENEMY, duration: 1.22, hit: [[0.62, 0.74]], windup: 0.58, cancel: 0.96, damage: 14, posture: 18, reach: 2.1, lunge: 0.7 },
  ...START,
  keys: [
    K(0, B, {}),
    // wind across the body: weapon cocked at the left shoulder, right shoulder turned in, head watches under it
    K(0.38, B, { hip: [0.03, -0.12, -0.04], pel: [6, 22, 0], sp: [4, 14, 0], ch: [2, 18, 0], nk: [-2, -26, 0], hd: [-6, -24, 0],
      sw: sw([0.26, 1.42, 0.16], az(150, 12), az(90, -10)),
      lh: hand([0.14, 1.26, 0.2], nrm([-0.2, 0.2, 1]), nrm([-0.9, 0, 0.2])), lk: [1, 1] }, 'flat'),
    K(0.54, B, { hip: [0.04, -0.125, -0.06], pel: [6, 25, 0], sp: [4, 16, 0], ch: [2, 21, 0], nk: [-2, -30, 0], hd: [-6, -28, 0],
      sw: sw([0.28, 1.44, 0.12], az(155, 14), az(90, -10)),
      lh: hand([0.14, 1.26, 0.18], nrm([-0.2, 0.2, 1]), nrm([-0.9, 0, 0.2])), lk: [1, 1] }, 'flat'),
    // the sweep through the front at chest height, stepping in
    K(0.62, B, { hip: [0.02, -0.13, 0.22], pel: [8, 8, 0], sp: [4, 4, 0], ch: [2, 6, 0], nk: [-2, -12, 0], hd: [-6, -12, 0],
      sw: sw([0.2, 1.28, 0.44], az(80, 0), az(-10, 0)),
      lf: [0.16, 0.05, 0.42, 18, 8, 0], rf: [-0.18, 0, -0.18, -32, -20, 0], lk: [0, 1] }),
    K(0.68, B, { hip: [0.0, -0.14, 0.44], pel: [10, -12, 0], sp: [4, -8, 0], ch: [2, -10, 0], nk: [-2, 14, 0], hd: [-6, 14, 0],
      sw: sw([-0.12, 1.22, 0.62], az(-5, 0), az(-95, 0)),
      lh: hand([0.36, 1.16, -0.02], nrm([0.8, -0.2, -0.4]), nrm([0, -1, 0])),
      lf: [0.16, 0, 0.66, 18, 6, 0], rf: [-0.18, 0.02, 0.02, -34, -10, 0], lk: [1, 0] }),
    K(0.75, B, { hip: [0.0, -0.14, 0.52], pel: [10, -34, 0], sp: [4, -14, 0], ch: [2, -18, 0], nk: [-2, 30, 0], hd: [-6, 28, 0],
      sw: sw([-0.48, 1.26, 0.3], az(-85, 2)),
      lf: [0.16, 0, 0.66, 18, 0, 0], rf: [-0.18, 0, 0.18, -38, 0, 0], lk: [1, 1] }),
    // over-rotated follow-through, weapon out to the right
    K(0.86, B, { hip: [0.0, -0.13, 0.54], pel: [8, -44, 0], sp: [4, -16, 0], ch: [2, -22, 0], nk: [-2, 36, 0], hd: [-6, 34, 0],
      sw: sw([-0.54, 1.3, 0.02], az(-140, 6)),
      lh: hand([0.4, 1.22, 0.1], nrm([0.8, 0, 0.5]), nrm([0, -1, 0])),
      lf: [0.16, 0, 0.66, 18, 0, 0], rf: [-0.18, 0, 0.18, -40, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.22, B, { hip: [0.0, -0.1, 0.52], lf: [0.16, 0, 0.7, 18, 0, 0], rf: [-0.18, 0, 0.34, -32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.6, type: 'whoosh', speed: 1 }],
};

// ============================== enemyHeavy · two-handed overhead cleave into the ground (unblockable) ==============================
const enemyHeavy = {
  meta: { ...ENEMY, duration: 1.85, hit: [[0.94, 1.06]], windup: 0.9, cancel: 1.5, damage: 28, posture: 45, reach: 2.3, lunge: 1.1, unblockable: true },
  ...START,
  keys: [
    K(0, B, {}),
    // the off hand joins the grip
    K(0.24, B, { hip: [0.0, -0.1, -0.02], pel: [6, -8, 0], sp: [4, -2, 0], ch: [2, -2, 0], nk: [-2, 4, 0], hd: [-6, 4, 0],
      sw: sw([-0.12, 1.36, 0.24], nrm([0.05, 0.9, 0.4]), nrm([0, -0.4, 0.9])), tw: 1 }),
    // the great raise: both hands overhead, blade hanging down the back, arched, rising onto the rear leg
    K(0.62, B, { hip: [-0.02, -0.04, -0.12], pel: [-4, -10, 0], sp: [-8, -2, 0], ch: [-12, -2, 0], nk: [-6, 6, 0], hd: [-4, 6, 0],
      sw: sw([-0.08, 1.88, -0.04], az(180, -45)), tw: 1,
      lf: [0.16, 0, 0.18, 18, -18, 0], lk: [1, 1] }, 'flat'),
    K(0.86, B, { hip: [-0.03, -0.03, -0.14], pel: [-5, -10, 0], sp: [-9, -2, 0], ch: [-13, -2, 0], nk: [-6, 6, 0], hd: [-4, 6, 0],
      sw: sw([-0.08, 1.9, -0.06], az(180, -52)), tw: 1,
      lf: [0.16, 0.02, 0.2, 18, -22, 0], lk: [0.4, 1] }, 'flat'),
    // the cleave: step in, over the top
    K(0.94, B, { hip: [-0.02, -0.08, 0.3], pel: [8, -6, 0], sp: [4, -2, 0], ch: [2, -2, 0], nk: [-4, 4, 0], hd: [-8, 4, 0],
      sw: sw([-0.06, 1.8, 0.36], az(-2, 62)), tw: 1,
      lf: [0.16, 0.06, 0.62, 18, 10, 0], rf: [-0.18, 0, -0.18, -32, -26, 0], lk: [0, 1] }),
    K(1.0, B, { hip: [-0.01, -0.18, 0.62], pel: [22, -4, 0], sp: [10, -2, 0], ch: [8, -2, 0], nk: [-8, 2, 0], hd: [-10, 2, 0],
      sw: sw([-0.04, 1.14, 0.68], az(0, -32)), tw: 1,
      lf: [0.16, 0, 0.96, 18, 6, 0], rf: [-0.18, 0.03, 0.14, -32, -12, 0], lk: [1, 0] }),
    // into the ground: folded deep, the blade bites the earth
    K(1.06, B, { hip: [0.0, -0.32, 0.72], pel: [34, -2, 0], sp: [14, -2, 0], ch: [10, -2, 0], nk: [-12, 2, 0], hd: [-14, 2, 0],
      sw: sw([-0.04, 0.66, 0.72], az(0, -72)), tw: 1,
      lf: [0.16, 0, 0.96, 18, 0, 0], rf: [-0.18, 0, 0.36, -32, 0, 0], lk: [1, 1] }, 'flat'),
    // stuck for a beat, then wrench it free
    K(1.34, B, { hip: [0.0, -0.3, 0.72], pel: [30, -4, 0], sp: [12, -2, 0], ch: [8, -2, 0], nk: [-10, 2, 0], hd: [-12, 2, 0],
      sw: sw([-0.05, 0.7, 0.7], az(0, -70)), tw: 1, lf: [0.16, 0, 0.96, 18, 0, 0], rf: [-0.18, 0, 0.36, -32, 0, 0], lk: [1, 1] }),
    K(1.52, B, { hip: [0.0, -0.18, 0.72], pel: [12, -8, 0], sp: [6, -2, 0], ch: [4, -4, 0],
      sw: sw([-0.2, 1.1, 0.5], nrm([0.1, 0.5, 0.86]), nrm([0, -0.86, 0.5])), tw: 0.3,
      lf: [0.16, 0, 0.96, 18, 0, 0], rf: [-0.18, 0.05, 0.5, -32, -10, 0], lk: [1, 0] }),
    K(1.85, B, { hip: [0.0, -0.1, 0.74], lf: [0.16, 0, 0.96, 18, 0, 0], rf: [-0.18, 0, 0.58, -32, 0, 0], lk: [1, 1], tw: 0 }, 'flat'),
  ],
  events: [{ t: 0.9, type: 'whoosh', speed: 1.4, heavy: true }, { t: 1.06, type: 'impact', ground: true }],
};

// ============================== enemyThrust · two-handed lunging thrust (spear / dao point) ==============================
const enemyThrust = {
  meta: { ...ENEMY, thrust: true, duration: 1.26, hit: [[0.64, 0.75]], windup: 0.6, cancel: 1.0, damage: 16, posture: 18, reach: 2.6, lunge: 1.4 },
  ...START,
  keys: [
    K(0, B, {}),
    // draw back to the right hip, point level at the target, crouched and coiled
    K(0.4, B, { hip: [-0.03, -0.17, -0.1], pel: [10, -34, 0], sp: [4, -6, 0], ch: [2, -8, 0], nk: [-4, 30, 0], hd: [-8, 28, 0],
      sw: sw([-0.3, 1.02, -0.16], az(6, 4), az(0, -86)), tw: 1,
      lf: [0.16, 0, 0.18, 18, -8, 0], lk: [1, 1] }, 'flat'),
    K(0.56, B, { hip: [-0.04, -0.18, -0.12], pel: [10, -36, 0], sp: [4, -6, 0], ch: [2, -9, 0], nk: [-4, 32, 0], hd: [-8, 30, 0],
      sw: sw([-0.32, 1.0, -0.2], az(6, 4), az(0, -86)), tw: 1,
      lf: [0.16, 0, 0.18, 18, -10, 0], lk: [1, 1] }, 'flat'),
    // drive: the lead foot shoots forward, the point goes out on a straight line
    K(0.64, B, { hip: [-0.02, -0.17, 0.4], pel: [10, 6, 0], sp: [4, 6, 0], ch: [2, 6, 0], nk: [-4, -8, 0], hd: [-8, -8, 0],
      sw: sw([-0.2, 1.08, 0.42], az(3, 2), az(0, -88)), tw: 1,
      lf: [0.16, 0.06, 0.78, 18, 10, 0], rf: [-0.18, 0, -0.18, -32, -24, 0], lk: [0, 1] }),
    K(0.7, B, { hip: [0.0, -0.22, 0.74], pel: [14, 20, 0], sp: [6, 10, 0], ch: [4, 8, 0], nk: [-6, -18, 0], hd: [-10, -18, 0],
      sw: sw([-0.06, 1.12, 0.7], az(1, 0), az(0, -90)), tw: 1,
      lf: [0.16, 0, 1.14, 18, 0, 0], rf: [-0.18, 0.02, 0.3, -32, -8, 0], lk: [1, 0] }, 'flat'),
    K(0.9, B, { hip: [0.0, -0.21, 0.76], pel: [14, 18, 0], sp: [6, 10, 0], ch: [4, 8, 0], nk: [-6, -16, 0], hd: [-10, -16, 0],
      sw: sw([-0.08, 1.1, 0.66], az(1, -2), az(0, -90)), tw: 1, lf: [0.16, 0, 1.14, 18, 0, 0], rf: [-0.18, 0, 0.36, -32, 0, 0], lk: [1, 1] }),
    // withdraw, rear foot follows
    K(1.06, B, { hip: [0.0, -0.14, 0.8], sw: sw([-0.22, 1.14, 0.3], nrm([0.1, 0.5, 0.86]), nrm([0, -0.86, 0.5])), tw: 0.2,
      lf: [0.16, 0, 1.14, 18, 0, 0], rf: [-0.18, 0.05, 0.7, -32, -10, 0], lk: [1, 0] }),
    K(1.26, B, { hip: [0.0, -0.1, 0.8], lf: [0.16, 0, 1.14, 18, 0, 0], rf: [-0.18, 0, 0.9, -32, 0, 0], lk: [1, 1], tw: 0 }, 'flat'),
  ],
  events: [{ t: 0.6, type: 'whoosh', speed: 1 }],
};

export const ENEMY_CLIPS = { enemyAttack1, enemyAttack2, enemyHeavy, enemyThrust };
