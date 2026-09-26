// Shared ground GLSL (bible §0.4 groundHeight/groundInfo + §4.5.5 canopy colours). Owner: world (W).
// Include GROUND_GLSL in any shader that needs the world bakes; bind the uniforms with groundUniforms().
//
//   vec2  wt_worldUV(vec2 xz)            uv into the ±512 m world bakes
//   float wt_inWorld(vec2 xz)            1 inside the baked square, else 0
//   float wt_groundHeight(vec2 xz)       exact rendered-mesh height (manual bilinear of the R32F tHeight bake)
//   vec4  wt_groundInfo(vec2 xz)         tGround: R grass density, G height factor, B late-green weight, A cavity AO
//                                        (outside the bake: far defaults, density 0 so blades never spawn there)
//   vec4  wt_splat(vec2 xz)              tSplat: R lush, G dry thatch, B rock, A dirt/road
//   vec3  wt_grassMid(float green) / wt_grassTip(float green)    species colours (bible §1.4; 15% bleached mixed in)
//   vec3  wt_grassMacro(vec2 xz)         field-scale tint (9–150 m) shared by the blades and the far canopy
//   vec3  wt_canopyColor(vec2 xz, float green, float tipFrac)    average visible blade colour (far field)
// V (grass): use tGround.B as the species weight and wt_grassMacro() for the per-field tint, so blades hand off to
// the terrain canopy with no seam at 25–90 m.
import { G } from '../core/globals.js';
import { U } from '../core/glsl.js';
import { GLSL_NOISE } from '../core/noise.js';

export const GROUND_GLSL = /* glsl */`
${GLSL_NOISE}
#ifndef WT_GROUND
#define WT_GROUND
${U('sampler2D', 'tHeight')}${U('sampler2D', 'tGround')}${U('sampler2D', 'tSplat')}${U('vec4', 'uWorldRect')}
vec2 wt_worldUV(vec2 xz) { return (xz - uWorldRect.xy) * uWorldRect.w; }
float wt_inWorld(vec2 xz) {
  vec2 uv = wt_worldUV(xz);
  return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
}
float wt_groundHeight(vec2 xz) {
  vec2 sz = vec2(textureSize(tHeight, 0));
  vec2 t = clamp(wt_worldUV(xz) * sz - 0.5, vec2(0.0), sz - 1.001);
  ivec2 i = ivec2(floor(t)); vec2 f = t - vec2(i);
  float a = texelFetch(tHeight, i, 0).r, b = texelFetch(tHeight, i + ivec2(1, 0), 0).r;
  float c = texelFetch(tHeight, i + ivec2(0, 1), 0).r, d = texelFetch(tHeight, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec4 wt_groundInfo(vec2 xz) { return wt_inWorld(xz) > 0.5 ? texture2D(tGround, wt_worldUV(xz)) : vec4(0.0, 0.6, 0.25, 1.0); }
vec4 wt_splat(vec2 xz) { return wt_inWorld(xz) > 0.5 ? texture2D(tSplat, wt_worldUV(xz)) : vec4(0.45, 0.55, 0.0, 0.0); }

// species colours, linear (bible §1.4): golden 62%, bleached seed tips ~15% of golden, late-green by tGround.B
vec3 wt_grassMid(float green) { return mix(mix(vec3(0.26, 0.19, 0.06), vec3(0.35, 0.27, 0.10), 0.15), vec3(0.12, 0.16, 0.04), green); }
vec3 wt_grassTip(float green) { return mix(mix(vec3(0.62, 0.46, 0.16), vec3(0.78, 0.66, 0.36), 0.15), vec3(0.30, 0.34, 0.09), green); }
vec3 wt_grassMacro(vec2 xz) {
  float m = wx_vnoise(xz * 0.04 + 7.3) * 0.65 + wx_vnoise(xz * 0.12 - 3.1) * 0.35;
  vec3 c = mix(vec3(0.86, 0.90, 0.84), vec3(1.10, 1.04, 0.92), m);
  // field-scale stands (60–200 m): russet-brown dead grass ↔ pale sun-bleached straw, so the plain is never uniform
  float p = wx_vnoise(xz * 0.011 + 23.0) * 0.7 + wx_vnoise(xz * 0.031 - 9.0) * 0.3;
  c *= mix(vec3(0.74, 0.66, 0.54), vec3(1.08, 1.05, 0.96), smoothstep(0.25, 0.75, p));
  return c * mix(vec3(1.0), vec3(1.07, 1.0, 0.86), wx_vnoise(xz * 0.0065 + 11.0));
}
vec3 wt_canopyColor(vec2 xz, float green, float tipFrac) {
  return mix(wt_grassMid(green), wt_grassTip(green), tipFrac) * wt_grassMacro(xz);
}
#endif
`;

export function groundUniforms() {
  return { tHeight: G.tHeight, tGround: G.tGround, tSplat: G.tSplat, uWorldRect: G.uWorldRect };
}
