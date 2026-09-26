// Environment controller (bible §3.3–3.5, §2.5, §2.7): time-of-day keyframes → G uniforms, three.js lights, IBL and
// the post params. The only writer of the sun / fog / sky / weather groups of G. Owner: sky/lighting (S).
// STABLE API:
//   const env = createEnvironment(app, { mood = 'golden' | 'ember' | 'blue' | 'night' | 'afternoon', drift = true })
//   env.sunFar / env.sun      key DirectionalLight (lit, far static-world shadow map)     env.sunNear  actor shadow helper
//   env.hemi, env.fill        HemisphereLight, anti-solar fill DirectionalLight           env.sky      sky dome Mesh
//   env.mood                  current (target) mood name;  env.u  current time-of-day key (0.60 … 0.85)
//   env.setMood(name, seconds = 0)    smoothstep-eased transition along the keyframes (bus event 'mood' does the same)
//   env.setU(u, seconds = 0)          same with a raw key (0.60 afternoon, 0.70 golden, 0.742 ember, 0.785 blue, 0.85 night)
//   env.setShadowFocus(vec3)          near (actor) shadow-map subject, normally the player's feet. Call every frame.
//   env.refreshShadows()              force a far (static world) shadow-map refresh after adding/moving world casters
//   env.setStorm(k, seconds = 3)      storm overlay 0..1 (grey palette, thick fog, overcast deck, no sun)
//   env.lightning(dir?)               one lightning flash (G.uFlash pulses, fill re-aimed at the bolt)
//   env.exposureMul                 per-level exposure trim (levels/*.js env.exposure)
//   env.lampLevel                     0 at day … 1 at night: dusk torches / lanterns should scale their weight by it
//   env.update(dt), env.lateUpdate()  registered automatically via app.add
//   env.setTimeOfDay(hours)           legacy stub API (17.6 h ≈ golden)
// Writes: G sun/sky/fog/weather groups (+ G.uSunDirTrue, G.uGroundY), scene.environment / environmentIntensity,
// app.pipeline.params.{exposure, bloom, vol, warm}; calls app.pipeline.setShadowSources?.({ far, near }).
// URL: ?mood=golden|ember|blue|night|afternoon  ?u=0.71  ?drift=0  ?storm=0.8  ?quality=medium (smaller shadow maps)
//      look-dev: ?lightk=2.9 (sun gain) ?ambk=1.6 (ambient gain) ?cloudshadow=0 (cloud-shadow strength multiplier)
import * as THREE from 'three';
import { G, SUN_DIR } from '../core/globals.js';
import { patchMaterial } from '../core/atmosphere.js';
import { installChunks } from '../core/chunks.js';
import { setWindStrength } from '../core/wind.js';
import { bus } from '../core/bus.js';
import { createSky } from './sky.js';
import { createShadows } from './shadows.js';

export const MOODS = { afternoon: 0.6, golden: 0.7, ember: 0.742, blue: 0.785, night: 0.85 };

// Keyframes (bible §3.4, linear colours). cloud = cloud-shadow strength, lamp = dusk lamp level, night = uNight.
const KEYS = [
  { u: 0.600, L: [3.8, 3.05, 2.2], hs: [.46, .58, .74], hg: [.24, .21, .11], hi: 0.92, amb: [1.1, 1.14, 1.2], env: 0.60,
    fc: [.42, .50, .58], fw: [1.05, .78, .52], fd: 0.0013, hz: 2.3e-4, mist: 0.5, zen: [.08, .17, .33], up: [.28, .40, .54],
    cl: [1.6, 1.28, .92], cs: [.40, .40, .50], gl: [1, .64, .40], exp: 0.95, bloom: 0.050, vol: 0.70, warm: 0.60, night: 0, cloud: 0.6, lamp: 0 },
  { u: 0.700, L: [3.3, 2.44, 1.55], hs: [.42, .55, .68], hg: [.21, .175, .08], hi: 0.85, amb: [1, 1, 1], env: 0.55,
    fc: [.33, .43, .50], fw: [1.05, .66, .36], fd: 0.0014, hz: 2.4e-4, mist: 0.6, zen: [.085, .16, .27], up: [.26, .36, .45],
    cl: [1.3, .936, .598], cs: [.34, .33, .42], gl: [1, .55, .30], exp: 1.05, bloom: 0.055, vol: 0.85, warm: 1.0, night: 0, cloud: 0.5, lamp: 0.15 },
  { u: 0.742, L: [1.75, 0.72, 0.3], hs: [.34, .38, .54], hg: [.17, .12, .07], hi: 0.70, amb: [.74, .70, .80], env: 0.45,
    fc: [.30, .32, .44], fw: [.92, .42, .22], fd: 0.0016, hz: 2.6e-4, mist: 0.8, zen: [.05, .08, .19], up: [.21, .23, .35],
    cl: [1.5, .62, .38], cs: [.30, .21, .28], gl: [1.1, .42, .20], exp: 1.22, bloom: 0.070, vol: 1.00, warm: 1.0, night: 0, cloud: 0.35, lamp: 0.45 },
  { u: 0.785, L: [0, 0, 0], hs: [.16, .22, .40], hg: [.045, .04, .04], hi: 0.55, amb: [.34, .40, .58], env: 0.40,
    fc: [.11, .14, .25], fw: [.34, .20, .20], fd: 0.0016, hz: 2.5e-4, mist: 1.1, zen: [.018, .03, .085], up: [.06, .09, .19],
    cl: [.38, .27, .32], cs: [.09, .09, .15], gl: [.5, .2, .12], exp: 1.90, bloom: 0.080, vol: 0.15, warm: 0.30, night: 0.45, cloud: 0, lamp: 0.85 },
  { u: 0.850, L: [.3, .37, .55], hs: [.075, .10, .19], hg: [.018, .018, .025], hi: 0.50, amb: [.12, .15, .26], env: 0.30,
    fc: [.038, .052, .088], fw: [.065, .075, .11], fd: 0.0015, hz: 2.4e-4, mist: 1.1, zen: [.004, .008, .02], up: [.012, .02, .044],
    cl: [.10, .11, .15], cs: [.03, .034, .05], gl: [.02, .03, .05], exp: 3.00, bloom: 0.100, vol: 0.40, warm: 0, night: 1, cloud: 0, lamp: 1 },
];
const U_MIN = KEYS[0].u, U_MAX = KEYS[KEYS.length - 1].u;

// Calibration gains for the three.js lights. The bible's keyframe intensities assume a grey card reads 0.18·E (no
// 1/π); three r186 lights are physical (Lambert = albedo/π), so the key light is scaled up to land the 0.18 grey card at
// sRGB 150–175 under the golden sun (bible §1.4 / App. C 5; scenes/sky.js readCard). The ambient terms (hemi, fill, IBL)
// get a smaller gain so shadow sides stay ~2.5 stops under the sun (contre-jour silhouettes keep their drama).
// Sky / fog radiance and uSunCol (custom shaders) are NOT scaled. Look-dev overrides: ?lightk= ?ambk=
export const EXPOSURE_TRIM = 1.0;
export let SUN_GAIN = 2.9;
export let AMB_GAIN = 1.6;

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** Interpolated keyframe at u (smoothstep eased per segment) written into `out` (reused, no allocation). */
function sampleKeys(u, out) {
  u = Math.min(Math.max(u, U_MIN), U_MAX);
  let i = 0;
  while (i < KEYS.length - 2 && u > KEYS[i + 1].u) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = smooth((u - a.u) / (b.u - a.u));
  for (const k in a) {
    if (k === 'u') continue;
    const va = a[k], vb = b[k];
    if (Array.isArray(va)) { const o = out[k] || (out[k] = [0, 0, 0]); o[0] = lerp(va[0], vb[0], t); o[1] = lerp(va[1], vb[1], t); o[2] = lerp(va[2], vb[2], t); }
    else out[k] = lerp(va, vb, t);
  }
  return out;
}

// Sun path (bible §3.4): elev = asin(sin58°·sin(πe)), az = az0 + 192°·e, then a fixed 0.1° rotation so u = 0.70
// reproduces SUN_DIR exactly. Moon: low in the −z sky (in the default contre-jour view) through blue hour and night.
const D2R = Math.PI / 180;
const AZ0 = Math.atan2(-SUN_DIR.x, -SUN_DIR.z);
function rawSun(u, out) {
  let e = (u + 0.012) / 0.759;
  if (u > 0.9) e = (u - 1 + 0.012) / 0.759;
  const el = Math.asin(Math.sin(58 * D2R) * Math.sin(Math.PI * e));
  const az = AZ0 + 192 * D2R * e;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}
const SUN_FIX = new THREE.Quaternion().setFromUnitVectors(rawSun(0.7, new THREE.Vector3()), SUN_DIR.clone().normalize());
const sunAt = (u, out) => rawSun(u, out).applyQuaternion(SUN_FIX);
function moonAt(u, out) {
  const e = Math.min(Math.max((u - 0.74) / 0.36, 0), 1);
  const el = (6 + 18 * Math.sin(Math.PI * e)) * D2R;
  const az = (150 + 60 * e) * D2R;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

const SUN_BOOST = [1.697, 1.455, 1.129];   // shader sun radiance is warmer/stronger than the three.js light
const FLASH_PULSES = [[0, 0.35, 0.05], [0.07, 1, 0.09], [0.22, 0.7, 0.07]];

export function createEnvironment(app, { mood, drift } = {}) {
  const { scene, renderer, params } = app;
  installChunks(app);                       // idempotent; guarantees the dummy fog + chunk patches
  scene.background = null;                  // the sky dome covers everything

  const qMood = params?.get?.('mood');
  mood = (qMood && MOODS[qMood] !== undefined) ? qMood : (mood && MOODS[mood] !== undefined ? mood : 'golden');
  const qU = parseFloat(params?.get?.('u'));
  const driftOn = drift ?? (params?.get?.('drift') !== '0');
  const qK = parseFloat(params?.get?.('lightk')), qA = parseFloat(params?.get?.('ambk'));
  if (Number.isFinite(qK)) SUN_GAIN = qK;
  if (Number.isFinite(qA)) AMB_GAIN = qA;
  const qCS = parseFloat(params?.get?.('cloudshadow'));
  const cloudShadowK = Number.isFinite(qCS) ? qCS : 1;

  // ---- lights (order matters: the two shadow casters first → indices 0 and 1 in the light loop) ----
  const shadows = createShadows(app, { quality: params?.get?.('quality') || 'high' });
  const { sunFar, sunNear } = shadows;
  scene.add(sunFar, sunFar.target, sunNear, sunNear.target);
  const fill = new THREE.DirectionalLight(new THREE.Color(0.62, 0.60, 0.58), 0.42);
  fill.name = 'fill';
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.85);
  hemi.name = 'hemi';
  for (const l of [fill, fill.target, hemi]) l.layers.enableAll();
  scene.add(fill, fill.target, hemi);

  // ---- sky + env cube (IBL) ----
  const sky = createSky(app);
  const envScene = new THREE.Scene();
  envScene.add(sky.captureMesh);
  const cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: false });
  cubeRT.texture.name = 'envCube';
  const cubeCam = new THREE.CubeCamera(1, 12000, cubeRT);
  envScene.add(cubeCam);
  scene.environment = cubeRT.texture;

  // ---- state ----
  const K = {};                                   // current (overlaid) keyframe values
  const st = {
    u: Number.isFinite(qU) ? qU : MOODS[mood], from: 0, to: 0, t: 0, dur: 0,
    storm: 0, stormFrom: 0, stormTo: 0, stormT: 0, stormDur: 0,
    flashT: -1, flashDir: new THREE.Vector3(0.3, 0.3, -1).normalize(),
    capFrame: -999, frame: 0,
  };
  const qStorm = parseFloat(params?.get?.('storm'));
  if (Number.isFinite(qStorm)) st.storm = st.stormTo = qStorm;
  const sun = new THREE.Vector3(), moon = new THREE.Vector3(), key = new THREE.Vector3(), tmp = new THREE.Vector3();
  const lastSig = new Float32Array(24).fill(-1), sig = new Float32Array(24);

  function applyStorm(k, s) {
    if (s <= 0) return;
    const a = 0.3 + 0.7 * Math.min(Math.max(k.L[0] / 3.5, 0), 1);
    const toward = (arr, tgt, w) => { for (let i = 0; i < 3; i++) arr[i] = lerp(arr[i], tgt[i] * a, w); };
    for (let i = 0; i < 3; i++) k.L[i] *= 1 - 0.9 * s;
    toward(k.hs, [0.36, 0.4, 0.46], 0.85 * s); k.hi *= 1 + 0.15 * s;
    toward(k.fc, [0.26, 0.29, 0.33], 0.85 * s); toward(k.fw, [0.31, 0.32, 0.35], 0.9 * s);
    toward(k.zen, [0.07, 0.08, 0.10], s); toward(k.up, [0.13, 0.145, 0.17], s);
    toward(k.cl, [0.36, 0.38, 0.43], s); toward(k.cs, [0.10, 0.105, 0.125], s);
    for (let i = 0; i < 3; i++) { k.gl[i] *= 1 - s; k.amb[i] = lerp(k.amb[i], [1, 1.08, 1.2][i], 0.6 * s); }
    k.fd *= 1 + 2.4 * s; k.hz *= 1 + 2.2 * s; k.mist += 1.1 * s;
    k.env *= 1 - 0.3 * s; k.exp *= 1 + 0.3 * s; k.vol *= 1 - s; k.warm *= 1 - s; k.bloom += 0.02 * s;
    k.cloud *= 1 - s; k.lamp = Math.max(k.lamp, 0.55 * s);
  }

  function flashLevel(t) {
    if (t < 0) return 0;
    let v = 0;
    for (const [d, amp, dec] of FLASH_PULSES) { const x = t - d; if (x > 0) v += amp * Math.min(x / 0.012, 1) * Math.exp(-x / dec); }
    return v;
  }

  function apply(dt, t) {
    // time-of-day key (+ a slow, small drift so shadows creep while a mood holds)
    let u = st.u;
    if (driftOn && st.dur === 0) u += 0.0025 * Math.sin(t * (2 * Math.PI / 480));
    sampleKeys(u, K);
    applyStorm(K, st.storm);

    sunAt(u, sun);
    moonAt(u, moon);
    const sunK = smooth(Math.min(Math.max((sun.y + 0.05) / 0.07, 0), 1));
    const moonK = 1 - smooth(Math.min(Math.max((sun.y + 0.16) / 0.09, 0), 1));
    const useMoon = sun.y < -0.07;
    key.copy(useMoon ? moon : sun);
    const keyK = useMoon ? moonK : sunK;
    const night = K.night;

    // flash (lightning)
    let flash = 0;
    if (st.flashT >= 0) { st.flashT += dt; flash = flashLevel(st.flashT); if (st.flashT > 1.2) st.flashT = -1; }

    // ---- G ----
    G.uSunDir.value.copy(key);
    G.uSunDirTrue.value.copy(sun);
    G.uMoonDir.value.copy(moon);
    G.uSunVis.value = smooth(Math.min(Math.max((sun.y + 0.03) / 0.04, 0), 1));
    const boost = (i) => lerp(SUN_BOOST[i], 1.35, night);
    G.uSunCol.value.setRGB(K.L[0] * boost(0) * keyK, K.L[1] * boost(1) * keyK, K.L[2] * boost(2) * keyK);
    G.uFogCool.value.setRGB(...K.fc); G.uFogWarm.value.setRGB(...K.fw);
    G.uFogParams.value.set(K.fd, 0.035, 0, K.hz);
    G.uMist.value = K.mist;
    G.uSkyZen.value.setRGB(...K.zen); G.uSkyUp.value.setRGB(...K.up);
    G.uCloudLit.value.setRGB(...K.cl); G.uCloudShade.value.setRGB(...K.cs);
    G.uHorizonGlow.value.setRGB(...K.gl);
    G.uAmbK.value.setRGB(...K.amb);
    G.uNight.value = night;
    G.uStorm.value = st.storm;
    G.uFlash.value = 1.6 * flash;
    G.uFlashDir.value.copy(st.flashDir);
    G.uCloudShadow.value.x = K.cloud * cloudShadowK;
    // legacy aliases (early stubs)
    G.uSkyZenith.value.setRGB(...K.zen); G.uSkyHorizon.value.setRGB(...K.gl); G.uGroundBounce.value.setRGB(...K.hg);

    // ---- lights ----
    const Lmax = Math.max(K.L[0], K.L[1], K.L[2], 1e-4);
    sunFar.color.setRGB(K.L[0] / Lmax, K.L[1] / Lmax, K.L[2] / Lmax);
    sunFar.intensity = Lmax * keyK * SUN_GAIN;
    G.uSunColor.value.copy(sunFar.color); G.uSunIntensity.value = sunFar.intensity;
    hemi.color.setRGB(...K.hs); hemi.groundColor.setRGB(...K.hg);
    hemi.intensity = (K.hi + 0.45 * flash) * AMB_GAIN;
    const fillBase = 0.42 * Math.min(Math.max(K.hi / 0.85, 0.15), 1.3) * (1 - 0.4 * night);
    tmp.set(-key.x, 0, -key.z);
    if (tmp.lengthSq() < 1e-6) tmp.set(0, 0, 1);
    tmp.normalize().multiplyScalar(Math.cos(20 * D2R)).setY(Math.sin(20 * D2R));
    if (flash > 0.01) {   // lightning re-aims the fill at the bolt, blue-white
      tmp.lerp(st.flashDir, Math.min(flash * 1.5, 1)).normalize();
      fill.color.setRGB(lerp(0.62, 0.72, Math.min(flash, 1)), lerp(0.60, 0.8, Math.min(flash, 1)), lerp(0.58, 1, Math.min(flash, 1)));
    } else fill.color.setRGB(0.62, 0.60, 0.58);
    fill.intensity = (fillBase + 2.2 * flash) * AMB_GAIN;
    fill.position.copy(tmp).multiplyScalar(100);
    scene.environmentIntensity = K.env * AMB_GAIN;
    env.lampLevel = K.lamp;

    // ---- post ----
    const pp = app.pipeline?.params;
    if (pp && env.writePost) { pp.exposure = K.exp * EXPOSURE_TRIM * (env.exposureMul ?? 1); pp.bloom = K.bloom; pp.vol = K.vol; pp.warm = K.warm; }
  }

  // Re-capture the env cube only when the sky changed by > 0.5% (every 12 frames at most during transitions).
  function maybeCapture(force) {
    let i = 0;
    const put = (v) => { sig[i++] = v; };
    const c3 = (c) => { put(c.r); put(c.g); put(c.b); };
    put(G.uSunDir.value.x); put(G.uSunDir.value.y); put(G.uSunDir.value.z);
    c3(G.uSunCol.value); c3(G.uSkyZen.value); c3(G.uSkyUp.value); c3(G.uFogWarm.value); c3(G.uFogCool.value);
    put(G.uNight.value); put(G.uStorm.value); put(G.uFlash.value);
    let changed = force;
    for (let j = 0; j < i && !changed; j++) if (Math.abs(sig[j] - lastSig[j]) > 0.005 * Math.max(Math.abs(lastSig[j]), 0.05)) changed = true;
    if (!changed || (!force && st.frame - st.capFrame < 12)) return;
    lastSig.set(sig);
    st.capFrame = st.frame;
    cubeCam.update(renderer, envScene);
    cubeRT.texture.needsPMREMUpdate = true;
  }

  const env = {
    sunFar, sun: sunFar, sunNear, hemi, fill, sky: sky.mesh, skyMaterial: sky.material, shadows,
    envTexture: cubeRT.texture, lampLevel: 0,
    writePost: true,              // false: leave app.pipeline.params alone (look-dev overrides)
    get mood() { return mood; },
    get u() { return st.u; },
    setU(u, seconds = 0) {
      u = Math.min(Math.max(u, U_MIN), U_MAX);
      if (seconds <= 0) { st.u = u; st.dur = 0; return; }
      Object.assign(st, { from: st.u, to: u, t: 0, dur: seconds });
    },
    setMood(name, seconds = 0) {
      if (MOODS[name] === undefined) { console.warn(`[env] unknown mood ${name}`); return; }
      mood = name;
      this.setU(MOODS[name], seconds);
    },
    setTimeOfDay(hours) { this.setU(0.7 + (hours - 17.6) * 0.052); },
    get timeOfDay() { return 17.6 + (st.u - 0.7) / 0.052; },
    setShadowFocus(v) { shadows.setFocus(v); },
    refreshShadows() { shadows.refresh(); },
    setStorm(k, seconds = 3) { Object.assign(st, { stormFrom: st.storm, stormTo: Math.min(Math.max(k, 0), 1), stormT: 0, stormDur: Math.max(seconds, 1e-3) }); },
    lightning(dir) {
      if (dir) st.flashDir.copy(dir).normalize();
      else { const cam = app.camera; cam.getWorldDirection(tmp); tmp.y = 0; tmp.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, (Math.random() - 0.5) * 0.8); st.flashDir.set(tmp.x, 0.42, tmp.z).normalize(); }
      st.flashT = 0;
    },
    update(dt, t = app.time?.t ?? 0) {
      st.frame++;
      if (st.dur > 0) {
        st.t = Math.min(st.t + dt, st.dur);
        st.u = lerp(st.from, st.to, smooth(st.t / st.dur));
        if (st.t >= st.dur) st.dur = 0;
      }
      if (st.stormDur > 0) {
        st.stormT = Math.min(st.stormT + dt, st.stormDur);
        st.storm = lerp(st.stormFrom, st.stormTo, smooth(st.stormT / st.stormDur));
        if (st.stormT >= st.stormDur) st.stormDur = 0;
      }
      apply(dt, t);
      const c = app.camera.position;
      G.uGroundY.value = app.world.heightAt(c.x, c.z);
      maybeCapture(false);
    },
    lateUpdate() {
      // after gameplay moved the player and the camera settled: place both shadow frusta (texel-snapped)
      shadows.update(G.uSunDir.value, app.camera);
    },
  };

  bus.on('mood', ({ name, seconds } = {}) => env.setMood(name, seconds ?? 8));
  bus.on('wind', ({ strength, ease } = {}) => { if (Number.isFinite(strength)) setWindStrength(strength, ease ?? 1.5); });

  apply(0, 0);
  shadows.update(G.uSunDir.value, app.camera);
  maybeCapture(true);
  app.pipeline?.setShadowSources?.({ far: sunFar, near: sunNear });
  app.add(env);
  return env;
}

export { patchMaterial };
