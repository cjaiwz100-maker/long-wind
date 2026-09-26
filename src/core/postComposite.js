// COMPOSITE (bible §2.4.5, order is law): CA (+hit kick) → radial hit blur → AO → shafts + bloom + sun veil →
// exposure (+kick, flash) → HDR white balance → ACES (no /0.6) → painterly grade tuned for golden grass →
// vignette / low health / slow-mo focus → letterbox → sRGB, luma in alpha (FXAA input).
// Half-res AO and shafts are joint-bilateral upsampled against full-res depth so the swordsman's silhouette stays
// crisp against the shafts. Owner: post-processing (R). Used only by core/pipeline.js.
import * as THREE from 'three';
import { G } from './globals.js';
import { U } from './glsl.js';
import { postMaterial, POST_GLSL } from './postCommon.js';

export const DEBUG_VIEWS = { none: 0, ao: 1, vol: 2, bloom: 3, depth: 4, copy: 5 };

const FRAG = /* glsl */`
${POST_GLSL}
${U('vec3', 'uSunCol')}${U('float', 'uSunVis')}${U('float', 'uStorm')}${U('float', 'uNight')}
uniform sampler2D tScene, tDepth, tCopy, tAO, tVol, tBloom;
uniform vec2 uNearFar, uHalfSize, uTexel;
uniform float uAspect;
uniform float uCA, uAO, uVolAmt, uVolOcc, uHueKeep, uBloom, uExposure, uWarm, uSat, uVigFloor, uLowHealth, uPulse, uSlowmo, uLetterbox;
uniform vec3 uRadial;          // xy centre (uv), z strength
uniform vec3 uSunScreen;       // xy uv, z > 0 when the sun is in front
uniform vec4 uFlash;           // rgb * intensity
uniform int uDebug;
varying vec2 vUv;

vec3 grade(vec3 m) {
  float l = dot(m, WXP_LUMA601);
  m += vec3(0.006, 0.020, 0.026) * (1.0 - smoothstep(0.0, 0.4, l));            // teal shadow lift
  m  = mix(m, m * vec3(1.05, 0.99, 0.88), smoothstep(0.4, 1.0, l));           // amber highlights
  float lime = smoothstep(0.0, 0.06, m.g - max(m.r * 0.95, m.b)) * smoothstep(0.3, 0.8, l);
  m  = mix(m, m * vec3(1.07, 0.97, 0.80), lime * 0.6);                        // lime → gold in bright greens
  m  = mix(vec3(l), m, uSat);
  m  = clamp(m, 0.0, 1.0);
  m  = mix(m, m * m * (3.0 - 2.0 * m), 0.38);                                 // S-curve
  return m;
}

void main() {
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);

  // 1 chromatic aberration (radial², plus the hit kick folded into uCA)
  vec2 ca = cc * r2 * uCA;
  vec3 col = vec3(texture(tScene, uv - ca).r, texture(tScene, uv).g, texture(tScene, uv + ca).b);
  // 1b radial hit blur toward the impact point
  if (uRadial.z > 0.0005) {
    vec2 dir = uRadial.xy - uv;
    vec3 acc = col;
    for (int i = 1; i < 8; i++) acc += texture(tScene, uv + dir * (float(i) / 7.0) * uRadial.z).rgb;
    col = acc * 0.125;
  }

  // joint-bilateral upsample weights for the half-res AO + shafts
  float zf = wxp_linearDepth(texture(tDepth, uv).x, uNearFar);
  vec2 hp = uv * uHalfSize - 0.5;
  vec2 f = fract(hp);
  ivec2 i0 = ivec2(floor(hp)), hmax = ivec2(uHalfSize) - 1;
  ivec2 p00 = clamp(i0, ivec2(0), hmax), p10 = clamp(i0 + ivec2(1, 0), ivec2(0), hmax);
  ivec2 p01 = clamp(i0 + ivec2(0, 1), ivec2(0), hmax), p11 = clamp(i0 + ivec2(1, 1), ivec2(0), hmax);
  vec4 dz = vec4(texelFetch(tCopy, p00, 0).a, texelFetch(tCopy, p10, 0).a, texelFetch(tCopy, p01, 0).a, texelFetch(tCopy, p11, 0).a);
  dz = abs(dz - zf) / max(zf, 0.3);
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y) / (4e-4 + dz * dz);
  w /= dot(w, vec4(1.0));
  float ao = texelFetch(tAO, p00, 0).r * w.x + texelFetch(tAO, p10, 0).r * w.y + texelFetch(tAO, p01, 0).r * w.z + texelFetch(tAO, p11, 0).r * w.w;
  vec4 volS = texelFetch(tVol, p00, 0) * w.x + texelFetch(tVol, p10, 0) * w.y + texelFetch(tVol, p01, 0) * w.z + texelFetch(tVol, p11, 0) * w.w;
  vec3 vol = volS.rgb;
  vec3 bloom = texture(tBloom, uv).rgb;

  // 2 AO (distance-faded: never muddies the far slopes)
  col *= mix(1.0, pow(clamp(ao, 0.0, 1.0), 1.4), uAO * (1.0 - smoothstep(60.0, 150.0, zf)));
  // 3 shafts (occlusion carves the shadow volumes into the glow behind, then in-scatter) + bloom + sun veil
  col *= mix(1.0, clamp(volS.a, 0.0, 1.0), uVolOcc * min(uVolAmt, 1.0));
  col += vol * uVolAmt;
  col += bloom * uBloom;
  if (uSunScreen.z > 0.0) {
    float sunOpen = mix(1.0, texture(tVol, uSunScreen.xy).a, uVolOcc);     // the veil dims when the sun is behind the tree
    col += uSunCol * 0.012 * exp(-length((uv - uSunScreen.xy) * vec2(uAspect, 1.0)) * 3.2) * uSunVis * (1.0 - uStorm) * uSunScreen.z * sunOpen;
  }
  // 4 exposure (keyframe + kicks) and flash
  col *= uExposure;
  col += uFlash.rgb * uFlash.a;
  // 5 white balance in HDR
  float lum = dot(col, WXP_LUMA709);
  col = mix(col, col * vec3(1.06, 1.0, 0.90), smoothstep(0.05, 0.8, lum) * uWarm);
  col = mix(col, col * vec3(0.90, 1.0, 1.07), 1.0 - smoothstep(0.0, 0.12, lum));
  col = mix(col, vec3(lum) * vec3(0.72, 0.88, 1.22), uNight * 0.55 * (1.0 - smoothstep(0.02, 0.35, lum)));
  col = mix(col, vec3(lum) * vec3(0.95, 1.0, 1.06), uStorm * 0.3);
  // 6 ACES fitted, with part of the highlight hue kept: per-channel ACES bleaches the golden haze, grass tips and sun
  // glow toward cream; tone-mapping the max channel and scaling rgb keeps them gold (palette: horizon #ffc495,
  // bleached tips #e5d4a2). Fades out toward the sun disc, which should still burn white.
  col = max(col, vec3(0.0));
  vec3 m = wxp_aces(col);
  float cmx = max(col.r, max(col.g, col.b));
  if (uHueKeep > 0.0 && cmx > 1e-4) {
    vec3 hp = col * (wxp_aces(vec3(cmx)).g / cmx);
    float k = uHueKeep * smoothstep(0.15, 0.6, cmx) * (1.0 - smoothstep(3.0, 14.0, cmx));
    m = mix(m, hp, k);
  }
  // 7 painterly grade
  m = grade(m);
  // 7b slow-mo "focus": drained colour, deeper blacks, a breath of cold in the shadows
  if (uSlowmo > 0.0) {
    float l = dot(m, WXP_LUMA601);
    vec3 d = mix(vec3(l), m, 0.55) * mix(vec3(0.94, 0.98, 1.06), vec3(1.03, 1.0, 0.95), smoothstep(0.2, 0.7, l));
    d = mix(d, d * d * (3.0 - 2.0 * d), 0.35);
    m = mix(m, d, uSlowmo);
  }
  // 8 vignette (floor 0.68; low health 0.50 + 35% desaturation + a slow crimson heartbeat at the edges)
  float vig = 1.0 - smoothstep(0.35, 1.05, length(cc * vec2(1.05, 1.25)));
  float floorV = mix(uVigFloor, 0.50, uLowHealth) - 0.10 * uSlowmo;
  m *= mix(floorV, 1.0, vig);
  float lm = dot(m, WXP_LUMA601);
  m = mix(m, vec3(lm), uLowHealth * 0.35 * (1.0 - vig * 0.5));
  m = mix(m, m * vec3(0.55, 0.12, 0.10), uLowHealth * (0.35 + 0.25 * uPulse) * smoothstep(0.55, 0.0, vig));
  // 9 letterbox (2.39:1)
  if (uLetterbox > 0.0) {
    float bar = max(0.0, 0.5 - 0.5 * uAspect / 2.39) * uLetterbox;
    float e = uTexel.y * 1.5;
    m *= smoothstep(bar - e, bar + e, uv.y) * smoothstep(bar - e, bar + e, 1.0 - uv.y);
  }

  // debug views (params.debugView)
  if (uDebug == 1) m = vec3(ao);
  else if (uDebug == 2) m = wxp_aces(vol * uVolAmt * uExposure * 1.5) * mix(0.35, 1.0, volS.a);
  else if (uDebug == 3) m = wxp_aces(bloom * uBloom * uExposure * 6.0);
  else if (uDebug == 4) m = vec3(1.0 - log2(1.0 + zf) / log2(1.0 + uNearFar.y));
  else if (uDebug == 5) m = wxp_aces(texture(tCopy, uv).rgb * uExposure);

  vec3 s = wxp_toSRGB(m);
  gl_FragColor = vec4(s, dot(s, WXP_LUMA601));
}
`;

export function createCompositeMaterial() {
  return postMaterial({
    name: 'composite', fragmentShader: FRAG,
    uniforms: {
      uSunCol: G.uSunCol, uSunVis: G.uSunVis, uStorm: G.uStorm, uNight: G.uNight,
      tScene: { value: null }, tDepth: { value: null }, tCopy: { value: null }, tAO: { value: null }, tVol: { value: null }, tBloom: { value: null },
      uNearFar: { value: new THREE.Vector2(0.3, 7000) }, uHalfSize: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2(1, 1) },
      uAspect: { value: 16 / 9 },
      uCA: { value: 0.0065 }, uAO: { value: 0.55 }, uVolAmt: { value: 0.85 }, uVolOcc: { value: 0.6 }, uHueKeep: { value: 0.45 }, uBloom: { value: 0.055 }, uExposure: { value: 1.05 },
      uWarm: { value: 1 }, uSat: { value: 1.1 }, uVigFloor: { value: 0.68 }, uLowHealth: { value: 0 }, uPulse: { value: 0 },
      uSlowmo: { value: 0 }, uLetterbox: { value: 0 },
      uRadial: { value: new THREE.Vector3(0.5, 0.5, 0) }, uSunScreen: { value: new THREE.Vector3() }, uFlash: { value: new THREE.Vector4() },
      uDebug: { value: 0 },
    },
  });
}
