// Worker for terrain-pool.js: evaluates terrain-grid rows or world-bake bands off the main thread. Owner: world (W).
import { gridRows, setGrid, hasGrid } from './terrain-field.js';
import { bakeBand } from './terrain-bake.js';
import { LAYOUT, applyLevelLayout } from './layout.js';

self.onmessage = (e) => {
  try {
    const m = e.data;
    if (m.level && m.level !== LAYOUT.levelId) applyLevelLayout(m.level);
    if (m.type === 'bake') {
      if (!hasGrid()) setGrid(m.xs, m.H);
      const b = bakeBand({ j0: m.j0, j1: m.j1, plan: m.plan });
      self.postMessage(b, [b.height.buffer, b.splat.buffer, b.ground.buffer, b.aux.buffer]);
    } else {
      const rows = gridRows(m.j0, m.j1);
      self.postMessage({ rows }, [rows.buffer]);
    }
  } catch (err) {
    self.postMessage({ error: String(err?.stack || err) });
  }
};
