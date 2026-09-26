// Ground texture baker (bible §4.4). Packs the scanned Poly Haven ground sets plus a procedural straw-thatch set into
// TWO sampler2DArrays so the terrain shader needs only two texture units for every layer:
//   albedo array (sRGB RGBA8):  rgb = diffuse,            a = blend height (luminance + AO, stretched per layer)
//   normal array (linear RGBA8): rg = tangent normal xy,  b = roughness,  a = ambient occlusion
// Rows are packed bottom-up (GL convention) so +v is the green-up direction of the OpenGL normal maps; the terrain
// maps u → +x and v → +z. Each layer also gets a per-channel albedo gain that normalises its mean linear albedo to the
// bible palette target, so every set lands in the right value range regardless of how the scan was exposed.
// Owner: world (W).
//
//   const sets = await bakeGroundSets({ size = 1024, onProgress })
//   sets.albedo / sets.normal   DataArrayTexture (layers in GROUND_LAYERS order)
//   sets.tile   Float32Array    metres per texture repeat, per layer
//   sets.gain   THREE.Vector3[] albedo gain per layer (uniform uWtGain)
//   sets.index  { name: layer }
import * as THREE from 'three';
import { loadManifest } from '../core/assets.js';
import { mulberry32 } from '../core/noise.js';
import { WIND_DIR } from '../core/globals.js';

// Linear albedo targets (bible §1.4 / §4.4 grey-card calibration). Order = layer index used by the terrain shader.
export const GROUND_LAYERS = [
  { name: 'lush', id: 'sparse_grass', tile: 2.4, target: [0.085, 0.080, 0.040] },       // 0 ground under the blades
  { name: 'leafy', id: 'leafy_grass', tile: 2.05, target: [0.080, 0.086, 0.036] },       // 1 moist hollows
  { name: 'thatch', id: null, tile: 2.6, target: [0.215, 0.160, 0.078] },               // 2 dry golden straw litter (procedural)
  { name: 'dirt', id: 'dry_ground_rocks', tile: 3.3, target: [0.185, 0.138, 0.092] },   // 3 bare cracked soil
  { name: 'road', id: 'grass_path_3', tile: 3.1, target: [0.160, 0.124, 0.084] },       // 4 packed road
  { name: 'rock', id: 'rock_boulder_dry', tile: 6.0, target: [0.180, 0.168, 0.150] },   // 5 rock / scree (triplanar)
  { name: 'leaves', id: 'forest_leaves_02', tile: 2.25, target: [0.26, 0.15, 0.045] },  // 6 leaf litter under the tree
  { name: 'stony', id: 'rocky_terrain_02', tile: 4.2, target: [0.090, 0.086, 0.046] },  // 7 grass with pebble patches
];

const BASE = import.meta.env?.BASE_URL ?? '/';
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const LUT = new Float32Array(256).map((_, i) => srgbToLin(i / 255));

async function decode(url, size) {
  const blob = await (await fetch(url.startsWith('/') ? url : BASE + url)).blob();
  const bmp = await createImageBitmap(blob, {
    resizeWidth: size, resizeHeight: size, resizeQuality: 'high',
    imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none',
  });
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return ctx.getImageData(0, 0, size, size).data;
}

/** Stretch a height channel to 0..255 between its 2nd and 98th percentile. */
function stretch(h) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < h.length; i++) hist[h[i]]++;
  let acc = 0, lo = 0, hi = 255;
  const n = h.length;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc < n * 0.02) lo = v; if (acc < n * 0.98) hi = v; }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < h.length; i++) h[i] = Math.max(0, Math.min(255, (h[i] - lo) * k));
}

/** Procedural straw thatch (bible §4.4 recipe): soil + 5000 layered straw strokes biased along the wind. */
function paintThatch(size) {
  const mk = () => { const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size }); return c; };
  const cCol = mk(), cH = mk();
  const col = cCol.getContext('2d', { willReadFrequently: true }), hgt = cH.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(5150);
  const tile = 2.6, pxPerM = size / tile;
  // soil with mottling
  col.fillStyle = 'rgb(84,70,54)'; col.fillRect(0, 0, size, size);
  hgt.fillStyle = 'rgb(0,0,0)'; hgt.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const x = rng() * size, y = rng() * size, r = 6 + rng() * 40, v = rng();
    const g = col.createRadialGradient(x, y, 0, x, y, r);
    const c = v < 0.5 ? `rgba(58,46,34,${0.25 * rng()})` : `rgba(112,94,70,${0.18 * rng()})`;
    g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
    col.fillStyle = g;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) { col.save(); col.translate(ox, oy); col.fillRect(x - r, y - r, 2 * r, 2 * r); col.restore(); }
  }
  // straw strokes: 3 passes old/dark → fresh/pale; height = layer order
  const windAng = Math.atan2(WIND_DIR.y, WIND_DIR.x);
  const passes = [
    { n: 1900, lum: [0.34, 0.52], a: 0.9, h: 70 },
    { n: 1900, lum: [0.55, 0.78], a: 0.95, h: 150 },
    { n: 1400, lum: [0.75, 1.0], a: 1.0, h: 230 },
  ];
  for (const p of passes) {
    for (let i = 0; i < p.n; i++) {
      const len = (0.04 + rng() * 0.10) * pxPerM;
      const ang = windAng + (rng() - 0.5) * 0.9 + (rng() < 0.25 ? (rng() - 0.5) * 2.6 : 0);
      const x = rng() * size, y = rng() * size;
      const bend = (rng() - 0.5) * len * 0.35;
      const w = 0.9 + rng() * 2.1;
      const l = p.lum[0] + rng() * (p.lum[1] - p.lum[0]);
      // straw palette (sRGB-ish): warm straw, some grey-dead, some olive
      const kind = rng();
      let r = 214 * l, g = 176 * l, b = 104 * l;
      if (kind < 0.18) { r = 170 * l; g = 160 * l; b = 132 * l; } else if (kind < 0.3) { r = 168 * l; g = 160 * l; b = 84 * l; }
      const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
      const nx = -Math.sin(ang) * bend, ny = Math.cos(ang) * bend;
      for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size], [size, size], [-size, -size], [size, -size], [-size, size]]) {
        const x0 = x + ox, y0 = y + oy;
        if (x0 + len < 0 || x0 - len > size || y0 + len < 0 || y0 - len > size) continue;
        col.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},${p.a})`;
        col.lineWidth = w; col.lineCap = 'round';
        col.beginPath(); col.moveTo(x0, y0); col.quadraticCurveTo(x0 + dx * 0.5 + nx, y0 + dy * 0.5 + ny, x0 + dx, y0 + dy); col.stroke();
        // darker contact edge under each stroke (fake self-shadow)
        const hv = p.h + rng() * 25;
        hgt.strokeStyle = `rgb(${hv | 0},${hv | 0},${hv | 0})`;
        hgt.lineWidth = w + 0.6; hgt.lineCap = 'round';
        hgt.beginPath(); hgt.moveTo(x0, y0); hgt.quadraticCurveTo(x0 + dx * 0.5 + nx, y0 + dy * 0.5 + ny, x0 + dx, y0 + dy); hgt.stroke();
      }
    }
  }
  return { col: col.getImageData(0, 0, size, size).data, h: hgt.getImageData(0, 0, size, size).data };
}

/** Sobel normal from a height field (0..255), strength in "texels per unit". */
function sobelNormal(h, size, strength, out, rough, aoOut) {
  const H = (x, y) => h[(((y + size) % size) * size + ((x + size) % size))];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
    let nx = -dx * strength / 255, ny = -dy * strength / 255, nz = 1;
    const il = 1 / Math.hypot(nx, ny, nz); nx *= il; ny *= il;
    const k = (y * size + x) * 4;
    out[k] = (nx * 0.5 + 0.5) * 255; out[k + 1] = (ny * 0.5 + 0.5) * 255;
    out[k + 2] = rough[y * size + x];
    out[k + 3] = aoOut[y * size + x];
  }
}

export async function bakeGroundSets({ size = 1024, onProgress } = {}) {
  const manifest = await loadManifest();
  const L = GROUND_LAYERS.length, px = size * size;
  const alb = new Uint8Array(px * 4 * L), nrm = new Uint8Array(px * 4 * L);
  const gain = [], tile = new Float32Array(L), index = {};
  let done = 0;
  const tick = () => onProgress?.(++done / L);

  async function layer(li) {
    const def = GROUND_LAYERS[li];
    index[def.name] = li; tile[li] = def.tile;
    const aOff = px * 4 * li;
    let col, nrmData, armData, hChan = new Uint8Array(px);
    if (def.id) {
      const m = manifest.textures[def.id];
      [col, nrmData, armData] = await Promise.all([decode(m.diffuse, size), decode(m.normal, size), decode(m.arm, size)]);
      for (let i = 0; i < px; i++) {
        const k = i * 4;
        nrm[aOff + k] = nrmData[k]; nrm[aOff + k + 1] = nrmData[k + 1];
        nrm[aOff + k + 2] = armData[k + 1];   // roughness (ARM.g)
        nrm[aOff + k + 3] = armData[k];       // AO (ARM.r)
        const lum = 0.3 * col[k] + 0.59 * col[k + 1] + 0.11 * col[k + 2];
        hChan[i] = Math.min(255, lum * 0.65 + armData[k] * 0.35);
      }
    } else {
      // procedural thatch
      const t = paintThatch(size);
      col = t.col;
      const h = new Uint8Array(px), rough = new Uint8Array(px), ao = new Uint8Array(px);
      for (let i = 0; i < px; i++) {
        h[i] = t.h[i * 4];
        rough[i] = 255 * (0.93 - h[i] / 255 * 0.12);
        ao[i] = 255 * (0.55 + 0.45 * Math.min(1, h[i] / 150));
      }
      const tmp = new Uint8Array(px * 4);
      sobelNormal(h, size, 2.2, tmp, rough, ao);
      nrm.set(tmp, aOff);
      for (let i = 0; i < px; i++) hChan[i] = Math.min(255, h[i] * 0.8 + col[i * 4] * 0.25);
    }
    stretch(hChan);
    // mean linear albedo → per-channel gain toward the target
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < px; i++) {
      const k = i * 4;
      alb[aOff + k] = col[k]; alb[aOff + k + 1] = col[k + 1]; alb[aOff + k + 2] = col[k + 2]; alb[aOff + k + 3] = hChan[i];
      sr += LUT[col[k]]; sg += LUT[col[k + 1]]; sb += LUT[col[k + 2]];
    }
    sr /= px; sg /= px; sb /= px;
    gain[li] = new THREE.Vector3(def.target[0] / Math.max(sr, 1e-3), def.target[1] / Math.max(sg, 1e-3), def.target[2] / Math.max(sb, 1e-3));
    tick();
  }

  // decode a couple of layers at a time (keeps memory spikes down, still overlaps network/decode)
  for (let i = 0; i < L; i += 3) await Promise.all([i, i + 1, i + 2].filter(j => j < L).map(layer));

  const mkArr = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, size, size, L);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true; t.anisotropy = 16;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mkArr(alb, true), normal: mkArr(nrm, false), tile, gain, index, size };
}
