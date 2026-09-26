// New ranks and the boss's arsenal (owner: animation A):
//   spearman  spearSweep (low wide sweep) · spearJab2 (double jab)
//   archer    bowShot (raise · nock · draw · release; `shootAt` spawns the arrow) · enemyKick (push-off kick)
//   shieldman shieldGuard (upper-body loop: shield up while walking) · shieldBash
//   boss      bossLeap (leaping cleave, unblockable) · bossFlurry (three cuts) · bossDash (居合 dash-cut) ·
//             bossQi (剑气: overhead release, `shootAt` spawns the wave)
//   player    execute (处决: step in, run the blade through, pull free) · enemy executed (take it, fall)
// Same conventions as enemy.js: readable windups that hold at the top, the glint lands at hit[0] − 0.38 s.
import { BANDIT_STANCE, STANCE, K, sw, hand, az, nrm, lhC, L_OPEN_BACK, L_HIGH_BACK, L_REACH } from './poses.js';

const B = BANDIT_STANCE;
const START = { frame: 'start', root: 'hip' };
const ENEMY = { type: 'enemy', combo: null };

// ============================== spearSweep · low horizontal sweep, right → left, both hands ==============================
const spearSweep = {
  meta: { ...ENEMY, duration: 1.4, hit: [[0.7, 0.84]], windup: 0.64, cancel: 1.1, damage: 16, posture: 24, reach: 3.1, lunge: 0.7, arc: 1.3 },
  ...START,
  keys: [
    K(0, B, {}),
    // wind the shaft out to the right, point low and wide (a spear can't be wound behind the back two-handed), body coiled right and sinking
    K(0.44, B, { hip: [-0.04, -0.2, -0.06], pel: [12, -40, 0], sp: [6, -14, 0], ch: [4, -18, 0], nk: [-4, 34, 0], hd: [-8, 32, 0],
      sw: sw([-0.3, 1.0, 0.0], az(-78, 6), az(12, 0)), tw: 1,
      lf: [0.18, 0, 0.22, 20, -8, 0], lk: [1, 1] }, 'flat'),
    K(0.62, B, { hip: [-0.05, -0.22, -0.08], pel: [12, -44, 0], sp: [6, -16, 0], ch: [4, -20, 0], nk: [-4, 38, 0], hd: [-8, 36, 0],
      sw: sw([-0.32, 0.98, -0.02], az(-86, 6), az(4, 0)), tw: 1,
      lf: [0.18, 0, 0.22, 20, -10, 0], lk: [1, 1] }, 'flat'),
    // the sweep: a big step, the hips unwind and the point scythes through the front at knee height 
    K(0.67, B, { hip: [-0.04, -0.24, 0.1], pel: [14, -26, 0], sp: [7, -9, 0], ch: [5, -11, 0], nk: [-5, 22, 0], hd: [-9, 20, 0],
      sw: sw([-0.24, 0.95, 0.16], az(-64, 8), az(26, 0)), tw: 1,
      lf: [0.19, 0.03, 0.4, 20, 0, 0], lk: [0, 1] }),
    K(0.72, B, { hip: [-0.02, -0.26, 0.3], pel: [16, -6, 0], sp: [8, -2, 0], ch: [6, -2, 0], nk: [-6, 6, 0], hd: [-10, 6, 0],
      sw: sw([-0.12, 0.92, 0.36], az(-40, 6), az(40, 0)), tw: 1,
      lf: [0.2, 0.05, 0.62, 20, 8, 0], rf: [-0.18, 0, -0.18, -32, -20, 0], lk: [0, 1] }),
    K(0.8, B, { hip: [0.0, -0.3, 0.52], pel: [18, 26, 0], sp: [8, 10, 0], ch: [6, 12, 0], nk: [-6, -16, 0], hd: [-10, -16, 0],
      sw: sw([0.14, 0.9, 0.42], az(50, 4), az(140, 0)), tw: 1,
      lf: [0.2, 0, 0.9, 20, 0, 0], rf: [-0.18, 0.02, 0.06, -32, -8, 0], lk: [1, 0] }),
    // carried round to the left, off balance
    K(0.92, B, { hip: [0.02, -0.28, 0.56], pel: [16, 46, 0], sp: [8, 16, 0], ch: [6, 20, 0], nk: [-6, -30, 0], hd: [-10, -28, 0],
      sw: sw([0.32, 0.96, 0.18], az(120, 4), az(-150, 0)), tw: 1,
      lf: [0.2, 0, 0.9, 20, 0, 0], rf: [-0.18, 0, 0.2, -36, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.4, B, { hip: [0.0, -0.1, 0.56], lf: [0.16, 0, 0.9, 18, 0, 0], rf: [-0.18, 0, 0.36, -32, 0, 0], lk: [1, 1], tw: 0.4 }, 'flat'),
  ],
  events: [{ t: 0.68, type: 'whoosh', speed: 1.2 }],
};

// ============================== spearJab2 · two fast jabs (the second one reaches further) ==============================
const JAB_BACK = { pel: [10, -34, 0], sp: [4, -6, 0], ch: [2, -8, 0], nk: [-4, 30, 0], hd: [-8, 28, 0], tw: 1 };
const JAB_OUT = { pel: [12, 14, 0], sp: [5, 8, 0], ch: [3, 6, 0], nk: [-5, -14, 0], hd: [-9, -14, 0], tw: 1 };
const spearJab2 = {
  meta: { ...ENEMY, thrust: true, duration: 1.3, hit: [[0.46, 0.54], [0.8, 0.9]], windup: 0.42, cancel: 1.05, damage: 11, posture: 13, reach: 3.0, lunge: 1.3 },
  ...START,
  keys: [
    K(0, B, {}),
    K(0.3, B, { hip: [-0.03, -0.17, -0.08], ...JAB_BACK, sw: sw([-0.3, 1.04, -0.14], az(6, 4), az(0, -86)), lf: [0.16, 0, 0.18, 18, -8, 0], lk: [1, 1] }, 'flat'),
    K(0.42, B, { hip: [-0.04, -0.18, -0.1], ...JAB_BACK, sw: sw([-0.32, 1.02, -0.18], az(6, 4), az(0, -86)), lf: [0.16, 0, 0.18, 18, -10, 0], lk: [1, 1] }, 'flat'),
    // jab 1: arms shoot, a half step
    K(0.5, B, { hip: [-0.02, -0.18, 0.18], ...JAB_OUT, sw: sw([-0.12, 1.1, 0.56], az(2, 2), az(0, -88)), lf: [0.16, 0.04, 0.46, 18, 6, 0], lk: [0, 1] }),
    // snap back (point stays aimed)
    K(0.64, B, { hip: [-0.03, -0.18, 0.22], ...JAB_BACK, sw: sw([-0.3, 1.04, 0.0], az(5, 3), az(0, -86)), lf: [0.16, 0, 0.5, 18, 0, 0], lk: [1, 1] }),
    K(0.74, B, { hip: [-0.04, -0.19, 0.2], ...JAB_BACK, sw: sw([-0.32, 1.02, -0.04], az(5, 3), az(0, -86)), lf: [0.16, 0, 0.5, 18, 0, 0], lk: [1, 1] }, 'flat'),
    // jab 2: the long one, the lead foot drives
    K(0.84, B, { hip: [0.0, -0.22, 0.66], ...JAB_OUT, pel: [14, 20, 0], sw: sw([-0.04, 1.12, 0.74], az(1, 0), az(0, -90)),
      lf: [0.16, 0, 1.1, 18, 0, 0], rf: [-0.18, 0.02, 0.24, -32, -8, 0], lk: [1, 0] }),
    K(1.0, B, { hip: [0.0, -0.2, 0.68], ...JAB_OUT, pel: [14, 20, 0], sw: sw([-0.06, 1.1, 0.7], az(1, -2), az(0, -90)), lf: [0.16, 0, 1.1, 18, 0, 0], rf: [-0.18, 0, 0.3, -32, 0, 0], lk: [1, 1] }),
    K(1.3, B, { hip: [0.0, -0.1, 0.72], lf: [0.16, 0, 1.1, 18, 0, 0], rf: [-0.18, 0, 0.7, -32, 0, 0], lk: [1, 1], tw: 0.4 }, 'flat'),
  ],
  events: [{ t: 0.44, type: 'whoosh', speed: 0.9 }, { t: 0.78, type: 'whoosh', speed: 1.1 }],
};

// ============================== bowShot · raise, nock, draw, release (the arrow leaves at shootAt) ==============================
// Side-on: the torso turns right so the left shoulder leads, the head looks down the arrow at the target (+Z).
// The bow fist (left) is thumb-up at shoulder height; the right hand pinches the string (fist around a vertical line).
const AIM = { hip: [0.02, -0.12, -0.02], pel: [4, -48, 0], sp: [2, -14, 0], ch: [0, -16, -2], nk: [-2, 36, 0], hd: [-4, 38, 0],
  lf: [0.2, 0, 0.18, 30, 0, 0], rf: [-0.14, 0, -0.18, -40, 0, 0] };
const BOW_ARM = hand([0.1, 1.44, 0.66], nrm([0.05, 0.02, 1]), nrm([-1, 0, 0.05]));
const bowShot = {
  meta: { ...ENEMY, duration: 1.7, hit: [], ranged: true, shootAt: 1.12, windup: 0.8, cancel: 1.3, damage: 12, posture: 14, reach: 20, lunge: 0 },
  ...START,
  keys: [
    K(0, B, {}),
    // turn side-on, the bow comes up, the right hand takes an arrow at the hip
    K(0.3, B, { ...AIM, lh: hand([0.14, 1.3, 0.46], nrm([0.1, 0.3, 0.95]), nrm([-1, 0, 0.1])),
      sw: sw([-0.2, 0.98, 0.0], nrm([0, -0.2, 1]), nrm([0, 1, 0])), lk: [1, 1] }),
    // nock: the right hand brings the arrow to the string at the bow
    K(0.52, B, { ...AIM, lh: BOW_ARM, sw: sw([0.06, 1.3, 0.44], nrm([0, 1, 0]), nrm([0, 0, 1])), lk: [1, 1] }),
    // draw to the jaw (tension builds: the glint lands in the full draw) — on the model the old 1.52 m sat above the head
    K(0.9, B, { ...AIM, lh: BOW_ARM, sw: sw([-0.02, 1.33, 0.06], nrm([0, 1, 0]), nrm([0, 0, 1])), ch: [0, -18, -3], lk: [1, 1] }, 'flat'),
    K(1.1, B, { ...AIM, lh: BOW_ARM, sw: sw([-0.03, 1.33, 0.02], nrm([0, 1, 0]), nrm([0, 0, 1])), ch: [0, -19, -3], lk: [1, 1] }, 'flat'),
    // release: the drawing hand flies back past the ear, the bow arm kicks a little
    K(1.16, B, { ...AIM, lh: hand([0.1, 1.45, 0.68], nrm([0.1, 0.05, 1]), nrm([-1, 0, 0.1])),
      sw: sw([-0.1, 1.36, -0.16], nrm([0, 0.8, -0.6]), nrm([0, 0.6, 0.8])), lk: [1, 1] }),
    K(1.4, B, { ...AIM, lh: BOW_ARM, sw: sw([-0.12, 1.3, -0.14], nrm([0, 0.8, -0.6]), nrm([0, 0.6, 0.8])), lk: [1, 1] }, 'flat'),
    K(1.7, B, {}, 'flat'),
  ],
  events: [{ t: 1.12, type: 'shoot' }],
};

// ============================== enemyKick · a push-off front kick (archer / shieldman at close range) ==============================
const enemyKick = {
  meta: { ...ENEMY, duration: 1.0, hit: [[0.4, 0.5]], windup: 0.34, cancel: 0.8, damage: 8, posture: 32, reach: 1.7, lunge: 0.5, knock: 5 },
  ...START,
  keys: [
    K(0, B, {}),
    // chamber: weight onto the left leg, the right knee comes up, hands up
    K(0.3, B, { hip: [0.04, -0.07, -0.08], pel: [-12, 6, 0], sp: [-6, 0, 0], ch: [-6, 0, 0],
      rf: [-0.14, 0.62, 0.2, -10, 30, 0], lk: [1, 0] }, 'flat'),
    // extend: the sole drives out at chest height, the body leaning back against it
    K(0.42, B, { hip: [0.03, -0.03, -0.02], pel: [-24, 8, 0], sp: [-10, 2, 0], ch: [-8, 2, 0],
      rf: [-0.12, 0.98, 0.78, -6, 80, 0], lk: [1, 0] }),
    K(0.5, B, { hip: [0.03, -0.04, 0.0], pel: [-22, 8, 0], sp: [-9, 2, 0], ch: [-7, 2, 0], rf: [-0.12, 0.94, 0.76, -6, 76, 0], lk: [1, 0] }),
    // retract and put it down in front
    K(0.7, B, { hip: [0.0, -0.1, 0.14], rf: [-0.16, 0.2, 0.3, -20, 10, 0], lk: [1, 0] }),
    K(1.0, B, { hip: [0.0, -0.1, 0.2], rf: [-0.18, 0, 0.36, -32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.38, type: 'whoosh', speed: 0.8 }],
};

// ============================== shieldGuard (upper-body loop) · shieldBash ==============================
// Shield on the left forearm: the forearm across the front of the chest, the back of the arm (and the shield face)
// toward the enemy — knuckles point to the right, the palm faces the body.
const GUARD_LH = hand([-0.02, 1.28, 0.42], nrm([-1, 0.1, 0.1]), nrm([0, 0, -1]));
const shieldGuard = {
  meta: { type: 'block', duration: 1.6, loop: true, cancel: 0, layer: 'upper' },
  keys: [0, 0.8, 1.6].map((t, i) => K(t, B, {
    ch: [6 + (i === 1 ? 1 : 0), -8, 0], sp: [6, -4, 0],
    lh: i === 1 ? hand([-0.02, 1.27, 0.43], nrm([-1, 0.1, 0.1]), nrm([0, 0, -1])) : GUARD_LH,
    sw: sw([-0.3, 1.12, 0.06], az(10, 40), [0.1, -0.52, 0.85]),
  })),
};
const shieldBash = {
  meta: { ...ENEMY, duration: 1.1, hit: [[0.46, 0.58]], windup: 0.4, cancel: 0.9, damage: 10, posture: 36, reach: 1.9, lunge: 1.3, knock: 6 },
  ...START,
  keys: [
    K(0, B, { lh: GUARD_LH }),
    // load: sink behind the shield, shoulder turned in
    K(0.38, B, { hip: [0.02, -0.2, -0.08], pel: [14, 24, 0], sp: [6, 10, 0], ch: [6, 14, 0], nk: [-4, -18, 0], hd: [-6, -16, 0],
      lh: hand([0.06, 1.2, 0.3], nrm([-1, 0.1, 0.1]), nrm([0, 0, -1])), sw: sw([-0.3, 1.1, -0.1], az(-160, 30)), lk: [1, 1] }, 'flat'),
    // drive: a lunging step, the shield punches forward
    K(0.5, B, { hip: [0.0, -0.18, 0.5], pel: [18, 4, 0], sp: [8, 2, 0], ch: [8, 2, 0], nk: [-6, 0, 0], hd: [-8, 0, 0],
      lh: hand([-0.02, 1.26, 0.78], nrm([-1, 0.1, 0.1]), nrm([0, 0, -1])), sw: sw([-0.3, 1.1, -0.06], az(-160, 30)),
      lf: [0.18, 0, 0.9, 20, 0, 0], rf: [-0.18, 0.02, 0.1, -32, -10, 0], lk: [1, 0] }),
    K(0.62, B, { hip: [0.0, -0.18, 0.56], pel: [16, 6, 0], lh: hand([-0.02, 1.26, 0.74], nrm([-1, 0.1, 0.1]), nrm([0, 0, -1])),
      lf: [0.18, 0, 0.9, 20, 0, 0], rf: [-0.18, 0, 0.2, -32, 0, 0], lk: [1, 1] }),
    K(1.1, B, { hip: [0.0, -0.1, 0.56], lh: GUARD_LH, lf: [0.16, 0, 0.9, 18, 0, 0], rf: [-0.18, 0, 0.4, -32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.44, type: 'whoosh', speed: 0.7, heavy: true }],
};

// ============================== boss: bossLeap · bossFlurry · bossDash · bossQi ==============================
// bossLeap: from 5–8 m, a crouch, a high leap with the blade over the head in both hands, the cleave lands with him.
const bossLeap = {
  meta: { ...ENEMY, duration: 1.7, hit: [[0.9, 1.02]], windup: 0.86, cancel: 1.4, damage: 30, posture: 50, reach: 2.6, lunge: 5.2, unblockable: true },
  ...START,
  keys: [
    K(0, B, {}),
    K(0.3, B, { hip: [0.0, -0.26, -0.04], pel: [18, 0, 0], sp: [8, 0, 0], ch: [6, 0, 0], nk: [-6, 0, 0], hd: [-10, 0, 0],
      sw: sw([-0.2, 0.9, 0.2], az(-150, -30)), tw: 1, lk: [1, 1] }, 'flat'),
    // take-off
    K(0.46, B, { hip: [0.0, 0.1, 0.6], pel: [-4, 0, 0], sp: [-6, 0, 0], ch: [-8, 0, 0], nk: [0, 0, 0], hd: [0, 0, 0],
      sw: sw([-0.08, 1.9, -0.02], az(180, -40)), tw: 1,
      lf: [0.16, 0.2, 0.4, 18, -30, 0], rf: [-0.18, 0.26, 0.2, -32, -30, 0], lk: [0, 0] }),
    // apex: high, knees tucked, the blade hangs down the back
    K(0.7, B, { hip: [0.0, 0.46, 1.6], pel: [-8, 0, 0], sp: [-8, 0, 0], ch: [-12, 0, 0], nk: [-2, 0, 0], hd: [0, 0, 0],
      sw: sw([-0.08, 2.0, -0.08], az(180, -55)), tw: 1,
      lf: [0.16, 0.62, 1.8, 18, 20, 0], rf: [-0.18, 0.64, 1.5, -32, 20, 0], lk: [0, 0] }),
    // the fall: over the top
    K(0.86, B, { hip: [0.0, 0.2, 2.6], pel: [10, 0, 0], sp: [6, 0, 0], ch: [4, 0, 0], nk: [-6, 0, 0], hd: [-8, 0, 0],
      sw: sw([-0.06, 1.9, 0.4], az(0, 60)), tw: 1,
      lf: [0.16, 0.26, 2.9, 18, 0, 0], rf: [-0.18, 0.3, 2.5, -32, 0, 0], lk: [0, 0] }),
    // land and cleave into the ground
    K(0.96, B, { hip: [0.0, -0.3, 3.0], pel: [30, 0, 0], sp: [14, 0, 0], ch: [10, 0, 0], nk: [-12, 0, 0], hd: [-14, 0, 0],
      sw: sw([-0.04, 0.7, 0.72], az(0, -70)), tw: 1,
      lf: [0.16, 0, 3.4, 18, 0, 0], rf: [-0.18, 0, 2.7, -32, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.3, B, { hip: [0.0, -0.28, 3.0], pel: [28, 0, 0], sp: [12, 0, 0], ch: [8, 0, 0], sw: sw([-0.05, 0.72, 0.7], az(0, -68)), tw: 1,
      lf: [0.16, 0, 3.4, 18, 0, 0], rf: [-0.18, 0, 2.7, -32, 0, 0], lk: [1, 1] }),
    K(1.7, B, { hip: [0.0, -0.1, 3.05], lf: [0.16, 0, 3.4, 18, 0, 0], rf: [-0.18, 0, 2.9, -32, 0, 0], lk: [1, 1], tw: 0 }, 'flat'),
  ],
  events: [{ t: 0.42, type: 'jump' }, { t: 0.84, type: 'whoosh', speed: 1.5, heavy: true }, { t: 0.96, type: 'impact', ground: true }],
};

// bossFlurry: three quick cuts — diagonal down right→left, backhand left→right, and a rising cut
const bossFlurry = {
  meta: { ...ENEMY, duration: 1.5, hit: [[0.44, 0.52], [0.7, 0.78], [0.98, 1.08]], windup: 0.4, cancel: 1.2, damage: 12, posture: 14, reach: 2.3, lunge: 1.6 },
  ...START,
  keys: [
    K(0, B, {}),
    K(0.34, B, { hip: [-0.02, -0.12, -0.04], pel: [4, -26, 0], sp: [-2, -10, 0], ch: [-4, -12, 0], nk: [-2, 24, 0], hd: [-6, 22, 0],
      sw: sw([-0.3, 1.74, -0.02], az(-160, -30)), lk: [1, 1] }, 'flat'),
    // cut 1
    K(0.46, B, { hip: [0.0, -0.16, 0.4], pel: [14, 20, 0], sp: [6, 8, 0], ch: [4, 10, 0], nk: [-4, -12, 0], hd: [-8, -12, 0],
      sw: sw([0.0, 1.2, 0.64], az(25, -24), az(110, -50)), lf: [0.16, 0.04, 0.6, 18, 6, 0], lk: [0, 1] }),
    K(0.54, B, { hip: [0.0, -0.18, 0.5], pel: [18, 34, 0], sp: [8, 12, 0], ch: [6, 14, 0], nk: [-4, -22, 0], hd: [-8, -20, 0],
      sw: sw([0.34, 0.86, 0.42], az(120, -36)), lf: [0.16, 0, 0.7, 18, 0, 0], lk: [1, 1] }),
    // cut 2: the wrist turns over, backhand level through the front
    K(0.72, B, { hip: [0.0, -0.18, 0.62], pel: [12, -10, 0], sp: [4, -4, 0], ch: [2, -6, 0], nk: [-2, 10, 0], hd: [-6, 10, 0],
      sw: sw([-0.1, 1.22, 0.64], az(-10, 0), az(-95, 0)), rf: [-0.18, 0.02, 0.2, -32, -10, 0], lk: [1, 0] }),
    K(0.8, B, { hip: [0.0, -0.18, 0.66], pel: [10, -36, 0], sp: [4, -14, 0], ch: [2, -18, 0], nk: [-2, 28, 0], hd: [-6, 26, 0],
      sw: sw([-0.5, 1.26, 0.26], az(-95, 2)), rf: [-0.18, 0, 0.3, -36, 0, 0], lk: [1, 1] }),
    // cut 3: low → high rising cut on a new step
    K(0.94, B, { hip: [0.0, -0.24, 0.8], pel: [18, -20, 0], sp: [8, -8, 0], ch: [6, -8, 0],
      sw: sw([-0.3, 0.72, 0.4], az(-30, -40), az(-10, 50)), lf: [0.16, 0.04, 1.1, 18, 6, 0], lk: [0, 1] }),
    K(1.04, B, { hip: [0.0, -0.1, 0.96], pel: [-2, 10, 0], sp: [-6, 4, 0], ch: [-8, 4, 0], nk: [0, -6, 0], hd: [-2, -6, 0],
      sw: sw([0.1, 1.8, 0.3], az(20, 60), az(0, -30)), lf: [0.16, 0, 1.24, 18, 0, 0], lk: [1, 1] }),
    K(1.5, B, { hip: [0.0, -0.1, 0.96], lf: [0.16, 0, 1.24, 18, 0, 0], rf: [-0.18, 0, 0.7, -32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.42, type: 'whoosh', speed: 1.2 }, { t: 0.68, type: 'whoosh', speed: 1.2 }, { t: 0.96, type: 'whoosh', speed: 1.3 }],
};

// bossDash: 居合 — crouched, the blade drawn back low at the left hip, then a flash forward with a flat cut
const bossDash = {
  meta: { ...ENEMY, duration: 1.3, hit: [[0.6, 0.72]], windup: 0.56, cancel: 1.05, damage: 22, posture: 30, reach: 2.4, lunge: 6.0 },
  ...START,
  keys: [
    K(0, B, {}),
    K(0.44, B, { hip: [0.0, -0.3, -0.06], pel: [22, 30, 0], sp: [10, 14, 0], ch: [8, 16, 0], nk: [-8, -26, 0], hd: [-10, -24, 0],
      sw: sw([0.22, 0.96, -0.06], az(-165, -8), az(-90, 0)), lh: hand([0.26, 1.0, 0.1], nrm([0, 0, 1]), nrm([-1, 0, 0])),
      lf: [0.2, 0, 0.3, 20, 0, 0], rf: [-0.2, 0, -0.3, -30, 0, 0], lk: [1, 1] }, 'flat'),
    K(0.56, B, { hip: [0.0, -0.32, -0.08], pel: [24, 32, 0], sp: [10, 15, 0], ch: [8, 17, 0], nk: [-8, -28, 0], hd: [-10, -26, 0],
      sw: sw([0.22, 0.95, -0.08], az(-168, -8), az(-90, 0)), lh: hand([0.26, 1.0, 0.1], nrm([0, 0, 1]), nrm([-1, 0, 0])),
      lf: [0.2, 0, 0.3, 20, 0, 0], rf: [-0.2, 0, -0.3, -30, 0, 0], lk: [1, 1] }, 'flat'),
    // the flash: a long low dash, the cut sweeps flat left → right across the front
    K(0.64, B, { hip: [0.0, -0.28, 1.6], pel: [20, 0, 0], sp: [8, 0, 0], ch: [6, 0, 0], nk: [-8, 0, 0], hd: [-10, 0, 0],
      sw: sw([0.0, 1.14, 0.64], az(-10, 0), az(-95, 0)), lh: lhC(L_OPEN_BACK),
      lf: [0.2, 0.06, 1.4, 20, 0, 0], rf: [-0.2, 0.06, 1.9, -30, 0, 0], lk: [0, 0] }),
    K(0.74, B, { hip: [0.0, -0.3, 2.4], pel: [20, -30, 0], sp: [8, -12, 0], ch: [6, -16, 0], nk: [-8, 24, 0], hd: [-10, 22, 0],
      sw: sw([-0.56, 1.12, 0.2], az(-110, 2)), lh: lhC(L_OPEN_BACK),
      lf: [0.2, 0, 2.2, 20, 0, 0], rf: [-0.2, 0, 2.9, -30, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.0, B, { hip: [0.0, -0.28, 2.4], pel: [18, -30, 0], sp: [8, -12, 0], ch: [6, -16, 0], sw: sw([-0.58, 1.1, 0.16], az(-115, 0)),
      lh: lhC(L_OPEN_BACK), lf: [0.2, 0, 2.2, 20, 0, 0], rf: [-0.2, 0, 2.9, -30, 0, 0], lk: [1, 1] }),
    K(1.3, B, { hip: [0.0, -0.1, 2.5], lf: [0.16, 0, 2.3, 18, 0, 0], rf: [-0.18, 0, 2.8, -32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.6, type: 'whoosh', speed: 1.6, heavy: true }],
};

// bossQi: the blade goes up over the head, then down on the diagonal — the wave leaves at shootAt
const bossQi = {
  meta: { ...ENEMY, duration: 1.6, hit: [], ranged: true, shootAt: 0.92, windup: 0.82, cancel: 1.3, damage: 24, posture: 40, reach: 16, lunge: 0.4 },
  ...START,
  keys: [
    K(0, B, {}),
    K(0.5, B, { hip: [-0.02, -0.08, -0.08], pel: [-2, -18, 0], sp: [-6, -8, 0], ch: [-10, -10, 0], nk: [-4, 16, 0], hd: [-6, 14, 0],
      sw: sw([-0.2, 1.95, -0.04], az(-170, -30)), tw: 1, lk: [1, 1] }, 'flat'),
    K(0.84, B, { hip: [-0.03, -0.08, -0.1], pel: [-3, -20, 0], sp: [-7, -9, 0], ch: [-12, -12, 0], nk: [-4, 18, 0], hd: [-6, 16, 0],
      sw: sw([-0.2, 1.98, -0.08], az(-172, -38)), tw: 1, lk: [1, 1] }, 'flat'),
    K(0.92, B, { hip: [0.0, -0.2, 0.36], pel: [18, 20, 0], sp: [8, 8, 0], ch: [6, 10, 0], nk: [-6, -12, 0], hd: [-10, -12, 0],
      sw: sw([0.0, 1.16, 0.7], az(20, -24), az(110, -50)), tw: 0.4, lh: lhC(L_OPEN_BACK),
      lf: [0.16, 0, 0.7, 18, 0, 0], rf: [-0.18, 0.02, 0.0, -32, -10, 0], lk: [1, 0] }),
    K(1.04, B, { hip: [0.0, -0.28, 0.44], pel: [24, 34, 0], sp: [10, 12, 0], ch: [8, 16, 0], nk: [-8, -22, 0], hd: [-10, -20, 0],
      sw: sw([0.36, 0.8, 0.38], az(125, -40)), lh: lhC(L_HIGH_BACK), tw: 0,
      lf: [0.16, 0, 0.7, 18, 0, 0], rf: [-0.18, 0, 0.1, -32, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.3, B, { hip: [0.0, -0.26, 0.44], pel: [22, 32, 0], sp: [10, 12, 0], ch: [8, 16, 0], sw: sw([0.34, 0.82, 0.4], az(122, -38)), lh: lhC(L_HIGH_BACK),
      lf: [0.16, 0, 0.7, 18, 0, 0], rf: [-0.18, 0, 0.1, -32, 0, 0], lk: [1, 1] }),
    K(1.6, B, { hip: [0.0, -0.1, 0.46], lf: [0.16, 0, 0.7, 18, 0, 0], rf: [-0.18, 0, 0.3, -32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.88, type: 'whoosh', speed: 1.7, heavy: true }, { t: 0.92, type: 'shoot' }],
};

// ============================== execute (player) · executed (victim) ==============================
// 处决: a step in, the jian runs through level at the chest, a beat, then it is pulled free with a flick of blood.
const S = STANCE;
const execute = {
  meta: { type: 'execute', duration: 1.5, hit: [], combo: null, cancel: 1.2, damage: 0, reach: 1.4, lunge: 0.5, stab: 0.5 },
  ...START,
  keys: [
    K(0, S, {}),
    // chamber: the blade draws back level at the ribs, 剑指 reaches to seize the shoulder
    // (the edge tipped 20° up from level: an easier wrist in the chamber)
    K(0.2, S, { hip: [0.03, -0.14, 0.1], pel: [8, 30, 0], sp: [4, -2, 0], ch: [2, -8, 0], nk: [-4, -12, 0], hd: [-6, -10, 0],
      sw: sw([-0.24, 1.18, 0.0], az(3, 2), [0.94, 0.34, 0]), lh: lhC(L_REACH), lk: [1, 1] }, 'flat'),
    // run through: arm and blade one line at chest height
    K(0.5, S, { hip: [0.02, -0.2, 0.46], pel: [12, 50, 0], sp: [6, 0, 0], ch: [4, -8, 0], nk: [-6, -24, 0], hd: [-8, -22, 0],
      sw: sw([-0.08, 1.22, 0.62], az(1, 1), az(90)), lh: hand([0.28, 1.36, 0.72], nrm([0.1, 0, 1]), nrm([0, -1, 0])),
      rf: [-0.12, 0, 0.8, 4, 0, 0], lk: [1, 1] }),
    K(0.9, S, { hip: [0.02, -0.21, 0.48], pel: [12, 50, 0], sp: [6, 0, 0], ch: [4, -8, 0], nk: [-6, -24, 0], hd: [-8, -22, 0],
      sw: sw([-0.08, 1.2, 0.6], az(1, 0), az(90)), lh: hand([0.28, 1.34, 0.72], nrm([0.1, 0, 1]), nrm([0, -1, 0])),
      rf: [-0.12, 0, 0.8, 4, 0, 0], lk: [1, 1] }, 'flat'),
    // pull free and flick the blood off to the low right (out to the side: a flick behind him turned the wrist over)
    K(1.1, S, { hip: [0.02, -0.14, 0.4], pel: [8, 16, 0], sp: [4, -6, 0], ch: [2, -10, 0],
      sw: sw([-0.44, 0.9, 0.34], az(-72, -36)), lh: lhC(L_OPEN_BACK), rf: [-0.12, 0, 0.7, 4, 0, 0], lk: [1, 1] }),
    K(1.5, S, { hip: [0.02, -0.095, 0.4], rf: [-0.14, 0, 0.7, 2, 0, 0], lf: [0.18, 0, 0.2, 32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.46, type: 'whoosh', speed: 0.8 }, { t: 0.5, type: 'stab' }, { t: 1.1, type: 'whoosh', speed: 1.1 }],
};
// the victim: already broken (staggered), the blade goes in, knees buckle, falls forward
const executed = {
  meta: { type: 'death', duration: 2.0, hit: [], combo: null, cancel: 2.0, hold: true },
  ...START,
  keys: [
    K(0, B, { hip: [0.0, -0.18, 0.0], pel: [22, 0, 0], sp: [10, 0, 0], ch: [8, 0, 0], nk: [4, 0, 0], hd: [8, 0, 0] }),
    K(0.5, B, { hip: [0.0, -0.14, -0.06], pel: [-10, 0, 0], sp: [-8, 0, 0], ch: [-10, 0, 0], nk: [-10, 0, 0], hd: [-16, 0, 0],
      lh: hand([0.1, 1.2, 0.3], nrm([0, -0.3, 1]), nrm([0, -1, 0])), lk: [1, 1] }),
    K(1.0, B, { hip: [0.0, -0.18, -0.08], pel: [-12, 0, 0], sp: [-8, 0, 0], ch: [-10, 0, 0], nk: [-8, 0, 0], hd: [-12, 0, 0], lk: [1, 1] }, 'flat'),
    // knees go, then forward onto the ground
    K(1.35, B, { hip: [0.0, -0.55, 0.1], pel: [30, 0, 0], sp: [20, 0, 0], ch: [16, 0, 0], nk: [10, 0, 0], hd: [10, 0, 0],
      sw: sw([-0.4, 0.55, 0.45], az(-70, -30), [0, 1, 0]),
      lf: [0.16, 0, 0.0, 18, -40, 0], rf: [-0.18, 0, -0.18, -32, -40, 0], lk: [1, 1] }),
    K(2.0, B, { hip: [0.0, -0.78, 0.45], pel: [80, 0, 0], sp: [10, 0, 0], ch: [6, 0, 0], nk: [0, 0, 0], hd: [0, 0, 0],
      sw: sw([-0.45, 0.12, 0.7], az(-80, -4), [0, 1, 0]), lh: hand([0.4, 0.1, 0.8], nrm([0.2, 0, 1]), nrm([0, -1, 0])),
      lf: [0.16, 0, -0.1, 18, -60, 0], rf: [-0.18, 0, -0.2, -32, -60, 0], lk: [1, 1] }, 'flat'),
  ],
};

// ============================== bossTaunt · bossFlourish (the master's presence; bodies baked from the hero's library) ==============================
// Procedural fallbacks (and the sword arm for the masked taunt): the blade hangs point-down at his side while he looks
// the hero over; the flourish whirls it through the front.
const bossTaunt = {
  meta: { type: 'taunt', duration: 2.2, cancel: 1.4 },
  keys: [
    K(0, B, {}),
    K(0.4, B, { hip: [0, 0.0, 0], pel: [-2, 10, 0], ch: [-6, 6, 0], hd: [-8, -6, 0], sw: sw([-0.3, 0.9, 0.1], nrm([-0.1, -0.95, 0.25])), lh: hand([0.2, 1.0, -0.05], nrm([0, -0.3, -1]), nrm([-1, 0, 0])) }, 'flat'),
    K(1.8, B, { hip: [0, 0.0, 0], pel: [-2, 10, 0], ch: [-6, 6, 0], hd: [-10, -8, 0], sw: sw([-0.3, 0.9, 0.1], nrm([-0.1, -0.95, 0.25])), lh: hand([0.2, 1.0, -0.05], nrm([0, -0.3, -1]), nrm([-1, 0, 0])) }, 'flat'),
    K(2.2, B, {}, 'flat'),
  ],
};
const bossFlourish = {
  meta: { type: 'taunt', duration: 2.6, cancel: 2.0 },
  keys: [
    K(0, B, {}),
    K(0.5, B, { sw: sw([-0.3, 1.3, 0.4], az(-60, 40)) }),
    K(0.9, B, { sw: sw([0.0, 1.1, 0.5], az(40, -10)) }),
    K(1.3, B, { sw: sw([-0.35, 1.4, 0.2], az(-120, 50)) }),
    K(1.7, B, { sw: sw([-0.1, 1.1, 0.5], az(10, 0)) }),
    K(2.6, B, {}, 'flat'),
  ],
  events: [{ t: 0.55, type: 'whoosh', speed: 1.0 }, { t: 1.35, type: 'whoosh', speed: 1.1 }],
};

// ============================== the night assassin (夜枭, bamboo grove boss) ==============================
// assassinBlink: he sinks into a crouch and is gone ('vanish'); a heartbeat later he is behind the hero ('blink',
// placed by game.js), already coiled, and the point drives in. The reappearance is the telegraph.
const assassinBlink = {
  meta: { ...ENEMY, duration: 1.75, hit: [[1.2, 1.32]], windup: 1.08, cancel: 1.5, damage: 26, posture: 34, reach: 2.3, lunge: 1.1, arc: 0.9 },
  ...START,
  keys: [
    K(0, B, {}),
    // gather: drop low, blade tucked along the forearm
    K(0.2, B, { hip: [0.0, -0.34, -0.1], pel: [26, 10, 0], sp: [14, 6, 0], ch: [10, 6, 0], nk: [-6, -4, 0], hd: [-10, -4, 0],
      sw: sw([-0.2, 0.7, 0.1], az(-160, -20)), lh: hand([0.2, 0.55, 0.3], nrm([0, -1, 0.3]), nrm([-1, 0, 0])),
      lf: [0.2, 0, 0.2, 20, 0, 0], rf: [-0.2, 0, -0.2, -30, 0, 0], lk: [1, 1] }, 'flat'),
    K(0.9, B, { hip: [0.0, -0.36, -0.1], pel: [28, 10, 0], sp: [14, 6, 0], ch: [10, 6, 0], nk: [-6, -4, 0], hd: [-10, -4, 0],
      sw: sw([-0.24, 0.9, -0.1], az(-170, -5)), lh: hand([0.24, 0.9, 0.4], nrm([0, 0.2, 1]), nrm([-1, 0, 0])),
      lf: [0.2, 0, 0.25, 20, 0, 0], rf: [-0.2, 0, -0.3, -30, 0, 0], lk: [1, 1] }, 'flat'),
    // coiled behind him (held so the hero can read it), then the thrust
    // (the fist comes up level with the hip, not behind it, and the thrust is 平刺 — edges left and right, flat level — all
    // the way out: behind the hip, and with the edge left to chance, the wrist bent back and wrung through the lunge)
    K(1.1, B, { hip: [0.0, -0.3, -0.14], pel: [20, 24, 0], sp: [10, 12, 0], ch: [8, 14, 0], nk: [-6, -20, 0], hd: [-8, -18, 0],
      sw: sw([-0.3, 1.02, -0.05], az(-5, -4), [1, 0, 0]), lh: hand([0.3, 1.25, 0.5], nrm([0, 0.3, 1]), nrm([-1, 0, 0])),
      lf: [0.2, 0, 0.3, 20, 0, 0], rf: [-0.2, 0, -0.35, -30, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.24, B, { hip: [0.0, -0.26, 0.7], pel: [16, -8, 0], sp: [8, -4, 0], ch: [6, -6, 0], nk: [-6, 6, 0], hd: [-8, 6, 0],
      sw: sw([-0.06, 1.2, 0.9], az(0, 2), [1, 0, 0]), lh: lhC(L_OPEN_BACK),
      lf: [0.2, 0.05, 0.9, 20, 0, 0], rf: [-0.2, 0, -0.3, -30, 0, 0], lk: [0, 1] }),
    K(1.4, B, { hip: [0.0, -0.25, 0.8], pel: [14, -8, 0], sp: [8, -4, 0], ch: [6, -6, 0], sw: sw([-0.08, 1.18, 0.95], az(2, 0), [1, 0, 0]), lh: lhC(L_OPEN_BACK),
      lf: [0.2, 0, 0.95, 20, 0, 0], rf: [-0.2, 0, -0.2, -30, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.75, B, { hip: [0.0, -0.1, 0.85], lf: [0.16, 0, 1.0, 18, 0, 0], rf: [-0.18, 0, 0.2, -32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.22, type: 'vanish' }, { t: 0.9, type: 'blink' }, { t: 1.16, type: 'whoosh', speed: 1.5 }],
};
// dartThrow: the off hand flicks three darts in a fan (the 'shoot' event; combat.fireDarts)
const dartThrow = {
  meta: { ...ENEMY, duration: 1.15, hit: [], ranged: true, shootAt: 0.6, windup: 0.5, cancel: 0.9, damage: 9, posture: 10, reach: 16, lunge: -0.6 },
  ...START,
  keys: [
    K(0, B, {}),
    K(0.42, B, { hip: [0.0, -0.16, -0.1], pel: [4, -34, 0], sp: [2, -16, 0], ch: [0, -20, 0], nk: [-4, 30, 0], hd: [-6, 28, 0],
      lh: hand([0.34, 1.45, -0.22], nrm([0.2, 0.3, -1]), nrm([0, 1, 0])), sw: sw([-0.4, 0.9, 0.0], az(-120, -40)), lk: [1, 1] }, 'flat'),
    K(0.6, B, { hip: [0.0, -0.2, 0.1], pel: [10, 12, 0], sp: [6, 8, 0], ch: [4, 10, 0], nk: [-4, -10, 0], hd: [-6, -8, 0],
      lh: hand([0.12, 1.3, 0.72], nrm([-0.1, 0, 1]), nrm([0, -1, 0])), sw: sw([-0.45, 0.9, -0.1], az(-140, -40)), lk: [1, 1] }),
    K(0.8, B, { hip: [0.0, -0.18, 0.1], pel: [8, 10, 0], lh: hand([0.1, 1.2, 0.66], nrm([-0.1, -0.2, 1]), nrm([0, -1, 0])),
      sw: sw([-0.45, 0.9, -0.1], az(-140, -40)), lk: [1, 1] }, 'flat'),
    K(1.15, B, {}, 'flat'),
  ],
  events: [{ t: 0.6, type: 'shoot' }],
};

export const ENEMY2_CLIPS = { assassinBlink, dartThrow, bossTaunt, bossFlourish,  spearSweep, spearJab2, bowShot, enemyKick, shieldGuard, shieldBash, bossLeap, bossFlurry, bossDash, bossQi, execute, executed };
