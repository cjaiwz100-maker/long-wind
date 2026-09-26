// Companion vegetation (bible §5.7): wildflowers + silver-grass plumes. Owner: vegetation (V). STABLE API:
//   const flora = await createFlora(app, opts?) → { flowers, plumes, update(dt), setDensity(k), stats() }
//     opts: { density = 1 (quality tier: 1 high, 0.6 medium, 0.4 low), flowers = true, plumes = true }
// Each part is optional and loaded defensively: a failure in one never takes the other down.
import { createFlowers } from './flowers.js';

export async function createFlora(app, opts = {}) {
  const density = opts.density ?? 1;
  let flowers = null, plumes = null;
  if (opts.flowers !== false) {
    try { flowers = createFlowers(app, { density }); } catch (e) { console.error('[flora] flowers failed', e); }
  }
  if (opts.plumes !== false) {
    try {
      const mod = await import('./plumes.js');
      plumes = await mod.createPlumes(app, { density });
    } catch (e) { console.error('[flora] plumes failed', e); }
  }
  return {
    flowers, plumes,
    update() {},
    setDensity(k) { flowers?.setDensity(k); plumes?.setDensity?.(k); },
    stats() { return { flowers: flowers?.stats(), plumes: plumes?.stats?.() }; },
  };
}
