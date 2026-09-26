// Shared plumbing for the post-processing passes (bible §2.2–2.4). Owner: post-processing (R).
//   FS_VERT                   — fullscreen-triangle vertex shader (vUv in 0..1)
//   fsPass(renderer, mat, rt) — draw one fullscreen triangle with `mat` into `rt` (null = canvas)
//   postMaterial({...})       — ShaderMaterial preset for post passes (no depth, no blending, GLSL ES 3.00 via three)
//   makeRT(w, h, opts)        — HalfFloat RGBA linear render target helper (bible §2.2 defaults)
//   POST_GLSL                 — GLSL helpers shared by the pass shaders (ign, hash, luma, ACES, sRGB, YCoCg …)
//   halton(i, base)           — low-discrepancy sequence for TAA jitter
import * as THREE from 'three';

// One big triangle covering the viewport. Cheaper than a quad (no diagonal seam → no helper-lane waste).
const triGeo = new THREE.BufferGeometry();
triGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
triGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fsMesh = new THREE.Mesh(triGeo);
fsMesh.frustumCulled = false;
fsMesh.matrixAutoUpdate = false;

export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Render `material` over the full target. `rt` null → canvas. */
export function fsPass(renderer, material, rt) {
  fsMesh.material = material;
  renderer.setRenderTarget(rt);
  renderer.render(fsMesh, fsCam);
}

export function postMaterial({ uniforms = {}, fragmentShader, defines = {}, vertexShader = FS_VERT, name = 'post' }) {
  const m = new THREE.ShaderMaterial({
    name, uniforms, defines, vertexShader, fragmentShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  return m;
}

export function makeRT(w, h, { type = THREE.HalfFloatType, format = THREE.RGBAFormat, filter = THREE.LinearFilter, name = '', ...rest } = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type, format, minFilter: filter, magFilter: filter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, ...rest,
  });
  rt.texture.name = name;
  return rt;
}

export function halton(i, base) {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

export const POST_GLSL = /* glsl */`
#ifndef WXP_COMMON
#define WXP_COMMON
const vec3 WXP_LUMA709 = vec3(0.2126, 0.7152, 0.0722);
const vec3 WXP_LUMA601 = vec3(0.299, 0.587, 0.114);
// Interleaved gradient noise (Jimenez 2014)
float wxp_ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float wxp_hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float wxp_vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  float a = wxp_hash12(i), b = wxp_hash12(i + vec2(1.0, 0.0)), c = wxp_hash12(i + vec2(0.0, 1.0)), d = wxp_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float wxp_fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * wxp_vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.31; a *= 0.5; }
  return s / 0.875;
}
// perspective depth-buffer value (0..1) → linear view depth (m)
float wxp_linearDepth(float z, vec2 nf) { float zn = z * 2.0 - 1.0; return 2.0 * nf.x * nf.y / (nf.y + nf.x - zn * (nf.y - nf.x)); }
// ACES fitted (Stephen Hill / BakingLab), no /0.6 pre-scale (bible §2.4.5-6)
vec3 wxp_rrtOdt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 wxp_aces(vec3 c) {
  const mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  return clamp(m2 * wxp_rrtOdt(m1 * c), 0.0, 1.0);
}
vec3 wxp_toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 wxp_toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 wxp_fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
#endif
`;
