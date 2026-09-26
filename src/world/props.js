// World props (bible §4.6, CONTRACTS World): the weathered stele by the duel pad, the hexagonal wayside pavilion 亭,
// stone road markers, three old graves with headstones, a stone cairn with faded red cloth strips, and two broken
// spears — quiet fight history near the higanbana patch. Owner: world (W).
//
//   const props = await createProps(app)  → { meshes, colliders, atlas, update(dt), stats() }
//     colliders   [{x, z, r}] (also pushed into app.world.colliders; terrain.isBlocked already knows these places)
//
// Draw calls: carved stone (stele + plinth + markers + headstones + cairn + plaque, one atlas) · pavilion stone ·
// wood (pavilion, spear shafts, cairn pole) · roof tiles · ceramic ridges / iron · cloth strips  = 6.
// Everything sits on the exact terrain surface (heightAt), sinks a little, and casts into the far shadow map.
import * as THREE from 'three';
import { LAYERS } from '../core/globals.js';
import { loadPBR } from '../core/assets.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { WIND_GLSL, windUniforms } from '../core/wind.js';
import { mulberry32 } from '../core/noise.js';
import { LAYOUT } from './layout.js';
import { heightAt, roadQuery } from './terrain-field.js';
import { buildCarveAtlas } from './props-carve.js';
import { createCarvedMaterial, steleGeometry, plinthGeometry, markerGeometry, headstoneGeometry, STELE, PLINTH } from './props-stone.js';
import { buildPavilion, createPavilionMaterials, PAVILION } from './props-pavilion.js';
import { cyl, place, merge, partAttr } from './props-geo.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();

/** World transform: yaw about y, then small tilts (lean forward / sideways), at (x, y, z). */
function toWorld(geo, x, y, z, yaw, tiltX = 0, tiltZ = 0) {
  _e.set(tiltX, yaw, tiltZ, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(1, 1, 1));
  return geo.applyMatrix4(_m);
}

/** Lowest ground height under a rectangular footprint (w × d) rotated by yaw. */
function footprintMin(x, z, w, d, yaw) {
  let h = heightAt(x, z);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const lx = a * w / 2, lz = b * d / 2;
    h = Math.min(h, heightAt(x + lx * c + lz * s, z - lx * s + lz * c));
  }
  return h;
}

/** Yaw that turns local +z toward the nearest road centreline point. */
function yawToRoad(x, z) {
  const e = 0.5;
  const g = (px, pz) => roadQuery(px, pz).d;
  const gx = (g(x + e, z) - g(x - e, z)) / (2 * e), gz = (g(x, z + e) - g(x, z - e)) / (2 * e);
  return Math.atan2(-gx, -gz);
}

// ------------------------------------------------------------------------------------------------ small builders
/** Procedural flat field stone (flattened, noise-displaced icosphere) with UVs into the plain-stone atlas region. */
function fieldStone(rng, rx, ry, rz, atlas) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const P = g.getAttribute('position');
  const seed = rng() * 100;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const n = Math.sin(x * 3.1 + seed) * Math.sin(y * 2.7 + seed * 1.3) * Math.sin(z * 3.3 - seed) * 0.16 + Math.sin(x * 7 + z * 5 + seed) * 0.04;
    const k = 1 + n;
    P.setXYZ(i, x * rx * k, Math.max(y, -0.55) * ry * k, z * rz * k);
  }
  g.computeVertexNormals();
  const out = g.toNonIndexed();
  const Pn = out.getAttribute('position'), Nn = out.getAttribute('normal'), uv = new Float32Array(Pn.count * 2);
  const ox = rng() * 0.6, oy = rng() * 1.2;
  for (let i = 0; i < Pn.count; i++) {
    const ny = Math.abs(Nn.getY(i));
    const u = ny > 0.6 ? Pn.getX(i) : Pn.getX(i) + Pn.getZ(i), v = ny > 0.6 ? Pn.getZ(i) : Pn.getY(i);
    atlas.uv('plain2', Math.min(0.98, Math.max(0.02, 0.3 + ox * 0.5 + u * 0.3)), Math.min(0.98, Math.max(0.02, 0.2 + oy * 0.4 + v * 0.18)), _uv);
    uv[i * 2] = _uv.x; uv[i * 2 + 1] = _uv.y;
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
const _uv = new THREE.Vector2();

/** Iron spear head (flattened double cone) pointing +y from the origin. */
function spearHead(len = 0.3, w = 0.045) {
  const g = new THREE.ConeGeometry(w, len, 4, 1).toNonIndexed();
  g.translate(0, len / 2, 0);
  g.scale(1, 1, 0.3);
  const s = new THREE.ConeGeometry(w * 0.7, 0.08, 6, 1).toNonIndexed();   // socket
  s.rotateX(Math.PI); s.translate(0, -0.02, 0);
  return merge([g, s]);
}

// ------------------------------------------------------------------------------------------------ cloth strips
const CLOTH_VERT = /* glsl */`
attribute float aT;
attribute float aPhase;
${WIND_GLSL}
`;
const CLOTH_DISPLACE = /* glsl */`
{
  vec3 wpC = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec3 sw = windSway(wpC, 1.0, aPhase);
  float t = aT;
  float flap = sin(uTime * 7.3 + aPhase * 5.0 - t * 6.0) * 0.12 + sin(uTime * 11.1 + aPhase * 3.0 - t * 9.0) * 0.05;
  vec3 dw = vec3(uWind.x, 0.0, uWind.y);
  vec3 side = vec3(-uWind.y, 0.0, uWind.x);
  float g = windGust(wpC);
  // strips stream downwind and rise with the gust, fluttering along their length
  transformed += (dw * (0.35 + 0.35 * g) * t + side * flap * t + vec3(0.0, 0.22 * g * t * t, 0.0) + sw * 0.15 * t) * t;
}
`;

function clothStrips(topPos, rng) {
  const pos = [], tv = [], ph = [], uv = [], idx = [];
  const SEG = 10;
  for (let s = 0; s < 4; s++) {
    const L = 0.42 + rng() * 0.28, w = 0.045 + rng() * 0.025, a = rng() * Math.PI * 2, phase = rng() * 6.28;
    const ox = Math.cos(a) * 0.03, oz = Math.sin(a) * 0.03, yOff = -0.05 - s * 0.05;
    const b = pos.length / 3;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      for (const side of [-1, 1]) {
        pos.push(topPos.x + ox + side * w * 0.5 * Math.cos(a + 1.57), topPos.y + yOff - t * L, topPos.z + oz + side * w * 0.5 * Math.sin(a + 1.57));
        tv.push(t); ph.push(phase); uv.push(side * 0.5 + 0.5, t);
      }
    }
    for (let i = 0; i < SEG; i++) { const k = b + i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(tv, 1));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(ph, 1));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.boundingSphere = new THREE.Sphere(topPos.clone(), 2);
  return g;
}

function clothMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.23, 0.035, 0.028), roughness: 0.9, side: THREE.DoubleSide });
  mat.name = 'props:cloth';
  patchMaterial(mat);
  addShaderHook(mat, 'wtCloth', (sh) => {
    Object.assign(sh.uniforms, windUniforms());
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', CLOTH_VERT + '\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + CLOTH_DISPLACE);
    // thin cloth: glows red when the sun shines through it (SUNLIGHT_TERMS-style, from the shadowed key light)
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
      { float sb = pow(clamp(dot(-normalize(vViewPosition), gSunDir), 0.0, 1.0), 3.0);
        reflectedLight.directDiffuse += gSunColor * diffuseColor.rgb * vec3(1.2, 0.5, 0.35) * (sb * 1.4 + 0.25); }`);
  });
  return mat;
}

// ------------------------------------------------------------------------------------------------ build
export async function createProps(app) {
  const t0 = performance.now();
  const atlas = buildCarveAtlas();
  const [stoneSet, woodSet, tileSet] = await Promise.all(['japanese_stone_wall', 'weathered_planks', 'ceramic_roof_01']
    .map((id) => loadPBR(id).catch((e) => { console.warn('[props] texture failed', id, e); return null; })));
  const rng = mulberry32(4242);
  const carved = [], stoneG = [], woodG = [], tileG = [], ceramicG = [], clothG = [];
  const colliders = [];

  const PR = LAYOUT.biome?.props ?? {};   // which props this level has (world/layout.js biome.props)
  // --- stele on its plinth (turned into the low sun so the carving catches raking light), leaning a little
  if (PR.stele !== false) {
    const S = LAYOUT.stele, yaw = S.yaw;
    const g0 = footprintMin(S.x, S.z, PLINTH.w, PLINTH.d, yaw) - 0.14;
    carved.push(toWorld(plinthGeometry(atlas), S.x, g0, S.z, yaw, 0, 0.012));
    const stele = steleGeometry(atlas);
    carved.push(toWorld(stele, S.x, g0 + PLINTH.h - STELE.sinkIntoPlinth, S.z, yaw, -0.035, 0.02));
    colliders.push({ x: S.x, z: S.z, r: 0.78 });
  }
  // --- road markers, inscription toward the road
  LAYOUT.roadMarkers.forEach((m, i) => {
    const yaw = yawToRoad(m.x, m.z);
    const y = footprintMin(m.x, m.z, 0.3, 0.2, yaw) - 0.2;
    carved.push(toWorld(markerGeometry(atlas, i), m.x, y, m.z, yaw, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.1));
    colliders.push({ x: m.x, z: m.z, r: 0.3 });
  });
  // --- graves: headstone in front of each mound (terrain-field raises the mounds), leaning, half sunk
  LAYOUT.graves.forEach((g, i) => {
    const hx = g.x + Math.sin(g.yaw) * 1.25, hz = g.z + Math.cos(g.yaw) * 1.25;
    const y = footprintMin(hx, hz, 0.44, 0.12, g.yaw) - 0.12;
    carved.push(toWorld(headstoneGeometry(atlas, i), hx, y, hz, g.yaw, -0.06 - rng() * 0.1, (rng() - 0.5) * 0.14));
    colliders.push({ x: hx, z: hz, r: 0.35 });
  });
  // --- cairn of flat field stones + a pole with faded red cloth strips
  if (PR.cairn !== false) {
    const C = LAYOUT.cairn;
    let y = heightAt(C.x, C.z) - 0.08;
    const layers = [[6, 0.46, 0.28], [5, 0.3, 0.22], [3, 0.16, 0.17], [2, 0.06, 0.13], [1, 0, 0.1]];
    for (const [n, ring, sz] of layers) {
      const a0 = rng() * 6.28;
      let top = 0;
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.4;
        const x = C.x + Math.cos(a) * ring, z = C.z + Math.sin(a) * ring;
        const rx = sz * (1 + rng() * 0.5), ry = sz * (0.45 + rng() * 0.2), rz = sz * (0.8 + rng() * 0.4);
        const g = fieldStone(rng, rx, ry, rz, atlas);
        carved.push(toWorld(g, x, y + ry * 0.6, z, rng() * 6.28, (rng() - 0.5) * 0.3, (rng() - 0.5) * 0.3));
        top = Math.max(top, ry * 1.25);
      }
      y += top;
    }
    const poleTop = new THREE.Vector3(C.x + 0.03, y + 1.25, C.z - 0.02);
    woodG.push(place(cyl(0.024, 0.018, 1.55, 6, { part: 2 }), { pos: [C.x + 0.03, y - 0.3, C.z - 0.02], rotZ: 0.05 }));
    clothG.push(clothStrips(poleTop, rng));
    colliders.push({ x: C.x, z: C.z, r: C.r });
  }
  // --- broken spears stuck in the ground by the graves (fight history)
  if (PR.graves !== false) {
    const spots = [[-12.4, -23.6, 1.35, 0.35, 0.2], [-7.2, -24.9, 0.95, -0.42, 0.9]];
    for (const [x, z, len, tilt, yaw] of spots) {
      const y = heightAt(x, z) - 0.25;
      const shaft = cyl(0.02, 0.018, len, 7, { part: 2 });
      woodG.push(toWorld(shaft, x, y, z, yaw, tilt, 0.1));
      if (len > 1.2) {
        const head = spearHead();
        // the head sits on top of the (intact) longer shaft
        head.translate(0, len, 0);
        ceramicG.push(toWorld(head, x, y, z, yaw, tilt, 0.1));
      }
    }
  }
  // --- pavilion 亭 on its rise beside the road, entrance toward the road
  let pav = null;
  if (PR.pavilion !== false) {
    const PV = LAYOUT.pavilion;
    const yaw = yawToRoad(PV.x, PV.z);
    const gy = heightAt(PV.x, PV.z);
    pav = buildPavilion(atlas);
    const tf = (g) => g && toWorld(g, PV.x, gy, PV.z, yaw);
    stoneG.push(tf(pav.geos.stone)); woodG.push(tf(pav.geos.wood)); tileG.push(tf(pav.geos.tiles));
    ceramicG.push(tf(pav.geos.ceramic)); carved.push(tf(pav.geos.carved));
    colliders.push({ x: PV.x, z: PV.z, r: PAVILION.Rp + 0.15 });
    pav.world = { x: PV.x, y: gy, z: PV.z, yaw };
  }

  // --- materials + meshes
  const pm = createPavilionMaterials({ stone: stoneSet, wood: woodSet, tiles: tileSet });
  const carvedMat = createCarvedMaterial(atlas);
  const meshes = [];
  const add = (name, list, mat, { shadow = true } = {}) => {
    const geo = merge(list);
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = shadow; mesh.receiveShadow = true;
    mesh.renderOrder = -1;
    mesh.layers.set(LAYERS.WORLD);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    app.scene.add(mesh);
    meshes.push(mesh);
    return mesh;
  };
  // every part of a merged list must carry the same attributes: give non-wood parts the aPart attribute they lack
  add('props:carved', carved, carvedMat);
  add('props:stone', stoneG, pm.stone);
  add('props:wood', woodG.map((g) => (g.getAttribute('aPart') ? g : partAttr(g, 2))), pm.wood);
  add('props:tiles', tileG, pm.tiles);
  add('props:ceramic', ceramicG, pm.ceramic);
  const cloth = add('props:cloth', clothG, clothMaterial(), { shadow: false });
  if (cloth) cloth.frustumCulled = false;

  if (app.world) { app.world.colliders ||= []; app.world.colliders.push(...colliders); }
  const ms = Math.round(performance.now() - t0);
  return {
    meshes, colliders, atlas, pavilion: pav,
    update() {},
    stats() { return { meshes: meshes.length, tris: meshes.reduce((s, m) => s + m.geometry.getAttribute('position').count / 3, 0), ms }; },
  };
}
