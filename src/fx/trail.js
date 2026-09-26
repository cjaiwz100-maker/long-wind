// Sword trails (剑光), bible §6.2.1. Owner: X.
// Per swing: a ring of (base, tip, t) samples → Catmull-Rom resample over the last 0.14 s (0.2 s heavy) into SEG
// segments → one shared dynamic ribbon geometry for every trail (2 draws total):
//   1. refraction: normal-blended, samples the opaque snapshot bent across the ribbon (air being cut)
//   2. light: additive HDR edge core tinted by the sun + wispy air streaks, soft against depth, fogged (transmittance)
import * as THREE from 'three';
import { ATMOS_GLSL } from '../core/atmosphere.js';
import { FX_COMMON, FX_FRAG, fxMaterial, fxMesh } from './common.js';

const MAX_RIB = 10, SEG = 40, MAX_S = 40;
const VPR = (SEG + 1) * 2;             // vertices per ribbon
const HILT = 0.1, OVER = 1.07;          // ribbon starts 10% up the blade, overshoots the tip 7% (soft outer edge)
export const TIP_Y = 1 / OVER;

const VS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
attribute vec4 aData;     // x along (0 newest .. 1 oldest), y across (0 hilt .. 1 outer), z abs time, w alpha*intensity
varying vec4 vData; varying vec3 vWp; varying float vViewZ; varying vec3 vT;
void main() {
  vData = aData;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWp = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  vT = wx_applyAtmosphereT(vec3(1.0), wp.xyz, 0.0);      // WX_FOG_ADD: transmittance only
  gl_Position = projectionMatrix * mv;
}`;

const FS_LIGHT = /* glsl */`
#define WX_FOG_ADD
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
varying vec4 vData; varying vec3 vWp; varying float vViewZ; varying vec3 vT;
void main() {
  float x = vData.x, y = vData.y, k = vData.w;
  if (k <= 0.001) discard;
  const float yt = ${TIP_Y.toFixed(4)};
  float dy = y - yt;
  // crisp outside the tip path, softer toward the hilt; a second faint echo line inside
  float edge = exp(-dy * dy / (dy > 0.0 ? 0.00045 : 0.0022));
  float echo = exp(-pow(y - yt + 0.07, 2.0) / 0.0012) * 0.25;
  float body = smoothstep(0.0, 0.85, y) * (1.0 - smoothstep(yt - 0.01, 1.0, y));
  float along = pow(1.0 - x, 2.4);
  float head = smoothstep(0.0, 0.02, x);                   // tiny fade at the very head (no hard cap)
  // air-cut streaks: fixed in swept space (abs time along, blade position across) → thin lines parallel to the motion
  float n1 = wx_vnoise(vec2(vData.z * 7.0, y * 34.0));
  float n2 = wx_vnoise(vec2(vData.z * 19.0 + 3.1, y * 81.0));
  float streak = smoothstep(0.35, 0.95, n1 * 0.65 + n2 * 0.45);
  float wisp = body * (0.12 + 0.55 * streak) * pow(1.0 - x, 1.4);
  // break the edge up toward the tail (the arc frays into air)
  edge *= mix(1.0, 0.35 + 0.9 * n2, smoothstep(0.25, 0.9, x));
  vec3 hot = fx_hotCore();
  vec3 sun = uSunCol * 0.16 + fx_amb() * 0.4;
  vec3 c = hot * 6.0 * (edge + echo) * along + mix(sun, hot * 1.4, 0.35) * wisp;
  c *= k * head;
  c *= fx_soft(vViewZ, 0.12);
  c *= vT;
  gl_FragColor = vec4(c, 1.0);
}`;

const FS_REFRACT = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
varying vec4 vData; varying vec3 vWp; varying float vViewZ; varying vec3 vT;
void main() {
  float x = vData.x, y = vData.y, k = min(vData.w, 1.0);
  const float yt = ${TIP_Y.toFixed(4)};
  float body = smoothstep(0.05, 0.8, y) * (1.0 - smoothstep(yt - 0.02, 1.0, y));
  float along = pow(1.0 - x, 2.0);
  float a = 0.7 * along * body * k;
  if (a < 0.004) discard;
  vec2 uv = fx_screenUv();
  vec2 g = vec2(dFdx(y), dFdy(y));
  vec2 dir = g / max(length(g), 1e-6);
  float n = wx_vnoise(vec2(vData.z * 11.0, y * 40.0));
  float amt = 0.010 * along * (0.55 + 0.9 * n) * smoothstep(0.0, 0.5, y);
  vec3 c;
  c.r = texture2D(tSceneCopy, uv + dir * amt * 1.12).r;
  c.g = texture2D(tSceneCopy, uv + dir * amt).g;
  c.b = texture2D(tSceneCopy, uv + dir * amt * 0.88).b;
  // the displaced sheet of air picks up a breath of light
  c = c * 1.04 + uSunCol * 0.004 * along;
  float soft = fx_soft(vViewZ, 0.2);
  gl_FragColor = vec4(c, a * soft);
}`;

// Uniform Catmull-Rom on scalar components
function cr(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

class Ribbon {
  constructor() {
    this.s = new Float32Array(MAX_S * 7);   // bx,by,bz, tx,ty,tz, t   (ring)
    this.n = 0; this.head = -1;              // count, index of newest
    this.active = false; this.ending = false; this.endAt = 0; this.k = 1; this.win = 0.14; this.tOff = 0; this.born = 0;
  }
  reset(clock) { this.n = 0; this.head = -1; this.active = true; this.ending = false; this.born = clock; }
  at(i) { return ((this.head - (this.n - 1) + i) % MAX_S + MAX_S) % MAX_S * 7; }   // i = 0 oldest .. n-1 newest
  push(b, tp, t) {
    if (this.n > 0) {
      const o = this.head * 7;
      if (t - this.s[o + 6] < 1e-4) {        // same instant (hit-stop / frozen / sub-frame dup): replace
        this.s.set([b.x, b.y, b.z, tp.x, tp.y, tp.z, t], o); return;
      }
      if (t < this.s[o + 6]) this.n = 0;      // time went backwards: restart
    }
    this.head = (this.head + 1) % MAX_S;
    this.s.set([b.x, b.y, b.z, tp.x, tp.y, tp.z, t], this.head * 7);
    this.n = Math.min(this.n + 1, MAX_S);
  }
  // sample component c (0..5) at time τ with Catmull-Rom over the (non-uniform) sample times
  eval(tau, out) {
    const n = this.n, s = this.s;
    let i = n - 2;
    while (i > 0 && s[this.at(i) + 6] > tau) i--;
    const o1 = this.at(i), o2 = this.at(Math.min(i + 1, n - 1));
    const o0 = this.at(Math.max(i - 1, 0)), o3 = this.at(Math.min(i + 2, n - 1));
    const t1 = s[o1 + 6], t2 = s[o2 + 6];
    const u = Math.min(Math.max((tau - t1) / Math.max(t2 - t1, 1e-5), 0), 1);
    for (let c = 0; c < 6; c++) out[c] = cr(s[o0 + c], s[o1 + c], s[o2 + c], s[o3 + c], u);
    return out;
  }
}

export function createTrails(app) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX_RIB * VPR * 3), data = new Float32Array(MAX_RIB * VPR * 4);
  const idx = [];
  for (let r = 0; r < MAX_RIB; r++) for (let j = 0; j < SEG; j++) {
    const a = r * VPR + j * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  geo.setIndex(idx);
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aData = new THREE.BufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('aData', aData);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const matR = fxMaterial({ vs: VS, fs: FS_REFRACT });
  const matL = fxMaterial({ vs: VS, fs: FS_LIGHT, additive: true });
  const meshR = fxMesh(geo, matR, { order: 10, name: 'trail.refract' });
  const meshL = fxMesh(geo, matL, { order: 11, name: 'trail.light' });
  app.scene.add(meshR, meshL);

  const ribs = Array.from({ length: MAX_RIB }, () => new Ribbon());
  let clock = 0;
  const tmp = new Float32Array(6);

  function alloc() {
    let best = null;
    for (const r of ribs) if (!r.active) return r;
    for (const r of ribs) if (r.ending && (!best || r.endAt < best.endAt)) best = r;   // steal the oldest fading one
    return best || ribs[0];
  }

  const FADE = 0.16;
  function build(r, ri) {
    const vo = ri * VPR;
    const n = r.n;
    let alive = r.active && n >= 2;
    const now = clock + r.tOff;
    const s = r.s;
    const tNew = n ? s[r.at(n - 1) + 6] : 0, tOld = n ? s[r.at(0) + 6] : 0;
    let fade = 1;
    if (r.ending) { fade = 1 - (clock - r.endAt) / FADE; if (fade <= 0) { r.active = false; alive = false; } }
    const tHead = r.ending ? tNew : Math.min(now, tNew);
    const tTail = Math.max(tOld, (r.ending ? now : tHead) - r.win);
    if (!alive || tHead - tTail < 1e-4) {
      data.fill(0, vo * 4, (vo + VPR) * 4);
      if (!alive && r.ending && fade <= 0) r.active = false;
      return;
    }
    const k = r.k * Math.max(fade, 0) ** 1.5;
    for (let j = 0; j <= SEG; j++) {
      const tau = tHead - (tHead - tTail) * (j / SEG);
      r.eval(tau, tmp);
      const bx = tmp[0], by = tmp[1], bz = tmp[2], tx = tmp[3], ty = tmp[4], tz = tmp[5];
      const hx = bx + (tx - bx) * HILT, hy = by + (ty - by) * HILT, hz = bz + (tz - bz) * HILT;
      const ox = bx + (tx - bx) * OVER, oy = by + (ty - by) * OVER, oz = bz + (tz - bz) * OVER;
      const v = (vo + j * 2) * 3;
      pos[v] = hx; pos[v + 1] = hy; pos[v + 2] = hz; pos[v + 3] = ox; pos[v + 4] = oy; pos[v + 5] = oz;
      const x = Math.min((now - tau) / r.win, 1);
      const d = (vo + j * 2) * 4;
      data[d] = x; data[d + 1] = 0; data[d + 2] = tau; data[d + 3] = k;
      data[d + 4] = x; data[d + 5] = 1; data[d + 6] = tau; data[d + 7] = k;
    }
  }

  return {
    trail(ownerId) {
      let rib = null;
      const h = {
        id: ownerId, k: 1,
        push(base, tip, t) {
          if (!rib || rib.ending || !rib.active) {
            rib = alloc(); rib.reset(clock); rib.k = h.k; rib.win = h.k > 1.1 ? 0.2 : 0.14;
          }
          const tt = typeof t === 'number' && isFinite(t) ? t : clock;
          rib.tOff = tt - clock;
          rib.push(base, tip, tt);
        },
        end() { if (rib && !rib.ending) { rib.ending = true; rib.endAt = clock; } rib = null; },
        setIntensity(k) { h.k = k; if (rib) { rib.k = k; rib.win = k > 1.1 ? 0.2 : 0.14; } },
        get active() { return !!rib; },
      };
      return h;
    },
    update(dt) {
      clock += dt;
      for (let i = 0; i < MAX_RIB; i++) build(ribs[i], i);
      aPos.needsUpdate = true; aData.needsUpdate = true;
    },
    meshes: [meshR, meshL],
  };
}
