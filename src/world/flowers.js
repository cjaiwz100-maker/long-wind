// Wildflowers (bible §5.7): red spider lilies (彼岸花 higanbana) at meadow cores and by the graves / stele, white
// daisies and yellow wild chrysanthemum (野菊) at the fringes. Owner: vegetation (V). STABLE API:
//   const flowers = createFlowers(app, opts?) → { mesh, atlas, update(), setDensity(k), stats() }
//     opts: { density = 1, radius = 55 }        registered with app.add automatically
//   flowerAtlas() → { canvas, texture }         1024×512 canvas atlas, 4 cells of 256×512 (bottom = ground):
//                                               0 higanbana, 1 white daisy, 2 yellow chrysanthemum, 3 higanbana pair
// GPU-procedural like the grass: ONE draw call, camera-following 10 m tiles (foliage.js TileRing), every flower built
// in the vertex shader from (tile, gl_InstanceID). Placement is the meadow field vegFlowerPatch() that the grass also
// reads (the sward is shorter and thinner there), species from the same noise (lilies at the cores). Crossed cards
// with a length-preserving arc bend (wind + actor push + trample + shock + slash), cut flowers vanish, shrink-fade
// 35–55 m, alpha-tested with mip-aware alpha, backlit petal translucency. Layer MAIN_ONLY, never casts.
import * as THREE from 'three';
import { G, LAYERS, WORLD } from '../core/globals.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { GLSL_NOISE, mulberry32 } from '../core/noise.js';
import { WIND_GLSL } from '../core/wind.js';
import {
  sunTermsSetup, sunGlobalsPars, sunGlobalsUniforms, FOLIAGE_NORMAL_BEGIN, vegGround, VEG_GROUND_GLSL,
  VEG_INTERACT_PARS, VEG_PUSH_GLSL, vegInteractUniforms, FLOWER_PATCH_GLSL, flowerSpots, TileRing, cameraFrustum,
  makeCanvas, dilateAlpha, canvasTexture,
} from './foliage.js';

const ATLAS_W = 1024, ATLAS_H = 512, CELL_W = 256;

// ------------------------------------------------------------------------------------------------ canvas painting
/** Filled polygon along a polyline with a linearly tapering width (canvas strokes cannot taper). */
function taper(ctx, pts, w0, w1, fill) {
  const n = pts.length;
  if (n < 2) return;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const w = (w0 + (w1 - w0) * (i / (n - 1))) * 0.5;
    L.push([pts[i][0] - ty * w, pts[i][1] + tx * w]);
    R.push([pts[i][0] + ty * w, pts[i][1] - tx * w]);
  }
  ctx.beginPath();
  ctx.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(L[i][0], L[i][1]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
/** Quadratic Bézier sampled into n points. */
function quad(p0, p1, p2, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}
/** Cubic Bézier sampled into n points. */
function cubic(p0, p1, p2, p3, n = 14) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}
const rgb = (r, g, b, k = 1) => `rgb(${Math.round(Math.min(255, r * k))},${Math.round(Math.min(255, g * k))},${Math.round(Math.min(255, b * k))})`;

/** A leafless flower stalk from the ground to the head, with a lit and a shaded edge. */
function stalk(ctx, x0, y0, x1, y1, bow, w0, w1, col = [84, 108, 38]) {
  const mid = [(x0 + x1) / 2 + bow, (y0 + y1) / 2];
  const pts = quad([x0, y0], mid, [x1, y1], 16);
  taper(ctx, pts, w0, w1, rgb(...col, 0.72));
  taper(ctx, pts.map(([x, y]) => [x - w0 * 0.12, y]), w0 * 0.55, w1 * 0.5, rgb(...col, 1.12));
}

/**
 * Red spider lily umbel seen from the side: 5–7 florets on short pedicels, each with 6 narrow, strongly recurved
 * petals and 6 very long up-curving stamens with dark anthers. (hx, hy) = head centre, s = scale (px).
 */
function higanbanaHead(ctx, hx, hy, s, rng) {
  const n = 5 + Math.floor(rng() * 3);
  const florets = [];
  for (let j = 0; j < n; j++) {
    const phi = (j / n) * Math.PI * 2 + rng() * 0.6, th = 0.05 + rng() * 0.55;
    florets.push({ dx: Math.cos(th) * Math.cos(phi), dy: -Math.sin(th), dz: Math.cos(th) * Math.sin(phi) });
  }
  florets.sort((a, b) => a.dz - b.dz);                     // back florets first (they are darker)
  for (const f of florets) {
    const shade = 0.72 + 0.28 * (f.dz * 0.5 + 0.5);
    const px = hx + f.dx * 12 * s, py = hy + f.dy * 10 * s - 2 * s;
    // pedicel
    taper(ctx, quad([hx, hy], [hx + f.dx * 6 * s, hy - 4 * s], [px, py], 6), 2.2 * s, 1.6 * s, rgb(96, 104, 36, shade));
    const ax = Math.atan2(f.dy - 0.35, f.dx);             // floret axis in the picture (tilted up)
    // stamens behind the petals: long arcs sweeping up and out, tipped with anthers
    for (let k = 0; k < 6; k++) {
      const a = ax + (k - 2.5) * 0.2 + (rng() - 0.5) * 0.15;
      const L = (40 + rng() * 22) * s;
      const e = [px + Math.cos(a) * L * 0.75, py + Math.sin(a) * L * 0.55 - L * 0.42];
      const c = [px + Math.cos(a) * L * 0.55, py + Math.sin(a) * L * 0.2 - L * 0.12];
      taper(ctx, quad([px, py], c, e, 10), 1.5 * s, 0.7 * s, rgb(212, 44, 34, shade));
      ctx.fillStyle = rgb(92, 26, 18, shade);
      ctx.beginPath(); ctx.ellipse(e[0], e[1], 2.2 * s, 1.3 * s, a, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgb(226, 170, 70, shade);
      ctx.beginPath(); ctx.arc(e[0] + 0.6 * s, e[1] - 0.5 * s, 0.7 * s, 0, Math.PI * 2); ctx.fill();
    }
    // petals: out along the axis, then curling back over themselves
    for (let k = 0; k < 6; k++) {
      const a = ax + (k - 2.5) * 0.42 + (rng() - 0.5) * 0.2;
      const L = (17 + rng() * 7) * s;
      const ca = Math.cos(a), sa = Math.sin(a);
      const p1 = [px + ca * L * 0.9, py + sa * L * 0.9 - 2 * s];
      const p2 = [px + ca * L * 1.25 - ca * 3 * s, py + sa * L * 1.1 + 6 * s];   // recurved tip droops back
      const p3 = [px + ca * L * 0.95 - ca * 6 * s, py + sa * L * 0.8 + 8 * s];
      const pts = cubic([px, py], p1, p2, p3, 12);
      const lit = 0.8 + 0.4 * rng();
      taper(ctx, pts, 4.4 * s, 1.4 * s, rgb(176, 22, 20, shade * lit));
      // brighter crinkled mid-line
      taper(ctx, pts.slice(1, 9), 1.6 * s, 0.6 * s, rgb(226, 58, 42, shade * lit));
    }
  }
  // umbel centre
  ctx.fillStyle = rgb(120, 20, 16);
  ctx.beginPath(); ctx.arc(hx, hy - s, 3.2 * s, 0, Math.PI * 2); ctx.fill();
}

function paintHiganbana(ctx, x0, rng, pair) {
  const stems = pair ? [[0.36, 0.64, 0.95], [0.66, 0.44, 0.82]] : [[0.5, 0.74, 1.0]];
  for (const [fx, fh, sc] of stems) {
    const bx = x0 + CELL_W * (0.5 + (fx - 0.5) * 0.4), hx = x0 + CELL_W * fx + (rng() - 0.5) * 16;
    const hy = ATLAS_H * (1 - fh);
    stalk(ctx, bx, ATLAS_H + 2, hx, hy + 6, (rng() - 0.5) * 18, 6.5, 4.2, [78, 112, 40]);
    higanbanaHead(ctx, hx, hy, 1.5 * sc, rng);
  }
}

/** One daisy-like head seen at a tilt (squash), ray petals around a disc. */
function composite(ctx, cx, cy, R, squash, rot, petalCol, baseCol, discCol, ringCol, nPetals, rng, petalW = 0.3) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(1, squash);
  for (let i = 0; i < nPetals; i++) {
    const a = (i / nPetals) * Math.PI * 2 + rng() * 0.2;
    const L = R * (0.82 + rng() * 0.3);
    ctx.save();
    ctx.rotate(a);
    const g = ctx.createLinearGradient(0, 0, L, 0);
    g.addColorStop(0, baseCol); g.addColorStop(0.45, petalCol); g.addColorStop(1, petalCol);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(L * 0.55, 0, L * 0.5, R * petalW * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = ringCol;
  ctx.beginPath(); ctx.arc(0, 0, R * 0.34, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = discCol;
  ctx.beginPath(); ctx.arc(-R * 0.04, -R * 0.05, R * 0.27, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function leafBlade(ctx, x, y, a, L, W, col) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const tip = [x + ca * L, y + sa * L], mid = [x + ca * L * 0.5 - sa * L * 0.12, y + sa * L * 0.5 + ca * L * 0.12];
  taper(ctx, quad([x, y], mid, tip, 8), W, 0.6, col);
}

function paintDaisies(ctx, x0, rng) {
  const heads = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < heads; i++) {
    const fx = 0.22 + 0.56 * (i + rng() * 0.8) / heads, fh = 0.55 + rng() * 0.36;
    const hx = x0 + CELL_W * fx, hy = ATLAS_H * (1 - fh);
    const bx = x0 + CELL_W * (0.5 + (fx - 0.5) * 0.3);
    stalk(ctx, bx, ATLAS_H + 2, hx, hy + 4, (rng() - 0.5) * 30, 3.6, 2.6, [70, 96, 36]);
    for (let l = 0; l < 2; l++) {
      const ly = ATLAS_H - (ATLAS_H - hy) * (0.15 + rng() * 0.45), lx = bx + (hx - bx) * ((ATLAS_H - ly) / (ATLAS_H - hy));
      leafBlade(ctx, lx, ly, -Math.PI / 2 + (rng() < 0.5 ? -1 : 1) * (0.6 + rng() * 0.5), 26 + rng() * 18, 6, rgb(62, 86, 32, 0.8 + rng() * 0.3));
    }
    const R = 26 + rng() * 10;
    composite(ctx, hx, hy, R, 0.38 + rng() * 0.55, (rng() - 0.5) * 0.5, rgb(245, 243, 234), rgb(206, 202, 186), rgb(232, 196, 78), rgb(186, 138, 40), 15 + Math.floor(rng() * 5), rng, 0.34);
  }
}

function paintChrysanthemum(ctx, x0, rng) {
  // a loose dome of small golden heads on branching wiry stems, small lobed leaves low down
  const base = [x0 + CELL_W * 0.5, ATLAS_H + 2];
  const heads = [];
  const n = 18 + Math.floor(rng() * 7);
  for (let i = 0; i < n; i++) {
    const u = (rng() - 0.5) * 2;
    const fh = 0.5 + 0.36 * Math.sqrt(1 - u * u) * (0.72 + rng() * 0.28);
    heads.push([x0 + CELL_W * (0.5 + u * 0.38), ATLAS_H * (1 - fh), 10 + rng() * 6]);
  }
  for (const [hx, hy] of heads) {
    const fork = [base[0] + (hx - base[0]) * 0.35, ATLAS_H - (ATLAS_H - hy) * 0.45];
    stalk(ctx, base[0] + (rng() - 0.5) * 20, base[1], fork[0], fork[1], (rng() - 0.5) * 10, 3.2, 2.4, [66, 88, 34]);
    stalk(ctx, fork[0], fork[1], hx, hy + 2, (rng() - 0.5) * 12, 2.4, 1.5, [72, 96, 36]);
  }
  for (let i = 0; i < 26; i++) {
    const lx = base[0] + (rng() - 0.5) * 110, ly = ATLAS_H - 20 - rng() * 220;
    ctx.fillStyle = rgb(52, 74, 28, 0.75 + rng() * 0.4);
    for (let k = 0; k < 3; k++) {
      ctx.beginPath(); ctx.ellipse(lx + (k - 1) * 5, ly + Math.abs(k - 1) * 3, 6, 3.2, (k - 1) * 0.7, 0, Math.PI * 2); ctx.fill();
    }
  }
  heads.sort((a, b) => b[1] - a[1]);
  for (const [hx, hy, R] of heads) {
    if (rng() < 0.2) {                                     // tight bud
      ctx.fillStyle = rgb(200, 150, 40); ctx.beginPath(); ctx.arc(hx, hy, R * 0.45, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    composite(ctx, hx, hy, R, 0.45 + rng() * 0.5, (rng() - 0.5) * 0.6, rgb(244, 204, 58), rgb(214, 150, 34), rgb(206, 142, 30), rgb(160, 96, 20), 13 + Math.floor(rng() * 4), rng, 0.42);
  }
}

let _atlas = null;
/** The flower atlas (built once). */
export function flowerAtlas() {
  if (_atlas) return _atlas;
  const canvas = makeCanvas(ATLAS_W, ATLAS_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
  const rng = mulberry32(WORLD.seed + 4711);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, CELL_W, ATLAS_H); ctx.clip(); paintHiganbana(ctx, 0, rng, false); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(CELL_W, 0, CELL_W, ATLAS_H); ctx.clip(); paintDaisies(ctx, CELL_W, rng); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(CELL_W * 2, 0, CELL_W, ATLAS_H); ctx.clip(); paintChrysanthemum(ctx, CELL_W * 2, rng); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(CELL_W * 3, 0, CELL_W, ATLAS_H); ctx.clip(); paintHiganbana(ctx, CELL_W * 3, rng, true); ctx.restore();
  dilateAlpha(ctx, ATLAS_W, ATLAS_H, 8);
  const texture = canvasTexture(canvas, { aniso: 8 });
  texture.name = 'flowerAtlas';
  _atlas = { canvas, texture };
  return _atlas;
}

// ------------------------------------------------------------------------------------------------ geometry
/** Two crossed cards, 4 rows each (x ∈ ±0.5, y ∈ 0..1, z = card index). */
function flowerGeometry() {
  const rows = [0, 0.38, 0.72, 1];
  const pos = [], idx = [];
  for (let q = 0; q < 2; q++) {
    const b = pos.length / 3;
    for (const y of rows) pos.push(-0.5, y, q, 0.5, y, q);
    for (let r = 0; r < rows.length - 1; r++) {
      const a = b + r * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ------------------------------------------------------------------------------------------------ shaders
const FLOWER_VERT_PARS = /* glsl */`
${GLSL_NOISE}
${WIND_GLSL}
${VEG_GROUND_GLSL}
${VEG_INTERACT_PARS}
${VEG_PUSH_GLSL}
${FLOWER_PATCH_GLSL}
uniform vec4 uTiles[64];
uniform float uK, uDensityMul;
uniform vec4 uRing;
varying vec4 vFl;        // x height along the card 0..1, y AO, z species (0 lily, 1 daisy, 2 chrysanthemum), w tint
`;

// Builds the flower in world space: flPos, flNormal, flUv.
const FLOWER_VERT_BODY = /* glsl */`
  vec3 flPos = vec3(0.0); vec3 flNormal = vec3(0.0, 1.0, 0.0); vec2 flUv = vec2(0.0);
  {
    int per = int(uK * uK + 0.5);
    int ti = gl_InstanceID / per;
    int bi = gl_InstanceID - ti * per;
    vec4 tile = uTiles[ti];
    int kk = int(uK + 0.5);
    vec2 cell = vec2(float(bi % kk), float(bi / kk));
    vec2 tc = floor(tile.xy / tile.z + 0.5);
    vec2 root = tile.xy + (cell + wx_hash22(tc * 91.3 + cell * 1.91 + 4.4)) * (tile.z / uK);
    float h1 = wx_hash12(root * 61.7 + 0.3), h2 = wx_hash12(root * 17.9 - 4.1), h3 = wx_hash12(root * 33.1 + 8.8);
    float h4 = wx_hash12(root * 7.7 + 2.2);
    float core;
    float fpatch = vegFlowerPatch(root, core);
    vec4 gi = gxGround(root);
    float dist = length(root - cameraPosition.xz);
    // species: lilies where the core weight wins the per-flower lottery; fringes split daisy / chrysanthemum
    bool lily = h2 < core * 0.92;
    float fringe = wx_vnoise(root * 0.23 + 3.0);
    float kind = lily ? (h3 < 0.3 ? 3.0 : 0.0) : (fringe > 0.48 ? 1.0 : 2.0);
    float dens = fpatch * (lily ? 0.9 : kind == 1.0 ? 0.16 : 0.26) * smoothstep(0.25, 0.55, gi.r);
    float keep = step(h1, dens * uDensityMul) * (1.0 - smoothstep(uRing.z, uRing.w, dist + h4 * 6.0));
    float S = kind == 0.0 || kind == 3.0 ? mix(0.46, 0.64, h3) : kind == 1.0 ? mix(0.36, 0.5, h3) : mix(0.32, 0.46, h3);
    S *= keep;
    vec2 iuv; vec4 im = vec4(0.0);
    if (S > 0.0) im = vegInteractAt(root, iuv);
    S *= step(im.g, 0.35);                                   // cut: the blade took the heads
    if (uCamGround.z > 0.0) S *= smoothstep(uCamGround.z * 0.6, uCamGround.z * 1.3, length(root - uCamGround.xy));
    if (S > 0.01) {
      vec3 base = vec3(root.x, gxHeight(root) - 0.02, root.y);
      float yaw = h4 * 3.14159 + position.z * 1.5708;
      vec3 ax = vec3(cos(yaw), 0.0, sin(yaw));
      // bend (radians): wind sway + everything that pushes plants; exact circular-arc bend preserves the length
      vec3 sw = windSway(base, 0.25, root.x * 3.0 + h2 * 6.0);
      float contact = 0.0;
      vec2 bend = sw.xz * 1.7 / S + vegPush(root, base.y, S, im, iuv, 1.0, contact);
      bend += vec2(0.21, -0.13) * (h2 - 0.5);               // natural stance
      float a = min(length(bend), 1.35);
      vec2 bd = bend / max(length(bend), 1e-4);
      float yn = position.y;
      float ang = a * yn;
      float along = a > 1e-3 ? (1.0 - cos(ang)) / a : 0.5 * a * yn * yn;
      float up = a > 1e-3 ? sin(ang) / a : yn;
      vec3 p = base + vec3(bd.x, 0.0, bd.y) * along * S + vec3(0.0, up * S, 0.0) + ax * position.x * S * 0.5;
      flPos = p;
      // soft lighting normal: card normal turned toward the viewer, blended toward the sky
      vec3 cn = vec3(-ax.z, 0.0, ax.x);
      if (dot(cn, cameraPosition - p) < 0.0) cn = -cn;
      flNormal = normalize(cn * 0.62 + vec3(bd.x * sin(a), 0.75, bd.y * sin(a)));
      float u = position.x + 0.5;
      if (h3 > 0.5) u = 1.0 - u;                              // mirrored variants
      flUv = vec2((kind + u) * 0.25, yn);
      vFl = vec4(yn, mix(0.32, 1.0, smoothstep(0.0, 0.62, yn)) * (1.0 - 0.3 * contact), kind == 3.0 ? 0.0 : kind, 0.88 + 0.24 * h1);
    } else {
      flPos = vec3(root.x, -1e4, root.y);                      // culled: collapse off-screen
      vFl = vec4(0.0);
    }
  }
`;

const FLOWER_FRAG_PARS = /* glsl */`
varying vec4 vFl;
uniform vec2 uAtlasSize;
`;

// after map_fragment: mip-aware alpha (thin stems keep their coverage in the distance), tint, gain, AO
const FLOWER_COLOR_FRAG = /* glsl */`
  {
    vec2 tx = dFdx(vMapUv * uAtlasSize), ty = dFdy(vMapUv * uAtlasSize);
    float lod = 0.5 * log2(max(max(dot(tx, tx), dot(ty, ty)), 1e-6));
    diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + max(lod, 0.0) * 0.3));
    diffuseColor.rgb *= (vFl.z > 0.5 && vFl.z < 1.5 ? 0.92 : 1.1) * vFl.w * vFl.y;
  }
`;

function flowerLightFrag(sunC, sunD) {
  return /* glsl */`
  {
    vec3 sunC = ${sunC}; vec3 sunLv = ${sunD};
    float sunBack = pow(saturate(dot(-geometryViewDir, sunLv)), 4.0);
    // petals transmit (lilies most: thin red tissue glows like stained glass); stems and leaves far less
    float petal = smoothstep(0.45, 0.7, vFl.x);
    float gain = vFl.z < 0.5 ? 1.8 : vFl.z < 1.5 ? 0.55 : 0.9;
    // transmission keeps (and deepens) the petal hue: red tissue glows crimson, not sunset-orange
    vec3 alb = diffuseColor.rgb;
    vec3 chroma = alb / max(max(alb.r, max(alb.g, alb.b)), 1e-3);
    vec3 tcol = alb * mix(vec3(1.0), chroma * chroma, 0.8);
    reflectedLight.directDiffuse += sunC * tcol * (sunBack * gain + 0.12) * mix(0.25, 1.0, petal);
  }
`;
}

// ------------------------------------------------------------------------------------------------ system
export function createFlowers(app, opts = {}) {
  const { scene, camera } = app;
  const ground = vegGround(app);
  const atlas = flowerAtlas();
  const radius = opts.radius ?? 55;
  const tiles = new TileRing(app, { tile: 10, k: 16, ring: [-2, -1, radius - 20, radius], cap: 64, max: 64, pad: 0.8 });
  const uDensityMul = { value: opts.density ?? 1 };
  const uAtlasSize = { value: new THREE.Vector2(ATLAS_W, ATLAS_H) };

  const mat = new THREE.MeshLambertMaterial({ map: atlas.texture, side: THREE.DoubleSide, alphaTest: 0.5 });
  mat.name = 'flowers';
  patchMaterial(mat);
  const sun = sunTermsSetup();
  addShaderHook(mat, `flowers-${sun.key}-v1`, (sh) => {
    Object.assign(sh.uniforms, tiles.uniforms, ground.uniforms, vegInteractUniforms(), sunGlobalsUniforms(sun), {
      uDensityMul, uAtlasSize, uFlowerSpots: flowerSpots, tWindNoise: G.tWindNoise,
    });
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', FLOWER_VERT_PARS + '\nvoid main() {\n' + FLOWER_VERT_BODY)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = flUv;')
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = flNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = flPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', FLOWER_FRAG_PARS + sunGlobalsPars(sun) + '\nvoid main() {')
      .replace('#include <alphatest_fragment>', FLOWER_COLOR_FRAG + '\n#include <alphatest_fragment>')
      .replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL_BEGIN)
      .replace('#include <lights_fragment_begin>', sun.lightsChunk + '\n' + flowerLightFrag(sun.sunC, sun.sunD));
  });

  const geo = flowerGeometry();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'flowers';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = -5;
  mesh.layers.set(LAYERS.MAIN_ONLY);
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  const flowers = {
    mesh, atlas, tiles,
    setDensity(k) { uDensityMul.value = Math.max(0, k); },
    stats() { return { tiles: tiles.count, slots: geo.instanceCount }; },
    lateUpdate() {
      cameraFrustum(camera, frustum, pv);
      const n = tiles.select(camera.position, frustum);
      geo.instanceCount = n * tiles.perTile;
      mesh.visible = n > 0 && uDensityMul.value > 0;
    },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); app.remove(flowers); },
  };
  app.add(flowers);
  return flowers;
}
