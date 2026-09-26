// Temporal anti-aliasing (bible §2.4.8): Halton(2,3) 8-frame sub-pixel jitter on the scene projection, camera
// reprojection from the (dilated, closest) depth, 5-tap Catmull-Rom history, YCoCg variance CLIP (γ = 1) in a
// Karis-tonemapped space so HDR highlights don't dominate, exponential blend 0.1. Actors and wind-animated grass
// write no velocity; the variance clip handles them. The single biggest win against grass shimmer.
// Owner: post-processing (R). Used only by core/pipeline.js.
//   taa.jitter(camera, W, H) → applies this frame's sub-pixel offset to camera.projectionMatrix (call restore()).
//   taa.render(renderer, sceneTex, depthTex, frame) → resolves into taa.texture (full-res HDR, also the history).
import * as THREE from 'three';
import { postMaterial, fsPass, makeRT, POST_GLSL, halton } from './postCommon.js';

const TAA_FRAG = /* glsl */`
${POST_GLSL}
uniform sampler2D tCur, tHist, tDepth;
uniform mat4 uInvViewProj, uPrevViewProj;
uniform vec2 uTexel, uSize;     // history (output) texel / size
uniform vec2 uCurTexel, uJit;   // current (scene) texel; this frame's jitter in UV (unjitters the scene sample)
uniform float uValid, uBlend, uGamma;
varying vec2 vUv;

vec3 tm(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 itm(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-3); }

vec3 historyCatmullRom(vec2 uv) {
  vec2 sp = uv * uSize;
  vec2 t1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (t1 - 1.0) * uTexel, t3 = (t1 + 2.0) * uTexel, t12 = (t1 + w2 / w12) * uTexel;
  vec3 r = texture(tHist, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
         + texture(tHist, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture(tHist, vec2(t12.x, t12.y)).rgb * (w12.x * w12.y)
         + texture(tHist, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture(tHist, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / ws, vec3(0.0));
}

void main() {
  // upsampling (scene rendered below output size): the scene is sampled unjittered at this output pixel, so the
  // Halton offsets land on different sub-pixels each frame and the history integrates the missing detail
  vec2 cuv = vUv + uJit;
  vec3 cur = texture(tCur, cuv).rgb;
  vec3 cy = wxp_toYCoCg(tm(cur));
  vec3 m1 = cy, m2 = cy * cy;
  float zMin = texture(tDepth, cuv).x; vec2 zOff = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    if (x == 0 && y == 0) continue;
    vec2 o = vec2(float(x), float(y));
    vec3 c = wxp_toYCoCg(tm(texture(tCur, cuv + o * uCurTexel).rgb));
    m1 += c; m2 += c * c;
    float z = texture(tDepth, cuv + o * uCurTexel).x;
    if (z < zMin) { zMin = z; zOff = o; }
  }
  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(abs(m2 / 9.0 - mean * mean));
  vec3 ext = uGamma * sigma + vec3(1e-4);

  // reproject using the closest depth of the 3×3 (keeps foreground silhouettes from trailing)
  vec2 uvz = vUv + zOff * uCurTexel;
  vec4 wp = uInvViewProj * vec4(uvz * 2.0 - 1.0, zMin * 2.0 - 1.0, 1.0);
  wp /= wp.w;
  vec4 pc = uPrevViewProj * wp;
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  vec2 hUv = vUv + (puv - uvz);
  bool off = pc.w <= 0.0 || any(lessThan(hUv, vec2(0.0))) || any(greaterThan(hUv, vec2(1.0)));

  vec3 hy = wxp_toYCoCg(tm(historyCatmullRom(hUv)));
  // variance clip toward the mean (Salvi / Playdead)
  vec3 v = hy - mean; vec3 a = abs(v / ext);
  float mm = max(a.x, max(a.y, a.z));
  if (mm > 1.0) hy = mean + v / mm;

  // luminance-difference feedback: accept more of the current frame where history had to be clipped hard
  float k = uBlend * (1.0 + clamp(mm - 1.0, 0.0, 1.0));
  if (off || uValid < 0.5) k = 1.0;
  vec3 res = mix(hy, cy, k);
  gl_FragColor = vec4(itm(max(wxp_fromYCoCg(res), vec3(0.0))), 1.0);
}
`;

export class TAAPass {
  constructor() {
    this.rt = [makeRT(1, 1, { name: 'taaA' }), makeRT(1, 1, { name: 'taaB' })];
    this.cur = 0;
    this.valid = false;
    this.index = 0;
    this.offset = new THREE.Vector2();      // this frame's jitter in pixels
    this._saved = new THREE.Matrix4();
    this._savedInv = new THREE.Matrix4();
    this._cam = null;
    this.mat = postMaterial({
      name: 'taa', fragmentShader: TAA_FRAG,
      uniforms: {
        tCur: { value: null }, tHist: { value: null }, tDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2() },
        uCurTexel: { value: new THREE.Vector2() }, uJit: { value: new THREE.Vector2() },
        uValid: { value: 0 }, uBlend: { value: 0.1 }, uGamma: { value: 1.0 },
      },
    });
  }
  get texture() { return this.rt[this.cur].texture; }
  /** w, h: output (history) size; sw, sh: the scene render size (smaller when upsampling). */
  setSize(w, h, sw = w, sh = h) { for (const rt of this.rt) rt.setSize(w, h); this.w = w; this.h = h; this.sw = sw; this.sh = sh; this.valid = false; }

  /** Offset the projection by a Halton(2,3) sub-pixel amount. Must be paired with restore(). */
  jitter(camera, W, H, scale = 1) {
    this.index = (this.index + 1) % 8;
    this.offset.set((halton(this.index + 1, 2) - 0.5) * scale, (halton(this.index + 1, 3) - 0.5) * scale);
    this._cam = camera;
    this._saved.copy(camera.projectionMatrix);
    this._savedInv.copy(camera.projectionMatrixInverse);
    const e = camera.projectionMatrix.elements;
    e[8] += 2 * this.offset.x / W;
    e[9] += 2 * this.offset.y / H;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  restore() {
    if (!this._cam) return;
    this._cam.projectionMatrix.copy(this._saved);
    this._cam.projectionMatrixInverse.copy(this._savedInv);
    this._cam = null;
  }

  /** Reprojection uses the UNJITTERED current and previous view-projections: a static camera then samples the
   *  history at exactly this pixel, so the jittered samples integrate into a supersampled pixel instead of the
   *  history random-walking by the jitter every frame (which smears). */
  render(renderer, sceneTex, depthTex, frame, params) {
    const prev = this.cur; this.cur ^= 1;
    const u = this.mat.uniforms;
    u.tCur.value = sceneTex; u.tDepth.value = depthTex; u.tHist.value = this.rt[prev].texture;
    u.uInvViewProj.value.copy(frame.viewProj).invert();
    u.uPrevViewProj.value.copy(frame.prevViewProj);
    u.uTexel.value.set(1 / this.w, 1 / this.h); u.uSize.value.set(this.w, this.h);
    const sw = this.sw ?? this.w, sh = this.sh ?? this.h;
    u.uCurTexel.value.set(1 / sw, 1 / sh);
    u.uJit.value.set(this.offset.x / sw, this.offset.y / sh);
    u.uValid.value = this.valid && frame.historyOk ? 1 : 0;
    u.uBlend.value = params.taaBlend ?? 0.1;
    u.uGamma.value = params.taaGamma ?? 1.0;
    fsPass(renderer, this.mat, this.rt[this.cur]);
    this.valid = true;
  }
  dispose() { for (const rt of this.rt) rt.dispose(); this.mat.dispose(); }
}
