// GPU-procedural grass (bible §5.2–5.6) — the centerpiece. Owner: vegetation (V). STABLE API:
//   const grass = createGrass(app, opts?)  → { update(dt), setDensity(k), setHeight(k), tiers, meshes, stats() }
//     opts: { density = 1 (tier quality: 1.3 ultra, 1 high, 0.6 medium, 0.35 low; or per tier [L0, L1, L2]), l2Radius = 90 }
//   Registered with app.add automatically.
// Architecture: three tiers (L0 near, L1 mid, L2 far), each ONE draw call: a Mesh with an InstancedBufferGeometry
// (the shared blade strip) and instanceCount = visibleTiles × k². The CPU only picks camera-following tiles that
// intersect the tier annulus and the frustum and uploads their origins (uTiles[64]); the vertex shader builds every
// blade (grass-glsl.js). No per-blade CPU memory, no alpha, early-Z via renderOrder.
// Terrain data: G.tHeight/tGround/uWorldRect from the world owner when present; otherwise a local fallback bake
// from app.world.heightAt (foliage.js vegGround, shared by all vegetation; re-bound when the bakes arrive).
// Wildflower meadows (foliage.js FLOWER_PATCH_GLSL) get a shorter, thinner sward so the flowers stand clear.
// Layer MAIN_ONLY, receives shadows (both sun maps through S's chunks), never casts.
import * as THREE from 'three';
import { G, LAYERS } from '../core/globals.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { sunTermsSetup, sunGlobalsPars, sunGlobalsUniforms, FOLIAGE_NORMAL_BEGIN, vegGround, TileRing, cameraFrustum, flowerSpots } from './foliage.js';
import { grassVertexPars, GRASS_VERTEX_BODY, grassFragmentPars, GRASS_COLOR_FRAG, grassLightFrag } from './grass-glsl.js';

export { GRASS_SPECIES_GLSL, GRASS_PALETTE } from './grass-glsl.js';

// The world owner's shared ground GLSL (wt_grassMacro: the same field tint as the far canopy). Optional: grass still
// builds with its own species/macro functions if the module is missing or broken.
const GROUND = await import('./ground-glsl.js').catch((e) => { console.warn('[grass] ground-glsl.js unavailable, using local macro', e?.message); return null; });

// Tier table (bible §5.2). ring = fade-in start/end, fade-out start/end.
const TIERS = [
  { name: 'L0', tile: 5, k: 52, segs: 5, width: 1.0, ring: [-2, -1, 9, 11], cap: 16, order: -4 },
  { name: 'L1', tile: 12, k: 64, segs: 4, width: 1.7, ring: [9, 11, 30, 34], cap: 32, order: -3 },
  { name: 'L2', tile: 30, k: 72, segs: 2, width: 3.4, ring: [30, 34, 80, 90], cap: 40, order: -2 },
];
const MAX_TILES = 64;

/** Shared blade strip: rows warped toward the tip (curvature + seed heads), two vertices (side ±1), one tip vertex. */
function bladeGeometry(segs) {
  const pos = [];
  for (let r = 0; r < segs; r++) {
    const t = 1 - Math.pow(1 - r / segs, 1.35);
    pos.push(-1, t, 0, 1, t, 0);
  }
  pos.push(0, 1, 0);
  const idx = [];
  for (let r = 0; r < segs - 1; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, d, a, d, c);
  }
  const l = (segs - 1) * 2;
  idx.push(l, l + 1, segs * 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // dummy normal: without it three forces FLAT_SHADED for Lambert (the real normal is built in the shader)
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ------------------------------------------------------------------------------------------------ material
function grassMaterial(tier, idx, shared) {
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: 0xffffff });
  mat.name = `grass-${tier.name}`;
  patchMaterial(mat);
  const sun = sunTermsSetup();
  const u = tier.uniforms;
  addShaderHook(mat, `grass-${tier.name}-${sun.key}-${GROUND?.GROUND_GLSL ? 'w' : 'l'}-v5`, (sh) => {
    Object.assign(sh.uniforms, {
      uTiles: u.uTiles, uK: u.uK, uRing: u.uRing, uWidthMul: u.uWidthMul,
      uDensityMul: shared.uDensityMul, uHeightMul: shared.uHeightMul, uPixelWorld: shared.uPixelWorld,
      ...shared.ground, uFlowerSpots: flowerSpots,
      uTime: G.uTime, uWind: G.uWind, tWindNoise: G.tWindNoise,
      tInteract: G.tInteract, uInteractRect: G.uInteractRect,
      uActors: G.uActors, uShock: G.uShock, uSlash: G.uSlash, uSlashB: G.uSlashB, uCamGround: G.uCamGround,
    });
    Object.assign(sh.uniforms, sunGlobalsUniforms(sun));
    const wMacro = !!GROUND?.GROUND_GLSL;
    const defs = `#define GR_TIER ${idx}\n#define GR_SEGS ${tier.segs}\n${wMacro ? '#define GR_W_MACRO\n' : ''}`;
    if (wMacro) Object.assign(sh.uniforms, GROUND.groundUniforms?.() ?? {});
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', defs + grassVertexPars(wMacro ? GROUND.GROUND_GLSL : '') + '\nvoid main() {\n  vec3 grPos; vec3 grNormal;\n' + GRASS_VERTEX_BODY)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = grNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = grPos;');
    let frag = sh.fragmentShader
      .replace('void main() {', grassFragmentPars() + sunGlobalsPars(sun) + '\nvoid main() {')
      .replace('#include <color_fragment>', GRASS_COLOR_FRAG)
      .replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL_BEGIN)
      .replace('#include <lights_fragment_begin>', sun.lightsChunk + '\n' + grassLightFrag(sun.sunC, sun.sunD));
    sh.fragmentShader = frag;
  });
  return mat;
}

// ------------------------------------------------------------------------------------------------ system
export function createGrass(app, opts = {}) {
  const { scene, camera } = app;
  const ground = vegGround(app);
  const shared = {
    uDensityMul: { value: 1 },
    uHeightMul: { value: 1 },
    uPixelWorld: { value: 0.001 },
    ground: ground.uniforms,
  };

  const l2 = opts.l2Radius ?? 90;
  const tiers = TIERS.map((t, i) => {
    const tier = { ...t, ring: t.ring.slice() };
    if (i === 2) { tier.ring[2] = l2 - 10; tier.ring[3] = l2; }
    tier.k0 = tier.k;
    tier.tiles = new TileRing(app, { tile: tier.tile, k: tier.k, ring: tier.ring, cap: tier.cap, max: MAX_TILES, pad: 1.8 });
    tier.uniforms = { ...tier.tiles.uniforms, uWidthMul: { value: tier.width } };
    tier.geo = bladeGeometry(tier.segs);
    tier.mat = grassMaterial(tier, i, shared);
    const mesh = new THREE.Mesh(tier.geo, tier.mat);
    mesh.name = `grass-${tier.name}`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = tier.order;
    mesh.layers.set(LAYERS.MAIN_ONLY);
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    tier.mesh = mesh;
    tier.count = 0;
    return tier;
  });

  const frustum = new THREE.Frustum();
  const pv = new THREE.Matrix4();

  const grass = {
    tiers, meshes: tiers.map((t) => t.mesh), shared,
    /** k: one factor for every tier, or [L0, L1, L2] (far tiers can thin out more: wider blades keep the cover). */
    setDensity(k) {
      for (const [i, t] of tiers.entries()) {
        t.tiles.setDensity(Math.max(0.1, Array.isArray(k) ? k[i] ?? k[k.length - 1] : k));
        const kk = t.uniforms.uK.value;
        t.uniforms.uWidthMul.value = t.width * Math.sqrt(t.k0 / kk);
      }
    },
    setHeight(k) { shared.uHeightMul.value = k; },
    stats() {
      let blades = 0, tris = 0;
      for (const t of tiers) { blades += t.geo.instanceCount; tris += t.geo.instanceCount * (2 * t.segs - 1); }
      return { tiles: tiers.map((t) => t.count), blades, tris };
    },
    update() {
      const H = app.pipeline?.H || app.renderer.domElement.height || 900;
      shared.uPixelWorld.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)) / H;
    },
    lateUpdate() {
      // tiles are picked with the final camera pose (gameplay cameras move in update())
      cameraFrustum(camera, frustum, pv);
      for (const t of tiers) {
        t.count = t.tiles.select(camera.position, frustum);
        t.geo.instanceCount = t.count * t.tiles.perTile;
        t.mesh.visible = t.count > 0;
      }
    },
  };
  if (opts.density !== undefined && opts.density !== 1) grass.setDensity(opts.density);   // number or per-tier array
  app.add(grass);
  return grass;
}
