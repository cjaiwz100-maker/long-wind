// Trees (bible §5.7): the lone golden poplar (胡杨-like) on the knoll, wind-bent pines on distant swells and a far
// band of star billboards on the rim ridges. Owner: vegetation (V). STABLE API:
//   const trees = await createTrees(app, opts?) → { colliders: [{x, z, r}], hero, pines, band, atlases, update(dt),
//                                                   setVisible(bool), stats(), dispose() }
//     hero      { group, position (trunk base, world), crown: {center, radius}, bark, leaves }
//     opts      { pines = 3, band = 3000, hero = true }
//   Colliders are also appended to app.world.colliders (and pines registered with app.world.addBlocker when present).
//
// Generator: the reference recursive grower (vegetation-wind.md §8.3): per-depth length / radius ratio / kids / start /
// angle / gnarl / up / droop / spread / segment length, golden-angle phyllotaxis, a downwind trunk lean and umbrella
// spread; bark tubes with parallel-transport frames, 5-lobed root flare, bark lumps and texel-density UVs; foliage
// cards from canvas atlases (alpha-dilated) with crown-volume lighting normals (70 % radial) and interior darkening.
// Wind: every vertex carries aWind = (flex, phase), flex = path-integrated Σ len/(40·r), displacement
// windSway(p, 0.018·fl² + 0.004·fl, phase) · min(fl, 6|8) · 0.16 (bark | leaves) + leaf flutter; cards inherit
// their branch phase (+ a small offset) so crowns move as sprays, not confetti.
// Light: bark = scanned PBR (Poly Haven chinese_cedar_bark / pine_bark, tinted) on MeshStandard; leaves = MeshStandard
// + backlit translucency with the SHADOWED sun (sunBack·2.6 + sunWrap·0.4)·1.3. Hero and pines cast (dappled,
// alpha-tested) into the far shadow map (layer WORLD); the far band never casts.
import * as THREE from 'three';
import { G, LAYERS, WORLD } from '../core/globals.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { mulberry32, noise } from '../core/noise.js';
import { WIND_GLSL } from '../core/wind.js';
import {
  sunTermsSetup, sunGlobalsPars, sunGlobalsUniforms, FOLIAGE_NORMAL_BEGIN, makeCanvas, dilateAlpha, canvasTexture, VEG_LAYOUT,
} from './foliage.js';

// ------------------------------------------------------------------------------------------------ species
// Old desert poplar: short massive trunk, long wind-sculpted scaffolds, clumpy golden crown (bible §5.7 numbers).
const POPLAR = {
  depth: 4, leafDepth: 3,
  len: [4.3, 3.9, 2.6, 1.5, 0.8], rad: 0.5, radRatio: [0.5, 0.56, 0.6, 0.62],
  kids: [4, 4, 3, 3], start: [0.58, 0.3, 0.25, 0.3], angle: [0.78, 0.68, 0.7, 0.75],
  gnarl: [0.14, 0.2, 0.24, 0.26, 0.28], up: [0.03, 0.04, 0.03, 0.03, 0.04], droop: [0, 0.08, 0.14, 0.12, 0.08],
  spread: [0, 0.62, 0.34, 0.2, 0.1], segLen: [0.35, 0.36, 0.3, 0.24, 0.18],
  lean: 0.18, clusterStep: 0.4, cards: [3, 5], cardSize: [0.48, 0.76],
};
// Wind-bent pine (reference niwaki pine, flagged downwind): near-horizontal limbs ending in cloud pads.
const PINE = {
  depth: 2, leafDepth: 2,
  len: [7.5, 3.6, 1.6], rad: 0.32, radRatio: [0.42, 0.55],
  kids: [7, 3], start: [0.35, 0.35], angle: [1.25, 0.7],
  gnarl: [0.1, 0.16, 0.2], up: [0.03, 0.05, 0.09], droop: [0, 0.08, 0], spread: [0, 0.2, 0.1], segLen: [0.4, 0.34, 0.26],
  lean: 0.3, pads: true, cardSize: [0.55, 0.85],
};

// ------------------------------------------------------------------------------------------------ canvas atlases
const rgbs = (r, g, b, a = 1) => `rgba(${Math.round(Math.max(0, Math.min(255, r)))},${Math.round(Math.max(0, Math.min(255, g)))},${Math.round(Math.max(0, Math.min(255, b)))},${a})`;

/** Poplar leaf: broad ovate-rhombic blade with a toothed margin, midrib and petiole. Drawn at the origin pointing +y. */
function poplarLeaf(ctx, L, W, col, rng) {
  const [r, g, b] = col;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const teeth = 7;
  const pts = [];
  for (let i = 0; i <= teeth * 2; i++) {
    const t = i / (teeth * 2);
    const y = t * L;
    const w = W * Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 - 0.25 * t) * (i % 2 ? 0.93 : 1);
    pts.push([w, y]);
  }
  for (const [x, y] of pts) ctx.lineTo(x, y);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(-pts[i][0] * (0.92 + rng() * 0.1), pts[i][1]);
  ctx.closePath();
  const gr = ctx.createLinearGradient(0, 0, W * 0.6, L);
  gr.addColorStop(0, rgbs(r * 0.82, g * 0.8, b * 0.9));
  gr.addColorStop(0.55, rgbs(r, g, b));
  gr.addColorStop(1, rgbs(r * 1.06, g * 1.08, b * 1.1));
  ctx.fillStyle = gr;
  ctx.fill();
  // midrib + a few veins
  ctx.strokeStyle = rgbs(r * 1.08, g * 1.05, b * 0.9, 0.55);
  ctx.lineWidth = Math.max(0.8, W * 0.06);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, L * 0.92); ctx.stroke();
  ctx.lineWidth = Math.max(0.5, W * 0.03);
  for (let k = 1; k <= 3; k++) {
    const y = L * (0.2 + k * 0.18);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W * 0.6, y + L * 0.12); ctx.moveTo(0, y); ctx.lineTo(-W * 0.6, y + L * 0.12); ctx.stroke();
  }
  // a darker blotch on some leaves (autumn spotting)
  if (rng() < 0.3) {
    ctx.fillStyle = rgbs(r * 0.6, g * 0.45, b * 0.3, 0.35);
    ctx.beginPath(); ctx.ellipse((rng() - 0.5) * W * 0.6, L * (0.3 + rng() * 0.4), W * 0.18, W * 0.14, 0, 0, Math.PI * 2); ctx.fill();
  }
}

/** Twig spray cell: a forked twig skeleton with 24–34 leaves on petioles, sized small → large so big leaves overlap. */
function leafCell(ctx, ox, oy, S, rng, palette, density) {
  ctx.save();
  ctx.translate(ox, oy);
  const twig = [];
  const branch = (x, y, a, len, w, depth) => {
    const ex = x + Math.sin(a) * len, ey = y - Math.cos(a) * len;
    ctx.strokeStyle = rgbs(74, 56, 40);
    ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.sin(a + 0.3) * len * 0.5, y - Math.cos(a + 0.3) * len * 0.5, ex, ey); ctx.stroke();
    for (let i = 1; i <= 4; i++) { const t = i / 4; twig.push([x + (ex - x) * t, y + (ey - y) * t, a]); }
    if (depth > 0) {
      branch(ex, ey, a - 0.55 - rng() * 0.3, len * 0.62, w * 0.62, depth - 1);
      branch(ex, ey, a + 0.45 + rng() * 0.3, len * 0.6, w * 0.6, depth - 1);
    }
  };
  branch(S * 0.5, S * 0.97, (rng() - 0.5) * 0.3, S * 0.36, S * 0.022, 2);
  const leaves = [];
  const n = Math.round((24 + rng() * 10) * density);
  for (let i = 0; i < n; i++) {
    const [tx, ty, ta] = twig[Math.floor(rng() * twig.length)];
    const a = ta + (rng() - 0.5) * 2.6;
    const size = S * (0.07 + rng() * 0.06);
    leaves.push({ x: tx, y: ty, a, size, col: palette[Math.floor(rng() * palette.length)], k: 0.85 + rng() * 0.3, sq: 0.55 + rng() * 0.45 });
  }
  leaves.sort((a, b) => a.size - b.size);
  for (const l of leaves) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.a + Math.PI);
    // petiole
    ctx.strokeStyle = rgbs(120, 96, 40); ctx.lineWidth = Math.max(1, l.size * 0.05);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, l.size * 0.35); ctx.stroke();
    ctx.translate(0, l.size * 0.33);
    ctx.scale(l.sq, 1);                                   // fake viewing angle
    poplarLeaf(ctx, l.size, l.size * 0.46, l.col.map((c) => c * l.k), rng);
    ctx.restore();
  }
  ctx.restore();
}

function buildLeafAtlas(seed) {
  const S = 512, canvas = makeCanvas(S * 2, S * 2);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(seed);
  // sRGB (180–235, 120–175, 20–60): golden to amber (bible §5.7)
  const golden = [[226, 170, 44], [214, 156, 36], [234, 184, 58], [200, 142, 30], [222, 176, 60]];
  const amber = [[210, 128, 30], [196, 120, 26], [226, 150, 40], [186, 112, 24]];
  const lemon = [[226, 186, 60], [206, 176, 52], [190, 170, 60], [232, 196, 80]];
  const cells = [[golden, 1.0], [golden.concat(amber), 1.0], [golden.concat(lemon), 1.0], [golden, 0.7]];
  cells.forEach(([pal, dens], i) => {
    ctx.save(); ctx.beginPath(); ctx.rect((i % 2) * S, Math.floor(i / 2) * S, S, S); ctx.clip();
    leafCell(ctx, (i % 2) * S, Math.floor(i / 2) * S, S, rng, pal, dens);
    ctx.restore();
  });
  dilateAlpha(ctx, S * 2, S * 2, 6);
  const texture = canvasTexture(canvas, { aniso: 8 });
  texture.name = 'poplarLeaves';
  return { canvas, texture };
}

/** Pine needle tufts: radial strokes, dark shafts and lighter tips (reference `py`). */
function buildNeedleAtlas(seed) {
  const S = 256, canvas = makeCanvas(S * 2, S * 2);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(seed);
  for (let c = 0; c < 4; c++) {
    const ox = (c % 2) * S, oy = Math.floor(c / 2) * S;
    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, S, S); ctx.clip();
    const tufts = 5 + c;
    for (let t = 0; t < tufts; t++) {
      const cx = ox + S * (0.25 + rng() * 0.5), cy = oy + S * (0.25 + rng() * 0.5);
      const w = 0.8 + rng() * 0.4;
      for (let k = 0; k < 70; k++) {
        const a = rng() * Math.PI * 2, L = S * (0.1 + rng() * 0.2);
        const ex = cx + Math.cos(a) * L, ey = cy + Math.sin(a) * L * 0.8;
        ctx.strokeStyle = rgbs(28 * w, 52 * w, 26 * w); ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (ex - cx) * 0.7, cy + (ey - cy) * 0.7); ctx.stroke();
        ctx.strokeStyle = rgbs(88 * w, 118 * w, 52 * w); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(cx + (ex - cx) * 0.6, cy + (ey - cy) * 0.6); ctx.lineTo(ex, ey); ctx.stroke();
      }
    }
    ctx.restore();
  }
  dilateAlpha(ctx, S * 2, S * 2, 6);
  const texture = canvasTexture(canvas, { aniso: 4 });
  texture.name = 'pineNeedles';
  return { canvas, texture };
}

/** Far band billboards (1024×512, 4 cells of 256×512): golden poplar, round broadleaf, dark juniper, shrub clump. */
function buildFarAtlas(seed) {
  const CW = 256, CH = 512, canvas = makeCanvas(CW * 4, CH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(seed);
  const blob = (x, y, rx, ry, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rng() * 3, 0, Math.PI * 2); ctx.fill(); };
  const limbs = (ox, top, n, col) => {
    ctx.strokeStyle = col; ctx.lineCap = 'round';
    ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(ox + CW / 2, CH); ctx.lineTo(ox + CW / 2 + (rng() - 0.5) * 10, CH * 0.62); ctx.stroke();
    for (let i = 0; i < n; i++) {
      const a = (rng() - 0.5) * 1.6, L = CH * (0.18 + rng() * 0.2);
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(ox + CW / 2, CH * 0.66); ctx.quadraticCurveTo(ox + CW / 2 + Math.sin(a) * L * 0.4, CH * 0.66 - L * 0.5, ox + CW / 2 + Math.sin(a) * L, top + CH * 0.12 + rng() * 40); ctx.stroke();
    }
  };
  // 0: columnar golden poplar
  {
    const ox = 0;
    limbs(ox, CH * 0.05, 4, rgbs(58, 44, 32));
    for (let i = 0; i < 90; i++) {
      const v = rng(), y = CH * (0.06 + 0.62 * v), wmax = CW * (0.14 + 0.2 * Math.sin(Math.PI * Math.min(1, v * 1.15)));
      const x = ox + CW / 2 + (rng() - 0.5) * 2 * wmax;
      const hk = 1 - v;
      const pal = [[180, 128, 36], [214, 160, 48], [236, 190, 76]][Math.min(2, Math.floor(hk * 3.2))];
      for (let k = 0; k < 6; k++) blob(x + (rng() - 0.5) * 22, y + (rng() - 0.5) * 22, 7 + rng() * 9, 5 + rng() * 7, rgbs(...pal.map((c) => c * (0.8 + rng() * 0.35))));
    }
  }
  // 1: round broadleaf (olive → amber)
  {
    const ox = CW;
    limbs(ox, CH * 0.3, 5, rgbs(50, 40, 30));
    for (let i = 0; i < 80; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng());
      const x = ox + CW / 2 + Math.cos(a) * r * CW * 0.42, y = CH * 0.46 + Math.sin(a) * r * CH * 0.2;
      const hk = 1 - (y - CH * 0.26) / (CH * 0.4);
      const pal = [[74, 70, 34], [118, 100, 44], [160, 128, 58]][Math.max(0, Math.min(2, Math.floor(hk * 3)))];
      for (let k = 0; k < 7; k++) blob(x + (rng() - 0.5) * 26, y + (rng() - 0.5) * 20, 8 + rng() * 9, 6 + rng() * 7, rgbs(...pal.map((c) => c * (0.8 + rng() * 0.35))));
    }
  }
  // 2: dark wind-shaped pine / juniper clump: a leaning trunk and a few flat needle pads (never a cypress cone)
  {
    const ox = CW * 2;
    ctx.strokeStyle = rgbs(46, 34, 28); ctx.lineCap = 'round';
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(ox + CW * 0.45, CH); ctx.quadraticCurveTo(ox + CW * 0.5, CH * 0.6, ox + CW * 0.62, CH * 0.3); ctx.stroke();
    const pads = 5 + Math.floor(rng() * 3);
    for (let p = 0; p < pads; p++) {
      const py = CH * (0.28 + 0.5 * (p / pads)) + (rng() - 0.5) * 20;
      const px = ox + CW * (0.5 + (rng() - 0.35) * 0.5), pw = CW * (0.18 + rng() * 0.2), ph = CH * (0.035 + rng() * 0.03);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(ox + CW * 0.52, py + ph); ctx.lineTo(px, py); ctx.stroke();
      for (let k = 0; k < 60; k++) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng());
        const shade = 0.75 + rng() * 0.45 * (1 - Math.sin(a) * 0.5);
        blob(px + Math.cos(a) * r * pw, py + Math.sin(a) * r * ph, 6 + rng() * 6, 4 + rng() * 4, rgbs(30 * shade, 46 * shade, 32 * shade));
      }
    }
  }
  // 3: low shrub clump (tamarisk / caragana: russet-olive), bottom 45 % of the cell
  {
    const ox = CW * 3;
    for (let i = 0; i < 70; i++) {
      const a = rng() * Math.PI, r = Math.sqrt(rng());
      const x = ox + CW / 2 + Math.cos(a) * r * CW * 0.46, y = CH - Math.sin(a) * r * CH * 0.4;
      const pal = [[90, 62, 36], [122, 92, 50], [150, 118, 64], [104, 60, 40]][Math.floor(rng() * 4)];
      for (let k = 0; k < 5; k++) blob(x + (rng() - 0.5) * 20, y + (rng() - 0.5) * 16, 6 + rng() * 8, 5 + rng() * 6, rgbs(...pal.map((c) => c * (0.8 + rng() * 0.3))));
    }
  }
  dilateAlpha(ctx, CW * 4, CH, 6);
  const texture = canvasTexture(canvas, { aniso: 4 });
  texture.name = 'farTrees';
  return { canvas, texture };
}

// ------------------------------------------------------------------------------------------------ generator
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Grow one tree. Returns { branches: [{pts, rad, flex, phase, depth}], clusters: [{p, flex, phase}], pads: [...] }.
 * base: Vector3 (trunk base), lean: unit xz Vector3 (downwind), scale, rng, seed (noise offset).
 */
function growTree(P, { base, lean, scale = 1, rng, seed = 0 }) {
  const branches = [], clusters = [], pads = [];
  const U = (a, b) => a + (b - a) * rng();
  let bid = 0;
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

  function grow(start, dir, length, radius, d, flex, phase) {
    const id = bid++;
    const nSeg = Math.max(3, Math.ceil(length / (P.segLen[d] * scale)));
    const rEnd = d === P.depth ? radius * 0.25 : radius * 0.5;
    const pts = [start.clone()], rad = [radius], flx = [flex];
    const pos = start.clone(), dv = dir.clone().normalize();
    const g = P.gnarl[d];
    for (let i = 1; i <= nSeg; i++) {
      const O = i / nSeg;
      dv.x += noise.simplex3(seed + id * 3.17, i * 0.35, 0.5) * g;
      dv.y += noise.simplex3(seed + id * 3.17, i * 0.35, 7.5) * g * 0.6;
      dv.z += noise.simplex3(seed + id * 3.17, i * 0.35, 13.5) * g;
      dv.y += P.up[d] - P.droop[d] * O * O;
      if (d === 0) dv.addScaledVector(lean, 0.035 * (1 - O));
      dv.normalize();
      pos.addScaledVector(dv, length / nSeg);
      const r = radius + (rEnd - radius) * Math.pow(O, 0.9);
      pts.push(pos.clone()); rad.push(r); flx.push(flex + (length * O) / Math.max(0.05, r * 40));
    }
    const br = { pts, rad, flex: flx, phase, depth: d, length };
    branches.push(br);
    const at = (t, out) => {                               // point on the polyline at fraction t
      const f = t * nSeg, i = Math.min(nSeg - 1, Math.floor(f)), u = f - i;
      return out.copy(pts[i]).lerp(pts[i + 1], u);
    };
    const tanAt = (t, out) => {
      const f = t * nSeg, i = Math.min(nSeg - 1, Math.floor(f));
      return out.subVectors(pts[i + 1], pts[i]).normalize();
    };
    const flexAt = (t) => { const f = t * nSeg, i = Math.min(nSeg - 1, Math.floor(f)), u = f - i; return flx[i] + (flx[i + 1] - flx[i]) * u; };
    const radAt = (t) => { const f = t * nSeg, i = Math.min(nSeg - 1, Math.floor(f)), u = f - i; return rad[i] + (rad[i + 1] - rad[i]) * u; };

    if (d < P.depth) {
      let n = P.kids[d] + (rng() < 0.35 ? 1 : 0) - (rng() < 0.2 ? 1 : 0);
      if (P.pads && d === 0) n = P.kids[0];
      const az0 = rng() * Math.PI * 2;
      for (let j = 0; j < n; j++) {
        const t = P.start[d] + (1 - P.start[d]) * ((j + U(0.1, 0.9)) / n);
        const a = at(t, new THREE.Vector3());
        const T = tanAt(t, tmpA);
        // perpendicular basis around the parent tangent
        const ref = Math.abs(T.y) < 0.9 ? _up : tmpB.set(1, 0, 0);
        const bx = tmpC.crossVectors(T, ref).normalize();
        const by = new THREE.Vector3().crossVectors(T, bx).normalize();
        const az = az0 + j * 2.39996 + U(-0.4, 0.4);
        const perp = bx.clone().multiplyScalar(Math.cos(az)).addScaledVector(by, Math.sin(az));
        const ang = P.angle[d] * U(0.75, 1.2);
        const cdir = T.clone().multiplyScalar(Math.cos(ang)).addScaledVector(perp, Math.sin(ang));
        const out = new THREE.Vector3(a.x - base.x, 0, a.z - base.z);
        if (out.lengthSq() > 1e-6) cdir.addScaledVector(out.normalize(), P.spread[d + 1]);
        // pines: flagged by the prevailing wind — limbs on the windward side are short and swept downwind
        let lenK = 1;
        if (P.pads && d === 0) {
          const h = new THREE.Vector3(cdir.x, 0, cdir.z).normalize();
          const dw = h.dot(lean);
          lenK = 0.55 + 0.6 * (dw * 0.5 + 0.5);
          cdir.addScaledVector(lean, 0.45);
          if (t > 0.85) lenK *= 0.6;
        }
        const clen = P.len[d + 1] * scale * U(0.75, 1.2) * (d > 0 ? 1 - 0.3 * t : 1) * lenK;
        const crad = Math.max(0.006, radAt(t) * P.radRatio[d] * U(0.85, 1.1));
        grow(a, cdir.normalize(), clen, crad, d + 1, flexAt(t), phase + U(-0.6, 0.6));
      }
    }
    if (P.pads) {
      if (d === P.depth || (d === P.depth - 1 && rng() < 0.4)) pads.push({ p: pts[pts.length - 1].clone(), flex: flx[flx.length - 1], phase });
    } else if (d >= P.leafDepth) {
      const step = P.clusterStep * scale;
      for (let s = length * 0.25; s <= length; s += step * U(0.7, 1.3)) {
        const t = s / length;
        clusters.push({ p: at(t, new THREE.Vector3()), flex: flexAt(t), phase: phase + U(-0.3, 0.3), depth: d });
      }
    }
  }
  const dir0 = new THREE.Vector3(0, 1, 0).addScaledVector(lean, P.lean).normalize();
  grow(base.clone(), dir0, P.len[0] * scale * U(0.9, 1.15), P.rad * scale, 0, 0, rng() * 6.28);
  return { branches, clusters, pads };
}

// ------------------------------------------------------------------------------------------------ meshers
/** Bark tubes: parallel-transport frames, root flare on the trunk, texel-density UVs, aWind = (flex, phase). */
function barkGeometry(branches, { flareBase = null, radialScale = 1 } = {}) {
  const pos = [], nrm = [], uv = [], wind = [], idx = [];
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), prevT = new THREE.Vector3();
  const dirV = new THREE.Vector3();
  let bi = 0;
  for (const br of branches) {
    const { pts, rad, flex, phase, depth } = br;
    const n = pts.length;
    const r0 = rad[0];
    let rs = r0 > 0.3 ? 20 : r0 > 0.2 ? 16 : r0 > 0.09 ? 9 : r0 > 0.035 ? 6 : 4;
    rs = Math.max(3, Math.round(rs * radialScale));
    const base = pos.length / 3;
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (i < n - 1) T.subVectors(pts[i + 1], pts[i]).normalize(); else T.subVectors(pts[i], pts[i - 1]).normalize();
      if (i > 0 && i < n - 1) T.add(prevT.subVectors(pts[i], pts[i - 1]).normalize()).normalize();
      if (i === 0) {
        N.crossVectors(T, Math.abs(T.y) < 0.9 ? _up : new THREE.Vector3(1, 0, 0)).normalize();
      } else {
        N.addScaledVector(T, -T.dot(N)).normalize();       // parallel transport
      }
      B.crossVectors(T, N).normalize();
      if (i > 0) s += pts[i].distanceTo(pts[i - 1]);
      const wraps = Math.max(1, Math.round((2 * Math.PI * rad[i]) / 0.9));
      for (let k = 0; k <= rs; k++) {
        const th = (k / rs) * Math.PI * 2;
        let R = rad[i];
        if (depth === 0 && flareBase) {
          const hAbove = Math.max(0, pts[i].y - flareBase.y);
          R *= 1 + Math.exp(-2.2 * hAbove) * (0.55 + 0.45 * Math.sin(5 * th + bi)) * 0.9;
          R *= 1 + 0.06 * noise.simplex3(Math.cos(th) * 2, Math.sin(th) * 2, s * 0.8);
        } else {
          R *= 1 + 0.05 * Math.sin(3 * th + 2 * s);
        }
        dirV.copy(N).multiplyScalar(Math.cos(th)).addScaledVector(B, Math.sin(th));
        pos.push(pts[i].x + dirV.x * R, pts[i].y + dirV.y * R, pts[i].z + dirV.z * R);
        nrm.push(dirV.x, dirV.y, dirV.z);
        uv.push((k / rs) * wraps, s / 1.1);
        wind.push(flex[i], phase);
      }
      prevT.copy(T);
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < rs; k++) {
        const a = base + i * (rs + 1) + k, b = a + rs + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);             // counter-clockwise seen from outside
      }
    }
    bi++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWind', new THREE.Float32BufferAttribute(wind, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Foliage cards. cards: [{p, n (card facing), size, roll, cell (0..3), flex, phase, tint:[r,g,b]}]. Lighting normal =
 * normalize(cardN·0.3 + radial·0.7) around the crown centre (one soft volume); vertex colour carries tint × AO.
 */
function cardGeometry(cards, crown, { radialW = 0.7 } = {}) {
  const n = cards.length;
  const pos = new Float32Array(n * 12), nrm = new Float32Array(n * 12), uv = new Float32Array(n * 8);
  const col = new Float32Array(n * 12), wind = new Float32Array(n * 8), idx = [];
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), R = new THREE.Vector3(), L = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const Nn = c.n;
    X.crossVectors(Math.abs(Nn.y) < 0.95 ? _up : new THREE.Vector3(1, 0, 0), Nn).normalize();
    Y.crossVectors(Nn, X).normalize();
    const cr = Math.cos(c.roll), sr = Math.sin(c.roll);
    const ax = X.clone().multiplyScalar(cr).addScaledVector(Y, sr), ay = Y.clone().multiplyScalar(cr).addScaledVector(X, -sr);
    R.subVectors(c.p, crown.center);
    const dist = R.length();
    R.divideScalar(Math.max(dist, 1e-3));
    L.copy(Nn).multiplyScalar(1 - radialW).addScaledVector(R, radialW).normalize();
    const h = c.size * 0.5;
    const corners = [[-h, -h, 0, 0], [h, -h, 1, 0], [h, h, 1, 1], [-h, h, 0, 1]];
    const cu = (c.cell % 2) * 0.5, cv = Math.floor(c.cell / 2) * 0.5;
    for (let k = 0; k < 4; k++) {
      const [sx, sy, u, v] = corners[k];
      const o = i * 12 + k * 3;
      pos[o] = c.p.x + ax.x * sx + ay.x * sy; pos[o + 1] = c.p.y + ax.y * sx + ay.y * sy; pos[o + 2] = c.p.z + ax.z * sx + ay.z * sy;
      nrm[o] = L.x; nrm[o + 1] = L.y; nrm[o + 2] = L.z;
      col[o] = c.tint[0]; col[o + 1] = c.tint[1]; col[o + 2] = c.tint[2];
      uv[i * 8 + k * 2] = cu + (c.flipU ? 1 - u : u) * 0.5; uv[i * 8 + k * 2 + 1] = 1 - cv - (1 - v) * 0.5;
      wind[i * 8 + k * 2] = c.flex + (v * 0.15); wind[i * 8 + k * 2 + 1] = c.phase;
    }
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aWind', new THREE.BufferAttribute(wind, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------------------------------------ materials
const TREE_WIND_PARS = /* glsl */`
${WIND_GLSL}
attribute vec2 aWind;       // flex (path-integrated), phase
`;
// bark: sway ~ cubic in flex; leaves: + flutter (bible §5.7, vegetation-wind.md §8.7)
function treeWindBody(leaf) {
  return /* glsl */`
  {
    vec4 wxW0 = modelMatrix * vec4(transformed, 1.0);
    float fl = aWind.x;
    vec3 sw = windSway(wxW0.xyz, 0.018 * fl * fl + 0.004 * fl, aWind.y);
    ${leaf ? `
    float g = windGust(wxW0.xyz);
    vec3 flut = vec3(sin(uTime * 5.3 + aWind.y * 7.0 + wxW0.y), sin(uTime * 4.1 + aWind.y * 5.0) * 0.6, sin(uTime * 6.1 + aWind.y * 3.0 + wxW0.x)) * 0.045 * g * smoothstep(1.0, 3.0, fl);
    transformed += (sw * min(fl, 8.0) * 0.16 + flut) * uTreeWindK;` : `
    transformed += sw * min(fl, 6.0) * 0.16 * uTreeWindK;`}
  }
`;
}

function barkMaterial(pbr, { tint, key }) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(...tint), roughness: 0.96, metalness: 0, envMapIntensity: 0.7,
    map: pbr?.map ?? null, normalMap: pbr?.normalMap ?? null, normalScale: new THREE.Vector2(1.4, 1.4),
  });
  mat.name = `bark-${key}`;
  patchMaterial(mat);
  addShaderHook(mat, `treeBark-${key}-v1`, (sh) => {
    Object.assign(sh.uniforms, { uTime: G.uTime, uWind: G.uWind, tWindNoise: G.tWindNoise, uTreeWindK: treeWindK });
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', TREE_WIND_PARS + 'uniform float uTreeWindK;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + treeWindBody(false));
  });
  return mat;
}

function leafMaterial(tex, { key, trans = 1.3, back = 2.6, wrap = 0.4, glow = 0.06, alphaTest = 0.42, roughness = 0.75 }) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex, vertexColors: true, alphaTest, side: THREE.DoubleSide, roughness, metalness: 0, envMapIntensity: 0.5,
  });
  mat.shadowSide = THREE.DoubleSide;
  mat.name = `leaves-${key}`;
  patchMaterial(mat);
  const sun = sunTermsSetup();
  addShaderHook(mat, `treeLeaf-${key}-${sun.key}-v1`, (sh) => {
    Object.assign(sh.uniforms, { uTime: G.uTime, uWind: G.uWind, tWindNoise: G.tWindNoise, uTreeWindK: treeWindK }, sunGlobalsUniforms(sun));
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', TREE_WIND_PARS + 'uniform float uTreeWindK;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + treeWindBody(true));
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', sunGlobalsPars(sun) + '\nvoid main() {')
      .replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL_BEGIN)
      .replace('#include <lights_fragment_begin>', sun.lightsChunk + /* glsl */`
  {
    vec3 sunC = ${sun.sunC}; vec3 sunLv = ${sun.sunD};
    float sunBack = pow(saturate(dot(-geometryViewDir, sunLv)), 4.0);
    float sunWrap = saturate(dot(-normal, sunLv) * 0.6 + 0.4);
    // transmitted light through the leaf is warmer and more saturated than the reflected
    vec3 alb = diffuseColor.rgb;
    vec3 tcol = alb * mix(vec3(1.0), vec3(1.08, 0.94, 0.7), 0.6);
    reflectedLight.directDiffuse += sunC * tcol * (sunBack * ${back.toFixed(2)} + sunWrap * ${wrap.toFixed(2)}) * ${trans.toFixed(2)};
    reflectedLight.indirectDiffuse += alb * ${glow.toFixed(3)};
  }
`);
  });
  return mat;
}

const treeWindK = { value: 1 };

// ------------------------------------------------------------------------------------------------ hero poplar
const HERO_SCALE = 1.32;
function buildHero(app, atlas, barkPBR, rng) {
  const L = VEG_LAYOUT?.oldTree ?? { x: -20, z: -14, r: 0.8, crown: 9 };
  const W = app.world;
  const y0 = W.heightAt(L.x, L.z);
  const base = new THREE.Vector3(L.x, y0 - 0.45, L.z);
  const wind = G.uWind.value;
  const lean = new THREE.Vector3(wind.x, 0, wind.y).normalize();
  // try a few seeds and keep the one whose crown is broadest and most balanced (deterministic)
  let best = null;
  for (let k = 0; k < 6; k++) {
    const r = mulberry32(WORLD.seed + 777 + k * 31);
    const t = growTree(POPLAR, { base, lean, scale: HERO_SCALE, rng: r, seed: 100 + k * 17 });
    const c = t.clusters;
    if (!c.length) continue;
    const cen = c.reduce((a, q) => a.add(q.p), new THREE.Vector3()).divideScalar(c.length);
    let spread = 0;
    for (const q of c) spread += Math.hypot(q.p.x - cen.x, q.p.z - cen.z);
    spread /= c.length;
    const off = Math.hypot(cen.x - base.x - lean.x * 1.2, cen.z - base.z - lean.z * 1.2);
    const score = spread - off * 0.8 + Math.min(c.length, 700) * 0.002;
    if (!best || score > best.score) best = { t, score, cen };
  }
  const tree = best.t;
  const clusters = tree.clusters;
  // crown volume
  const center = best.cen.clone();
  let rad = 0;
  const ds = clusters.map((q) => q.p.distanceTo(center)).sort((a, b) => a - b);
  rad = ds[Math.floor(ds.length * 0.9)] || 6;

  const bark = barkGeometry(tree.branches, { flareBase: base });
  const barkMat = barkMaterial(barkPBR, { tint: [0.95, 0.9, 0.86], key: 'poplar' });
  const barkMesh = new THREE.Mesh(bark, barkMat);
  barkMesh.name = 'heroTree-bark';

  // foliage cards: clumpy sprays around each cluster point
  const cards = [];
  const Uf = (a, b) => a + (b - a) * rng();
  const gauss = () => (rng() + rng() + rng() - 1.5) / 1.5;
  for (const q of clusters) {
    const nC = Math.floor(Uf(POPLAR.cards[0], POPLAR.cards[1] + 1));
    const radial = new THREE.Vector3().subVectors(q.p, center).normalize();
    const clumpK = 0.9 + 0.2 * rng();
    for (let i = 0; i < nC; i++) {
      const p = q.p.clone().add(new THREE.Vector3(gauss(), gauss() * 0.7, gauss()).multiplyScalar(0.34 * HERO_SCALE));
      const nrm = new THREE.Vector3(Uf(-1, 1), Uf(-0.3, 1), Uf(-1, 1)).addScaledVector(radial, 0.7).addScaledVector(_up, 0.35).normalize();
      const dist = p.distanceTo(center) / rad;
      const ao = Math.min(1, Math.max(0.35, 0.45 + 0.55 * dist)) * (0.82 + 0.18 * Math.min(1, Math.max(0, (p.y - center.y) / rad + 0.6)));
      const k = clumpK * (0.9 + 0.2 * rng()) * ao;
      cards.push({
        p, n: nrm, size: Uf(POPLAR.cardSize[0], POPLAR.cardSize[1]) * HERO_SCALE, roll: rng() * Math.PI * 2,
        cell: dist > 0.95 && rng() < 0.5 ? 3 : Math.floor(rng() * 3), flipU: rng() < 0.5,
        flex: q.flex + 0.8, phase: q.phase + Uf(-0.3, 0.3),
        tint: (() => { const g = rng(); const kk = k * (0.7 + 0.35 * rng()); return g < 0.28 ? [kk * 0.62, kk * 0.8, kk * 0.42] : g < 0.4 ? [kk * 1.05, kk * 1.0, kk * 0.85] : [kk, kk * (0.94 + 0.06 * rng()), kk * (0.85 + 0.12 * rng())]; })(),
      });
    }
  }
  const leafGeo = cardGeometry(cards, { center });
  const leafMat = leafMaterial(atlas.texture, { key: 'poplar', trans: 1.1, back: 1.7, wrap: 0.35, glow: 0.02 });
  const leafMesh = new THREE.Mesh(leafGeo, leafMat);
  leafMesh.name = 'heroTree-leaves';

  const group = new THREE.Group();
  group.name = 'heroTree';
  for (const m of [barkMesh, leafMesh]) {
    m.castShadow = true; m.receiveShadow = true;
    m.layers.set(LAYERS.WORLD);
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  // the canopy grows past the rim of its bounding sphere once it sways: keep culling honest
  leafGeo.boundingSphere.radius += 1.5; bark.boundingSphere.radius += 1;
  return {
    group, position: base, crown: { center, radius: rad }, bark: barkMesh, leaves: leafMesh,
    counts: { branches: tree.branches.length, clusters: clusters.length, cards: cards.length, barkTris: bark.index.count / 3 },
    collider: { x: L.x, z: L.z, r: Math.max(0.8, L.r ?? 0.8) },
  };
}

// ------------------------------------------------------------------------------------------------ pines
/** Pick distant high points (local maxima on the swells) in a ring, spread in azimuth. */
function pickSwells(app, n, rng) {
  const H = app.world.heightAt;
  const sunAz = Math.atan2(G.uSunDir.value.z, G.uSunDir.value.x);
  const cands = [];
  for (let i = 0; i < 900; i++) {
    const a = rng() * Math.PI * 2, r = 110 + rng() * 150;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = H(x, z);
    let avg = 0;
    for (let k = 0; k < 6; k++) { const b = (k / 6) * Math.PI * 2; avg += H(x + Math.cos(b) * 22, z + Math.sin(b) * 22); }
    avg /= 6;
    const prom = h - avg;
    const gi = app.world.groundInfo?.(x, z);
    if (gi && (gi.road > 0.2 || gi.rock > 0.5)) continue;
    if (app.world.isBlocked?.(x, z, 3)) continue;
    // favour silhouettes against the sky on the sun side and one on the cool side
    const dAz = Math.abs(Math.atan2(Math.sin(a - sunAz), Math.cos(a - sunAz)));
    cands.push({ x, z, h, score: prom + (dAz < 1.0 ? 1.2 : 0) + rng() * 0.6 });
  }
  cands.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cands) {
    if (out.length >= n) break;
    if (out.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 70)) continue;
    out.push(c);
  }
  return out;
}

function buildPines(app, atlas, barkPBR, n, rng) {
  if (n <= 0) return null;
  const spots = pickSwells(app, n, rng);
  const wind = G.uWind.value;
  const lean = new THREE.Vector3(wind.x, 0, wind.y).normalize();
  const branches = [], cards = [], colliders = [];
  let crownC = new THREE.Vector3();
  for (const [si, s] of spots.entries()) {
    const base = new THREE.Vector3(s.x, s.h - 0.35, s.z);
    const scale = 0.95 + rng() * 0.35;
    const t = growTree(PINE, { base, lean, scale, rng, seed: 500 + si * 23 });
    branches.push(...t.branches);
    colliders.push({ x: s.x, z: s.z, r: 0.5 * scale });
    // cloud pads: lens-shaped discs of needle cards, lighter and yellower on top
    for (const pad of t.pads) {
      const E = (1 + rng() * 0.7) * scale, M = (0.35 + rng() * 0.2) * scale;
      const c = pad.p.clone().add(new THREE.Vector3(0, 0.6 * M, 0)).addScaledVector(lean, 0.3 * E);
      const nCards = Math.round(46 * E * E * 0.55);
      for (let i = 0; i < nCards; i++) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * E;
        const C = -0.5 + rng() * 1.1;
        const p = c.clone().add(new THREE.Vector3(Math.cos(a) * r * 1.15, C * M * (1 - 0.6 * r / E), Math.sin(a) * r * 0.9));
        const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const nrm = new THREE.Vector3((rng() - 0.5) * 0.6, 1, (rng() - 0.5) * 0.6).addScaledVector(radial, 0.6 * (r / E)).normalize();
        const ao = 0.75 + 0.25 * Math.min(1, Math.max(0, C + 0.5));
        cards.push({
          p, n: nrm, size: (0.55 + rng() * 0.3) * scale, roll: rng() * Math.PI * 2, cell: Math.floor(rng() * 4), flipU: rng() < 0.5,
          flex: pad.flex + 1.5, phase: pad.phase, tint: [(0.85 + 0.3 * C) * ao, (0.95 + 0.25 * C) * ao, (0.8 + 0.2 * C) * ao],
        });
      }
    }
    crownC = base.clone().add(new THREE.Vector3(0, 6, 0));
  }
  const bark = barkGeometry(branches, { radialScale: 0.8 });
  const barkMesh = new THREE.Mesh(bark, barkMaterial(barkPBR, { tint: [0.75, 0.7, 0.68], key: 'pine' }));
  barkMesh.name = 'pines-bark';
  // pads shade as units: radial weight toward the pad itself is already in the card normal (up + radial)
  const leafGeo = cardGeometry(cards, { center: crownC }, { radialW: 0.0 });
  const leafMesh = new THREE.Mesh(leafGeo, leafMaterial(atlas.texture, { key: 'pine', trans: 0.45, back: 2.4, wrap: 0.35, glow: 0.02, alphaTest: 0.45, roughness: 0.8 }));
  leafMesh.name = 'pines-needles';
  const group = new THREE.Group();
  group.name = 'pines';
  for (const m of [barkMesh, leafMesh]) {
    m.castShadow = true; m.receiveShadow = true; m.layers.set(LAYERS.WORLD); m.matrixAutoUpdate = false;
    m.frustumCulled = false;                     // spread over the whole plain: one merged draw each
    group.add(m);
  }
  return { group, spots, colliders, counts: { pines: spots.length, cards: cards.length, barkTris: bark.index.count / 3 } };
}

// ------------------------------------------------------------------------------------------------ far band
function buildBand(app, atlas, count, rng) {
  if (count <= 0) return null;
  const H = app.world.heightAt;
  const pts = [];
  let tries = 0;
  while (pts.length < count && tries < count * 40) {
    tries++;
    const a = rng() * Math.PI * 2, r = 200 + Math.pow(rng(), 0.7) * 330;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // groves on the rim ridges: noise clusters, favouring high ground relative to the surroundings
    const grove = noise.fbm2(x * 0.011 + 31.7, z * 0.011 - 12.2, 3);
    if (grove < 0.24) continue;
    const h = H(x, z);
    let avg = 0;
    for (let k = 0; k < 4; k++) { const b = (k / 4) * Math.PI * 2 + 0.4; avg += H(x + Math.cos(b) * 30, z + Math.sin(b) * 30); }
    avg /= 4;
    const ridge = h - avg;
    if (rng() > 0.3 + ridge * 0.25 + (grove - 0.24) * 2.2) continue;
    if (app.world.pathAt && app.world.pathAt(x, z).dist < 5) continue;
    const kindN = noise.fbm2(x * 0.02 - 8.1, z * 0.02 + 3.3, 2);
    const kind = kindN > 0.2 ? 0 : kindN > -0.1 ? 1 : kindN > -0.38 ? 3 : 2;
    pts.push({ x, z, y: h, kind });
  }
  const n = pts.length;
  // 3 vertical quads at 60° (six-sided star); normals tilted up (reference `xT`)
  const base = new THREE.BufferGeometry();
  const P = [], Nn = [], UV = [], I = [];
  for (let q = 0; q < 3; q++) {
    const a = (q / 3) * Math.PI, c = Math.cos(a), s = Math.sin(a);
    const b = P.length / 3;
    P.push(-0.5 * c, 0, -0.5 * s, 0.5 * c, 0, 0.5 * s, 0.5 * c, 1, 0.5 * s, -0.5 * c, 1, -0.5 * s);
    for (let k = 0; k < 4; k++) { const sx = k === 0 || k === 3 ? -1 : 1; Nn.push(-s * sx * 0.95, 0.3, c * sx * 0.95); }
    UV.push(0, 0, 1, 0, 1, 1, 0, 1);
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  base.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  base.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  base.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  base.setIndex(I);
  const aKind = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  base.setAttribute('aKind', aKind);
  const mat = new THREE.MeshLambertMaterial({ map: atlas.texture, alphaTest: 0.45, side: THREE.DoubleSide });
  mat.name = 'farTrees';
  patchMaterial(mat);
  const sun = sunTermsSetup();
  addShaderHook(mat, `farTrees-${sun.key}-v1`, (sh) => {
    Object.assign(sh.uniforms, { uTime: G.uTime, uWind: G.uWind, tWindNoise: G.tWindNoise }, sunGlobalsUniforms(sun));
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', WIND_GLSL + 'attribute float aKind;\nvarying float vFH;\nvoid main() {')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = vec2((aKind + uv.x) * 0.25, uv.y); vFH = uv.y;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    vec4 wp0 = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 sw = windSway(wp0.xyz, 0.05, wp0.x * 0.3);
    transformed.xz += (wx_invRotScale(mat3(instanceMatrix)) * sw).xz * uv.y * uv.y;
  }`)
      .replace('void main() {', 'mat3 wx_invRotScale(mat3 m) { return transpose(m) / max(dot(m[0], m[0]), 1e-8); }\nvoid main() {');
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', sunGlobalsPars(sun) + 'varying float vFH;\nvoid main() {')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= mix(0.4, 1.0, smoothstep(0.0, 0.85, vFH));')
      .replace('#include <lights_fragment_begin>', sun.lightsChunk + `
  {
    vec3 sunC = ${sun.sunC}; vec3 sunLv = ${sun.sunD};
    float sunBack = pow(saturate(dot(-geometryViewDir, sunLv)), 4.0);
    reflectedLight.directDiffuse += sunC * diffuseColor.rgb * 0.5 * sunBack * vFH;
  }`);
  });
  const mesh = new THREE.InstancedMesh(base, mat, Math.max(1, n));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pp = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const p = pts[i], r = rng();
    let h, w;
    if (p.kind === 0) { h = 8 + 11 * r * r; w = h * (0.4 + 0.2 * rng()); }
    else if (p.kind === 1) { h = 7 + 4 * r; w = h * (0.9 + 0.3 * rng()); }
    else if (p.kind === 2) { h = 7 + 5 * r; w = h * (0.75 + 0.25 * rng()); }
    else { h = 4.5 + 2.5 * r; w = h * (1.4 + 0.4 * rng()); }
    q.setFromAxisAngle(_up, rng() * Math.PI);
    // non-uniform scale breaks the rotY·uniform inverse used for wind; keep uniform scale and stretch in the atlas
    sc.set(w, h, w);
    pp.set(p.x, p.y - 0.4, p.z);
    m4.compose(pp, q, sc);
    mesh.setMatrixAt(i, m4);
    aKind.array[i] = p.kind;
    const k = 0.55 + 0.5 * rng();
    if (rng() < 0.3) mesh.setColorAt(i, col.setRGB(k * 0.95, k, k * 0.85));        // golden
    else mesh.setColorAt(i, col.setRGB(k * 0.42, k * 0.55, k * 0.3));             // dark olive-green
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = false; mesh.receiveShadow = true;
  mesh.layers.set(LAYERS.WORLD);
  mesh.name = 'farTrees';
  return { mesh, count: n };
}

// ------------------------------------------------------------------------------------------------ system
async function tryPBR(id) {
  try {
    const { loadPBR } = await import('../core/assets.js');
    const t = await loadPBR(id);
    // bark UVs are texel-density (0.9 m around, 1.1 m along): repeat wrapping, trilinear
    for (const k of ['map', 'normalMap', 'armMap']) if (t[k]) { t[k].wrapS = t[k].wrapT = THREE.RepeatWrapping; t[k].needsUpdate = true; }
    return t;
  } catch (e) { console.warn('[trees] bark texture unavailable', id, e?.message); return null; }
}

export async function createTrees(app, opts = {}) {
  const rng = mulberry32(WORLD.seed + 9001);
  const [poplarBark, pineBark] = await Promise.all([tryPBR('chinese_cedar_bark'), tryPBR('pine_bark')]);
  const atlases = {
    leaves: buildLeafAtlas(WORLD.seed + 9101),
    pine: buildNeedleAtlas(WORLD.seed + 9102),
    far: buildFarAtlas(WORLD.seed + 9103),
  };
  const colliders = [];
  const root = new THREE.Group();
  root.name = 'trees';

  let hero = null, pines = null, band = null;
  if (opts.hero !== false) {
    try {
      hero = buildHero(app, atlases.leaves, poplarBark, rng);
      root.add(hero.group);
      colliders.push(hero.collider);
    } catch (e) { console.error('[trees] hero tree failed', e); }
  }
  try {
    pines = buildPines(app, atlases.pine, pineBark, opts.pines ?? 3, rng);
    if (pines) { root.add(pines.group); colliders.push(...pines.colliders); }
  } catch (e) { console.error('[trees] pines failed', e); }
  try {
    band = buildBand(app, atlases.far, opts.band ?? 3000, rng);
    if (band) root.add(band.mesh);
  } catch (e) { console.error('[trees] far band failed', e); }

  root.updateMatrixWorld(true);
  app.scene.add(root);
  // movement / camera registry (+ W's blocker hash for the pines; the hero trunk is already a LAYOUT blocker)
  if (Array.isArray(app.world.colliders)) app.world.colliders.push(...colliders);
  if (pines && app.world.addBlocker) for (const c of pines.colliders) app.world.addBlocker(c);

  const trees = {
    colliders, hero, pines, band, atlases, root,
    setVisible(v) { root.visible = v; },
    /** Wind response multiplier (1 = bible amplitudes). */
    setWindResponse(k) { treeWindK.value = k; },
    stats() { return { hero: hero?.counts, pines: pines?.counts, band: band?.count }; },
    update() {},
    dispose() {
      app.scene.remove(root);
      root.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      app.remove(trees);
    },
  };
  app.add(trees);
  return trees;
}
