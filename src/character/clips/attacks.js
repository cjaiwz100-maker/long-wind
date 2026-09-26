// Hero attacks: light combo 1–4 (劈 · 平扫 · 旋身反斩 · 跃劈), thrust (弓步平刺), heavy (剑横眉前 → 冲步低扫 → 仆步亮相),
// special (云剑 → 剑气). Key poses and timing follow the video-mocap take in src/character/mocap/jian-demo.js.
// Owner: animation (A).
//
// Timing philosophy: short readable anticipation (0.06–0.1 s), a whip-fast strike through the hit window, long
// follow-through arcs with the off hand counter-balancing, then a relaxed settle back to the guard. The body leads
// the blade (hips fire first, then chest, then arm, then the wrist snaps the tip through: overlapping action), and
// the blade's leading edge (`e`) always faces its direction of travel. Combo windows open in the follow-through, and
// each next attack starts from the previous one's follow-through pose, so chains flow on the momentum.
//
// All attacks use the clip-start frame with the root following the pelvis (see track.js): steps are real steps,
// and gameplay can warp the lunge distance (magnetism) without re-authoring.
import { STANCE, K, sw, hand, az, nrm, SW_DRAG, lhC, resolveChestHands,
  L_TUCK, L_REACH, L_SWING, L_OPEN_SIDE, L_OPEN_BACK, L_LOW_OUT, L_HANG, L_HIGH_BACK } from './poses.js';

const S = STANCE;
const START = { frame: 'start', root: 'hip' };

// ---------------------------------------------------------------------------------------------------------
// shared poses between chained attacks (key poses from the video-mocap take, src/character/mocap/jian-demo.js)
// ---------------------------------------------------------------------------------------------------------
/** attack1 finish: 劈 carried through to the low left in a deep 弓步, 剑指 opened up behind. */
const A1_FOLLOW = {
  pel: [12, 32, 2], sp: [7, 10, 0], ch: [4, 12, -3], nk: [-3, -14, 0], hd: [-5, -14, 0],
  sw: sw([0.22, 0.82, 0.44], az(78, -24), [0.3, -0.5, -0.8]),
  lh: lhC(L_OPEN_BACK),
};
/** attack2 finish: the level sweep carried out to the right, both arms spread wide (展臂). */
const A2_FOLLOW = {
  pel: [8, -26, 0], sp: [5, -10, 0], ch: [2, -12, 0], nk: [-2, 14, 0], hd: [-4, 14, 0],
  sw: sw([-0.56, 1.1, 0.2], az(-110, 2), az(170, 0)),
  lh: lhC(L_OPEN_SIDE),
};

// ============================== attack1 · 劈剑 overhead cut into 弓步 ==============================
// Mocap 11.2 → 11.6 s: the sword goes up high over the right shoulder while the left hand leads forward, the front
// foot drives into a long 弓步 and the blade falls on the diagonal to the low left; the free arm opens behind.
const attack1 = {
  meta: { duration: 0.6, type: 'light', hit: [[0.14, 0.25]], combo: [0.26, 0.54], cancel: 0.3, damage: 18, posture: 12, reach: 2.1, lunge: 0.4, arc: 'RL' },
  ...START,
  keys: [
    K(0, S, {}),
    // 举剑: blade raised up and back over the right shoulder, the left hand reaches toward the target
    K(0.08, S, { hip: [0.03, -0.08, -0.04], pel: [0, 4, 0], sp: [-3, -8, 0], ch: [-5, -12, 3], nk: [0, 10, 0], hd: [-4, 10, 0],
      sw: sw([-0.3, 1.72, -0.02], az(-150, 55), [0, 0.5, 0.8]), lh: lhC(L_REACH) }, 'flat'),
    // the step: the front foot drives out, the hands start down, the blade still high behind (whip)
    K(0.14, S, { hip: [0.02, -0.12, 0.18], pel: [4, 14, 0], sp: [0, -2, 0], ch: [-2, -4, 1], nk: [-1, 0, 0], hd: [-4, 0, 0],
      sw: sw([-0.22, 1.7, 0.3], az(-40, 55), [0.4, -0.5, 0.7]), lh: lhC(L_TUCK),
      rf: [-0.14, 0.05, 0.5, 2, 8, 0], lk: [1, 0] }),
    // contact: arm and blade one long line through the centre, the heel lands in 弓步
    K(0.19, S, { hip: [0, -0.18, 0.36], pel: [8, 26, 0], sp: [5, 6, 0], ch: [3, 8, -2], nk: [-3, -10, 0], hd: [-5, -10, 0],
      sw: sw([-0.02, 1.22, 0.64], az(15, -12), [0.5, -0.85, 0]), lh: lhC(L_SWING),
      rf: [-0.14, 0, 0.66, 4, 0, 0], lk: [1, 1] }),
    // cut through to the low left, hips sink, the back foot slides a touch
    K(0.25, S, { hip: [0, -0.26, 0.42], pel: [14, 34, 2], sp: [8, 10, 0], ch: [4, 12, -3], nk: [-3, -14, 0], hd: [-5, -14, 0],
      sw: sw([0.2, 0.8, 0.5], az(70, -22), [0.4, -0.6, -0.6]), lh: lhC(L_OPEN_BACK),
      rf: [-0.14, 0, 0.66, 4, 0, 0], lf: [0.18, 0.02, 0.02, 34, -10, 0], lk: [1, 0.4] }),
    K(0.36, S, { hip: [0, -0.22, 0.44], ...A1_FOLLOW, rf: [-0.14, 0, 0.66, 4, 0, 0], lf: [0.18, 0, 0.12, 34, 0, 0], lk: [1, 1] }, 'flat'),
    K(0.6, S, { hip: [0.02, -0.095, 0.44], rf: [-0.14, 0, 0.66, 2, 0, 0], lf: [0.18, 0, 0.27, 32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.12, type: 'whoosh', speed: 1 }],
};

// ============================== attack2 · 平扫 level sweep, left → right ==============================
// Mocap 12.4 → 12.8 s: from the low-left finish the wrist turns the edge over, the hips unwind and the blade sweeps
// level at the waist through the front and out to the right, the arms ending spread wide in 弓步.
const attack2 = {
  meta: { duration: 0.62, type: 'light', hit: [[0.13, 0.23]], combo: [0.28, 0.56], cancel: 0.32, damage: 18, posture: 12, reach: 2.1, lunge: 0.45, arc: 'LR' },
  ...START,
  keys: [
    K(0, S, { hip: [0, -0.22, 0], ...A1_FOLLOW }),
    // gather: the edge turns to face right, hips still wound left, the free hand comes in
    K(0.07, S, { hip: [0.02, -0.24, 0.02], pel: [14, 40, 2], sp: [8, 12, 0], ch: [4, 14, 0], nk: [-3, -18, 0], hd: [-5, -18, 0],
      sw: sw([0.26, 0.92, 0.36], az(110, -10), az(20, 0)), lh: lhC(L_TUCK) }, 'flat'),
    // the step: the hips unwind, the blade comes round in front at the waist
    K(0.12, S, { hip: [0, -0.24, 0.18], pel: [10, 26, 0], sp: [6, 8, 0], ch: [3, 8, 0], nk: [-2, -8, 0], hd: [-4, -8, 0],
      sw: sw([0.1, 0.98, 0.56], az(50, -6), az(-40, 0)), lh: lhC(L_TUCK),
      rf: [-0.16, 0.05, 0.5, 4, 6, 0], lk: [1, 0] }),
    // contact: level through the centre, arms opening
    K(0.17, S, { hip: [0, -0.26, 0.34], pel: [10, 4, 0], sp: [6, -2, 0], ch: [3, -2, 0], nk: [-2, 0, 0], hd: [-4, 0, 0],
      sw: sw([-0.14, 1.02, 0.66], az(-10, -4), az(-100, 0)), lh: lhC(L_OPEN_SIDE),
      rf: [-0.16, 0, 0.72, 4, 0, 0], lk: [1, 1] }),
    K(0.23, S, { hip: [0, -0.26, 0.4], pel: [10, -18, 0], sp: [6, -8, 0], ch: [3, -10, 0], nk: [-2, 10, 0], hd: [-4, 10, 0],
      sw: sw([-0.46, 1.06, 0.46], az(-70, -2), az(-160, 0)), lh: lhC(L_OPEN_SIDE),
      rf: [-0.16, 0, 0.72, 4, 0, 0], lf: [0.18, 0.02, 0.1, 32, -10, 0], lk: [1, 0] }),
    // 展臂: both arms spread, blade level out to the right
    K(0.33, S, { hip: [0, -0.22, 0.46], ...A2_FOLLOW, rf: [-0.16, 0, 0.72, 4, 0, 0], lf: [0.18, 0, 0.28, 32, 0, 0], lk: [1, 1] }, 'flat'),
    K(0.62, S, { hip: [0.02, -0.095, 0.48], rf: [-0.14, 0, 0.72, 2, 0, 0], lf: [0.18, 0, 0.31, 32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.1, type: 'whoosh', speed: 1 }],
};


// ============================== attack3 · 旋身反斩 (spinning back-cut) ==============================
// Continues attack2's rightward momentum into a full turn to the right, low and driven rather than a pirouette: the
// left foot crosses in front and the hips drop, the torso pitches into the turn and leans with it (no upright
// spinning top), the blade is coiled high over the left shoulder where it can be seen, then the right leg sweeps
// round and the backhand unwinds at full arm's length at chest height, finishing with both arms thrown wide in a
// long 弓步. Hands ride in chest space so the whole kit turns as one.
const C3 = { space: { L: 'chest', R: 'chest' } };
const attack3 = {
  meta: { duration: 0.82, type: 'light', hit: [[0.27, 0.37]], combo: [0.42, 0.72], cancel: 0.46, damage: 24, posture: 16, reach: 2.4, lunge: 0.7, arc: 'LR', look: 0.2 },
  ...START, ...C3,
  keys: [
    K(0, S, { hip: [-0.02, -0.1, 0.0], ...A2_FOLLOW,
      sw: sw([-0.3, 0.38, 0.14], nrm([-0.55, 0.62, -0.56]), nrm([0.5, 0.5, -0.7])),
      lh: L_LOW_OUT }),
    // eyes lead: head and chest start round, weight drops onto the right (front) foot, the blade lifts
    K(0.06, S, { hip: [-0.04, -0.14, 0.06], pel: [10, 2, -4], sp: [4, -22, 0], ch: [2, -26, 2], nk: [0, -12, 0], hd: [-4, -16, 0],
      sw: sw([-0.1, 0.36, 0.26], nrm([0.2, 0.8, -0.56]), nrm([0.9, 0.2, 0.4])),
      lh: L_LOW_OUT, lk: [1, 1] }, 'flat'),
    // crossing step, low: back turned, torso pitched and leaning into the turn; the blade coiled high over the left
    // shoulder (剑绕肩), point back, the free hand out low for balance
    K(0.17, S, { hip: [-0.02, -0.17, 0.2], pel: [14, -150, 8], sp: [6, -16, 4], ch: [3, -16, 4], nk: [-2, -22, 0], hd: [-6, -26, 0],
      sw: sw([0.2, 0.36, 0.04], nrm([0.45, 0.55, -0.7]), nrm([-0.2, 0.7, 0.68])),
      lh: L_LOW_OUT,
      lf: [-0.06, 0.0, 0.48, -130, 0, 0], rf: [-0.12, 0, 0.26, -60, -14, 0], lk: [0, 0] }),
    // swing: the right leg sweeps round wide, the chest arrives first, the blade starts to unwind across the front
    K(0.26, S, { hip: [-0.02, -0.17, 0.4], pel: [14, -270, 6], sp: [6, -22, 3], ch: [3, -24, 2], nk: [-2, 10, 0], hd: [-6, 12, 0],
      sw: sw([0.06, 0.16, 0.52], nrm([0.55, 0.15, 0.82]), nrm([-0.82, 0.0, 0.55])),
      lh: L_SWING,
      lf: [-0.04, 0, 0.48, -250, -10, 0], rf: [-0.4, 0.08, 0.78, -250, 0, 0], lk: [0, 0] }),
    // contact: facing the enemy again, the backhand at full arm's length through the front at chest height
    K(0.32, S, { hip: [-0.02, -0.18, 0.58], pel: [14, -322, -2], sp: [6, -18, 0], ch: [2, -18, 2], nk: [-2, 22, 0], hd: [-6, 22, 0],
      sw: sw([-0.44, 0.04, 0.46], nrm([-0.55, 0.0, 0.84]), nrm([-0.84, 0.0, -0.55])),
      lh: L_OPEN_SIDE,
      lf: [0.08, 0, 0.44, -330, -8, 0], rf: [-0.2, 0, 1.0, -356, 6, 0], lk: [0.2, 1] }),
    // follow-through: the blade runs on past the right hip and trails low behind, the free hand gathers in by the belly
    // (the old both-arms-flung-level finish read as a T-pose), low in 弓步
    K(0.42, S, { hip: [-0.02, -0.19, 0.64], pel: [14, -338, -3], sp: [6, -20, 0], ch: [2, -22, 3], nk: [-2, 26, 0], hd: [-6, 24, 0],
      sw: sw([-0.56, -0.12, -0.02], [-0.754, -0.302, -0.583], [0.266, -0.952, 0.149]),
      lh: L_TUCK,
      lf: [0.16, 0, 0.44, -320, 0, 0], rf: [-0.16, 0, 1.0, -356, 0, 0], lk: [1, 1] }, 'flat'),
    K(0.54, S, { hip: [-0.02, -0.185, 0.64], pel: [12, -338, -3], sp: [5, -20, 0], ch: [2, -22, 3], nk: [-2, 26, 0], hd: [-6, 24, 0],
      sw: sw([-0.5, -0.24, -0.02], [-0.680, -0.450, -0.580], [0.378, -0.892, 0.248]),
      lh: L_TUCK,
      lf: [0.16, 0, 0.44, -320, 0, 0], rf: [-0.16, 0, 1.0, -356, 0, 0], lk: [1, 1] }),
    // settle back into the guard (chest-space guard of the stance)
    K(0.82, S, { hip: [0.02, -0.085, 0.68], pel: [5, -336, 0],
      sw: sw([-0.25, -0.43, 0.13], nrm([-0.2, -0.6, 0.77]), nrm([-0.05, -0.78, -0.62])),   // the chest-space ready (SW_DRAG)
      lh: L_HANG,
      lf: [0.17, 0, 0.44, -320, 0, 0], rf: [-0.12, 0, 1.0, -356, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.24, type: 'whoosh', speed: 1.2 }],
};

// ============================== attack4 · 劈 leaping downward finishing cleave ==============================
const attack4 = {
  meta: { duration: 1.0, type: 'light', hit: [[0.4, 0.5]], combo: null, cancel: 0.66, damage: 32, posture: 26, reach: 2.2, lunge: 1.2, finisher: true, arc: 'down' },
  ...START,
  keys: [
    K(0, S, {}),
    // gather: crouch, blade drawn low and back, 剑指 points at the target
    K(0.1, S, { hip: [0.03, -0.2, -0.05], pel: [12, 30, 0], sp: [6, -10, 0], ch: [4, -14, 0], nk: [-4, 0, 0], hd: [-8, -2, 0],
      sw: sw([-0.34, 0.9, 0.0], az(-165, -30)),
      lh: lhC(L_TUCK), lk: [1, 1] }, 'flat'),
    // take-off: legs drive, the blade swings up in a big arc beside the body
    K(0.2, S, { hip: [0.02, -0.02, 0.28], pel: [2, 26, 0], sp: [0, -8, 0], ch: [-4, -10, 0], nk: [-2, -4, 0], hd: [-6, -4, 0],
      sw: sw([-0.3, 1.6, 0.14], az(-120, 70)),
      lh: lhC(L_REACH),
      lf: [0.17, 0.02, -0.18, 40, -36, 0], rf: [-0.12, 0.06, 0.34, 4, -30, 0], lk: [0, 0] }),
    // apex: knees tucked, blade cocked behind the head, 剑指 high — the whole body a drawn bow
    K(0.3, S, { hip: [0.02, 0.2, 0.68], pel: [-4, 22, 0], sp: [-6, -6, 0], ch: [-8, -8, 0], nk: [0, -4, 0], hd: [-2, -4, 0],
      sw: sw([-0.14, 2.08, 0.0], az(175, -35)),
      lh: hand([0.36, 1.98, 0.2], nrm([0.2, 0.9, 0.3]), nrm([-0.5, 0, 0.85])),
      lf: [0.17, 0.3, 0.46, 34, 10, 0], rf: [-0.12, 0.38, 0.9, 4, 16, 0], lk: [0, 0] }),
    // over the top: falling, the blade whips over the head
    K(0.38, S, { hip: [0.01, 0.1, 1.0], pel: [10, 24, 0], sp: [8, -8, 0], ch: [8, -8, 0], nk: [-6, -4, 0], hd: [-8, -4, 0],
      sw: sw([-0.1, 1.96, 0.4], az(-2, 45)),
      lh: lhC(L_OPEN_SIDE),
      lf: [0.17, 0.16, 0.62, 36, 0, 0], rf: [-0.12, 0.12, 1.36, 4, 14, 0], lk: [0, 0] }),
    // contact: the cleave falls with the body, front heel lands
    K(0.44, S, { hip: [0.0, -0.1, 1.16], pel: [18, 26, 0], sp: [12, -8, 0], ch: [10, -8, 0], nk: [-8, -4, 0], hd: [-10, -4, 0],
      sw: sw([-0.08, 1.12, 0.66], az(0, -30), az(0, -95)),
      lh: lhC(L_OPEN_BACK),
      lf: [0.17, 0.06, 0.74, 40, -10, 0], rf: [-0.12, 0, 1.56, 4, 12, 0], lk: [0, 1] }),
    // impact: deep landing, blade tip a hand's breadth above the grass, 剑指 thrown high behind
    K(0.52, S, { hip: [0.0, -0.3, 1.22], pel: [24, 28, 0], sp: [14, -8, 0], ch: [10, -8, 0], nk: [-12, -4, 0], hd: [-14, -4, 0],
      sw: sw([-0.06, 0.66, 0.68], az(0, -62), az(180, -30)),
      lh: lhC(L_OPEN_BACK),
      lf: [0.17, 0, 0.8, 40, 0, 0], rf: [-0.12, 0, 1.56, 4, 0, 0], lk: [1, 1] }, 'flat'),
    // hold the finish, then rise
    K(0.7, S, { hip: [0.0, -0.27, 1.22], pel: [20, 28, 0], sp: [12, -8, 0], ch: [8, -8, 0], nk: [-10, -4, 0], hd: [-12, -4, 0],
      sw: sw([-0.08, 0.7, 0.66], az(0, -58), az(180, -30)),
      lh: lhC(L_OPEN_BACK),
      lf: [0.17, 0, 0.8, 40, 0, 0], rf: [-0.12, 0, 1.56, 4, 0, 0], lk: [1, 1] }),
    K(1.0, S, { hip: [0.02, -0.085, 1.22], lf: [0.17, 0, 0.98, 40, 0, 0], rf: [-0.12, 0, 1.48, 4, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.2, type: 'jump' }, { t: 0.36, type: 'whoosh', speed: 1.4, heavy: true }, { t: 0.5, type: 'impact', ground: true }],
};

// ============================== thrust · 刺 lightning lunge ==============================
const THRUST_EXT = {
  pel: [10, 58, 0], sp: [6, 0, 0], ch: [4, -10, 0], nk: [-6, -26, 0], hd: [-8, -22, 0],
  sw: sw([-0.08, 1.22, 0.8], az(1, 1), az(90)),
  lh: lhC(L_OPEN_BACK),   // free arm flung back level: counterweight to the lunge
};
const thrust = {
  meta: { duration: 0.64, type: 'thrust', hit: [[0.15, 0.24]], combo: [0.3, 0.56], cancel: 0.34, damage: 24, posture: 14, reach: 2.5, lunge: 1.8, arc: 'point' },
  ...START,
  keys: [
    K(0, S, {}),
    // chamber: blade drawn back level at the ribs, 剑指 laid along the line of attack, weight on the rear leg
    K(0.07, S, { hip: [0.05, -0.12, -0.06], pel: [6, 34, 0], sp: [4, -2, 0], ch: [2, -8, 0], nk: [-4, -12, 0], hd: [-6, -10, 0],
      sw: sw([-0.24, 1.14, 0.02], az(3, 2), az(90)),
      lh: lhC(L_TUCK), lk: [1, 1] }, 'flat'),
    // explode: rear leg drives, front foot flies forward low, the point leads
    K(0.12, S, { hip: [0.03, -0.15, 0.36], pel: [8, 42, 0], sp: [5, -2, 0], ch: [2, -8, 0], nk: [-5, -16, 0], hd: [-7, -14, 0],
      sw: sw([-0.14, 1.18, 0.46], az(2, 1), az(90)),
      lh: lhC(L_SWING),
      rf: [-0.12, 0.07, 0.86, 4, 14, 0], lf: [0.17, 0.0, -0.08, 40, -30, 0], lk: [0, 0] }),
    // full extension: 弓步 lunge, arm and blade one straight line, 剑指 arcs overhead behind
    K(0.17, S, { hip: [0.02, -0.19, 1.3], ...THRUST_EXT,
      rf: [-0.12, 0, 1.92, 4, 12, 0], lf: [0.16, 0, 0.72, 50, 0, 0], lk: [0, 1] }),
    K(0.22, S, { hip: [0.02, -0.21, 1.52], ...THRUST_EXT, sw: sw([-0.08, 1.2, 0.82], az(1, 0), az(90)),
      rf: [-0.12, 0, 2.04, 4, 0, 0], lf: [0.17, 0, 0.9, 52, 0, 0], lk: [1, 1] }, 'flat'),
    // recover: point withdraws to the guard, back foot slides up
    K(0.36, S, { hip: [0.02, -0.14, 1.62], pel: [6, 34, 0], sp: [4, -6, 0], ch: [3, -8, 0],
      rf: [-0.12, 0, 2.04, 4, 0, 0], lf: [0.17, 0.02, 1.36, 42, -8, 0], lk: [1, 0] }),
    K(0.64, S, { hip: [0.02, -0.085, 1.78], rf: [-0.12, 0, 2.04, 4, 0, 0], lf: [0.17, 0, 1.58, 40, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.1, type: 'whoosh', speed: 1.1 }],
};

// ============================== heavyCharge · 剑横眉前 (loop) ==============================
// Mocap/video 9.3 s: the blade held level across the front of the eyes, flat to the enemy, the 剑指 resting on it;
// the stance sinks, a slow breath runs through the loop.
const CH_BODY = { ...S, hip: [0.02, -0.14, -0.02], pel: [4, 26, 0], sp: [2, -8, 0], ch: [0, -10, 0], nk: [-2, -14, 0], hd: [-4, -12, 0],
  lf: [0.2, 0, -0.22, 40, 0, 0], rf: [-0.13, 0, 0.26, 4, 0, 0] };
const heavyCharge = {
  meta: { duration: 0.9, loop: true, type: 'heavy', layer: 'full', cancel: 0 },
  keys: [0, 0.45, 0.9].map((t, i) => K(t, CH_BODY, {
    hip: [0.02, -0.14 - (i === 1 ? 0.012 : 0), -0.02], ch: [i === 1 ? 1.5 : 0, -10, 0],
    sw: sw([-0.2, 1.5 + (i === 1 ? 0.008 : 0), 0.3], az(75, 0), [0, 0.7, 0.7]),   // edge up: the flat faces the enemy, level
    lh: hand([0.04, 1.5, 0.35], nrm([0.95, 0.1, 0.25]), nrm([-0.2, 0, -1])),
  })),
  events: [{ t: 0.05, type: 'whoosh', speed: 0.3 }],
};

// ============================== heavy · 冲步力劈 (dash into a falling cleave) ==============================
// From the brow guard the sword is thrown up high behind the head as the legs drive (the whole body a drawn bow),
// the dash closes the distance, and the blade falls from above the head down the diagonal to the low front as the
// hips drop into a long 弓步; the 剑指 flies up behind. The cut only ever travels downward (力劈华山).
const HV_FINISH = { pel: [22, 34, 2], sp: [12, 10, 0], ch: [6, 12, -3], nk: [-8, -12, 0], hd: [-10, -12, 0] };
const heavy = {
  meta: { duration: 1.12, type: 'heavy', hit: [[0.42, 0.54]], combo: null, cancel: 0.76, damage: 42, posture: 40, reach: 2.6, lunge: 2.5,
    leap: { t0: 0.1, t1: 0.4, h: 0.12 }, arc: 'RL-down' },
  ...START,
  keys: [
    K(0, CH_BODY, { sw: sw([-0.2, 1.5, 0.3], az(75, 0), [0, 0.7, 0.7]), lh: hand([0.04, 1.5, 0.35], nrm([0.95, 0.1, 0.25]), nrm([-0.2, 0, -1])) }),
    // 举: the blade swings up and back over the right shoulder, the chest opens, the 剑指 reaches for the target
    K(0.1, S, { hip: [0.03, -0.16, 0.1], pel: [4, 14, 0], sp: [-4, -10, 0], ch: [-7, -14, 3], nk: [2, 8, 0], hd: [-2, 8, 0],
      sw: sw([-0.28, 1.78, -0.1], az(-155, 52), [0, 0.5, 0.8]), lh: lhC(L_REACH),
      rf: [-0.13, 0.04, 0.36, 4, -16, 0], lf: [0.2, 0, -0.22, 40, -26, 0], lk: [0.3, 0.3] }, 'flat'),
    // the dash: low and long, the blade cocked behind the head
    K(0.26, S, { hip: [0.02, -0.12, 1.1], pel: [6, 18, 0], sp: [-2, -10, 0], ch: [-6, -12, 2], nk: [0, 6, 0], hd: [-4, 6, 0],
      sw: sw([-0.18, 1.96, -0.16], az(-170, 34), [0, 0.8, 0.6]), lh: lhC(L_REACH),
      rf: [-0.14, 0.12, 1.6, 4, 12, 0], lf: [0.2, 0.08, 0.7, 40, -24, 0], lk: [0, 0] }),
    // over the top: the front foot reaches, the blade comes over the head (still high)
    K(0.37, S, { hip: [0.01, -0.16, 1.8], pel: [10, 22, 0], sp: [4, 0, 0], ch: [2, 2, 0], nk: [-4, -4, 0], hd: [-6, -4, 0],
      sw: sw([-0.12, 1.98, 0.3], az(-15, 62), [0.3, -0.6, 0.74]), lh: lhC(L_TUCK),
      rf: [-0.16, 0.04, 2.36, 4, 10, 0], lf: [0.22, 0.04, 1.2, 42, -16, 0], lk: [0, 0] }),
    // contact: the heel lands, arm and blade one long line falling through the centre
    K(0.44, S, { hip: [0.0, -0.3, 2.0], pel: [16, 28, 0], sp: [8, 6, 0], ch: [4, 8, -2], nk: [-6, -8, 0], hd: [-8, -8, 0],
      sw: sw([-0.02, 1.2, 0.7], az(12, -18), [0.5, -0.85, 0]), lh: lhC(L_SWING),
      rf: [-0.16, 0, 2.42, 4, 0, 0], lf: [0.22, 0.02, 1.34, 44, -10, 0], lk: [1, 0.6] }),
    // through: the blade drives down to the low front-left, hips sink into the long 弓步, 剑指 flies up behind
    K(0.52, S, { hip: [0.0, -0.42, 2.1], ...HV_FINISH,
      sw: sw([0.2, 0.74, 0.62], az(48, -52), [0.4, -0.5, -0.75]), lh: lhC(L_HIGH_BACK),
      rf: [-0.16, 0, 2.42, 4, 0, 0], lf: [0.22, 0, 1.4, 46, 0, 0], lk: [1, 1] }),
    // 亮相: held low, tip a hand above the grass
    K(0.62, S, { hip: [0.0, -0.44, 2.1], ...HV_FINISH,
      sw: sw([0.22, 0.7, 0.6], az(46, -56), [0.4, -0.5, -0.75]), lh: lhC(L_HIGH_BACK),
      rf: [-0.16, 0, 2.42, 4, 0, 0], lf: [0.22, 0, 1.4, 46, 0, 0], lk: [1, 1] }, 'flat'),
    K(0.86, S, { hip: [0.0, -0.43, 2.1], ...HV_FINISH, pel: [20, 34, 2],
      sw: sw([0.22, 0.71, 0.6], az(46, -54), [0.4, -0.5, -0.75]), lh: lhC(L_HIGH_BACK),
      rf: [-0.16, 0, 2.42, 4, 0, 0], lf: [0.22, 0, 1.4, 46, 0, 0], lk: [1, 1] }),
    K(1.12, S, { hip: [0.02, -0.095, 2.2], rf: [-0.14, 0, 2.42, 2, 0, 0], lf: [0.18, 0, 1.95, 32, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.1, type: 'whoosh', speed: 0.7 }, { t: 0.4, type: 'whoosh', speed: 1.5, heavy: true }, { t: 0.5, type: 'impact', ground: true }],
};


// ============================== special · 剑气 qi sword-wave ==============================
// 以指抹剑: the 剑指 wipes the flat from guard to tip (the blade gathers qi), a coiled wind-up, then a great
// descending diagonal sweep that releases the wave, held in a low 亮相 finish.
const special = {
  meta: { duration: 1.36, type: 'special', hit: [[0.64, 0.76]], combo: null, cancel: 1.0, damage: 60, posture: 60, reach: 14, lunge: 0.6, unblockable: true, arc: 'RL-down' },
  ...START,
  keys: [
    K(0, S, {}),
    // 云剑: the blade circles flat over the head (video 4.6–5.0 s), the free arm out for balance
    K(0.16, S, { hip: [0.02, -0.14, -0.02], pel: [4, 14, 0], sp: [0, -4, 0], ch: [-3, -4, 0], nk: [-2, -3, 0], hd: [-6, -2, 0],
      sw: sw([-0.06, 1.9, 0.12], az(80, 5), az(170, 0)), lh: lhC(L_OPEN_SIDE),
      lf: [0.22, 0, -0.22, 42, 0, 0], rf: [-0.15, 0, 0.26, 2, 0, 0], lk: [1, 1] }),
    K(0.29, S, { hip: [0.02, -0.15, -0.02], pel: [4, 8, 0], sp: [-1, -8, 0], ch: [-4, -8, 0], nk: [-2, 4, 0], hd: [-6, 4, 0],
      sw: sw([0.0, 1.94, -0.02], az(-170, 8), az(-80, 0)), lh: lhC(L_OPEN_SIDE),
      lf: [0.22, 0, -0.22, 42, 0, 0], rf: [-0.15, 0, 0.26, 2, 0, 0], lk: [1, 1] }),
    K(0.42, S, { hip: [0.02, -0.15, -0.02], pel: [4, 2, 0], sp: [-2, -12, 0], ch: [-4, -14, 2], nk: [0, 12, 0], hd: [-4, 12, 0],
      sw: sw([-0.14, 1.9, 0.08], az(-90, 6), az(0, 0)), lh: lhC(L_REACH),
      lf: [0.22, 0, -0.22, 42, 0, 0], rf: [-0.15, 0, 0.26, 2, 0, 0], lk: [1, 1] }),
    // coil: blade swung back high over the right shoulder, 剑指 points at the enemy, weight back
    K(0.54, S, { hip: [0.05, -0.16, -0.08], pel: [2, 0, -2], sp: [-2, -16, 0], ch: [-4, -20, 3], nk: [0, 18, 0], hd: [-4, 16, 0],
      sw: sw([-0.42, 1.74, -0.06], az(-150, -10)),
      lh: hand([0.14, 1.42, 0.5], nrm([-0.05, 0.1, 1]), nrm([-0.9, -0.3, 0])),
      lf: [0.22, 0, -0.22, 42, 0, 0], rf: [-0.15, 0, 0.26, 2, 0, 0], lk: [1, 1] }, 'flat'),
    // release: a long stamp forward, the blade comes over the top at full reach
    K(0.61, S, { hip: [0.02, -0.18, 0.4], pel: [8, 16, 0], sp: [2, -4, 0], ch: [-2, -4, 0], nk: [-2, -4, 0], hd: [-6, -4, 0],
      sw: sw([-0.2, 1.96, 0.3], az(-20, 60), [0.3, -0.6, 0.74]),
      lh: lhC(L_TUCK),
      rf: [-0.14, 0.06, 0.9, 4, 12, 0], lk: [1, 0] }),
    // the great diagonal: arm and blade one straight line from the shoulder, falling through the front
    K(0.67, S, { hip: [0.0, -0.27, 0.72], pel: [16, 30, 2], sp: [8, 8, 0], ch: [4, 10, -2], nk: [-4, -10, 0], hd: [-8, -10, 0],
      sw: sw([-0.02, 1.26, 0.72], az(16, -14), [0.5, -0.85, 0]),
      lh: lhC(L_SWING),
      rf: [-0.14, 0, 1.2, 4, 0, 0], lf: [0.22, 0.02, 0.0, 44, -10, 0], lk: [1, 0.6] }),
    K(0.74, S, { hip: [0.0, -0.34, 0.8], pel: [20, 40, 3], sp: [10, 12, 0], ch: [6, 14, -3], nk: [-6, -18, 0], hd: [-10, -18, 0],
      sw: sw([0.36, 0.86, 0.5], az(88, -34), [0.2, -0.5, -0.85]),
      lh: lhC(L_OPEN_BACK),
      rf: [-0.14, 0, 1.2, 4, 0, 0], lf: [0.22, 0, 0.1, 46, 0, 0], lk: [1, 1] }),
    // 亮相: the blade swept back up level and pointed at the enemy at full reach, the 剑指 thrown up behind —
    // one straight line from the rear hand to the point, low in the long 弓步 (the wind takes the robe)
    K(0.86, S, { hip: [0.0, -0.34, 0.8], pel: [14, 44, 2], sp: [8, 2, 0], ch: [4, -6, 0], nk: [-6, -30, 0], hd: [-8, -28, 0],
      sw: sw([-0.1, 1.34, 0.74], az(-4, 6), az(90)),
      lh: lhC(L_HIGH_BACK), rf: [-0.14, 0, 1.2, 4, 0, 0], lf: [0.22, 0, 0.1, 46, 0, 0], lk: [1, 1] }, 'flat'),
    K(1.08, S, { hip: [0.0, -0.33, 0.8], pel: [14, 44, 2], sp: [8, 2, 0], ch: [4, -6, 0], nk: [-6, -30, 0], hd: [-8, -28, 0],
      sw: sw([-0.1, 1.35, 0.74], az(-4, 7), az(90)),
      lh: lhC(L_HIGH_BACK), rf: [-0.14, 0, 1.2, 4, 0, 0], lf: [0.22, 0, 0.1, 46, 0, 0], lk: [1, 1] }),
    K(1.36, S, { hip: [0.02, -0.085, 0.84], rf: [-0.13, 0, 1.16, 4, 0, 0], lf: [0.18, 0, 0.66, 40, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.16, type: 'charge' }, { t: 0.58, type: 'whoosh', speed: 1.6, heavy: true }, { t: 0.64, type: 'release' }],
};


// ============================== airFlurry · 跃空斩 (leaping diagonal cut) ==============================
// One clean, wide cut from the air: a crouch, a high leap with the sword thrown back over the right shoulder and the
// body arched like a drawn bow, the great diagonal from high right to low left at the top of the jump, and a deep
// 弓步 landing with the 剑指 flung up behind. The height is authored on the hips (no gameplay hop) so the foot
// planter sees the real contacts.
const airFlurry = {
  meta: { duration: 1.1, type: 'light', hit: [[0.4, 0.52]], combo: [0.66, 0.94], cancel: 0.76,
    damage: 34, posture: 28, reach: 2.4, lunge: 1.3, arc: 'RL-down' },
  ...START,
  keys: [
    K(0, S, {}),
    // gather: crouch, blade drawn low and back, 剑指 toward the target
    K(0.1, S, { hip: [0.03, -0.24, 0.04], pel: [16, 24, 0], sp: [6, -8, 0], ch: [4, -12, 0], nk: [-4, 0, 0], hd: [-8, 0, 0],
      sw: sw([-0.34, 0.9, 0.0], az(-165, -30)), lh: lhC(L_REACH), lk: [1, 1] }, 'flat'),
    // take-off: legs drive, the blade swings up and back over the right shoulder
    K(0.2, S, { hip: [0.02, 0.12, 0.3], pel: [2, 22, 0], sp: [-4, -10, 0], ch: [-6, -12, 2], nk: [0, 6, 0], hd: [-4, 6, 0],
      sw: sw([-0.28, 1.8, -0.06], az(-155, 52), [0, 0.5, 0.8]), lh: lhC(L_REACH),
      lf: [0.17, 0.14, 0.0, 40, -40, 0], rf: [-0.12, 0.2, 0.46, 4, -30, 0], lk: [0, 0] }),
    // apex: knees tucked high, the body a drawn bow — blade cocked far behind the head, 剑指 high and forward
    K(0.32, S, { hip: [0.02, 0.5, 0.62], pel: [-8, 24, 0], sp: [-8, -8, 0], ch: [-10, -10, 0], nk: [2, -4, 0], hd: [0, -4, 0],
      sw: sw([-0.16, 2.1, -0.08], az(-168, 30), [0.34, 0.79, 0.52]),   // edge rolled 20° about the blade: an easier wrist
      lh: hand([0.38, 1.98, 0.3], nrm([0.2, 0.9, 0.3]), nrm([-0.5, 0, 0.85])),
      lf: [0.17, 0.62, 0.46, 34, 20, 0], rf: [-0.12, 0.7, 0.86, 4, 24, 0], lk: [0, 0] }),
    // the cut: over the top and down the diagonal at full reach, hips twisting through, still in the air
    K(0.4, S, { hip: [0.01, 0.46, 0.84], pel: [8, 26, 0], sp: [4, 2, 0], ch: [2, 4, 0], nk: [-4, -6, 0], hd: [-6, -6, 0],
      sw: sw([-0.2, 1.9, 0.44], az(-30, 50), [0.4, -0.5, 0.7]), lh: lhC(L_TUCK),
      lf: [0.17, 0.56, 0.62, 36, 16, 0], rf: [-0.12, 0.62, 1.02, 4, 20, 0], lk: [0, 0] }),
    K(0.46, S, { hip: [0.0, 0.3, 1.0], pel: [14, 30, 0], sp: [8, 8, 0], ch: [4, 10, -2], nk: [-6, -10, 0], hd: [-8, -10, 0],
      sw: sw([-0.02, 1.3, 0.72], az(16, -16), [0.5, -0.85, 0]), lh: lhC(L_SWING),
      lf: [0.17, 0.34, 0.74, 38, 8, 0], rf: [-0.12, 0.34, 1.3, 4, 10, 0], lk: [0, 0] }),
    // landing: the blade finishes low to the left as the heels strike, deep 弓步, 剑指 thrown up behind
    K(0.54, S, { hip: [0.0, -0.3, 1.14], pel: [22, 36, 2], sp: [12, 10, 0], ch: [6, 12, -3], nk: [-8, -12, 0], hd: [-10, -12, 0],
      sw: sw([0.24, 0.74, 0.58], az(52, -50), [0.4, -0.5, -0.75]), lh: lhC(L_LOW_OUT),
      lf: [0.19, 0, 0.8, 42, 0, 0], rf: [-0.14, 0, 1.52, 4, 0, 0], lk: [1, 1] }),
    K(0.62, S, { hip: [0.0, -0.36, 1.14], pel: [22, 36, 2], sp: [12, 10, 0], ch: [6, 12, -3], nk: [-8, -12, 0], hd: [-10, -12, 0],
      sw: sw([0.24, 0.7, 0.58], az(50, -54), [0.4, -0.5, -0.75]), lh: lhC(L_LOW_OUT),
      lf: [0.19, 0, 0.8, 42, 0, 0], rf: [-0.14, 0, 1.52, 4, 0, 0], lk: [1, 1] }, 'flat'),
    K(0.84, S, { hip: [0.0, -0.34, 1.14], pel: [20, 36, 2], sp: [11, 10, 0], ch: [6, 12, -3], nk: [-8, -12, 0], hd: [-10, -12, 0],
      sw: sw([0.24, 0.71, 0.58], az(50, -52), [0.4, -0.5, -0.75]), lh: lhC(L_LOW_OUT),
      lf: [0.19, 0, 0.8, 42, 0, 0], rf: [-0.14, 0, 1.52, 4, 0, 0], lk: [1, 1] }),
    K(1.1, S, { hip: [0.02, -0.085, 1.16], lf: [0.17, 0, 0.94, 40, 0, 0], rf: [-0.12, 0, 1.46, 4, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.16, type: 'jump' }, { t: 0.37, type: 'whoosh', speed: 1.5, heavy: true }, { t: 0.54, type: 'impact', ground: true }],
};

// ============================== flipCleave · 空翻斜劈 (somersault cleave) ==============================
// Take-off, a full forward somersault tucked round the blade (hands ride in chest space so they turn with the body),
// the body opens out of the roll already high, and the cleave falls on the diagonal with the landing.
// Tucked-foot offsets follow the hips round the flip: v = (0, -0.32, 0.12) pitched by θ about the hips.
const flipFeet = (th, hipY, z, side) => {
  const r = th * Math.PI / 180, y = -0.32 * Math.cos(r) - 0.12 * Math.sin(r), zz = -0.32 * Math.sin(r) + 0.12 * Math.cos(r);
  const H = 0.95 + hipY;
  return side === 'L' ? [0.15, Math.max(0, H + y), z + zz, 36, th, 0] : [-0.12, Math.max(0, H + y + 0.03), z + zz + 0.08, 4, th, 0];
};
const FLIP = (t, th, hipY, z, extra = {}) => K(t, S, {
  hip: [0.0, hipY, z], pel: [th, 20, 0], sp: [26, -6, 0], ch: [22, -6, 0], nk: [18, -4, 0], hd: [10, -4, 0],
  sw: sw([-0.14, -0.1, 0.34], nrm([0.1, -0.35, -0.93]), nrm([0, 0.93, -0.35])), lh: L_TUCK,
  lf: flipFeet(th, hipY, z, 'L'), rf: flipFeet(th, hipY, z, 'R'), lk: [0, 0], ...extra });
const flipCleave = {
  meta: { duration: 1.2, type: 'light', hit: [[0.62, 0.72]], combo: null, cancel: 0.9, damage: 34, posture: 30, reach: 2.4, lunge: 1.6,
    finisher: true, arc: 'RL-down' },
  ...START, ...C3,
  keys: [
    K(0, S, { pel: [6, 16, -1] }),
    // gather: crouch, arms swing down and back
    K(0.08, S, { hip: [0.02, -0.24, 0.04], pel: [18, 18, 0], sp: [8, -6, 0], ch: [6, -8, 0], nk: [-4, 0, 0], hd: [-8, 0, 0],
      sw: sw([-0.3, -0.5, -0.1], nrm([-0.3, -0.5, -0.8]), nrm([0, -0.85, 0.5])), lh: L_LOW_OUT, lk: [1, 1] }, 'flat'),
    // take-off: arms throw up, the chest leads over
    K(0.16, S, { hip: [0.02, 0.34, 0.3], pel: [30, 18, 0], sp: [10, -6, 0], ch: [8, -6, 0], nk: [4, 0, 0], hd: [0, 0, 0],
      sw: sw([-0.2, 0.3, 0.3], nrm([0.1, 0.6, -0.8]), nrm([0, 0.8, 0.6])), lh: L_REACH,
      lf: [0.17, 0.5, 0.05, 40, -30, 0], rf: [-0.12, 0.56, 0.4, 4, -30, 0], lk: [0, 0] }),
    FLIP(0.26, 120, 0.66, 0.6),
    FLIP(0.35, 220, 0.7, 0.9),
    FLIP(0.44, 310, 0.6, 1.15),
    // open out of the roll: upright, the blade already raised over the head, legs reaching down
    // (the edge is turned 30° about the blade: with the old roll the wrist had to wring over to hold it)
    K(0.53, S, { hip: [0.0, 0.4, 1.34], pel: [362, 22, 0], sp: [-4, -6, 0], ch: [-6, -8, 0], nk: [0, -4, 0], hd: [-2, -4, 0],
      sw: sw([-0.1, 0.62, 0.02], nrm([-0.2, 0.55, -0.8]), nrm([0.58, 0.71, 0.4])), lh: L_REACH,
      lf: [0.17, 0.5, 1.1, 38, 0, 0], rf: [-0.12, 0.5, 1.6, 4, 10, 0], lk: [0, 0] }),
    // the cleave falls with the body
    K(0.62, S, { hip: [0.0, 0.1, 1.46], pel: [374, 26, 0], sp: [10, -6, 0], ch: [10, -6, 0], nk: [-6, -4, 0], hd: [-8, -4, 0],
      sw: sw([-0.08, 0.22, 0.46], nrm([0.05, 0.4, 0.92]), nrm([0.3, -0.88, 0.37])), lh: L_SWING,
      lf: [0.17, 0.18, 1.14, 40, -6, 0], rf: [-0.12, 0.16, 1.78, 4, 8, 0], lk: [0, 0.6] }),
    K(0.7, S, { hip: [0.0, -0.3, 1.5], pel: [384, 32, 2], sp: [12, 8, 0], ch: [6, 10, -3], nk: [-10, -12, 0], hd: [-12, -12, 0],
      sw: sw([0.28, -0.4, 0.44], nrm([0.62, -0.5, 0.6]), nrm([0.4, -0.3, -0.86])), lh: L_OPEN_BACK,
      lf: [0.19, 0, 1.12, 42, 0, 0], rf: [-0.12, 0, 1.84, 4, 0, 0], lk: [1, 1] }),
    // 亮相: low, blade out to the low left, 剑指 up behind
    K(0.8, S, { hip: [0.0, -0.34, 1.5], pel: [386, 34, 2], sp: [12, 10, 0], ch: [6, 12, -3], nk: [-10, -14, 0], hd: [-12, -14, 0],
      sw: sw([0.34, -0.5, 0.36], nrm([0.7, -0.55, 0.45]), nrm([0.4, -0.3, -0.86])), lh: L_TUCK,
      lf: [0.19, 0, 1.12, 42, 0, 0], rf: [-0.12, 0, 1.84, 4, 0, 0], lk: [1, 1] }, 'flat'),
    K(0.96, S, { hip: [0.0, -0.32, 1.5], pel: [384, 34, 2], sp: [11, 10, 0], ch: [6, 12, -3], nk: [-10, -14, 0], hd: [-12, -14, 0],
      sw: sw([0.34, -0.49, 0.36], nrm([0.7, -0.54, 0.46]), nrm([0.4, -0.3, -0.86])), lh: L_TUCK,
      lf: [0.19, 0, 1.12, 42, 0, 0], rf: [-0.12, 0, 1.84, 4, 0, 0], lk: [1, 1] }),
    K(1.2, S, { hip: [0.02, -0.085, 1.52], pel: [366, 16, -1],
      sw: sw([-0.25, -0.43, 0.13], nrm([-0.2, -0.6, 0.77]), nrm([-0.05, -0.78, -0.62])), lh: L_HANG,
      lf: [0.18, 0, 1.3, 32, 0, 0], rf: [-0.12, 0, 1.76, 2, 0, 0], lk: [1, 1] }, 'flat'),
  ],
  events: [{ t: 0.12, type: 'jump' }, { t: 0.58, type: 'whoosh', speed: 1.5, heavy: true }, { t: 0.7, type: 'impact', ground: true }],
};

// Ground the light combo and the thrust (ref: 黑神话·钟馗 gameplay): every committed cut sinks the hips well below the
// ready height and pitches the pelvis into the strike, so the blade is driven by the legs rather than the arm.
const READY_Y = STANCE.hip[1];
function grounded(clip, depth = 2.0, floor = -0.3) {
  for (const k of clip.keys) {
    if (!k.hip) continue;
    const y = k.hip[1];
    if (y > -0.086 && y < -0.084) { k.hip = [k.hip[0], READY_Y, k.hip[2]]; continue; }   // settle keys → the new ready height
    if (y >= READY_Y) continue;
    const ny = Math.max(floor, READY_Y + (y - READY_Y) * depth);
    k.hip = [k.hip[0], ny, k.hip[2]];
    if (k.pel) k.pel = [k.pel[0] + (y - ny) * 60, k.pel[1], k.pel[2]];
  }
  return clip;
}
for (const c of [attack3, thrust]) grounded(c);   // attack1/2 are authored at mocap depth already
for (const c of [attack1, attack2, attack4, thrust, heavyCharge, heavy, special, airFlurry]) resolveChestHands(c);

export const ATTACK_CLIPS = { attack1, attack2, attack3, attack4, thrust, heavyCharge, heavy, special, airFlurry, flipCleave };
export { A1_FOLLOW, A2_FOLLOW };
