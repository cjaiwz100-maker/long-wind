// Procedural ink-brush textures for the HUD (canvas 2D, generated once at start-up, then used as CSS masks).
// A real brush is a bundle of bristles that each carry a little ink: where the stroke is loaded they merge into a
// solid body, where the ink runs out they separate into dry streaks (飞白). The paper then bleeds (洇) a soft halo
// around the edges and its fibres break the fill. Everything is seeded, so every run paints the same strokes.
//
// Model: a stroke is a spine s ∈ [0,1] with separate top/bottom half-widths (so a pressed head can be slanted). Every
// pixel maps to (s, u), u ∈ [-1,1] across the brush, and an ink field decides coverage: a wet body with fibrous
// edges, dry streaks (anisotropic noise, long along s) that open toward the tail and the outer hairs, and rim
// pooling. Evaluated per pixel: resolution-exact, seeded, no bitmaps.
// Owner: UI (U).
//   strokeTex({ w, h, seed, dry, taper, rise, end })  — horizontal 横: pressed head (藏锋), body, dry tail or pressed stop
//   ensoTex({ size, seed, sweep, start })       — circular ensō that never closes
//   splatTex({ size, seed })                    — ink splash with thrown droplets
//   washTex({ w, h, seed, rim })                — soft ink wash with a faint water-stain rim
//   sealTex({ text, w, h, seed, white })        — vermilion seal stamp, carved and worn (needs fonts loaded)
//   toURL(canvas) → Promise<string>             — blob URL for CSS `mask-image` / `background-image`
import { mulberry32, createNoise } from '../core/noise.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ---- the ink field -------------------------------------------------------------------------------------------
// A stroke is parameterised by s ∈ [0,1] along the spine and u ∈ [-1,1] across it (already divided by the local
// half-width of that side). `inkField` returns coverage(s, u, x, y): a wet body with paper-fibre edges, 飞白 streaks
// that open up toward the dry tail and along the edges (anisotropic noise: long along s, fine across u), and a tone
// that darkens where wet ink pools at the rim.
function inkField({ seed = 1, dry = 0.45, dryStart = 0.45, hairs = 22, streak = 2.6, fibre = 0.06, pool = 0.08 }) {
  const nz = createNoise(seed * 31 + 7), fz = createNoise(seed * 17 + 3);
  const off = seed * 13.7;
  return function cover(s, u, x, y) {
    const au = Math.abs(u);
    // paper fibres make the rim ragged at two scales; the coarse one also varies along the stroke
    const edge = 1 + fibre * (0.65 * fz.simplex2(x * 0.42, y * 0.42) + 0.35 * fz.simplex2(x * 0.09 + 3.1, y * 0.09)) + 0.035 * nz.simplex2(s * 9 + off, u > 0 ? 1.7 : 5.3);
    if (au > edge + 0.04) return 0;
    let a = 1 - smooth(edge - 0.07, edge + 0.03, au);
    // dry brush: the load runs out toward the tail and the outer hairs dry first
    const d = dry * (0.1 + smooth(dryStart * 0.55, 1.0, s) * 0.95 + 0.5 * au * au * au) + dry * 0.1 * nz.simplex2(s * 3 + off, 9.1);
    if (d > 0.03) {
      // streak noise: long along the stroke, fine across it, with a clumping octave so gaps span groups of hairs
      const st = 0.52 * nz.simplex2(u * hairs + off, s * streak) + 0.26 * nz.simplex2(u * hairs * 2.7 - off, s * streak * 0.8 + 4.2)
        + 0.22 * nz.simplex2(u * hairs * 0.35 + 5.5, s * streak * 0.5 - off);
      a *= smooth(d - 0.07, d + 0.05, st * 0.62 + 0.5);
    }
    // tone: rim pooling (wet edge darkening) + a soft mottle; dry streaks carry less ink
    const tone = 0.88 + pool * smooth(0.62, 0.97, au) + 0.05 * nz.simplex2(s * 5 + off, u * 1.3) - 0.1 * smooth(0.35, 1, d);
    return a * Math.min(1, tone);
  };
}

// circular ease used for rounded caps: 0 → 1 with a vertical tangent at 0
const circ = (q) => (q <= 0 ? 0 : q >= 1 ? 1 : Math.sqrt(1 - (1 - q) * (1 - q)));

// Cheap paper grain (hash), multiplied into alpha so flat ink still has tooth.
function grainAt(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Soft bleed halo under the ink (洇): blurred copy drawn behind at partial alpha.
function bleed(c, px, k = 0.5) {
  if (px <= 0) return c;
  const b = canvas(c.width, c.height), bx = b.getContext('2d');
  bx.filter = `blur(${px}px)`;
  bx.drawImage(c, 0, 0);
  const ctx = c.getContext('2d');
  ctx.globalCompositeOperation = 'destination-over';
  ctx.globalAlpha = k;
  ctx.drawImage(b, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * Horizontal brush stroke (a 横), white on transparent. The head is pressed in at an angle (藏锋): the top edge
 * starts first and rises into a shoulder, the lower-left corner is cut on a slant. The body breathes slightly.
 * end 'fly': the brush lifts and the tail breaks into dry streaks (飞白). end 'press': a pressed stop (回锋) that
 * bulges to the lower right. dry: 0 wet … 1 very dry. taper: tail width fraction. rise: tail lift (fraction of h).
 * thick: half-width / h. swell: waist amount. Legacy options (core, N, streak) are accepted and ignored.
 */
export function strokeTex({ w = 1024, h = 128, seed = 1, dry = 0.45, taper = 0.2, rise = 0.1, thick = 0.3, swell = 0.08, end = 'fly', dryStart = null, hairs = null } = {}) {
  const c = canvas(w, h), ctx = c.getContext('2d');
  const nz = createNoise(seed * 5 + 1);
  const H = h * thick, x0 = Math.max(2, H * 0.25), x1 = w - (end === 'press' ? H * 0.4 : 2), len = x1 - x0;
  const sh = (H * 1.7) / len, se = (H * 1.5) / len;         // head / pressed-end lengths in s
  const field = inkField({ seed, dry, dryStart: dryStart ?? (end === 'press' ? 0.8 : 0.42), hairs: hairs ?? Math.max(10, Math.min(30, H * 0.9)), streak: 2.4 });
  const bins = Math.ceil(len) + 1;
  const CY = new Float32Array(bins), T = new Float32Array(bins), Bt = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const s = b / (bins - 1);
    const n1 = nz.simplex2(s * 3.2, 0.5), n2 = nz.simplex2(s * 7.5, 2.5);
    const body = 1 + 0.035 * n1 + 0.02 * n2 - swell * Math.exp(-Math.pow((s - 0.45) / 0.22, 2));
    // head: top edge first (with a shoulder), bottom edge later → the slanted entry of a pressed brush
    let top = circ(s / (0.85 * sh)) * (1 + 0.1 * Math.exp(-Math.pow((s - 1.05 * sh) / (0.6 * sh), 2)));
    let bot = circ((s - 0.12 * sh) / (1.05 * sh)) * (1 + 0.05 * Math.exp(-Math.pow((s - 1.4 * sh) / (0.7 * sh), 2)));
    let cy = h * 0.5 - H * 0.1 * (1 - smooth(0, 2.2 * sh, s)) + nz.simplex2(s * 1.4, 7.7) * h * 0.02;
    if (end === 'press') {
      const q = (1 - s) / se;                                  // 1 → 0 across the pressed end
      const bulge = Math.exp(-Math.pow((q - 0.55) / 0.45, 2));
      top *= circ(q / 0.45) * (1 - 0.06 * bulge);
      bot *= circ(q / 0.6) * (1 + 0.2 * bulge);
      cy += H * 0.08 * bulge;
    } else {
      const k = 1 - (1 - taper) * Math.pow(smooth(0.5, 1.0, s), 1.25);
      top *= k; bot *= k;
      cy -= Math.pow(smooth(0.55, 1, s), 2) * h * rise;
    }
    CY[b] = cy; T[b] = Math.max(0.01, H * top * body); Bt[b] = Math.max(0.01, H * bot * body);
  }
  const img = ctx.createImageData(w, h), d = img.data;
  for (let x = 0; x < w; x++) {
    const b = Math.round(x - x0);
    if (b < 0 || b >= bins) continue;
    const s = b / (bins - 1), cy = CY[b], tp = T[b], bt = Bt[b];
    const yA = Math.max(0, Math.floor(cy - tp * 1.2)), yB = Math.min(h - 1, Math.ceil(cy + bt * 1.2));
    for (let y = yA; y <= yB; y++) {
      const dy = y + 0.5 - cy, u = dy < 0 ? dy / tp : dy / bt;
      let a = field(s, u, x, y);
      if (a <= 0.004) continue;
      a *= 0.93 + 0.07 * grainAt(x, y, seed);
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return bleed(c, Math.max(0.8, h / 110), 0.35);
}

/** Ensō: one circular stroke that starts pressed and heavy, and runs dry before it closes. start in radians (canvas angle). */
export function ensoTex({ size = 256, seed = 3, sweep = 0.9, start = -2.2, thick = 0.07, dry = 0.55 } = {}) {
  const c = canvas(size, size), ctx = c.getContext('2d');
  const nz = createNoise(seed * 11 + 2);
  const cx = size / 2, cy = size / 2, R = size * 0.38, H = size * thick;
  const bins = Math.ceil(R * Math.PI * 2 * sweep);
  const field = inkField({ seed, dry, dryStart: 0.35, hairs: Math.max(8, H * 0.8), streak: 3.2 });
  const RR = new Float32Array(bins), IN = new Float32Array(bins), OUT = new Float32Array(bins);
  const sh = (H * 1.6) / bins;
  for (let b = 0; b < bins; b++) {
    const s = b / (bins - 1);
    RR[b] = R * (1 + 0.03 * nz.simplex2(s * 2.2, 1.7) - 0.04 * s);
    const body = (1 + 0.08 * nz.simplex2(s * 6, 4)) * (1 - 0.72 * Math.pow(smooth(0.3, 1, s), 1.2));
    OUT[b] = H * Math.max(0.03, circ(s / (0.55 * sh)) * (1 + 0.18 * Math.exp(-Math.pow((s - sh) / sh, 2))) * body);
    IN[b] = H * Math.max(0.03, circ((s - 0.2 * sh) / sh) * body);
  }
  const img = ctx.createImageData(size, size), d = img.data;
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      let ang = Math.atan2(dy, dx) - start;
      ang = ((ang % TAU) + TAU) % TAU;
      const s = ang / (TAU * sweep);
      if (s > 1) continue;
      const b = Math.min(bins - 1, Math.round(s * (bins - 1)));
      const dr = Math.hypot(dx, dy) - RR[b], u = dr > 0 ? dr / OUT[b] : dr / IN[b];
      if (u < -1.2 || u > 1.2) continue;
      let a = field(s, u, x, y);
      if (a <= 0.004) continue;
      a *= 0.93 + 0.07 * grainAt(x, y, seed);
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return bleed(c, Math.max(0.8, size / 220), 0.35);
}

/** Ink splash: a noisy blob, thrown droplets and a few streaks. */
export function splatTex({ size = 256, seed = 5, droplets = 22 } = {}) {
  const c = canvas(size, size), ctx = c.getContext('2d');
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  const rng = mulberry32(seed * 97 + 1), nz = createNoise(seed * 13 + 5);
  const cx = size / 2, cy = size / 2, R = size * 0.18;
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    const r = R * (0.7 + 0.3 * nz.fbm2(Math.cos(a) * 1.4, Math.sin(a) * 1.4, 3) + 0.35 * Math.pow(Math.max(0, nz.simplex2(Math.cos(a) * 3.5, Math.sin(a) * 3.5)), 3));
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.globalAlpha = 0.9; ctx.fill();
  const dir = rng() * Math.PI * 2;
  for (let k = 0; k < droplets; k++) {
    const a = dir + (rng() - 0.5) * (k < droplets * 0.65 ? 1.4 : 6.2);
    const dd = R * (1.05 + Math.pow(rng(), 0.7) * 1.6);
    const r = size * (0.005 + 0.028 * Math.pow(rng(), 2.2)) * Math.max(0.25, 1.4 - dd / (R * 2.8));
    const x = cx + Math.cos(a) * dd, y = cy + Math.sin(a) * dd;
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.6, r * 1.35), Math.max(0.6, r), a, 0, Math.PI * 2); ctx.fill();
    if (rng() < 0.35) {
      ctx.globalAlpha = 0.45; ctx.lineWidth = Math.max(0.6, r * 0.6);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  return bleed(c, size / 120, 0.5);
}

/** Soft ink wash (淡墨) with a faint water-stain rim. Computed at low resolution: it is always shown blurred. */
export function washTex({ w = 256, h = 128, seed = 9, rim = 0.3, soft = 0.5 } = {}) {
  const c = canvas(w, h), ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h), d = img.data;
  const nz = createNoise(seed * 19 + 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x / w) * 2 - 1, v = (y / h) * 2 - 1;
      const n = nz.fbm2(x / w * 3.2, y / h * 2.4, 3);
      const r = Math.sqrt(u * u + v * v) + n * 0.3;
      const body = 1 - smooth(0.35 - soft * 0.3, 0.9, r);
      const edge = Math.exp(-Math.pow((r - 0.78) / 0.06, 2)) * rim;
      const cloud = 0.74 + 0.26 * nz.simplex2(x / w * 8, y / h * 6);
      const a = Math.min(1, body * cloud + edge * body * 2);
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Vermilion seal (印). white = 白文 (characters carved out of the red), else 朱文 (red characters in a red frame).
 * Characters stack top-to-bottom; more than 2 characters use two columns read right-to-left.
 */
export function sealTex({ text = '长风', w, h, seed = 2, white = true, color = '#b8322a', font = '"Noto Serif SC", serif', weight = 900 } = {}) {
  const chars = [...text];
  const cols = chars.length <= 2 ? 1 : 2, rows = Math.ceil(chars.length / cols);
  h = h ?? 192; w = w ?? Math.round(h * (cols === 1 && rows === 2 ? 0.62 : 1));
  const c = canvas(w, h), ctx = c.getContext('2d');
  const rng = mulberry32(seed * 31 + 9), nz = createNoise(seed * 7 + 1);
  const m = Math.min(w, h) * 0.06, SW = w - 2 * m, SH = h - 2 * m;
  ctx.fillStyle = ctx.strokeStyle = color;
  ctx.beginPath();
  const P = 36, per = 2 * (SW + SH);
  for (let i = 0; i < P * 4; i++) {
    let t = (i / (P * 4)) * per, x, y;
    if (t < SW) { x = m + t; y = m; } else if ((t -= SW) < SH) { x = m + SW; y = m + t; }
    else if ((t -= SH) < SW) { x = m + SW - t; y = m + SH; } else { t -= SW; x = m; y = m + SH - t; }
    const j = nz.simplex2(i * 0.4, 1) * Math.min(w, h) * 0.01;
    i ? ctx.lineTo(x + j, y - j * 0.7) : ctx.moveTo(x + j, y - j * 0.7);
  }
  ctx.closePath();
  if (white) ctx.fill(); else { ctx.lineWidth = Math.min(w, h) * 0.06; ctx.stroke(); }
  const pad = white ? 0.1 : 0.14;
  const cw = SW / cols, rh = SH / rows;
  const fs = Math.min(cw * (1 - pad), rh * (1 - pad) * 1.05);
  ctx.font = `${weight} ${fs}px ${font}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.globalCompositeOperation = white ? 'destination-out' : 'source-over';
  chars.forEach((ch, k) => {
    const col = cols - 1 - Math.floor(k / rows), row = k % rows;
    const x = m + cw * (col + 0.5), y = m + rh * (row + 0.5) + fs * 0.03;
    ctx.save(); ctx.translate(x, y);
    ctx.scale((cw * (1 - pad)) / fs, (rh * (1 - pad)) / fs);
    ctx.fillText(ch, 0, 0); ctx.restore();
  });
  ctx.globalCompositeOperation = 'source-over';
  // wear: uneven paste pressure, pits and speckles where the paste didn't take
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (!d[i]) continue;
      const press = 0.8 + 0.2 * nz.simplex2(x / w * 3, y / h * 3);
      const pit = nz.simplex2(x * 0.11, y * 0.11) > 0.74 ? 0.2 : 1;
      const spk = rng() < 0.01 ? 0.25 : 1;
      d[i] = Math.round(d[i] * Math.min(1, press * pit * spk * 1.1));
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Canvas → blob URL (async PNG encode). */
export function toURL(c) {
  return new Promise((resolve) => {
    if (c.toBlob) c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : c.toDataURL()), 'image/png');
    else resolve(c.toDataURL());
  });
}
