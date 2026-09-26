// Carved-inscription atlas for the world props (bible §4.6: "canvas-rendered system CJK font → height → normal").
// Owner: world (W). One 2048×1024 atlas shared by the stele (front, back, sides), its plinth, the road markers, the
// grave headstones and the pavilion plaque, so all of them render with ONE material (props-stone.js).
//
//   const atlas = buildCarveAtlas()   → { carve, normal, region(name) → {u0, v0, u1, v1}, uv(name, u, v, out) }
//     carve  DataTexture RGBA8 linear: R surface height (1 = face, 0 = deepest carve), G paint (red pigment on stone /
//            gold on the plaque), B painted-wood board mask, A weathering (1 = fresh, 0 = eroded / pitted)
//     normal DataTexture RGBA8 linear: tangent-space normal (OpenGL, +v up) from a Sobel pass over R (+ stone grain)
//   Regions use a v-UP convention (v = 0 bottom row) like every three.js texture.
//
// Fonts: stele text in 魏碑 (Weibei SC) — literally "stele script" — the plaque in 隶书 (Libian SC), markers and
// headstones in 楷书 (Kaiti SC); each falls back through the list to any installed CJK serif.
import * as THREE from 'three';

const W = 2048, H = 1024;

// Region table (canvas px, top-left origin) + the physical face size they are drawn for (metres).
export const REGIONS = {
  steleFront: { x: 0, y: 0, w: 392, h: 1024 },
  steleBack: { x: 392, y: 0, w: 392, h: 1024 },
  stone: { x: 784, y: 0, w: 256, h: 1024 },          // plain weathered stone (sides, plinth, marker bodies)
  marker0: { x: 1040, y: 0, w: 124, h: 400 },
  marker1: { x: 1164, y: 0, w: 124, h: 400 },
  marker2: { x: 1288, y: 0, w: 124, h: 400 },
  marker3: { x: 1412, y: 0, w: 124, h: 400 },
  head0: { x: 1040, y: 410, w: 176, h: 290 },
  head1: { x: 1216, y: 410, w: 176, h: 290 },
  head2: { x: 1392, y: 410, w: 176, h: 290 },
  plaque: { x: 1040, y: 720, w: 480, h: 150 },
  plain2: { x: 1540, y: 0, w: 508, h: 1024 },        // more plain stone (headstone backs, cairn slabs)
};

const FONTS = {
  stele: '"Weibei SC","Weibei TC","Libian SC","Kaiti SC","STKaiti","Songti SC","STSong",serif',
  clerical: '"Libian SC","Weibei SC","Kaiti SC","STKaiti","Songti SC",serif',
  kai: '"Kaiti SC","Kaiti TC","STKaiti","KaiTi","Songti SC","STSong",serif',
};

// Inscriptions (traditional characters). Stele: 宋玉《風賦》 "風起於青萍之末" flanked by 李白《俠客行》.
const TEXT = {
  steleMain: '風起於青萍之末',
  steleRight: '縱死俠骨香',
  steleLeft: '不慚世上英',
  steleHead: '長風',
  steleDate: '歲在乙巳秋立',
  markers: ['西去陽關道', '長風驛五里', '青萍原', '風陵渡十里'],
  heads: ['無名劍客之墓', '義士之墓', '故人'],
  plaque: '長風亭',
  pool: '天地玄黃宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏閏餘成歲律呂調陽雲騰致雨露結為霜金生麗水玉出崑岡劍號巨闕珠稱夜光風塵俠客千里孤城一劍霜寒十四州',
};

// ------------------------------------------------------------------------------------------------ CPU noise
function hash(ix, iy, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, s, oct = 4) => { let t = 0, a = 0.5, n = 0; for (let o = 0; o < oct; o++) { t += a * vnoise(x, y, s + o * 31); n += a; x *= 2.03; y *= 2.03; a *= 0.5; } return t / n; };

// ------------------------------------------------------------------------------------------------ drawing
function canvas(w, h) {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

/** Vertical column of characters centred at (cx, y0..y1) in canvas px. */
function column(ctx, chars, cx, y0, y1, size, font, jitter = 0, rng = Math.random) {
  const n = [...chars].length, step = (y1 - y0) / n;
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [...chars].forEach((ch, i) => {
    ctx.save();
    ctx.translate(cx + (rng() - 0.5) * jitter, y0 + step * (i + 0.5));
    ctx.rotate((rng() - 0.5) * jitter * 0.004);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
}

function drawInscriptions(mask, paint, wood) {
  const R = REGIONS;
  let seed = 9;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  mask.fillStyle = '#fff'; paint.fillStyle = '#fff'; wood.fillStyle = '#fff';
  mask.strokeStyle = '#fff';

  // --- stele front: main column (red pigment), flanking couplet, arch header, date, carved border
  {
    const r = R.steleFront, cx = r.x + r.w / 2;
    mask.lineWidth = 3;
    mask.strokeRect(r.x + 22, r.y + 150, r.w - 44, r.h - 190);                    // incised frame
    mask.lineWidth = 1.5;
    mask.strokeRect(r.x + 30, r.y + 158, r.w - 60, r.h - 206);
    // header cartouche in the arch
    mask.lineWidth = 2.5;
    mask.beginPath(); mask.ellipse(cx, r.y + 88, 62, 40, 0, 0, Math.PI * 2); mask.stroke();
    mask.font = `44px ${FONTS.stele}`; mask.textAlign = 'center'; mask.textBaseline = 'middle';
    mask.fillText(TEXT.steleHead[0], cx - 22, r.y + 88); mask.fillText(TEXT.steleHead[1], cx + 22, r.y + 88);
    column(mask, TEXT.steleMain, cx, r.y + 190, r.y + 900, 96, FONTS.stele, 2, rng);
    column(paint, TEXT.steleMain, cx, r.y + 190, r.y + 900, 96, FONTS.stele, 2, () => 0.5);
    column(mask, TEXT.steleRight, cx + 118, r.y + 200, r.y + 640, 58, FONTS.stele, 1.5, rng);
    column(mask, TEXT.steleLeft, cx - 118, r.y + 200, r.y + 640, 58, FONTS.stele, 1.5, rng);
    column(mask, TEXT.steleDate, cx - 124, r.y + 700, r.y + 930, 30, FONTS.kai, 1, rng);
  }
  // --- stele back: a dense, heavily weathered record (9 columns)
  {
    const r = R.steleBack, pool = [...TEXT.pool];
    mask.lineWidth = 2.5;
    mask.strokeRect(r.x + 24, r.y + 150, r.w - 48, r.h - 192);
    for (let c = 0; c < 9; c++) {
      let s = '';
      const n = 14 + ((rng() * 4) | 0);
      for (let i = 0; i < n; i++) s += pool[(rng() * pool.length) | 0];
      column(mask, s, r.x + r.w - 58 - c * 34, r.y + 176, r.y + 176 + n * 44, 32, FONTS.stele, 1, rng);
    }
  }
  // --- road markers: one column each, framed
  TEXT.markers.forEach((t, i) => {
    const r = R['marker' + i], cx = r.x + r.w / 2;
    mask.lineWidth = 2; mask.strokeRect(r.x + 10, r.y + 16, r.w - 20, r.h - 30);
    const n = [...t].length;
    column(mask, t, cx, r.y + 34, r.y + 34 + Math.min(r.h - 70, n * 70), Math.min(58, (r.h - 70) / n * 0.9), FONTS.kai, 1.5, rng);
  });
  // --- headstones
  TEXT.heads.forEach((t, i) => {
    const r = R['head' + i], cx = r.x + r.w / 2, n = [...t].length;
    const sz = Math.min(52, (r.h - 60) / n * 0.92);
    column(mask, t, cx, r.y + 40, r.y + 40 + n * sz * 1.08, sz, FONTS.kai, 1.2, rng);
  });
  // --- plaque: gilded clerical script on a dark lacquer board with a raised frame
  {
    const r = R.plaque;
    wood.fillRect(r.x, r.y, r.w, r.h);
    mask.lineWidth = 6; mask.strokeRect(r.x + 8, r.y + 8, r.w - 16, r.h - 16);
    mask.font = `104px ${FONTS.clerical}`; mask.textAlign = 'center'; mask.textBaseline = 'middle';
    paint.font = mask.font; paint.textAlign = 'center'; paint.textBaseline = 'middle';
    [...TEXT.plaque].forEach((ch, i) => {
      const x = r.x + r.w * (0.2 + 0.3 * i), y = r.y + r.h * 0.53;
      mask.fillText(ch, x, y); paint.fillText(ch, x, y);
    });
    paint.lineWidth = 5; paint.strokeStyle = '#fff'; paint.strokeRect(r.x + 8, r.y + 8, r.w - 16, r.h - 16);
  }
}

// ------------------------------------------------------------------------------------------------ build
let ATLAS = null;

export function buildCarveAtlas() {
  if (ATLAS) return ATLAS;
  const cm = canvas(W, H), cp = canvas(W, H), cw = canvas(W, H), cb = canvas(W, H);
  const mask = cm.getContext('2d', { willReadFrequently: true }), paint = cp.getContext('2d', { willReadFrequently: true });
  const wood = cw.getContext('2d', { willReadFrequently: true }), blur = cb.getContext('2d', { willReadFrequently: true });
  for (const c of [mask, paint, wood, blur]) { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
  drawInscriptions(mask, paint, wood);
  // V-cut profile: sharp mask + a blurred copy (deeper along the stroke centre)
  blur.filter = 'blur(2.5px)'; blur.drawImage(cm, 0, 0); blur.filter = 'none';
  const M = mask.getImageData(0, 0, W, H).data, B = blur.getImageData(0, 0, W, H).data;
  const Pn = paint.getImageData(0, 0, W, H).data, Wd = wood.getImageData(0, 0, W, H).data;

  const regionOf = new Uint8Array(W * H);   // 1 stele back (heavy erosion), 2 plaque, 3 plain stone
  const R = REGIONS;
  const mark = (r, v) => { for (let y = r.y; y < r.y + r.h; y++) regionOf.fill(v, y * W + r.x, y * W + r.x + r.w); };
  mark(R.steleBack, 1); mark(R.plaque, 2); mark(R.stone, 3); mark(R.plain2, 3);

  // height (flipped so row 0 = v 0), weathering, paint
  const hgt = new Float32Array(W * H);
  const carve = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const fy = H - 1 - y;                                   // canvas row → texture row
    for (let x = 0; x < W; x++) {
      const k = y * W + x, reg = regionOf[k];
      const sharp = M[k * 4] / 255, soft = B[k * 4] / 255;
      // erosion: large soft patches where the carving has weathered away (strong on the stele back)
      const er = fbm(x * 0.012, y * 0.012, 3, 3);
      const erosion = reg === 1 ? 0.25 + 0.75 * Math.min(1, Math.max(0, (er - 0.38) * 3.2)) : 0.72 + 0.28 * Math.min(1, Math.max(0, (er - 0.3) * 3));
      let depth = Math.min(1, sharp * 0.45 + soft * 0.85) * erosion;
      if (reg === 2) depth *= 0.5;                          // the plaque is shallow-carved, then gilded
      // stone grain + pitting (lichen pits, frost spalls)
      const grain = (vnoise(x * 0.35, y * 0.35, 7) - 0.5) * 0.05 + (vnoise(x * 0.09, y * 0.09, 8) - 0.5) * 0.06;
      const pitN = vnoise(x * 0.22, y * 0.22, 11);
      const pit = pitN > 0.86 ? (pitN - 0.86) * 3.5 : 0;
      const spall = Math.max(0, fbm(x * 0.02, y * 0.02, 19, 3) - 0.66) * 1.4;
      const h = 1 - depth - pit * 0.6 - spall * (reg === 2 ? 0.1 : 0.5) + (reg === 2 ? 0 : grain);
      hgt[fy * W + x] = h;
      const o = (fy * W + x) * 4;
      carve[o] = Math.max(0, Math.min(255, h * 230 + 20));
      const paintWorn = reg === 2 ? 0.85 : 0.75 * Math.min(1, Math.max(0, (vnoise(x * 0.05, y * 0.05, 23) - 0.25) * 2.2));
      carve[o + 1] = Math.min(255, (Pn[k * 4] / 255) * paintWorn * 255);
      carve[o + 2] = Wd[k * 4];
      carve[o + 3] = Math.max(0, Math.min(255, (1 - pit * 2 - spall * 1.5 - (1 - erosion) * 0.3) * 255));
    }
  }
  // Sobel normal (OpenGL convention, +v up); stone relief strength ~ 3.5 mm per unit height
  const nrm = new Uint8Array(W * H * 4);
  const hs = (x, y) => hgt[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const str = 2.6;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (hs(x + 1, y - 1) + 2 * hs(x + 1, y) + hs(x + 1, y + 1)) - (hs(x - 1, y - 1) + 2 * hs(x - 1, y) + hs(x - 1, y + 1));
    const dy = (hs(x - 1, y + 1) + 2 * hs(x, y + 1) + hs(x + 1, y + 1)) - (hs(x - 1, y - 1) + 2 * hs(x, y - 1) + hs(x + 1, y - 1));
    let nx = -dx * str, ny = -dy * str;
    const il = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    const o = (y * W + x) * 4;
    nrm[o] = (nx * il * 0.5 + 0.5) * 255; nrm[o + 1] = (ny * il * 0.5 + 0.5) * 255; nrm[o + 2] = (il * 0.5 + 0.5) * 255; nrm[o + 3] = 255;
  }
  const tex = (data) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true; t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  const region = (name) => {
    const r = REGIONS[name];
    return { u0: r.x / W, u1: (r.x + r.w) / W, v0: 1 - (r.y + r.h) / H, v1: 1 - r.y / H };
  };
  ATLAS = {
    carve: tex(carve), normal: tex(nrm), region,
    /** local (u right, v up) in [0,1] → atlas uv (inset half a texel against bleeding) */
    uv(name, u, v, out = new THREE.Vector2()) {
      const r = region(name), e = 0.5 / W;
      return out.set(r.u0 + e + (r.u1 - r.u0 - 2 * e) * u, r.v0 + e + (r.v1 - r.v0 - 2 * e) * v);
    },
  };
  return ATLAS;
}
