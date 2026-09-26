// Third-person combat camera (bible §7.5, derived from the reference `kf` rig). Owner: gameplay (P).
//
// Orbit (heading/pitch/distance) around a low chest pivot (1.45 m) with a shoulder offset, smoothed on REAL dt so
// hit-stop and slow-mo never freeze the camera. Composition: the view is tilted slightly up from the orbit so the
// horizon sits on the lower third and the sky/sun glow fills 55–65 % of the frame; the default heading looks into
// the sun (contre-jour). Lock-on frames player + target (weights 0.6/0.4). Analytic collision against the terrain
// and static colliders (pull in fast, release slowly). Trauma shake, FOV kicks/punches, micro-zoom, and scripted
// modes blended by decaying offsets: 'follow' | 'title' | 'intro' | 'kill' | 'victory' | 'defeat'.
//
//   const cam = new CombatCamera(app, { heightAt, colliders })
//   cam.update(rawDt, { player, lock, input, sprinting, idleCine })
//   cam.shake(k)  cam.kickFov(deg)  cam.punchFov(deg)  cam.microZoom(k, s)  cam.setMode(name, opts)  cam.snap()
//   cam.heading   (orbit heading: the direction the camera looks, yaw convention of the game)
import * as THREE from 'three';
import { SUN_DIR } from '../core/globals.js';
import { clamp, damp, dampAngle, expK, wrapAngle, yawOf, lerp } from './util.js';

const UP = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3(), _r = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();
const _m = new THREE.Matrix4(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _qt = new THREE.Quaternion();

export const CAM = {
  fov: 48,
  pivotH: 1.45,          // chest pivot height
  shoulder: 0.35,        // pivot offset to the right (swapped when the lock target is on the right)
  dist: 4.4, distMin: 2.8, distMax: 7, lockDist: 5.4,
  pitch: 0.08, pitchMin: -0.35, pitchMax: 0.9,
  compose: 0.068,        // view tilt up (rad) at the default pitch: horizon on the lower third, sky ≈ 58 % of the frame
  lockOffset: 0.3,       // lock-on: heading offset (rad) that puts the target beside the hero, not behind him
  follow: 9,             // pivot position smoothing rate
  aimRate: 14,           // lock-on aim smoothing rate
  mouseRate: 22, autoRate: 4, lockRate: 6,
  groundClear: 0.6,
};

export class CombatCamera {
  constructor(app, { heightAt, colliders } = {}) {
    this.app = app;
    this.cam = app.camera;
    this.heightAt = heightAt ?? ((x, z) => app.world.heightAt(x, z));
    this.colliders = colliders ?? app.world.colliders ?? [];
    this.sunHeading = Math.atan2(SUN_DIR.x, SUN_DIR.z);
    this.yaw = this.yawT = this.sunHeading;
    this.pitch = this.pitchT = CAM.pitch;
    this.dist = this.distT = this.userDist = CAM.dist;
    this.collDist = CAM.dist;
    this.rate = CAM.autoRate;
    this.side = 1;
    this.pivot = new THREE.Vector3();
    this.lead = new THREE.Vector3();
    this.aimS = new THREE.Vector3();          // smoothed lock aim
    this.desPos = new THREE.Vector3(); this.desAim = new THREE.Vector3();
    this.finalPos = new THREE.Vector3(); this.finalAim = new THREE.Vector3();
    this.blendPos = new THREE.Vector3(); this.blendAim = new THREE.Vector3(); this.blendRate = 2.2;
    this.mode = 'follow'; this.modeT = 0; this.modeOpts = {};
    this._rebase = false;
    this.bump = 0; this.fovSprint = 0; this.fovKickV = 0; this.fovPunchV = 0; this.zoomAmt = 0; this.zoomDur = 0.25; this.zoomT = 9;
    this.clock = 0;
    this.first = true;
    this.fovNow = CAM.fov;
    this.lockSmooth = 0;
    this.lockSide = 0;
    this.avoid = 0;
  }

  get heading() { return this.yaw; }

  snap() { this.first = true; }
  shake(k) { this.bump = Math.min(1.2, this.bump + k); }
  /** Directional hit kick: the lens is shoved along the blow (world dir) and springs back. */
  kickDir(dir, k = 1) {
    this.kickV ??= new THREE.Vector3(); this.kickP ??= new THREE.Vector3();
    this.kickV.x += dir.x * 1.6 * k; this.kickV.y += (dir.y ?? 0) * 1.6 * k - 0.35 * k; this.kickV.z += dir.z * 1.6 * k;
  }
  kickFov(deg) { this.fovKickV = Math.max(this.fovKickV, deg); }
  punchFov(deg) { this.fovPunchV = Math.min(this.fovPunchV, -Math.abs(deg)); }
  microZoom(k = 0.03, seconds = 0.25) { this.zoomAmt = k; this.zoomDur = seconds; this.zoomT = 0; }

  /** Switch to a scripted mode; the transition glides via decaying offsets (no pops). */
  setMode(mode, opts = {}) {
    if (mode === this.mode && !opts.force) { Object.assign(this.modeOpts, opts); return; }
    this.mode = mode; this.modeT = 0; this.modeOpts = opts;
    this.blendRate = opts.blend ?? 2.2;
    this._rebase = !this.first;
    if (mode === 'follow' && opts.heading !== undefined) { this.yaw = this.yawT = opts.heading; }
  }

  /** Heading for the orbit that looks along `h` — used when handing back to follow after a cinematic. */
  _followFromFinal() {
    _d.copy(this.finalAim).sub(this.finalPos);
    this.yaw = this.yawT = yawOf(_d.x, _d.z);
  }

  update(rawDt, ctx) {
    const dt = Math.min(rawDt, 0.1);
    this.clock += dt; this.modeT += dt;
    const { player, lock, input } = ctx;
    if (!player) return;
    const pp = player.pos;

    // -------- mode → desired position + aim --------
    if (this.mode === 'follow') this._follow(dt, ctx);
    else this._cinematic(dt, ctx);
    if (this.orbit) this._orbit(dt, pp);

    // -------- collision (analytic): static colliders pull in, terrain pushes up --------
    this._collide(dt, pp);

    // -------- blending between modes --------
    if (this.first) {
      this.blendPos.set(0, 0, 0); this.blendAim.set(0, 0, 0); this.first = false; this._rebase = false;
    } else if (this._rebase) {
      this.blendPos.copy(this.finalPos).sub(this.desPos);
      this.blendAim.copy(this.finalAim).sub(this.desAim);
      this._rebase = false;
    }
    const kb = Math.exp(-this.blendRate * dt);
    this.blendPos.multiplyScalar(kb); this.blendAim.multiplyScalar(kb);
    this.finalPos.copy(this.desPos).add(this.blendPos);
    this.finalAim.copy(this.desAim).add(this.blendAim);
    // never let a blend dip the camera into the ground
    const gy = this.heightAt(this.finalPos.x, this.finalPos.z) + 0.35;
    if (this.finalPos.y < gy) this.finalPos.y = gy;

    // -------- shake (trauma: decaying sinusoids, ≤ 0.6° yaw/roll, ≤ 4 cm) --------
    const s = Math.min(this.bump, 1), t = this.clock;
    this.bump = Math.max(0, this.bump * Math.exp(-2.5 * dt) - 0.05 * dt);
    const cam = this.cam;
    cam.position.copy(this.finalPos);
    if (s > 1e-4) {
      cam.position.x += s * 0.06 * Math.sin(21 * t);
      cam.position.y += s * 0.05 * Math.sin(27 * t + 1.1);
      cam.position.z += s * 0.06 * Math.sin(18 * t + 2.3);
    }
    if (this.kickV) {
      // spring (ω 26, ζ 0.5): a few cm along the blow, one small overshoot
      const w = 26, k = Math.min(dt, 1 / 30);
      this.kickV.addScaledVector(this.kickP, -w * w * k).multiplyScalar(Math.max(0, 1 - w * k));
      this.kickP.addScaledVector(this.kickV, k);
      cam.position.add(this.kickP);
      this.finalAim.addScaledVector(this.kickP, 0.5);
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(this.finalAim);
    if (s > 1e-4) {
      const D = Math.PI / 180;
      _e.set(s * 1.0 * D * (Math.sin(19 * t + 0.7) * 0.6 + Math.sin(29 * t) * 0.4),
        s * 1.0 * D * (Math.sin(23 * t) * 0.6 + Math.sin(17 * t + 1.3) * 0.4),
        s * 1.0 * D * Math.sin(13 * t + 2.0));
      cam.quaternion.multiply(_qt.setFromEuler(_e));
    }

    // -------- FOV: sprint kick, dodge kick, heavy punch, parry micro-zoom --------
    this.fovSprint = damp(this.fovSprint, ctx.sprinting ? 4 : 0, 6, dt);
    this.fovKickV *= Math.exp(-4.5 * dt);
    this.fovPunchV *= Math.exp(-7 * dt);
    this.zoomT += dt;
    const zu = this.zoomT / this.zoomDur;
    const zoom = zu < 1 ? this.zoomAmt * Math.sin(Math.PI * Math.min(1, zu * 1.6)) ** 0.7 * (1 - zu * 0.3) : 0;
    let fov = (this.modeOpts.fov ?? CAM.fov) + this.fovSprint + this.fovKickV + this.fovPunchV;
    fov *= 1 - zoom;
    if (Math.abs(fov - cam.fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this.fovNow = fov;
    cam.updateMatrixWorld();
  }

  /**
   * Record mode: 'orbit' (O) a slow, low orbit around the hero; 'crane' (V) rises and pulls back into a wide vista
   * while circling (?crane=r,h sets the end radius / height, default 24,10). Overrides the desired shot; the blend
   * eases it in and out.
   */
  toggleOrbit(style = 'orbit') {
    this.orbit = this.orbit === style ? null : style;
    if (this.orbit) { this.orbitYaw = this.heading + Math.PI; this.orbitT = 0; }   // start from where the follow camera stands
    this._rebase = true;
  }
  _orbit(dt, pp) {
    this.orbitT += dt;
    if (this.orbit === 'crane') {
      const [R, Hc] = (this.app.params?.get('crane') ?? '24,10').split(',').map(Number);
      const u = Math.min(this.orbitT / 9, 1), e = u * u * (3 - 2 * u);
      this.orbitYaw += dt * 0.09;
      const r = lerp(4.5, R, e), h = lerp(1.1, Hc, e);
      this.desPos.set(pp.x + Math.sin(this.orbitYaw) * r, pp.y + h, pp.z + Math.cos(this.orbitYaw) * r);
      // the aim slides from the hero out to the horizon beyond him: the land opens up as the camera rises
      _q.set(pp.x - this.desPos.x, 0, pp.z - this.desPos.z).normalize();
      _p.set(pp.x + _q.x * 40, pp.y + 1.5, pp.z + _q.z * 40);
      this.desAim.set(pp.x, pp.y + 1.2, pp.z).lerp(_p, e * 0.85);
      return;
    }
    this.orbitYaw += dt * 0.16;
    const r = 5.2 + Math.sin(this.clock * 0.21) * 1.2, h = 0.9 + Math.sin(this.clock * 0.13) * 0.45;
    this.desPos.set(pp.x + Math.sin(this.orbitYaw) * r, pp.y + h, pp.z + Math.cos(this.orbitYaw) * r);
    this.desAim.set(pp.x, pp.y + 1.25, pp.z);
  }

  // ------------------------------------------------------------------------------------------------------------
  _follow(dt, ctx) {
    const { player, lock, input } = ctx;
    const pp = player.pos;
    let manual = false;
    if (input) {
      const lx = input.look.x, ly = input.look.y;
      if (lx || ly) {
        manual = true;
        if (!lock) this.yawT -= lx;
        this.pitchT = clamp(this.pitchT + ly, CAM.pitchMin, CAM.pitchMax);
      }
      if (input.zoom) this.userDist = clamp(this.userDist * Math.pow(1.12, input.zoom), CAM.distMin, CAM.distMax);
    }
    this.lockSmooth = damp(this.lockSmooth, lock ? 1 : 0, 5, dt);
    let rate = manual ? CAM.mouseRate : CAM.autoRate;
    if (lock) {
      // heading from the player to the target, turned so the target stands beside the player (two-shot) instead
      // of hiding behind him. The target keeps the screen side it is on (hysteresis), so the camera never whips.
      const h = yawOf(lock.pos.x - pp.x, lock.pos.z - pp.z);
      const d = Math.hypot(lock.pos.x - pp.x, lock.pos.z - pp.z);
      const rel = wrapAngle(h - this.yaw);                 // > 0: target left of the view centre
      // on acquire, take the side whose framing looks more into the sun (contre-jour two-shot)
      if (!this.lockSide) this.lockSide = wrapAngle(h - this.sunHeading) >= 0 ? 1 : -1;
      else if (rel * this.lockSide < -0.12) this.lockSide = -this.lockSide;
      this.side = damp(this.side, -this.lockSide, 3, dt);   // shoulder opposite the target
      this.yawT = h - CAM.lockOffset * this.lockSide * clamp(3.2 / Math.max(d, 1.5), 0.5, 1.4);
      this.distT = clamp(CAM.lockDist + Math.max(0, d - 4) * 0.35, CAM.lockDist, 7.5);
      if (!manual) this.pitchT = damp(this.pitchT, 0.1, 2, dt);
      rate = CAM.lockRate;
    } else {
      this.lockSide = 0;
      this.side = damp(this.side, 1, 3, dt);
      this.distT = this.userDist;
      const sp = Math.hypot(player.vel.x, player.vel.z);
      // auto-recenter behind the heading after 1.5 s without look input while running
      if (input && input.lookIdle > 1.5 && sp > 1.5) {
        this.yawT = dampAngle(this.yawT, yawOf(player.vel.x, player.vel.z), 1.5, dt);
      }
      // sun-seeking cinematographer when idle and alone (bible §7.5)
      if (ctx.idleCine) {
        const cine = this.sunHeading + 0.55 * Math.sin(0.045 * this.clock) + 0.25 * Math.sin(0.017 * this.clock + 1.3);
        this.yawT = dampAngle(this.yawT, cine, 0.35, dt);
        this.pitchT = damp(this.pitchT, 0.04 + 0.03 * Math.sin(0.03 * this.clock), 0.35, dt);
      }
    }
    this.rate = damp(this.rate, rate, 10, dt);
    this.yaw = dampAngle(this.yaw, this.yawT, this.rate, dt);
    this.yawT = this.yaw + wrapAngle(this.yawT - this.yaw); // keep the target unwrapped near the current heading
    this.pitch = damp(this.pitch, this.pitchT, this.rate, dt);
    this.dist = damp(this.dist, this.distT, 4, dt);

    // enemies standing between the lens and the hero push the orbit sideways (they never fill the frame)
    this._avoidActors(dt, ctx);
    // pivot: chest + shoulder offset + a lead in the movement direction
    const h = this.yaw + this.avoid;
    _d.set(Math.sin(h), 0, Math.cos(h));
    _r.set(-Math.cos(h), 0, Math.sin(h));
    const sp = Math.hypot(player.vel.x, player.vel.z);
    _p.set(player.vel.x, 0, player.vel.z);
    if (sp > 0.1) _p.multiplyScalar(clamp(sp / 5.2, 0, 1) * 1.1 / sp); else _p.set(0, 0, 0);
    if (lock) _p.multiplyScalar(0.3);
    this.lead.lerp(_p, expK(3, dt));
    _q.set(pp.x, pp.y + player.hop * 0.6 + CAM.pivotH, pp.z).addScaledVector(_r, CAM.shoulder * this.side).add(this.lead);
    if (this.first) this.pivot.copy(_q); else this.pivot.lerp(_q, expK(CAM.follow, dt));

    const dist = Math.min(this.dist, this.collDist);
    const cp = Math.cos(this.pitch), sp2 = Math.sin(this.pitch);
    this.desPos.copy(this.pivot).addScaledVector(_d, -dist * cp).addScaledVector(UP, dist * sp2);

    // free view: orbit heading, tilted up so the horizon sits on the lower third at the default pitch; pitching
    // the orbit down (mouse) tilts the view down proportionally
    const vp = CAM.compose - (this.pitch - CAM.pitch) * 0.85;
    _q.set(Math.sin(h) * Math.cos(vp), Math.sin(vp), Math.cos(h) * Math.cos(vp));
    const freeAim = _p.copy(this.desPos).addScaledVector(_q, 12);
    if (this.lockSmooth > 0.01 && lock) {
      // lock-on: aim at the player/target midpoint (0.6 / 0.4) at chest height, lifted for composition
      const tx = pp.x * 0.6 + lock.pos.x * 0.4, tz = pp.z * 0.6 + lock.pos.z * 0.4;
      const ty = (pp.y + CAM.pivotH) * 0.6 + (lock.pos.y + 1.35) * 0.4;
      _q.set(tx, ty, tz);
      const dd = _q.distanceTo(this.desPos);
      _q.y += dd * Math.tan(CAM.compose);
      if (this.first || this.aimS.lengthSq() === 0) this.aimS.copy(_q); else this.aimS.lerp(_q, expK(CAM.aimRate, dt));
      // aim point projected to 12 m so it blends with the free aim
      _q.copy(this.aimS).sub(this.desPos).normalize().multiplyScalar(12).add(this.desPos);
      this.desAim.copy(freeAim).lerp(_q, this.lockSmooth);
    } else {
      this.aimS.copy(freeAim);
      this.desAim.copy(freeAim);
    }
  }

  _cinematic(dt, ctx) {
    const { player } = ctx;
    const o = this.modeOpts;
    const pp = player.pos;
    const t = this.clock;
    const ground = (x, z) => this.heightAt(x, z);
    if (this.mode === 'title') {
      // low, slow, into the sun; the hero on the left third with the sky filling the frame
      const h = this.sunHeading + 0.06 * Math.sin(0.05 * t) + 0.03;
      const dist = 5.6 + 0.6 * Math.sin(0.07 * t + 1);
      _d.set(Math.sin(h), 0, Math.cos(h));
      this.desPos.set(pp.x, 0, pp.z).addScaledVector(_d, -dist);
      this.desPos.y = Math.max(ground(this.desPos.x, this.desPos.z) + 1.05, pp.y + 1.0);
      const vh = h - 0.27; // turn the view right: the hero (haloed by the low sun) sits on the left third, the title on the right
      const vp = 0.12;
      this.desAim.copy(this.desPos).add(_q.set(Math.sin(vh) * Math.cos(vp), Math.sin(vp), Math.cos(vh) * Math.cos(vp)).multiplyScalar(12));
    } else if (this.mode === 'intro') {
      // wave intro (bible §7.5): a low wide shot just above the grass tips from behind the hero's shoulder, looking
      // into the sun at the bandits cresting the swell in silhouette, then a slow push-in onto the hero.
      // The hero holds the left third; the pack sits right of centre against the glow.
      const focus = o.focus ?? pp;
      const dur = o.duration ?? 3.2;
      const h = yawOf(focus.x - pp.x, focus.z - pp.z);
      const u = clamp(this.modeT / dur, 0, 1);
      const e = u * u * (3 - 2 * u);
      _d.set(Math.sin(h), 0, Math.cos(h)); _r.set(-Math.cos(h), 0, Math.sin(h));
      const back = lerp(5.8, 3.1, e), side = lerp(2.3, 1.0, e);
      this.desPos.set(pp.x, 0, pp.z).addScaledVector(_d, -back).addScaledVector(_r, side);
      this.desPos.y = Math.max(ground(this.desPos.x, this.desPos.z) + lerp(1.3, 1.55, e), pp.y + 0.9);
      // aim between the pack and the hero's line of sight, lifted so the horizon sits on the lower third
      this.desAim.set(focus.x, 0, focus.z).addScaledVector(_r, -lerp(3.5, 1.5, e));
      const far = this.desAim.distanceTo(_p.set(this.desPos.x, 0, this.desPos.z));
      this.desAim.y = Math.max(focus.y, pp.y) + 1.1 + far * Math.tan(0.075);
      if (this.modeT > dur) { this._followFromFinal(); this.setMode('follow', { blend: 1.6 }); this._follow(dt, ctx); }
    } else if (this.mode === 'kill' || this.mode === 'victory') {
      // three-quarter profile of the two fighters AGAINST the sun (bible: orbit ~70° to a side profile), slowly
      // orbiting at chest height with the view lifted so the glow fills the upper frame
      const other = o.victim ?? pp;
      const mx = (pp.x + other.x) * 0.5, mz = (pp.z + other.z) * 0.5, my = Math.max(pp.y, other.y ?? pp.y);
      if (o.heading === undefined) {
        const line = yawOf(other.x - pp.x, other.z - pp.z);
        // allowed bearings: 55°–125° off the fighters' line on either side; take the one nearest the sun heading
        let best = 0, bestErr = Infinity;
        for (const side of [1, -1]) {
          const lo = line + side * 0.96, hi = line + side * 2.18;
          const c = (lo + hi) / 2, half = (hi - lo) / 2 * side;
          const h = c + clamp(wrapAngle(this.sunHeading - c), -Math.abs(half), Math.abs(half));
          const err = Math.abs(wrapAngle(h - this.sunHeading));
          if (err < bestErr) { bestErr = err; best = h; }
        }
        o.heading = best;
        o.spin = wrapAngle(best - this.yaw) >= 0 ? 1 : -1;   // keep orbiting the way the cut came from
      }
      const kill = this.mode === 'kill';
      const h = o.heading + (kill ? 0.09 : 0.045) * this.modeT * (o.spin ?? 1);
      const dist = kill ? lerp(5.4, 4.5, clamp(this.modeT / 2.2, 0, 1)) : lerp(6.8, 4.8, clamp(this.modeT / 6, 0, 1));
      _d.set(Math.sin(h), 0, Math.cos(h));
      this.desPos.set(mx, 0, mz).addScaledVector(_d, -dist);
      // above the grass tips (never inside the blades), a touch below the chest for a heroic angle
      this.desPos.y = Math.max(ground(this.desPos.x, this.desPos.z) + 1.4, my + 1.3);
      this.desAim.set(mx, my + 1.2, mz).addScaledVector(_d, 4);
      this.desAim.y += 4 * Math.tan(0.11);
      if (kill && this.modeT > (o.duration ?? 2.6)) { this._followFromFinal(); this.setMode('follow', { blend: 1.8 }); this._follow(dt, ctx); }
    } else if (this.mode === 'defeat') {
      const h = (o.heading ?? this.yaw) + 0.06 * this.modeT;
      const dist = lerp(4, 7, clamp(this.modeT / 5, 0, 1));
      const pitch = lerp(0.35, 0.75, clamp(this.modeT / 5, 0, 1));
      _d.set(Math.sin(h), 0, Math.cos(h));
      this.desPos.set(pp.x, pp.y + 0.6, pp.z).addScaledVector(_d, -dist * Math.cos(pitch)).addScaledVector(UP, dist * Math.sin(pitch));
      this.desAim.set(pp.x, pp.y + 0.4, pp.z);
    } else {
      this.setMode('follow');
      this._follow(dt, ctx);
    }
  }

  /** Yaw nudge away from active enemies inside the camera → pivot corridor (bible: keep the fighters readable). */
  _avoidActors(dt, ctx) {
    let push = 0;
    const list = ctx.enemies;
    if (list && this.mode === 'follow') {
      const h = this.yaw + this.avoid;
      const fx = Math.sin(h), fz = Math.cos(h), rx = -Math.cos(h), rz = Math.sin(h);
      const px = this.pivot.x, pz = this.pivot.z, L = Math.max(1, this.dist);
      for (const e of list) {
        if (!e.active || e.sink > 0.2) continue;   // fresh corpses still block the view
        // position relative to the pivot, in the camera frame: behind the pivot (toward the lens) = negative along
        const ex = e.pos.x - px, ez = e.pos.z - pz;
        const along = ex * fx + ez * fz, lat = ex * rx + ez * rz;
        if (along > 0.3 || along < -L + 0.2) continue;
        const R = e.radius + 0.55;
        if (Math.abs(lat) > R) continue;
        const w = (1 - Math.abs(lat) / R) * (0.5 + 0.5 * clamp(-along / L, 0, 1));
        push += (lat >= 0 ? -1 : 1) * w;
      }
    }
    this.avoid = damp(this.avoid, clamp(push, -1, 1) * 0.45, push ? 2.5 : 1.2, dt);
  }

  _collide(dt, pp) {
    if (this.mode !== 'follow') return;
    const P = this.pivot;
    const C = this.desPos;
    _r.copy(C); // remember the unconstrained position; the aim moves with the camera to keep the orientation
    const dx = C.x - P.x, dz = C.z - P.z;
    let maxT = 1;
    if (dx * dx + dz * dz > 1e-6) {
      for (const c of this.colliders) {
        const R = (c.r ?? 1) + 0.35;
        // segment (P → C) vs circle, in XZ
        const fx = P.x - c.x, fz = P.z - c.z;
        const a = dx * dx + dz * dz, b = 2 * (fx * dx + fz * dz), cc = fx * fx + fz * fz - R * R;
        const disc = b * b - 4 * a * cc;
        if (disc < 0) continue;
        const t0 = (-b - Math.sqrt(disc)) / (2 * a);
        if (t0 < 0 || t0 > 1) continue;
        // ignore low obstacles the camera passes over (colliders may carry a height h)
        const top = this.heightAt(c.x, c.z) + (c.h ?? (c.r ?? 1) * 1.6);
        if (P.y + (C.y - P.y) * t0 > top + 0.2) continue;
        maxT = Math.min(maxT, Math.max(0.12, t0 - 0.08));
      }
    }
    // pull in fast (rate 20), release slowly (rate 3) so the camera never pumps
    const allowed = maxT * this.dist;
    this.collDist = allowed < this.collDist ? damp(this.collDist, allowed, 20, dt) : damp(this.collDist, allowed, 3, dt);
    if (this.collDist < this.dist - 1e-3) {
      const k = Math.max(0.1, this.collDist / Math.max(1e-3, this.dist));
      C.sub(P).multiplyScalar(k).add(P);
    }
    // terrain clearance: raise the camera, and pre-empt hills between the pivot and the camera
    let g = this.heightAt(C.x, C.z) + CAM.groundClear;
    for (let i = 1; i < 4; i++) {
      const f = i / 4;
      const gy = this.heightAt(P.x + (C.x - P.x) * f, P.z + (C.z - P.z) * f) + CAM.groundClear * 0.8;
      const lineY = P.y + (C.y - P.y) * f;
      if (gy > lineY) g = Math.max(g, C.y + (gy - lineY) / f);
    }
    let lift = 0;
    if (C.y < g) { lift = g - C.y; C.y = g; }
    // translate the aim with the camera (full for pull-in, 40 % of a lift so the view tilts down onto the player)
    this.desAim.x += C.x - _r.x; this.desAim.z += C.z - _r.z;
    this.desAim.y += (C.y - lift - _r.y) + lift * 0.4;
  }

  /** Project a world point to screen UV (0..1, y down) — for radial blur centres. */
  screenUV(p, out = { x: 0.5, y: 0.5 }) {
    _p.copy(p).project(this.cam);
    out.x = _p.x * 0.5 + 0.5; out.y = 0.5 - _p.y * 0.5;
    return out;
  }
}
