// Combat VFX facade (bible §6.2, CONTRACTS §VFX). Owner: X.
//   const vfx = createVFX(app, { interaction })
//   vfx.trail(ownerId) → { push(base, tip, t), end(), setIntensity(k) }
//   vfx.sparks(pos, normal, power) · vfx.blood(pos, dir, amount, ink) · vfx.dust(pos, amount)
//   vfx.clippings(points[], dir) · vfx.shockwave(x, z, strength) · vfx.hitGlow(pos, size, color?)
//   vfx.leafBurst(pos, n) · vfx.qiWave(origin, dir) → { update(dt), dead, pos }
// Sub-systems: trail.js (ribbons), particles.js (sparks, droplets, glows), soft.js (dust, blood mist, ink blooms),
// and the debris swarm + qi crescent defined here.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ATMOS_GLSL } from '../core/atmosphere.js';
import { lamps } from '../core/lamps.js';
import { windVector } from '../core/wind.js';
import { FX_COMMON, FX_FRAG, fxMaterial, fxMesh, instancedQuad, Swarm, flush, rnd, rr, coneDir } from './common.js';
import { createTrails } from './trail.js';
import { createParticles } from './particles.js';
import { createSoft } from './soft.js';

// ------------------------------------------------------------------------------------------ debris (clippings, leaves)
// Small tumbling cards lit by the sun (two-sided, with backlit translucency), fogged like the world.
const DEBRIS_VS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
attribute vec3 iPos; attribute vec4 iRot; attribute vec4 iCol;   // iRot: axis xyz, angle · iCol: rgb, age01
attribute vec2 iSize;
varying vec3 vWp, vN, vCol; varying vec2 vUv; varying float vAge;
vec3 rotAA(vec3 v, vec3 a, float t) { float c = cos(t), s = sin(t); return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c); }
void main() {
  vec3 ax = normalize(iRot.xyz + vec3(1e-4));
  vec3 p = vec3(position.x * iSize.x, (position.y - 0.5) * iSize.y, 0.0);
  p.z += position.x * position.x * iSize.x * 0.35;          // slight cupping
  vec3 wp = iPos + rotAA(p, ax, iRot.w);
  vN = rotAA(vec3(0.0, 0.0, 1.0), ax, iRot.w);
  vWp = wp; vCol = iCol.rgb; vAge = iCol.a; vUv = vec2(position.x * 0.5 + 0.5, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const DEBRIS_FS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
varying vec3 vWp, vN, vCol; varying vec2 vUv; varying float vAge;
void main() {
  // leaf/blade silhouette: pointed ellipse
  float w = 1.0 - pow(abs(vUv.y * 2.0 - 1.0), 1.6);
  if (abs(vUv.x * 2.0 - 1.0) > w) discard;
  vec3 V = normalize(cameraPosition - vWp);
  vec3 N = normalize(vN); if (dot(N, V) < 0.0) N = -N;
  float ndl = max(dot(N, uSunDir), 0.0);
  float back = pow(max(dot(-V, uSunDir), 0.0), 4.0);
  vec3 col = vCol * (uSunCol * (ndl * 0.32 + back * 0.9) + fx_amb() * 0.9) + vCol * fx_lamps(vWp);
  col = wx_applyAtmosphere(col, vWp);
  float a = 1.0 - smoothstep(0.75, 1.0, vAge);
  gl_FragColor = vec4(col, a);
}`;

// ------------------------------------------------------------------------------------------ qi crescent
const QI_VS = /* glsl */`
${ATMOS_GLSL}
varying vec2 vUv; varying vec3 vWp;
void main() { vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vWp = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const QI_FS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
uniform float uAge, uLife, uTimeQ;
varying vec2 vUv; varying vec3 vWp;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  // u: along the arc (0..1), v: across (0 inner .. 1 outer edge)
  float along = sin(vUv.x * 3.14159);                         // tapered ends
  float edge = smoothstep(0.0, 0.35, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
  float streak = n2(vec2(vUv.x * 14.0 - uTimeQ * 9.0, vUv.y * 3.0)) * 0.6 + 0.4;
  float core = exp(-pow((vUv.y - 0.62) * 7.0, 2.0));
  float k = along * (edge * streak * 0.8 + core * 1.4);
  float life = 1.0 - smoothstep(0.55, 1.0, uAge / uLife);
  float born = smoothstep(0.0, 0.06, uAge);
  vec3 col = fx_hotCore() * (2.2 + 5.0 * core) * k * life * born;
  // ink-wash fringe: a darker, cooler rim on the trailing side
  col = mix(col, col * vec3(0.6, 0.75, 1.0), 1.0 - vUv.y);
  gl_FragColor = vec4(col, 1.0);
}`;

function crescentGeometry(radius = 1.7, width = 0.55, arc = 2.1, seg = 36) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg, a = (u - 0.5) * arc;
    const bow = Math.cos(a);                                     // crescent bulges forward (+z) at the centre
    for (let j = 0; j <= 1; j++) {
      const r = radius - width * (1 - j) * (0.3 + 0.7 * Math.sin(u * Math.PI));
      pos.push(Math.sin(a) * r, 0, bow * r - radius * 0.72);
      uv.push(u, j);
    }
    if (i < seg) { const b = i * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function createVFX(app, { interaction } = {}) {
  const heightAt = (x, z) => app.world.heightAt(x, z);
  const trails = createTrails(app);
  const parts = createParticles(app, { interaction, lamps, heightAt });
  const soft = createSoft(app, { heightAt, interaction, pipeline: app.pipeline });

  // ---- debris
  const debris = new Swarm(700, 16);   // px py pz vx vy vz age life ax ay az ang spin r g b(+size packed below)
  const dSize = new Float32Array(700 * 2);
  const dGeo = instancedQuad(700, { iPos: 3, iRot: 4, iCol: 4, iSize: 2 });
  const dMat = fxMaterial({ vs: DEBRIS_VS, fs: DEBRIS_FS, depthWrite: true, transparent: true });
  app.scene.add(fxMesh(dGeo, dMat, { order: 12, name: 'fx.debris' }));
  const _d = new THREE.Vector3(), _w = new THREE.Vector2(), _up = new THREE.Vector3(0, 1, 0);

  function spawnDebris(p, v, life, col, w, h, spin) {
    const o = debris.spawn(), d = debris.d, i = o / debris.S;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = v.x; d[o + 4] = v.y; d[o + 5] = v.z;
    d[o + 6] = 0; d[o + 7] = life;
    coneDir(_up, Math.PI, _d); d[o + 8] = _d.x; d[o + 9] = _d.y; d[o + 10] = _d.z;
    d[o + 11] = rnd() * 6.28; d[o + 12] = spin; d[o + 13] = col[0]; d[o + 14] = col[1]; d[o + 15] = col[2];
    dSize[i * 2] = w; dSize[i * 2 + 1] = h;
  }
  const GRASS = [[0.62, 0.46, 0.16], [0.35, 0.27, 0.10], [0.78, 0.66, 0.36], [0.30, 0.34, 0.09]];
  const LEAF = [[0.62, 0.40, 0.06], [0.90, 0.66, 0.16], [0.75, 0.52, 0.10]];

  // ---- qi waves
  const qiGeo = crescentGeometry();
  const qiMaterial = () => fxMaterial({ vs: QI_VS, fs: QI_FS, additive: true, uniforms: { uAge: { value: 0 }, uLife: { value: 0.8 }, uTimeQ: { value: 0 } } });
  // A permanent, invisible (fully faded, zero-size) crescent keeps the qi program compiled and alive: every wave
  // creates and disposes its own material, and without a live user three would delete and re-link the program
  // (a ~60 ms hitch on each special).
  const qiKeep = new THREE.Mesh(qiGeo, qiMaterial());
  qiKeep.name = 'fx.qi.keep'; qiKeep.layers.set(1); qiKeep.frustumCulled = false; qiKeep.scale.setScalar(1e-4);
  qiKeep.material.uniforms.uAge.value = 10; qiKeep.position.set(0, -1000, 0);
  app.scene.add(qiKeep);
  const waves = [];

  // arrows (archers): one shared mesh per flying arrow — shaft, iron head, three fletchings; points along +Z
  const arrowGeo = (() => {
    const shaft = new THREE.CylinderGeometry(0.0045, 0.0045, 0.78, 6, 1, true); shaft.rotateX(Math.PI / 2);
    const head = new THREE.ConeGeometry(0.011, 0.07, 6); head.rotateX(Math.PI / 2); head.translate(0, 0, 0.42);
    const fl = [];
    for (let k = 0; k < 3; k++) {
      const f = new THREE.PlaneGeometry(0.028, 0.11); f.translate(0.016, 0, -0.32); f.rotateZ(k * Math.PI * 2 / 3); fl.push(f);
    }
    const strip = (g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; };
    return mergeGeometries([shaft, head, ...fl].map(strip));
  })();
  const arrowMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide });
  const _az = new THREE.Vector3(0, 0, 1), _ad = new THREE.Vector3();
  // compiled with the scene (no first-arrow hitch): a permanent arrow far under the ground
  const arrowKeep = new THREE.Mesh(arrowGeo, arrowMat);
  arrowKeep.name = 'fx.arrow.keep'; arrowKeep.layers.set(2); arrowKeep.frustumCulled = false; arrowKeep.position.set(0, -1000, 0);
  app.scene.add(arrowKeep);

  const vfx = {
    /** A flying arrow: { update(pos, vel), dispose() } */
    arrow(pos, vel, scale = 1) {
      const mesh = new THREE.Mesh(arrowGeo, arrowMat);
      if (scale !== 1) mesh.scale.setScalar(scale);
      mesh.layers.set(2); mesh.frustumCulled = false; mesh.name = 'fx.arrow';
      app.scene.add(mesh);
      const h = {
        update(p, v) { mesh.position.copy(p); if (v.lengthSq() > 1e-6) mesh.quaternion.setFromUnitVectors(_az, _ad.copy(v).normalize()); },
        dispose() { mesh.removeFromParent(); },
      };
      h.update(pos, vel);
      return h;
    },

    trail: (id) => trails.trail(id),
    sparks: (pos, normal, power) => parts.sparks(pos, normal, power),
    hitGlow: (pos, size, color) => parts.hitGlow(pos, size, color),
    dust: (pos, amount = 1) => soft.dust(pos, amount),

    blood(pos, dir, amount = 1, ink = false) {
      _d.copy(dir ?? _up); if (_d.lengthSq() < 1e-6) _d.set(1, 0, 0); _d.normalize();
      parts.droplets(pos, _d, Math.round((ink ? 10 : 18) * amount), ink);
      soft.mist(pos, _d, Math.min(amount, 1.4) * 0.7, ink);
      if (ink) soft.bloom(pos, _d, Math.min(amount, 1.2) * 0.6, ink);   // a restrained ink bloom, never a smoke cloud
      interaction?.stain?.(pos.x + _d.x * 0.8, pos.z + _d.z * 0.8, 0.5 + 0.35 * amount, Math.min(1, 0.5 * amount));
    },

    /** Cut grass pieces flung along `dir` from the points the blade passed through. */
    clippings(points = [], dir) {
      _d.copy(dir ?? _up); _d.y = 0; if (_d.lengthSq() < 1e-6) _d.set(1, 0, 0); _d.normalize();
      for (const p of points) {
        for (let k = 0; k < 6; k++) {
          const v = new THREE.Vector3(_d.x * rr(1, 4) + rr(-0.8, 0.8), rr(1.2, 3.2), _d.z * rr(1, 4) + rr(-0.8, 0.8));
          spawnDebris(p, v, rr(1.4, 2.4), GRASS[(rnd() * GRASS.length) | 0], rr(0.006, 0.012), rr(0.07, 0.16), rr(6, 16));
        }
      }
    },

    /** Golden leaves shaken loose (tree hits, heavy impacts, kills). */
    leafBurst(pos, n = 30) {
      for (let k = 0; k < n; k++) {
        coneDir(_up, 1.2, _d);
        const v = _d.clone().multiplyScalar(rr(1.5, 4.5)); v.y *= 0.8;
        spawnDebris(pos, v, rr(2.5, 4.5), LEAF[(rnd() * LEAF.length) | 0], rr(0.02, 0.035), rr(0.04, 0.07), rr(2, 7));
      }
    },

    shockwave(x, z, strength = 1) {
      const y = heightAt(x, z);
      soft.ring(x, y, z, strength);
      interaction?.shock?.(x, z, strength);
      lamps.flash(new THREE.Vector3(x, y + 0.5, z), [1.0, 0.7, 0.4], 2 + 2 * strength, 0.15);
    },

    qiWave(origin, dir) {
      const mat = qiMaterial();
      const mesh = new THREE.Mesh(qiGeo, mat);
      mesh.layers.set(1); mesh.frustumCulled = false; mesh.renderOrder = 25;
      const f = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      mesh.position.copy(origin);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f);
      mesh.rotateZ(-0.35);                                    // slanted like the finishing cut
      app.scene.add(mesh);
      const light = lamps.add({ pos: origin.clone(), color: [0.9, 0.85, 0.7], weight: 6 });
      const w = {
        mesh, mat, light, age: 0, life: 0.8, speed: 24, dir: f, pos: mesh.position, dead: false, last: origin.clone(),
        update(dt) {
          if (w.dead) return;
          w.age += dt;
          w.last.copy(mesh.position);
          mesh.position.addScaledVector(f, w.speed * dt);
          mat.uniforms.uAge.value = w.age; mat.uniforms.uTimeQ.value += dt;
          light.pos.copy(mesh.position); light.weight = 6 * (1 - w.age / w.life);
          // carve the grass under the crescent
          const p = mesh.position, s = new THREE.Vector3(-f.z, 0, f.x).multiplyScalar(1.4);
          interaction?.cut?.(p.x - s.x, p.z - s.z, p.x + s.x, p.z + s.z, 0.8);
          if ((w.age * 20 | 0) % 2 === 0) interaction?.slash?.(w.last.x - s.x, w.last.z - s.z, p.x + s.x, p.z + s.z, 1.2, 1);
          if (rnd() < 0.5) vfx.clippings([p.clone().setY(heightAt(p.x, p.z) + 0.4)], f);
          if (w.age >= w.life) w.dispose();
        },
        dispose() {
          if (w.dead) return;
          w.dead = true; mesh.removeFromParent(); mat.dispose(); light.remove();
          const i = waves.indexOf(w); if (i >= 0) waves.splice(i, 1);
        },
      };
      waves.push(w);
      return w;
    },

    update(dt, t) {
      trails.update(dt);
      parts.update(dt);
      soft.update(dt, t);
      // debris physics: gravity, air drag, wind drift, ground settle
      if (dt > 0) {
        const d = debris.d;
        for (let i = debris.n - 1; i >= 0; i--) {
          const o = i * debris.S;
          d[o + 6] += dt;
          if (d[o + 6] >= d[o + 7]) {
            const li = debris.n - 1;
            dSize[(o / debris.S) * 2] = dSize[li * 2]; dSize[(o / debris.S) * 2 + 1] = dSize[li * 2 + 1];
            debris.kill(o); continue;
          }
          windVector(d[o], d[o + 2], t, _w);
          const e = Math.exp(-2.2 * dt);
          d[o + 3] = d[o + 3] * e + _w.x * 1.2 * (1 - e);
          d[o + 5] = d[o + 5] * e + _w.y * 1.2 * (1 - e);
          d[o + 4] = d[o + 4] * e - 3.2 * dt;                    // light things: low terminal velocity
          d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
          d[o + 11] += d[o + 12] * dt;
          const gy = heightAt(d[o], d[o + 2]) + 0.03;
          if (d[o + 1] < gy) { d[o + 1] = gy; d[o + 3] *= 0.3; d[o + 5] *= 0.3; d[o + 4] = 0; d[o + 12] *= 0.2; }
        }
      }
      for (const w of [...waves]) w.update(dt);
    },

    lateUpdate() {
      parts.lateUpdate?.();
      soft.lateUpdate?.();
      const P = dGeo.attributes.iPos.array, R = dGeo.attributes.iRot.array, C = dGeo.attributes.iCol.array, S = dGeo.attributes.iSize.array, d = debris.d;
      for (let i = 0; i < debris.n; i++) {
        const o = i * debris.S;
        P[i * 3] = d[o]; P[i * 3 + 1] = d[o + 1]; P[i * 3 + 2] = d[o + 2];
        R[i * 4] = d[o + 8]; R[i * 4 + 1] = d[o + 9]; R[i * 4 + 2] = d[o + 10]; R[i * 4 + 3] = d[o + 11];
        C[i * 4] = d[o + 13]; C[i * 4 + 1] = d[o + 14]; C[i * 4 + 2] = d[o + 15]; C[i * 4 + 3] = d[o + 6] / d[o + 7];
        S[i * 2] = dSize[i * 2]; S[i * 2 + 1] = dSize[i * 2 + 1];
      }
      flush(dGeo, debris.n, ['iPos', 'iRot', 'iCol', 'iSize']);
    },
  };
  app.add(vfx);
  window.__vfx = vfx;
  return vfx;
}
