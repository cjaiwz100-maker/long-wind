// Streak particles (sparks 火花, blood droplets 墨血) and glow sprites (hit glow, blade glint star). Owner: X.
// CPU ring buffers → instanced quads; one draw per system.
import * as THREE from 'three';
import { ATMOS_GLSL } from '../core/atmosphere.js';
import { FX_COMMON, FX_FRAG, fxMaterial, fxMesh, instancedQuad, Swarm, flush, rnd, rr, coneDir } from './common.js';

// ------------------------------------------------------------------------------------------------ streak vertex
// Velocity-stretched capsule quad facing the camera. Width floors at ~0.8 px and the energy is conserved (no shimmer).
const STREAK_VS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iData;   // age01, width m, seed, amount
uniform float uStretch, uMaxLen;
varying vec2 vL; varying float vLen, vEnergy, vViewZ; varying vec4 vData;
varying vec3 vWp, vSide, vDir, vToCam, vAtT, vAtS, vLamp;
void main() {
  vec3 axis = iVel * uStretch;
  float L = length(axis);
  if (L > uMaxLen) { axis *= uMaxLen / L; L = uMaxLen; }
  vec3 dir = L > 1e-5 ? axis / L : vec3(0.0, 1.0, 0.0);
  vec3 toCam = normalize(cameraPosition - iPos);
  vec3 side = cross(dir, toCam); float sl = length(side);
  side = sl > 1e-3 ? side / sl : normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-4, 0.0, 0.0));
  vec4 mvc = viewMatrix * vec4(iPos, 1.0);
  float z = max(-mvc.z, 0.05);
  float px = 2.0 * z / (projectionMatrix[1][1] * uResolution.y);
  float w = max(iData.y, px * 0.8);
  vEnergy = iData.y / w;
  float along = w - (L + 2.0 * w) * position.y;
  vec3 wp = iPos + dir * along + side * position.x * w;
  vL = vec2(position.x, along / w); vLen = L / w;
  vData = iData; vWp = wp; vSide = side; vDir = dir; vToCam = toCam;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
#ifdef LIT
  vAtS = wx_applyAtmosphere(vec3(0.0), wp);
  vAtT = wx_applyAtmosphere(vec3(1.0), wp) - vAtS;
  vLamp = fx_lamps(iPos);
#else
  vAtS = vec3(0.0); vLamp = vec3(0.0);
  vAtT = wx_applyAtmosphereT(vec3(1.0), wp, 0.0);
#endif
  gl_Position = projectionMatrix * mv;
}`;

const SPARK_FS = /* glsl */`
#define WX_FOG_ADD
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
varying vec2 vL; varying float vLen, vEnergy, vViewZ; varying vec4 vData;
varying vec3 vWp, vSide, vDir, vToCam, vAtT, vAtS, vLamp;
void main() {
  float a = vL.y;
  float da = a > 0.0 ? a : (a < -vLen ? a + vLen : 0.0);
  float d2 = vL.x * vL.x + da * da;
  float prof = exp(-d2 * 2.2);
  float tailK = mix(1.0, 0.1, clamp(-a / max(vLen, 1e-3), 0.0, 1.0));
  float age = vData.x, seed = vData.z;
  float heat = pow(1.0 - age, 1.25);
  vec3 hue = mix(vec3(1.0, 0.26, 0.05), vec3(1.0, 0.64, 0.30), heat);
  hue = mix(hue, vec3(1.0, 0.92, 0.8), smoothstep(0.85, 1.0, heat) * 0.6);   // white-hot at birth
  float flick = 0.72 + 0.28 * sin(age * 90.0 + seed * 61.0);
  vec3 c = hue * mix(1.5, 24.0, heat * heat) * flick * vData.w;
  c *= prof * tailK * vEnergy * fx_soft(vViewZ, 0.06) * vAtT;
  gl_FragColor = vec4(c, 1.0);
}`;

const DROP_FS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
uniform float uInk;
varying vec2 vL; varying float vLen, vEnergy, vViewZ; varying vec4 vData;
varying vec3 vWp, vSide, vDir, vToCam, vAtT, vAtS, vLamp;
void main() {
  float a = vL.y;
  float da = a > 0.0 ? a : (a < -vLen ? a + vLen : 0.0);
  // teardrop: round head, thinning tail
  float t01 = clamp(-a / max(vLen, 1e-3), 0.0, 1.0);
  float wx = vL.x / mix(1.0, 0.35, t01);
  float r = sqrt(wx * wx + da * da);
  float mask = 1.0 - smoothstep(0.62, 1.0, r);
  float age = vData.x;
  float alpha = mask * (1.0 - smoothstep(0.8, 1.0, age)) * min(vEnergy * 1.4, 1.0) * fx_soft(vViewZ, 0.04);
  if (alpha < 0.01) discard;
  float nx = clamp(wx, -0.98, 0.98);
  vec3 N = normalize(vSide * nx + vToCam * sqrt(1.0 - nx * nx) + vDir * clamp(da, -1.0, 1.0) * 0.6);
  vec3 L = uSunDir, V = vToCam;
  float ink = max(uInk, vData.w);
  vec3 albedo = mix(vec3(0.19, 0.006, 0.005), vec3(0.008, 0.008, 0.01), ink);
  vec3 sunC = uSunCol * uSunVis;
  vec3 col = albedo * (fx_amb() + sunC * 0.4 * max(dot(N, L), 0.0) + vLamp);
  float back = pow(max(dot(-V, L), 0.0), 4.0);
  col += mix(vec3(0.85, 0.05, 0.025), vec3(0.03), ink) * sunC * 0.28 * back * (1.0 - r * 0.6);   // ruby when backlit
  vec3 H = normalize(L + V);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  col += sunC * pow(max(dot(N, H), 0.0), 140.0) * 0.9;                                         // wet glint
  col += (uSkyUp * uAmbK) * fres * 0.5;
  col = col * vAtT + vAtS;
  gl_FragColor = vec4(col, alpha);
}`;

// ------------------------------------------------------------------------------------------------ glows
const GLOW_VS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
attribute vec3 iPos; attribute vec3 iCol; attribute vec4 iData;   // size m, age01, kind (0 glow, 1 glow+star, 2 star), rot
varying vec2 vQ; varying vec3 vCol, vAtT; varying vec4 vData; varying float vCZ; varying vec2 vCUv;
void main() {
  float S = iData.x;
  float ext = iData.z > 0.5 ? 2.6 : 1.0;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec2 q = position.xy;               // -1..1
  vec3 wp = iPos + (right * q.x + up * q.y) * S * ext;
  vQ = q * ext; vCol = iCol; vData = iData;
  vec4 c = viewMatrix * vec4(iPos, 1.0);
  vCZ = -c.z;
  vec4 cc = projectionMatrix * c;
  vCUv = cc.xy / cc.w * 0.5 + 0.5;
  vAtT = wx_applyAtmosphereT(vec3(1.0), iPos, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const GLOW_FS = /* glsl */`
#define WX_FOG_ADD
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
varying vec2 vQ; varying vec3 vCol, vAtT; varying vec4 vData; varying float vCZ; varying vec2 vCUv;
void main() {
  // 5-tap manual occlusion against the opaque snapshot (depthTest is off so the halo can wrap edges)
  vec2 o = vec2(3.0) / uResolution;
  float zc = vCZ - 0.12, vis = 0.0;
  vis += step(zc, fx_sceneZ(vCUv));
  vis += step(zc, fx_sceneZ(vCUv + vec2(o.x, 0.0))); vis += step(zc, fx_sceneZ(vCUv - vec2(o.x, 0.0)));
  vis += step(zc, fx_sceneZ(vCUv + vec2(0.0, o.y))); vis += step(zc, fx_sceneZ(vCUv - vec2(0.0, o.y)));
  vis *= 0.2;
  if (vis <= 0.0) discard;
  float age = vData.y, kind = vData.z;
  float env = smoothstep(0.0, 0.06, age) * pow(1.0 - age, 1.6);
  float rr = length(vQ) * 0.5;            // 0.5 = sprite edge (glow radius = size)
  float g = 0.0;
  if (kind < 1.5) g = exp(-pow(rr / 0.03, 2.0)) * 5.0 + exp(-pow(rr / 0.1, 2.0)) + exp(-pow(rr / 0.3, 2.0)) * 0.35;
  if (kind > 0.5) {
    float c = cos(vData.w), s = sin(vData.w);
    vec2 p = mat2(c, -s, s, c) * vQ;
    float arm = exp(-abs(p.x) * 2.6) * exp(-p.y * p.y * 900.0) + exp(-abs(p.y) * 2.6) * exp(-p.x * p.x * 900.0);
    vec2 d = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p;
    arm += 0.3 * (exp(-abs(d.x) * 5.0) * exp(-d.y * d.y * 1400.0) + exp(-abs(d.y) * 5.0) * exp(-d.x * d.x * 1400.0));
    float star = arm * (0.6 + 0.4 * exp(-dot(p, p) * 8.0)) * 3.0;
    g += star * (kind > 1.5 ? 1.0 : 0.8) * (1.0 - smoothstep(0.0, 1.0, age) * 0.5);
  }
  float edge = 1.0 - smoothstep(0.8, 1.0, max(abs(vQ.x), abs(vQ.y)) / (kind > 0.5 ? 2.6 : 1.0));
  vec3 c = vCol * g * env * vis * edge * vAtT;
  gl_FragColor = vec4(c, 1.0);
}`;

const GRAV = 9.8;

export function createParticles(app, { interaction, lamps, heightAt }) {
  const H = heightAt;
  // ---------------------------------------------------------------- sparks
  const SP = { px: 0, py: 1, pz: 2, vx: 3, vy: 4, vz: 5, age: 6, life: 7, w: 8, seed: 9, br: 10, bounce: 11, drag: 12 };
  const sparks = new Swarm(640, 13);
  const sGeo = instancedQuad(640, { iPos: 3, iVel: 3, iData: 4 });
  const sMat = fxMaterial({ vs: STREAK_VS, fs: SPARK_FS, additive: true, uniforms: { uStretch: { value: 0.028 }, uMaxLen: { value: 0.35 } } });
  app.scene.add(fxMesh(sGeo, sMat, { order: 20, name: 'fx.sparks' }));

  // ---------------------------------------------------------------- droplets
  const drops = new Swarm(600, 13);
  const dGeo = instancedQuad(600, { iPos: 3, iVel: 3, iData: 4 });
  const uInk = { value: 0 };
  const dMat = fxMaterial({ vs: STREAK_VS, fs: DROP_FS, defines: { LIT: 1 }, uniforms: { uStretch: { value: 0.016 }, uMaxLen: { value: 0.12 }, uInk } });
  app.scene.add(fxMesh(dGeo, dMat, { order: 14, name: 'fx.blood' }));

  // ---------------------------------------------------------------- glows
  const GL = { px: 0, py: 1, pz: 2, r: 3, g: 4, b: 5, size: 6, age: 7, life: 8, kind: 9, rot: 10 };
  const glows = new Swarm(64, 11);
  const gGeo = instancedQuad(64, { iPos: 3, iCol: 3, iData: 4 }, { centered: true });
  const gMat = fxMaterial({ vs: GLOW_VS, fs: GLOW_FS, additive: true, depthTest: false });
  app.scene.add(fxMesh(gGeo, gMat, { order: 30, name: 'fx.glow' }));

  const _d = new THREE.Vector3(), _n = new THREE.Vector3();

  function spark(pos, dir, speed, life, w, br) {
    const o = sparks.spawn(), d = sparks.d;
    d[o] = pos.x; d[o + 1] = pos.y; d[o + 2] = pos.z;
    d[o + 3] = dir.x * speed; d[o + 4] = dir.y * speed; d[o + 5] = dir.z * speed;
    d[o + 6] = 0; d[o + 7] = life; d[o + 8] = w; d[o + 9] = rnd(); d[o + 10] = br; d[o + 11] = 0; d[o + 12] = 1.5;
    return o;
  }

  function glow(pos, size, col, kind, life, rot = 0.35) {
    const o = glows.spawn(), d = glows.d;
    d[o] = pos.x; d[o + 1] = pos.y; d[o + 2] = pos.z;
    d[o + 3] = col[0]; d[o + 4] = col[1]; d[o + 5] = col[2];
    d[o + 6] = size; d[o + 7] = 0; d[o + 8] = life; d[o + 9] = kind; d[o + 10] = rot;
  }

  const api = {
    /** Clash sparks: cone of 35° round `normal` (the reflected blade direction), power 1 (block) … 2 (perfect parry). */
    sparks(pos, normal, power = 1) {
      power = Math.max(0.2, power);
      _n.copy(normal ?? _d.set(0, 1, 0)); if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0); _n.normalize();
      const count = Math.round(22 + 19 * power);
      for (let i = 0; i < count; i++) {
        const ember = rnd() < 0.18;
        coneDir(_n, ember ? 1.1 : 0.61, _d);
        const o = spark(pos, _d, ember ? rr(1.2, 3.5) : rr(4, 9) * (0.85 + 0.15 * power), ember ? rr(0.7, 1.3) : rr(0.25, 0.6),
          ember ? rr(0.006, 0.01) : rr(0.008, 0.014), ember ? 0.35 : rr(0.7, 1.2));
        if (ember) sparks.d[o + 12] = 3.5;
      }
      // white-hot contact flash + glow (+ star on a strong clash)
      glow(pos, 0.34 + 0.12 * power, [1.0 * 3.2, 0.78 * 3.2, 0.52 * 3.2], power >= 1.8 ? 1 : 0, 0.12 + 0.04 * power, rnd() * 3);
      if (power >= 1.8) glow(pos, 0.6, [1.0 * 3, 0.95 * 3, 0.85 * 3], 2, 0.09, rnd() * 3);
      lamps?.flash?.(pos, [1.0, 0.62, 0.3], 3.5 + 2.5 * power, 0.12);
    },

    /** Soft HDR glow sprite; with a 4-point star (blade glint telegraph). colour defaults to the warm core. */
    hitGlow(pos, size = 0.5, color) {
      const c = color || [1.0, 0.85, 0.6];
      const k = 3.4;
      glow(pos, Math.max(0.12, size), [c[0] * k, c[1] * k, c[2] * k], 1, 0.22, 0.35 + rnd() * 0.2);
    },

    /** Droplets (called by vfx.blood). */
    droplets(pos, dir, n, ink) {
      _n.copy(dir ?? _d.set(1, 0, 0)); if (_n.lengthSq() < 1e-6) _n.set(1, 0, 0); _n.normalize();
      for (let i = 0; i < n; i++) {
        coneDir(_n, 0.55, _d);
        _d.y += rr(0.05, 0.5); _d.normalize();
        const o = drops.spawn(), d = drops.d;
        const sp = rr(1.6, 5.2), big = rnd() < 0.2;
        d[o] = pos.x + rr(-0.05, 0.05); d[o + 1] = pos.y + rr(-0.05, 0.05); d[o + 2] = pos.z + rr(-0.05, 0.05);
        d[o + 3] = _d.x * sp; d[o + 4] = _d.y * sp; d[o + 5] = _d.z * sp;
        d[o + 6] = 0; d[o + 7] = rr(0.9, 1.6); d[o + 8] = big ? rr(0.011, 0.016) : rr(0.004, 0.009); d[o + 9] = rnd(); d[o + 10] = ink ? 1 : 0;
        d[o + 11] = 0; d[o + 12] = 0.4;
      }
    },
    setInk(on) { uInk.value = on ? 1 : 0; },

    update(dt) {
      if (dt <= 0) return;
      // sparks: gravity + drag, one bounce at 0.3 restitution
      const s = sparks.d;
      for (let i = sparks.n - 1; i >= 0; i--) {
        const o = i * sparks.S;
        s[o + 6] += dt;
        if (s[o + 6] >= s[o + 7]) { sparks.kill(o); continue; }
        const dr = Math.exp(-s[o + 12] * dt);
        s[o + 3] *= dr; s[o + 5] *= dr; s[o + 4] = s[o + 4] * dr - GRAV * dt * (s[o + 12] > 2 ? 0.25 : 1);
        s[o] += s[o + 3] * dt; s[o + 1] += s[o + 4] * dt; s[o + 2] += s[o + 5] * dt;
        const gy = H(s[o], s[o + 2]);
        if (s[o + 1] < gy + 0.01) {
          if (s[o + 11] < 1 && s[o + 4] < -0.5) {
            s[o + 1] = gy + 0.01; s[o + 4] = -s[o + 4] * 0.3; s[o + 3] *= 0.55; s[o + 5] *= 0.55; s[o + 11] = 1;
          } else { s[o + 1] = gy + 0.01; s[o + 4] = 0; s[o + 3] *= 0.8; s[o + 5] *= 0.8; s[o + 7] = Math.min(s[o + 7], s[o + 6] + 0.08); }
        }
      }
      // droplets: ballistic, stain the ground on contact
      const d = drops.d;
      let stamps = 0;
      for (let i = drops.n - 1; i >= 0; i--) {
        const o = i * drops.S;
        d[o + 6] += dt;
        if (d[o + 6] >= d[o + 7]) { drops.kill(o); continue; }
        const dr = Math.exp(-d[o + 12] * dt);
        d[o + 3] *= dr; d[o + 5] *= dr; d[o + 4] = d[o + 4] * dr - GRAV * dt;
        d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
        const gy = H(d[o], d[o + 2]);
        if (d[o + 1] < gy + 0.02) {
          if (interaction?.stain && stamps < 6 && d[o + 9] < 0.45) { interaction.stain(d[o], d[o + 2], 0.08 + d[o + 8] * 8, 0.55); stamps++; }
          drops.kill(o);
        }
      }
      const g = glows.d;
      for (let i = glows.n - 1; i >= 0; i--) {
        const o = i * glows.S;
        g[o + 7] += dt / g[o + 8];
        if (g[o + 7] >= 1) glows.kill(o);
      }
    },

    lateUpdate() {
      writeStreaks(sparks, sGeo, 1);
      writeStreaks(drops, dGeo, 0);
      const P = gGeo.attributes.iPos.array, C = gGeo.attributes.iCol.array, D = gGeo.attributes.iData.array, g = glows.d;
      for (let i = 0; i < glows.n; i++) {
        const o = i * glows.S;
        P[i * 3] = g[o]; P[i * 3 + 1] = g[o + 1]; P[i * 3 + 2] = g[o + 2];
        C[i * 3] = g[o + 3]; C[i * 3 + 1] = g[o + 4]; C[i * 3 + 2] = g[o + 5];
        D[i * 4] = g[o + 6]; D[i * 4 + 1] = g[o + 7]; D[i * 4 + 2] = g[o + 9]; D[i * 4 + 3] = g[o + 10];
      }
      flush(gGeo, glows.n, ['iPos', 'iCol', 'iData']);
    },
  };

  function writeStreaks(sw, geo, isSpark) {
    const P = geo.attributes.iPos.array, V = geo.attributes.iVel.array, D = geo.attributes.iData.array, s = sw.d;
    for (let i = 0; i < sw.n; i++) {
      const o = i * sw.S;
      P[i * 3] = s[o]; P[i * 3 + 1] = s[o + 1]; P[i * 3 + 2] = s[o + 2];
      V[i * 3] = s[o + 3]; V[i * 3 + 1] = s[o + 4]; V[i * 3 + 2] = s[o + 5];
      D[i * 4] = s[o + 6] / s[o + 7]; D[i * 4 + 1] = s[o + 8]; D[i * 4 + 2] = s[o + 9]; D[i * 4 + 3] = s[o + 10];
    }
    void isSpark;
    flush(geo, sw.n, ['iPos', 'iVel', 'iData']);
  }

  return api;
}
