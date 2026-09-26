// One wind field for everything (bible §5.1). GPU (GLSL) and CPU (JS) evaluate the SAME function from the
// SAME noise bytes, so a gust bends the grass, the robe, the tassel and the leaves at the same instant.
// Owner: integrator. STABLE API:
//   WIND_GLSL                        — GLSL: `float windGust(vec3 wp)`, `vec3 windSway(vec3 wp, float flex, float phase)`
//                                      (needs uniforms uTime, uWind, tWindNoise → use windUniforms())
//   windUniforms()                   — { uTime, uWind, tWindNoise } shared objects for ShaderMaterials
//   windGust(x, z, t?)               — CPU mirror (t defaults to G.uTime)
//   windSway(x, z, flex, phase, t?, out?) — CPU mirror, returns THREE.Vector3 displacement direction*amount
//   windVector(x, z, t?, out?)       — THREE.Vector2: horizontal wind velocity-ish (dir * gust), for cloth/particles/audio
//   setWindStrength(k, easeSeconds)  — gameplay/environment: 0.6 calm, 1 default, 1.5 pre-duel, 2.2 boss, 2.6 spike
//   updateWind(dt)                   — call once per frame (app registers it)
import * as THREE from 'three';
import { G } from './globals.js';
import { mulberry32 } from './noise.js';
import { U } from './glsl.js';

const N = 256;

// Tileable 4-octave value fBm, two decorrelated channels (R: gust puffs, G: flutter).
function buildNoiseBytes() {
  const data = new Uint8Array(N * N * 4);
  const chan = (seed) => {
    const out = new Float32Array(N * N);
    let amp = 0.5, norm = 0;
    for (let o = 0; o < 4; o++) {
      const period = 8 << o;          // 8, 16, 32, 64 lattice cells across the tile
      const rng = mulberry32(seed + o * 101);
      const lat = new Float32Array(period * period);
      for (let i = 0; i < lat.length; i++) lat[i] = rng();
      const cell = N / period;
      for (let y = 0; y < N; y++) {
        const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
        const y0 = iy % period, y1 = (iy + 1) % period;
        for (let x = 0; x < N; x++) {
          const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
          const x0 = ix % period, x1 = (ix + 1) % period;
          const a = lat[y0 * period + x0], b = lat[y0 * period + x1], c = lat[y1 * period + x0], d = lat[y1 * period + x1];
          out[y * N + x] += amp * ((a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy);
        }
      }
      norm += amp; amp *= 0.5;
    }
    // normalise to full 0..1 range for better byte precision
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < out.length; i++) { out[i] /= norm; mn = Math.min(mn, out[i]); mx = Math.max(mx, out[i]); }
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) / (mx - mn);
    return out;
  };
  const r = chan(9001), g = chan(4242);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(r[i] * 255);
    data[i * 4 + 1] = Math.round(g[i] * 255);
    data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
  }
  return data;
}

export const WIND_BYTES = buildNoiseBytes();
const tex = new THREE.DataTexture(WIND_BYTES, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
tex.magFilter = THREE.LinearFilter;
tex.minFilter = THREE.LinearFilter;   // no mips: CPU mirror samples level 0 bilinearly
tex.generateMipmaps = false;
tex.colorSpace = THREE.NoColorSpace;
tex.needsUpdate = true;
G.tWindNoise.value = tex;

/** Bilinear sample of the noise bytes, matching GPU LinearFilter + RepeatWrapping. channel 0 = R, 1 = G. */
export function sampleWindNoise(u, v, channel = 0) {
  const x = u * N - 0.5, y = v * N - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const x0 = ((ix % N) + N) % N, x1 = (x0 + 1) % N, y0 = ((iy % N) + N) % N, y1 = (y0 + 1) % N;
  const a = WIND_BYTES[(y0 * N + x0) * 4 + channel], b = WIND_BYTES[(y0 * N + x1) * 4 + channel];
  const c = WIND_BYTES[(y1 * N + x0) * 4 + channel], d = WIND_BYTES[(y1 * N + x1) * 4 + channel];
  return ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) / 255;
}

export const WIND_GLSL = /* glsl */`
#ifndef WX_WIND
#define WX_WIND
${U('float', 'uTime')}${U('vec4', 'uWind')}${U('sampler2D', 'tWindNoise')}// gust fronts: λ≈126 m, travelling downwind; cat's-paw puffs 5–15 m drifting at 9 m/s
float windGust(vec3 wp) {
  float along = dot(wp.xz, uWind.xy);
  float g = 0.55 + 0.45 * sin(uTime * 0.6 - along * 0.05) * (0.6 + 0.4 * sin(uTime * 0.19 + wp.x * 0.011 - wp.z * 0.013));
  float n = texture2D(tWindNoise, (wp.xz - uWind.xy * uTime * 9.0) / 46.0).r;
  return max(g * (0.6 + 0.8 * n), 0.08) * uWind.z;
}
// sway wave travels DOWNWIND (−k·along); returns a world-space horizontal displacement direction * amount
vec3 windSway(vec3 wp, float flex, float phase) {
  float g = windGust(wp), t = uTime, along = dot(wp.xz, uWind.xy);
  float s = sin(t * 1.7 - along * 0.7 + phase) * 0.55 + sin(t * 2.9 - along * 1.3 + phase * 1.9) * 0.20;
  vec3 dir = vec3(uWind.x, 0.0, uWind.y), side = vec3(-uWind.y, 0.0, uWind.x);
  return (dir * (0.55 + s) * g + side * sin(t * 1.7 + phase * 2.3) * 0.18 * g) * flex;
}
// high-frequency flutter (leaves, cloth edges): -1..1
float windFlutter(vec3 wp, float t) {
  return texture2D(tWindNoise, wp.xz / 7.0 + vec2(t * 0.9, t * 0.37)).g * 2.0 - 1.0;
}
#endif
`;

export function windUniforms() {
  return { uTime: G.uTime, uWind: G.uWind, tWindNoise: G.tWindNoise };
}

export function windGust(x, z, t = G.uTime.value) {
  const w = G.uWind.value;
  const along = x * w.x + z * w.y;
  const g = 0.55 + 0.45 * Math.sin(t * 0.6 - along * 0.05) * (0.6 + 0.4 * Math.sin(t * 0.19 + x * 0.011 - z * 0.013));
  const n = sampleWindNoise((x - w.x * t * 9.0) / 46.0, (z - w.y * t * 9.0) / 46.0, 0);
  return Math.max(g * (0.6 + 0.8 * n), 0.08) * w.z;
}

export function windSway(x, z, flex = 1, phase = 0, t = G.uTime.value, out = new THREE.Vector3()) {
  const w = G.uWind.value;
  const g = windGust(x, z, t), along = x * w.x + z * w.y;
  const s = Math.sin(t * 1.7 - along * 0.7 + phase) * 0.55 + Math.sin(t * 2.9 - along * 1.3 + phase * 1.9) * 0.2;
  const side = Math.sin(t * 1.7 + phase * 2.3) * 0.18 * g;
  const a = (0.55 + s) * g;
  return out.set((w.x * a - w.y * side) * flex, 0, (w.y * a + w.x * side) * flex);
}

export function windFlutter(x, z, t = G.uTime.value) {
  return sampleWindNoise(x / 7 + t * 0.9, z / 7 + t * 0.37, 1) * 2 - 1;
}

export function windVector(x, z, t = G.uTime.value, out = new THREE.Vector2()) {
  const w = G.uWind.value, g = windGust(x, z, t);
  return out.set(w.x * g, w.y * g);
}

const ease = { from: 1, to: 1, t: 0, dur: 0 };
export function setWindStrength(k, easeSeconds = 0.6) {
  Object.assign(ease, { from: G.uWind.value.z, to: k, t: 0, dur: Math.max(easeSeconds, 1e-3) });
}
export function updateWind(dt) {
  if (ease.t < ease.dur) {
    ease.t = Math.min(ease.dur, ease.t + dt);
    const u = ease.t / ease.dur;
    G.uWind.value.z = ease.from + (ease.to - ease.from) * (u * u * (3 - 2 * u));
  }
}
