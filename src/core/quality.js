// Graphics quality presets (流畅 / 均衡 / 极致). Owner: core.
//   QUALITY[name] = { label, scale, minScale, grass: [L0, L1, L2], volSteps, aoSamples, bloomLevels }
//   getQuality() → 'low' | 'med' | 'high'   (URL ?q= wins, then localStorage 'wx.quality', default 'med')
//   applyQuality(app, name, { grass })       — render scale (temporal upsampling), post sample counts, grass density;
//                                              persisted; bus 'quality' { name } so the HUD can mark the choice.
// The adaptive-resolution loop in app.js moves the render scale between minScale and scale (never the output size),
// so the picture stays sharp: TAA reconstructs the full resolution from the jittered, smaller scene.
import { bus } from './bus.js';

export const QUALITY = {
  low: { label: '流畅', scale: 0.62, minScale: 0.5, grass: [0.8, 0.6, 0.45], volSteps: 8, aoSamples: 4, bloomLevels: 5 },
  med: { label: '均衡', scale: 0.8, minScale: 0.6, grass: [1.15, 0.85, 0.65], volSteps: 12, aoSamples: 6, bloomLevels: 6 },
  high: { label: '极致', scale: 1.0, minScale: 0.72, grass: [1.3, 1.05, 0.85], volSteps: 14, aoSamples: 8, bloomLevels: 6 },
};

export function getQuality() {
  try {
    const q = new URLSearchParams(location.search).get('q');
    if (q && QUALITY[q]) return q;
    const s = localStorage.getItem('wx.quality');
    if (s && QUALITY[s]) return s;
  } catch { /* storage blocked */ }
  return 'med';
}

export function applyQuality(app, name, { grass = null } = {}) {
  const Q = QUALITY[name] ?? QUALITY.med;
  app.quality = { name, ...Q };
  const p = app.pipeline;
  if (p) {
    p.params.aa = 'taa';             // every preset: TAA (switching AA later would recompile the final pass mid-play)
    p.params.volSteps = Q.volSteps;
    p.params.aoSamples = Q.aoSamples;
    p.params.bloomLevels = Q.bloomLevels;
    p.setRenderScale?.(Q.scale * (app.perf?.scale ?? 1));
  }
  const g = grass ?? app.grass;
  if (g) g.setDensity(Q.grass);
  try { localStorage.setItem('wx.quality', name); } catch { /* ignore */ }
  bus.emit('quality', { name });
  return Q;
}
