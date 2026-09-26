// Gentle SSAO (bible §2.4.3): half-res, 8 golden-spiral samples in a normal-oriented hemisphere, normals from
// depth derivatives (picking the flatter neighbour per axis), IGN rotation, distance-scaled radius and bias
// tuned for a noisy blade field, then a bilateral H+V blur at 1.2 texels. Output R = AO (1 = open).
// Owner: post-processing (R). Used only by core/pipeline.js.
import * as THREE from 'three';
import { postMaterial, fsPass, makeRT, POST_GLSL } from './postCommon.js';
import { BILATERAL_FRAG } from './postVolumetric.js';

const AO_FRAG = /* glsl */`
${POST_GLSL}
uniform sampler2D tCopy;
uniform mat4 uProj, uInvProj;
uniform vec2 uTexel;
uniform float uFrame;
varying vec2 vUv;

vec3 viewPos(vec2 uv, float lin) {
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = v.xyz / v.w;
  return dir * (lin / max(-dir.z, 1e-4));
}
vec3 viewPosAt(vec2 uv) { return viewPos(uv, texture(tCopy, uv).a); }

void main() {
  float lin = texture(tCopy, vUv).a;
  if (lin > 160.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv, lin);
  // depth-derived normal: per axis use the neighbour whose depth is closer (no silhouette smearing)
  vec3 pl = viewPosAt(vUv - vec2(uTexel.x, 0.0)), pr = viewPosAt(vUv + vec2(uTexel.x, 0.0));
  vec3 pd = viewPosAt(vUv - vec2(0.0, uTexel.y)), pu = viewPosAt(vUv + vec2(0.0, uTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  float dist = length(P);
  float R = clamp(0.5 + 0.02 * dist, 0.5, 1.6);
  float bias = 0.03 + 0.002 * dist;
  // tangent frame
  vec3 T = normalize(abs(N.y) < 0.99 ? cross(N, vec3(0.0, 1.0, 0.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = cross(N, T);
  float rot = wxp_ign(gl_FragCoord.xy) * 6.2831853;
  float occ = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float fi = float(i);
    float a = fi * 2.39996 + rot;
    float r = sqrt((fi + 0.5) / float(SAMPLES));
    float h = 0.25 + 0.75 * fract(fi * 0.618 + rot * 0.159);
    float s = (0.35 + 0.65 * fract(fi * 0.37 + 0.13)) * R;
    vec3 sp = P + (T * (cos(a) * r) + B * (sin(a) * r) + N * h) * s;
    vec4 clip = uProj * vec4(sp, 1.0);
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    if (any(lessThan(suv, vec2(0.0))) || any(greaterThan(suv, vec2(1.0)))) continue;
    float sceneD = texture(tCopy, suv).a;
    float diff = -sp.z - sceneD;                 // > 0: the scene surface is in front of the sample point
    occ += step(bias, diff) * smoothstep(1.0, 0.0, (diff - R) / R);
  }
  float ao = 1.0 - occ / float(SAMPLES);
  gl_FragColor = vec4(ao, 1.0, 1.0, 1.0);
}
`;

export class AOPass {
  constructor() {
    this.samples = 8;
    this.rtA = makeRT(1, 1, { name: 'ao', format: THREE.RGFormat });
    this.rtB = makeRT(1, 1, { name: 'ao2', format: THREE.RGFormat });
    this._samples = -1;
    this.uniforms = {
      tCopy: { value: null }, uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() }, uFrame: { value: 0 },
    };
    this.mat = null;
    this.blur = postMaterial({ name: 'aoBlur', fragmentShader: BILATERAL_FRAG, uniforms: { tSrc: { value: null }, tCopy: { value: null }, uStep: { value: new THREE.Vector2() } } });
  }
  get texture() { return this.rtA.texture; }
  setSize(w, h) { this.rtA.setSize(w, h); this.rtB.setSize(w, h); this.w = w; this.h = h; }

  render(renderer, frame, copyTex) {
    if (this._samples !== this.samples) {
      this.mat?.dispose();
      this._samples = this.samples;
      this.mat = postMaterial({ name: 'ssao', fragmentShader: AO_FRAG, uniforms: this.uniforms, defines: { SAMPLES: this.samples | 0 } });
    }
    const u = this.uniforms;
    u.tCopy.value = copyTex; u.uProj.value.copy(frame.proj); u.uInvProj.value.copy(frame.invProj);
    u.uTexel.value.set(1 / this.w, 1 / this.h); u.uFrame.value = frame.index;
    fsPass(renderer, this.mat, this.rtA);
    const b = this.blur.uniforms;
    b.tCopy.value = copyTex;
    b.tSrc.value = this.rtA.texture; b.uStep.value.set(1.2 / this.w, 0);
    fsPass(renderer, this.blur, this.rtB);
    b.tSrc.value = this.rtB.texture; b.uStep.value.set(0, 1.2 / this.h);
    fsPass(renderer, this.blur, this.rtA);
  }

  /** AO off: a constant white 1×1 is cheaper than branching in the composite. */
  clear(renderer) {
    renderer.setRenderTarget(this.rtA);
    const c = renderer.getClearColor(_c), a = renderer.getClearAlpha();
    renderer.setClearColor(0xffffff, 1); renderer.clear(true, false, false);
    renderer.setClearColor(c, a);
  }

  dispose() { this.rtA.dispose(); this.rtB.dispose(); this.mat?.dispose(); this.blur.dispose(); }
}
const _c = new THREE.Color();
