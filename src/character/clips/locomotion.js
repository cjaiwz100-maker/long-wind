// Procedural locomotion: one continuous gait whose parameters are functions of speed, so idle → walk → run →
// 轻功 sprint blend without cross-fading separate cycles and the stride always matches the speed (the planted foot
// moves backward in rig space at exactly the travel speed ⇒ no sliding; the animator additionally world-locks it).
// Owner: animation (A).
//
// Per foot, the cycle phase φ ∈ [0,1) splits into stance [0, β) and swing [β, 1) (β = duty factor). Stance rolls
// heel → flat → ball (rocker pivots, see ik.footFromAnchor). Swing follows a Hermite path whose end velocities match
// the stance velocity (swing-leg retraction, no pops at lift-off/touch-down) with a heel-kick lift profile when
// running. The pelvis follows an inverted pendulum (walk: high at mid-stance) blending into a spring-mass bounce
// (run: low at mid-stance, high in flight), with pelvic rotation, list, lateral sway and counter-rotating shoulders.
import * as THREE from 'three';
import { D2R, quatFromDeg } from '../ik.js';
import { poseFromChannels } from './track.js';
import { IDLE, STANCE, NEUTRAL, BANDIT_STANCE, LH_SHEATH, RH_HANG, hand } from './poses.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** Piecewise-linear table lookup over speed. */
function table(speeds, vals) {
  return (s) => {
    if (s <= speeds[0]) return vals[0];
    for (let i = 1; i < speeds.length; i++) {
      if (s <= speeds[i]) { const t = (s - speeds[i - 1]) / (speeds[i] - speeds[i - 1]); return lerp(vals[i - 1], vals[i], t * t * (3 - 2 * t)); }
    }
    return vals[vals.length - 1];
  };
}

// speed breakpoints (m/s): idle, stroll, walk (1.6), jog, run (5.2), 轻功 sprint (8.5)
const S = [0, 0.8, 1.6, 3.2, 5.2, 8.5];
export const GAIT_STYLES = {
  // Stance excursion (ground travel while a foot is planted = duty · 2 · stepLen) is kept within leg reach:
  // touchdown ≈ 0.3 m ahead of the hip, toe-off ≈ 0.5 m behind with the heel peeled up. Faster gaits therefore
  // shorten contact (duty) rather than overreach, which also gives the 轻功 sprint its long floating flight.
  hero: {
    stepLen: table(S, [0.32, 0.5, 0.7, 1.08, 1.5, 2.35]),     // one step (half cycle), metres
    duty: table(S, [0.66, 0.64, 0.61, 0.36, 0.27, 0.18]),
    s0: table(S, [0.45, 0.45, 0.45, 0.4, 0.38, 0.38]),         // stance fraction where the anchor passes under the hip
    drop: table(S, [0.0, 0.012, 0.022, 0.04, 0.055, 0.07]),    // pelvis base lowering
    bobW: table(S, [0.0, 0.014, 0.026, 0.02, 0.0, 0.0]),       // inverted-pendulum dip at double support
    bobR: table(S, [0.0, 0.0, 0.0, 0.03, 0.045, 0.05]),        // spring-mass compression at mid-stance
    lift: table(S, [0.04, 0.06, 0.085, 0.18, 0.3, 0.42]),     // swing ankle clearance
    heel: table(S, [0.0, 10, 16, 9, 3, -2]),                   // touch-down pitch (+ toes up)
    toe: table(S, [0.0, -22, -34, -40, -46, -52]),             // toe-off pitch (heel up)
    pelYaw: table(S, [0, 3, 6, 8, 9, 9]),
    pelRoll: table(S, [0, 2, 3.8, 3, 2.5, 2]),
    sway: table(S, [0, 0.012, 0.02, 0.012, 0.008, 0.006]),
    width: table(S, [0.1, 0.095, 0.088, 0.072, 0.062, 0.055]),
    toeOut: table(S, [7, 7, 7, 5, 3, 2]),
    arm: table(S, [0, 0.07, 0.14, 0.2, 0.24, 0.24]),
    elbow: table(S, [0, 0.02, 0.04, 0.09, 0.13, 0.15]),       // hand raise from elbow flexion while running (kept low: a loose swordsman's run, not a sprinter's pump)
  },
  bandit: {
    stepLen: table(S, [0.3, 0.46, 0.66, 1.02, 1.4, 1.95]),
    duty: table(S, [0.66, 0.65, 0.63, 0.38, 0.3, 0.22]),
    s0: table(S, [0.45, 0.45, 0.45, 0.4, 0.38, 0.38]),
    drop: table(S, [0.02, 0.03, 0.04, 0.055, 0.07, 0.08]),
    bobW: table(S, [0.0, 0.018, 0.032, 0.025, 0.0, 0.0]),
    bobR: table(S, [0.0, 0.0, 0.0, 0.035, 0.05, 0.055]),
    lift: table(S, [0.04, 0.05, 0.075, 0.16, 0.26, 0.32]),
    heel: table(S, [0.0, 8, 13, 7, 2, 0]),
    toe: table(S, [0.0, -18, -28, -34, -40, -44]),
    pelYaw: table(S, [0, 4, 8, 10, 11, 11]),
    pelRoll: table(S, [0, 3, 5, 4, 3, 3]),
    sway: table(S, [0, 0.018, 0.028, 0.016, 0.01, 0.008]),
    width: table(S, [0.12, 0.115, 0.11, 0.09, 0.08, 0.075]),
    toeOut: table(S, [12, 12, 11, 8, 6, 5]),
    arm: table(S, [0, 0.08, 0.16, 0.25, 0.3, 0.3]),
    elbow: table(S, [0, 0.02, 0.05, 0.14, 0.2, 0.2]),
  },
};

// combat footwork: short gliding steps that keep the staggered stance
const COMBAT = {
  stepLen: table([0, 1, 2, 3.5], [0.25, 0.36, 0.5, 0.8]),
  duty: table([0, 1, 2, 3.5], [0.7, 0.68, 0.62, 0.5]),
  lift: table([0, 1, 2, 3.5], [0.03, 0.05, 0.07, 0.12]),
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class Gait {
  constructor(solver, { style = 'hero' } = {}) {
    this.solver = solver;
    this.style = GAIT_STYLES[style] ?? GAIT_STYLES.hero;
    this.styleName = style;
    // base poses (idle relaxed, combat stance) compiled once
    const stance = style === 'bandit' ? BANDIT_STANCE : STANCE;
    this.base = {
      idle: poseFromChannels(IDLE),
      idleUnarmed: poseFromChannels({ ...IDLE, lh: LH_SHEATH, rh: RH_HANG }),
      stance: poseFromChannels(stance),
      bandit: poseFromChannels({ ...NEUTRAL, hip: [0, -0.03, 0], pel: [3, 0, 0], sp: [4, 0, 0], ch: [3, 0, 0], nk: [-2, 0, 0], hd: [-4, 0, 0], lf: [0.12, 0, 0, 12, 0, 0], rf: [-0.12, 0, 0, -12, 0, 0] }),
    };
    this.stanceChannels = stance;
    this.phase = 0;             // cycle phase (left heel strike at 0)
    this.speed = 0;             // smoothed speed
    this.dir = new THREE.Vector2(0, 1); // smoothed travel direction (local x, z)
    this.w = 0;                 // gait weight (0 idle … 1 moving)
    this.combatW = 0; this.armedW = 1;
    this.moving = false;
    this.events = [];
    this.lastStepFoot = null;
  }

  /** Advance the cycle. Returns step events via this.events. */
  update(dt, loco, armed) {
    this.events.length = 0;
    const target = Math.max(0, loco.speed || 0);
    // speed reacts fast but not instantly (weight transfer), direction turns smoothly
    this.speed += (target - this.speed) * (1 - Math.exp(-dt * (target > this.speed ? 7 : 9)));
    if (target > 0.05) {
      // turn the travel direction by angle (a lerp of unit vectors can never reverse: forward → back would stick);
      // a full reversal swings through the left side, so the feet pass through a strafe instead of popping
      const cur = Math.atan2(this.dir.x, this.dir.y), want = Math.atan2(loco.dirX ?? 0, loco.dirZ ?? 1);
      let d = want - cur;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > 3.1) d = Math.PI * 0.999;
      // slow speeds re-orient almost instantly (a planted stance can face any way), fast gaits carve the turn
      const rate = this.speed < 0.6 ? 30 : 13;
      const a = cur + d * (1 - Math.exp(-dt * rate));
      this.dir.set(Math.sin(a), Math.cos(a));
    }
    this.combatW += ((loco.combat ? 1 : 0) - this.combatW) * (1 - Math.exp(-dt * 6));
    this.armedW += ((armed ? 1 : 0) - this.armedW) * (1 - Math.exp(-dt * 8));

    const p = this._params();
    const cyc = 2 * p.stepLen / Math.max(this.speed, 0.05); // seconds per full cycle
    const wantMove = target > 0.08;
    const prev = this.phase;
    if (wantMove || this.w > 0.02) {
      if (!this.moving && wantMove) {
        // starting from rest: lift the trailing foot first (both feet are in stance at φ ≈ β−ε and β−0.5−ε)
        this.moving = true;
        this.phase = (p.duty - 0.02 + 1) % 1;
        if (this.dir.y > 0.3 && this._leftIsAhead) this.phase = (p.duty - 0.52 + 1) % 1;
      }
      if (this.moving) this.phase = (this.phase + dt / Math.max(cyc, 0.25) * (wantMove ? 1 : 1.2)) % 1;
    }
    // stopping: finish the current step, then settle in double support
    if (!wantMove && this.moving) {
      const b = p.duty;
      const lSt = this.phase < b, rSt = ((this.phase + 0.5) % 1) < b;
      if (lSt && rSt) this.moving = false;
    }
    const wT = this.moving ? sstep(0.02, 0.5, this.speed + (wantMove ? 0.25 : 0)) : 0;
    this.w += (wT - this.w) * (1 - Math.exp(-dt * (this.moving ? 8 : 5)));
    // heel strikes
    if (this.moving) {
      const wrapped = this.phase < prev;
      if (wrapped) this._step('L');
      if (prev < 0.5 && this.phase >= 0.5) this._step('R');
    }
    return this.events;
  }

  /** Deterministic preview state (filmstrips): fixed speed/direction/phase, fully blended in. */
  setPreview(speed, dirX, dirZ, phase, combat = false, armed = true) {
    this.speed = speed; this.dir.set(dirX, dirZ).normalize(); this.phase = ((phase % 1) + 1) % 1;
    this.w = speed > 0.05 ? 1 : 0; this.moving = speed > 0.05; this.combatW = combat ? 1 : 0; this.armedW = armed ? 1 : 0;
  }
  /** Cycle duration (s) at the current speed. */
  get cycle() { const p = this._params(); return 2 * p.stepLen / Math.max(this.speed, 0.05); }

  _step(foot) {
    this.events.push({ type: 'step', foot, speed: this.speed });
    this.lastStepFoot = foot;
  }

  _params() {
    const st = this.style, s = this.speed, c = this.combatW * (1 - sstep(2.6, 4.2, s));
    const P = this._p ??= {};
    P.combat = c;
    P.stepLen = lerp(st.stepLen(s), COMBAT.stepLen(s), c);
    P.duty = lerp(st.duty(s), COMBAT.duty(s), c);
    P.lift = lerp(st.lift(s), COMBAT.lift(s), c);
    P.drop = lerp(st.drop(s), 0.01, c);
    P.bobW = st.bobW(s) * (1 - 0.5 * c); P.bobR = st.bobR(s);
    P.heel = st.heel(s) * (1 - 0.6 * c); P.toe = st.toe(s) * (1 - 0.5 * c);
    P.pelYaw = st.pelYaw(s) * (1 - 0.7 * c); P.pelRoll = st.pelRoll(s) * (1 - 0.5 * c);
    P.sway = st.sway(s); P.width = st.width(s); P.toeOut = st.toeOut(s);
    P.arm = st.arm(s) * (1 - c); P.elbow = st.elbow(s) * (1 - c);
    P.runW = sstep(2.3, 3.6, s);
    P.s0 = st.s0(s);
    return P;
  }

  /**
   * Write the locomotion pose into `pose` (rig space, unscaled). `lean` adds are done by the animator.
   * Returns pose.
   */
  evaluate(pose) {
    const p = this._params();
    const armed = this.armedW, combat = this.combatW;
    // ---- base: relaxed idle ↔ combat stance, armed ↔ unarmed ----
    pose.copy(this.styleName === 'bandit' && combat < 0.5 ? this.base.bandit : this.base.idle);
    if (armed < 0.999) pose.blend(this.base.idleUnarmed, 1 - armed);
    if (combat > 0.001) pose.blend(this.base.stance, combat);
    const w = this.w;
    if (w < 1e-3) { pose.lock[0] = pose.lock[1] = 1; return pose; }

    const s = this.speed, dx = this.dir.x, dz = this.dir.y;
    const beta = p.duty, S2 = 2 * p.stepLen, excursion = beta * S2;
    const phi = this.phase;
    const fwd = dz; // travel component along the character's forward
    // ---- pelvis ----
    const msL = beta * p.s0;                     // left mid-stance phase
    const c2 = Math.cos(4 * Math.PI * (phi - msL));
    const yW = -p.bobW * (1 - c2) * 0.5;          // walk: dip at double support
    const yR = -p.bobR * (1 + c2) * 0.5;          // run: compress at mid-stance
    const bob = lerp(yW, yR, p.runW);
    const c1 = Math.cos(TAU * (phi - msL));
    pose.hips.x = lerp(pose.hips.x, pose.hips.x + p.sway * c1, w);
    pose.hips.y = lerp(pose.hips.y, pose.hips.y - p.drop + bob, w);
    // pelvis yaw follows the forward-swinging leg; list drops the swing side; shoulders counter-rotate
    const yawOsc = -p.pelYaw * Math.cos(TAU * phi) * Math.sign(fwd || 1) * (0.35 + 0.65 * Math.abs(fwd));
    const roll = p.pelRoll * c1;
    // strafing: the pelvis opens toward the travel direction, the chest keeps facing forward
    const strafeYaw = clamp(Math.atan2(dx, Math.abs(dz) + 0.35) / D2R * 0.45, -35, 35) * (1 - 0.6 * combat) * (fwd < -0.2 ? -1 : 1);
    _q.setFromAxisAngle(UP, (yawOsc + strafeYaw) * D2R * w);
    _q2.setFromAxisAngle(_v.set(0, 0, 1), roll * D2R * w);
    pose.q.hips.premultiply(_q).multiply(_q2);
    // counter-rotation up the spine (net shoulders ≈ −0.35× pelvis), head stabilised forward
    _q.setFromAxisAngle(UP, -(yawOsc * 0.55 + strafeYaw * 0.5) * D2R * w);
    pose.q.spine.premultiply(_q);
    _q.setFromAxisAngle(UP, -(yawOsc * 0.8 + strafeYaw * 0.5) * D2R * w);
    pose.q.chest.premultiply(_q);
    _q2.setFromAxisAngle(_v.set(0, 0, 1), -roll * 0.9 * D2R * w);
    pose.q.chest.multiply(_q2);
    _q.setFromAxisAngle(UP, (yawOsc * 0.35) * D2R * w);
    pose.q.head.premultiply(_q);

    // ---- feet ----
    const toeOut = p.toeOut;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const ph = (phi + (i === 0 ? 0 : 0.5)) % 1;
      // stance anchor (flat foot ground point) relative to the root: base stance offset + travel excursion
      const bx = pose.foot[i].x, bz = pose.foot[i].z;
      // idle/stance width blends toward the gait width, and a lateral stagger keeps strafing feet from colliding
      const baseX = lerp(bx, side * p.width, (1 - combat) * w);
      const stagger = (1 - Math.abs(dz)) * 0.09 * side * Math.sign(dx || 1) * (1 - combat);
      const baseZ = lerp(bz * (1 - 0.35 * combat * w), bz * 0.3 + stagger, (1 - combat) * w);
      const footYaw0 = Math.atan2(_v.set(0, 0, 1).applyQuaternion(pose.footQ[i]).x, _v.z) / D2R;
      const yawBase = lerp(footYaw0, side * toeOut, (1 - combat) * w);
      // rocker direction depends on how the foot's forward aligns with the travel direction
      const fy = yawBase * D2R, ffx = Math.sin(fy), ffz = Math.cos(fy);
      const cAlign = ffx * dx + ffz * dz;
      let pitch, lock, ax, az, ay = 0;
      if (ph < beta) {
        // stance: anchor fixed in the world ⇒ moves backward at travel speed in rig space
        const u = ph / beta;
        const e = excursion * (p.s0 - u);
        ax = baseX + dx * e; az = baseZ + dz * e;
        const hsEnd = lerp(0.14, 0.06, p.runW), hoStart = lerp(0.5, 0.36, p.runW);
        if (cAlign >= 0) {
          if (u < hsEnd) pitch = p.heel * (1 - sstep(0, hsEnd, u));
          else if (u > hoStart) pitch = p.toe * sstep(hoStart, 1, u) ** 1.2;
          else pitch = 0;
          pitch *= cAlign;
        } else {
          // walking backward: land on the ball, peel off the heel last
          if (u < 0.2) pitch = -14 * (1 - sstep(0, 0.2, u));
          else if (u > 0.65) pitch = 10 * sstep(0.65, 1, u);
          else pitch = 0;
          pitch *= -cAlign;
        }
        // lock ramps: full plant through stance, released just before lift-off
        lock = 1 - sstep(0.9, 1, u);
      } else {
        // swing: Hermite path lift-off → touch-down, end velocities match the stance (no pop, leg retraction)
        const u = (ph - beta) / (1 - beta);
        const x0 = excursion * (p.s0 - 1), x1 = excursion * p.s0;
        const m = -(1 - beta) / beta * 0.55; // normalised end slope
        const u2 = u * u, u3 = u2 * u;
        let hh = (-2 * u3 + 3 * u2) + (u3 - 2 * u2 + u) * m + (u3 - u2) * m;
        // running: the foot trails behind while the heel kicks up, then whips through
        hh = lerp(hh, hh * hh * (1.6 - 0.6 * hh) , p.runW * 0.5);
        const e = x0 + (x1 - x0) * hh;
        ax = baseX + dx * e; az = baseZ + dz * e;
        const peak = lerp(0.5, 0.33, p.runW);
        const g = Math.log(0.5) / Math.log(peak);
        const lp = Math.pow(Math.sin(Math.PI * Math.pow(u, g)), 1.3);
        ay = p.lift * lp;
        // foot pitch: toe-off → toes up for clearance → touch-down attitude
        const midPitch = lerp(8, -18, p.runW);
        const a0 = cAlign >= 0 ? p.toe * cAlign : 10 * -cAlign;
        const a1 = cAlign >= 0 ? p.heel * cAlign : -14 * -cAlign;
        pitch = u < 0.5 ? lerp(a0, midPitch * Math.abs(cAlign), sstep(0, 0.5, u)) : lerp(midPitch * Math.abs(cAlign), a1, sstep(0.5, 1, u));
        lock = 0;
        // the swing foot passes inside, close to the stance leg, then lands on its line
        ax -= side * 0.02 * Math.sin(Math.PI * u);
      }
      // blend with the idle/stance foot by the gait weight
      pose.foot[i].set(lerp(pose.foot[i].x, ax, w), lerp(pose.foot[i].y, ay, w), lerp(pose.foot[i].z, az, w));
      pose.pitch[i] = lerp(pose.pitch[i], pitch * D2R, w);
      pose.lock[i] = lerp(1, lock, w);
      quatFromDeg(0, lerp(footYaw0, yawBase, w), 0, pose.footQ[i]);
      // toes stay on the ground while the heel peels off
      const tp = Math.min(0, pose.pitch[i]) / D2R;
      quatFromDeg(clamp(-tp * 0.9, 0, 45), 0, 0, pose.q[i === 0 ? 'toes.L' : 'toes.R']);
    }

    // ---- arms ----
    this._arms(pose, p, w, phi);
    return pose;
  }

  get _leftIsAhead() { return false; }

  /** Arm swing in chest space: pendulum arcs opposite to the legs, bent elbows when running. */
  _arms(pose, p, w, phi) {
    const solver = this.solver;
    const combat = p.combat;
    // combat footwork keeps the free arm alive too (a loose pendulum, never parked): the left arm keeps ~40% of its
    // swing while stepping in the stance; the sword arm stays on the stance line
    // combat footwork: the stance hands are authored for the stance torso; as the stepping body sinks and bobs, carry
    // them with the chest so the arms keep hanging long instead of folding into elbows-out 叉腰
    if (combat > 1e-3 && w > 1e-3) {
      if (!this._stChest) { solver.torso(this.base.stance); this._stChest = solver.P.chest.clone().divideScalar(solver.s); }
      solver.torso(pose);
      _v.copy(solver.P.chest).divideScalar(solver.s).sub(this._stChest).multiplyScalar(combat);
      pose.hand[0].add(_v); pose.hand[1].add(_v);
    }
    const kL = w * (1 - 0.6 * combat);
    if (kL < 1e-3) return;
    solver.torso(pose);
    const qc = solver.Q.chest, pc = solver.P.chest, s = solver.s;
    const sw1 = Math.cos(TAU * phi); // +1: left leg forward
    const armed = this.armedW;
    const k = w * (1 - combat);
    const runW = p.runW;
    // left arm: a pendulum from the shoulder (opposite to the left leg). The upper arm hangs and swings about the
    // shoulder, the forearm adds a little flexion with pace; the palm faces the thigh. Nothing is placed in space, so
    // the hand can never end up behind the hip or on the lower back.
    {
      const a = -p.arm * sw1;                                   // forward excursion
      pendulumArm(_v, _q2, +1, a, p.elbow);
      const target = _v.applyQuaternion(qc).addScaledVector(pc, 1 / s);
      pose.hand[0].lerp(target, kL);
      pose.handQ[0].slerp(_q2.premultiply(qc), kL);
    }
    // right arm: sword carried low when walking, trailed back when running; unarmed swings freely
    {
      const a = p.arm * sw1 * lerp(0.5, 0.35, runW) * armed + p.arm * sw1 * (1 - armed);
      pendulumArm(_v, _q2, -1, a, p.elbow * (1 - 0.4 * armed));
      if (armed < 0.99) pose.handQ[1].slerp(_q2.premultiply(qc), k * (1 - armed));
      const target = _v.applyQuaternion(qc).addScaledVector(pc, 1 / s);
      pose.hand[1].lerp(target, k);
      if (armed > 0.01) {
        // blade: walk = down-forward carry; run/sprint = trailing back-down, flat to the wind
        // (ref 黑神话·钟馗) always a forward grip: the tip hangs down-forward from a loose fist and levels out a little
        // as the pace rises. Never trailed backwards — with the knuckles forward that reads as a reverse grip.
        const dW = _v.set(-0.12, -0.72, 0.68).lerp(_v2.set(-0.16, -0.46, 0.87), runW).normalize();
        dW.applyQuaternion(qc);
        const eW = _v2.set(0.0, -0.68, -0.73).lerp(_v2.clone().set(0.0, -0.87, -0.49), runW).normalize().applyQuaternion(qc);
        // weapon frame → hand frame is done by the solver-side convention in the pose (handQ is the hand frame)
        weaponToHand(dW, eW, _q);
        pose.handQ[1].slerp(_q, k * armed);
      }
    }
  }
}

// Free-arm pendulum in chest space (+X left, shoulder line ≈ +0.15 above the chest origin). side +1 = left, −1 = right.
// swing: forward excursion (the back-swing is damped); flex: elbow flexion that grows with pace. Writes the grip
// target (chest space) and the hand frame (chest space: knuckles along the forearm, palm facing the thigh).
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3(), _pm = new THREE.Matrix4();
function pendulumArm(outP, outQ, side, swing, flex) {
  const th = (swing > 0 ? swing : swing * 0.6) * 1.5;          // shoulder swing (rad)
  const fl = 0.12 + flex * 2.4;                                 // elbow flexion (rad): a relaxed arm is never locked
  const up = _pa.set(0.07 * side, -Math.cos(th), Math.sin(th)).normalize();
  const fore = _pb.set(0.03 * side, -Math.cos(th + fl), Math.sin(th + fl)).normalize();
  outP.set(0.19 * side, 0.15, 0).addScaledVector(up, 0.29).addScaledVector(fore, 0.3);
  // hand frame: X = knuckles·sgn (sgn +1 L / −1 R), Y = −palm normal; palm faces the thigh (normal −X·side)
  const x = _pc.copy(fore).multiplyScalar(side);
  const y = _pa.set(side, 0, 0);                                // −n where n = (−side, 0, 0)
  y.addScaledVector(x, -y.dot(x)).normalize();
  const z = _pb.crossVectors(x, y).normalize();
  _pm.makeBasis(x, y, z);
  return outQ.setFromRotationMatrix(_pm);
}

// weapon frame (Z blade, Y edge) → hand frame
import { quatLook, GRIP_R_INV } from '../ik.js';
function weaponToHand(d, e, out) {
  quatLook(d, e, out);
  return out.multiply(GRIP_R_INV);
}
