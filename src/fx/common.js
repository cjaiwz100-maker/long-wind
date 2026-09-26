// Shared VFX plumbing (X): GLSL helpers (soft depth vs the opaque snapshot, virtual lamps, ambient), a tiny
// struct-of-arrays particle swarm with swap-remove, and instanced-geometry builders.
// Every effect: CPU ring buffer → one InstancedBufferGeometry → one draw on LAYERS.TRANSPARENT (or MAIN_ONLY for
// alpha-tested opaque bits), lit from G.uSunCol / sky / lamps and fogged through ATMOS_GLSL.
import * as THREE from 'three';
import { G, LAYERS } from '../core/globals.js';
import { U } from '../core/glsl.js';

// pipeline-owned shared uniforms may not exist when a standalone module is imported first
G.tSceneCopy ??= { value: null };
G.uCamNearFar ??= { value: new THREE.Vector2(0.3, 7000) };

/** Both stages: lamps, ambient, sun helpers. Include AFTER ATMOS_GLSL. */
export const FX_COMMON = /* glsl */`
#ifndef WX_FX_COMMON
#define WX_FX_COMMON
${U('vec2', 'uResolution')}${U('vec4', 'uLamps', '[8]')}${U('vec3', 'uLampC', '[8]')}${U('int', 'uLampN')}
${U('float', 'uLampOn')}${U('vec3', 'uSkyUp')}${U('vec3', 'uAmbK')}${U('float', 'uNight')}${U('float', 'uRain')}
${U('float', 'uSunVis')}
// virtual lamps (same falloff as the lit materials: w / (d² + .35), 30 m cut), as irradiance / π
vec3 fx_lamps(vec3 wp) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uLampN) break;
    vec4 lp = uLamps[i];
    vec3 d = lp.xyz - wp; float d2 = dot(d, d);
    if (d2 > 900.0 || lp.w <= 0.0) continue;
    s += uLampC[i] * (lp.w * uLampOn / (d2 + 0.35) * (1.0 - smoothstep(400.0, 900.0, d2)));
  }
  return s * 0.3183;
}
// sky ambient for small diffuse bits (hemisphere average)
vec3 fx_amb() { return (uSkyUp * 0.85 + uFogCool * 0.25) * uAmbK; }
// hue of the key light at unit peak: golden (1,.63,.31) at sunset, cold at blue hour
vec3 fx_sunHue() { return uSunCol / max(max(uSunCol.r, max(uSunCol.g, uSunCol.b)), 1e-3); }
float fx_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// HDR blade/qi core colour: warm white in daylight, steel-white at blue hour/night
vec3 fx_hotCore() { return mix(mix(vec3(1.0, 0.86, 0.66), fx_sunHue() * vec3(1.0, 1.1, 1.3), 0.25), vec3(0.8, 0.9, 1.0), clamp(uNight, 0.0, 1.0)); }
#endif
`;

/** Fragment stage only: screen uv and soft-depth against the half-res opaque snapshot (a = linear depth, m). */
export const FX_FRAG = /* glsl */`
#ifndef WX_FX_FRAG
#define WX_FX_FRAG
${U('sampler2D', 'tSceneCopy')}
vec2 fx_screenUv() { return gl_FragCoord.xy / uResolution; }
float fx_sceneZ(vec2 uv) { float z = texture2D(tSceneCopy, uv).a; return z <= 0.0 ? 1e5 : z; }
float fx_soft(float viewZ, float range) { return clamp((fx_sceneZ(fx_screenUv()) - viewZ) / range, 0.0, 1.0); }
#endif
`;

/** Shared uniforms for a VFX ShaderMaterial (G by reference) plus locals. */
export function fxUniforms(local = {}) {
  return { ...G, ...local };
}

/** Standard transparent VFX material. */
export function fxMaterial({ vs, fs, uniforms = {}, additive = false, blending, depthTest = true, depthWrite = false,
  side = THREE.DoubleSide, defines = {}, transparent = true, alphaToCoverage = false }) {
  const m = new THREE.ShaderMaterial({
    vertexShader: vs, fragmentShader: fs, uniforms: fxUniforms(uniforms), defines,
    transparent, depthTest, depthWrite, side, alphaToCoverage,
    blending: blending ?? (additive ? THREE.AdditiveBlending : THREE.NormalBlending),
  });
  m.fog = false; m.lights = false; m.toneMapped = false;
  return m;
}

/** Mesh helper: layer, no culling (instances move), render order. */
export function fxMesh(geo, mat, { layer = LAYERS.TRANSPARENT, order = 0, name } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.layers.set(layer);
  m.frustumCulled = false;
  m.renderOrder = order;
  m.castShadow = false; m.receiveShadow = false;
  m.matrixAutoUpdate = false;
  if (name) m.name = name;
  return m;
}

/** Instanced quad (corners x∈{-1,1}, y∈{0,1} or centered) with dynamic per-instance attributes. */
export function instancedQuad(capacity, attrs, { centered = false, rows = 1 } = {}) {
  const g = new THREE.InstancedBufferGeometry();
  const pos = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    pos.push(-1, centered ? v * 2 - 1 : v, 0, 1, centered ? v * 2 - 1 : v, 0);
    if (r < rows) { const a = r * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  for (const [name, size] of Object.entries(attrs)) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
  }
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

/** Struct-of-arrays particle store. spawn() → base offset; kill(offset) swap-removes (iterate backwards). */
export class Swarm {
  constructor(cap, stride) {
    this.cap = cap; this.S = stride; this.d = new Float32Array(cap * stride); this.n = 0; this.rr = 0;
  }
  spawn() {
    if (this.n < this.cap) return (this.n++) * this.S;
    this.rr = (this.rr + 1) % this.cap;                 // full: recycle round-robin (oldest-ish)
    return this.rr * this.S;
  }
  kill(o) {
    const last = (--this.n) * this.S;
    if (o !== last) this.d.copyWithin(o, last, last + this.S);
  }
}

/** Mark instanced attributes dirty for n instances. */
export function flush(geo, n, names) {
  geo.instanceCount = n;
  if (!n) return;
  for (const k of names) {
    const a = geo.attributes[k];
    a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true;
  }
}

// small deterministic RNG for effects (visual only; gameplay determinism unaffected)
let _s = 0x9e3779b9;
export function rnd() { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; return ((_s >>> 0) % 1e7) / 1e7; }
export const rr = (a, b) => a + (b - a) * rnd();

/** Random unit vector inside a cone of half-angle `ang` around unit `axis`. */
export function coneDir(axis, ang, out) {
  const ct = 1 - rnd() * (1 - Math.cos(ang)), st = Math.sqrt(1 - ct * ct), ph = rnd() * Math.PI * 2;
  // orthonormal basis
  const ax = axis.x, ay = axis.y, az = axis.z;
  let tx, ty, tz;
  if (Math.abs(ay) < 0.9) { tx = -az; ty = 0; tz = ax; } else { tx = 0; ty = az; tz = -ay; }
  const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  const bx = ay * tz - az * ty, by = az * tx - ax * tz, bz = ax * ty - ay * tx;
  const c = Math.cos(ph) * st, s = Math.sin(ph) * st;
  return out.set(ax * ct + tx * c + bx * s, ay * ct + ty * c + by * s, az * ct + tz * c + bz * s);
}
