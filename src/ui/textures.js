// Builds every HUD brush texture once and publishes them as CSS custom properties (--t-*) on the HUD root, plus
// seal images. Work is spread over macrotasks so the loader / first frames never stall on a long block.
// Owner: UI (U).
import { strokeTex, ensoTex, splatTex, washTex, sealTex, toURL } from './brush.js';
import { createNoise } from '../core/noise.js';

const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Ink vignette mask: dark ink creeping in from the frame edges in tendrils.
function edgeTex(w = 320, h = 180, seed = 21) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
  const nz = createNoise(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = Math.min(x / w * (w / h), (w - x) / w * (w / h), y / h, (h - y) / h);
      const n = nz.fbm2(x / w * 5, y / h * 3, 4);
      const a = 1 - smooth(0.02, 0.3 + 0.16 * n, e + 0.05 * nz.simplex2(x * 0.05, y * 0.05));
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Generate textures, set CSS vars on `root`, return { seals: { name: url } }.
 * Fonts are awaited (with a timeout) before seals are carved so the characters are right.
 */
export async function buildTextures(root) {
  const set = async (name, canvas) => { root.style.setProperty(name, `url("${await toURL(canvas)}")`); await tick(); };
  await set('--t-stroke', strokeTex({ w: 1024, h: 120, seed: 1, dry: 0.45, thick: 0.32, taper: 0.14, core: 0.64, swell: 0.22 }));
  await set('--t-wash', washTex({ w: 256, h: 128, seed: 9, rim: 0.25 }));
  await set('--t-enso', ensoTex({ size: 256, seed: 3, sweep: 0.9, start: -2.2, thick: 0.07 }));
  await set('--t-thin', strokeTex({ w: 512, h: 48, seed: 4, dry: 0.5, thick: 0.28, taper: 0.1, N: 60 }));
  await set('--t-stroke2', strokeTex({ w: 1400, h: 96, seed: 2, dry: 0.62, thick: 0.3, taper: 0.12, rise: 0.05, core: 0.45 }));
  await set('--t-enso2', ensoTex({ size: 192, seed: 8, sweep: 0.86, start: -1.4, thick: 0.06, dry: 0.65 }));
  await set('--t-stroke3', strokeTex({ w: 1024, h: 128, seed: 7, dry: 0.62, thick: 0.3, taper: 0.1, rise: 0.14 }));
  await set('--t-tick', strokeTex({ w: 512, h: 128, seed: 11, dry: 0.55, thick: 0.2, taper: 0.04, rise: 0.25, N: 60 }));
  await set('--t-splat', splatTex({ size: 256, seed: 5 }));
  await set('--t-splat2', splatTex({ size: 256, seed: 12, droplets: 30 }));
  await set('--t-edge', edgeTex());

  const seals = {};
  try {
    await Promise.race([
      Promise.all([document.fonts.load('900 64px "Noto Serif SC"', '长风剑破侠胜败歇'), document.fonts.load('64px "Ma Shan Zheng"', '长风')]),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch { /* fonts are optional: fall back to system serif */ }
  const mk = async (key, opts) => { seals[key] = await toURL(sealTex(opts)); await tick(); };
  await mk('title', { text: '长风', h: 160, seed: 2 });
  await mk('sword', { text: '剑', h: 96, w: 96, seed: 5 });
  await mk('parry', { text: '破', h: 96, w: 96, seed: 6, white: false });
  await mk('xia', { text: '侠客', h: 150, seed: 8 });
  await mk('fall', { text: '易水', h: 150, seed: 9, white: false });
  await mk('rest', { text: '歇', h: 96, w: 96, seed: 10 });
  return { seals };
}
