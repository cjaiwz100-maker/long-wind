// Terrain: public world API + the ground mesh. Owner: world (W). STABLE API (CONTRACTS §World, bible §0.5):
//   heightAt(x, z) -> m               exact height of the rendered mesh (cheap: grid interpolation)
//   normalAt(x, z, out?) -> Vector3   smooth shading normal
//   pathAt(x, z) -> { dist, width, signed, s }   distance to the dirt-road centreline (signed: +left of travel), arclength
//   groundInfo(x, z) -> { grass, dry, rock, dirt, moisture, grassH, green, ao, road }   (baked, bilinear; moisture = late-green weight)
//   isBlocked(x, z, margin = 0) -> bool   rocks, tree trunk, stele, pavilion, graves, cairn, markers
//   addBlocker({ x, z, r })           register an extra static obstacle for isBlocked (props/trees may call it)
//   const terrain = await createTerrain(app)  -> { mesh, material, stats, bakes: {height, splat, ground, aux} }
//     registers app.world.{heightAt, normalAt, pathAt, groundInfo, isBlocked, addBlocker, roadLength}
//     sets G.tHeight (R32F 2048², NEAREST), G.tSplat, G.tGround (RGBA8 2048², mipmapped), G.uWorldRect,
//     and the extra shared uniforms G.tWtAux (RGBA8 2048²: R road weight, G signed road distance sd/8+0.5,
//     B golden-tree proximity, A packed-earth pads) and G.tWtSunVis / G.uWtSunRect (terrain self-shadowing from the
//     sun over ±1536 m, R = visibility; see terrain-shadow.js).
//   GROUND_GLSL / groundUniforms()    shared GLSL: wt_groundHeight, wt_groundInfo, wt_splat, grass species colours
//   TERRAIN_READY                     promise resolved once the bakes are uploaded
import * as THREE from 'three';
import { G } from '../core/globals.js';
import { LAYOUT } from './layout.js';
import * as F from './terrain-field.js';
import { bakeWorld, BAKE_N, BAKE_HALF } from './terrain-bake.js';
import { rockPlan } from './rocks-plan.js';
import { bakeGroundSets } from './texbake.js';
import { createTerrainMaterial } from './terrain-material.js';
import { createPool } from './terrain-pool.js';
import { createTerrainShadow } from './terrain-shadow.js';
import { patchMaterial } from '../core/atmosphere.js';

export { GROUND_GLSL, groundUniforms } from './ground-glsl.js';
export { LAYOUT } from './layout.js';

// ---------------------------------------------------------------- queries
export function heightAt(x, z) { return F.heightAt(x, z); }
export function normalAt(x, z, out = new THREE.Vector3()) { return F.normalInto(x, z, out); }
export function pathAt(x, z) {
  const q = F.roadQuery(x, z);
  return { dist: q.d, width: LAYOUT.roadWidth, signed: q.sd, s: q.s };
}

let BAKED = null;   // { splat, ground, aux } CPU copies for groundInfo
function sample4(arr, x, z, c) {
  const N = BAKE_N, t = (2 * BAKE_HALF) / N;
  let fx = (x + BAKE_HALF) / t - 0.5, fz = (z + BAKE_HALF) / t - 0.5;
  fx = Math.max(0, Math.min(N - 1.001, fx)); fz = Math.max(0, Math.min(N - 1.001, fz));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = (j * N + i) * 4 + c;
  return ((arr[k] * (1 - u) + arr[k + 4] * u) * (1 - v) + (arr[k + N * 4] * (1 - u) + arr[k + N * 4 + 4] * u) * v) / 255;
}
export function groundInfo(x, z) {
  if (!BAKED || Math.abs(x) >= BAKE_HALF || Math.abs(z) >= BAKE_HALF) {
    const road = Math.max(0, Math.min(1, (LAYOUT.roadWidth * 0.5 + 1.8 - F.roadQuery(x, z, false).d) / 2));
    return { grass: BAKED ? 0 : 0.8 * (1 - road), dry: 0.5, rock: 0, dirt: road, moisture: 0.25, grassH: 0.6, green: 0.25, ao: 1, road };
  }
  const S = BAKED.splat, Gd = BAKED.ground, A = BAKED.aux;
  const green = sample4(Gd, x, z, 2);
  return {
    grass: sample4(Gd, x, z, 0), grassH: sample4(Gd, x, z, 1), moisture: green, green, ao: sample4(Gd, x, z, 3),
    dry: sample4(S, x, z, 1), rock: sample4(S, x, z, 2), dirt: sample4(S, x, z, 3), road: sample4(A, x, z, 0),
  };
}

// ---------------------------------------------------------------- static blockers (spatial hash, 16 m cells)
const CELL = 16;
const blockHash = new Map();
let blockersReady = false;
export function addBlocker({ x, z, r }) {
  const c0 = Math.floor((x - r) / CELL), c1 = Math.floor((x + r) / CELL), d0 = Math.floor((z - r) / CELL), d1 = Math.floor((z + r) / CELL);
  const b = { x, z, r };
  for (let cz = d0; cz <= d1; cz++) for (let cx = c0; cx <= c1; cx++) {
    const key = cx * 73856093 ^ cz * 19349663;
    let l = blockHash.get(key); if (!l) blockHash.set(key, l = []); l.push(b);
  }
}
function initBlockers() {
  if (blockersReady) return;
  blockersReady = true;
  for (const r of rockPlan()) if (r.kind !== 'outcrop') addBlocker({ x: r.x, z: r.z, r: r.r });
  const L = LAYOUT;
  addBlocker({ x: L.oldTree.x, z: L.oldTree.z, r: L.oldTree.r + 0.3 });
  addBlocker({ x: L.stele.x, z: L.stele.z, r: L.stele.r });
  addBlocker({ x: L.pavilion.x, z: L.pavilion.z, r: L.pavilion.r * 0.95 });
  for (const g of L.graves) addBlocker({ x: g.x, z: g.z, r: 1.2 });
  addBlocker({ x: L.cairn.x, z: L.cairn.z, r: L.cairn.r });
  for (const m of L.roadMarkers) addBlocker({ x: m.x, z: m.z, r: 0.3 });
}
export function isBlocked(x, z, margin = 0) {
  if (!blockersReady) initBlockers();
  const cx0 = Math.floor((x - margin) / CELL), cx1 = Math.floor((x + margin) / CELL);
  const cz0 = Math.floor((z - margin) / CELL), cz1 = Math.floor((z + margin) / CELL);
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
    const l = blockHash.get(cx * 73856093 ^ cz * 19349663);
    if (!l) continue;
    for (const b of l) { const dx = x - b.x, dz = z - b.z, rr = b.r + margin; if (dx * dx + dz * dz < rr * rr) return true; }
  }
  return false;
}

// ---------------------------------------------------------------- build
let readyResolve;
export const TERRAIN_READY = new Promise((r) => { readyResolve = r; });

const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

function dataTex(data, format, type, { mips = false, nearest = false } = {}) {
  const t = new THREE.DataTexture(data, BAKE_N, BAKE_N, format, type);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.minFilter = nearest ? THREE.NearestFilter : mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.needsUpdate = true;
  return t;
}

export async function createTerrain(app, opts = {}) {
  const t0 = performance.now();
  const timings = {};
  const pool = opts.workers === false ? null : createPool();
  // start decoding the ground texture sets right away (overlaps the CPU bake)
  const setsP = bakeGroundSets({ size: opts.texSize || 1024 }).catch((err) => { console.error('[terrain] ground sets failed', err); return null; });

  await F.ensureGrid(pool);
  timings.grid = Math.round(performance.now() - t0);
  Object.assign(app.world, { heightAt, normalAt, pathAt, groundInfo, isBlocked, addBlocker, roadLength: F.roadLUT().length });
  initBlockers();
  await nextTick();

  const plan = rockPlan();
  const t1 = performance.now();
  const baked = await bakeWorld({ pool, plan });
  timings.bake = Math.round(performance.now() - t1);
  pool?.close();
  BAKED = { splat: baked.splat, ground: baked.ground, aux: baked.aux };

  G.tHeight.value = dataTex(baked.height, THREE.RedFormat, THREE.FloatType, { nearest: true });
  G.tSplat.value = dataTex(baked.splat, THREE.RGBAFormat, THREE.UnsignedByteType, { mips: true });
  G.tGround.value = dataTex(baked.ground, THREE.RGBAFormat, THREE.UnsignedByteType, { mips: true });
  const aux = dataTex(baked.aux, THREE.RGBAFormat, THREE.UnsignedByteType, { mips: true });
  G.tWtAux = G.tWtAux || { value: null };
  G.tWtAux.value = aux;
  G.uWorldRect.value.set(-BAKE_HALF, -BAKE_HALF, 2 * BAKE_HALF, 1 / (2 * BAKE_HALF));
  await nextTick();

  // mesh (bible §4.2): separable grid, 0.75 m core → ±1.5 km, one draw call
  const arr = F.buildGeometryArrays();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(arr.nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(arr.idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), F.GRID.edge * 1.5);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-F.GRID.edge, -100, -F.GRID.edge), new THREE.Vector3(F.GRID.edge, 300, F.GRID.edge));

  // long hill shadows beyond the far shadow map (GPU heightfield march toward the sun, re-baked when it moves)
  let sunVis = null;
  try { sunVis = createTerrainShadow(app); } catch (err) { console.warn('[terrain] sun-visibility bake failed', err); }
  const sets = await setsP;
  timings.textures = Math.round(performance.now() - t0);
  const material = sets ? createTerrainMaterial(sets, { aux }) : patchMaterial(new THREE.MeshStandardMaterial({ color: 0x6f613c, roughness: 0.95 }));
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  app.scene.add(mesh);
  timings.total = Math.round(performance.now() - t0);

  const terrain = { mesh, material, stats: baked.stats, timings, sets, bakes: BAKED, params: material.userData.params, sunVis };
  readyResolve(terrain);
  if (app.params?.has?.('debug')) console.info('[terrain]', timings, baked.stats);
  return terrain;
}
