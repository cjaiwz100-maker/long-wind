// FINAL (bible §2.4.6): rtLDR (sRGB, luma in alpha) → canvas.
// FXAA 3.11 (quality: early exit max(0.0312, 0.125·lumaMax), 10 search steps 1,1,1,1.5,1.5,1.5,2,2,4,4,
// subpixel sub²·0.75) with an unsharp mask on non-edge pixels; with TAA on, FXAA is skipped and every pixel gets
// the (lighter) TAA sharpen. THEN film grain (shadow-weighted) + ±0.5/255 dither — after AA so FXAA doesn't smear
// them and the sharpen doesn't amplify them — THEN the fade to black / warm mist.
// Owner: post-processing (R). Used only by core/pipeline.js.
import * as THREE from 'three';
import { postMaterial, POST_GLSL } from './postCommon.js';

const FRAG = /* glsl */`
${POST_GLSL}
uniform sampler2D tLDR;
uniform vec2 uTexel;
uniform float uSharpen, uGrain, uFrame, uFade;
uniform vec3 uFadeColor;        // display-referred (sRGB) colour
varying vec2 vUv;

#define L(o) textureLodOffset(tLDR, uv, 0.0, o).a
float lumaAt(vec2 p) { return textureLod(tLDR, p, 0.0).a; }

void main() {
  vec2 uv = vUv;
  vec4 M = textureLod(tLDR, uv, 0.0);
  float lumaM = M.a;
  float lumaS = L(ivec2(0, 1)), lumaE = L(ivec2(1, 0)), lumaN = L(ivec2(0, -1)), lumaW = L(ivec2(-1, 0));
  float rangeMax = max(max(lumaN, lumaW), max(lumaE, max(lumaS, lumaM)));
  float rangeMin = min(min(lumaN, lumaW), min(lumaE, min(lumaS, lumaM)));
  float range = rangeMax - rangeMin;
  vec3 rgb;
#if FXAA
  if (range < max(0.0312, rangeMax * 0.125)) {
#else
  if (true) {
#endif
    // not an edge (or TAA mode): unsharp mask against the 4-neighbour average
    vec3 avg = (textureLodOffset(tLDR, uv, 0.0, ivec2(0, 1)).rgb + textureLodOffset(tLDR, uv, 0.0, ivec2(1, 0)).rgb
              + textureLodOffset(tLDR, uv, 0.0, ivec2(0, -1)).rgb + textureLodOffset(tLDR, uv, 0.0, ivec2(-1, 0)).rgb) * 0.25;
    rgb = M.rgb + (M.rgb - avg) * uSharpen;
  } else {
    float lumaNW = L(ivec2(-1, -1)), lumaSE = L(ivec2(1, 1)), lumaNE = L(ivec2(1, -1)), lumaSW = L(ivec2(-1, 1));
    float lumaNS = lumaN + lumaS, lumaWE = lumaW + lumaE;
    float subpixRcpRange = 1.0 / range;
    float subpixNSWE = lumaNS + lumaWE;
    float edgeHorz1 = -2.0 * lumaM + lumaNS, edgeVert1 = -2.0 * lumaM + lumaWE;
    float lumaNESE = lumaNE + lumaSE, lumaNWNE = lumaNW + lumaNE;
    float edgeHorz2 = -2.0 * lumaE + lumaNESE, edgeVert2 = -2.0 * lumaN + lumaNWNE;
    float lumaNWSW = lumaNW + lumaSW, lumaSWSE = lumaSW + lumaSE;
    float edgeHorz4 = abs(edgeHorz1) * 2.0 + abs(edgeHorz2), edgeVert4 = abs(edgeVert1) * 2.0 + abs(edgeVert2);
    float edgeHorz3 = -2.0 * lumaW + lumaNWSW, edgeVert3 = -2.0 * lumaS + lumaSWSE;
    float edgeHorz = abs(edgeHorz3) + edgeHorz4, edgeVert = abs(edgeVert3) + edgeVert4;
    float subpixNWSWNESE = lumaNWSW + lumaNESE;
    float lengthSign = uTexel.x;
    bool horzSpan = edgeHorz >= edgeVert;
    float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
    if (!horzSpan) { lumaN = lumaW; lumaS = lumaE; } else lengthSign = uTexel.y;
    float subpixB = subpixA * (1.0 / 12.0) - lumaM;
    float gradientN = lumaN - lumaM, gradientS = lumaS - lumaM;
    float lumaNN = lumaN + lumaM, lumaSS = lumaS + lumaM;
    bool pairN = abs(gradientN) >= abs(gradientS);
    float gradient = max(abs(gradientN), abs(gradientS));
    if (pairN) lengthSign = -lengthSign;
    float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);
    vec2 posB = uv;
    vec2 offNP = horzSpan ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
    if (!horzSpan) posB.x += lengthSign * 0.5; else posB.y += lengthSign * 0.5;
    vec2 posN = posB - offNP, posP = posB + offNP;
    float subpixD = -2.0 * subpixC + 3.0;
    float lumaEndN = lumaAt(posN), lumaEndP = lumaAt(posP);
    float subpixE = subpixC * subpixC;
    if (!pairN) lumaNN = lumaSS;
    float gradientScaled = gradient * 0.25;
    float lumaMM = lumaM - lumaNN * 0.5;
    float subpixF = subpixD * subpixE;
    bool lumaMLTZero = lumaMM < 0.0;
    lumaEndN -= lumaNN * 0.5; lumaEndP -= lumaNN * 0.5;
    bool doneN = abs(lumaEndN) >= gradientScaled, doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) posN -= offNP;
    if (!doneP) posP += offNP;
    const float STEPS[8] = float[8](1.0, 1.5, 1.5, 1.5, 2.0, 2.0, 4.0, 4.0);   // after the two 1.0 steps above
    for (int i = 0; i < 8; i++) {
      if (doneN && doneP) break;
      if (!doneN) lumaEndN = lumaAt(posN) - lumaNN * 0.5;
      if (!doneP) lumaEndP = lumaAt(posP) - lumaNN * 0.5;
      doneN = abs(lumaEndN) >= gradientScaled; doneP = abs(lumaEndP) >= gradientScaled;
      if (!doneN) posN -= offNP * STEPS[i];
      if (!doneP) posP += offNP * STEPS[i];
    }
    float dstN = horzSpan ? uv.x - posN.x : uv.y - posN.y;
    float dstP = horzSpan ? posP.x - uv.x : posP.y - uv.y;
    bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero, goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
    float spanLengthRcp = 1.0 / (dstP + dstN);
    bool directionN = dstN < dstP;
    float dst = min(dstN, dstP);
    bool goodSpan = directionN ? goodSpanN : goodSpanP;
    float subpixG = subpixF * subpixF;
    float pixelOffset = dst * -spanLengthRcp + 0.5;
    float subpixH = subpixG * 0.75;
    float pixelOffsetSubpix = max(goodSpan ? pixelOffset : 0.0, subpixH);
    vec2 posM = uv;
    if (!horzSpan) posM.x += pixelOffsetSubpix * lengthSign; else posM.y += pixelOffsetSubpix * lengthSign;
    rgb = textureLod(tLDR, posM, 0.0).rgb;
  }

  // film grain (heavier in the shadows) + dither, after AA
  vec2 fc = gl_FragCoord.xy;
  float fr = mod(uFrame, 1024.0);
  float l = dot(rgb, WXP_LUMA601);
  rgb += (wxp_hash12(fc + fract(fr * 0.618034) * 311.0) - 0.5) * uGrain * (1.0 - 0.6 * clamp(l, 0.0, 1.0));
  rgb += (wxp_hash12(fc.yx * 1.3 + fr * 0.713) - 0.5) / 255.0;
  rgb = mix(rgb, uFadeColor, uFade);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

export function createFinalMaterial(fxaa = true) {
  return postMaterial({
    name: 'final', fragmentShader: FRAG, defines: { FXAA: fxaa ? 1 : 0 },
    uniforms: {
      tLDR: { value: null }, uTexel: { value: new THREE.Vector2() }, uSharpen: { value: 0.35 }, uGrain: { value: 0.028 },
      uFrame: { value: 0 }, uFade: { value: 0 }, uFadeColor: { value: new THREE.Vector3() },
    },
  });
}
