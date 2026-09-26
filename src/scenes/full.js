// The full game: composes every area module. Owner: integrator.
// Each module is loaded defensively so one failing area never takes the whole game down (errors are logged and
// surfaced in window.__integration for the harness).
import * as THREE from 'three';

const report = (window.__integration = { ok: [], failed: [] });

// The area modules, listed for the bundler (a production build cannot follow a runtime import path); lazy chunks.
const MODULES = import.meta.glob(['../world/*.js', '../fx/*.js', '../ui/*.js', '../audio/*.js', '../game/*.js', '../levels/*.js']);

async function load(label, path, fn, ...args) {
  try {
    const mod = await (MODULES[path] ? MODULES[path]() : import(/* @vite-ignore */ path));
    if (typeof mod[fn] !== 'function') throw new Error(`${path} has no export ${fn}`);
    const out = await mod[fn](...args);
    report.ok.push(label);
    return out;
  } catch (err) {
    console.error(`[full] ${label} failed:`, err);
    report.failed.push({ label, error: String(err?.stack || err) });
    return null;
  }
}

// Yield to the browser between build stages so the loader keeps animating.
const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

export default async function (app) {
  const p = app.params;
  const step = async (v, label) => { app.progress(v, label); await nextTick(); };
  // the level (src/levels): world/layout.js has already applied its layout, terrain shape and biome
  const { LEVEL } = await import('../levels/index.js');
  const { LAYOUT } = await import('../world/layout.js');
  const BI = LAYOUT.biome, EV = LEVEL.env ?? {};
  app.level = LEVEL;

  // townsfolk bodies build in the workers while the world loads (world/citizens.js)
  if (BI.citizens) import('../world/citizens.js').then((m) => m.prefetchCitizens?.()).catch(() => {});

  await step(0.05, '天 · sky');
  const env = await load('environment', '../world/environment.js', 'createEnvironment', app,
    { mood: p.get('mood') || EV.mood || 'golden', drift: EV.drift ?? true });
  if (env && EV.u !== undefined && !p.has('mood')) env.setU?.(EV.u, 0);
  if (env && EV.storm) env.setStorm?.(EV.storm, 0);
  if (env && EV.exposure) env.exposureMul = EV.exposure;

  await step(0.14, '地 · earth');
  const terrain = await load('terrain', '../world/terrain.js', 'createTerrain', app);
  await step(0.28, '山 · mountains');
  await load('mountains', '../world/mountains.js', 'createMountains', app);
  await step(0.34, '石 · stone');
  await load('rocks', '../world/rocks.js', 'createRocks', app);
  await load('props', '../world/props.js', 'createProps', app);

  await step(0.44, '风 · wind');
  const interaction = await load('interaction', '../world/interaction.js', 'createInteraction', app);
  await step(0.5, '草 · grass');
  // density per tier from the quality preset (core/quality.js): near stays dense, far tiers thin out behind wider blades
  const grass = await load('grass', '../world/grass.js', 'createGrass', app, { density: app.quality?.grass ?? [1.15, 0.85, 0.65] });
  if (grass && BI.grassHeight) grass.setHeight(BI.grassHeight);
  app.grass = grass;
  { const { applyQuality } = await import('../core/quality.js'); const { bus } = await import('../core/bus.js');
    bus.on('ui:quality', (p) => applyQuality(app, p.name, { grass })); }
  await step(0.6, '花 · flowers');
  if (BI.flowers || BI.plumes) await load('flora', '../world/flora.js', 'createFlora', app, { flowers: BI.flowers, plumes: BI.plumes });
  await step(0.66, BI.bamboo ? '竹 · bamboo' : '树 · tree');
  await load('trees', '../world/trees.js', 'createTrees', app, { hero: BI.heroTree, pines: BI.pines, band: BI.band });
  if (BI.bamboo) {
    const { roadQuery } = await import('../world/terrain-field.js');
    const B = BI.bamboo;
    await load('bamboo', '../world/bamboo.js', 'createBamboo', app, {
      center: { x: LAYOUT.knoll.x, z: LAYOUT.knoll.z }, clearR: B.clearR, inner: B.inner, outer: B.outer, density: B.density, height: B.height,
      keepOut: [{ ...LAYOUT.pavilion, r: LAYOUT.pavilion.r + 3 }, { x: LAYOUT.stele.x, z: LAYOUT.stele.z, r: 2.5 }, { x: LAYOUT.playerSpawn.x, z: LAYOUT.playerSpawn.z, r: 4 }],
      path: (x, z) => roadQuery(x, z, false).d, pathClear: B.pathClear, seed: 7,
      ...({ low: { lod0: 22, midKeep: 0.45 }, med: { lod0: 26, midKeep: 0.58 }, high: { lod0: 32, midKeep: 0.7 } }[app.quality?.name ?? 'med']),
      // camera-occlusion fade: culms between the camera and the hero dither out (the game exists by the first frame)
      focus: (() => { const v = new THREE.Vector3(); return () => { const P = window.__full?.game?.player; return P ? P.chest(v) : null; }; })(),
    });
  }

  if (BI.town) {
    await step(0.69, '街 · street');
    app.town = await load('town', '../world/town.js', 'createTown', app, { town: LAYOUT.town });
  }
  await step(0.72, '尘 · motes');
  const vfx = await load('vfx', '../fx/vfx.js', 'createVFX', app, { interaction });
  await load('ambient', '../fx/ambient.js', 'createAmbient', app);
  // weather: rain + wet ground (fx/rain.js; G.uWet drives the terrain material)
  let rain = null;
  // wet: false — the level sets the ground wetness itself (it has been raining for hours, not 14 s)
  if (EV.rain) rain = await load('rain', '../fx/rain.js', 'createRain', app, { intensity: EV.rain, wet: !EV.wet });
  if (EV.wet) { const { G } = await import('../core/globals.js'); if (G.uWet) G.uWet.value = EV.wet; }

  await step(0.8, '声 · sound');
  const hud = await load('hud', '../ui/hud.js', 'createHUD', app);
  const audio = await load('audio', '../audio/audio.js', 'createAudio', app);

  await step(0.86, '剑 · sword');
  const game = await load('game', '../game/game.js', 'createGame', app, { env, terrain, grass, vfx, hud, audio, interaction });
  // phones and tablets: thumb-stick, look drag and brush buttons (?touch=1 forces them, ?touch=0 turns them off)
  if (game && hud) await load('touch', '../ui/touch.js', 'createTouchControls', app, { game, hud });

  // townsfolk (they need the game for the danger points: the hero and the living enemies)
  let citizens = null;
  if (BI.citizens && game) {
    citizens = await load('citizens', '../world/citizens.js', 'createCitizens', app, {
      count: Math.round(BI.citizens * ({ low: 0.5, med: 0.72, high: 1 }[app.quality?.name ?? 'med'] ?? 0.72)), town: LAYOUT.town,
      avoid: () => [game.player, ...game.enemies.filter((e) => e.active && e.alive)].map((a) => ({ x: a.pos.x, z: a.pos.z, r: 4 })),
    });
  }
  await step(0.96, '');
  if (!game) {
    // no gameplay yet: frame the hero view so the world can still be judged
    const y = app.world.heightAt(0, 40);
    app.setView({ pos: [0, y + 1.7, 44], target: [0, y + 1.2, 0] });
    env?.setShadowFocus?.(new THREE.Vector3(0, y, 40));
  }
  window.__full = { env, terrain, grass, vfx, hud, audio, game, interaction, rain, citizens, level: LEVEL };
  // the level's own weather beats (lightning + thunder), and the next-level link on the victory screen
  await load('level', '../levels/runtime.js', 'createLevelRuntime', app, { env, level: LEVEL });
  app.progress(1, '');
  await app.ready();
}
