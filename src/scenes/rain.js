// Weather test scene (X): night storm 竹林夜雨 look-dev — environment + terrain (+ optional grass) + rain + lightning.
//   ?scene=rain[&level=bamboo&bamboo=1&lanterns=1][&mood=night][&sound=0][&storm=0.7][&rain=1][&wet=1][&grass=1][&flash=0][&view=road|hero|low|wide][&orbit=0]
// Harness hooks: window.__rain = { rain, storm, env, view(name), strike(opts), wet(k) }.
import * as THREE from 'three';
import { G } from '../core/globals.js';

const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

const VIEWS = {
  road: { pos: [-30, 1.65, 37.5], target: [18, 0.6, 24] },     // along the dirt road (ruts + puddles)
  low: { pos: [-12, 0.7, 33.2], target: [12, 0.2, 27] },       // puddle-level
  hero: { pos: [0, 1.7, 40], target: [0, 1.4, 0] },
  wide: { pos: [-40, 4.5, 60], target: [20, 0, 10] },
  clearing: { pos: [2, 1.6, 12], target: [-2, 1.2, -4] },      // bamboo level: across the clearing
  path: { pos: [-14, 1.5, 7.5], target: [8, 0.8, -4] },        // bamboo level: along the path, lanterns
};

export default async function (app) {
  const p = app.params;
  const step = async (v, label) => { app.progress(v, label); await nextTick(); };
  const mood = p.get('mood') || 'night';

  await step(0.05, '天 · sky');
  const { createEnvironment } = await import('../world/environment.js');
  const env = createEnvironment(app, { mood, drift: false });
  const storm = +(p.get('storm') ?? 0.7);
  env.setStorm(storm, 0.001);

  await step(0.15, '地 · earth');
  const { createTerrain } = await import('../world/terrain.js');
  await createTerrain(app);
  if (p.get('grass') === '1') {
    await step(0.5, '草 · grass');
    try {
      await (await import('../world/interaction.js')).createInteraction(app);
      await (await import('../world/grass.js')).createGrass(app);
    } catch (e) { console.error('[rain scene] grass failed', e); }
  }
  if (p.get('bamboo') === '1') {
    await step(0.6, '竹 · bamboo');
    try {
      const { LAYOUT } = await import('../world/layout.js');
      const b = LAYOUT.biome?.bamboo ?? {};
      await (await import('../world/bamboo.js')).createBamboo(app, { clearR: b.clearR, inner: b.inner, outer: b.outer, density: b.density, height: b.height });
    } catch (e) { console.error('[rain scene] bamboo failed', e); }
  }
  if (p.get('lanterns') === '1') {   // warm pools of light (the level's stone lanterns, as virtual lamps only)
    const { lamps } = await import('../core/lamps.js');
    const { LAYOUT } = await import('../world/layout.js');
    for (const l of LAYOUT.lanterns ?? [{ x: -7.5, z: 5.5 }, { x: 8.5, z: -4.5 }, { x: -10.5, z: 11 }, { x: -3.5, z: -11 }]) {
      lamps.add({ pos: new THREE.Vector3(l.x, app.world.heightAt(l.x, l.z) + 1.1, l.z), color: [1.0, 0.55, 0.22], weight: 4, flicker: 0.15 });
    }
  }
  if (p.get('mountains') !== '0') {
    try { await (await import('../world/mountains.js')).createMountains(app); } catch (e) { console.error(e); }
  }

  await step(0.8, '雨 · rain');
  const { createRain } = await import('../fx/rain.js');
  const { createLightning } = await import('../fx/storm.js');
  const rain = createRain(app, { intensity: +(p.get('rain') ?? 1), wet: false });
  G.uWet.value = +(p.get('wet') ?? 1);
  const lightning = createLightning(app, env, { interval: [5, 7], enabled: p.get('flash') !== '0' });
  // sound (starts on the first click / key): rain bed + thunder from the bus events above
  const audio = p.get('sound') === '0' ? null : await (await import('../audio/audio.js')).createAudio(app);

  const heightAt = app.world.heightAt;
  const view = (name) => {
    const v = VIEWS[name] || VIEWS.road;
    const pos = [v.pos[0], heightAt(v.pos[0], v.pos[2]) + v.pos[1], v.pos[2]];
    const target = [v.target[0], heightAt(v.target[0], v.target[2]) + v.target[1], v.target[2]];
    app.setView({ pos, target, fov: 48 });
    const f = new THREE.Vector3(pos[0] + (target[0] - pos[0]) * 0.3, 0, pos[2] + (target[2] - pos[2]) * 0.3);
    f.y = heightAt(f.x, f.z);
    env.setShadowFocus(f);
  };
  if (p.get('orbit') !== '0') app.debugControls();
  view(p.get('view') || 'road');

  window.__rain = {
    rain, storm: lightning, env, audio, view, strike: (o) => lightning.strike(o),
    wet: (k) => { G.uWet.value = k; },
  };
  app.progress(1, '');
  await app.ready();
}
