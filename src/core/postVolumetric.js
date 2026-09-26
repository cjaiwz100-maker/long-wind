// Volumetric sun shafts (bible §2.4.2): half-res raymarch through the real sun shadow map(s) with IGN-jittered
// steps, drifting pollen/mist density and cloud shadow, then a depth-aware bilateral blur and a REPROJECTED
// temporal blend with a neighbourhood clamp (our camera never stops, so history must follow it).
// Owner: post-processing (R). Used only by core/pipeline.js.
//   const vol = new VolumetricPass()
//   vol.setSize(hw, hh) · vol.render(renderer, frame, copyTex, params) · vol.texture (latest filtered shafts, HDR rgb)
//   vol.setShadowSources(far, near)   — DirectionalLights (either may be null → graceful fallback: unshadowed haze)
//   vol.steps                          — raymarch steps (tier: 32/26/18/12); changing it recompiles once
import * as THREE from 'three';
import { G } from './globals.js';
import { U } from './glsl.js';
import { ATMOS_GLSL, atmosUniforms } from './atmosphere.js';
import { postMaterial, fsPass, makeRT, POST_GLSL } from './postCommon.js';

// Local copy of the bible's cloudShadow() (§2.6), used only if core/atmosphere.js doesn't provide
// wx_cloudShadow / wx_groundHeight. With them, shafts and ground cloud-shadows line up exactly and the haze
// follows the baked terrain height under every sample.
const CLOUD_FALLBACK = /* glsl */`
${U('vec3', 'uSunDir')}${U('vec4', 'uCloudShadow')}${U('vec4', 'uWind')}${U('float', 'uTime')}
float wxp_cloudShadow(vec3 wp) {
  vec2 p = wp.xz + uSunDir.xz / max(uSunDir.y, 0.08) * (uCloudShadow.y - wp.y);
  p = (p - uWind.xy * uTime * uCloudShadow.w) * uCloudShadow.z;
  float n = wxp_fbm3(p) * 0.8 + wxp_vnoise(p * 3.7) * 0.2;
  return 1.0 - uCloudShadow.x * smoothstep(0.52, 0.74, n);
}
#define WXP_CLOUD(p) wxp_cloudShadow(p)
#define WXP_GROUND(xz, fb) (fb)
`;
const ATMOS_OK = /\bwx_cloudShadow\s*\(/.test(ATMOS_GLSL) && /\bwx_groundHeight\s*\(/.test(ATMOS_GLSL);
const CLOUD_ATMOS = `${ATMOS_GLSL}
#define WXP_CLOUD(p) wx_cloudShadow(p)
// haze base height: one nearest texel of the baked terrain height (0.5 m texels are plenty for a density falloff)
float wxp_ground(vec2 xz, float fb) {
  ivec2 sz = textureSize(tHeight, 0);
  vec2 uv = (xz - uWorldRect.xy) * uWorldRect.w;
  if (sz.x < 4 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return fb;
  return texelFetch(tHeight, ivec2(uv * vec2(sz)), 0).r;
}
#define WXP_GROUND(xz, fb) wxp_ground(xz, fb)
`;

function marchFrag(atmos) {
  return /* glsl */`
${POST_GLSL}
${atmos ? CLOUD_ATMOS : CLOUD_FALLBACK}
${U('vec3', 'uSunCol')}${U('sampler2D', 'tWindNoise')}
uniform sampler2D tCopy;
#if NUM_SHADOWS > 0
uniform sampler2DShadow tShadowFar; uniform mat4 uShadowMatFar; uniform float uBiasFar;
#endif
#if NUM_SHADOWS > 1
uniform sampler2DShadow tShadowNear; uniform mat4 uShadowMatNear; uniform float uBiasNear;
#endif
uniform mat4 uInvProj, uCamWorld;
${U('vec3', 'uCamPos')}
uniform float uFrame, uVolGroundY, uDustAmt, uMaxDist, uDensity, uCloudK, uExt, uScale, uBroad, uOccPow;
varying vec2 vUv;

// Shadow lookup with a soft fade at the frustum border (no seam where a map ends).
float wxp_shadow(sampler2DShadow m, vec3 s, float bias) {
  if (s.z >= 1.0 || s.z <= 0.0) return 1.0;
  vec2 e = min(s.xy, 1.0 - s.xy);
  float edge = smoothstep(0.0, 0.04, min(e.x, e.y));
  if (edge <= 0.0) return 1.0;
  return mix(1.0, texture(m, vec3(s.xy, s.z - bias)), edge);
}
float wxp_hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }

void main() {
  float lin = texture(tCopy, vUv).a;
  vec4 vd = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vdir = normalize(vd.xyz / vd.w);
  vec3 rd = normalize(mat3(uCamWorld) * vdir);
  float tMax = min(lin / max(-vdir.z, 1e-3), uMaxDist);
  float j = wxp_ign(gl_FragCoord.xy + mod(uFrame, 64.0) * 5.588238);
#if NUM_SHADOWS > 0
  // the shadow matrices are affine, so the shadow coordinate is linear in t
  vec3 sF0 = (uShadowMatFar * vec4(uCamPos, 1.0)).xyz, sFd = (uShadowMatFar * vec4(rd, 0.0)).xyz;
#endif
#if NUM_SHADOWS > 1
  vec3 sN0 = (uShadowMatNear * vec4(uCamPos, 1.0)).xyz, sNd = (uShadowMatNear * vec4(rd, 0.0)).xyz;
#endif
  // Cloud shadow varies over hundreds of metres: evaluated at both ends of the ray, linear in between.
  float c0 = mix(1.0, WXP_CLOUD(uCamPos), uCloudK), c1 = mix(1.0, WXP_CLOUD(uCamPos + rd * tMax), uCloudK);
  // Quadratic step spacing t = tMax·x²: centimetre steps around the fighters (their blade and hat carve crisp
  // shafts), ~17 m steps at the far end where only the tree, pillars and hills still matter.
  float acc = 0.0, accGeo = 0.0, accAll = 0.0, trans = 1.0, gy = uVolGroundY;
  vec2 drift = uWind.xy * (uTime * 1.2);                   // mist banks drift downwind
  const float INV_N = 1.0 / float(STEPS);
  for (int i = 0; i < STEPS; i++) {
    float x = (float(i) + j) * INV_N;
    float t = tMax * x * x, dt = tMax * 2.0 * x * INV_N;
    vec3 p = uCamPos + rd * t;
    float geo = 1.0;
#if NUM_SHADOWS > 0
    geo = wxp_shadow(tShadowFar, sF0 + sFd * t, uBiasFar);
#endif
#if NUM_SHADOWS > 1
    geo *= wxp_shadow(tShadowNear, sN0 + sNd * t, uBiasNear);
#endif
    if ((i & 3) == 0) gy = WXP_GROUND(p.xz, uVolGroundY);   // terrain swells are big: every 4th step is plenty
    float lit = geo * mix(c0, c1, x * x);
    float y = max(p.y - gy, 0.0);
    float mist = smoothstep(0.38, 0.82, texture(tWindNoise, (p.xz + drift) * (1.0 / 267.0)).g);   // drifting pollen/mist banks
    float e = exp(-y * 0.05);
    float dens = 0.32 * e + 0.75 * mist * e * e * e;         // haze + pollen banks (e³ ≈ exp(-0.15y))
    if (uDustAmt > 0.0) dens += 0.25 * uDustAmt * exp(-y * 0.5);   // combat dust (uniform branch)
    dens *= uDensity;
    float w = dens * trans * dt;
    acc += lit * w; accGeo += geo * w; accAll += w;
    trans *= exp(-dens * dt * uExt);
  }
  // two-lobe phase: a tight forward lobe (the blaze around the sun) + a broad one so shafts still read 30–60° off-sun
  float mu = dot(rd, uSunDir);
  float ph = mix(wxp_hg(mu, 0.8), wxp_hg(mu, 0.3), uBroad) * 0.8 + 0.035;
  // alpha: shaft OCCLUSION of what lies behind (1 = open air). The fraction of the near air that the sun reaches,
  // weighted toward the sun direction, lets the composite carve the occluders' shadow volumes into the sky glow
  // and sun haze as well (the classic light-shaft occlusion term) instead of only adding light where it is lit.
  // Only what lies well behind the air gets carved (the sky glow, far haze): a near wall has no air in front of it.
  float litFrac = accAll > 1e-5 ? accGeo / accAll : 1.0;
  float toward = pow(max(mu, 0.0), 10.0) * smoothstep(15.0, 120.0, tMax);
  gl_FragColor = vec4(uSunCol * acc * ph * uScale, 1.0 - toward * (1.0 - pow(litFrac, uOccPow)));
}
`;
}

// 9-tap separable bilateral blur. Depth comes from rtCopy.a so shafts/AO never bleed across silhouettes.
export const BILATERAL_FRAG = /* glsl */`
uniform sampler2D tSrc, tCopy;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  float d0 = texture(tCopy, vUv).a;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec2 uv = vUv + uStep * float(i);
    float d = texture(tCopy, uv).a;
    float w = exp(-float(i * i) * 0.12) / (1.0 + abs(d - d0) / max(d0, 1.0) * 8.0);
    acc += texture(tSrc, uv) * w; ws += w;
  }
  gl_FragColor = acc / ws;
}
`;

// 3×3 joint-bilateral (1.6-texel taps) applied AFTER the temporal accumulation, for display only: the history keeps
// the sharp, temporally denoised signal and never gets re-blurred frame after frame.
const BLUR2D_FRAG = /* glsl */`
uniform sampler2D tSrc, tCopy;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float d0 = texture(tCopy, vUv).a;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 uv = vUv + vec2(x, y) * uTexel * 1.6;
    float d = texture(tCopy, uv).a;
    float w = exp(-float(x * x + y * y) * 0.5) / (1.0 + abs(d - d0) / max(d0, 1.0) * 8.0);
    acc += texture(tSrc, uv) * w; ws += w;
  }
  gl_FragColor = acc / ws;
}
`;

const TEMPORAL_FRAG = /* glsl */`
uniform sampler2D tCur, tHist, tCopy;
uniform mat4 uInvProj, uCamWorld, uPrevViewProj;
uniform vec3 uCamPos;
uniform vec2 uTexel;
uniform float uValid, uBlend;
varying vec2 vUv;
void main() {
  vec4 cur = texture(tCur, vUv);
  vec4 mn = cur, mx = cur;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    if (x == 0 && y == 0) continue;
    vec4 c = texture(tCur, vUv + vec2(x, y) * uTexel);
    mn = min(mn, c); mx = max(mx, c);
  }
  float lin = texture(tCopy, vUv).a;
  vec4 vd = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vdir = normalize(vd.xyz / vd.w);
  vec3 wp = uCamPos + normalize(mat3(uCamWorld) * vdir) * (lin / max(-vdir.z, 1e-3));
  vec4 pc = uPrevViewProj * vec4(wp, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  // the current frame is raw, IGN-noisy march output, so its 3×3 box is already generous
  vec4 ext = (mx - mn) * 0.1;
  vec4 h = clamp(texture(tHist, puv), mn - ext, mx + ext);
  bool off = pc.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)));
  float k = (off || uValid < 0.5) ? 1.0 : uBlend;
  gl_FragColor = mix(h, cur, k);
}
`;

export class VolumetricPass {
  constructor() {
    this.steps = 26;
    this.maxDist = 220;
    this.far = null; this.near = null;
    this.rtVol = makeRT(1, 1, { name: 'vol' });
    this.rtVol2 = makeRT(1, 1, { name: 'vol2' });
    this.rtHist = [makeRT(1, 1, { name: 'volHistA' }), makeRT(1, 1, { name: 'volHistB' })];
    this.cur = 0;
    this.histValid = false;
    this._numShadows = -1; this._steps = -1;
    this._dust = 0;

    this.marchUniforms = {
      ...(ATMOS_OK ? atmosUniforms() : pickG(['uSunDir', 'uCloudShadow', 'uWind', 'uTime'])),
      uSunCol: G.uSunCol,
      tCopy: { value: null },
      tShadowFar: { value: null }, uShadowMatFar: { value: new THREE.Matrix4() }, uBiasFar: { value: 0.001 },
      tShadowNear: { value: null }, uShadowMatNear: { value: new THREE.Matrix4() }, uBiasNear: { value: 0.0006 },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uFrame: { value: 0 }, uVolGroundY: { value: 0 }, uDustAmt: { value: 0 }, uMaxDist: { value: 220 }, uDensity: { value: 1 },
      uCloudK: { value: 1 }, uExt: { value: 0.004 }, uScale: { value: 0.0054 }, uBroad: { value: 0.3 }, uOccPow: { value: 3 },
      tWindNoise: G.tWindNoise,
    };
    this.march = null;
    this.blur = postMaterial({ name: 'volBlur', fragmentShader: BLUR2D_FRAG, uniforms: { tSrc: { value: null }, tCopy: { value: null }, uTexel: { value: new THREE.Vector2() } } });
    this.temporal = postMaterial({
      name: 'volTemporal', fragmentShader: TEMPORAL_FRAG,
      uniforms: {
        tCur: { value: null }, tHist: { value: null }, tCopy: { value: null },
        uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() }, uTexel: { value: new THREE.Vector2() }, uValid: { value: 0 }, uBlend: { value: 0.22 },
      },
    });
  }

  get texture() { return this.rtVol2.texture; }

  setShadowSources(far, near) {
    this.far = far || null; this.near = near || null;
    this.histValid = false;
  }

  setSize(w, h) {
    for (const rt of [this.rtVol, this.rtVol2, ...this.rtHist]) rt.setSize(w, h);
    this.w = w; this.h = h;
    this.histValid = false;
  }

  /** Rebuild the raymarch material when the shadow count or step count changes. */
  _ensureMarch(numShadows) {
    if (this.march && numShadows === this._numShadows && this.steps === this._steps) return;
    this.march?.dispose();
    this._numShadows = numShadows; this._steps = this.steps;
    this.march = postMaterial({
      name: 'volMarch', fragmentShader: marchFrag(ATMOS_OK), uniforms: this.marchUniforms,
      defines: { STEPS: this.steps | 0, NUM_SHADOWS: numShadows },
    });
  }

  /** frame: per-frame camera record from the pipeline; copyTex: rtCopy.texture. */
  render(renderer, frame, copyTex, params) {
    const mapF = shadowTex(this.far), mapN = shadowTex(this.near);
    const n = mapF ? (mapN ? 2 : 1) : 0;
    this._ensureMarch(n);
    const u = this.marchUniforms;
    if (mapF) { u.tShadowFar.value = mapF; u.uShadowMatFar.value.copy(this.far.shadow.matrix); u.uBiasFar.value = depthBias(this.far, 0.6); }
    if (mapN) { u.tShadowNear.value = mapN; u.uShadowMatNear.value.copy(this.near.shadow.matrix); u.uBiasNear.value = depthBias(this.near, 0.06); }
    u.tCopy.value = copyTex;
    u.uInvProj.value.copy(frame.invProj); u.uCamWorld.value.copy(frame.camWorld); u.uCamPos.value.copy(frame.camPos);
    u.uFrame.value = frame.index; u.uVolGroundY.value = frame.groundY;
    u.uMaxDist.value = this.maxDist; u.uDensity.value = params.volDensity ?? 1;
    u.uCloudK.value = params.volClouds ?? 1;
    u.uExt.value = params.volExtinction ?? 0.004;
    u.uScale.value = params.volScale ?? 0.0054;
    u.uBroad.value = params.volBroad ?? 0.3;
    u.uOccPow.value = params.volOccPow ?? 3;
    u.uDustAmt.value = this._dust;
    fsPass(renderer, this.march, this.rtVol);

    // reprojected temporal accumulation of the raw march (denoises the IGN jitter)
    const prev = this.cur; this.cur ^= 1;
    const t = this.temporal.uniforms;
    t.tCur.value = this.rtVol.texture; t.tHist.value = this.rtHist[prev].texture; t.tCopy.value = copyTex;
    t.uInvProj.value.copy(frame.invProj); t.uCamWorld.value.copy(frame.camWorld); t.uCamPos.value.copy(frame.camPos);
    t.uPrevViewProj.value.copy(frame.prevViewProj);
    t.uTexel.value.set(1 / this.w, 1 / this.h);
    t.uValid.value = this.histValid && frame.historyOk ? 1 : 0;
    t.uBlend.value = params.volBlend ?? 0.22;
    fsPass(renderer, this.temporal, this.rtHist[this.cur]);

    // display-only joint-bilateral smoothing → rtVol2 (= this.texture)
    const b = this.blur.uniforms;
    b.tCopy.value = copyTex; b.tSrc.value = this.rtHist[this.cur].texture; b.uTexel.value.set(1 / this.w, 1 / this.h);
    fsPass(renderer, this.blur, this.rtVol2);
    this.histValid = true;
  }

  /** vol off: black shafts (cheaper than branching in the composite and bloom). */
  clear(renderer) {
    const c = renderer.getClearColor(_c), a = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1);
    for (const rt of [...this.rtHist, this.rtVol2]) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setClearColor(c, a);
    this.histValid = false;
  }

  /** combat dust (0..1) that decays over ~1.5 s */
  addDust(k) { this._dust = Math.min(1, this._dust + k); }
  tick(dt) { this._dust = Math.max(0, this._dust - dt / 1.5); }

  dispose() {
    for (const rt of [this.rtVol, this.rtVol2, ...this.rtHist]) rt.dispose();
    this.march?.dispose(); this.blur.dispose(); this.temporal.dispose();
  }
}

const _c = new THREE.Color();
function pickG(keys) { const o = {}; for (const k of keys) o[k] = G[k]; return o; }

/** Depth texture of a DirectionalLight's PCF shadow map (r186: compare-mode DepthTexture), or null. */
function shadowTex(light) {
  const t = light?.shadow?.map?.depthTexture;
  return light && light.castShadow && t && t.compareFunction ? t : null;
}

/** Convert a bias in metres to shadow-depth units for this light's ortho frustum. */
function depthBias(light, meters) {
  const c = light.shadow.camera;
  return meters / Math.max(1e-3, c.far - c.near);
}
