// GLSL for the GPU-procedural grass (bible §5.2–5.6). Owner: vegetation (V). Used by grass.js.
// Every blade is generated in the vertex shader from (tile, gl_InstanceID, aT, aSide): stratified root inside a
// camera-following tile, clump membership, species and colour, terrain height (tHeight), ground info (tGround),
// wind (WIND_GLSL), actor push, trample/cut/blood from tInteract, shock rings, slash gusts, a length-preserving
// quadratic Bézier and view-dependent widening. The fragment side is a patched MeshLambertMaterial: dome normals,
// backlit translucency with the SHADOWED sun, Kajiya sheen and honami bend sheen.
import { U } from '../core/glsl.js';
import { GLSL_NOISE } from '../core/noise.js';
import { WIND_GLSL } from '../core/wind.js';
import { VEG_GROUND_GLSL, FLOWER_PATCH_GLSL } from './foliage.js';

// Colour palette (bible §1.4 / §5.3), linear. Exported so the terrain canopy can match the blades exactly.
export const GRASS_PALETTE = {
  golden: { root: [0.035, 0.028, 0.010], mid: [0.26, 0.19, 0.06], tip: [0.62, 0.46, 0.16] },
  bleached: { root: [0.035, 0.028, 0.010], mid: [0.35, 0.27, 0.10], tip: [0.78, 0.66, 0.36] },
  green: { root: [0.03, 0.045, 0.012], mid: [0.12, 0.16, 0.04], tip: [0.30, 0.34, 0.09] },
};
const v3 = (a) => `vec3(${a.map((x) => x.toFixed(4)).join(', ')})`;

/**
 * Species / colour functions shared by the blades and (optionally) the terrain canopy far field.
 *   float grassGreen(vec2 xz, float moisture)  — 0 golden … 1 late-green (15–35 m patches)
 *   vec3 grassMacro(vec2 xz)                    — slow warm/pale tint shared by blades and canopy
 *   vec3 grassSpeciesMid(xz, moisture), grassSpeciesTip(xz, moisture) — canopy averages (bleached fraction folded in)
 * Needs GLSL_NOISE (wx_vnoise).
 */
export const GRASS_SPECIES_GLSL = /* glsl */`
#ifndef WX_GRASS_SPECIES
#define WX_GRASS_SPECIES
const vec3 GR_ROOT_G = ${v3(GRASS_PALETTE.golden.root)};
const vec3 GR_MID_G  = ${v3(GRASS_PALETTE.golden.mid)};
const vec3 GR_TIP_G  = ${v3(GRASS_PALETTE.golden.tip)};
const vec3 GR_MID_B  = ${v3(GRASS_PALETTE.bleached.mid)};
const vec3 GR_TIP_B  = ${v3(GRASS_PALETTE.bleached.tip)};
const vec3 GR_ROOT_L = ${v3(GRASS_PALETTE.green.root)};
const vec3 GR_MID_L  = ${v3(GRASS_PALETTE.green.mid)};
const vec3 GR_TIP_L  = ${v3(GRASS_PALETTE.green.tip)};
float grassGreen(vec2 xz, float moisture) {
  float s = wx_vnoise(xz * 0.045 + vec2(3.7, -1.9)) * 0.65 + wx_vnoise(xz * 0.11 + vec2(-7.3, 4.1)) * 0.35;
  s += 0.38 * moisture - 0.12;
  return smoothstep(0.56, 0.74, s);
}
vec3 grassMacro(vec2 xz) {
  float m = wx_vnoise(xz * 0.021 + vec2(11.0, 3.0)) * 0.7 + wx_vnoise(xz * 0.0065 - 5.0) * 0.3;
  // warm russet ↔ pale straw drift over whole hillsides
  return mix(vec3(1.06, 0.96, 0.82), vec3(0.94, 1.0, 1.10), m);
}
vec3 grassSpeciesMid(vec2 xz, float moisture) {
  float gr = grassGreen(xz, moisture);
  return mix(mix(GR_MID_G, GR_MID_B, 0.15), GR_MID_L, gr) * grassMacro(xz);
}
vec3 grassSpeciesTip(vec2 xz, float moisture) {
  float gr = grassGreen(xz, moisture);
  return mix(mix(GR_TIP_G, GR_TIP_B, 0.15), GR_TIP_L, gr) * grassMacro(xz);
}
#endif
`;

// ---------------------------------------------------------------- vertex
export function grassVertexPars(extra = '') {
  return /* glsl */`
${GLSL_NOISE}
${extra}
${WIND_GLSL}
${GRASS_SPECIES_GLSL}
${VEG_GROUND_GLSL}
${FLOWER_PATCH_GLSL}
uniform vec4 uTiles[64];      // xy tile origin (world xz), z tile size
uniform float uK;             // blades per tile edge
uniform vec4 uRing;           // fade-in start/end, fade-out start/end (m)
uniform float uWidthMul, uDensityMul, uHeightMul, uPixelWorld;
${U('sampler2D', 'tInteract')}${U('vec4', 'uInteractRect')}
${U('vec4', 'uActors', '[8]')}${U('vec4', 'uShock', '[4]')}${U('vec4', 'uSlash', '[4]')}${U('vec4', 'uSlashB', '[4]')}
${U('vec3', 'uCamGround')}
varying vec3 vGAlb;
varying vec4 vGParam;         // x t along blade, y AO, z bend angle, w translucency gain
varying vec3 vGTan;           // world tangent (Kajiya)
varying vec4 vGMisc;          // x blood, y sheen gain, z canopy light (self-shadow), w culm/seed-head factor
varying vec3 vGWorld;         // world position (honami view angle)

`;
}

// Main blade body. Defines: GR_TIER (0/1/2). Writes `vec3 grPos` (world) and `vec3 grNormal` (world).
// Blade kinds inside a clump: arching leaves (most), seed-bearing culms (thin, tall, straight, pale spikelet head),
// and dead blades (grey-brown, flopped). Rows are warped toward the tip on the CPU side (curvature + heads).
export const GRASS_VERTEX_BODY = /* glsl */`
  float aSide = position.x;
  float aT = position.y;
  int per = int(uK * uK + 0.5);
  int ti = gl_InstanceID / per;
  int bi = gl_InstanceID - ti * per;
  vec4 tile = uTiles[ti];
  int kk = int(uK + 0.5);
  vec2 cell = vec2(float(bi % kk), float(bi / kk));
  vec2 tc = floor(tile.xy / tile.z + 0.5);
  vec2 jit = wx_hash22(tc * 127.1 + cell * 1.37 + float(GR_TIER) * 19.19);
  vec2 root = tile.xy + (cell + jit) * (tile.z / uK);

  // clumps: nearest jittered point of a 0.75 m lattice (2x2 search) → shared lean, height, species
  const float CL = 0.75;
  vec2 cb = floor(root / CL - 0.5);
  float best = 1e9; vec2 cPos = root; vec2 cId = cb;
  for (int yy = 0; yy < 2; yy++) for (int xx = 0; xx < 2; xx++) {
    vec2 id = cb + vec2(float(xx), float(yy));
    vec2 pnt = (id + 0.18 + 0.64 * wx_hash22(id * 1.713 + 11.3)) * CL;
    vec2 dd = pnt - root; float d2 = dot(dd, dd);
    if (d2 < best) { best = d2; cPos = pnt; cId = id; }
  }
  float hc = wx_hash12(cId * 3.17 + 0.5);
  root = mix(root, cPos, 0.3);
  vec2 toC = root - cPos;

  vec4 gi = gxGround(root);
  float h1 = wx_hash12(root * 91.7);
  float h2 = wx_hash12(root * 47.3 + 5.1);
  float h3 = wx_hash12(root * 13.9 - 2.7);
  float h4 = wx_hash12(root * 71.1 + 9.3);
  float h5 = wx_hash12(root * 29.3 - 7.7);
  float dist = length(root - cameraPosition.xz);
  float keep = smoothstep(uRing.x, uRing.y, dist + h1 * 2.0) * (1.0 - smoothstep(uRing.z, uRing.w, dist + h1 * 4.0));
  keep *= step(h2, gi.r * uDensityMul);

  // species and blade kind
  float green = uGreenMode > 0.5
    ? smoothstep(0.08, 0.92, gi.b + (wx_vnoise(root * 0.35) - 0.5) * 0.18)
    : grassGreen(root, gi.b);
  float bleach = step(hc, 0.16) * (1.0 - green);
  float culm = step(h4, mix(0.16, 0.42, bleach) * (1.0 - 0.6 * green));
  float dead = step(h5, 0.07) * (1.0 - culm);

  float canopyH = mix(0.38, 1.05, gi.g) * uHeightMul;
  float H = canopyH * mix(0.72, 1.25, hc) * (0.74 + 0.5 * h3);
  H *= mix(1.0, 0.82, green) * (1.0 + 0.22 * bleach) * (1.0 + 0.3 * culm) * (1.0 - 0.25 * dead);
  // wildflower meadows (flowers.js reads the same field): a shorter, thinner sward so the flowers stand clear
  float fCore;
  float fPatch = vegFlowerPatch(root, fCore);
  H *= 1.0 - fPatch * mix(0.34, 0.46, fCore);
  keep *= step(fPatch * mix(0.08, 0.16, fCore), wx_hash12(root * 5.3 + 1.7));

  // interaction map (trample R, cut G, blood B, dust A)
  vec4 im = vec4(0.0);
  vec2 iuv = (root - uInteractRect.xy) * uInteractRect.w;
  bool inMap = all(greaterThan(iuv, vec2(0.004))) && all(lessThan(iuv, vec2(0.996)));
#if GR_TIER < 2
  if (inMap) im = textureLod(tInteract, iuv, 0.0);
#endif
  float cutK = 1.0 - 0.72 * im.g;
  H *= cutK;

  // lens clearing (low camera)
  if (uCamGround.z > 0.0) {
    float dc = length(root - uCamGround.xy);
    H *= smoothstep(uCamGround.z * 0.5, uCamGround.z * 1.15, dc);
  }
  H *= keep;

  vec3 base = vec3(root.x, gxHeight(root) - 0.03, root.y);
  if (H < 0.005) {
    grPos = base; grNormal = vec3(0.0, 1.0, 0.0); vGWorld = base;
    vGAlb = vec3(0.0); vGParam = vec4(0.0); vGTan = vec3(0.0, 1.0, 0.0); vGMisc = vec4(0.0);
  } else {
  // ---- bend: natural lean + wind + push + trample + shock + slash (radians along bd) ----
  vec2 wdir = uWind.xy;
  vec2 wside = vec2(-wdir.y, wdir.x);
  float yaw = hc * 6.2832 + (h1 - 0.5) * 2.4;
  vec2 face = vec2(cos(yaw), sin(yaw));
  vec2 outward = length(toC) > 1e-3 ? normalize(toC) : face;
  // tufts splay outward like a fountain; prevailing wind has combed them downwind over the season
  vec2 leanDir = normalize(outward * 0.9 + face * 0.5 + wdir * 0.55);
  float leanA = mix(0.18, 0.72, h3) * (0.55 + 0.45 * smoothstep(0.04, 0.3, length(toC)));
  leanA = mix(leanA, 0.12 + 0.1 * h3, culm);
  leanA = mix(leanA, 0.9 + 0.4 * h3, dead);
  vec2 lean = leanDir * leanA;

  float g = windGust(base);
  float along = dot(root, uWind.xy);
  float s01 = 0.5 + 0.5 * sin(uTime * 1.7 - along * 0.7 + hc * 1.3);
  float flexH = (smoothstep(0.2, 1.0, H) * 0.9 + 0.1) * (1.0 + 0.35 * culm);
  vec2 windB = wdir * (0.30 + 0.55 * s01) * g * flexH
             + wside * sin(uTime * 1.7 + hc * 14.0 + along * 0.31) * 0.12 * g * flexH;

  vec2 push = vec2(0.0);
  float contact = 0.0;
#if GR_TIER < 2
  for (int i = 0; i < 8; i++) {
    vec4 a = uActors[i];
    if (a.w <= 0.0) continue;
    vec2 d = root - a.xz;
    float dl = length(d);
    float R = a.w * 1.35 + 0.3 * H;
    float f = (1.0 - smoothstep(0.25 * R, R, dl)) * step(a.y - base.y, 1.6);
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
    vec2 tdir = length(gr) > 0.02 ? -normalize(gr) : normalize(face + wdir * 0.8);
    push += normalize(tdir + face * 0.35) * im.r * 1.3;
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
    float a2 = clamp((age - hh * 0.12) / 0.35, 0.0, 1.0);        // gust front travels along the arc
    float pulse = sin(3.14159 * a2) * exp(-dl / 1.2) * (1.0 - smoothstep(1.8, 2.5, dl));
    vec2 nrm = dl > 1e-3 ? dv / dl : normalize(vec2(-ba.y, ba.x) + 1e-4);
    push += nrm * sb.y * pulse * 1.1 / (1.0 + max(sb.z - 0.6, 0.0) * 0.7);
  }
#endif
  vec2 bend = lean + windB + push;
#if GR_TIER == 0
  // tip flick (per blade, ~1.1 Hz) folded into the bend angle
  bend += vec2(sin(uTime * 7.0 + root.x * 3.0 + h1 * 20.0), cos(uTime * 6.3 + root.y * 3.0 + h2 * 9.0)) * 0.05 * g * (1.0 + culm);
#endif
  float blen = length(bend);
  float ang = min(blen, 1.5);
  vec2 bd = bend / max(blen, 1e-4);
  float baseK = clamp(length(push) / max(blen, 1e-3), 0.0, 1.0);   // contact bends at the root, wind at the tip

  // ---- length-preserving quadratic Bézier (root at 0): stiff base, arching tip ----
  float curl = mix(0.35, 1.0, h2) * (1.0 - 0.7 * culm);
  vec3 P2 = vec3(bd.x * sin(ang), cos(ang), bd.y * sin(ang)) * H;
  float a1 = ang * mix(mix(0.22, 0.45, culm), 0.92, baseK);
  vec3 P1 = vec3(bd.x * sin(a1), cos(a1), bd.y * sin(a1)) * H * 0.6 + vec3(bd.x, 0.0, bd.y) * H * 0.14 * curl;
  float L = (2.0 * length(P2) + length(P1) + length(P2 - P1)) / 3.0;
  P1 *= H / L; P2 *= H / L;
  float t = aT;
  vec3 p = 2.0 * (1.0 - t) * t * P1 + t * t * P2;
  vec3 tanW = normalize(2.0 * (1.0 - t) * P1 + 2.0 * t * (P2 - P1) + vec3(0.0, 1e-4, 0.0));

  // blade width axis: perpendicular to the bend where bent, else the blade's own facing
  vec2 pf = vec2(-face.y, face.x);
  vec2 pb = vec2(-bd.y, bd.x);
  if (dot(pf, pb) < 0.0) pb = -pb;
  vec2 sd = normalize(mix(pf, pb, clamp(ang * 1.4, 0.0, 1.0)) + 1e-4);
  vec3 sideV = vec3(sd.x, 0.0, sd.y);

  float W = mix(0.0065, 0.0145, h1) * uWidthMul * mix(1.0, 0.38, culm);
  float w = W * (1.0 - 0.9 * pow(t, 1.25));
  // culm seed head: a slim spikelet swelling below the tip (L0/L1 only; L2 is too coarse)
  float head = 0.0;
#if GR_TIER < 2
  head = culm * smoothstep(0.7, 0.8, t);
  w = mix(w, W * 3.2 * sin(3.14159 * clamp((t - 0.72) / 0.28, 0.0, 1.0)), head);
#endif
  vec3 wp = base + p;
  vec3 V = cameraPosition - wp; float vd = length(V); V /= max(vd, 1e-4);
  vec3 Nf = normalize(cross(sideV, tanW));
  float fv = dot(Nf, V);
  if (fv < 0.0) { Nf = -Nf; fv = -fv; }
  w *= 1.0 + (1.0 - fv) * 0.8;                                    // edge-on blades never become slivers
  w = max(w, uPixelWorld * vd * (0.95 - 0.45 * t));               // ≥ ~0.9 px: grass anti-aliasing
  grPos = wp + sideV * aSide * w * 0.5;
  vGWorld = grPos;

  // ---- normals: rounded cross-section + clump dome (reference trick) ----
  vec3 Nr = normalize(Nf + sideV * aSide * 0.35);
  vec3 Nd = normalize(vec3(bd.x * 0.5 + toC.x * 2.0, 0.8, bd.y * 0.5 + toC.y * 2.0));
  grNormal = normalize(mix(Nr, Nd, 0.5));

  // ---- colour ----
  vec3 cRoot = mix(GR_ROOT_G, GR_ROOT_L, green);
  vec3 cMid = mix(mix(GR_MID_G, GR_MID_B, bleach), GR_MID_L, green);
  vec3 cTip = mix(mix(GR_TIP_G, GR_TIP_B, bleach), GR_TIP_L, green);
  vec3 alb = mix(cRoot, cMid, smoothstep(0.0, 0.55, t));
  alb = mix(alb, cTip, smoothstep(0.45, 1.0, t));
  // seed heads bleach to pale straw; dead blades go grey-brown
  alb = mix(alb, GR_TIP_B * vec3(1.0, 0.97, 0.9), head * 0.85);
  alb = mix(alb, mix(vec3(0.07, 0.06, 0.045), vec3(0.34, 0.30, 0.24), smoothstep(0.1, 0.9, t)), dead * 0.85);
  // per-clump tint: brightness 0.82–1.18, r ×0.95–1.08, b ×0.8–1.0; per-blade value jitter
  vec3 th = vec3(wx_hash12(cId + 1.3), wx_hash12(cId + 7.1), wx_hash12(cId - 3.9));
  alb *= (0.82 + 0.36 * th.x) * vec3(0.95 + 0.13 * th.y, 1.0, 0.8 + 0.2 * th.z);
  alb *= 0.8 + 0.4 * fract(h4 * 7.13 + h5 * 3.1);
#ifdef GR_W_MACRO
  alb *= wt_grassMacro(root);   // the world's field tint: blades hand off to the terrain canopy with no seam
#else
  alb *= grassMacro(root);
#endif
  alb *= 1.0 + 0.12 * im.a;   // kicked dust lightens

  // AO: root ramp, dense-field darkening, cavity, actor contact
  float yAbove = p.y;
  float ao = mix(0.40, 1.0, smoothstep(0.0, 0.55, t));
#if GR_TIER < 2
  ao *= mix(0.62, 1.0, smoothstep(0.0, canopyH, yAbove));
#endif
  ao *= mix(1.0, gi.a, 0.85);
  ao *= 1.0 - 0.42 * (1.0 - t) * contact;

  // canopy light: at 9.5° sun elevation only the top of the sward sees the sun; blades standing proud glow
  float lit = smoothstep(canopyH * 0.25, canopyH * 0.95, yAbove + 0.12 * h3);
  lit = max(lit, 0.18 * step(0.85, h5));   // sun flecks through gaps

  vGAlb = alb;
  vGParam = vec4(t, ao, ang * (1.0 - baseK * 0.6), mix(1.7, 1.4, green) * (1.0 + 0.4 * head));
  vGTan = tanW;
  vGMisc = vec4(im.b * (1.0 - t * 0.55), mix(0.05, 0.03, green) * (1.0 - dead), lit, head);
  }
`;

// ---------------------------------------------------------------- fragment
export function grassFragmentPars() {
  return /* glsl */`
${U('vec4', 'uWind')}
varying vec3 vGAlb;
varying vec4 vGParam;
varying vec3 vGTan;
varying vec4 vGMisc;
varying vec3 vGWorld;
`;
}

// Replaces color_fragment. Honami: bent blades show their brighter, waxier flank; strongest along the wind axis.
export const GRASS_COLOR_FRAG = /* glsl */`
  vec3 grV = normalize(vGWorld - cameraPosition);
  float grAlong = abs(dot(uWind.xy, normalize(grV.xz + 1e-4)));
  diffuseColor.rgb = vGAlb * (1.0 + 0.42 * vGParam.z * (0.55 + 0.45 * grAlong));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.10, 0.005, 0.006), smoothstep(0.25, 0.6, vGMisc.x) * 0.9);
  diffuseColor.rgb *= vGParam.y;
`;

// After lights_fragment_begin: canopy self-shadow on the direct terms, backlit translucency (shadowed sun) and
// Kajiya sheen. Lambert drops directSpecular, so the sheen goes into directDiffuse.
export function grassLightFrag(sunC, sunD) {
  return /* glsl */`
  {
    float lit = vGMisc.z;
    reflectedLight.directDiffuse *= mix(0.3, 1.0, lit);
    vec3 sunC = ${sunC} * lit; vec3 sunLv = ${sunD};
    float sunBack = pow(saturate(dot(-geometryViewDir, sunLv)), 4.0);
    float gt = vGParam.x;
    // transmitted light: slightly warmer than the albedo but not neon (dry blades transmit a pale gold)
    vec3 alb = diffuseColor.rgb;
    vec3 trans = mix(vec3(dot(alb, vec3(0.3, 0.6, 0.1))), alb, 0.8) * vec3(1.04, 0.95, 0.80);
    reflectedLight.directDiffuse += sunC * trans * (sunBack * vGParam.w + 0.2) * gt * gt;
    vec3 T = normalize((viewMatrix * vec4(vGTan, 0.0)).xyz);
    vec3 Hh = normalize(sunLv + geometryViewDir);
    float TH = dot(T, Hh);
    reflectedLight.directDiffuse += sunC * vGMisc.y * pow(sqrt(max(0.0, 1.0 - TH * TH)), 64.0) * gt;
  }
`;
}
