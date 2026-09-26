// Virtual point lights (bible §3.3): up to 8 shader-evaluated lamps (spark flashes, torches, qi glow) packed into
// G.uLamps / G.uLampC each frame. The shader side (lights_fragment_end loop) is implemented by the lighting owner (S).
// Owner: integrator. STABLE API:
//   const h = lamps.add({ pos?: Vector3, get?: () => Vector3, color: [r,g,b] (linear HDR), weight = 1, flicker = 0, ttl = Infinity, decay = 0 })
//   h.remove(); h.color / h.weight are live-editable
//   lamps.flash(pos, color, weight, seconds)  — convenience: short-lived lamp that decays to 0 (sparks, parries)
//   lamps.update(dt, camPos)                   — picks the 8 most relevant lamps (weight / distance) and writes G
import * as THREE from 'three';
import { G, MAX_LAMPS } from './globals.js';

const list = new Set();
const _p = new THREE.Vector3();

export const lamps = {
  add({ pos, get, color = [1, 0.6, 0.3], weight = 1, flicker = 0, ttl = Infinity, decay = 0 } = {}) {
    const h = { pos: pos ? pos.clone() : new THREE.Vector3(), get, color: new THREE.Color(...color), weight, flicker, ttl, age: 0, decay, w0: weight,
      remove() { list.delete(h); } };
    list.add(h);
    return h;
  },
  flash(pos, color = [1, 0.6, 0.25], weight = 6, seconds = 0.18) {
    return this.add({ pos, color, weight, ttl: seconds, decay: 1 });
  },
  update(dt, camPos) {
    const ranked = [];
    for (const h of list) {
      h.age += dt;
      if (h.age >= h.ttl) { list.delete(h); continue; }
      if (h.get) h.pos.copy(h.get(_p));
      let w = h.w0 === undefined ? h.weight : h.weight;
      if (h.decay) { const k = 1 - h.age / h.ttl; w = h.w0 * k * k; }
      if (h.flicker) w *= 1 - h.flicker * (0.5 + 0.5 * Math.sin(h.age * 23.0 + Math.sin(h.age * 7.3) * 3.0)) * 0.6;
      const d = camPos ? h.pos.distanceTo(camPos) : 0;
      ranked.push([w / (1 + d * 0.05), h, w]);
    }
    ranked.sort((a, b) => b[0] - a[0]);
    const n = Math.min(MAX_LAMPS, ranked.length);
    for (let i = 0; i < MAX_LAMPS; i++) {
      if (i < n) { const [, h, w] = ranked[i]; G.uLamps.value[i].set(h.pos.x, h.pos.y, h.pos.z, w); G.uLampC.value[i].copy(h.color); }
      else { G.uLamps.value[i].set(0, -999, 0, 0); G.uLampC.value[i].setRGB(0, 0, 0); }
    }
    G.uLampN.value = n;
  },
};
