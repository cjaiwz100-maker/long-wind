// Soft volumetric sprites: dust puffs 尘 (sun-lit, forward-scattering), blood mist, and ink blooms 墨 (ink dispersing
// in water, dissolving through a noise threshold). Owner: X. One instanced draw, soft against depth.
import * as THREE from 'three';
import { ATMOS_GLSL } from '../core/atmosphere.js';
import { windVector } from '../core/wind.js';
import { FX_COMMON, FX_FRAG, fxMaterial, fxMesh, instancedQuad, Swarm, flush, rnd, rr } from './common.js';

const VS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
attribute vec3 iPos; attribute vec4 iData; attribute vec4 iCol;   // iData: age01, size m, seed, kind | iCol: rgb albedo, alpha max
varying vec2 vQ; varying vec4 vData, vCol; varying float vViewZ, vCamD; varying vec3 vWp, vAtT, vAtS, vLight, vRd; varying vec2 vSunS;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float ang = iData.z * 6.2832 + iData.x * (iData.z - 0.5) * 1.6;      // slow roll as it grows
  float c = cos(ang), s = sin(ang);
  vec2 q = mat2(c, -s, s, c) * position.xy;
  vec3 wp = iPos + (right * q.x + up * q.y) * iData.y;
  vQ = position.xy; vData = iData; vCol = iCol; vWp = wp;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  vCamD = length(iPos - cameraPosition);
  vRd = normalize(iPos - cameraPosition);
  // sun direction in the sprite's (rotated) frame, for the self-shadow gradient
  vec2 ls = vec2(dot(uSunDir, right), dot(uSunDir, up));
  vSunS = mat2(c, s, -s, c) * ls;
  float sh = wx_cloudShadow(iPos);
  vLight = uSunCol * uSunVis * sh;
  vAtS = wx_applyAtmosphere(vec3(0.0), iPos);
  vAtT = wx_applyAtmosphere(vec3(1.0), iPos) - vAtS;
  vLight += fx_lamps(iPos) * 1.5;
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
varying vec2 vQ; varying vec4 vData, vCol; varying float vViewZ, vCamD; varying vec3 vWp, vAtT, vAtS, vLight, vRd; varying vec2 vSunS;
float dens(vec2 p, float seed, float age, float kind) {
  float r = length(p);
  vec2 q = p * 1.6 + seed * 17.0;
  float n = wx_fbm(q + vec2(wx_vnoise(q * 1.7 + age * 1.3), wx_vnoise(q * 1.3 - age)) * 0.9 + age * 0.4);
  return clamp(1.0 - r * 1.05 + (n - 0.5) * 1.1, 0.0, 1.0);
}
void main() {
  float age = vData.x, seed = vData.z, kind = vData.w;
  vec2 p = vQ;
  float r = length(p);
  if (r > 1.0) discard;
  vec3 col; float a;
  if (kind < 0.5) {
    // ---- dust: billowy fbm puff, self-shadowed toward the sun, forward-scatters gold when backlit
    float d = dens(p, seed, age, kind);
    float d2 = dens(p + normalize(vSunS + 1e-4) * 0.22, seed, age, kind);
    float shadow = exp(-max(d2 - d * 0.5, 0.0) * 2.2);
    float mu = dot(vRd, uSunDir);
    float phase = 0.3 + 2.8 * pow(max(mu, 0.0), 8.0) + 0.6 * pow(max(mu, 0.0), 2.0);
    vec3 fogC = wx_skyFogColor(vRd);
    col = fogC * 0.5 + vCol.rgb * fx_amb() * 0.7 + vCol.rgb * vLight * 0.22 * phase * shadow;
    a = smoothstep(0.02, 0.6, d) * vCol.a * smoothstep(0.0, 0.08, age) * pow(1.0 - age, 1.3);
    a *= fx_soft(vViewZ, 0.5) * smoothstep(0.4, 1.4, vCamD);
  } else if (kind < 1.5) {
    // ---- blood mist: fine, short-lived, red glow when backlit
    float d = dens(p * 1.2, seed, age * 1.5, kind);
    float back = pow(max(dot(vRd, uSunDir), 0.0), 4.0);
    col = vCol.rgb * (fx_amb() + vLight * 0.25) + vec3(0.7, 0.03, 0.02) * vLight * 0.18 * back * (1.0 - vCol.a * 0.0);
    a = smoothstep(0.1, 0.7, d) * 0.3 * pow(1.0 - age, 2.0) * smoothstep(0.0, 0.05, age);
    a *= fx_soft(vViewZ, 0.15);
  } else {
    // ---- ink bloom: domain-warped tendrils, pigment pooling at the rim, dissolving through a noise threshold
    vec2 q = p * 1.35 + seed * 31.0;
    vec2 w = vec2(wx_fbm(q * 1.2 + age * 0.9), wx_fbm(q * 1.2 + 5.2 - age * 0.7));
    float n = wx_fbm(q + w * 1.6 + age * 0.35);
    float shape = n * 1.25 - r * 1.05 + 0.32;
    float thr = age * 0.62;
    float m = smoothstep(thr, thr + 0.16, shape);
    float rim = smoothstep(thr, thr + 0.05, shape) * (1.0 - smoothstep(thr + 0.06, thr + 0.3, shape));
    float fil = smoothstep(0.55, 0.8, wx_fbm(q * 4.0 + w * 3.0));
    a = (m * 0.5 + rim * 0.55 + fil * m * 0.25) * vCol.a * (1.0 - smoothstep(0.55, 1.0, age)) * smoothstep(0.0, 0.05, age);
    float back = pow(max(dot(vRd, uSunDir), 0.0), 3.0);
    col = vCol.rgb * (fx_amb() * 0.6 + vLight * 0.12) * (1.0 - rim * 0.5);
    col += vCol.rgb * vec3(3.0, 0.2, 0.15) * vLight * 0.05 * back * (1.0 - m * 0.5);   // thin ink glows red against the sun
    a *= fx_soft(vViewZ, 0.25);
  }
  if (a < 0.003) discard;
  col = col * vAtT + vAtS;
  gl_FragColor = vec4(col, a);
}`;

export function createSoft(app, { heightAt, interaction, pipeline }) {
  const H = heightAt;
  // fields: px py pz vx vy vz age life s0 s1 seed kind r g b a rise
  const sw = new Swarm(256, 17);
  const geo = instancedQuad(256, { iPos: 3, iData: 4, iCol: 4 }, { centered: true });
  const mat = fxMaterial({ vs: VS, fs: FS });
  app.scene.add(fxMesh(geo, mat, { order: 12, name: 'fx.soft' }));
  const _w = new THREE.Vector2();

  function puff(x, y, z, vx, vy, vz, life, s0, s1, kind, col, alpha, rise = 0) {
    const o = sw.spawn(), d = sw.d;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = 0; d[o + 7] = life; d[o + 8] = s0; d[o + 9] = s1; d[o + 10] = rnd(); d[o + 11] = kind;
    d[o + 12] = col[0]; d[o + 13] = col[1]; d[o + 14] = col[2]; d[o + 15] = alpha; d[o + 16] = rise;
  }

  const DUST = [0.42, 0.33, 0.21];
  return {
    puff,
    /** Dust puffs at pos (footfalls, dodges, landings): 4–10 soft quads, 0.3 → 1.6 m over 1.2 s. */
    dust(pos, amount = 1) {
      const n = Math.round(3 + 6 * Math.min(amount, 1.5));
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, sp = rr(0.4, 1.6) * amount;
        const s = rr(0.8, 1.3) * (0.7 + 0.5 * amount);
        puff(pos.x + Math.cos(a) * 0.15, pos.y + rr(0.05, 0.25), pos.z + Math.sin(a) * 0.15,
          Math.cos(a) * sp, rr(0.2, 0.7), Math.sin(a) * sp, rr(1.0, 1.6), 0.3 * s, 1.6 * s, 0, DUST, rr(0.14, 0.24), rr(0.05, 0.2));
      }
      interaction?.dust?.(pos.x, pos.z, 0.6 + 0.5 * amount, Math.min(amount, 1));
      pipeline?.fx?.dust?.(Math.min(0.25 * amount, 0.6));
    },
    /** Radial dust ring (shockwave). */
    ring(x, y, z, strength = 1) {
      const n = Math.round(12 + 8 * strength);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rr(-0.15, 0.15), sp = rr(5, 8) * strength;
        puff(x + Math.cos(a) * 0.6, y + rr(0.1, 0.35), z + Math.sin(a) * 0.6, Math.cos(a) * sp, rr(0.3, 1.0), Math.sin(a) * sp,
          rr(1.1, 1.7), 0.5, rr(1.6, 2.4), 0, DUST, rr(0.12, 0.2), 0.1);
      }
      pipeline?.fx?.dust?.(0.5 * strength);
    },
    mist(pos, dir, amount, ink) {
      const col = ink ? [0.012, 0.011, 0.013] : [0.16, 0.008, 0.007];
      for (let i = 0; i < 2 + Math.round(amount); i++) {
        const sp = rr(0.4, 1.2);
        puff(pos.x, pos.y, pos.z, dir.x * sp + rr(-0.2, 0.2), dir.y * sp + rr(0, 0.3), dir.z * sp + rr(-0.2, 0.2),
          rr(0.35, 0.6), 0.08, rr(0.35, 0.6) * (0.8 + 0.3 * amount), 1, col, 1);
      }
    },
    /** Ink bloom: expands 0.3 → 1.2 m over 0.7 s and dissolves. */
    bloom(pos, dir, scale = 1, ink = false) {
      const col = ink ? [0.012, 0.011, 0.014] : [0.10, 0.005, 0.006];
      const k = 0.9 + 0.3 * scale;
      puff(pos.x, pos.y, pos.z, dir.x * 0.5, dir.y * 0.5 + 0.1, dir.z * 0.5, rr(0.75, 1.0), 0.3 * k, 1.25 * k, 2, col, 0.45);
      if (scale > 1.2) puff(pos.x + dir.x * 0.35, pos.y + 0.1, pos.z + dir.z * 0.35, dir.x * 0.9, 0.2, dir.z * 0.9, rr(0.8, 1.1), 0.2 * k, 0.9 * k, 2, col, 0.35);
    },
    update(dt, t) {
      if (dt <= 0) return;
      const d = sw.d;
      for (let i = sw.n - 1; i >= 0; i--) {
        const o = i * sw.S;
        d[o + 6] += dt;
        if (d[o + 6] >= d[o + 7]) { sw.kill(o); continue; }
        const kind = d[o + 11];
        const drag = kind < 0.5 ? 3.2 : kind < 1.5 ? 3.5 : 2.5;
        const e = Math.exp(-drag * dt);
        windVector(d[o], d[o + 2], t, _w);
        const wk = (kind < 0.5 ? 0.45 : 0.25) * (1 - e);
        d[o + 3] = d[o + 3] * e + _w.x * wk; d[o + 5] = d[o + 5] * e + _w.y * wk;
        d[o + 4] = d[o + 4] * e + d[o + 16] * (1 - e);
        d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
        const gy = H(d[o], d[o + 2]) + 0.05;
        if (d[o + 1] < gy) d[o + 1] = gy;
      }
    },
    lateUpdate() {
      const P = geo.attributes.iPos.array, D = geo.attributes.iData.array, C = geo.attributes.iCol.array, d = sw.d;
      for (let i = 0; i < sw.n; i++) {
        const o = i * sw.S, a = d[o + 6] / d[o + 7];
        const g = 1 - (1 - a) ** 2.2;                         // fast early growth
        P[i * 3] = d[o]; P[i * 3 + 1] = d[o + 1]; P[i * 3 + 2] = d[o + 2];
        D[i * 4] = a; D[i * 4 + 1] = d[o + 8] + (d[o + 9] - d[o + 8]) * g; D[i * 4 + 2] = d[o + 10]; D[i * 4 + 3] = d[o + 11];
        C[i * 4] = d[o + 12]; C[i * 4 + 1] = d[o + 13]; C[i * 4 + 2] = d[o + 14]; C[i * 4 + 3] = d[o + 15];
      }
      flush(geo, sw.n, ['iPos', 'iData', 'iCol']);
    },
  };
}
