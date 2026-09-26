// Tiny Web Worker pool for the terrain build (grid rows + world bakes run in parallel bands). Owner: world (W).
//   const pool = createPool()        // null when workers are unavailable
//   await pool.run(msg, transfer?)   // resolves with the worker's reply data
//   pool.size / pool.close()
import { LAYOUT } from './layout.js';

export function createPool(max = 6) {
  if (typeof Worker === 'undefined') return null;
  const n = Math.max(1, Math.min(max, ((globalThis.navigator?.hardwareConcurrency) || 4) - 2));
  if (n <= 1) return null;
  const workers = [], idle = [], queue = [];
  let failed = false;
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
    w._job = null;
    w.onmessage = (e) => { const j = w._job; w._job = null; idle.push(w); pump(); if (e.data?.error) j.reject(new Error(e.data.error)); else j.resolve(e.data); };
    w.onerror = (e) => { failed = true; const j = w._job; w._job = null; j?.reject(e.error || new Error(e.message || 'worker error')); };
    workers.push(w); idle.push(w);
  }
  function pump() {
    while (idle.length && queue.length) { const w = idle.pop(), j = queue.shift(); w._job = j; w.postMessage(j.msg, j.transfer || []); }
  }
  return {
    size: n,
    run(msg, transfer) {
      if (failed) return Promise.reject(new Error('worker pool failed'));
      msg.level = LAYOUT.levelId;   // the worker's layout.js cannot see the page's ?level=
      return new Promise((resolve, reject) => { queue.push({ msg, transfer, resolve, reject }); pump(); });
    },
    close() { for (const w of workers) w.terminate(); },
  };
}
