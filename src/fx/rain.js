// Rain 雨 (bible §6): GPU rain streaks wrapped around the camera plus ground splashes.
// Owner: X. Two instanced draws on LAYERS.TRANSPARENT, zero CPU work per drop, zero per-frame allocations.
//
//   const rain = createRain(app, { intensity = 1, wind = true, wet = true, count = 40960, splashes = 520 })
//   rain.setIntensity(k, seconds = 2)   0 … 1 (eased); emits bus 'weather' { rain } on change + a 1 s heartbeat
//   rain.intensity                      current (eased) level
//   rain.update(dt)                     registered with app.add (sim dt: hit-stop freezes the drops mid-air)
//   rain.dispose()                      removes the meshes, zeroes G.uRain, emits 'weather' { rain: 0 }
//
// Streaks: drops live in three nested camera-wrapped boxes (14×12×14, 28×24×28, 56×48×56 m) so the density is
// highest where streaks are resolvable, with no visible volume edge (box-face + distance fades). Each drop is a thin
// motion-blurred quad along its velocity (fall ~9 m/s, slanted by G.uWind × the gust at the camera), width clamped
// to ~1 px with coverage-preserving alpha (no shimmer at range), faded near the lens and soft against the opaque
// depth snapshot. Colour = the in-scattered fog/sky radiance along the view ray (so a streak is brighter than the dark
// scene behind it and fades into a bright sky), + sky ambient + moon/sun forward glint + lamps + lightning (G.uFlash).
// Splashes: a crown (two thin jets) + an expanding ring per splash, respawned each cycle at a hashed spot inside a
// camera-wrapped box, sat on the terrain height bake (G.tHeight, exact mesh height).
// Writes: G.uRain (= intensity), G.uWet (wets over ~14 s under rain, dries over ~150 s) unless opts.wet === false.
import * as THREE from 'three';
import { G, LAYERS } from '../core/globals.js';
import { bus } from '../core/bus.js';
import { ATMOS_GLSL } from '../core/atmosphere.js';
import { windGust } from '../core/wind.js';
import { GROUND_GLSL, groundUniforms } from '../world/ground-glsl.js';
import { FX_COMMON, FX_FRAG, fxMaterial, fxMesh } from './common.js';

// three nested tiers (share of drops, box size): each box size divides the next, so one wrapped offset serves all
const TIERS = [[0.3, [14, 12, 14]], [0.35, [28, 24, 28]], [0.35, [56, 48, 56]]];
const WRAP = TIERS[2][1];                                  // drop offsets are wrapped modulo the largest box
const SPEEDS = [0.86, 1.0, 1.15];                          // three fall-speed classes (each has its own offset)

// ------------------------------------------------------------------------------------------------ streaks
const STREAK_VS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
attribute vec4 iSeed;                 // xyz position in the box 0..1, w: speed class / size variation
uniform vec3 uCamBox;                 // wrap centre (camera, raised)
uniform vec3 uOff[3];                 // integrated displacement per speed class (wrapped)
uniform vec3 uVel[3];                 // current velocity per speed class (m/s)
uniform vec3 uBox0, uBox1, uBox2;
uniform float uShutter, uWidth, uAlpha, uGain;
uniform vec2 uTierFrac;              // cumulative shares of tiers 0, 1
varying vec2 vQ; varying float vA, vViewZ; varying vec3 vCol;
void main() {
  float tr = fract(float(gl_InstanceID) * 0.6180339);   // golden-ratio sequence: any prefix is evenly mixed
  int tier = tr < uTierFrac.x ? 0 : tr < uTierFrac.y ? 1 : 2;
  vec3 B = tier == 0 ? uBox0 : tier == 1 ? uBox1 : uBox2;
  int cls = int(iSeed.w * 2.999);
  vec3 p = iSeed.xyz * B + uOff[cls];
  vec3 rel = mod(p - uCamBox + B * 0.5, B) - B * 0.5;
  vec3 head = uCamBox + rel;
  vec3 vel = uVel[cls];
  vec3 toC = head - cameraPosition;
  float d = length(toC);
  // fades: box faces (hide the wrap), distance, lens
  vec3 e = abs(rel) / (B * 0.5);
  float a = 1.0 - smoothstep(0.72, 1.0, max(e.x, e.z));
  a *= 1.0 - smoothstep(0.6, 1.0, e.y);
  a *= tier < 2 ? 1.0 : 1.0 - smoothstep(20.0, 28.0, d);
  a *= smoothstep(0.7, 2.4, d);
  // motion-blurred quad along the velocity: head at y = 0, tail at y = 1
  vec3 axis = -vel * uShutter;
  vec3 V = toC / max(d, 1e-3);
  vec3 side = cross(normalize(axis), V);
  side /= max(length(side), 1e-3);
  float px = 2.0 * d / (projectionMatrix[1][1] * uResolution.y);   // metres per pixel at this depth
  float w = uWidth * (0.8 + 0.4 * fract(iSeed.w * 7.13));
  float wd = max(w, px * 0.85);
  a *= w / wd;                                                    // keep coverage when widened to ~1 px
  vec3 wp = head + axis * position.y * (0.75 + 0.5 * fract(iSeed.w * 3.7)) + side * position.x * wd;
  // light: fog/sky in-scatter along the ray (a drop refracts the bright sky into the dark scene), ambient, glints
  vec3 fogC = wx_skyFogColor(V);
  float mu = max(dot(V, uSunDir), 0.0);
  vec3 lit = fogC * 1.6 + fx_amb() * 0.6 + uSunCol * uSunVis * (0.012 + 0.35 * pow(mu, 12.0))
           + vec3(0.75, 0.82, 1.0) * uFlash * 0.55 + fx_lamps(head) * 1.2;
  vCol = lit * uGain;
  vA = a * uAlpha;
  vQ = position.xy;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = vA < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;   // culled drops cost no fragments
}`;

const STREAK_FS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
varying vec2 vQ; varying float vA, vViewZ; varying vec3 vCol;
void main() {
  float x = abs(vQ.x);
  float prof = (1.0 - x * x) * smoothstep(0.0, 0.18, vQ.y) * (1.0 - smoothstep(0.35, 1.0, vQ.y) * 0.75);
  float a = vA * prof * fx_soft(vViewZ, 0.35);
  gl_FragColor = vec4(vCol, a);
}`;

// ------------------------------------------------------------------------------------------------ splashes
// geometry: 2 quads per instance — quad 0 the crown (camera-facing about Y), quad 1 the ring (flat on the ground)
const SPLASH_VS = /* glsl */`
${ATMOS_GLSL}
${GROUND_GLSL}
${FX_COMMON}
attribute vec4 iSeed;
attribute float aPart;
uniform vec3 uCamBox;
uniform float uBoxN, uBoxF, uNearFrac, uRainK, uGain;
varying vec2 vQ; varying float vPh, vA, vViewZ, vPart, vSeed; varying vec3 vCol;
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  bool nearTier = fract(float(gl_InstanceID) * 0.6180339) < uNearFrac;
  float B = nearTier ? uBoxN : uBoxF;
  float life = 0.26 + 0.14 * iSeed.z;
  float cyc = uTime / life + iSeed.w * 17.0;
  float id = floor(cyc), ph = cyc - id;
  vec2 r = vec2(h12(vec2(id, iSeed.x * 311.0)), h12(vec2(iSeed.y * 173.0, id + 7.0)));
  vec2 rel = mod(r * B - uCamBox.xz + B * 0.5, B) - B * 0.5;
  vec2 xz = uCamBox.xz + rel;
  // only a share of the splashes live at lower rain levels (a cycle-hashed lottery keeps it flicker-free)
  float live = step(h12(vec2(id * 1.7, iSeed.z * 91.0)), uRainK);
  float gy = wt_groundHeight(xz);
  vec3 base = vec3(xz.x, gy + 0.015, xz.y);
  vec3 toC = base - cameraPosition; float d = length(toC);
  float a = live * (1.0 - smoothstep(0.7, 1.0, max(abs(rel.x), abs(rel.y)) / (B * 0.5)));
  a *= smoothstep(0.6, 1.6, d) * (1.0 - smoothstep(nearTier ? 20.0 : 14.0, nearTier ? 26.0 : 24.0, d));
  float sz = 0.06 + 0.04 * iSeed.x;
  vec3 wp;
  if (aPart < 0.5) {
    // crown: grows fast, jets lean out; faces the camera about the vertical axis
    vec3 sd = normalize(vec3(-toC.z, 0.0, toC.x) + 1e-5);
    float s = sz;
    wp = base + sd * position.x * s + vec3(0.0, position.y * s, 0.0);
  } else {
    float s = 0.02 + 0.1 * sqrt(ph) * (0.7 + 0.6 * iSeed.y);
    wp = base + vec3(position.x * s, 0.0, (position.y * 2.0 - 1.0) * s);
    a *= 0.8;
  }
  // light (same recipe as the streaks, a touch brighter: a splash is a cluster of lit droplets)
  vec3 V = toC / max(d, 1e-3);
  float mu = max(dot(V, uSunDir), 0.0);
  vCol = (wx_skyFogColor(V) * 1.6 + fx_amb() * 0.6 + uSunCol * uSunVis * (0.02 + 0.3 * pow(mu, 8.0))
         + vec3(0.75, 0.82, 1.0) * uFlash * 0.6 + fx_lamps(base) * 1.4) * uGain;
  vQ = position.xy; vPh = ph; vA = a; vPart = aPart; vSeed = iSeed.y + id * 0.137;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = a < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
}`;

const SPLASH_FS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
varying vec2 vQ; varying float vPh, vA, vViewZ, vPart, vSeed; varying vec3 vCol;
void main() {
  float a;
  if (vPart < 0.5) {
    // crown burst: a few droplets thrown up and out on parabolic arcs, plus the low sheet at the impact point
    float t = vPh * 0.3;                                   // seconds since impact (quad spans ~±1 = size)
    a = exp(-40.0 * vQ.y * vQ.y) * exp(-4.0 * vQ.x * vQ.x) * (1.0 - smoothstep(0.0, 0.5, vPh)) * 0.5;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float h = fract(sin(fi * 12.9898 + vSeed * 78.233) * 43758.5453);
      float vx = (h - 0.5) * 2.6, vy = 3.0 + 2.0 * fract(h * 7.31);
      vec2 dp = vec2(vx * t, vy * t - 9.8 * t * t * 2.2) * 1.1;
      vec2 e = (vQ - dp) * vec2(1.0, 0.7);
      a += exp(-dot(e, e) * 260.0) * 0.9;
    }
    a *= (1.0 - vPh) * 0.7;
  } else {
    // expanding ring (a thin crest with a faint inner trough)
    float r = length(vec2(vQ.x, vQ.y * 2.0 - 1.0));
    float ring = exp(-pow((r - 0.8) / 0.08, 2.0)) + 0.25 * exp(-pow((r - 0.55) / 0.1, 2.0));
    a = ring * (1.0 - vPh) * (1.0 - vPh) * 0.28 * step(r, 1.0);
  }
  a *= vA * fx_soft(vViewZ, 0.06);
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol, a);
}`;

function streakGeometry(count) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 4);
  let s = 0x6d2b79f5;
  const r = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e7) / 1e7; };
  for (let i = 0; i < seeds.length; i++) seeds[i] = r();
  g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

function splashGeometry(count) {
  const g = new THREE.InstancedBufferGeometry();
  // crown quad x∈[-1,1], y∈[0,1]; ring quad x∈[-1,1], y∈[0,1] (mapped to −1..1 in the shader)
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0,
    -1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0,
  ], 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 1, 1, 1], 1));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const seeds = new Float32Array(count * 4);
  let s = 0x1b873593;
  const r = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e7) / 1e7; };
  for (let i = 0; i < seeds.length; i++) seeds[i] = r();
  g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

const smooth = (x) => x * x * (3 - 2 * x);
const wrap = (v, m) => v - Math.floor(v / m) * m;

export function createRain(app, opts = {}) {
  const { intensity = 1, wind = true, wet = true, count = 40960, splashes = 520 } = opts;

  // ---- streaks
  const sGeo = streakGeometry(count);
  const offs = SPEEDS.map(() => new THREE.Vector3());
  const vels = SPEEDS.map(() => new THREE.Vector3(0, -9, 0));
  const su = {
    uCamBox: { value: new THREE.Vector3() },
    uOff: { value: offs }, uVel: { value: vels },
    uBox0: { value: new THREE.Vector3(...TIERS[0][1]) }, uBox1: { value: new THREE.Vector3(...TIERS[1][1]) },
    uBox2: { value: new THREE.Vector3(...TIERS[2][1]) }, uTierFrac: { value: new THREE.Vector2(TIERS[0][0], TIERS[0][0] + TIERS[1][0]) },
    uShutter: { value: 0.03 }, uWidth: { value: 0.0022 }, uAlpha: { value: 0.32 }, uGain: { value: 1.0 },
  };
  const sMat = fxMaterial({ vs: STREAK_VS, fs: STREAK_FS, uniforms: su });
  sMat.name = 'fx.rain';
  const streaks = fxMesh(sGeo, sMat, { layer: LAYERS.TRANSPARENT, order: 4, name: 'fx.rain' });
  app.scene.add(streaks);

  // ---- splashes
  const pGeo = splashGeometry(splashes);
  const pu = {
    ...groundUniforms(),
    uCamBox: { value: new THREE.Vector3() },
    uBoxN: { value: 12 }, uBoxF: { value: 34 }, uNearFrac: { value: 0.45 }, uRainK: { value: 1 }, uGain: { value: 0.85 },
  };
  const pMat = fxMaterial({ vs: SPLASH_VS, fs: SPLASH_FS, uniforms: pu });
  pMat.name = 'fx.rain.splash';
  const splash = fxMesh(pGeo, pMat, { layer: LAYERS.TRANSPARENT, order: 5, name: 'fx.rain.splash' });
  app.scene.add(splash);

  // ---- state
  const st = { k: 0, from: 0, to: Math.max(0, Math.min(1, intensity)), t: 0, dur: 0, sent: -1, beat: 0 };
  st.k = st.to;
  const msg = { rain: 0 };   // reused payload (no per-frame garbage)
  // 'weather' on every ≥2% change, when a ramp lands, and as a 1 s heartbeat (late subscribers, e.g. audio created
  // after the rain or started on a later user gesture, pick the level up)
  const emit = (dt = 0) => {
    st.beat += dt;
    if (st.beat < 1 && Math.abs(st.k - st.sent) < 0.02 && !(st.k === st.to && st.sent !== st.to)) return;
    st.beat = 0;
    st.sent = st.k;
    msg.rain = st.k;
    bus.emit('weather', msg);
  };
  const apply = () => {
    const k = st.k;
    sGeo.instanceCount = Math.round(count * Math.min(1, k * 1.15));
    streaks.visible = k > 0.003;
    pu.uRainK.value = k;
    splash.visible = k > 0.003;
    G.uRain.value = k;
  };
  apply();

  const rain = {
    streaks, splash, uniforms: su, splashUniforms: pu,
    get intensity() { return st.k; },
    setIntensity(k, seconds = 2) {
      k = Math.max(0, Math.min(1, +k || 0));
      if (seconds <= 0) { st.k = st.to = k; st.dur = 0; apply(); emit(); return; }
      Object.assign(st, { from: st.k, to: k, t: 0, dur: seconds });
    },
    update(dt) {
      if (st.dur > 0) {
        st.t = Math.min(st.t + dt, st.dur);
        st.k = st.from + (st.to - st.from) * smooth(st.t / st.dur);
        if (st.t >= st.dur) { st.dur = 0; st.k = st.to; }
        apply();
      }
      emit(dt);
      const k = st.k;
      if (wet) {
        const w = G.uWet.value;
        G.uWet.value = k > 0.02 ? Math.min(1, w + dt * k / 14) : Math.max(0, w - dt / 150);
      }
      if (!streaks.visible) return;
      // velocity: fall ~9 m/s (heavier rain falls a touch faster), pushed downwind by the gust at the camera
      const c = app.camera.position;
      const wv = G.uWind.value;
      const g = wind ? windGust(c.x, c.z) : 0;
      const hx = wv.x * g * 1.9, hz = wv.y * g * 1.9, vy = -(8.4 + 1.2 * k);
      for (let i = 0; i < 3; i++) {
        const f = SPEEDS[i];
        vels[i].set(hx * f, vy * f, hz * f);
        const o = offs[i];
        o.set(wrap(o.x + vels[i].x * dt, WRAP[0]), wrap(o.y + vels[i].y * dt, WRAP[1]), wrap(o.z + vels[i].z * dt, WRAP[2]));
      }
      su.uCamBox.value.set(c.x, c.y + 3.0, c.z);
      pu.uCamBox.value.copy(c);
    },
    dispose() {
      app.remove?.(rain);
      app.scene.remove(streaks, splash);
      sGeo.dispose(); sMat.dispose(); pGeo.dispose(); pMat.dispose();
      G.uRain.value = 0;
      msg.rain = 0; bus.emit('weather', msg);   // the rain bed fades out with it
    },
  };
  app.add(rain);
  emit();
  return rain;
}
