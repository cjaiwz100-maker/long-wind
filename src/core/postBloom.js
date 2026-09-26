// Bloom (bible §2.4.4): firefly-safe bright pass (scene + shafts, clamp 60, Rec.709 soft knee at 0.9), then a
// dual-Kawase chain — N downsamples (4·centre + 4 diagonals)/8 and N tent upsamples accumulated progressively
// (ups[d] = mips[d] + tent(coarser)·0.85). Only real highlights bloom: sun, blade glints, sparks, trail cores.
// Owner: post-processing (R). Used only by core/pipeline.js.
import * as THREE from 'three';
import { postMaterial, fsPass, makeRT, POST_GLSL } from './postCommon.js';

const BRIGHT_FRAG = /* glsl */`
${POST_GLSL}
uniform sampler2D tScene, tVol;
uniform vec2 uTexel;          // full-res texel
uniform float uVolAmt, uVolOcc, uThreshold, uKnee;
varying vec2 vUv;
vec3 tap(vec2 o) { return min(texture(tScene, vUv + o * uTexel).rgb, vec3(60.0)); }
void main() {
  // 4 bilinear taps = a 4×4 full-res footprint. Karis (1/(1+luma)) weights stop sub-pixel glints on grass
  // tips and the blade from flickering the whole halo.
  vec3 a = tap(vec2(-1.0, -1.0)), b = tap(vec2(1.0, -1.0)), c = tap(vec2(-1.0, 1.0)), d = tap(vec2(1.0, 1.0));
  float wa = 1.0 / (1.0 + dot(a, WXP_LUMA709)), wb = 1.0 / (1.0 + dot(b, WXP_LUMA709));
  float wc = 1.0 / (1.0 + dot(c, WXP_LUMA709)), wd = 1.0 / (1.0 + dot(d, WXP_LUMA709));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  vec4 vol = texture(tVol, vUv);
  col = col * mix(1.0, clamp(vol.a, 0.0, 1.0), uVolOcc * min(uVolAmt, 1.0)) + vol.rgb * uVolAmt;   // same shaft terms as the composite
  col = min(col, vec3(60.0));
  float l = dot(col, WXP_LUMA709);
  float k = max(l - uThreshold, 0.0); k = k * k / (k + uKnee);
  gl_FragColor = vec4(col * (k / max(l, 1e-4)), 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;          // source texel
varying vec2 vUv;
void main() {
  vec3 c = texture(tSrc, vUv).rgb * 4.0;
  c += texture(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  c += texture(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;
  c += texture(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
  c += texture(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;
  gl_FragColor = vec4(c * 0.125, 1.0);
}
`;

const UP_FRAG = /* glsl */`
uniform sampler2D tCoarse, tFine;
uniform vec2 uTexel;          // coarse texel
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec3 c = (texture(tCoarse, vUv + vec2(-1.0, 0.0) * uTexel).rgb + texture(tCoarse, vUv + vec2(1.0, 0.0) * uTexel).rgb
          + texture(tCoarse, vUv + vec2(0.0, -1.0) * uTexel).rgb + texture(tCoarse, vUv + vec2(0.0, 1.0) * uTexel).rgb) * 2.0;
  c += texture(tCoarse, vUv + vec2(-1.0, -1.0) * uTexel).rgb + texture(tCoarse, vUv + vec2(1.0, -1.0) * uTexel).rgb
     + texture(tCoarse, vUv + vec2(-1.0, 1.0) * uTexel).rgb + texture(tCoarse, vUv + vec2(1.0, 1.0) * uTexel).rgb;
  gl_FragColor = vec4(texture(tFine, vUv).rgb + c / 12.0 * uWeight, 1.0);
}
`;

export class BloomPass {
  constructor(levels = 6) {
    this.levels = levels;          // mips[0..levels-1]; levels-1 down + levels-1 up passes
    this.mips = []; this.ups = [];
    for (let i = 0; i < 7; i++) {
      this.mips.push(makeRT(1, 1, { name: `bloomMip${i}` }));
      this.ups.push(makeRT(1, 1, { name: `bloomUp${i}` }));
    }
    this.bright = postMaterial({
      name: 'bloomBright', fragmentShader: BRIGHT_FRAG,
      uniforms: { tScene: { value: null }, tVol: { value: null }, uTexel: { value: new THREE.Vector2() }, uVolAmt: { value: 0.85 }, uVolOcc: { value: 0.6 }, uThreshold: { value: 0.9 }, uKnee: { value: 1.2 } },
    });
    this.down = postMaterial({ name: 'bloomDown', fragmentShader: DOWN_FRAG, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } } });
    this.up = postMaterial({ name: 'bloomUp', fragmentShader: UP_FRAG, uniforms: { tCoarse: { value: null }, tFine: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 0.85 } } });
    this.output = this.ups[0];
  }

  get texture() { return this.output.texture; }

  setSize(hw, hh) {
    let w = hw, h = hh;
    for (let i = 0; i < this.mips.length; i++) {
      this.mips[i].setSize(w, h); this.ups[i].setSize(w, h);
      w = Math.max(2, Math.round(w / 2)); h = Math.max(2, Math.round(h / 2));
    }
  }

  render(renderer, sceneTex, volTex, fullW, fullH, params) {
    const L = Math.max(2, Math.min(this.levels, this.mips.length));
    const b = this.bright.uniforms;
    b.tScene.value = sceneTex; b.tVol.value = volTex;
    b.uTexel.value.set(1 / fullW, 1 / fullH);
    b.uVolAmt.value = params.vol; b.uVolOcc.value = params.volOcclusion ?? 0.6; b.uThreshold.value = params.bloomThreshold; b.uKnee.value = params.bloomKnee;
    fsPass(renderer, this.bright, this.mips[0]);
    const d = this.down.uniforms;
    for (let i = 1; i < L; i++) {
      const src = this.mips[i - 1];
      d.tSrc.value = src.texture; d.uTexel.value.set(1 / src.width, 1 / src.height);
      fsPass(renderer, this.down, this.mips[i]);
    }
    const u = this.up.uniforms;
    u.uWeight.value = params.bloomSpread ?? 0.85;
    let coarse = this.mips[L - 1];
    for (let i = L - 2; i >= 0; i--) {
      u.tCoarse.value = coarse.texture; u.tFine.value = this.mips[i].texture;
      u.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
      fsPass(renderer, this.up, this.ups[i]);
      coarse = this.ups[i];
    }
    this.output = this.ups[0];
  }

  dispose() { for (const rt of [...this.mips, ...this.ups]) rt.dispose(); this.bright.dispose(); this.down.dispose(); this.up.dispose(); }
}
