// Silver grass (芒 / 荻, Miscanthus) tufts with feathery plumes that blaze in the backlight (bible §5.7).
// Owner: vegetation (V). STABLE API:
//   const plumes = await createPlumes(app, opts?) → { near, far, atlas, count, update(), setDensity(k), stats() }
//     opts: { density = 1, max = 4600, fade = [110, 140] }        registered with app.add automatically
//   plumeAtlas() → { canvas, texture }   256×512 canvas: a panicle of ~400 fine silky strokes + an opaque strip
// Placement: static, CPU-scattered once (seed WORLD.seed + 3031) in noise drifts along the road margins, on the knoll
// flanks and on hollow rims, clustered into clumps; never on the road, rocks, the fighting pad or the tree trunk.
// Rendering: per frame the tufts of visible 32 m cells are compacted into two instance buffers → TWO draw calls
// (near LOD: 12 arching leaves + 3 culms + 3×2 crossed plume ribbons; far LOD: 6 wider leaves + 3 culms + 3 ribbons).
// Every leaf / culm / plume is built in the vertex shader from the instance (position, scale, yaw, seed, combed lean):
// length-preserving Bézier leaves, culms that sway with the shared wind (flex 0.9) and nod under the plume, plume
// ribbons that follow their culm exactly, actor push / trample / shock / slash, cut → stubble, shrink-fade 110–140 m.
// Lighting: patched Lambert + backlit translucency (plume sunBack·2.4 + 0.3). Layer MAIN_ONLY, never casts.
import * as THREE from 'three';
import { G, LAYERS, WORLD } from '../core/globals.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { GLSL_NOISE, mulberry32, noise } from '../core/noise.js';
import { WIND_GLSL } from '../core/wind.js';
import {
  sunTermsSetup, sunGlobalsPars, sunGlobalsUniforms, FOLIAGE_NORMAL_BEGIN, VEG_INTERACT_PARS, VEG_PUSH_GLSL,
  vegInteractUniforms, makeCanvas, dilateAlpha, canvasTexture, VEG_LAYOUT,
} from './foliage.js';

const TEX_W = 256, TEX_H = 512, STRIP_U = 0.975;   // u of the opaque strip used by leaves and culms
const CELL = 32;

// ------------------------------------------------------------------------------------------------ plume texture
let _atlas = null;
export function plumeAtlas() {
  if (_atlas) return _atlas;
  const canvas = makeCanvas(TEX_W, TEX_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, TEX_W, TEX_H);
  const rng = mulberry32(WORLD.seed + 3032);
  const W = 236;                                        // plume region; the right strip stays opaque white
  const cx = W * 0.5;
  // rachis: up the middle, bowing a little toward +x (the panicle's nod side)
  const rach = (v) => [cx + 10 * v * v, TEX_H * (1 - v)];
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgb(196,178,140)';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  for (let i = 0; i <= 20; i++) { const [x, y] = rach(i / 20 * 0.9); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
  // primary branches: appressed near the base, spreading and curling outward higher up; silky hairs along each
  const nb = 26;
  for (let b = 0; b < nb; b++) {
    const v0 = 0.04 + 0.78 * (b / (nb - 1)) + (rng() - 0.5) * 0.03;
    const side = b % 2 ? 1 : -1;
    const [bx, by] = rach(v0);
    const spread = (0.1 + 0.35 * v0 + rng() * 0.12) * side;
    const len = TEX_H * (0.26 + rng() * 0.22) * (1 - 0.35 * v0);
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, a = spread * (0.4 + t * 1.1) + 0.08 * t * t;   // curls outward (and toward +x) with length
      const px = bx + Math.sin(a) * len * t, py = by - Math.cos(a) * len * t;
      pts.push([Math.max(3, Math.min(W - 3, px)), Math.max(3, py)]);
    }
    ctx.strokeStyle = 'rgb(206,188,150)';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    // hairs: fine curved strokes fanning off the branch (≈ 400 in total)
    const nh = 16;
    for (let h = 0; h < nh; h++) {
      const t = 0.08 + 0.92 * (h / nh) + rng() * 0.03;
      const i = Math.min(11, Math.floor(t * 12));
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const dir = Math.atan2(x1 - x0, -(y1 - y0));
      const a = dir + (rng() - 0.5) * 0.9 + side * 0.25;
      const L = 14 + rng() * 26;
      const k = 0.85 + rng() * 0.3;
      ctx.strokeStyle = `rgba(${Math.round(237 * k)},${Math.round(225 * k)},${Math.round(196 * k)},${0.75 + rng() * 0.25})`;
      ctx.lineWidth = 0.9 + rng() * 0.8;
      const ex = x0 + Math.sin(a) * L, ey = y0 - Math.cos(a) * L;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x0 + Math.sin(a - side * 0.3) * L * 0.6, y0 - Math.cos(a - side * 0.3) * L * 0.6,
        Math.max(1, Math.min(W - 1, ex)), Math.max(1, ey));
      ctx.stroke();
    }
  }
  // opaque strip for leaves/culms (sampled at u = STRIP_U)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(W + 4, 0, TEX_W - W - 4, TEX_H);
  dilateAlpha(ctx, TEX_W, TEX_H, 6);
  const texture = canvasTexture(canvas, { aniso: 8 });
  texture.name = 'plumeAtlas';
  _atlas = { canvas, texture };
  return _atlas;
}

// ------------------------------------------------------------------------------------------------ tuft geometry
/** One tuft: `leaves` strips, `culms` strips, `cards` crossed plume ribbons per culm. aElem = (kind, index, card). */
function tuftGeometry({ leaves, leafSegs, culms, culmSegs, cards, cardRows }) {
  const pos = [], elem = [], idx = [];
  const strip = (kind, index, segs) => {
    const b = pos.length / 3;
    for (let r = 0; r < segs; r++) {
      const t = 1 - Math.pow(1 - r / segs, 1.3);
      pos.push(-1, t, 0, 1, t, 0); elem.push(kind, index, 0, kind, index, 0);
    }
    pos.push(0, 1, 0); elem.push(kind, index, 0);
    for (let r = 0; r < segs - 1; r++) { const a = b + r * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    const l = b + (segs - 1) * 2;
    idx.push(l, l + 1, b + segs * 2);
  };
  for (let i = 0; i < leaves; i++) strip(0, i, leafSegs);
  for (let j = 0; j < culms; j++) strip(1, j, culmSegs);
  for (let j = 0; j < culms; j++) {
    for (let c = 0; c < cards; c++) {
      const b = pos.length / 3;
      for (let r = 0; r <= cardRows; r++) { const v = r / cardRows; pos.push(-1, v, 0, 1, v, 0); elem.push(2, j, c, 2, j, c); }
      for (let r = 0; r < cardRows; r++) { const a = b + r * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setAttribute('aElem', new THREE.Float32BufferAttribute(elem, 3));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ------------------------------------------------------------------------------------------------ shaders
const PLUME_VERT_PARS = /* glsl */`
${GLSL_NOISE}
${WIND_GLSL}
${VEG_INTERACT_PARS}
${VEG_PUSH_GLSL}
attribute vec3 aElem;     // kind (0 leaf, 1 culm, 2 plume ribbon), element index, ribbon index
attribute vec4 iPos;      // tuft root (world) + scale
attribute vec4 iMisc;     // yaw, seed, combed lean xz
uniform vec2 uFade;       // shrink-fade start / end (m)
uniform float uLeafW, uPixelWorld;
varying vec3 vPlCol;      // albedo
varying vec4 vPl;         // x t along element, y AO, z translucency gain, w kind

float plH(float a, float b) { return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453); }

// quadratic Bézier from the root with a stiff base; bend = xz direction * angle (radians); L = length
void plCurve(vec2 bend, float L, float stiff, float t, out vec3 p, out vec3 tg) {
  float ang = min(length(bend), 1.55);
  vec2 bd = bend / max(length(bend), 1e-4);
  vec3 P2 = vec3(bd.x * sin(ang), cos(ang), bd.y * sin(ang)) * L;
  float a1 = ang * stiff;
  vec3 P1 = vec3(bd.x * sin(a1), cos(a1), bd.y * sin(a1)) * L * 0.6;
  float Lb = (2.0 * length(P2) + length(P1) + length(P2 - P1)) / 3.0;
  P1 *= L / Lb; P2 *= L / Lb;
  p = 2.0 * (1.0 - t) * t * P1 + t * t * P2;
  tg = normalize(2.0 * (1.0 - t) * P1 + 2.0 * t * (P2 - P1) + vec3(0.0, 1e-4, 0.0));
}
`;

const PLUME_VERT_BODY = /* glsl */`
  vec3 plPos = vec3(0.0, -1e4, 0.0); vec3 plNormal = vec3(0.0, 1.0, 0.0); vec2 plUv = vec2(${STRIP_U}, 0.5);
  vPlCol = vec3(0.0); vPl = vec4(0.0);
  {
    float kind = aElem.x, ei = aElem.y;
    vec3 base = iPos.xyz;
    float seed = iMisc.y;
    float dist = length(base.xz - cameraPosition.xz);
    float S = iPos.w * (1.0 - smoothstep(uFade.x, uFade.y, dist + plH(seed, 3.0) * 10.0));
    vec2 iuv; vec4 im = vegInteractAt(base.xz, iuv);
    float cut = smoothstep(0.3, 0.6, im.g);
    if (uCamGround.z > 0.0) S *= smoothstep(uCamGround.z * 0.8, uCamGround.z * 1.8, length(base.xz - uCamGround.xy));
    if (S > 0.01) {
      // shared tuft wind: gust + the downwind sway wave (bible §5.4) + cross-wind wobble
      vec2 wdir = uWind.xy, wside = vec2(-wdir.y, wdir.x);
      float g = windGust(base);
      float along = dot(base.xz, wdir);
      float s01 = 0.5 + 0.5 * sin(uTime * 1.7 - along * 0.7 + seed * 6.2832);
      vec2 windB = wdir * (0.3 + 0.55 * s01) * g + wside * sin(uTime * 1.7 + seed * 14.0 + along * 0.31) * 0.12 * g;
      float contact = 0.0;
      vec2 push = vegPush(base.xz, base.y, 1.3 * S, im, iuv, 1.5, contact);
      vec2 comb = iMisc.zw;
      vec3 V = normalize(cameraPosition - base - vec3(0.0, 0.7 * S, 0.0));
      float t = position.y;
      if (kind < 0.5) {
        // ---- arching leaf ----
        float a1 = plH(seed, ei * 7.13 + 1.0), a2 = plH(seed, ei * 3.71 + 2.0), a3 = plH(seed, ei * 5.37 + 3.0);
        float yaw = iMisc.x + ei * 2.39996 + (a1 - 0.5) * 0.7;
        vec2 o = vec2(cos(yaw), sin(yaw));
        float L = S * mix(0.85, 1.4, a2) * (1.0 - 0.62 * cut);
        float chord = mix(0.3, 1.25, a3 * a3) + 0.25 * cut;
        vec2 bend = o * chord + comb * 0.25 + windB * 0.5 + push * 0.8;
        vec3 p, tn;
        plCurve(bend, L, 0.28, t, p, tn);
        vec2 bd = normalize(bend + 1e-4);
        vec3 sideV = normalize(vec3(-bd.y, 0.0, bd.x));
        float w = uLeafW * S * mix(0.8, 1.2, a1) * (1.0 - 0.86 * pow(t, 1.4));
        vec3 wp = base + p;
        vec3 Nf = normalize(cross(sideV, tn));
        float fv = dot(Nf, normalize(cameraPosition - wp));
        if (fv < 0.0) { Nf = -Nf; fv = -fv; }
        w *= 1.0 + (1.0 - fv) * 0.7;
        w = max(w, uPixelWorld * length(cameraPosition - wp) * 0.9);
        plPos = wp + sideV * position.x * w * 0.5;
        plNormal = normalize(mix(normalize(Nf + sideV * position.x * 0.35), normalize(vec3(o.x * 0.6, 0.8, o.y * 0.6)), 0.45));
        // autumn susuki leaves: dark base, olive-straw blade, pale bleached tips; some tufts russet
        float rus = plH(seed, 9.0);
        vec3 mid = mix(vec3(0.20, 0.18, 0.075), vec3(0.24, 0.13, 0.06), smoothstep(0.6, 0.95, rus));
        vec3 tip = mix(vec3(0.50, 0.42, 0.20), vec3(0.52, 0.34, 0.16), smoothstep(0.6, 0.95, rus));
        vec3 alb = mix(vec3(0.03, 0.028, 0.012), mid, smoothstep(0.0, 0.5, t));
        alb = mix(alb, tip, smoothstep(0.55, 1.0, t)) * (0.85 + 0.3 * a2);
        vPlCol = alb;
        vPl = vec4(t, mix(0.35, 1.0, smoothstep(0.0, 0.6, t)) * (1.0 - 0.35 * contact), 1.5, 0.0);
      } else {
        // ---- culm (kind 1) and the plume ribbons that ride on its top (kind 2) ----
        float c1 = plH(seed, ei * 11.3 + 5.0), c2 = plH(seed, ei * 4.9 + 6.0), c3 = plH(seed, ei * 8.1 + 7.0);
        float Hc = S * mix(1.45, 2.1, c1) * (1.0 - cut);
        float yawc = iMisc.x + ei * 2.1 + c2 * 1.4;
        vec2 lean = vec2(cos(yawc), sin(yawc)) * mix(0.05, 0.22, c3) + comb * 0.3;
        float nodT = sin(uTime * 2.2 + c1 * 6.0 + along * 0.4) * 0.06 * g;
        vec2 bendC = lean + windB * 0.9 + push + wdir * nodT;
        vec2 bd = normalize(bendC + 1e-4);
        if (kind < 1.5) {
          vec3 p, tn;
          plCurve(bendC, Hc, 0.2, t * 0.9, p, tn);
          vec3 sideV = normalize(cross(tn, V));
          float w = max(0.0065 * S * (1.0 - 0.4 * t), uPixelWorld * length(cameraPosition - base - p) * 0.8);
          plPos = base + p + sideV * position.x * w * 0.5;
          plNormal = normalize(V * 0.5 + vec3(0.0, 0.6, 0.0));
          vPlCol = mix(vec3(0.10, 0.075, 0.03), vec3(0.34, 0.26, 0.12), smoothstep(0.0, 0.4, t));
          vPl = vec4(t, mix(0.4, 1.0, smoothstep(0.0, 0.5, t)), 1.1, 1.0);
        } else {
          // ribbon row v follows the culm from 72% to its tip, then droops downwind (the panicle's weight)
          float v = t;
          vec3 p, tn;
          plCurve(bendC, Hc, 0.2, mix(0.66, 0.9, v), p, tn);
          vec3 nodDir = normalize(vec3(bd.x + wdir.x * 0.6, 0.0, bd.y + wdir.y * 0.6));
          float droop = (0.05 + 0.05 * g + 0.4 * nodT) * v * v * Hc;
          p += nodDir * droop - vec3(0.0, droop * 0.35, 0.0);
          vec3 side0 = normalize(cross(tn, vec3(bd.x, 0.0, bd.y) + vec3(0.0, 0.001, 0.0)));
          vec3 axis = aElem.z < 0.5 ? side0 : normalize(cross(tn, side0));
          float Wp = 0.2 * S * mix(0.85, 1.15, c2);
          plPos = base + p + axis * position.x * Wp * 0.5;
          plUv = vec2((position.x * 0.5 + 0.5) * 0.92, v);
          plNormal = normalize(V * 0.45 + vec3(0.0, 0.55, 0.0) + (axis * position.x) * 0.3);
          vPlCol = vec3(0.96, 0.86, 0.68) * mix(0.86, 1.04, c3);
          vPl = vec4(0.7 + 0.3 * v, 1.0, 1.9, 2.0);
        }
      }
    }
  }
`;

const PLUME_FRAG_PARS = /* glsl */`
varying vec3 vPlCol;
varying vec4 vPl;
uniform vec2 uTexSize;
`;

const PLUME_COLOR_FRAG = /* glsl */`
  {
    vec2 tx = dFdx(vMapUv * uTexSize), ty = dFdy(vMapUv * uTexSize);
    float lod = 0.5 * log2(max(max(dot(tx, tx), dot(ty, ty)), 1e-6));
    diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + max(lod, 0.0) * 0.35));
    // plume albedo (0.85, 0.75, 0.55) comes from the texture (sRGB #ede1c4); leaves / culms from the vertex colour
    diffuseColor.rgb *= vPlCol * vPl.y;
  }
`;

function plumeLightFrag(sunC, sunD) {
  return /* glsl */`
  {
    vec3 sunC = ${sunC}; vec3 sunLv = ${sunD};
    float sunBack = pow(saturate(dot(-geometryViewDir, sunLv)), 4.0);
    float glow = vPl.w > 1.5 ? 0.3 : 0.18;
    // light through silky hairs / dry leaves is warmer than the surface colour
    vec3 tcol = diffuseColor.rgb * vec3(1.05, 0.92, 0.72);
    reflectedLight.directDiffuse += sunC * tcol * (sunBack * vPl.z + glow) * vPl.x;
  }
`;
}

// ------------------------------------------------------------------------------------------------ placement
function scatter(app, { max, density }) {
  const W = app.world;
  const sm = THREE.MathUtils.smoothstep;
  const rng = mulberry32(WORLD.seed + 3031);
  const L = VEG_LAYOUT;
  const knoll = L?.knoll ?? { x: 0, z: 0 };
  const duel = L?.duelCircle ?? { x: 0, z: 0, r: 16 };
  const tree = L?.oldTree ?? { x: -20, z: -14 };
  const stele = L?.stele ?? { x: 4, z: 3 };
  const halfRoad = (L?.roadWidth ?? 3.2) * 0.5;
  const R = 270, step = 1.7;
  const out = [];
  const wind = G.uWind.value;
  function prob(x, z) {
    const gi = W.groundInfo ? W.groundInfo(x, z) : null;
    const dens = gi ? gi.grass : 0.8;
    if (dens < 0.3) return 0;
    const dk = Math.hypot(x - knoll.x, z - knoll.z);
    if (Math.hypot(x - duel.x, z - duel.z) < duel.r * 0.9) return 0;          // the fighting pad stays clear
    if (Math.hypot(x - tree.x, z - tree.z) < 3.2 || Math.hypot(x - stele.x, z - stele.z) < 2.5) return 0;
    if (W.isBlocked && W.isBlocked(x, z, 0.6)) return 0;
    const drift = noise.fbm2(x * 0.045 + 13.1, z * 0.045 - 7.7, 3);            // −1..1, 15–25 m drifts
    const driftK = sm(drift, -0.05, 0.45);
    let p = 0;
    if (W.pathAt) {                                                           // road verges
      const rd = W.pathAt(x, z).dist - halfRoad;
      p = Math.max(p, sm(rd, 0.5, 1.6) * (1 - sm(rd, 3.5, 8)) * 0.55 * (0.35 + 0.65 * driftK));
    }
    p = Math.max(p, sm(dk, 17, 24) * (1 - sm(dk, 34, 48)) * 0.28 * driftK);  // knoll flanks
    if (gi) p = Math.max(p, sm(gi.green, 0.28, 0.55) * (1 - sm(gi.green, 0.8, 0.98)) * 0.4 * driftK); // hollow rims
    p = Math.max(p, sm(noise.fbm2(x * 0.012 - 4.4, z * 0.012 + 2.2, 2), 0.28, 0.55) * 0.3 * driftK); // wide swales
    p *= 0.9 * density * (0.5 + 0.5 * sm(dens, 0.3, 0.7));
    return p;
  }
  function add(x, z, cluster) {
    const y = W.heightAt(x, z);
    const gi = W.groundInfo ? W.groundInfo(x, z) : null;
    const moist = gi ? gi.green : 0.3;
    const s = (0.82 + rng() * 0.36) * (0.92 + 0.2 * moist) * (cluster ? 0.9 : 1);
    // season-long prevailing wind has combed the tufts downwind a little
    const combA = 0.12 + rng() * 0.18;
    out.push(x, y - 0.04, z, s, rng() * Math.PI * 2, rng() * 1000, wind.x * combA, wind.y * combA);
  }
  for (let gz = -R; gz < R && out.length / 8 < max; gz += step) {
    for (let gx = -R; gx < R; gx += step) {
      const x = gx + rng() * step, z = gz + rng() * step;
      if (x * x + z * z > R * R) { rng(); continue; }
      const p = prob(x, z);
      if (p <= 0 || rng() >= p) continue;
      add(x, z, false);
      // clumping: satellites around the parent tuft
      const ns = rng() < 0.55 ? 1 + Math.floor(rng() * 3) : 0;
      for (let k = 0; k < ns; k++) {
        const a = rng() * Math.PI * 2, r = 0.7 + rng() * 1.1;
        const sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
        if (prob(sx, sz) > 0.05) add(sx, sz, true);
      }
      if (out.length / 8 >= max) break;
    }
  }
  return new Float32Array(out);
}

// ------------------------------------------------------------------------------------------------ system
export async function createPlumes(app, opts = {}) {
  const { scene, camera } = app;
  const max = Math.round((opts.max ?? 4600) * Math.min(1, opts.density ?? 1));
  const fade = opts.fade ?? [110, 140];
  const atlas = plumeAtlas();
  const data = scatter(app, { max, density: 1 });
  const count = data.length / 8;

  // bucket into 32 m cells for culling
  const cells = new Map();
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(data[i * 8] / CELL), cz = Math.floor(data[i * 8 + 2] / CELL);
    const key = cx * 4096 + cz;
    let c = cells.get(key);
    if (!c) { c = { cx, cz, ids: [], lo: Infinity, hi: -Infinity }; cells.set(key, c); }
    c.ids.push(i);
    c.lo = Math.min(c.lo, data[i * 8 + 1]); c.hi = Math.max(c.hi, data[i * 8 + 1]);
  }
  const cellList = [...cells.values()].map((c) => ({ ...c, ids: Int32Array.from(c.ids), box: new THREE.Box3(
    new THREE.Vector3(c.cx * CELL - 2, c.lo - 0.2, c.cz * CELL - 2), new THREE.Vector3((c.cx + 1) * CELL + 2, c.hi + 2.4, (c.cz + 1) * CELL + 2)) }));

  const uFade = { value: new THREE.Vector2(fade[0], fade[1]) };
  const uPixelWorld = { value: 0.001 };
  const uTexSize = { value: new THREE.Vector2(TEX_W, TEX_H) };
  const sun = sunTermsSetup();

  function makeLOD(name, geoOpts, leafW) {
    const geo = tuftGeometry(geoOpts);
    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const iMisc = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', iPos); geo.setAttribute('iMisc', iMisc);
    const mat = new THREE.MeshLambertMaterial({ map: atlas.texture, side: THREE.DoubleSide, alphaTest: 0.5 });
    mat.name = name;
    patchMaterial(mat);
    const uLeafW = { value: leafW };
    addShaderHook(mat, `${name}-${sun.key}-v1`, (sh) => {
      Object.assign(sh.uniforms, vegInteractUniforms(), sunGlobalsUniforms(sun), { uFade, uLeafW, uPixelWorld, uTexSize, tWindNoise: G.tWindNoise });
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', PLUME_VERT_PARS + '\nvoid main() {\n' + PLUME_VERT_BODY)
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = plUv;')
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = plNormal;')
        .replace('#include <begin_vertex>', 'vec3 transformed = plPos;');
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', PLUME_FRAG_PARS + sunGlobalsPars(sun) + '\nvoid main() {')
        .replace('#include <alphatest_fragment>', PLUME_COLOR_FRAG + '\n#include <alphatest_fragment>')
        .replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL_BEGIN)
        .replace('#include <lights_fragment_begin>', sun.lightsChunk + '\n' + plumeLightFrag(sun.sunC, sun.sunD));
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = -5;
    mesh.layers.set(LAYERS.MAIN_ONLY);
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    return { geo, mat, mesh, iPos, iMisc, n: 0 };
  }
  const near = makeLOD('plumes-near', { leaves: 12, leafSegs: 5, culms: 3, culmSegs: 6, cards: 2, cardRows: 5 }, 0.022);
  const far = makeLOD('plumes-far', { leaves: 6, leafSegs: 3, culms: 3, culmSegs: 3, cards: 1, cardRows: 3 }, 0.036);

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  let densityK = 1;
  function emit(lod, i) {
    const k = lod.n++ * 4, s = i * 8;
    const a = lod.iPos.array, b = lod.iMisc.array;
    a[k] = data[s]; a[k + 1] = data[s + 1]; a[k + 2] = data[s + 2]; a[k + 3] = data[s + 3];
    b[k] = data[s + 4]; b[k + 1] = data[s + 5]; b[k + 2] = data[s + 6]; b[k + 3] = data[s + 7];
  }
  function commit(lod) {
    lod.geo.instanceCount = lod.n;
    lod.mesh.visible = lod.n > 0;
    for (const at of [lod.iPos, lod.iMisc]) { at.clearUpdateRanges(); at.addUpdateRange(0, Math.max(4, lod.n * 4)); at.needsUpdate = true; }
  }

  const plumes = {
    near, far, atlas, count, cells: cellList.length,
    setDensity(k) { densityK = Math.max(0, Math.min(1, k)); },
    /** Nearest tuft to (x, z) → THREE.Vector3 or null (debug views, level design). */
    nearest(x, z, out = new THREE.Vector3()) {
      let best = Infinity, bi = -1;
      for (let i = 0; i < count; i++) {
        const d = (data[i * 8] - x) ** 2 + (data[i * 8 + 2] - z) ** 2;
        if (d < best) { best = d; bi = i; }
      }
      return bi < 0 ? null : out.set(data[bi * 8], data[bi * 8 + 1], data[bi * 8 + 2]);
    },
    stats() { return { tufts: count, near: near.n, far: far.n }; },
    update() {
      const H = app.pipeline?.H || app.renderer.domElement.height || 900;
      uPixelWorld.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)) / H;
    },
    lateUpdate() {
      camera.updateMatrixWorld();
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      const cx = camera.position.x, cz = camera.position.z, rOut = fade[1] + 2;
      near.n = 0; far.n = 0;
      for (const c of cellList) {
        const dx = Math.max(c.cx * CELL - cx, 0, cx - (c.cx + 1) * CELL), dz = Math.max(c.cz * CELL - cz, 0, cz - (c.cz + 1) * CELL);
        if (dx * dx + dz * dz > rOut * rOut) continue;
        if (!frustum.intersectsBox(c.box)) continue;
        const ids = c.ids;
        for (let q = 0; q < ids.length; q++) {
          const i = ids[q], s = i * 8;
          const h = (data[s + 5] * 0.618) % 1;
          if (h > densityK) continue;
          const ddx = data[s] - cx, ddz = data[s + 2] - cz, d2 = ddx * ddx + ddz * ddz;
          if (d2 > rOut * rOut) continue;
          const lim = 42 + 8 * h;
          emit(d2 < lim * lim ? near : far, i);
        }
      }
      commit(near); commit(far);
    },
    dispose() {
      for (const l of [near, far]) { scene.remove(l.mesh); l.geo.dispose(); l.mat.dispose(); }
      app.remove(plumes);
    },
  };
  app.add(plumes);
  return plumes;
}
