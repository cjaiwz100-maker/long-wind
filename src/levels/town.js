// 第三章 · 长街灯火 — a Jiangnan market town at dusk: one long lantern-lit street (along x) with shophouses on both
// sides, a plaza at its heart (the fighting ground, with the opera stage 戏台 on its north side and a 牌坊 at each
// street mouth), a canal crossing the street east of the plaza under an arched stone bridge. Townsfolk fill the street
// until the fight starts; then they scatter. Owner: integrator.
//
// layout.town (read by world/town.js and world/citizens.js; all metres, street centreline z = 0):
//   street {x0, x1, width}        paved street (the terrain road runs along it too)
//   plaza {x, z, w, d}            open square (x-extent w, z-extent d), buildings stand back from it
//   frontage                      facade line distance from the street centreline (both sides)
//   depth                         shophouse depth behind the facade
//   alleys [x...]                 gaps between house rows (enemies and townsfolk come and go through them)
//   canal {x, width, depth}       canal crossing the street (along z); the terrain carves it except under the bridge
//   bridge {x, span, rise}        the street's arched bridge (the terrain arches the walkway, town.js builds the stone)
//   stage {x, z, yaw}             opera stage facing the plaza
//   paifang [{x, z, yaw}]         memorial archways at the plaza's street mouths
export default {
  id: 'town', no: '第三章', title: '长街灯火', en: 'Lanterns on the Long Street',
  tagline: '灯市 · 人声', enTagline: 'the whole town is watching',
  env: { mood: 'ember', u: 0.772, drift: false, storm: 0, rain: 0, wet: 0.3, wind: 0.7, exposure: 1.25, victoryMood: null },
  layout: {
    arenaRadius: 46, playableRadius: 46,
    playerSpawn: { x: 12, z: 0, yaw: -Math.PI / 2 },
    knoll: { x: 0, z: 0, r: 30, padR: 16 },
    duelCircle: { x: 0, z: 0, r: 13 },
    oldTree: { x: 900, z: 900, r: 0.5, crown: 2 },
    stele: { x: 900, z: -900, r: 0.5, yaw: 0 },
    pavilion: { x: -900, z: 900, r: 4, yaw: 0 },
    graves: [], cairn: { x: 900, z: 900, r: 0.5 }, higanbana: [],
    rockOutcrops: [{ x: -60, z: -120, r: 10, size: 5, n: 3 }, { x: 90, z: 130, r: 10, size: 5, n: 3 }],
    standingStones: [],
    road: [[-500, 0], [-250, 0], [-120, 0], [0, 0], [120, 0], [250, 0], [500, 0]],
    roadWidth: 8,
    roadMarkers: [],
    enemySpawns: [],
    views: { hero: { pos: [16, 1.7, 0], target: [0, 1.5, 0] }, aerial: { pos: [40, 45, 60], target: [0, 0, 0] } },
    town: {
      street: { x0: -130, x1: 130, width: 8 },
      plaza: { x: 0, z: 0, w: 34, d: 28 },
      frontage: 5.2, depth: 9,
      alleys: [-62, -38, 27, 52, 78],
      canal: { x: 40, width: 9, depth: 2.2 },
      bridge: { x: 40, span: 13, rise: 1.3 },
      stage: { x: 0, z: -15.5, yaw: 0 },
      paifang: [{ x: -18.5, z: 0, yaw: Math.PI / 2 }, { x: 18.5, z: 0, yaw: Math.PI / 2 }],
    },
  },
  // a town on a river plain: nearly flat, far low hills
  terrain: { swell: 1.5, undul: 0.35, hummock: 0.04, knollH: 0, knollR: 30, sunRidge: 0, rim: 70, edgeRise: 3, siteFlatten: 0.9 },
  biome: {
    grassDensity: 0.12, drySpread: 0.35, dirt: 0.55,
    heroTree: false, pines: 2, band: 1500, flowers: false, plumes: false,
    props: { stele: false, graves: false, cairn: false, markers: false, pavilion: false },
    town: true, citizens: 28,
  },
  // they come out of the alleys and drop from the eaves (spawn.eaves: some of each wave leap down from the roofs)
  spawn: { ring: true, r: 17, eaves: 0.4 },
  waves: [
    { title: '灯市', sub: 'The Lantern Market', enemies: ['bandit', 'bandit', 'bandit', 'bandit'], wind: 0.7, maxAttackers: 2 },
    { title: '惊鸿', sub: 'A Startled Crowd', enemies: ['spearman', 'bandit', 'archer', 'bandit', 'shieldman'], wind: 0.8, maxAttackers: 2 },
    { title: '檐上', sub: 'From the Eaves', enemies: ['archer', 'archer', 'spearman', 'bandit_heavy', 'bandit', 'shieldman'], wind: 0.9, maxAttackers: 2 },
    { title: '戏台', sub: 'Before the Opera Stage', enemies: ['swordmaster'], wind: 1.1, windPhase2: 1.6, boss: true, maxAttackers: 1,
      name: '寒山客', bossSub: 'Master of Cold Mountain' },
  ],
  next: null,
};
