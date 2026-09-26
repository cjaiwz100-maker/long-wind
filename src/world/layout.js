// World layout: named places shared by terrain, vegetation, props and gameplay. Owner: world (W).
// Per level (src/levels/*.js): the values below are the steppe's; a level overrides fields, `terrain` and `biome`.
import { getLevel, levelIdFromEnv } from '../levels/index.js';

// Coordinates in metres, +Y up, the duel knoll crest is the origin. Others READ ONLY.
//
// Composition (bible §0.1, §1.3): the sun sits low toward −x −z (SUN_DIR xz ≈ (−0.61, −0.79)). The player spawns at
// (0, 40) looking −z at the knoll, so the default view is contre-jour: the lone golden tree stands left of centre near
// the sun, its long shadow crossing the view; the stele marks the fighting pad; the road sweeps across the foreground
// and recedes to the right toward the wayside pavilion. Bandits come out of the sun (enemySpawns all sit within ±40°
// of the sun azimuth, 70–90 m out) and read as dark silhouettes against the amber haze.
//
// Field reference (all {x, z} in metres; r = footprint radius):
//   arenaRadius / playableRadius  soft boundary (wind pushback, fog, rising ground)
//   playerSpawn {x, z, yaw}       yaw = π faces −z
//   knoll {x, z, r, padR}         duel knoll centre; padR = flat fighting pad radius
//   duelCircle {x, z, r}          open meadow where most fights happen (short, trampled grass)
//   oldTree {x, z, r, crown}      lone golden poplar (trees.js, V); r = trunk radius, crown = canopy radius
//   stele {x, z, r, yaw}          weathered stone stele (props.js)
//   pavilion {x, z, r, yaw}       hexagonal wayside pavilion 亭 on a low rise beside the road (props.js)
//   graves [{x, z, yaw}] / cairn  old graves and a stone cairn near the higanbana patch (props.js)
//   higanbana [{x, z, r}]         red spider-lily patch centres (flowers, V): by the graves and the stele
//   rockOutcrops [{x, z, r, size, n}]  boulder clusters (rocks.js); size = hero boulder size (m), n = boulder count
//   standingStones [{x, z, h}]    tall weathered stones by the road
//   road [[x, z], ...]            Catmull-Rom control points of the dirt road (terrain grades + textures it)
//   roadWidth                     travelled width (m)
//   roadMarkers [{s|x,z}]         stone road markers (props.js)
//   enemySpawns [{x, z}]          bandit entry points, all on the sun side
//   views {name: {pos, target}}   camera bookmarks (y is metres ABOVE the ground at that xz)
//   sunAzimuthDeg                 compass-ish azimuth of the sun seen from the knoll (atan2(x, z) of SUN_DIR, degrees)
const BASE_LAYOUT = {
  arenaRadius: 180,
  playableRadius: 180,
  playerSpawn: { x: 0, z: 40, yaw: Math.PI },
  knoll: { x: 0, z: 0, r: 40, padR: 7 },
  duelCircle: { x: 0, z: 0, r: 16 },
  oldTree: { x: -20, z: -14, r: 0.8, crown: 9 },
  stele: { x: 4, z: 3, r: 0.75, yaw: -1.26 },   // face turned 20° into the sun: raking light on the carving
  pavilion: { x: 95.7, z: -87, r: 4.2, yaw: 0.66 },
  graves: [
    { x: -9.5, z: -26.5, yaw: 0.35 },
    { x: -13.2, z: -28.2, yaw: 0.28 },
    { x: -6.4, z: -29.4, yaw: 0.5 },
  ],
  cairn: { x: -15.5, z: -23.8, r: 0.9 },
  higanbana: [
    { x: -10.5, z: -25.5, r: 7 },
    { x: 6.5, z: 5.5, r: 2.6 },
    { x: -26, z: -12, r: 4 },
  ],
  rockOutcrops: [
    { x: -14, z: 7, r: 2.6, size: 2.4, n: 2 },     // knoll edge, left of the default view line (a seat-high boulder pair)
    { x: 13, z: -9.5, r: 3.4, size: 3.2, n: 3 },   // knoll edge, right-behind the pad
    { x: 10.5, z: 13.5, r: 1.8, size: 1.5, n: 1 },
    { x: -60, z: 22, r: 10, size: 5.2, n: 4 },     // west outcrop beyond the road
    { x: 46, z: -34, r: 8, size: 4.2, n: 3 },      // by the road bend
    { x: -38, z: -92, r: 9, size: 5.6, n: 4 },     // sun side: silhouettes against the haze
    { x: 112, z: 36, r: 11, size: 5.4, n: 4 },
    { x: -120, z: -28, r: 13, size: 6.2, n: 5 },
    { x: 28, z: 74, r: 7, size: 3.6, n: 2 },       // behind the spawn (anti-solar view)
    { x: -96, z: 92, r: 9, size: 4.8, n: 3 },
    { x: 150, z: -40, r: 10, size: 5.0, n: 3 },
    { x: -10, z: -150, r: 11, size: 6.0, n: 4 },
  ],
  standingStones: [
    { x: -34.1, z: 41.2, h: 2.6 },
    { x: 65.5, z: -23.1, h: 2.2 },
    { x: 83.3, z: -75.1, h: 3.0 },
  ],
  // Dirt road: enters behind-left of the spawn, crosses the foreground just in front of the player, then bends away
  // to the right, climbing past the pavilion and on toward the far south-east swells.
  road: [
    [-620, 210], [-460, 150], [-270, 96], [-130, 55], [-48, 36], [0, 29], [36, 17], [56, -12], [66, -48],
    [79, -80], [112, -122], [190, -182], [320, -246], [500, -300], [700, -350],
  ],
  roadWidth: 3.2,
  roadMarkers: [{ x: -83.6, z: 46.4 }, { x: 50.7, z: 4.5 }, { x: 100.8, z: -106.4 }, { x: -205.1, z: 73.8 }],
  enemySpawns: [
    { x: -49, z: -63 }, { x: -24, z: -76 }, { x: -67, z: -43 }, { x: 4, z: -85 }, { x: -83, z: -18 },
  ],
  views: {
    hero: { pos: [0, 1.7, 40], target: [0, 1.4, 0] },
    sun: { pos: [9, 1.5, 12], target: [-52, 6, -68] },
    away: { pos: [-6, 1.8, -8], target: [60, 8, 78] },
    aerial: { pos: [95, 70, 150], target: [0, 0, 0] },
    knoll: { pos: [-0.2, 1.6, 5.6], target: [4, 1.25, 3] },          // in front of the stele's inscription
    pavilion: { pos: [112, 2.0, -66], target: [95.7, 3.2, -87] },
  },
  sunAzimuthDeg: -142.6,
};

// Terrain shape (terrain-field.js H0) and biome (terrain-bake.js, full.js module choice) defaults = the steppe.
const BASE_TERRAIN = {
  swell: 16, swellFreq: 0.0035, undul: 2.6, undulFreq: 0.014, hummock: 0.3, knollH: 2.9, knollR: 34,
  sunRidge: 2.6, rim: 95, edgeRise: 6, siteFlatten: 0.72,
};
const BASE_BIOME = {
  grassDensity: 1, drySpread: 0.55, dirt: 0, leafCarpet: null,   // leafCarpet: {inner, outer, amount} — forest-floor litter ring
  heroTree: true, pines: 3, band: 3000, flowers: true, plumes: true, bamboo: null,
  props: { stele: true, markers: true, graves: true, cairn: true, pavilion: true },
};

/**
 * The live layout. A level (src/levels) overrides any of the fields above plus `terrain` and `biome`; the object is
 * mutated in place so every module holding the import sees the level's values. Main thread: picked from ?level= at
 * import. Terrain workers: terrain-pool.js sends the level id with each job (applyLevelLayout).
 */
export const LAYOUT = {};
const resetHooks = [];
/** Modules with caches derived from the layout (road LUT, …) register a reset. */
export function onLayoutReset(fn) { resetHooks.push(fn); }
export function applyLevelLayout(id) {
  const L = getLevel(id);
  for (const k of Object.keys(LAYOUT)) delete LAYOUT[k];
  Object.assign(LAYOUT, JSON.parse(JSON.stringify(BASE_LAYOUT)), JSON.parse(JSON.stringify(L.layout ?? {})));
  LAYOUT.terrain = { ...BASE_TERRAIN, ...(L.terrain ?? {}) };
  LAYOUT.biome = { ...BASE_BIOME, ...(L.biome ?? {}), props: { ...BASE_BIOME.props, ...(L.biome?.props ?? {}) } };
  LAYOUT.levelId = L.id;
  for (const f of resetHooks) f();
  return LAYOUT;
}
applyLevelLayout(levelIdFromEnv());


/** Return a named camera bookmark with absolute y (adds the ground height at pos / target). */
export function viewBookmark(name, heightAt) {
  const v = LAYOUT.views[name] || LAYOUT.views.hero;
  const [px, py, pz] = v.pos, [tx, ty, tz] = v.target;
  return { pos: [px, heightAt(px, pz) + py, pz], target: [tx, heightAt(tx, tz) + ty, tz] };
}
