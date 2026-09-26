// Shared helpers for every vegetation module (grass, flowers, plumes, trees). Owner: vegetation (V).
//   sunTermsSetup()            — how a foliage shader gets the SHADOWED sun (colour + view-space direction):
//                                uses S's global `gSunColor/gSunDir` when chunks.js provides them, otherwise a local
//                                capture spliced into three's directional-light loop (brightest directional light,
//                                after getShadow), so translucency never leaks into tree/actor shadows.
//                                → { key, lightsChunk, sunC, sunD }  (put lightsChunk where `#include <lights_fragment_begin>` was)
//   FOLIAGE_NORMAL_BEGIN       — replacement for normal_fragment_begin: authored normal, no double-side flip
//   dilateAlpha(ctx, w, h, passes = 6) — reference `Jc` alpha dilation so mipmapped cut-outs never get dark halos
//   canvasTexture(canvas, { srgb, mips, aniso }) → THREE.CanvasTexture ; makeCanvas(w, h)
//   ROT_SCALE_INV_GLSL         — GLSL `mat3 wx_invRotScale(mat3 m)` for instance matrices made of rotY·uniform scale
//   vegGround(app)             — ONE shared terrain binding for all GPU vegetation: uniforms {tGH, tGG, uHRect, uGRect,
//                                uGreenMode} pointing at W's G.tHeight/tGround (or a local fallback bake from
//                                app.world.heightAt when the bakes are missing), re-bound automatically when they arrive.
//   VEG_GROUND_GLSL            — GLSL: float gxHeight(vec2 xz) (manual bilinear), vec4 gxGround(vec2 xz)
//   VEG_PUSH_GLSL              — GLSL: vec2 vegPush(vec2 root, float baseY, float H, vec4 im, vec2 iuv, inout float contact)
//                                actors + lens + trample gradient + shock rings + slash gusts, in bend radians (xz)
//   VEG_INTERACT_PARS          — guarded uniform declarations for tInteract/uInteractRect/uActors/uShock/uSlash/uCamGround
//   vegInteractUniforms()      — the matching shared G objects
//   FLOWER_PATCH_GLSL          — float vegFlowerPatch(vec2 xz, out float core): wildflower meadows (grass thins there)
//   TileRing                   — camera-following tile picker for GPU-procedural layers (one draw call per ring)
import * as THREE from 'three';
import { G } from '../core/globals.js';
import { U } from '../core/glsl.js';
import { noise } from '../core/noise.js';

let _setup = null;

/** Detect S's sun capture once (installChunks runs before any scene builds materials). */
export function sunTermsSetup() {
  if (_setup) return _setup;
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const pars = THREE.ShaderChunk.lights_pars_begin;
  if (/gSunColor\s*=/.test(src) && /gSunColor/.test(pars + src)) {
    _setup = { key: 'sunS', lightsChunk: '#include <lights_fragment_begin>', sunC: 'gSunColor', sunD: 'gSunDir' };
    return _setup;
  }
  const at = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const re = at >= 0 ? src.indexOf('RE_Direct( directLight', at) : -1;
  if (re < 0) {
    // unknown three layout: fall back to the unshadowed global sun (world → view space)
    _setup = {
      key: 'sunG',
      lightsChunk: '#include <lights_fragment_begin>\nvec3 wxSunC = uSunCol * 0.59 * uSunVis; vec3 wxSunD = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);',
      sunC: 'wxSunC', sunD: 'wxSunD', needsGlobals: true,
    };
    return _setup;
  }
  const cap = '{ float wxL = dot( directionalLights[ i ].color, vec3( 0.2126, 0.7152, 0.0722 ) ); ' +
    'if ( wxL > wxSunBest ) { wxSunBest = wxL; wxSunC = directLight.color; wxSunD = directLight.direction; } }\n\t\t';
  const chunk = 'vec3 wxSunC = vec3( 0.0 ); vec3 wxSunD = vec3( 0.0, 1.0, 0.0 ); float wxSunBest = -1.0;\n' +
    src.slice(0, re) + cap + src.slice(re);
  _setup = { key: 'sunF', lightsChunk: chunk, sunC: 'wxSunC', sunD: 'wxSunD' };
  return _setup;
}

/** Uniforms + declarations a hook needs when sunTermsSetup() fell back to the global (unshadowed) sun. */
export function sunGlobalsPars(sun) {
  return sun.needsGlobals ? U('vec3', 'uSunCol') + U('vec3', 'uSunDir') + U('float', 'uSunVis') : '';
}
export function sunGlobalsUniforms(sun) {
  return sun.needsGlobals ? { uSunCol: G.uSunCol, uSunDir: G.uSunDir, uSunVis: G.uSunVis } : {};
}

export const FOLIAGE_NORMAL_BEGIN = /* glsl */`
float faceDirection = 1.0;
vec3 normal = normalize( vNormal );
vec3 nonPerturbedNormal = normal;
`;

/** For rotY · uniform-scale instance matrices: inverse = transpose / s². Avoids a per-vertex inverse(). */
export const ROT_SCALE_INV_GLSL = /* glsl */`
mat3 wx_invRotScale(mat3 m) { return transpose(m) / max(dot(m[0], m[0]), 1e-8); }
`;

/**
 * Alpha dilation (reference `Jc`): transparent texels next to opaque ones take the average colour of their opaque
 * 4-neighbours, repeated `passes` times, then alpha is restored. Mip levels of cut-out cards then keep the right hue.
 */
export function dilateAlpha(ctx, w, h, passes = 6) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = d[i * 4 + 3];
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = alpha[i] > 8 ? 1 : 0;
  const next = new Uint8Array(w * h);
  for (let p = 0; p < passes; p++) {
    next.set(filled);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        if (x > 0 && filled[i - 1]) { r += d[(i - 1) * 4]; g += d[(i - 1) * 4 + 1]; b += d[(i - 1) * 4 + 2]; n++; }
        if (x < w - 1 && filled[i + 1]) { r += d[(i + 1) * 4]; g += d[(i + 1) * 4 + 1]; b += d[(i + 1) * 4 + 2]; n++; }
        if (y > 0 && filled[i - w]) { r += d[(i - w) * 4]; g += d[(i - w) * 4 + 1]; b += d[(i - w) * 4 + 2]; n++; }
        if (y < h - 1 && filled[i + w]) { r += d[(i + w) * 4]; g += d[(i + w) * 4 + 1]; b += d[(i + w) * 4 + 2]; n++; }
        if (n) { d[i * 4] = r / n; d[i * 4 + 1] = g / n; d[i * 4 + 2] = b / n; next[i] = 1; }
      }
    }
    filled.set(next);
  }
  // any texel never reached takes the global average of opaque texels
  let ar = 0, ag = 0, ab = 0, an = 0;
  for (let i = 0; i < w * h; i++) if (alpha[i] > 8) { ar += d[i * 4]; ag += d[i * 4 + 1]; ab += d[i * 4 + 2]; an++; }
  if (an) { ar /= an; ag /= an; ab /= an; }
  for (let i = 0; i < w * h; i++) {
    if (!filled[i]) { d[i * 4] = ar; d[i * 4 + 1] = ag; d[i * 4 + 2] = ab; }
    d[i * 4 + 3] = alpha[i];
  }
  ctx.putImageData(img, 0, 0);
}

export function canvasTexture(canvas, { srgb = true, mips = true, aniso = 4, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  // canvas pixels are straight alpha after dilation: never premultiply on upload
  t.premultiplyAlpha = false;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ------------------------------------------------------------------------------------------------ terrain binding
/** Height (R32F) + ground info (RGBA8) around the origin from app.world.* when the world bakes are missing. */
function bakeFallback(app, half = 320, res = 512) {
  const heightAt = app.world.heightAt, pathAt = app.world.pathAt;
  const n = res, step = (half * 2) / n;
  const hts = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < n; i++) hts[j * n + i] = heightAt(-half + (i + 0.5) * step, z);
  }
  // box blurs of the height for cavity AO (≈3.5 m and ≈11 m)
  const blur = (src, rad) => {
    const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      let acc = 0, cnt = 0;
      for (let i = -rad; i <= rad; i++) if (i >= 0 && i < n) { acc += src[j * n + i]; cnt++; }
      for (let i = 0; i < n; i++) {
        tmp[j * n + i] = acc / cnt;
        const a = i - rad, b = i + rad + 1;
        if (a >= 0) { acc -= src[j * n + a]; cnt--; }
        if (b < n) { acc += src[j * n + b]; cnt++; }
      }
    }
    for (let i = 0; i < n; i++) {
      let acc = 0, cnt = 0;
      for (let j = -rad; j <= rad; j++) if (j >= 0 && j < n) { acc += tmp[j * n + i]; cnt++; }
      for (let j = 0; j < n; j++) {
        out[j * n + i] = acc / cnt;
        const a = j - rad, b = j + rad + 1;
        if (a >= 0) { acc -= tmp[a * n + i]; cnt--; }
        if (b < n) { acc += tmp[b * n + i]; cnt++; }
      }
    }
    return out;
  };
  const b1 = blur(hts, Math.max(1, Math.round(3.5 / step))), b2 = blur(hts, Math.max(2, Math.round(11 / step)));
  const gnd = new Uint8Array(n * n * 4);
  const sm = THREE.MathUtils.smoothstep;
  for (let j = 0; j < n; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * step, k = j * n + i;
      const h = hts[k];
      const hx = hts[j * n + Math.min(n - 1, i + 1)] - hts[j * n + Math.max(0, i - 1)];
      const hz = hts[Math.min(n - 1, j + 1) * n + i] - hts[Math.max(0, j - 1) * n + i];
      const slope = Math.hypot(hx, hz) / (2 * step);
      const cav = 1 - Math.min(0.55, Math.max(0, (b1[k] - h) * 0.2 + (b2[k] - h) * 0.035));
      let road = 0;
      if (pathAt) { const p = pathAt(x, z); if (p) road = 1 - sm(p.dist, p.width * 0.55, p.width * 0.55 + 1.6); }
      const rock = sm(slope, 0.55, 0.9);
      const patch = noise.fbm2(x * 0.05, z * 0.05, 2);
      const dens = (1 - rock) * (1 - road) * (0.62 + 0.38 * sm(patch, -0.5, 0.3));
      const r = Math.hypot(x, z);
      const knollPad = sm(r, 18, 8);
      const moist = Math.min(1, Math.max(0, (1 - cav) * 1.6 + 0.3 * noise.fbm2(x * 0.01 + 7, z * 0.01, 2)));
      const hf = (0.35 + 0.65 * sm(noise.fbm2(x * 0.02 - 3, z * 0.02 + 9, 2) + moist * 0.4, -0.2, 0.6)) * (1 - 0.6 * knollPad);
      gnd[k * 4] = Math.round(dens * 255);
      gnd[k * 4 + 1] = Math.round(Math.min(1, hf) * 255);
      gnd[k * 4 + 2] = Math.round(moist * 255);
      gnd[k * 4 + 3] = Math.round(cav * 255);
    }
  }
  const tH = new THREE.DataTexture(hts, n, n, THREE.RedFormat, THREE.FloatType);
  tH.minFilter = tH.magFilter = THREE.NearestFilter;
  tH.generateMipmaps = false; tH.needsUpdate = true; tH.name = 'vegFallbackHeight';
  const tG = new THREE.DataTexture(gnd, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tG.minFilter = tG.magFilter = THREE.LinearFilter;
  tG.generateMipmaps = false; tG.needsUpdate = true; tG.name = 'vegFallbackGround';
  const rect = new THREE.Vector4(-half, -half, half * 2, 1 / (half * 2));
  return { tH, tG, rect };
}

const _grounds = new WeakMap();

/**
 * The shared terrain binding (one per app). `uniforms` are shared by reference into every vegetation material.
 * uGreenMode = 1 when tGG is W's bake (B = late-green weight), 0 for the fallback (B = moisture).
 */
export function vegGround(app) {
  let g = _grounds.get(app);
  if (g) return g;
  const uniforms = {
    tGH: { value: null }, tGG: { value: null },
    uHRect: { value: new THREE.Vector4() }, uGRect: { value: new THREE.Vector4() },
    uGreenMode: { value: 0 },
  };
  let fallback = null;
  function bind() {
    const hasH = !!G.tHeight.value, hasG = !!G.tGround.value;
    if ((!hasH || !hasG) && !fallback) fallback = bakeFallback(app);
    if (hasH) { uniforms.tGH.value = G.tHeight.value; uniforms.uHRect.value.copy(G.uWorldRect.value); }
    else { uniforms.tGH.value = fallback.tH; uniforms.uHRect.value.copy(fallback.rect); }
    if (hasG) { uniforms.tGG.value = G.tGround.value; uniforms.uGRect.value.copy(G.uWorldRect.value); uniforms.uGreenMode.value = 1; }
    else { uniforms.tGG.value = fallback.tG; uniforms.uGRect.value.copy(fallback.rect); uniforms.uGreenMode.value = 0; }
  }
  bind();
  g = {
    uniforms,
    get usingFallback() { return uniforms.tGG.value === fallback?.tG || uniforms.tGH.value === fallback?.tH; },
    update() {
      if ((G.tHeight.value && uniforms.tGH.value !== G.tHeight.value) || (G.tGround.value && uniforms.tGG.value !== G.tGround.value)) bind();
    },
  };
  app.add({ update: g.update });
  _grounds.set(app, g);
  return g;
}

export const VEG_GROUND_GLSL = /* glsl */`
#ifndef VEG_GROUND
#define VEG_GROUND
uniform sampler2D tGH;        // ground height (R32F, manual bilinear)
uniform sampler2D tGG;        // ground info: R density, G height factor, B late-green / moisture, A cavity
uniform vec4 uHRect, uGRect;  // x0, z0, size, 1/size of tGH / tGG
uniform float uGreenMode;
float gxHeight(vec2 xz) {
  vec2 uv = (xz - uHRect.xy) * uHRect.w;
  ivec2 sz = textureSize(tGH, 0);
  vec2 p = uv * vec2(sz) - 0.5;
  vec2 fl = floor(p);
  vec2 f = p - fl;
  ivec2 i = clamp(ivec2(fl), ivec2(0), sz - 2);
  float a = texelFetch(tGH, i, 0).r, b = texelFetch(tGH, i + ivec2(1, 0), 0).r;
  float c = texelFetch(tGH, i + ivec2(0, 1), 0).r, d = texelFetch(tGH, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec4 gxGround(vec2 xz) {
  vec2 uv = (xz - uGRect.xy) * uGRect.w;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0, 0.5, 0.0, 1.0);
  return textureLod(tGG, uv, 0.0);
}
#endif
`;

export const VEG_INTERACT_PARS = /* glsl */`
${U('sampler2D', 'tInteract')}${U('vec4', 'uInteractRect')}
${U('vec4', 'uActors', '[8]')}${U('vec4', 'uShock', '[4]')}${U('vec4', 'uSlash', '[4]')}${U('vec4', 'uSlashB', '[4]')}
${U('vec3', 'uCamGround')}${U('float', 'uTime')}${U('vec4', 'uWind')}
`;

export function vegInteractUniforms() {
  return {
    tInteract: G.tInteract, uInteractRect: G.uInteractRect, uActors: G.uActors, uShock: G.uShock,
    uSlash: G.uSlash, uSlashB: G.uSlashB, uCamGround: G.uCamGround, uTime: G.uTime, uWind: G.uWind,
  };
}

/**
 * Bend (radians, xz direction) from everything that pushes vegetation, bible §5.5–5.6. `im` = tInteract at the root,
 * `iuv` its uv. `contact` receives the actor-contact AO weight (0..1). `reach` scales actor radii (tall plants: >1).
 */
export const VEG_PUSH_GLSL = /* glsl */`
#ifndef VEG_PUSH
#define VEG_PUSH
vec2 vegPush(vec2 root, float baseY, float H, vec4 im, vec2 iuv, float reach, inout float contact) {
  vec2 push = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 a = uActors[i];
    if (a.w <= 0.0) continue;
    vec2 d = root - a.xz;
    float dl = length(d);
    float R = (a.w * 1.35 + 0.3 * H) * reach;
    float f = (1.0 - smoothstep(0.25 * R, R, dl)) * step(a.y - baseY, 1.6 + H);
    push += (d / max(dl, 1e-3)) * f * 1.25;
    contact = max(contact, exp(-(dl * dl) / 0.49));
  }
  if (uCamGround.z > 0.0) {
    vec2 d = root - uCamGround.xy; float dl = length(d);
    push += d / max(dl, 1e-3) * (1.0 - smoothstep(uCamGround.z, uCamGround.z * 2.4, dl)) * 0.9;
  }
  if (im.r > 0.01) {
    float e = 0.1875 * uInteractRect.w;
    float gx = textureLod(tInteract, iuv + vec2(e, 0.0), 0.0).r - textureLod(tInteract, iuv - vec2(e, 0.0), 0.0).r;
    float gz = textureLod(tInteract, iuv + vec2(0.0, e), 0.0).r - textureLod(tInteract, iuv - vec2(0.0, e), 0.0).r;
    vec2 gr = vec2(gx, gz);
    vec2 tdir = length(gr) > 0.02 ? -normalize(gr) : normalize(uWind.xy + vec2(0.31, -0.17));
    push += tdir * im.r * 1.3;
  }
  for (int i = 0; i < 4; i++) {
    vec4 s = uShock[i];
    float age = uTime - s.z;
    if (age < 0.0 || age > 0.9) continue;
    vec2 d = root - s.xy; float dl = length(d);
    float ring = exp(-pow((dl - 9.0 * age) / 1.2, 2.0));
    float k = 1.0 - age / 0.9;
    push += d / max(dl, 1e-3) * s.w * k * k * ring * 1.2;
  }
  for (int i = 0; i < 4; i++) {
    vec4 c = uSlash[i]; vec4 sb = uSlashB[i];
    float age = uTime - sb.x;
    if (age < 0.0 || age > 0.6) continue;
    vec2 pa = root - c.xy, ba = c.zw - c.xy;
    float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    vec2 dv = pa - ba * hh; float dl = length(dv);
    if (dl > 2.5) continue;
    float a2 = clamp((age - hh * 0.12) / 0.35, 0.0, 1.0);
    float pulse = sin(3.14159 * a2) * exp(-dl / 1.2) * (1.0 - smoothstep(1.8, 2.5, dl));
    vec2 nrm = dl > 1e-3 ? dv / dl : normalize(vec2(-ba.y, ba.x) + 1e-4);
    push += nrm * sb.y * pulse * 1.1 / (1.0 + max(sb.z - 0.6, 0.0) * 0.7);
  }
  return push;
}
vec4 vegInteractAt(vec2 root, out vec2 iuv) {
  iuv = (root - uInteractRect.xy) * uInteractRect.w;
  bool inMap = all(greaterThan(iuv, vec2(0.004))) && all(lessThan(iuv, vec2(0.996)));
  return inMap ? textureLod(tInteract, iuv, 0.0) : vec4(0.0);
}
#endif
`;

/**
 * Wildflower meadows: noise patches of ~10–18 m (bible §5.7) plus the story patches from LAYOUT (uFlowerSpots:
 * x, z, radius, strength). Returns 0..1 patch weight; `core` (0..1) marks patch cores where higanbana grows.
 * The grass reads the same function and grows shorter / sparser inside meadows, so flowers stand clear of it.
 * Needs GLSL_NOISE (wx_vnoise).
 */
export const FLOWER_PATCH_GLSL = /* glsl */`
#ifndef VEG_FLOWER_PATCH
#define VEG_FLOWER_PATCH
${U('vec4', 'uFlowerSpots', '[6]')}
float vegFlowerPatch(vec2 xz, out float core) {
  float n = wx_vnoise(xz * 0.075 + vec2(9.1, -3.3)) * 0.62 + wx_vnoise(xz * 0.19 + vec2(-4.7, 7.9)) * 0.38;
  float region = wx_vnoise(xz * 0.013 + vec2(2.3, 5.7));             // some hillsides bloom, some don't
  float p = smoothstep(0.6, 0.78, n + (region - 0.5) * 0.28);
  // red spider lily cores in ~1/3 of the noise meadows
  core = smoothstep(0.74, 0.86, n) * smoothstep(0.52, 0.64, wx_vnoise(xz * 0.021 + vec2(-8.0, 1.0)));
  for (int i = 0; i < 6; i++) {
    vec4 s = uFlowerSpots[i];
    if (s.z <= 0.0) continue;
    float d = length(xz - s.xy) / s.z;
    if (d > 1.2) continue;
    float e = (0.85 + 0.3 * wx_vnoise(xz * 0.6 + float(i) * 7.0)) - d;   // ragged patch edge
    float w = smoothstep(0.0, 0.35, e) * s.w;
    p = max(p, w);
    core = max(core, w);
  }
  return p;
}
#endif
`;

/** LAYOUT higanbana patches → vec4 uFlowerSpots[6] (x, z, r, strength). Shared object (grass + flowers). */
export const flowerSpots = { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) };
G.uFlowerSpots ??= flowerSpots;
export function setFlowerSpots(list = []) {
  for (let i = 0; i < 6; i++) {
    const s = list[i];
    if (s) flowerSpots.value[i].set(s.x, s.z, s.r, s.strength ?? 1); else flowerSpots.value[i].set(0, 0, 0, 0);
  }
}
// story patches (graves, stele) from the world layout; optional so vegetation never depends on W being importable
const LAYOUT = (await import('./layout.js').catch(() => null))?.LAYOUT;
export const VEG_LAYOUT = LAYOUT ?? null;
setFlowerSpots(LAYOUT?.higanbana ?? [{ x: -10.5, z: -25.5, r: 7 }, { x: 6.5, z: 5.5, r: 2.6 }, { x: -26, z: -12, r: 4 }]);

// ------------------------------------------------------------------------------------------------ tile ring
/**
 * Camera-following tiles for GPU-procedural layers (bible §5.2): tiles of `tile` metres whose squares intersect the
 * annulus [ring[0], ring[3]] and the frustum (AABB from a cached coarse height range + `pad` metres of plant height),
 * sorted near → far and capped. uniforms: uTiles (vec4[max]: xy origin, z size), uK (slots per tile edge), uRing.
 */
export class TileRing {
  constructor(app, { tile, k, ring, cap = 64, max = 64, pad = 1.8 }) {
    this.app = app;
    this.tile = tile; this.k0 = k; this.ring = ring.slice(); this.cap = Math.min(cap, max); this.pad = pad;
    this.uniforms = {
      uTiles: { value: Array.from({ length: max }, () => new THREE.Vector4(0, 0, tile, 0)) },
      uK: { value: k },
      uRing: { value: new THREE.Vector4(...ring) },
    };
    this.cand = Array.from({ length: 2048 }, () => ({ x: 0, z: 0, d: 0 }));
    this.list = [];
    this.count = 0;
    this.hCache = new Map();
    this._box = new THREE.Box3();
  }
  setRing(ring) { this.ring = ring.slice(); this.uniforms.uRing.value.set(...ring); }
  setDensity(k) { this.uniforms.uK.value = Math.max(2, Math.round(this.k0 * Math.sqrt(Math.max(0.05, k)))); }
  get perTile() { const k = this.uniforms.uK.value; return k * k; }
  range(i, j) {
    const key = (i + 32768) * 65536 + (j + 32768);
    let r = this.hCache.get(key);
    if (!r) {
      const S = this.tile, h = this.app.world.heightAt;
      let lo = Infinity, hi = -Infinity;
      for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) {
        const y = h(i * S + (a / 4) * S, j * S + (b / 4) * S);
        if (y < lo) lo = y; if (y > hi) hi = y;
      }
      r = { lo: lo - 0.3, hi: hi + 0.3 };
      if (this.hCache.size > 20000) this.hCache.clear();
      this.hCache.set(key, r);
    }
    return r;
  }
  /** Pick tiles around `cam` inside `frustum`. Returns the tile count (instanceCount = count × perTile). */
  select(cam, frustum) {
    const S = this.tile, cx = cam.x, cz = cam.z;
    const rIn = this.ring[0] - 2, rOut = this.ring[3] + 0.5;
    const i0 = Math.floor((cx - rOut) / S), i1 = Math.floor((cx + rOut) / S);
    const j0 = Math.floor((cz - rOut) / S), j1 = Math.floor((cz + rOut) / S);
    const list = this.list;
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x0 = i * S, z0 = j * S;
        const dx = Math.max(x0 - cx, 0, cx - x0 - S), dz = Math.max(z0 - cz, 0, cz - z0 - S);
        const dmin = Math.hypot(dx, dz);
        if (dmin > rOut) continue;
        const fx = Math.max(Math.abs(x0 - cx), Math.abs(x0 + S - cx)), fz = Math.max(Math.abs(z0 - cz), Math.abs(z0 + S - cz));
        if (Math.hypot(fx, fz) < rIn) continue;
        const r = this.range(i, j);
        this._box.min.set(x0 - 0.8, r.lo, z0 - 0.8);
        this._box.max.set(x0 + S + 0.8, r.hi + this.pad, z0 + S + 0.8);
        if (!frustum.intersectsBox(this._box)) continue;
        if (n >= this.cand.length) break;
        const c = this.cand[n];
        c.x = x0; c.z = z0; c.d = dmin;
        list[n] = c;
        n++;
      }
    }
    list.length = n;
    list.sort(byDist);
    const m = Math.min(n, this.cap);
    const arr = this.uniforms.uTiles.value;
    for (let q = 0; q < m; q++) arr[q].set(list[q].x, list[q].z, S, 0);
    this.count = m;
    return m;
  }
}
const byDist = (a, b) => a.d - b.d;

/** Frustum of a camera (reuses the objects passed in). */
export function cameraFrustum(camera, frustum, pv) {
  camera.updateMatrixWorld();
  pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(pv);
  return frustum;
}
