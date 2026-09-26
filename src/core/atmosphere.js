// Atmosphere (aerial perspective + height fog + ground mist + sun in-scatter + cloud shadow) shared by EVERY lit
// surface, plus a tiny composable shader-hook system for three.js built-in materials. Owner: sky/lighting (S).
//
// STABLE API:
//   ATMOS_GLSL            GLSL (self-contained, guarded): uniforms + helpers, safe to include next to <common>:
//     vec3  wx_applyAtmosphere(vec3 col, vec3 wpos)      full aerial perspective (height fog + haze + ground mist)
//     vec3  wx_applyAtmosphereT(vec3 col, vec3 wpos, float mistTau)   same with a precomputed mist depth (per-vertex)
//     vec3  wx_skyFogColor(vec3 rd)     in-scatter colour along a view ray == the sky dome's horizon colour (seamless)
//     vec3  wx_fogBase(vec3 rd)         directional warm/cool fog colour without the sun lobes
//     vec3  wx_sunGlow(vec3 rd)         forward-scatter lobes round the key light + the warm horizon band
//     float wx_cloudShadow(vec3 wpos)   0..1 sun visibility under the drifting cloud deck (1 = lit)
//     float wx_groundHeight(vec2 xz, float fallback)   manual-bilinear G.tHeight (fallback when absent / outside)
//     vec4  wx_groundInfo(vec2 xz)      G.tGround (R density, G height, B moisture, A cavity AO) with safe defaults
//     float wx_mistTau(vec3 wpos, vec3 camPos)          ground-mist optical depth (pools in hollows, drifts downwind)
//     float wx_ign(vec2 fragCoord)      interleaved gradient noise;  float wx_fbm3v(vec2) 3-octave soft value fBm
//     (+ GLSL_NOISE from core/noise.js: wx_hash12/22/13, wx_vnoise, wx_fbm, ...)
//   atmosUniforms()       uniforms to spread into a ShaderMaterial that uses ATMOS_GLSL (all shared G objects)
//   SUNLIGHT_TERMS        GLSL snippet for built-in material hooks, insert right AFTER #include <lights_fragment_begin>:
//                         defines vec3 sunC (shadowed + cloud-shadowed sun radiance), vec3 sunLv (view-space dir to the
//                         sun), float sunBack (looking into the sun through the surface), float sunWrap (light from behind)
//   addShaderHook(material, key, fn(shader, material))  chain an onBeforeCompile hook (key feeds the program cache key)
//   addWorldPos(material)                               exposes `varying vec3 vWxWorldPos` in both stages
//   patchMaterial(material, opts?)                      opts: { fog = true, wetBias = 0 }. Also accepts the bible form
//                                                       patchMaterial(material, key, fn) = G uniforms + your hook.
//   patchAll(scene)                                     retrofits every non-Shader material that was never patched
//
// Built-in materials get the atmosphere, dual shadows, cloud shadow, lamps and wetness from the GLOBAL ShaderChunk
// patches (core/chunks.js) through the dummy scene.fog; patchMaterial() only guarantees the G uniforms / wet bias and
// flips material.fog. Custom ShaderMaterials: `${ATMOS_GLSL}` in the fragment shader, `...atmosUniforms()` (or ...G)
// in the uniforms, pass world position via your own varying and end with `col = wx_applyAtmosphere(col, vWorldPos);`.
// Every uniform left at 0 (not supplied) degrades to "no effect", never to black.
import * as THREE from 'three';
import { G } from './globals.js';
import { U } from './glsl.js';
import { GLSL_NOISE } from './noise.js';

// Extra shared uniforms owned by S (attached here so every `{...G}` spread made later sees them).
G.uSunDirTrue ??= { value: G.uSunDir.value.clone() }; // the real sun (may be below the horizon); uSunDir is the key light
G.uGroundY ??= { value: 0 };                          // ground height under the camera (volumetrics, mist fallback)

export const ATMOS_GLSL = /* glsl */`
#ifndef WX_ATMOS
#define WX_ATMOS
${U('vec3', 'uSunDir')}${U('vec3', 'uSunDirTrue')}${U('vec3', 'uSunCol')}${U('vec3', 'uFogCool')}${U('vec3', 'uFogWarm')}
${U('vec4', 'uFogParams')}${U('float', 'uMist')}${U('vec3', 'uCamPos')}${U('float', 'uTime')}${U('float', 'uStorm')}
${U('float', 'uFlash')}${U('vec3', 'uFlashDir')}${U('vec4', 'uWind')}${U('vec4', 'uCloudShadow')}${U('vec3', 'uHorizonGlow')}
${U('sampler2D', 'tHeight')}${U('sampler2D', 'tGround')}${U('vec4', 'uWorldRect')}${U('float', 'uGroundY')}
${GLSL_NOISE}
float wx_ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// 3-octave value fBm (weights .55/.28/.17): blobby, soft, no lattice artefacts -> painted clouds and cloud shadows.
float wx_fbm3v(vec2 p) {
  const mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
  float s = 0.55 * wx_vnoise(p);
  p = R * p * 2.02 + 3.17; s += 0.28 * wx_vnoise(p);
  p = R * p * 2.03 + 7.71; s += 0.17 * wx_vnoise(p);
  return s;
}

// The real sun (drives the warm/cool split and the horizon afterglow even after sunset). Falls back to the key.
vec3 wx_sunTrue() { return dot(uSunDirTrue, uSunDirTrue) > 0.5 ? uSunDirTrue : uSunDir; }

// Directional fog colour: cool blue-grey away from the sun, amber toward it (half-width ~41 deg), lightning tint.
vec3 wx_fogBase(vec3 rd) {
  float s = max(dot(rd, wx_sunTrue()), 0.0);
  float warm = clamp(pow(s, 2.5) * 0.95 + 0.06, 0.0, 1.0);
  vec3 c = mix(uFogCool, uFogWarm, warm);
  c += vec3(0.5, 0.58, 0.8) * uFlash * (0.05 + 0.45 * pow(max(dot(rd, uFlashDir), 0.0), 4.0));
  return c;
}

// Forward-scatter lobes round the key light (30 / 13 / 4.5 deg, the wide one smeared along the horizon) plus the
// warm band hugging the whole horizon. Shared by sky AND fog so fogged geometry dissolves into the sky seamlessly.
vec3 wx_sunGlow(vec3 rd) {
  float clear = 1.0 - uStorm;
  float s = max(dot(rd, uSunDir), 0.0);
  float band = exp(-max(rd.y, 0.0) * 7.0);
  float s5 = s * s; s5 *= s5 * s;
  float s48 = pow(s, 48.0);
  // wide lobe: the long slant path along the horizon reddens it (orange smear); halo (~10 deg) + aureole (~4 deg):
  // whiter, yellow-gold. Kept tight so the sky 20+ deg above the sun stays clean blue, not greige.
  vec3 g = uSunCol * vec3(1.0, 0.52, 0.22) * s5 * (0.075 * band + 0.010)
         + uSunCol * vec3(1.0, 0.74, 0.48) * (s48 * 0.12 + s48 * pow(s, 172.0) * 0.55);
  g *= 0.25 + 0.75 * clear;
  float st = max(dot(rd, wx_sunTrue()), 0.0);
  g += uHorizonGlow * band * 0.10 * (0.3 + 0.7 * st * sqrt(st)) * clear;
  return g;
}

vec3 wx_skyFogColor(vec3 rd) { return wx_fogBase(rd) + wx_sunGlow(rd); }

// Cloud shadow: project along the sun ray to the deck, drift downwind. ~30% of the plain shadowed at x = 0.5.
float wx_cloudShadow(vec3 wp) {
  if (uCloudShadow.x <= 0.0) return 1.0;
  vec2 p = wp.xz + uSunDir.xz / max(uSunDir.y, 0.08) * (uCloudShadow.y - wp.y);
  p = (p - uWind.xy * uTime * uCloudShadow.w) * uCloudShadow.z;
  float n = wx_fbm3v(p) * 0.8 + wx_vnoise(p * 3.7) * 0.2;
  return 1.0 - uCloudShadow.x * smoothstep(0.52, 0.74, n);
}

// Ground height from the terrain bake (R32F, NEAREST) with manual bilinear. texel (i,j) <-> world
// x = rect.x + (i+.5)*rect.z/N, z = rect.y + (j+.5)*rect.z/N.
float wx_groundHeight(vec2 xz, float fallback) {
  ivec2 sz = textureSize(tHeight, 0);
  if (sz.x < 4) return fallback;
  vec2 uv = (xz - uWorldRect.xy) * uWorldRect.w;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return fallback;
  vec2 p = uv * vec2(sz) - 0.5;
  ivec2 i0 = ivec2(floor(p)), mx = sz - 1;
  vec2 f = p - floor(p);
  float a = texelFetch(tHeight, clamp(i0, ivec2(0), mx), 0).r;
  float b = texelFetch(tHeight, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0).r;
  float c = texelFetch(tHeight, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0).r;
  float d = texelFetch(tHeight, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// R grass density, G height factor, B moisture, A cavity AO (1 on ridges, ~.5 in dips).
vec4 wx_groundInfo(vec2 xz) {
  if (textureSize(tGround, 0).x < 4) return vec4(0.6, 0.6, 0.3, 0.82);
  vec2 uv = (xz - uWorldRect.xy) * uWorldRect.w;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0, 0.5, 0.3, 1.0);
  return texture2D(tGround, uv);
}

// Low evening mist: lives in the lowest few metres above the ground, pools in hollows, breaks into drifting banks.
float wx_mistTau(vec3 wp, vec3 ro) {
  if (uMist <= 0.0) return 0.0;
  float hollow = 1.0 - wx_groundInfo(wp.xz).a;
  float hAbove = wp.y - wx_groundHeight(wp.xz, uGroundY);
  float my = clamp(1.0 - hAbove / (2.5 + 4.0 * hollow), 0.0, 1.0);
  float mn = wx_vnoise(wp.xz * 0.035 + uWind.xy * uTime * 0.12) * 1.3 - 0.35 + hollow * 0.6;
  return uMist * my * my * max(mn + uStorm * 0.25, 0.0) * min(length(wp - ro), 140.0) * 0.0042;
}

// Aerial perspective: exact integral of exponential height fog + linear haze + ground mist, coloured by the
// view-dependent sky in-scatter. Additive materials (#define WX_FOG_ADD) are only attenuated.
vec3 wx_applyAtmosphereT(vec3 col, vec3 wp, float mistTau) {
  vec3 ro = uCamPos;
  vec3 dv = wp - ro;
  float dist = length(dv);
  vec3 rd = dv / max(dist, 1e-3);
  float fall = uFogParams.y, k = fall * dv.y;
  float fh = uFogParams.x * exp(-fall * (ro.y - uFogParams.z)) * dist * (abs(k) > 1e-3 ? (1.0 - exp(-k)) / k : 1.0);
  float T = exp(-(fh + uFogParams.w * dist + mistTau));
#ifdef WX_FOG_ADD
  return col * T;
#else
  // In-scatter: the directional fog colour, plus the sun lobes weighted by (1-T)^2 — near air is lit by the
  // shadowed volumetric pass (post), far air converges to exactly the sky's horizon colour (seamless).
  vec3 fd = normalize(vec3(rd.x, max(rd.y, -0.05), rd.z));
  float F = 1.0 - T;
  vec3 fc = wx_fogBase(fd) * F + wx_sunGlow(fd) * F * F;
  fc += uSunCol * 0.04 * mistTau * pow(max(dot(rd, uSunDir), 0.0), 3.0) * F;   // mist glows where the sun rakes it
  return col * T + fc;
#endif
}
vec3 wx_applyAtmosphere(vec3 col, vec3 wp) { return wx_applyAtmosphereT(col, wp, wx_mistTau(wp, uCamPos)); }
#endif
`;

/** Uniforms needed by ATMOS_GLSL (shared objects). Spreading `...G` works too. */
export function atmosUniforms() {
  return {
    uSunDir: G.uSunDir, uSunDirTrue: G.uSunDirTrue, uSunCol: G.uSunCol,
    uFogCool: G.uFogCool, uFogWarm: G.uFogWarm, uFogParams: G.uFogParams, uMist: G.uMist,
    uCamPos: G.uCamPos, uTime: G.uTime, uStorm: G.uStorm, uFlash: G.uFlash, uFlashDir: G.uFlashDir,
    uWind: G.uWind, uCloudShadow: G.uCloudShadow, uHorizonGlow: G.uHorizonGlow,
    tHeight: G.tHeight, tGround: G.tGround, uWorldRect: G.uWorldRect, uGroundY: G.uGroundY,
  };
}

/**
 * Translucency terms for foliage / cloth / skin (bible §2.6). Insert AFTER `#include <lights_fragment_begin>` in a
 * built-in material hook, then use e.g. `reflectedLight.directDiffuse += sunC * diffuseColor.rgb * (sunBack*1.8 + 0.2);`
 * sunC is 0 in materials that receive no directional light.
 */
export const SUNLIGHT_TERMS = /* glsl */`
vec3 sunC = gSunColor; vec3 sunLv = gSunDir;
float sunBack = pow(clamp(dot(-normalize(vViewPosition), sunLv), 0.0, 1.0), 4.0);
float sunWrap = clamp(dot(-normal, sunLv) * 0.6 + 0.4, 0.0, 1.0);
`;

/** Add every G uniform the shader doesn't define yet (shared by reference). */
export function injectG(uniforms) {
  for (const k in G) if (!(k in uniforms)) uniforms[k] = G[k];
  return uniforms;
}

const isAdditive = (m) => m.blending === THREE.AdditiveBlending;

/**
 * Chain an onBeforeCompile hook. Hooks run in insertion order, after the global G injection. `key` must uniquely
 * describe the hook's GLSL (include any #define-like options) so three.js caches programs correctly.
 */
export function addShaderHook(material, key, fn) {
  const ud = material.userData;
  if (!ud.wxHooks) {
    ud.wxHooks = [];
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    const hadPrev = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile') && typeof prev === 'function';
    const hadPrevKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
    material.onBeforeCompile = (shader, renderer) => {
      globalHook.call(material, shader, renderer);
      if (hadPrev) prev.call(material, shader, renderer);
      for (const h of ud.wxHooks) h.fn(shader, material, renderer);
    };
    material.customProgramCacheKey = () => (hadPrevKey ? prevKey.call(material) : '') + '|' + ud.wxHooks.map(h => h.key).join('|') + (isAdditive(material) ? '|add' : '');
  }
  if (!ud.wxHooks.some(h => h.key === key)) ud.wxHooks.push({ key, fn });
  material.needsUpdate = true;
  return material;
}

/**
 * The global per-material hook (installed on THREE.Material.prototype by core/chunks.js): built-in materials get the
 * shared G uniforms; additive ones get WX_FOG_ADD. ShaderMaterials manage their own uniforms.
 */
export function globalHook(shader) {
  if (this && this.isShaderMaterial) return;
  injectG(shader.uniforms);
  if (this && isAdditive(this)) shader.defines = Object.assign({}, shader.defines, { WX_FOG_ADD: '' });
}

const WORLDPOS_VERT = /* glsl */`
{
  vec4 wxWp = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    wxWp = batchingMatrix * wxWp;
  #endif
  #ifdef USE_INSTANCING
    wxWp = instanceMatrix * wxWp;
  #endif
  vWxWorldPos = (modelMatrix * wxWp).xyz;
}
`;

/** Ensure the material exposes `varying vec3 vWxWorldPos` (world position) in both stages. */
export function addWorldPos(material) {
  return addShaderHook(material, 'wxWorldPos', (shader) => {
    if (!shader.vertexShader.includes('varying vec3 vWxWorldPos')) {
      shader.vertexShader = 'varying vec3 vWxWorldPos;\n' + shader.vertexShader.replace(
        '#include <project_vertex>', '#include <project_vertex>\n' + WORLDPOS_VERT);
      shader.fragmentShader = 'varying vec3 vWxWorldPos;\n' + shader.fragmentShader;
    }
  });
}

// true once core/chunks.js replaced the fog chunks (then the atmosphere is global and patchMaterial must not add it)
const chunksInstalled = () => THREE.ShaderChunk.fog_fragment.includes('wx_applyAtmosphere');

/**
 * Give a built-in material (Standard/Physical/Lambert/Basic/Points/Sprite...) our atmosphere + G uniforms.
 *   patchMaterial(mat)                       atmosphere on (default)
 *   patchMaterial(mat, { fog: false })       no atmosphere (sky-like / UI-ish objects)
 *   patchMaterial(mat, { wetBias: 0.3 })     standing wetness (sweat, blood, spray); live: mat.userData.uWetBias.value
 *   patchMaterial(mat, 'grass-L0', fn)       bible form: G uniforms + your own onBeforeCompile hook under that key
 */
export function patchMaterial(material, opts = {}, fn) {
  if (typeof opts === 'string') {
    patchMaterial(material, {});
    if (fn) addShaderHook(material, opts, fn);
    return material;
  }
  const { fog = true, wetBias } = opts;
  const ud = material.userData;
  ud.uWetBias ??= { value: 0 };
  if (wetBias !== undefined) ud.uWetBias.value = wetBias;
  addWorldPos(material);
  addShaderHook(material, 'wxG', (shader) => { injectG(shader.uniforms); shader.uniforms.uWetBias = ud.uWetBias; });
  if (material.fog !== fog) { material.fog = fog; material.needsUpdate = true; }
  if (fog) {
    // Global chunks active: the dummy scene.fog + material.fog drive fog_fragment. WX_ATMOS_ON also forces it when a
    // scene has no fog object. Without the global chunks (standalone use) inject the atmosphere by hand.
    addShaderHook(material, 'wxAtmos', (shader) => {
      if (chunksInstalled()) { shader.defines = Object.assign({}, shader.defines, { WX_ATMOS_ON: '' }); return; }
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', ATMOS_GLSL + '\nvoid main() {')
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = wx_applyAtmosphere(gl_FragColor.rgb, vWxWorldPos);');
    });
  }
  ud.wxPatched = true;
  return material;
}

/** Retrofit every mesh material in `root` that was never patched (keeps bible `patchAll` semantics). */
export function patchAll(root) {
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) if (!m.isShaderMaterial && !m.userData.wxPatched) patchMaterial(m);
  });
}
