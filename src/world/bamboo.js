// Bamboo grove 竹林 (moso / phyllostachys) for the "竹林夜雨" level. Owner: vegetation (V). STABLE API:
//   const bamboo = await createBamboo(app, opts?) → { root, colliders, update(dt), stats(), setVisible(v), dispose() }
//   opts { center:{x,z}={0,0}, clearR=16, inner=18, outer=200, keepOut:[{x,z,r}], path:(x,z)=>dist|null, pathClear=2.5,
//          density=1, height:[9,15], seed=1 }
//   The clearing (radius clearR, ~4 m soft edge) stays open; culms grow in the annulus inner..outer (the soft edge may
//   start growing from clearR). One collider {x,z,r} per clump (nearest ≤600 clumps within 140 m of the centre) is
//   pushed to app.world.colliders and app.world.addBlocker(). The module registers itself with app.add() (culling runs
//   in lateUpdate, after the game camera moved); update(dt) is a harmless no-op kept for symmetry.
//
// Structure (all GPU-instanced, ~7 draw calls in the main pass whatever the camera sees):
//   culm  L0  (< 40 m)   8 radial × 20 rings, shader-built taper / lean / curve / wind, procedural nodes + powder bands
//   crown L0  (< 40 m)   18 leaf sprays × 2 crossed alpha-tested cards following the culm (flutter, backlit translucency)
//   culm  L1  (40–120 m) 5 × 8;   crown L1: 8 big dense sprays
//   clump impostor (> 120 m)  one crossed billboard per clump (painted culms + canopy)
//   shoots/stumps near the clearing edge: one small static merged mesh
// Every culm/crown instance is 12 floats (pos+yaw | height, radius, lean xz | phase, age, node spacing, crown scale).
// CPU culling: the grove is binned into 24 m chunks; when the camera moves/turns, visible chunks are sorted
// front-to-back and copied into two dynamic instance buffers (near / mid, per-instance LOD on straddling chunks) and a
// per-clump impostor buffer. Culms + crowns of a LOD share one buffer, so a re-cull uploads each instance once.
// Shadows: the dynamic meshes do not cast. Two static "shadow proxy" meshes (cheap culm + L1 crown for every culm
// within 170 m of the centre) cast into the far (static-world, layer WORLD) sun map; they skip every main-pass draw
// by zeroing their instance count in onBeforeRender, while WebGLShadowMap only calls onBeforeShadow — so the far map
// always sees the whole grove even though the main pass is frustum culled. The far map is refreshed automatically when
// a new top-level WORLD object is added to the scene (shadows.js) — env.refreshShadows() is only needed if you toggle
// setVisible() or move things afterwards.
import * as THREE from 'three';
import { G, LAYERS } from '../core/globals.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { U } from '../core/glsl.js';
import { mulberry32, noise } from '../core/noise.js';
import { GLSL_NOISE } from '../core/noise.js';
import { WIND_GLSL } from '../core/wind.js';
import { sunTermsSetup, sunGlobalsPars, sunGlobalsUniforms, FOLIAGE_NORMAL_BEGIN, makeCanvas, dilateAlpha, canvasTexture } from './foliage.js';

const STRIDE = 12;        // culm instance floats
const ISTRIDE = 8;        // impostor instance floats
const CHUNK = 24;         // m
let LOD0 = 32, LOD1 = 95;
const HYST = 3;
let MID_KEEP = 0.7;      // fraction of each chunk's culms drawn at the mid LOD (the canopy saturates anyway)
const T0 = 0.45;          // crown geometry authored for branches from 45 % height (remapped per instance)

// shared uniforms (module level so every material references the same objects)
const U_WIND = { value: 1 };      // wind response multiplier
const U_FOCUS = { value: new THREE.Vector4(0, -1e4, 0, 0) };   // xyz = player (chest), w = 1 when camera-occlusion fading is on

// camera-occlusion fade (main pass only): per instance, 1 = fully dithered away. Culms within ~2.5 m of the camera and
// culms within ~1.2 m of the camera→focus segment (xz, only in front of the focus) fade out.
const FADE_VERT = /* glsl */`
${U('vec3', 'uCamPos')}uniform vec4 uBBFocus;
varying float vBBFade;
float bbOcclusion(vec3 base) {
  vec2 c = uCamPos.xz, q = base.xz - c;
  float f = 1.0 - smoothstep(1.7, 2.6, length(q));
  if (uBBFocus.w > 0.5) {
    vec2 sg = uBBFocus.xz - c;
    float L2 = max(dot(sg, sg), 1e-4);
    float h = dot(q, sg) / L2;
    float ds = length(q - sg * clamp(h, 0.0, 1.0));
    f = max(f, (1.0 - smoothstep(0.8, 1.3, ds)) * step(0.0, h) * (1.0 - smoothstep(0.93, 1.0, h)));
  }
  return f;
}
`;
const FADE_FRAG = /* glsl */`
  if (vBBFade > 0.004) {
    vec2 bq = floor(gl_FragCoord.xy);
    vec2 bh = floor(bq * 0.5);
    float bayer = fract(bh.x * 0.5 + bh.y * bh.y * 0.75) * 0.25 + fract(bq.x * 0.5 + bq.y * bq.y * 0.75) + 0.03125;
    if (vBBFade >= bayer) discard;
  }
`;

// ------------------------------------------------------------------------------------------------ atlases
const rgb = (r, g, b, a = 1) => `rgba(${Math.round(Math.max(0, Math.min(255, r)))},${Math.round(Math.max(0, Math.min(255, g)))},${Math.round(Math.max(0, Math.min(255, b)))},${a})`;

/** Lanceolate bamboo leaf at the origin pointing +y (canvas units), long acuminate tip, short petiole. */
function drawLeaf(ctx, L, W, col, rng) {
  const [r, g, b] = col;
  const bend = (rng() - 0.5) * W * 1.6;   // leaves curve a little sideways
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const N = 10, pts = [];
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    // widest at ~30 %, long tapering tip
    const w = W * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.25) ** 0.75), 1.1) * (1 - 0.35 * t) * (t > 0.95 ? 0.3 : 1);
    pts.push([w * 0.5, t * L, bend * t * t]);
  }
  for (const [w, y, o] of pts) ctx.lineTo(o + w, y);
  for (let i = pts.length - 1; i >= 0; i--) { const [w, y, o] = pts[i]; ctx.lineTo(o - w, y); }
  ctx.closePath();
  const gr = ctx.createLinearGradient(-W, 0, W, L);
  gr.addColorStop(0, rgb(r * 0.8, g * 0.82, b * 0.8));
  gr.addColorStop(0.5, rgb(r, g, b));
  gr.addColorStop(1, rgb(r * 1.12, g * 1.1, b * 0.95));
  ctx.fillStyle = gr;
  ctx.fill();
  // midrib (lighter) + a darker half
  ctx.strokeStyle = rgb(r * 1.25, g * 1.2, b * 1.05, 0.55);
  ctx.lineWidth = Math.max(0.7, W * 0.09);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(bend * 0.25, L * 0.5, bend * 0.9, L * 0.93); ctx.stroke();
  ctx.fillStyle = rgb(r * 0.55, g * 0.6, b * 0.55, 0.22);
  ctx.beginPath(); ctx.moveTo(0, 0);
  for (const [w, y, o] of pts) ctx.lineTo(o + w, y);
  for (let i = pts.length - 1; i >= 0; i--) { const [, y, o] = pts[i]; ctx.lineTo(o, y); }
  ctx.closePath(); ctx.fill();
  // some leaves have dry / yellowed tips
  if (rng() < 0.22) {
    ctx.save(); ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = rgb(150, 130, 60, 0.55);
    ctx.fillRect(-W * 2, L * (0.7 + rng() * 0.2), W * 4, L);
    ctx.restore();
  }
}

const LEAF_PAL = [[58, 88, 30], [72, 104, 36], [86, 118, 40], [100, 128, 46], [66, 96, 40], [118, 136, 52], [80, 100, 34]];

/**
 * One spray: a slender twig from the bottom centre (the branch at the culm) with short alternate branchlets, each
 * ending in a palmate fan of 3–6 lanceolate leaves splayed forward and sideways (the card is near-horizontal in 3D, so
 * "forward" reads as the leaves hanging out from the branch). Clipped to its cell.
 */
function sprayCell(ctx, ox, oy, S, rng, { dense = false } = {}) {
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, oy, S, S); ctx.clip();
  ctx.translate(ox + S / 2, oy + S);
  ctx.scale(1, -1); // +y up the card (away from the culm)
  const leaves = [];
  const stroke = (pts, w0, w1, col) => {
    ctx.strokeStyle = col; ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      ctx.lineWidth = w0 + (w1 - w0) * (i / pts.length);
      ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke();
    }
  };
  const fan = (x, y, a, n, spread, lk) => {
    for (let i = 0; i < n; i++) {
      const u = n > 1 ? i / (n - 1) - 0.5 : 0;
      const la = a + u * spread + (rng() - 0.5) * 0.25;
      const L = S * (0.15 + rng() * 0.08) * lk;
      leaves.push({ x, y, a: la, L, W: L * (0.13 + rng() * 0.05), col: LEAF_PAL[Math.floor(rng() * LEAF_PAL.length)], k: 0.82 + rng() * 0.36 });
    }
  };
  const twig = (a0, len, w) => {
    const pts = [[0, 0]];
    let x = 0, y = 0, a = a0;
    const segs = 14, curl = (rng() - 0.5) * 0.05;
    const nodes = [];
    for (let i = 1; i <= segs; i++) {
      a += curl + (rng() - 0.5) * 0.05;
      x += Math.sin(a) * len / segs; y += Math.cos(a) * len / segs;
      pts.push([x, y]);
      if (y > S * 0.1 && i < segs) nodes.push([x, y, a]);
    }
    stroke(pts, w, w * 0.35, rgb(98, 104, 52));
    let side = rng() < 0.5 ? -1 : 1;
    for (const [nx, ny, na] of nodes) {
      if (rng() > (dense ? 0.95 : 0.9)) continue;
      side = -side;
      const t = ny / (S * 0.9);
      const ba = na + side * (0.55 + rng() * 0.45);
      const bl = S * (0.1 + rng() * 0.13) * (1.2 - 0.55 * t);
      const ex = nx + Math.sin(ba) * bl, ey = ny + Math.cos(ba) * bl;
      stroke([[nx, ny], [ex, ey]], w * 0.45, w * 0.25, rgb(104, 110, 56));
      fan(ex, ey, ba + side * 0.25, (dense ? 4 : 3) + Math.floor(rng() * 3), 1.5 + rng() * 0.7, 1);
    }
    fan(x, y, a, 5 + Math.floor(rng() * 3), 1.9, 1.05);
  };
  if (dense) { twig(-0.28 + (rng() - 0.5) * 0.1, S * 0.9, S * 0.011); twig(0.3 + (rng() - 0.5) * 0.1, S * 0.82, S * 0.009); twig((rng() - 0.5) * 0.1, S * 0.6, S * 0.008); }
  else twig((rng() - 0.5) * 0.2, S * 0.9, S * 0.012);
  // small leaves first so the big ones overlap them
  leaves.sort((p, q) => p.L - q.L);
  for (const l of leaves) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(-l.a);
    drawLeaf(ctx, l.L, l.W, l.col.map((c) => c * l.k), rng);
    ctx.restore();
  }
  ctx.restore();
}

function buildLeafAtlas(seed) {
  const S = 512, canvas = makeCanvas(S * 2, S * 2);
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(seed);
  for (let c = 0; c < 4; c++) sprayCell(ctx, (c % 2) * S, Math.floor(c / 2) * S, S, rng, { dense: c === 3 });
  dilateAlpha(ctx, S * 2, S * 2, 8);
  return { canvas, texture: canvasTexture(canvas, { aniso: 4 }) };
}

/** Distant clump impostor: 2 cells (512×1024 each) of 5–9 culms + a feathery canopy mass on the upper half. */
function buildClumpAtlas(seed) {
  const CW = 512, CH = 1024, canvas = makeCanvas(CW * 2, CH);
  const ctx = canvas.getContext('2d');
  const rng = mulberry32(seed);
  for (let c = 0; c < 2; c++) {
    ctx.save();
    ctx.translate(c * CW, 0);
    const n = 5 + Math.floor(rng() * 4);
    const tops = [];
    for (let i = 0; i < n; i++) {
      const x0 = CW * (0.36 + rng() * 0.28), lean = (x0 - CW / 2) * (1.2 + rng()) + (rng() - 0.5) * 80;
      const top = CH * (0.02 + rng() * 0.12);
      const w = 5 + rng() * 4;
      const k = 0.8 + rng() * 0.35;
      ctx.strokeStyle = rgb(96 * k, 112 * k, 58 * k);
      ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, CH); ctx.quadraticCurveTo(x0 + lean * 0.3, CH * 0.5, x0 + lean, top); ctx.stroke();
      // node marks
      ctx.strokeStyle = rgb(60, 66, 36, 0.8); ctx.lineWidth = 1.5;
      for (let y = CH - 30; y > CH * 0.5; y -= 34 + rng() * 6) {
        const t = (CH - y) / (CH - top), x = x0 + lean * (0.3 * 2 * t * (1 - t) + t * t);
        ctx.beginPath(); ctx.moveTo(x - w * 0.6, y); ctx.lineTo(x + w * 0.6, y); ctx.stroke();
      }
      tops.push([x0, lean, top]);
    }
    // canopy: many little leaves along the upper halves of the culms, denser toward the middle of the crown
    const nL = 2600;
    for (let i = 0; i < nL; i++) {
      const [x0, lean, top] = tops[Math.floor(rng() * tops.length)];
      const t = 0.5 + 0.5 * Math.pow(rng(), 0.7);
      const y = CH - (CH - top) * t;
      const cx = x0 + lean * (0.3 * 2 * t * (1 - t) + t * t);
      const reach = CW * 0.26 * Math.sin(Math.PI * Math.min(1, (t - 0.45) / 0.6)) + 12;
      const x = cx + (rng() - 0.5) * 2 * reach * Math.sqrt(rng());
      const L = 14 + rng() * 12;
      const col = LEAF_PAL[Math.floor(rng() * LEAF_PAL.length)];
      const kk = 0.75 + 0.35 * t + rng() * 0.15;
      ctx.save(); ctx.translate(x, y + rng() * 20); ctx.rotate(Math.PI + (rng() - 0.5) * 2.2 + (x < cx ? 0.5 : -0.5));
      drawLeaf(ctx, L, L * 0.2, col.map((v) => v * kk), rng);
      ctx.restore();
    }
    ctx.restore();
  }
  dilateAlpha(ctx, CW * 2, CH, 8);
  return { canvas, texture: canvasTexture(canvas, { aniso: 4 }) };
}

// ------------------------------------------------------------------------------------------------ geometries
/** Unit culm: unit circle cross-section (radius applied in the shader), y = 0..1 height fraction, uv.x around. */
function culmGeometry(radial, rings) {
  const P = [], N = [], UV = [], I = [];
  for (let j = 0; j <= rings; j++) {
    // denser rings low down, where the camera looks at the culm up close
    const t = Math.pow(j / rings, 1.25);
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      P.push(c, t, s); N.push(c, 0, s); UV.push(i / radial, t);
    }
  }
  const row = radial + 1;
  for (let j = 0; j < rings; j++) for (let i = 0; i < radial; i++) {
    const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
    I.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I);
  return g;
}

/** Ribbon culm for the mid LOD: x = ±1 (side), y = 0..1, 2 triangles per ring interval. */
function ribbonGeometry(rings) {
  const P = [], N = [], UV = [], I = [];
  for (let j = 0; j <= rings; j++) {
    const t = Math.pow(j / rings, 1.2);
    P.push(-1, t, 0, 1, t, 0); N.push(0, 0, 1, 0, 0, 1); UV.push(0, t, 1, t);
  }
  for (let j = 0; j < rings; j++) { const a = j * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I);
  return g;
}

/**
 * Crown: sprays along the upper culm. position = metres from the culm axis at the attach point (crown scale 1),
 * aLeaf = (attach height fraction t, flutter weight, spray phase, 0), uv into the 2×2 leaf atlas.
 */
function crownGeometry(rng, { sprays, len, wid, cells, top = false, cross = 1 }) {
  const P = [], N = [], UV = [], A = [], I = [];
  const up = new THREE.Vector3(0, 1, 0);
  const out = new THREE.Vector3(), d = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  const base = new THREE.Vector3(), q = new THREE.Vector3();
  const quad = (t, o, dir, across, L, W, cell, phase, nrm) => {
    const i0 = P.length / 3;
    const cu = (cell % 2) * 0.5, cv = 0.5 - Math.floor(cell / 2) * 0.5;
    const flip = rng() < 0.5;
    for (let k = 0; k < 4; k++) {
      const u = k === 0 || k === 3 ? 0 : 1, v = k < 2 ? 0 : 1;
      // slight spoon: the far edge droops a bit more than the axis
      q.copy(o).addScaledVector(dir, v * L).addScaledVector(across, (u - 0.5) * W * (0.35 + 0.65 * v));
      q.y -= v * v * L * 0.12;
      P.push(q.x, q.y, q.z);
      N.push(nrm.x, nrm.y, nrm.z);
      UV.push(cu + (0.18 + (flip ? 1 - u : u) * 0.64) * 0.5, cv + v * 0.5);   // sprays fill the middle 64 % of a cell
      A.push(t, v, phase, 0);
    }
    I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  };
  const GA = Math.PI * (3 - Math.sqrt(5));
  let az = rng() * Math.PI * 2;
  for (let s = 0; s < sprays; s++) {
    const f = (s + 0.3 + rng() * 0.4) / sprays;                 // 0 (lowest branch) .. 1 (top)
    const t = T0 + (0.99 - T0) * Math.pow(f, 0.75);
    az += GA + (rng() - 0.5) * 0.5;
    out.set(Math.cos(az), 0, Math.sin(az));
    // branch length profile: long in the lower-middle crown, short at the top → narrow spindle crown
    const prof = 0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, 0.1 + f * 0.9));
    const L = (len[0] + (len[1] - len[0]) * rng()) * prof * (1 - 0.45 * f * f);
    const W = (wid[0] + (wid[1] - wid[0]) * rng()) * (0.8 + 0.2 * prof) * 0.7;
    // spray direction: up-and-out at the attach, drooping toward horizontal (lower sprays droop more)
    const pitch = -0.42 + 0.5 * f - 1.1 * Math.max(0, f - 0.7) + (rng() - 0.5) * 0.3;   // top sprays hang off the arching tip
    d.copy(out).multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)).normalize();
    a.crossVectors(up, d).normalize();
    b.crossVectors(d, a).normalize();
    base.copy(out).multiplyScalar(0.03);
    const phase = rng() * 6.283;
    const cell = cells[Math.floor(rng() * cells.length)];
    // lighting normal: crown-volume (outward + up) blended with the card's upper face
    n.copy(out).multiplyScalar(0.55).addScaledVector(up, 0.5).addScaledVector(b, 0.3).normalize();
    // flat-ish card (rolled a little) + a steep card sharing the same spine
    const roll = (rng() - 0.5) * 1.3;
    const acr = a.clone().multiplyScalar(Math.cos(roll)).addScaledVector(b, Math.sin(roll));
    quad(t, base, d, acr, L, W, cell, phase, n);
    if (f > 0.72 || rng() > cross) continue;   // no steep cross cards up top: seen from the side they read as flags
    const rr = (rng() < 0.5 ? -1 : 1) * (0.6 + rng() * 0.25);   // second card rolled 35–50° off the first
    const acr2 = a.clone().multiplyScalar(Math.cos(rr)).addScaledVector(b, Math.sin(rr)).normalize();
    quad(t, base, d, acr2, L * 0.92, W * 0.8, cells[Math.floor(rng() * cells.length)], phase + 0.4, n);
  }
  if (top) {
    // top tuft: the leader's last spray pointing up, bowed downwind in the shader
    for (let k = 0; k < 2; k++) {
      const ang = rng() * Math.PI;
      out.set(Math.cos(ang), 0, Math.sin(ang));
      d.set(out.x * 0.35, 1, out.z * 0.35).normalize();
      a.crossVectors(up, out).normalize();
      n.set(0, 1, 0).addScaledVector(out, 0.3).normalize();
      quad(0.97, base.set(0, 0, 0), d, a, len[0] * 0.8, wid[1] * 0.8, cells[0], rng() * 6.283, n);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(A, 4));
  g.setIndex(I);
  return g;
}

/** One vertical quad, x ∈ [-0.5, 0.5], y ∈ [0, 1] (turned to the camera in the shader). */
function crossGeometry() {
  const P = [], N = [], UV = [], I = [];
  for (let q = 0; q < 1; q++) {
    const ang = q * Math.PI / 2, c = Math.cos(ang), s = Math.sin(ang);
    const b = P.length / 3;
    P.push(-0.5 * c, 0, -0.5 * s, 0.5 * c, 0, 0.5 * s, 0.5 * c, 1, 0.5 * s, -0.5 * c, 1, -0.5 * s);
    for (let k = 0; k < 4; k++) { const sx = k === 0 || k === 3 ? -1 : 1; N.push(-s * sx * 0.7, 0.55, c * sx * 0.7); }
    UV.push(0, 0, 1, 0, 1, 1, 0, 1);
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I);
  return g;
}

/** InstancedBufferGeometry sharing `base`'s vertex data + the interleaved instance buffer. */
function instGeo(base, ibuf, names) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const k in base.attributes) g.setAttribute(k, base.attributes[k]);
  names.forEach((nm, i) => g.setAttribute(nm, new THREE.InterleavedBufferAttribute(ibuf, 4, i * 4)));
  g.instanceCount = 0;
  return g;
}

// ------------------------------------------------------------------------------------------------ GLSL
const COMMON_PARS = /* glsl */`
${WIND_GLSL}
attribute vec4 aI0;   // base xyz, yaw
attribute vec4 aI1;   // height, radius, lean x, lean z (top offset, m)
attribute vec4 aI2;   // phase, age, node spacing, floor = first-branch height %, fract = crown scale / 2
uniform float uBBWind;
vec3 bbRotY(vec3 p, float c, float s) { return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }
// culm centre-line offset at height fraction t: lean (curved: stiff base) + wind (∝ t², bigger for tall culms)
vec3 bbAxis(float t, float H, out vec3 sw) {
  sw = windSway(aI0.xyz + vec3(0.0, H * 0.7, 0.0), 1.0, aI2.x) * uBBWind * (0.2 + 0.012 * H);
  float bk = t * (0.3 + 0.7 * t);
  // the leader arches over under the weight of its leaves (along the lean, or a random side for straight culms)
  vec2 ld = vec2(aI1.z, aI1.w);
  float ll = length(ld);
  vec2 dd = ll > 1e-3 ? ld / ll : vec2(cos(aI2.x), sin(aI2.x));
  float tip = smoothstep(0.55, 1.0, t);
  float droop = (0.5 + 0.2 * H) * (0.35 + 0.65 * fract(aI2.x * 3.31)) * tip * tip;
  return vec3(aI1.z, 0.0, aI1.w) * bk + vec3(dd.x, -0.5 * tip, dd.y) * droop + sw * (t * t);
}
`;

const CULM_BODY = /* glsl */`
void bbCulm(out vec3 P, out vec3 Nn) {
  float t = position.y, H = aI1.x, R = aI1.y;
  float along = t * H;
  float r = R * (1.0 - 0.62 * pow(t, 1.5)) * (1.0 + 0.3 * exp(-along * 6.0)) * (1.0 - 0.75 * smoothstep(0.86, 1.0, t));   // whip-thin leader
  float c = cos(aI0.w), s = sin(aI0.w);
  vec3 sw;
  vec3 ax = bbAxis(t, H, sw);
#ifdef BB_RIBBON
  // distant culm: a 2-sided ribbon turned to the viewer (or the light in the shadow pass), shaded as a cylinder
  vec3 axisP = aI0.xyz + vec3(0.0, along, 0.0) + ax;
  vec3 toC = cameraPosition - axisP; toC.y = 0.0;
  toC = normalize(toC + vec3(1e-4, 0.0, 0.0));
  vec3 side = vec3(toC.z, 0.0, -toC.x);
  P = axisP + side * (position.x * r * 1.15);
  Nn = normalize(side * position.x * 0.85 + toC * 0.53);
  return;
#endif
  vec3 ring = bbRotY(vec3(position.x * r, 0.0, position.z * r), c, s);
  P = aI0.xyz + vec3(0.0, along, 0.0) + ax + ring;
  // tilt the normal by the local slope of the centre line (lean + wind)
  vec3 slope = (vec3(aI1.z, 0.0, aI1.w) * (0.3 + 1.4 * t) + sw * 2.0 * t) / H;
  vec3 n = bbRotY(vec3(position.x, 0.0, position.z), c, s);
  Nn = normalize(n - vec3(0.0, dot(n, slope), 0.0));
}
`;

const CROWN_BODY = /* glsl */`
attribute vec4 aLeaf; // t (authored for branches from ${T0.toFixed(2)}), flutter weight, phase, 0
varying float vLeafAO;
void bbCrown(out vec3 P, out vec3 Nn) {
  float H = aI1.x;
  float tS = floor(aI2.w) * 0.01;
  float t = tS + (1.0 - tS) * (aLeaf.x - ${T0.toFixed(3)}) / ${(1 - T0).toFixed(3)};
  float c = cos(aI0.w), s = sin(aI0.w);
  vec3 sw;
  vec3 ax = bbAxis(t, H, sw);
  float k = fract(aI2.w) * 2.0;
  vec3 lp = bbRotY(position * k, c, s);
  Nn = bbRotY(normal, c, s);
  // flutter: sprays bob + twist, stronger toward the tips and in gusts
  float g = windGust(aI0.xyz) * uBBWind;
  float ph = aLeaf.z + aI2.x;
  vec3 fl = vec3(sin(uTime * 5.3 + ph * 7.0), 0.7 * sin(uTime * 4.1 + ph * 5.0), sin(uTime * 6.1 + ph * 3.0)) * (0.05 * g * aLeaf.y);
  // sprays trail downwind a little more than the culm they hang on
  P = aI0.xyz + vec3(0.0, t * H, 0.0) + ax + lp + fl + sw * (0.25 * aLeaf.y * length(position.xz) * k);
  vLeafAO = mix(0.55, 1.0, smoothstep(tS - 0.05, 1.0, t)) * (0.8 + 0.2 * aLeaf.y);
}
`;

// mip-aware alpha boost (keeps thin leaves from dissolving in the distance)
const ALPHA_MIP = /* glsl */`
#ifdef USE_MAP
  {
    vec2 bbDx = dFdx(vMapUv * 1024.0), bbDy = dFdy(vMapUv * 1024.0);
    float bbLod = 0.5 * log2(max(max(dot(bbDx, bbDx), dot(bbDy, bbDy)), 1e-6));
    diffuseColor.a *= 1.0 + max(bbLod, 0.0) * 0.16;
  }
#endif
`;

// cards seen edge-on read as planks: thin their coverage at grazing angles (true face normal from derivatives)
const EDGE_FADE = /* glsl */`
  {
    vec3 fN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    diffuseColor.a *= smoothstep(0.06, 0.32, abs(dot(fN, normalize(vViewPosition))));
  }
`;

function culmMaterial(key, depth = false, ribbon = false) {
  const mat = depth ? new THREE.MeshDepthMaterial()
    : ribbon ? new THREE.MeshLambertMaterial({ color: 0xffffff })   // distant ribbons: no specular worth paying for
      : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0, envMapIntensity: 0.85 });
  mat.name = `bamboo-culm-${key}`;
  if (!depth) patchMaterial(mat);
  addShaderHook(mat, `bambooCulm-${key}-${depth ? 'd' : 'm'}${ribbon ? 'r' : ''}-v3`, (sh) => {
    Object.assign(sh.uniforms, { uTime: G.uTime, uWind: G.uWind, tWindNoise: G.tWindNoise, uBBWind: U_WIND });
    Object.assign(sh.uniforms, { uCamPos: G.uCamPos, uBBFocus: U_FOCUS });
    let vs = sh.vertexShader.replace('void main() {', (ribbon ? '#define BB_RIBBON\n' : '') + COMMON_PARS + CULM_BODY + (depth ? '' : FADE_VERT) + 'varying vec4 vBB; varying vec2 vBB2;\nvoid main() {');
    if (depth) {
      vs = vs.replace('#include <begin_vertex>', 'vec3 transformed; { vec3 bbN; bbCulm(transformed, bbN); }');
    } else {
      vs = vs.replace('#include <beginnormal_vertex>', 'vec3 bbP, objectNormal; bbCulm(bbP, objectNormal);\n  vBB = vec4(position.y * aI1.x, uv.x, aI2.y, aI2.z); vBB2 = vec2(fract(aI2.x * 0.1591), position.y); vBBFade = bbOcclusion(aI0.xyz);')
        .replace('#include <begin_vertex>', 'vec3 transformed = bbP;');
    }
    sh.vertexShader = vs;
    if (depth) return;
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', (ribbon ? '#define BB_RIBBON\n' : '') + GLSL_NOISE + 'varying vec4 vBB; varying vec2 vBB2; varying float vBBFade;\nfloat bbNodeDn; float bbAA; float bbAge;\nvoid main() {\n' + FADE_FRAG)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
  {
    float along = vBB.x, around = vBB.y, age = vBB.z, sp = vBB.w, seed = vBB2.x * 97.0;
    bbAge = age;
    // young: saturated green; mature: yellow-green; old: grey-olive with lichen
    vec3 cY = vec3(0.075, 0.165, 0.045), cM = vec3(0.13, 0.185, 0.06), cO = vec3(0.23, 0.215, 0.115);
    vec3 c = age < 0.5 ? mix(cY, cM, age * 2.0) : mix(cM, cO, age * 2.0 - 1.0);
#ifndef BB_RIBBON
    float n1 = wx_vnoise(vec2(around * 26.0, along * 0.9 + seed));
    float n2 = wx_vnoise(vec2(around * 7.0 + seed, along * 3.1));
    c *= 0.84 + 0.26 * n1 + 0.1 * n2;
    // yellow sun-bleached streaks on mature culms
    c = mix(c, vec3(0.30, 0.30, 0.09), smoothstep(0.62, 0.9, wx_vnoise(vec2(around * 11.0 + seed, along * 0.35))) * smoothstep(0.25, 0.7, age) * 0.6);
    float lich = smoothstep(0.58, 0.78, wx_vnoise(vec2(around * 9.0, along * 2.2) + seed * 1.7)) * smoothstep(0.45, 1.0, age);
    c = mix(c, vec3(0.34, 0.34, 0.30), lich * 0.75);
#endif
    // nodes: dn = metres from the nearest node (+ above); internodes shorter near the base
    float spx = sp * mix(0.55, 1.0, smoothstep(0.0, 2.5, along));
    float f = fract(along / spx);
    float dn = (f < 0.5 ? f : f - 1.0) * spx;
    bbNodeDn = dn;
    bbAA = clamp(1.0 - fwidth(along) * 18.0, 0.0, 1.0);
    float line = exp(-pow(dn / 0.0045, 2.0));
    float ridge = exp(-pow((dn - 0.011) / 0.008, 2.0));
    float powder = smoothstep(-0.055, -0.03, dn) * (1.0 - smoothstep(-0.012, -0.004, dn));
    c = mix(c, vec3(0.42, 0.45, 0.40), powder * 0.55 * (1.0 - age) * bbAA);
    c *= 1.0 - 0.6 * line * bbAA;
    c *= 1.0 + 0.22 * ridge * bbAA;
    // base: soil splash, dry sheath remnants
    c = mix(vec3(0.11, 0.085, 0.05), c, smoothstep(0.05, 0.6, along));
    c = mix(c, vec3(0.22, 0.17, 0.10), (1.0 - smoothstep(0.5, 1.3, along)) * smoothstep(0.5, 0.75, wx_vnoise(vec2(around * 5.0, along * 2.2) + seed)) * 0.6);
    // sky occlusion inside the grove (lower culm sees less sky)
    c *= mix(0.62, 1.0, smoothstep(0.0, 0.5, vBB2.y));
    diffuseColor.rgb = c;
  }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(0.3, 0.72, bbAge) + 0.25 * exp(-pow(bbNodeDn / 0.01, 2.0));')
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
  {
    // node ridge bump along the culm axis (view-space up)
    vec3 axV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float w = 0.009, dd = bbNodeDn - 0.006;
    float slope = -2.0 * dd / (w * w) * 0.0035 * exp(-dd * dd / (w * w));
    normal = normalize(normal - axV * slope * bbAA);
  }`);
  });
  return mat;
}

function crownMaterial(tex, key, depth = false, lambert = false) {
  const sun = sunTermsSetup();
  const mat = depth
    ? new THREE.MeshDepthMaterial({ map: tex, alphaTest: 0.5 })
    : lambert ? new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, envMapIntensity: 0.35 });
  mat.name = `bamboo-crown-${key}`;
  if (!depth) { mat.shadowSide = THREE.DoubleSide; patchMaterial(mat); }
  addShaderHook(mat, `bambooCrown-${key}-${depth ? 'd' : 'm'}-${sun.key}-v2`, (sh) => {
    Object.assign(sh.uniforms, { uTime: G.uTime, uWind: G.uWind, tWindNoise: G.tWindNoise, uBBWind: U_WIND }, sunGlobalsUniforms(sun));
    Object.assign(sh.uniforms, { uCamPos: G.uCamPos, uBBFocus: U_FOCUS });
    let vs = sh.vertexShader.replace('void main() {', COMMON_PARS + CROWN_BODY + (depth ? '' : FADE_VERT) + 'varying vec3 vBBTint;\nvoid main() {');
    const tint = 'vBBTint = mix(vec3(1.0), vec3(1.14, 1.08, 0.72), smoothstep(0.55, 1.0, aI2.y) * 0.8) * (0.85 + 0.3 * fract(aI2.x * 3.71));';
    if (depth) vs = vs.replace('#include <begin_vertex>', `vec3 transformed; { vec3 bbN; bbCrown(transformed, bbN); ${tint} }`);
    else vs = vs.replace('#include <beginnormal_vertex>', `vec3 bbP, objectNormal; bbCrown(bbP, objectNormal); ${tint} vBBFade = bbOcclusion(aI0.xyz);`)
      .replace('#include <begin_vertex>', 'vec3 transformed = bbP;');
    sh.vertexShader = vs;
    let fs = sh.fragmentShader
      .replace('void main() {', 'varying vec3 vBBTint;\n' + (depth ? '' : 'varying float vLeafAO; varying float vBBFade;\n' + sunGlobalsPars(sun)) + 'void main() {' + (depth ? '' : FADE_FRAG))
      .replace('#include <alphatest_fragment>', ALPHA_MIP + (depth ? '' : EDGE_FADE) + '#include <alphatest_fragment>');
    if (!depth) {
      fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vBBTint * vLeafAO;')
        .replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL_BEGIN)
        .replace('#include <lights_fragment_begin>', sun.lightsChunk + /* glsl */`
  {
    // modest backlit translucency (thin leaves glow a little against the moon / low sun)
    vec3 sunC = ${sun.sunC}; vec3 sunLv = ${sun.sunD};
    float sunBack = pow(saturate(dot(-geometryViewDir, sunLv)), 4.0);
    float sunWrap = saturate(dot(-normal, sunLv) * 0.6 + 0.4);
    vec3 alb = diffuseColor.rgb;
    reflectedLight.directDiffuse += sunC * alb * vec3(1.05, 1.0, 0.72) * (sunBack * 1.1 + sunWrap * 0.25) * 0.6;
  }
`);
    }
    sh.fragmentShader = fs;
  });
  return mat;
}

function impostorMaterial(tex) {
  const sun = sunTermsSetup();
  const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
  mat.name = 'bamboo-far';
  patchMaterial(mat);
  addShaderHook(mat, `bambooFar-${sun.key}-v2`, (sh) => {
    Object.assign(sh.uniforms, { uTime: G.uTime, uWind: G.uWind, tWindNoise: G.tWindNoise, uBBWind: U_WIND }, sunGlobalsUniforms(sun));
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', WIND_GLSL + 'attribute vec4 aJ0; attribute vec4 aJ1; uniform float uBBWind; varying float vFH; varying float vTint;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = vec2((aJ1.z + uv.x) * 0.5, uv.y); vFH = uv.y; vTint = aJ1.w;')
      .replace('#include <beginnormal_vertex>', /* glsl */`
  // cylindrical billboard: one quad turned to the viewer, lit as a rounded clump (wraps toward its sides)
  vec2 bbT = cameraPosition.xz - aJ0.xz;
  bbT = bbT / max(length(bbT), 1e-3);
  vec3 bbToC = vec3(bbT.x, 0.0, bbT.y), bbSide = vec3(bbT.y, 0.0, -bbT.x);
  vec3 objectNormal = normalize(bbToC * 0.7 + vec3(0.0, 0.55, 0.0) + bbSide * position.x * 0.9);`)
      .replace('#include <begin_vertex>', /* glsl */`
  vec3 transformed;
  {
    vec3 p = bbSide * (position.x * aJ1.y) + vec3(0.0, position.y * aJ1.x, 0.0);
    vec3 sw = windSway(aJ0.xyz + vec3(0.0, 8.0, 0.0), 1.0, aJ0.x * 0.37) * uBBWind * 0.3;
    transformed = aJ0.xyz + p + sw * position.y * position.y;
  }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', sunGlobalsPars(sun) + 'varying float vFH; varying float vTint;\nvoid main() {')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vTint * mix(0.45, 1.0, smoothstep(0.1, 0.8, vFH));')
      .replace('#include <alphatest_fragment>', ALPHA_MIP + '#include <alphatest_fragment>')
      .replace('#include <lights_fragment_begin>', sun.lightsChunk + `
  {
    vec3 sunC = ${sun.sunC}; vec3 sunLv = ${sun.sunD};
    float sunBack = pow(saturate(dot(-geometryViewDir, sunLv)), 4.0);
    reflectedLight.directDiffuse += sunC * diffuseColor.rgb * 0.35 * sunBack * vFH;
  }`);
  });
  return mat;
}

// ------------------------------------------------------------------------------------------------ shoots & stumps
function shootsGeometry(items) {
  const P = [], N = [], C = [], I = [];
  const add = (x, y, z, nx, ny, nz, r, g, b) => { P.push(x, y, z); N.push(nx, ny, nz); C.push(r, g, b); return P.length / 3 - 1; };
  const radial = 7;
  for (const it of items) {
    const { x, y, z, h, r0, kind, yaw, lean } = it;
    const rings = kind === 'shoot' ? 6 : 2;
    const base = P.length / 3;
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      let r = kind === 'shoot' ? r0 * Math.pow(1 - t, 0.85) + 0.004 : r0;
      let yy = t * h;
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2 + yaw, c = Math.cos(a), s = Math.sin(a);
        let top = yy;
        if (kind === 'stump' && j === rings) top = h + c * r0 * 1.2;              // slanted machete cut
        const cx = x + lean[0] * t * t, cz = z + lean[1] * t * t;
        let col;
        if (kind === 'shoot') {
          // overlapping brown sheaths with dark mottles
          const band = 0.5 + 0.5 * Math.sin(t * 22 + i * 0.9);
          const k = 0.7 + 0.3 * band;
          col = [0.16 * k, 0.1 * k, 0.045 * k];
          if (t > 0.85) col = [0.12, 0.13, 0.05];
        } else col = [0.2, 0.2, 0.1];
        add(cx + c * r, y + top, cz + s * r, c, kind === 'shoot' ? 0.4 : 0, s, ...col);
      }
    }
    const row = radial + 1;
    for (let j = 0; j < rings; j++) for (let i = 0; i < radial; i++) {
      const a = base + j * row + i, b = a + 1, c = a + row, d = c + 1;
      I.push(a, c, b, b, c, d);
    }
    if (kind === 'stump') {
      // cut face: pale inner wall ring (hollow culm: dark centre)
      const topRow = base + rings * row;
      const ctr = add(x + lean[0], y + h - 0.02, z + lean[1], 0, 1, 0, 0.03, 0.025, 0.015);
      const inner = P.length / 3;
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2 + yaw, c = Math.cos(a), s = Math.sin(a);
        add(x + lean[0] + c * r0 * 0.75, y + h + c * r0 * 0.9, z + lean[1] + s * r0 * 0.75, 0.3 * c, 0.9, 0.3 * s, 0.42, 0.38, 0.22);
      }
      for (let i = 0; i < radial; i++) {
        // outer rim → inner ring (pale wood), inner ring → centre (dark hollow)
        const o0 = topRow + i, o1 = topRow + i + 1, i0 = inner + i, i1 = inner + i + 1;
        I.push(o0, i0, o1, o1, i0, i1, i0, ctr, i1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------------------------------------ system
export async function createBamboo(app, opts = {}) {
  // detail budget (quality preset): near-LOD radius and the share of culms kept at the mid LOD
  LOD0 = opts.lod0 ?? 32; LOD1 = opts.lod1 ?? 95; MID_KEEP = opts.midKeep ?? 0.7;
  const {
    center = { x: 0, z: 0 }, clearR = 16, inner = 18, outer = 200, keepOut = [], path = null, pathClear = 2.5,
    density = 1, height = [9, 15], seed = 1,
  } = opts;
  const t0 = performance.now();
  const H = (x, z) => app.world.heightAt(x, z);
  const rng = mulberry32(0xB4B00 + seed * 7919);
  const soft = 4;
  const r0 = Math.min(clearR, inner);             // growth starts here (soft edge up to clearR+soft)

  // ---- placement: jittered grid of clump candidates, noise-driven density ----
  const cell = 3.1 / Math.sqrt(Math.max(0.05, density));
  const clumps = [];
  const nCell = Math.ceil(outer / cell);
  const blocked = (x, z, m) => {
    for (const k of keepOut) if ((x - k.x) ** 2 + (z - k.z) ** 2 < (k.r + m) ** 2) return true;
    if (path) { const d = path(x, z); if (d != null && d < pathClear + m) return true; }
    return false;
  };
  for (let gj = -nCell; gj <= nCell; gj++) for (let gi = -nCell; gi <= nCell; gi++) {
    const x = center.x + (gi + 0.15 + rng() * 0.7) * cell, z = center.z + (gj + 0.15 + rng() * 0.7) * cell;
    const u1 = rng(), u2 = rng(), u3 = rng(), u4 = rng();
    const d = Math.hypot(x - center.x, z - center.z);
    if (d < r0 || d > outer) continue;
    // density field: broad patches + gaps; clearing edge ramps in over `soft` metres
    const nz = noise.fbm2(x * 0.021 + seed * 3.1, z * 0.021 - seed * 1.7, 3);
    const gap = noise.fbm2(x * 0.045 - 11.3, z * 0.045 + 5.2, 2);
    let p = THREE.MathUtils.clamp(0.72 + nz * 0.9, 0.12, 1);
    if (gap < -0.42) p *= 0.12;
    p *= THREE.MathUtils.smoothstep(d, clearR, clearR + soft) * (d < inner ? 0.8 : 1);
    if (d > outer - 10) p *= (outer - d) / 10;
    if (u1 > p) continue;
    const n = 3 + Math.floor(Math.pow(u2, 1.2) * 10 * (0.6 + 0.4 * p));
    const spread = 0.28 + 0.07 * Math.sqrt(n) + u3 * 0.35;
    if (blocked(x, z, spread)) continue;
    clumps.push({ x, z, d, n, spread, hk: 0.85 + 0.25 * u4 + 0.1 * nz, edge: THREE.MathUtils.clamp(1 - (d - clearR) / 14, 0, 1) });
  }

  // ---- culms ----
  const culms = [];     // flat per-culm records before chunk sort
  const TAU = Math.PI * 2;
  for (const cl of clumps) {
    const inward = { x: (center.x - cl.x) / Math.max(cl.d, 1e-3), z: (center.z - cl.z) / Math.max(cl.d, 1e-3) };
    const pts = [];
    for (let k = 0, tries = 0; k < cl.n && tries < cl.n * 6; tries++) {
      const a = rng() * TAU, rr = cl.spread * Math.sqrt(rng());
      const x = cl.x + Math.cos(a) * rr, z = cl.z + Math.sin(a) * rr;
      if (pts.some((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 < 0.2 * 0.2)) continue;
      if (blocked(x, z, 0.1)) continue;
      pts.push([x, z]); k++;
    }
    for (const [x, z] of pts) {
      const age = rng() < 0.22 ? 0.65 + rng() * 0.35 : rng() * 0.65;
      let h = (height[0] + (height[1] - height[0]) * Math.pow(rng(), 0.8)) * cl.hk;
      h *= 1 - 0.18 * cl.edge * rng();
      const hn = THREE.MathUtils.clamp((h - 8) / 8, 0, 1);
      const R = 0.025 + 0.032 * hn + (rng() - 0.5) * 0.008;
      // lean: splay out from the clump centre + random + toward the light over the clearing edge
      const ox = x - cl.x, oz = z - cl.z, ol = Math.hypot(ox, oz) || 1;
      const splay = 0.25 + rng() * 0.9, ra = rng() * TAU, rl = rng() * 0.5;
      const edgeLean = cl.edge * (0.8 + rng() * 1.6);
      const lx = (ox / ol) * splay + Math.cos(ra) * rl + inward.x * edgeLean;
      const lz = (oz / ol) * splay + Math.sin(ra) * rl + inward.z * edgeLean;
      const y = H(x, z) - 0.06;
      culms.push({ x, y, z, yaw: rng() * TAU, h, R, lx: lx * h / 12, lz: lz * h / 12, phase: rng() * 40, age, sp: 0.3 + rng() * 0.15,
        ck: Math.min(1.9, Math.pow(h / 12, 0.6) * (0.85 + rng() * 0.3)),
        // first branches at 47–61 % height; culms facing the clearing branch lower (edge light) → foliage at mid height
        ts: Math.round(100 * (0.47 + 0.14 * rng() - cl.edge * (0.12 + 0.12 * rng()))) });
    }
    cl.y = H(cl.x, cl.z);
  }

  // ---- chunk binning ----
  const key = (x, z) => `${Math.floor((x - center.x) / CHUNK)},${Math.floor((z - center.z) / CHUNK)}`;
  const chunkMap = new Map();
  const getChunk = (x, z) => {
    const k = key(x, z);
    let c = chunkMap.get(k);
    if (!c) {
      const [i, j] = k.split(',').map(Number);
      c = { cx: center.x + (i + 0.5) * CHUNK, cz: center.z + (j + 0.5) * CHUNK, y: 0, culms: [], clumps: [], cs: 0, ce: 0, ks: 0, ke: 0, minD: 0, maxD: 0, ymin: Infinity, ymax: -Infinity };
      chunkMap.set(k, c);
    }
    return c;
  };
  for (const c of culms) { const ch = getChunk(c.x, c.z); ch.culms.push(c); ch.ymin = Math.min(ch.ymin, c.y); ch.ymax = Math.max(ch.ymax, c.y + c.h); }
  for (const c of clumps) { const ch = getChunk(c.x, c.z); ch.clumps.push(c); ch.ymin = Math.min(ch.ymin, c.y); ch.ymax = Math.max(ch.ymax, c.y + 15); }
  const chunks = [...chunkMap.values()];
  const all = new Float32Array(Math.max(1, culms.length) * STRIDE);
  const allImp = new Float32Array(Math.max(1, clumps.length) * ISTRIDE);
  let ci = 0, ki = 0;
  for (const ch of chunks) {
    // shuffle so that "the first MID_KEEP of a chunk" is a random subset, not whole clumps
    for (let i = ch.culms.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ch.culms[i], ch.culms[j]] = [ch.culms[j], ch.culms[i]]; }
    ch.cs = ci;
    for (const c of ch.culms) {
      all.set([c.x, c.y, c.z, c.yaw, c.h, c.R, c.lx, c.lz, c.phase, c.age, c.sp, c.ts + c.ck * 0.5], ci * STRIDE);
      ci++;
    }
    ch.ce = ci;
    ch.cm = ch.cs + Math.ceil((ch.ce - ch.cs) * MID_KEEP);
    ch.ks = ki;
    for (const c of ch.clumps) {
      if (rng() > 0.62) continue;   // distant clumps merge: fewer, wider impostors
      const hMean = (height[0] + height[1]) * 0.5 * c.hk;
      allImp.set([c.x, c.y - 0.1, c.z, rng() * Math.PI, hMean * 1.1, (3.2 + c.spread * 2.2 + rng() * 1.2) * 1.25, rng() < 0.5 ? 0 : 1, 0.8 + rng() * 0.35], ki * ISTRIDE);
      ki++;
    }
    ch.ke = ki;
    ch.y = (ch.ymin + ch.ymax) * 0.5;
    ch.rad = Math.hypot(CHUNK * 0.5 * Math.SQRT2 + 3, (ch.ymax - ch.ymin) * 0.5 + 2);
    ch.lod = -1;
    delete ch.culms; delete ch.clumps;
  }

  // ---- resources ----
  const leafAtlas = buildLeafAtlas(0xB4B01 + seed);
  const clumpAtlas = buildClumpAtlas(0xB4B02 + seed);
  const grng = mulberry32(0xB4B03 + seed);
  const baseCulm0 = culmGeometry(6, 12), baseCulm1 = ribbonGeometry(4), baseCulmS = ribbonGeometry(3);
  const baseCrown0 = crownGeometry(grng, { sprays: 14, len: [1.4, 2.2], wid: [0.9, 1.3], cells: [0, 1, 2], cross: 0.6 });
  const baseCrown1 = crownGeometry(grng, { sprays: 7, len: [2.0, 2.8], wid: [1.4, 1.8], cells: [3, 3, 2], cross: 0.45, top: false });
  const baseCross = crossGeometry();

  const mkBuf = (n, stride) => { const b = new THREE.InstancedInterleavedBuffer(new Float32Array(Math.max(1, n) * stride), stride, 1); b.setUsage(THREE.DynamicDrawUsage); return b; };
  const bufNear = mkBuf(culms.length, STRIDE), bufMid = mkBuf(culms.length, STRIDE), bufFar = mkBuf(clumps.length, ISTRIDE);
  const names = ['aI0', 'aI1', 'aI2'];
  const mat = {
    culm0: culmMaterial('L0'), culm1: culmMaterial('L1', false, true),
    crown0: crownMaterial(leafAtlas.texture, 'L0'), crown1: crownMaterial(leafAtlas.texture, 'L1', false, true),
    far: impostorMaterial(clumpAtlas.texture),
    culmDepth: culmMaterial('S', true, true), crownDepth: crownMaterial(leafAtlas.texture, 'S', true),
  };
  mat.culm1.shadowSide = THREE.DoubleSide;   // ribbons face the light in the shadow pass
  const root = new THREE.Group();
  root.name = 'bamboo';
  const sphere = new THREE.Sphere(new THREE.Vector3(center.x, H(center.x, center.z) + 8, center.z), outer + 25);
  const mkMesh = (geo, material, name, order) => {
    geo.boundingSphere = sphere.clone();
    const m = new THREE.Mesh(geo, material);
    m.name = name; m.layers.set(LAYERS.WORLD);
    m.castShadow = false; m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.renderOrder = order;
    root.add(m);
    return m;
  };
  const meshes = {
    culm0: mkMesh(instGeo(baseCulm0, bufNear, names), mat.culm0, 'bamboo-culm-L0', 0),
    crown0: mkMesh(instGeo(baseCrown0, bufNear, names), mat.crown0, 'bamboo-crown-L0', 2),
    culm1: mkMesh(instGeo(baseCulm1, bufMid, names), mat.culm1, 'bamboo-culm-L1', 1),
    crown1: mkMesh(instGeo(baseCrown1, bufMid, names), mat.crown1, 'bamboo-crown-L1', 3),
    far: mkMesh(instGeo(baseCross, bufFar, ['aJ0', 'aJ1']), mat.far, 'bamboo-far', 4),
  };

  // ---- static shadow proxies (whole grove within 170 m of the centre) ----
  const shadowR = 170;
  const sIdx = [];
  for (let i = 0; i < culms.length; i++) {
    const o = i * STRIDE;
    if ((all[o] - center.x) ** 2 + (all[o + 2] - center.z) ** 2 < shadowR * shadowR) sIdx.push(i);
  }
  const sBuf = new THREE.InstancedInterleavedBuffer(new Float32Array(Math.max(1, sIdx.length) * STRIDE), STRIDE, 1);
  sIdx.forEach((i, k) => sBuf.array.set(all.subarray(i * STRIDE, i * STRIDE + STRIDE), k * STRIDE));
  const proxies = [];
  for (const [base, m, dm, nm] of [[baseCulmS, mat.culm1, mat.culmDepth, 'culm'], [baseCrown1, mat.crown1, mat.crownDepth, 'crown']]) {
    const g = instGeo(base, sBuf, names);
    g.instanceCount = sIdx.length;
    g.boundingSphere = sphere.clone();
    const px = new THREE.Mesh(g, m);
    px.name = `bamboo-shadow-${nm}`;
    px.layers.set(LAYERS.WORLD);
    px.castShadow = true; px.receiveShadow = false; px.matrixAutoUpdate = false;
    px.customDepthMaterial = dm;
    const n = sIdx.length;
    // never drawn by a camera pass (WebGLShadowMap does not call onBeforeRender, so the shadow pass keeps them)
    px.onBeforeRender = () => { g.instanceCount = 0; };
    px.onAfterRender = () => { g.instanceCount = n; };
    root.add(px);
    proxies.push(px);
  }

  // ---- shoots & stumps near the clearing edge ----
  const items = [];
  for (let i = 0, tries = 0; i < 34 && tries < 400; tries++) {
    const a = rng() * TAU, d = clearR + 0.6 + rng() * (soft + 3);
    const x = center.x + Math.cos(a) * d, z = center.z + Math.sin(a) * d;
    if (blocked(x, z, 0.3)) continue;
    const kind = rng() < 0.7 ? 'shoot' : 'stump';
    const h = kind === 'shoot' ? 0.25 + Math.pow(rng(), 1.5) * 0.9 : 0.15 + rng() * 0.6;
    const r = kind === 'shoot' ? 0.05 + rng() * 0.06 : 0.035 + rng() * 0.025;
    items.push({ x, z, y: H(x, z) - 0.04, h, r0: r, kind, yaw: rng() * TAU, lean: [(rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08] });
    i++;
  }
  let shoots = null;
  if (items.length) {
    const sm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 });
    sm.name = 'bamboo-shoots';
    patchMaterial(sm);
    shoots = new THREE.Mesh(shootsGeometry(items), sm);
    shoots.name = 'bamboo-shoots';
    shoots.layers.set(LAYERS.WORLD);
    shoots.castShadow = true; shoots.receiveShadow = true; shoots.matrixAutoUpdate = false;
    root.add(shoots);
  }

  // ---- colliders: nearest clumps first, ≤ 600, within 140 m ----
  const colliders = [];
  const byD = clumps.filter((c) => c.d <= 140).sort((a, b) => a.d - b.d).slice(0, 600);
  for (const c of byD) colliders.push({ x: c.x, z: c.z, r: THREE.MathUtils.clamp(c.spread * 0.75 + 0.12, 0.35, 0.6) });
  if (Array.isArray(app.world.colliders)) app.world.colliders.push(...colliders);
  if (app.world.addBlocker) for (const c of colliders) app.world.addBlocker(c);

  root.updateMatrixWorld(true);
  app.scene.add(root);

  // ---- culling / LOD ----
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sph = new THREE.Sphere();
  const last = { p: new THREE.Vector3(1e9, 0, 0), f: new THREE.Vector3(), fov: 0, aspect: 0 };
  const fwd = new THREE.Vector3();
  const vis = [];
  const counts = { near: 0, mid: 0, far: 0, chunks: 0, recull: 0, ms: 0 };
  const setCount = (buf, geos, n, stride) => {
    for (const g of geos) g.instanceCount = n;
    if (n > 0) { buf.clearUpdateRanges(); buf.addUpdateRange(0, n * stride); buf.needsUpdate = true; }
  };
  function cull(force = false) {
    const cam = app.camera;
    cam.updateMatrixWorld();
    cam.getWorldDirection(fwd);
    const p = cam.position;
    if (!force && p.distanceToSquared(last.p) < 0.25 * 0.25 && fwd.dot(last.f) > 0.9997 && cam.fov === last.fov && cam.aspect === last.aspect) return;
    const tc = performance.now();
    last.p.copy(p); last.f.copy(fwd); last.fov = cam.fov; last.aspect = cam.aspect;
    pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    vis.length = 0;
    for (const ch of chunks) {
      sph.center.set(ch.cx, ch.y, ch.cz); sph.radius = ch.rad + 2;
      if (!frustum.intersectsSphere(sph)) continue;
      const d = Math.hypot(ch.cx - p.x, ch.cz - p.z);
      ch.dist = d;
      vis.push(ch);
    }
    vis.sort((a, b) => a.dist - b.dist);   // front to back: early-z inside the grove
    const nA = bufNear.array, mA = bufMid.array, fA = bufFar.array;
    let nn = 0, nm = 0, nf = 0;
    const half = CHUNK * 0.72;
    const l0 = LOD0 * LOD0, px = p.x, pz = p.z;
    for (const ch of vis) {
      const d = ch.dist;
      if (d - half > LOD1 + HYST) {                       // whole chunk far → impostors
        const n = ch.ke - ch.ks;
        if (n) { fA.set(allImp.subarray(ch.ks * ISTRIDE, ch.ke * ISTRIDE), nf * ISTRIDE); nf += n; }
        continue;
      }
      if (d + half < LOD0) {                               // whole chunk near
        const n = ch.ce - ch.cs;
        if (n) { nA.set(all.subarray(ch.cs * STRIDE, ch.ce * STRIDE), nn * STRIDE); nn += n; }
        continue;
      }
      if (d - half > LOD0 && d + half < LOD1) {            // whole chunk mid
        const n = ch.cm - ch.cs;
        if (n) { mA.set(all.subarray(ch.cs * STRIDE, ch.ce * STRIDE), nm * STRIDE); nm += n; }
        continue;
      }
      if (d > LOD1) {                                      // straddles the far boundary: decide per chunk
        const n = ch.ke - ch.ks;
        if (n) { fA.set(allImp.subarray(ch.ks * ISTRIDE, ch.ke * ISTRIDE), nf * ISTRIDE); nf += n; }
        continue;
      }
      if (d - half > LOD0) {
        const n = ch.cm - ch.cs;
        if (n) { mA.set(all.subarray(ch.cs * STRIDE, ch.ce * STRIDE), nm * STRIDE); nm += n; }
        continue;
      }
      for (let i = ch.cs; i < ch.ce; i++) {               // straddles 40 m: per culm
        const o = i * STRIDE;
        const dx = all[o] - px, dz = all[o + 2] - pz;
        if (dx * dx + dz * dz < l0) { for (let k = 0; k < STRIDE; k++) nA[nn * STRIDE + k] = all[o + k]; nn++; }
        else if (i < ch.cm) { for (let k = 0; k < STRIDE; k++) mA[nm * STRIDE + k] = all[o + k]; nm++; }
      }
    }
    setCount(bufNear, [meshes.culm0.geometry, meshes.crown0.geometry], nn, STRIDE);
    setCount(bufMid, [meshes.culm1.geometry, meshes.crown1.geometry], nm, STRIDE);
    setCount(bufFar, [meshes.far.geometry], nf, ISTRIDE);
    meshes.culm0.visible = meshes.crown0.visible = nn > 0;
    meshes.culm1.visible = meshes.crown1.visible = nm > 0;
    meshes.far.visible = nf > 0;
    Object.assign(counts, { near: nn, mid: nm, far: nf, chunks: vis.length, recull: counts.recull + 1, ms: +(performance.now() - tc).toFixed(2) });
  }
  cull(true);

  const buildMs = performance.now() - t0;
  const bamboo = {
    root, colliders, meshes, proxies, atlases: { leaves: leafAtlas, clumps: clumpAtlas },
    update() {},
    lateUpdate() {
      if (opts.focus) { const f = opts.focus(); if (f) bamboo.setFocus(f); }
      if (root.visible) cull();
    },
    /** Camera-occlusion fade target (player chest, world). Call every frame; null disables the segment fade
     *  (culms within ~2.5 m of the camera still fade). */
    setFocus(v) { if (v) U_FOCUS.value.set(v.x, v.y, v.z, 1); else U_FOCUS.value.w = 0; },
    focusUniform: U_FOCUS,
    /** Force a re-cull (e.g. after teleporting the camera outside the normal update loop). */
    cull: () => cull(true),
    setVisible(v) { root.visible = v; },
    /** Wind response multiplier (1 = default amplitudes). */
    setWindResponse(k) { U_WIND.value = k; },
    stats() {
      return {
        clumps: clumps.length, culms: culms.length, chunks: chunks.length, colliders: colliders.length,
        shadowCasters: sIdx.length, shoots: items.length, visible: { ...counts },
        tris: {
          culmL0: baseCulm0.index.count / 3, culmL1: baseCulm1.index.count / 3, crownL0: baseCrown0.index.count / 3, crownL1: baseCrown1.index.count / 3,
        },
        buildMs: +buildMs.toFixed(1),
      };
    },
    dispose() {
      app.scene.remove(root);
      app.remove?.(bamboo);
      if (Array.isArray(app.world.colliders)) {
        const set = new Set(colliders);
        for (let i = app.world.colliders.length - 1; i >= 0; i--) if (set.has(app.world.colliders[i])) app.world.colliders.splice(i, 1);
      }
      for (const g of [baseCulm0, baseCulm1, baseCulmS, baseCrown0, baseCrown1, baseCross]) g.dispose();
      root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      for (const m of Object.values(mat)) m.dispose();
      shoots?.material.dispose();
      leafAtlas.texture.dispose(); clumpAtlas.texture.dispose();
    },
  };
  app.add(bamboo);
  return bamboo;
}
