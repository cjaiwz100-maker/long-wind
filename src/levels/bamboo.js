// 第二章 · 比捷试峰 — a clearing deep in a bamboo grove, night, heavy rain, lightning. The path the hero came by
// runs through the clearing; the bandits come out of the culms on every side.
export default {
  id: 'bamboo', no: '第二章', title: '比捷试峰', en: 'Night Rain in the Bamboo',
  tagline: '竹声 · 雨声', enTagline: 'the rain hides the footsteps',
  env: { mood: 'blue', u: 0.79, drift: false, storm: 0.45, rain: 1, wet: 1, wind: 1.15, lightning: [7, 16], exposure: 1.6, victoryMood: null },
  layout: {
    arenaRadius: 60, playableRadius: 60,
    playerSpawn: { x: 0, z: 11, yaw: Math.PI },
    knoll: { x: 0, z: 0, r: 26, padR: 9 },
    duelCircle: { x: 0, z: 0, r: 14 },
    oldTree: { x: 900, z: 900, r: 0.5, crown: 2 },          // no golden tree here (kept far away: code reads it)
    stele: { x: -5.5, z: -6.5, r: 0.75, yaw: 0.6 },         // a moss-dark stele at the clearing edge
    pavilion: { x: 21, z: -27, r: 4.2, yaw: 0.9 },          // a wayside pavilion on the path, half-swallowed by bamboo
    graves: [], cairn: { x: 900, z: 900, r: 0.5 }, higanbana: [],
    rockOutcrops: [
      { x: 11, z: 7, r: 1.8, size: 1.7, n: 2 },
      { x: -12, z: 4, r: 2.2, size: 2.1, n: 2 },
      { x: 6, z: -13, r: 1.6, size: 1.4, n: 1 },
      { x: -40, z: -35, r: 6, size: 3.6, n: 3 },
      { x: 45, z: 20, r: 6, size: 3.4, n: 3 },
    ],
    standingStones: [],
    road: [[-320, 140], [-170, 80], [-70, 34], [-24, 12], [0, 3], [16, -8], [30, -24], [46, -58], [64, -140], [110, -320]],
    roadWidth: 1.8,
    roadMarkers: [],
    enemySpawns: [{ x: -26, z: -12 }, { x: 22, z: 14 }, { x: -8, z: -26 }, { x: 26, z: -6 }, { x: -20, z: 18 }],
    views: {
      hero: { pos: [0, 1.7, 11], target: [0, 1.4, 0] },
      aerial: { pos: [30, 40, 50], target: [0, 0, 0] },
    },
  },
  terrain: { swell: 7, undul: 3.2, undulFreq: 0.02, hummock: 0.45, knollH: 1.0, knollR: 30, sunRidge: 0, rim: 120, siteFlatten: 0.8 },
  biome: {
    grassDensity: 0.28, drySpread: 0.15, dirt: 0.3,
    leafCarpet: { inner: 10, outer: 600, amount: 0.9 },     // bamboo leaf litter everywhere but the clearing's heart
    heroTree: false, pines: 0, band: 1200, flowers: false, plumes: false,
    bamboo: { clearR: 17, inner: 16, outer: 230, pathClear: 2.2, density: 1, height: [10, 16] },
    props: { graves: false, cairn: false, markers: false },
  },
  // stone lanterns at the clearing edge: warm pools of light in the blue rain
  lanterns: [{ x: -7.5, z: 5.5, yaw: 0.3 }, { x: 8.5, z: -4.5, yaw: 1.1 }, { x: -10.5, z: 11, yaw: -0.4 }, { x: -3.5, z: -11, yaw: 0.8 }],
  // enemies step out of the culms all round the clearing (not from the sun: there is none)
  spawn: { ring: true, r: 21 },
  waves: [
    { title: '夜雨', sub: 'Night Rain', enemies: ['bandit', 'bandit', 'bandit'], wind: 1.1, maxAttackers: 1 },
    { title: '竹影', sub: 'Shadows in the Bamboo', enemies: ['archer', 'bandit', 'spearman', 'archer', 'bandit'], wind: 1.2, maxAttackers: 2 },
    { title: '惊雷', sub: 'Thunder', enemies: ['shieldman', 'spearman', 'bandit_heavy', 'archer', 'bandit', 'spearman'], wind: 1.35, maxAttackers: 2 },
    { title: '断岳', sub: 'The Mountain-Breaker', enemies: ['bandit_heavy', 'shieldman', 'shieldman', 'archer'], wind: 1.4, maxAttackers: 2 },
    // the boss: 夜枭 alone in the rain — he vanishes into it and strikes from behind; the lightning shows him
    { title: '夜枭', sub: 'The Night Owl', enemies: ['assassin'], wind: 1.6, windPhase2: 2.1, boss: true, maxAttackers: 1 },
  ],
  next: 'town',
};
