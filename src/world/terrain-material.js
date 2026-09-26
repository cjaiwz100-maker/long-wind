// Terrain ground material (bible §4.5): a patched MeshStandardMaterial that blends the baked splat layers from the
// packed ground-texture arrays with anti-tiling, macro variation, height blending, the far grass-canopy hand-off
// (average blade colour + honami + backlit translucency), cavity + actor contact AO, trample/blood/dust from
// tInteract and the leaf carpet under the golden tree. Owner: world (W).
//
//   const mat = createTerrainMaterial(sets, { aux })   sets = bakeGroundSets() result, aux = DataTexture (tWtAux)
//   mat.userData.params  — live uniforms: canopy (vec4: gain, honami, translucency, backscatter), tint (vec3)
import * as THREE from 'three';
import { G } from '../core/globals.js';
import { U } from '../core/glsl.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { WIND_GLSL, windUniforms } from '../core/wind.js';
import { GROUND_GLSL } from './ground-glsl.js';
import { LAYOUT } from './layout.js';

const FRAG_PARS = /* glsl */`
${GROUND_GLSL}
${WIND_GLSL}
${U('vec3', 'uSunDir')}${U('vec4', 'uActors', '[8]')}${U('sampler2D', 'tInteract')}${U('vec4', 'uInteractRect')}
uniform sampler2D tWtAux;
uniform highp sampler2DArray tWtAlb;
uniform highp sampler2DArray tWtNrm;
uniform float uWtTile[8];
uniform vec3 uWtGain[8];
uniform vec4 uWtTree;       // x, z, crown radius, 0
uniform vec4 uWtCanopy;     // canopy albedo gain, honami gain, translucency gain, backscatter gain
uniform vec4 uWtMisc;       // x canopy start (m), y canopy end (m), z ground darkening under blades, w detail normal strength
uniform sampler2D tWtSunVis; // terrain self-shadowing from the sun (terrain-shadow.js)
uniform vec4 uWtSunRect;
uniform vec4 uWtLight;      // canopy lighting: x blade-side gain, y hot-spot gain, z tussock self-shadow depth, w normal flatten
varying vec3 vWtNrm;

// layer ids (texbake GROUND_LAYERS order)
#define WT_LUSH 0
#define WT_LEAFY 1
#define WT_DRY 2
#define WT_DIRT 3
#define WT_ROAD 4
#define WT_ROCK 5
#define WT_LEAVES 6
#define WT_STONY 7

// one planar layer: albedo (rgb, a = blend height) + packed normal (xy, rough, ao); far self-resample anti-tiling
float wtCanopyHide = 0.0;   // canopy cover over the splat layers (set before the layer loop): hidden layers skip anti-tiling
void wt_planar(int L, vec2 xz, vec2 dX, vec2 dY, float far, bool cheap, out vec4 A, out vec4 N) {
  float tile = uWtTile[L];
  vec3 uv = vec3(xz / tile, float(L));
  vec2 dx = dX / tile, dy = dY / tile;
  A = textureGrad(tWtAlb, uv, dx, dy);
  N = textureGrad(tWtNrm, uv, dx, dy);
  if (!cheap && far > 0.2 && wtCanopyHide < 0.7) {
    vec3 uv2 = vec3(uv.xy * 0.21 + 0.37, uv.z);
    A = mix(A, textureGrad(tWtAlb, uv2, dx * 0.21, dy * 0.21) * vec4(1.04, 1.02, 1.0, 1.0), far * 0.55);
    N = mix(N, textureGrad(tWtNrm, uv2, dx * 0.21, dy * 0.21), far * 0.55);
  }
  A.rgb *= uWtGain[L];
}

// rock: biplanar-ish triplanar (weights^4, projections under 4% skipped), UDN normal swizzle → world normal
void wt_rock(vec3 wp, vec3 Ng, vec3 dPx, vec3 dPy, bool cheap, out vec4 A, out vec3 Nw, out float rough) {
  float tile = uWtTile[WT_ROCK];
  vec3 bw = pow(abs(Ng), vec3(4.0)); bw /= dot(bw, vec3(1.0));
  if (cheap) { bw = step(max(bw.x, max(bw.y, bw.z)), bw); bw /= dot(bw, vec3(1.0)); }
  A = vec4(0.0); vec4 nx = vec4(0.5, 0.5, 0.8, 1.0), ny = nx, nz = nx; rough = 0.0;
  float Lr = float(WT_ROCK);
  if (bw.x > 0.04) { vec3 uv = vec3(wp.zy / tile, Lr); vec4 a = textureGrad(tWtAlb, uv, dPx.zy / tile, dPy.zy / tile); nx = textureGrad(tWtNrm, uv, dPx.zy / tile, dPy.zy / tile); A += a * bw.x; }
  if (bw.y > 0.04) { vec3 uv = vec3(wp.xz / tile, Lr); vec4 a = textureGrad(tWtAlb, uv, dPx.xz / tile, dPy.xz / tile); ny = textureGrad(tWtNrm, uv, dPx.xz / tile, dPy.xz / tile); A += a * bw.y; }
  if (bw.z > 0.04) { vec3 uv = vec3(wp.xy / tile, Lr); vec4 a = textureGrad(tWtAlb, uv, dPx.xy / tile, dPy.xy / tile); nz = textureGrad(tWtNrm, uv, dPx.xy / tile, dPy.xy / tile); A += a * bw.z; }
  float sw = (bw.x > 0.04 ? bw.x : 0.0) + (bw.y > 0.04 ? bw.y : 0.0) + (bw.z > 0.04 ? bw.z : 0.0);
  A /= max(sw, 1e-4);
  vec2 tx = nx.xy * 2.0 - 1.0, ty = ny.xy * 2.0 - 1.0, tz = nz.xy * 2.0 - 1.0;
  Nw = normalize(bw.x * vec3(Ng.x, Ng.y + tx.y, Ng.z + tx.x) + bw.y * vec3(Ng.x + ty.x, Ng.y, Ng.z + ty.y) + bw.z * vec3(Ng.x + tz.x, Ng.y + tz.y, Ng.z));
  rough = (nx.b * bw.x + ny.b * bw.y + nz.b * bw.z);
  A.rgb *= uWtGain[WT_ROCK];
}

vec3 wtAlb; vec3 wtNw; float wtRough; float wtC; float wtAO; float wtMicro = 1.0; float wtSunVis = 1.0; vec3 wtNc = vec3(0.0, 1.0, 0.0);

// gradient of wx_vnoise (analytic: one noise evaluation instead of four central differences)
vec2 wt_vgrad(vec2 p) { return wx_vnoised(p).yz; }

float wt_bias(int i, float macro, float rut) {
  return i == 0 || i == 1 || i == 6 ? macro * 0.25 : i == 2 ? (1.0 - macro) * 0.2 : i == 4 ? -rut * 0.3 : 0.0;
}
// blend slot i (0 lush, 1 leafy, 2 dry, 3 dirt, 4 road, 5 rock (triplanar), 6 stony) → albedo + packed normal
void wt_layer(int i, vec3 wp, vec2 xz, vec3 Ng, vec3 dPx, vec3 dPy, vec2 dX, vec2 dY, float far, bool cheap, bool hidden,
              out vec4 A, out vec4 N, inout vec3 rN, inout float rR) {
  N = vec4(0.5, 0.5, 1.0, 1.0);
  if (hidden) { A = vec4(0.2, 0.16, 0.07, 0.5); N = vec4(0.5, 0.5, 0.85, 1.0); return; }
  if (i == 5) { wt_rock(wp, Ng, dPx, dPy, cheap, A, rN, rR); return; }
  int L = i == 0 ? WT_LUSH : i == 1 ? WT_LEAFY : i == 2 ? WT_DRY : i == 3 ? WT_DIRT : i == 4 ? WT_ROAD : WT_STONY;
  wt_planar(L, xz, dX, dY, far, cheap, A, N);
}

// Raindrop rings: 3 cell layers (1.7 / 2.45 / 3.3 cells per metre), one drop per cell with a random
// centre, rate and phase; ring radius grows with phase, profile sin(1.6x)·exp(−.35x²). Returns the height gradient.
vec2 wt_ripples(vec2 p, float t) {
  vec2 g = vec2(0.0);
  for (int L = 0; L < 3; L++) {
    float cpm = L == 0 ? 1.7 : L == 1 ? 2.45 : 3.3;
    vec2 q = p * cpm + float(L) * 17.3;
    vec2 cell = floor(q), f = q - cell;
    vec3 h = fract(vec3(cell.xyx) * vec3(0.1031, 0.1030, 0.0973));
    h += dot(h, h.yzx + 33.33); h = fract((h.xxy + h.yzz) * h.zyx);
    vec2 dv = f - (0.3 + 0.4 * h.xy);
    float ph = fract(t * (1.1 + 0.8 * h.z) + h.x * 7.0);
    float r = length(dv), R = ph * 0.3;
    float x = (r - R) * 26.0;
    float prof = sin(1.6 * x) * exp(-0.35 * x * x) * (1.0 - ph) * (1.0 - ph);
    g += dv / max(r, 1e-3) * prof;
  }
  return g;
}
float wtPool = 0.0, wtWetK = 0.0, wtCamD = 0.0;
${U('sampler2D', 'tSceneCopy')}
uniform mat4 projectionMatrix;   // (vertex-stage uniform, shared)
// screen-space trace of a mirrored ray through the previous frame's opaque snapshot → rgb, a = hit confidence.
// A ray that leaves the top of the screen while the snapshot there is near geometry (a culm, a trunk, a wall — not sky
// or far ridges) is taken as blocked by that geometry: tall things above the frame still darken their reflections.
vec4 wt_ssr(vec3 P, vec3 R) {
  float t = 0.3;
  vec4 last = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    vec3 Q = P + R * t;
    vec4 c = projectionMatrix * (viewMatrix * vec4(Q, 1.0));
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0) return vec4(0.0);
    if (uv.y > 1.0) break;
    vec4 sc = texture2D(tSceneCopy, uv);
    if (sc.a > 0.0 && sc.a < c.w && c.w - sc.a < max(t * 0.6, 0.5)) {
      float edge = smoothstep(0.0, 0.1, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
      return vec4(sc.rgb, edge);
    }
    last = sc;
    t *= 1.6;
  }
  // ran off the top of the frame / out of steps: continue into whatever near geometry the ray was last over
  return vec4(last.rgb, last.a > 0.0 ? (1.0 - smoothstep(60.0, 160.0, last.a)) * 0.85 : 0.0);
}
void wt_wet(vec2 xz, vec3 Ng, vec4 gnd, vec4 spl, float c, float rut, float roadW, float camD,
            inout vec3 alb, inout vec3 N, inout float rough) {
  float wet = clamp(uWet, 0.0, 1.0);
  float soil = clamp(spl.a, 0.0, 1.0), rockW = clamp(spl.b, 0.0, 1.0);
  // soaked albedo: bare soil/road ×0.55, grassy ground ×0.66, rock ×0.72, far grass canopy ×0.82
  float dk = mix(mix(0.66, 0.55, soil), 0.72, rockW);
  dk = mix(dk, 0.82, c);
  alb *= mix(1.0, dk, wet);
  float wr = mix(mix(0.5, 0.3, soil), 0.4, rockW);
  wr = mix(wr, 0.66, c);
  rough = mix(rough, wr, wet);
  // puddles: noise-shaped patches, pulled into wheel ruts, the road and baked hollows (cavity AO), flat ground only
  // (a low-frequency wet-zone field modulates puddle-sized blobs, so water gathers in some stretches and not others)
  float zone = wx_vnoise(xz * 0.07 + 3.1) - 0.5;
  float pn = wx_vnoise(xz * 0.62 - 1.7) * 0.72 + wx_vnoise(xz * 2.3 + 5.0) * 0.28;
  float bias = zone * 0.45 + rut * 0.22 + soil * roadW * 0.06 + (1.0 - gnd.a) * 0.3 - c * 0.5 - rockW * 0.3 - (1.0 - soil) * 0.06;
  float level = smoothstep(0.94, 0.99, Ng.y);
  float lvl = pn + bias - (1.0 - wet) * 0.25;          // puddles fill in as the ground gets wetter
  float pool = smoothstep(0.7, 0.73, lvl) * level * wet;
  float rim = smoothstep(0.6, 0.7, lvl) * level * wet;
  alb *= 1.0 - rim * 0.3;
  wtPool = pool; wtWetK = wet * (1.0 - c); wtCamD = camD;
  if (pool > 0.001) {
    alb = mix(alb, alb * 0.25, pool);                  // water over mud: the reflection carries the look
    rough = mix(rough, 0.04, pool);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float rk = uRain * (1.0 - smoothstep(12.0, 38.0, camD));
    if (rk > 0.01) {
      vec2 g = wt_ripples(xz, uTime) * 0.55 * rk;
      g += (vec2(wx_vnoise(xz * 1.3 + uTime * vec2(0.4, -0.3)), wx_vnoise(xz * 1.3 - 9.0 + uTime * vec2(-0.3, 0.35))) - 0.5) * 0.06 * rk;
      n = normalize(vec3(-g.x, 1.0, -g.y));
    }
    N = normalize(mix(N, n, pool));
  }
}

void wt_ground() {
  vec3 wp = vWxWorldPos; vec2 xz = wp.xz;
  vec3 Ng = normalize(vWtNrm);
  vec3 toCam = cameraPosition - wp; float camD = length(toCam); vec3 V = toCam / max(camD, 1e-3);
  // derivatives in uniform control flow (layers are sampled with textureGrad inside branches)
  vec3 dPx = dFdx(wp), dPy = dFdy(wp);
  vec2 dX = dPx.xz, dY = dPy.xz;
  float far = smoothstep(18.0, 70.0, camD);
  bool cheap = camD > 260.0;

  // baked world data, cross-faded to procedural far defaults over the last ~30 m of the ±512 m square
  vec2 wuv = wt_worldUV(xz);
  float edge = smoothstep(0.0, 0.03, min(min(wuv.x, 1.0 - wuv.x), min(wuv.y, 1.0 - wuv.y)));
  vec4 spl = vec4(0.0), gnd = vec4(0.0), aux = vec4(0.0, 0.5, 0.0, 0.0);
  if (edge > 0.0) { spl = texture2D(tSplat, wuv); gnd = texture2D(tGround, wuv); aux = texture2D(tWtAux, wuv); }
  if (edge < 1.0) {
    float slope = 1.0 - Ng.y;
    float R = smoothstep(0.2, 0.42, slope + (wx_vnoise(xz * 0.03) - 0.5) * 0.12);
    float dry = clamp(0.55 + (wx_vnoise(xz * 0.011) - 0.5) * 1.3 + (wx_vnoise(xz * 0.043) - 0.5) * 0.4, 0.0, 1.0) * (1.0 - R);
    vec4 fs = vec4((1.0 - R) * (1.0 - dry), dry, R, 0.0);
    float green = smoothstep(0.62, 0.8, wx_vnoise(xz * 0.018 + 4.0)) * (1.0 - dry * 0.6);
    vec4 fg = vec4((1.0 - R) * (0.72 + 0.2 * wx_vnoise(xz * 0.05)), 0.7, green, 0.92);
    spl = mix(fs, spl, edge); gnd = mix(fg, gnd, edge); aux = mix(vec4(0.0, 1.0, 0.0, 0.0), aux, edge);
  }

  // long hill shadows (terrain self-shadowing bake); beyond the ±150 m far shadow map this is the only cast shadow
  {
    vec2 suv = (xz - uWtSunRect.xy) * uWtSunRect.w;
    if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) wtSunVis = texture2D(tWtSunVis, suv).r;
  }
  // interaction: trample → dirt before the height blend; blood; dust
  vec4 ix = vec4(0.0);
  vec2 iuv = (xz - uInteractRect.xy) * uInteractRect.w;
  if (camD < 60.0 && iuv.x > 0.0 && iuv.y > 0.0 && iuv.x < 1.0 && iuv.y < 1.0) ix = texture2D(tInteract, iuv);
  spl.a += ix.r * 0.8 * (1.0 - spl.b);

  // sub-layer weights
  float macro = wx_vnoise(xz * 0.04) * 0.65 + wx_vnoise(xz * 0.12) * 0.35;
  float leafy = smoothstep(0.3, 0.75, gnd.b + (wx_vnoise(xz * 0.09 + 2.0) - 0.5) * 0.6);
  float stony = smoothstep(0.62, 0.8, wx_vnoise(xz * 0.021 - 5.0) + aux.a * 0.2) * (1.0 - gnd.b);
  float roadW = clamp(aux.r + aux.a * 0.35, 0.0, 1.0);
  float w[7];
  w[0] = spl.r * (1.0 - leafy) * (1.0 - stony);   // lush → sparse_grass
  w[1] = spl.r * leafy;                          // leafy_grass
  w[2] = spl.g;                                  // thatch
  w[3] = spl.a * (1.0 - roadW);                  // bare cracked soil
  w[4] = spl.a * roadW;                          // road
  w[5] = spl.b;                                  // rock (triplanar)
  w[6] = spl.r * (1.0 - leafy) * stony;          // grass with pebbles
  int ids[7]; ids[0] = WT_LUSH; ids[1] = WT_LEAFY; ids[2] = WT_DRY; ids[3] = WT_DIRT; ids[4] = WT_ROAD; ids[5] = WT_ROCK; ids[6] = WT_STONY;

  // wheel ruts: darker, lower-roughness bands ±0.65 m from the centreline
  float sd = (aux.g - 0.5) * 8.0;
  float rut = (1.0 - smoothstep(0.12, 0.42, abs(abs(sd) - 0.68))) * aux.r * (1.0 - far);

  // far grass canopy weight (bible §4.5.5); where it covers ≥98.5% of the ground and no rock shows, the splat layers
  // are invisible (and their detail normal has faded out), so they are not sampled at all
  float dens = gnd.r;
  float c = smoothstep(uWtMisc.x, uWtMisc.y, camD) * dens;
  // (≥94% canopy past 55 m: the last few % of layer colour under the canopy is a flat stand-in, not worth 7 layers)
  bool layersHidden = c > 0.94 && spl.b < 0.004 && camD > 55.0;
  wtCanopyHide = c;
#ifdef WT_FULL
  layersHidden = false;   // A/B reference: every term evaluated everywhere
#endif

  vec3 rockN = Ng; float rockR = 0.8;
  vec3 alb = vec3(0.0); vec2 dn = vec2(0.0); float rough = 0.0, tao = 0.0, bRock = 0.0;
#ifndef WT_ALL_LAYERS
  // Two strongest layers only, held in scalars: the 7-slot arrays of the full blend kept ~70 floats live across the
  // whole shader, and that register pressure (not the fetches) was the cost. A third layer rarely shows through the
  // height blend; it fades out through its weight.
  {
    int i1 = 0, i2 = 1; float w1 = -1.0, w2 = -1.0;
    for (int i = 0; i < 7; i++) {
      if (w[i] > w1) { w2 = w1; i2 = i1; w1 = w[i]; i1 = i; }
      else if (w[i] > w2) { w2 = w[i]; i2 = i; }
    }
    if (layersHidden) { i1 = 0; w1 = 1.0; w2 = 0.0; }
    vec4 A1, N1, A2 = vec4(0.0), N2 = vec4(0.5, 0.5, 1.0, 1.0); vec3 rN = Ng; float rR = 0.8;
    wt_layer(i1, wp, xz, Ng, dPx, dPy, dX, dY, far, cheap, layersHidden, A1, N1, rN, rR);
    if (i1 == 5) { rockN = rN; rockR = rR; }
    float hw1 = w1 + A1.a * 0.55 + wt_bias(i1, macro, rut), hw2 = -1.0;
    if (w2 >= 0.004) {
      wt_layer(i2, wp, xz, Ng, dPx, dPy, dX, dY, far, cheap, layersHidden, A2, N2, rN, rR);
      if (i2 == 5) { rockN = rN; rockR = rR; }
      hw2 = w2 + A2.a * 0.55 + wt_bias(i2, macro, rut);
    }
    float mx = max(hw1, hw2);
    float b1 = max(hw1 - (mx - 0.22), 0.0), b2 = w2 >= 0.004 ? max(hw2 - (mx - 0.22), 0.0) : 0.0;
    float bs = max(b1 + b2, 1e-4); b1 /= bs; b2 /= bs;
    alb = A1.rgb * b1 + A2.rgb * b2;
    if (i1 == 5) { rough += rockR * b1; tao += b1; bRock += b1; } else { dn += (N1.xy * 2.0 - 1.0) * b1; rough += N1.z * b1; tao += N1.w * b1; }
    if (i2 == 5) { rough += rockR * b2; tao += b2; bRock += b2; } else { dn += (N2.xy * 2.0 - 1.0) * b2; rough += N2.z * b2; tao += N2.w * b2; }
  }
#else
  vec4 A[7]; vec4 Nn[7];
  float hw[7]; float mx = -1.0;
  if (layersHidden) { for (int i = 0; i < 7; i++) w[i] = 0.0; w[0] = 1.0; }
  for (int i = 0; i < 7; i++) {
    A[i] = vec4(0.0); Nn[i] = vec4(0.5, 0.5, 1.0, 1.0); hw[i] = -1.0;
    if (w[i] < 0.004) continue;
    if (layersHidden) { A[i] = vec4(0.2, 0.16, 0.07, 0.5); Nn[i] = vec4(0.5, 0.5, 0.85, 1.0); }
    else if (i == 5) wt_rock(wp, Ng, dPx, dPy, cheap, A[i], rockN, rockR);
    else wt_planar(ids[i], xz, dX, dY, far, cheap, A[i], Nn[i]);
    float bias = i == 0 || i == 1 || i == 6 ? macro * 0.25 : i == 2 ? (1.0 - macro) * 0.2 : i == 4 ? -rut * 0.3 : 0.0;
    hw[i] = w[i] + A[i].a * 0.55 + bias;
    mx = max(mx, hw[i]);
  }
  float bl[7]; float bs = 0.0;
  for (int i = 0; i < 7; i++) { bl[i] = w[i] < 0.004 ? 0.0 : max(hw[i] - (mx - 0.22), 0.0); bs += bl[i]; }
  for (int i = 0; i < 7; i++) {
    float b = bl[i] / max(bs, 1e-4);
    alb += A[i].rgb * b;
    if (i == 5) { rough += rockR * b; tao += b; }
    else { dn += (Nn[i].xy * 2.0 - 1.0) * b; rough += Nn[i].z * b; tao += Nn[i].w * b; }
  }
  bRock = bl[5] / max(bs, 1e-4);
#endif
  alb *= mix(1.0, 0.72, rut) * mix(1.0, 0.8, (1.0 - tao) * 0.6);
  rough = mix(rough, 0.75, rut);

  // leaf carpet under the golden tree (settled leaves; the tree itself is V's)
  float tprox = aux.b;
  if (tprox > 0.01 && !layersHidden) {
    float lm = smoothstep(0.58, 0.8, wx_vnoise(xz * 5.3) * 0.6 + wx_vnoise(xz * 13.0) * 0.4 + tprox * 0.35) * smoothstep(0.0, 0.3, tprox);
    if (lm > 0.004) {
      vec4 LA, LN;
      wt_planar(WT_LEAVES, xz, dX, dY, far, cheap, LA, LN);
      alb = mix(alb, LA.rgb * vec3(1.15, 1.02, 0.7), lm * 0.85);
      dn = mix(dn, LN.xy * 2.0 - 1.0, lm * 0.7);
      rough = mix(rough, LN.z, lm);
    }
  }

  // macro tint (field-scale colour variation, bible §4.5.2)
  alb *= mix(vec3(0.84, 0.92, 0.80), vec3(1.12, 1.04, 0.88), macro);
  alb *= mix(vec3(1.0), vec3(1.08, 1.0, 0.86), wx_vnoise(xz * 0.0065));

  // blood (ink) and kicked dust from the interaction map
  if (ix.b > 0.001) {
    float bm = smoothstep(0.3, 0.6, ix.b + 0.3 * wx_vnoise(xz * 9.0));
    alb = mix(alb, vec3(0.10, 0.005, 0.006), bm); rough = mix(rough, 0.35, bm);
  }
  alb *= 1.0 + 0.12 * clamp(ix.a, 0.0, 1.0);

  // detail normal: UDN on the planar layers + the triplanar rock normal
  float dStr = uWtMisc.w * (1.0 - far * 0.6) * (1.0 - smoothstep(60.0, 75.0, camD));
  vec3 N = normalize(vec3(Ng.x + dn.x * dStr, Ng.y, Ng.z + dn.y * dStr));
  N = normalize(mix(N, rockN, bRock * (1.0 - smoothstep(120.0, 260.0, camD))));

  // ---- far grass canopy (bible §4.5.5): terrain becomes the average visible blade colour (only where it shows)
  float fw = length(fwidth(xz));                    // (derivatives in uniform control flow)
#ifdef WT_FULL
  if (false) {}
#else
  if (c <= 0.002) alb *= mix(uWtMisc.z, 1.0, 1.0 - dens);
#endif
  else {
  float tipFrac = mix(0.85, 0.45, clamp(V.y * 3.0, 0.0, 1.0));
  vec3 canopy = wt_canopyColor(xz, gnd.b * 0.8, tipFrac) * uWtCanopy.x;
  // tufts, clumps and wind-combed streaks (octaves fade out below ~2 px per cycle: no shimmer)
  float q1 = 1.0 - smoothstep(0.2, 0.7, fw * 1.1), q2 = 1.0 - smoothstep(0.2, 0.7, fw * 3.7);
  float clump = (wx_vnoise(xz * 0.31 + 5.0) - 0.5) * 0.7;
  if (q1 > 0.0) clump += (wx_vnoise(xz * 1.1) - 0.5) * 0.55 * q1;           // octaves under ~2 px are skipped, not just faded
  if (q2 > 0.0) clump += (wx_vnoise(xz * 3.7 - 2.0) - 0.5) * 0.45 * q2;
  vec2 wd = normalize(uWind.xy);
  vec2 wq = vec2(dot(xz, wd), dot(xz, vec2(-wd.y, wd.x)));
  float sq = 1.0 - smoothstep(0.3, 1.0, fw * 0.55);
  float streak = sq > 0.0 ? (wx_vnoise(vec2(wq.x * 0.045, wq.y * 0.55)) - 0.5) * sq : 0.0;
  canopy *= (1.0 + clump * 0.55) * (1.0 + streak * 0.28);
  // steppe shrubs (锦鸡儿-like) in loose clusters: dark olive dots that make the distant field read as vegetation.
  // Unresolved dots fade to their mean coverage, so a far cluster becomes a darker stand instead of aliasing.
  float cl = smoothstep(0.45, 0.8, wx_vnoise(xz * 0.035 + 3.0) * 0.8 + wx_vnoise(xz * 0.11) * 0.2);
  float dv = 1.0 - smoothstep(0.3, 0.7, fw * 0.45);
  float shrub = cl > 0.0 ? mix(0.3, dv > 0.0 ? smoothstep(0.55, 0.75, wx_vnoise(xz * 0.45 + 9.0)) : 0.3, dv) * cl : 0.0;
  float scrub = shrub * smoothstep(70.0, 130.0, camD);
  canopy = mix(canopy, canopy * vec3(0.36, 0.38, 0.28), scrub * 0.9);
  alb = mix(alb * mix(uWtMisc.z, 1.0, 1.0 - dens), canopy, c);
  // canopy micro-relief: tussock mounds and hummocks (2–22 m). At a 9° sun a few degrees of slope swing the light
  // by ±40%, which is what makes a distant field read as grass instead of sand. Octaves fade by pixel footprint.
  if (c > 0.01) {
    vec2 g = vec2(0.0);
    g += wt_vgrad(xz * 0.045 + 1.3) * (1.2 * 0.045) * (1.0 - smoothstep(0.3, 0.6, fw * 0.045));
    float g2 = 1.0 - smoothstep(0.3, 0.6, fw * 0.14), g3 = 1.0 - smoothstep(0.3, 0.6, fw * 0.45);
    if (g2 > 0.0) g += wt_vgrad(xz * 0.14 - 4.1) * (0.3 * 0.14) * g2;
    if (g3 > 0.0) g += wt_vgrad(xz * 0.45 + 7.7) * (0.08 * 0.45) * g3;
    wtNc = normalize(Ng - vec3(g.x, 0.0, g.y) * c);
    N = normalize(N - vec3(g.x, 0.0, g.y) * c);
  }
  // keep most of the terrain relief: the canopy normal leans only a little toward up + wind
  N = normalize(mix(N, normalize(Ng + vec3(uWind.x, 1.6, uWind.y) * 0.5), c * uWtLight.w));
  // tussock self-shadowing: at a low sun every clump throws a long shadow, so the field reads as a mottled pile
  // (not sand). Elongated along the shadow direction; octaves fade to their mean below ~2 px (no shimmer, same
  // average darkening at any distance). Strongest cross-sun, weakest looking down-sun (the hot spot hides shadows).
  {
    vec2 sd = normalize(-uSunDir.xz + vec2(1e-4));
    vec2 tq = vec2(dot(xz, sd), dot(xz, vec2(-sd.y, sd.x)));
    float lowSun = 1.0 - smoothstep(0.12, 0.6, uSunDir.y);
    float v1 = 1.0 - smoothstep(0.25, 0.8, fw * 1.2), v2 = 1.0 - smoothstep(0.25, 0.8, fw * 3.6);
    float t1 = v1 > 0.0 ? mix(0.5, wx_vnoise(tq * vec2(0.3, 1.0) + 3.7), v1) : 0.5;
    float t2 = v2 > 0.0 ? mix(0.5, wx_vnoise(tq * vec2(1.0, 3.2) - 1.3), v2) : 0.5;
    float sh = smoothstep(0.3, 0.7, t1 * 0.6 + t2 * 0.4);
    float downSun = pow(clamp(dot(V, uSunDir), 0.0, 1.0), 3.0);
    wtMicro = mix(1.0, mix(1.0 - uWtLight.z, 1.0, sh), c * lowSun * (1.0 - 0.7 * downSun));
  }
  // honami: gust fronts keep rolling past the blades as bright bands (strongest looking into the wind)
  float gst = windGust(wp);
  float facing = clamp(dot(uWind.xy, -V.xz / max(length(V.xz), 1e-3)) * 0.5 + 0.5, 0.0, 1.0);
  alb *= 1.0 + uWtCanopy.y * (gst - 0.55) * c * (0.45 + 0.55 * facing);
  rough = mix(rough, 0.82, c);
  }

  // ---- occlusion: baked cavity + actor contact AO + blob shadows (bible §5.5)
  float ao = mix(1.0, gnd.a, 1.0 - c * 0.35);
  vec2 shDir = normalize(-uSunDir.xz);
#ifdef WT_FULL
  for (int i = 0; i < 8; i++) {
#else
  if (camD < 80.0) for (int i = 0; i < 8; i++) {
#endif
    vec4 a = uActors[i];
    if (a.w <= 0.0 || abs(wp.y - a.y) > 2.5) continue;
    float d = length(xz - a.xz);
    ao *= 1.0 - 0.45 * exp(-(d * d) / (0.55 * 0.55));
    float ds = length(xz - (a.xz + shDir * 0.6));
    ao *= 1.0 - 0.35 * exp(-(ds * ds) / (0.8 * 0.8));
  }
  float wr = clamp(rough * 1.05 + 0.12, 0.62, 1.0);   // dry steppe ground: no wet-looking sheen into the sun
  // ---- rain (G.uWet): soaked darker albedo, glossy soil, puddles in ruts / hollows / on the road with raindrop rings.
  // Uniform branch: the dry path costs one compare. (The generic chunks.js wetness is disabled for this material.)
  if (uWet > 0.001) wt_wet(xz, Ng, gnd, spl, c, rut, roadW, camD, alb, N, wr);
  wtAlb = alb * ao;
  wtNw = N;
  wtRough = wr;
  wtC = c;
  wtAO = ao;
}
`;

// Sun capture: every RE_Direct call whose direction is the key light accumulates its (shadowed) colour, so the canopy
// translucency term respects both shadow maps and cloud shadows however the lighting owner patches the light loop.
const SUN_CAPTURE = /* glsl */`
vec3 wtSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
vec3 wtSunC = vec3(0.0);
#undef RE_Direct
#define RE_Direct(dl, gp, gn, gv, gcn, mt, rl) { if (dot(dl.direction, wtSunV) > 0.9995) { dl.color *= wtMicro * wtSunVis; wtSunC += dl.color; } RE_Direct_Physical(dl, gp, gn, gv, gcn, mt, rl); }
`;

const CANOPY_LIGHT = /* glsl */`
#undef RE_Direct
#define RE_Direct RE_Direct_Physical
{
  vec3 wtRay = -normalize(vViewPosition);                           // camera → fragment
  float sunBack = pow(clamp(dot(wtRay, wtSunV), 0.0, 1.0), 4.0);     // looking into the sun through the blades
  float hot = pow(clamp(dot(-wtRay, wtSunV), 0.0, 1.0), 6.0);        // sun behind the camera: opposition hot spot
  // blades stand up, so the canopy catches the low sun far better than the ground plane under it
  float wrap = clamp(dot(wtNc, uSunDir) * 0.6 + 0.4, 0.0, 1.0);
  reflectedLight.directDiffuse += wtSunC * wtAlb * uWtLight.x * wrap * wrap * wtC;
  reflectedLight.directDiffuse += wtSunC * wtAlb * (sunBack * 1.6 + 0.2) * 0.55 * wtC * uWtCanopy.z;
  reflectedLight.directDiffuse += wtSunC * wtAlb * hot * uWtLight.y * wtC;
}
`;

// Wet reflections. The env cube only holds the sky dome, which at night / in a storm is far darker than the fog-lit
// air the eye sees at the horizon, so at night / in storms (weighted by uNight + uStorm) puddles, and soaked soil
// faintly, reflect at least the in-scattered fog colour along the mirrored ray (Schlick, water F0 0.02, mottled like
// the cloud deck). Puddles within 70 m also trace the mirrored ray through last frame's half-res opaque snapshot
// (pipeline copyTexture: rgb + linear depth), so the dark silhouettes of culms, rocks and ridges stand in the water.
// 12 geometric steps, puddle pixels only.
const WET_LIGHT = /* glsl */`
if (wtWetK > 0.0) {
  vec3 wV = normalize(cameraPosition - vWxWorldPos);
  vec3 wR = reflect(-wV, wtNw); wR.y = max(wR.y, 0.015); wR = normalize(wR);
  float wF = 0.02 + 0.98 * pow(1.0 - clamp(dot(wtNw, wV), 0.0, 1.0), 5.0);
  vec3 wSky = wx_skyFogColor(wR) * wF * (wtPool + wtWetK * 0.12) * clamp(uNight + uStorm, 0.0, 1.0);
  vec2 wCp = wR.xz / max(wR.y, 0.08) * 0.35 + uWind.xy * uTime * 0.03;   // cloud mottling in the mirrored sky
  wSky *= 0.5 + 0.9 * (wx_vnoise(wCp) * 0.6 + wx_vnoise(wCp * 2.7 + 3.0) * 0.4);
  reflectedLight.indirectSpecular = max(reflectedLight.indirectSpecular, wSky);
  if (wtPool > 0.02 && wtCamD < 70.0) {
    vec4 hit = wt_ssr(vWxWorldPos, wR);
    hit.a *= wtPool * (1.0 - smoothstep(50.0, 70.0, wtCamD));
    reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, hit.rgb * (wF * 0.85), hit.a);
  }
}
`;

export function createTerrainMaterial(sets, { aux }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = 'terrain';
  const params = {
    tWtAux: { value: aux },
    tWtAlb: { value: sets.albedo },
    tWtNrm: { value: sets.normal },
    uWtTile: { value: Array.from(sets.tile) },
    uWtGain: { value: sets.gain },
    uWtTree: { value: new THREE.Vector4(LAYOUT.oldTree.x, LAYOUT.oldTree.z, LAYOUT.oldTree.crown, 0) },
    uWtCanopy: { value: new THREE.Vector4(0.34, 0.3, 1.0, 1.0) },
    uWtLight: { value: new THREE.Vector4(0.62, 0.22, 0.55, 0.3) },
    uWtMisc: { value: new THREE.Vector4(25, 85, 0.55, 0.9) },
  };
  mat.userData.params = params;
  patchMaterial(mat);
  addShaderHook(mat, 'wtTerrain', (shader) => {
    Object.assign(shader.uniforms, windUniforms(), params, {
      tHeight: G.tHeight, tGround: G.tGround, tSplat: G.tSplat, uWorldRect: G.uWorldRect,
      uSunDir: G.uSunDir, uActors: G.uActors, tInteract: G.tInteract, uInteractRect: G.uInteractRect,
      tSceneCopy: G.tSceneCopy || (G.tSceneCopy = { value: null }),
      tWtSunVis: G.tWtSunVis || { value: null }, uWtSunRect: G.uWtSunRect || { value: new THREE.Vector4(0, 0, 1, 1) },
    });
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vWtNrm;\nvoid main() {')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWtNrm = objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', FRAG_PARS + '\nvoid main() {')
      .replace('#include <map_fragment>', 'wt_ground();\ndiffuseColor.rgb = wtAlb;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = wtRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(wtNw, 0.0)).xyz);')
      .replace('#include <lights_physical_fragment>', '#define uWet 0.0\n#include <lights_physical_fragment>\n#undef uWet')   // own wetness (wt_wet)
      .replace('#include <lights_fragment_begin>', SUN_CAPTURE + '#include <lights_fragment_begin>')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + CANOPY_LIGHT + WET_LIGHT);
  });
  return mat;
}
