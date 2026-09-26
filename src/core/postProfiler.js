// Per-pass GPU timings (bible §8.3 #18: window.__perf.gpu). Owner: post-processing (R). Used only by core/pipeline.js.
//   const prof = new GPUProfiler(renderer)
//   prof.mode = 'off' | 'query' | 'sync'
//     'query' — EXT_disjoint_timer_query_webgl2 (async, no stalls; ANGLE-Metal reports inflated numbers when the GPU
//               is shared, so treat them as relative)
//     'sync'  — gl.finish() around every section and CPU wall time (stalls the pipeline: profiling runs only)
//   prof.begin('opaque') … prof.begin('copy') … prof.end()   — sequential, non-nested sections
//   prof.frame()   — once per frame: collects finished results into prof.ms (exponential average, ms)
export class GPUProfiler {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null;
    this.mode = 'off';
    this.ms = {};            // name → smoothed ms
    this.samples = {};       // name → recent raw samples (sync mode), for medians
    this.total = 0;
    this._pool = [];
    this._pending = [];      // [{name, q}]
    this._active = null;
    this._t0 = 0;
  }

  begin(name) {
    if (this.mode === 'off') return;
    if (this._active) this.end();
    if (this.mode === 'sync') {
      this.gl.finish();
      this._t0 = performance.now();
      this._active = { name };
      return;
    }
    if (!this.ext) return;
    const q = this._pool.pop() || this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._active = { name, q };
  }

  end() {
    const a = this._active;
    if (!a) return;
    this._active = null;
    if (this.mode === 'sync' || !a.q) {
      this.gl.finish();
      this._record(a.name, performance.now() - this._t0);
      return;
    }
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._pending.push(a);
  }

  frame() {
    if (this._active) this.end();
    if (this.ext && this._pending.length) {
      const gl = this.gl;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      let i = 0;
      for (; i < this._pending.length; i++) {
        const p = this._pending[i];
        if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
        if (!disjoint) this._record(p.name, gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6);
        this._pool.push(p.q);
      }
      if (i) this._pending.splice(0, i);
      if (this._pending.length > 256) { for (const p of this._pending) this._pool.push(p.q); this._pending.length = 0; }
    }
    let t = 0; for (const k in this.ms) t += this.ms[k];
    this.total = t;
  }

  _record(name, ms) {
    this.ms[name] = this.ms[name] === undefined ? ms : this.ms[name] * 0.9 + ms * 0.1;
    const s = (this.samples[name] ??= []);
    s.push(ms); if (s.length > 120) s.shift();
  }

  /** Rounded snapshot, e.g. for window.__perf.gpu */
  snapshot() {
    const o = {};
    for (const k in this.ms) o[k] = +this.ms[k].toFixed(3);
    return o;
  }

  /** Median of the recent raw samples per section (robust against a shared, noisy GPU). */
  medians() {
    const o = {};
    let t = 0;
    for (const k in this.samples) {
      const s = [...this.samples[k]].sort((a, b) => a - b);
      o[k] = +s[s.length >> 1].toFixed(3); t += o[k];
    }
    o.total = +t.toFixed(3);
    return o;
  }

  reset() { this.ms = {}; this.samples = {}; }
}
