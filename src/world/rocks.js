// Scanned rocks (bible §4.6, Poly Haven CC0): hero boulders at the outcrops, debris clusters, standing stones by the
// road, scattered boulders on the plain and rock faces on the far rim — placed by rocks-plan.js (seed 777), partly
// buried and grounded into the terrain. Owner: world (W).
//
//   const rocks = await createRocks(app, { lod = 1 })  → { meshes, colliders, instances, update(dt), stats() }
//     colliders   [{x, z, r}] also pushed into app.world.colliders (movement + camera)
//     instances   the placement plan entries that were built (with .mesh / .id)
//   Registered with app.add (per-frame LOD + distance culling; re-evaluated only when the camera moved > 1.5 m).
//
// Rendering: ONE BatchedMesh per scan material (≤ 9 draw calls), every piece in 3 LODs built at load by crack-free
// vertex clustering (rocks-lod.js). Per-instance frustum culling + LOD switching via setGeometryIdAt. Layer 0 (WORLD),
// casts into the far shadow map, renderOrder −1 (drawn before the terrain for early-Z).
// Material: the scan's MeshStandardMaterial calibrated to the bible rock albedo (0.18, 0.17, 0.155) by the texture's
// measured mean, plus a hook that (1) turns green moss into dry ochre/olive lichen, (2) adds lichen on up-facing
// surfaces, (3) blends the base into the ground it sits in (dust/soil colour + grass bleed + contact occlusion, from
// the exact terrain height bake) — so no rock ever looks pasted on.
import * as THREE from 'three';
import { loadModel } from '../core/assets.js';
import { LAYERS } from '../core/globals.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { mulberry32 } from '../core/noise.js';
import { GROUND_GLSL } from './ground-glsl.js';
import { rockPlan } from './rocks-plan.js';
import { heightAt, normalInto } from './terrain-field.js';
import { simplify, prepGeometry } from './rocks-lod.js';

// Triangle targets per LOD. Hero pieces are large scans (up to 98k tris): LOD0 is decimated too.
const LOD_TRIS = { hero: [14000, 2400, 420], debris: [1800, 420, 90] };
// LOD selection by projected size (size / distance): LOD0 above A, LOD1 above B, hidden below C.
const LOD_SEL = { hero: [0.075, 0.02, 0.0035], debris: [0.06, 0.02, 0.0045] };

// Models used by the plan; which of them are debris-class (small scans).
const DEBRIS_IDS = new Set(['stone_01', 'rock_07', 'rock_09']);

const ROCK_TARGET = new THREE.Color(0.18, 0.17, 0.155);   // bible §1.4 rock albedo (linear)

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3();
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3();
const _c = new THREE.Color();

/** Mean linear albedo of an image (ImageBitmap / HTMLImageElement) measured on a 32² thumbnail. */
function meanAlbedo(image) {
  try {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(32, 32) : Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += lin(d[i]); g += lin(d[i + 1]); b += lin(d[i + 2]); }
    const n = d.length / 4;
    return new THREE.Color(r / n, g / n, b / n);
  } catch { return new THREE.Color(0.25, 0.24, 0.22); }
}

// ------------------------------------------------------------------------------------------------ material
const ROCK_FRAG_PARS = /* glsl */`
${GROUND_GLSL}
uniform vec4 uRkLichen;   // x lichen amount, y moss→dry recolour, z ground blend height (m), w contact AO
`;
const ROCK_ALBEDO = /* glsl */`
{
  vec3 wp = vWxWorldPos;
  vec3 wN = normalize(inverseTransformDirection(normal, viewMatrix));
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  // 1) scanned moss (green) → dry steppe lichen: olive-ochre, a touch lighter
  float moss = smoothstep(0.0, 0.05, diffuseColor.g - max(diffuseColor.r * 1.02, diffuseColor.b * 1.1));
  vec3 dryMoss = lum * vec3(1.32, 1.08, 0.58);
  diffuseColor.rgb = mix(diffuseColor.rgb, dryMoss, moss * uRkLichen.y);
  // 2) crusty lichen on up-facing surfaces (bible: smoothstep(0.42,0.8, n.y + (noise-0.5)*0.7) → ochre)
  float ln = wx_vnoise(wp.xz * 3.1 + wp.y * 1.7) * 0.6 + wx_vnoise(wp.xz * 11.0 - wp.y * 5.0) * 0.4;
  float lich = smoothstep(0.42, 0.8, wN.y + (ln - 0.5) * 0.7) * smoothstep(0.35, 0.7, wx_vnoise(wp.xz * 1.3 + 4.0) + ln * 0.3);
  vec3 lichCol = mix(vec3(0.20, 0.17, 0.08), vec3(0.30, 0.24, 0.10), wx_vnoise(wp.xz * 7.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, lichCol * (0.7 + 0.6 * lum / 0.18), lich * uRkLichen.x);
  // 3) ground blend: soil/dust skirt + grass-colour bleed + contact occlusion near the terrain line
  if (wt_inWorld(wp.xz) > 0.5) {
    float hA = wp.y - wt_groundHeight(wp.xz);
    float en = wx_vnoise(wp.xz * 6.0 + wp.y * 3.0);
    float skirt = 1.0 - smoothstep(0.0, uRkLichen.z * (0.6 + 0.8 * en), hA);
    vec4 gi = wt_groundInfo(wp.xz);
    vec3 soil = vec3(0.13, 0.10, 0.068) * (0.85 + 0.3 * en);
    vec3 grassy = wt_canopyColor(wp.xz, gi.b, 0.3) * 0.55;
    vec3 skirtCol = mix(soil, grassy, clamp(gi.r * 1.3, 0.0, 1.0) * 0.6);
    diffuseColor.rgb = mix(diffuseColor.rgb, skirtCol, skirt * 0.75);
    diffuseColor.rgb *= mix(uRkLichen.w, 1.0, smoothstep(-0.05, 0.45, hA));
  }
}
`;

function makeMaterial(src, id) {
  const mat = src.clone();
  mat.name = 'rock:' + id;
  mat.side = THREE.FrontSide;
  mat.metalness = 0;
  mat.metalnessMap = null;
  mat.envMapIntensity = 0.6;
  // albedo calibration: scale the measured mean to the bible rock value (keep 35% of the scan's own hue)
  const img = mat.map?.image;
  const mean = img ? meanAlbedo(img) : new THREE.Color(0.25, 0.24, 0.22);
  const lm = mean.r * 0.2126 + mean.g * 0.7152 + mean.b * 0.0722, lt = 0.1694;
  const k = lt / Math.max(lm, 1e-3);
  _c.setRGB(ROCK_TARGET.r / Math.max(mean.r, 1e-3), ROCK_TARGET.g / Math.max(mean.g, 1e-3), ROCK_TARGET.b / Math.max(mean.b, 1e-3));
  mat.color.setRGB(k + (_c.r - k) * 0.65, k + (_c.g - k) * 0.65, k + (_c.b - k) * 0.65);
  mat.userData.meanAlbedo = mean;
  const uRkLichen = { value: new THREE.Vector4(id.startsWith('rock_moss') ? 0.45 : 0.8, 0.85, 0.32, 0.5) };
  mat.userData.uRkLichen = uRkLichen;
  patchMaterial(mat);
  addShaderHook(mat, 'wtRock', (shader) => {
    shader.uniforms.uRkLichen = uRkLichen;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', ROCK_FRAG_PARS + '\nvoid main() {')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + ROCK_ALBEDO);
  });
  return mat;
}

// ------------------------------------------------------------------------------------------------ prototypes
/** Load a scan and split it into centred pieces (xz centre at 0, bottom at y = 0) with 3 LOD geometries each. */
async function loadPrototype(id) {
  const root = await loadModel(id);
  root.updateMatrixWorld(true);
  const pieces = [];
  let material = null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    material ||= o.material;
    const g = prepGeometry(o.geometry);
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    const bb = g.boundingBox, c = new THREE.Vector3();
    bb.getCenter(c);
    g.translate(-c.x, -bb.min.y, -c.z);
    g.computeBoundingBox();
    const size = new THREE.Vector3(); g.boundingBox.getSize(size);
    pieces.push({ name: o.name, geo: g, size, bbox: g.boundingBox.clone() });
  });
  return { id, pieces, material, debris: DEBRIS_IDS.has(id) };
}

// ------------------------------------------------------------------------------------------------ build
export async function createRocks(app, { lod = 1 } = {}) {
  const t0 = performance.now();
  const plan = rockPlan();
  const ids = [...new Set(plan.map((r) => r.model))];
  const protos = new Map();
  await Promise.all(ids.map(async (id) => {
    try { protos.set(id, await loadPrototype(id)); } catch (err) { console.warn('[rocks] model failed', id, err); }
  }));

  const tLoad = performance.now() - t0;
  // one BatchedMesh per scan
  const batches = new Map();
  let triTotal = 0;
  for (const [id, pr] of protos) {
    const cls = pr.debris ? 'debris' : 'hero';
    const lodTris = LOD_TRIS[cls].map((t) => Math.round(t * lod));
    // count how many instances use this model to size the batch
    const users = plan.filter((r) => r.model === id);
    if (!users.length) continue;
    const lods = pr.pieces.map((p) => lodTris.map((t) => simplify(p.geo, t)));
    let nv = 0, ni = 0;
    for (const l of lods) for (const g of l) { nv += g.getAttribute('position').count; ni += g.index.count; }
    const mat = makeMaterial(pr.material, id);
    const bm = new THREE.BatchedMesh(users.length + 4, nv, ni, mat);
    bm.name = 'rocks:' + id;
    bm.castShadow = true;
    bm.receiveShadow = true;
    bm.renderOrder = -1;
    bm.layers.set(LAYERS.WORLD);
    bm.frustumCulled = false;          // per-instance culling instead
    bm.perObjectFrustumCulled = true;
    bm.sortObjects = false;            // opaque; skip the per-frame sort
    const geoIds = lods.map((l) => l.map((g) => bm.addGeometry(g)));
    const lowPos = lods.map((l) => l[2].getAttribute('position').array);
    batches.set(id, { id, bm, geoIds, lowPos, proto: pr, cls });
    for (const l of lods) triTotal += l[0].index.count / 3;
    app.scene.add(bm);
  }

  const tLod = performance.now() - t0 - tLoad;
  // instances
  const colliders = [];
  const instances = [];
  const rng = mulberry32(7770);
  for (const r of plan) {
    const b = batches.get(r.model);
    if (!b) continue;
    const pr = b.proto;
    const pi = r.piece >= 0 ? Math.min(r.piece, pr.pieces.length - 1) : Math.floor(rng() * pr.pieces.length);
    const piece = pr.pieces[pi];
    // rotation: optional stand-up (longest axis vertical) → yaw → partial alignment to the terrain normal
    _q.identity();
    let sx = piece.size.x, sy = piece.size.y, sz = piece.size.z;
    if (r.kind === 'standing') {
      if (sx >= sz && sx > sy) { _q.setFromAxisAngle(_v.set(0, 0, 1), Math.PI / 2); [sx, sy] = [sy, sx]; }
      else if (sz > sy) { _q.setFromAxisAngle(_v.set(1, 0, 0), Math.PI / 2); [sz, sy] = [sy, sz]; }
    }
    _q2.setFromAxisAngle(_up, r.rotY);
    _q.premultiply(_q2);
    normalInto(r.x, r.z, _n);
    if (r.kind === 'outcrop' && r.nx !== undefined) _n.set(r.nx, r.ny, r.nz);
    _v.copy(_up).lerp(_n, r.align ?? 0.5).normalize();
    _q2.setFromUnitVectors(_up, _v);
    _q.premultiply(_q2);
    if (r.lean) { _q2.setFromAxisAngle(_v.set(Math.cos(r.rotY), 0, Math.sin(r.rotY)), r.lean); _q.premultiply(_q2); }
    // scale: size = largest horizontal extent; standing stones scale to height h
    let s = r.size / Math.max(sx, sz, 1e-3);
    if (r.kind === 'standing' && r.h) s = r.h / Math.max(sy, 1e-3) / (1 - r.sink);
    _s.set(s, s * (r.yScale || 1), s);
    // grounding: exact lowest vertex after rotation/scale (LOD2 hull), then bury `sink` of the height below the
    // lowest ground point under the footprint so no edge floats on slopes
    _m.compose(_p.set(0, 0, 0), _q, _s);
    const P = b.lowPos[pi];
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
      const y = _m.elements[1] * P[i] + _m.elements[5] * P[i + 1] + _m.elements[9] * P[i + 2];
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const H = maxY - minY, fr = Math.max(0.1, r.size * 0.42);
    let g = heightAt(r.x, r.z);
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g = Math.min(g, heightAt(r.x + Math.cos(a) * fr, r.z + Math.sin(a) * fr)); }
    const y = g - minY - H * r.sink;
    _m.compose(_p.set(r.x, y, r.z), _q, _s);
    const iid = b.bm.addInstance(b.geoIds[pi][2]);
    b.bm.setMatrixAt(iid, _m);
    // subtle per-rock tint: brightness 0.86–1.08, a little warm/cool drift
    const br = 0.86 + rng() * 0.22, w = (rng() - 0.5) * 0.06;
    b.bm.setColorAt(iid, _c.setRGB(br * (1 + w), br, br * (1 - w)));
    const inst = { plan: r, batch: b, id: iid, pi, size: Math.max(r.size, H), lod: 2, x: r.x, y: y + H * 0.5, z: r.z };
    instances.push(inst);
    if (r.collide) colliders.push({ x: r.x, z: r.z, r: r.r * 1.05 });
  }
  if (app.world) { app.world.colliders ||= []; app.world.colliders.push(...colliders); }

  // per-frame LOD: only when the camera moved (> 1.5 m) or on the first frame
  const last = new THREE.Vector3(1e9, 0, 0);
  const counts = [0, 0, 0, 0];
  const sys = {
    update() {
      const cam = app.camera.position;
      if (cam.distanceToSquared(last) < 2.25) return;
      last.copy(cam);
      counts.fill(0);
      for (const it of instances) {
        const sel = LOD_SEL[it.batch.cls];
        const dx = it.x - cam.x, dy = it.y - cam.y, dz = it.z - cam.z;
        const k = it.size / Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.1);
        const l = k > sel[0] ? 0 : k > sel[1] ? 1 : k > sel[2] ? 2 : 3;
        counts[l]++;
        if (l === it.lod) continue;
        const bm = it.batch.bm;
        if (l === 3) bm.setVisibleAt(it.id, false);
        else {
          if (it.lod === 3) bm.setVisibleAt(it.id, true);
          bm.setGeometryIdAt(it.id, it.batch.geoIds[it.pi][l]);
        }
        it.lod = l;
      }
    },
    stats() { return { instances: instances.length, lod0: counts[0], lod1: counts[1], lod2: counts[2], hidden: counts[3], batches: batches.size, lod0TrisPerSet: triTotal, ms: { load: Math.round(tLoad), lod: Math.round(tLod) } }; },
  };
  sys.update();
  app.add(sys);
  return { meshes: [...batches.values()].map((b) => b.bm), colliders, instances, update: sys.update, stats: sys.stats };
}
