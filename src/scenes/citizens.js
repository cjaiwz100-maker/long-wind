// Townsfolk review scene: the town level's dusk + terrain (+ the town's buildings once world/town.js exists) and
// the crowd (world/citizens.js). Open as ?scene=citizens&level=town.
//   &view=street|plaza|wide|close|alley   &count=28   &hero=walk|stand|none (a stand-in danger point)   &panic=1
//   &sound=1 (crowd audio; starts on the first click)   &orbit=0
// Hooks: window.__citizens = { crowd, env, view(name), setPanic(k), hero: {x, z}, stats() }.
import * as THREE from 'three';

const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
const TOWN = import.meta.glob('../world/town.js');

const VIEWS = {
  street: { pos: [34, 1.7, 1.6], target: [4, 1.3, -0.5], fov: 50 },
  plaza: { pos: [15.5, 1.7, 9], target: [-4, 1.2, -3], fov: 55 },
  close: { pos: [9, 1.65, 4], target: [2, 1.0, 0], fov: 45 },
  wide: { pos: [46, 14, 26], target: [2, 0, 0], fov: 50 },
  alley: { pos: [30, 1.7, -2], target: [22, 1.0, 5], fov: 50 },
};

export default async function (app) {
  const p = app.params;
  const step = async (v, label) => { app.progress(v, label); await nextTick(); };
  await step(0.05, '天 · sky');
  // the level's own light (levels/town.js env), like scenes/full.js; ?mood= / ?u= override
  const { LEVEL } = await import('../levels/index.js');
  const EV = LEVEL.env ?? {};
  const { createEnvironment } = await import('../world/environment.js');
  const env = createEnvironment(app, { mood: p.get('mood') || EV.mood || 'ember', drift: false });
  if (p.has('u') || (!p.has('mood') && EV.u !== undefined)) env.setU?.(+(p.get('u') ?? EV.u), 0);
  if (EV.exposure) env.exposureMul = EV.exposure;
  if (EV.wet) { const { G } = await import('../core/globals.js'); if (G.uWet) G.uWet.value = EV.wet; }
  await step(0.15, '地 · earth');
  const { createTerrain } = await import('../world/terrain.js');
  await createTerrain(app);
  const { LAYOUT } = await import('../world/layout.js');
  if (TOWN['../world/town.js'] && p.get('town') !== '0') {
    await step(0.4, '街 · street');
    try { await (await TOWN['../world/town.js']()).createTown(app, { town: LAYOUT.town }); } catch (e) { console.warn('[citizens scene] town failed', e); }
  }

  await step(0.55, '人 · townsfolk');
  const hero = { x: 2, z: 1, r: 4, on: (p.get('hero') ?? 'walk') !== 'none', walk: (p.get('hero') ?? 'walk') === 'walk' };
  const heroMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.1, 4, 10), new THREE.MeshStandardMaterial({ color: 0x8a1c1c, roughness: 0.7 }));
  heroMesh.geometry.translate(0, 0.83, 0); heroMesh.layers.set(3); heroMesh.visible = hero.on; app.scene.add(heroMesh);
  const t0 = performance.now();
  const { createCitizens } = await import('../world/citizens.js');
  const crowd = await createCitizens(app, {
    count: +(p.get('count') ?? LAYOUT.biome?.citizens ?? 28), town: LAYOUT.town,
    avoid: () => (hero.on ? [hero] : []), maxWait: +(p.get('wait') ?? 2500),
  });
  const loadMs = Math.round(performance.now() - t0);
  // the stand-in hero strolls a loop through the plaza (a danger point for the crowd)
  let ht = 0;
  app.add({
    update(dt) {
      ht += dt;
      if (hero.walk) { hero.x = Math.sin(ht * 0.12) * 9; hero.z = Math.sin(ht * 0.24) * 6; }
      heroMesh.position.set(hero.x, app.world.heightAt(hero.x, hero.z), hero.z);
      heroMesh.visible = hero.on;
    },
  });
  const audio = p.get('sound') === '1' ? await (await import('../audio/audio.js')).createAudio(app) : null;

  const heightAt = app.world.heightAt;
  const view = (name) => {
    const v = VIEWS[name] || VIEWS.street;
    const pos = [v.pos[0], heightAt(v.pos[0], v.pos[2]) + v.pos[1], v.pos[2]];
    const target = [v.target[0], heightAt(v.target[0], v.target[2]) + v.target[1], v.target[2]];
    app.setView({ pos, target, fov: v.fov });
    env.setShadowFocus?.(new THREE.Vector3(pos[0] + (target[0] - pos[0]) * 0.35, heightAt(pos[0], pos[2]), pos[2] + (target[2] - pos[2]) * 0.35));
  };
  if (p.get('orbit') !== '0') app.debugControls();
  view(p.get('view') || 'street');
  if (p.has('panic')) crowd.setPanic(+p.get('panic'));

  // ?lineup=1: one of each look in a row facing the camera (look review); the others are sent down the street
  const lineup = (side = +(p.get('side') ?? 1)) => {
    const seen = new Map();
    for (const c of crowd.list) { const k = crowd.LOOKS.indexOf(c.spec); if (!seen.has(k)) seen.set(k, c); }
    const row = [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    row.forEach((c, k) => {
      c.state = 'pose'; c.legs.length = 0; c.vx = c.vz = 0; c.look = null;
      c.pos.set(-6 + k * 1.5, 0, 0); c.pos.y = heightAt(c.pos.x, 0); c.yaw = side > 0 ? 0 : Math.PI; c.face = c.yaw; c.fresh = true;
    });
    for (const c of crowd.list) if (!row.includes(c)) { c.state = 'pose'; c.legs.length = 0; c.pos.set(90 + c.i, 0, 0); }
    hero.on = false;
    const zc = 10.5 * side;
    app.setView({ pos: [0, heightAt(0, zc) + 1.3, zc], target: [0, heightAt(0, 0) + 0.9, 0], fov: 46 });
    env.setShadowFocus?.(new THREE.Vector3(0, heightAt(0, 0), 0));
  };
  if (p.get('lineup') === '1') lineup();
  window.__citizens = { THREE, lineup, crowd, env, audio, view, hero, heroMesh, loadMs, setPanic: (k) => crowd.setPanic(k), stats: () => crowd.stats() };
  app.progress(1, '');
  await app.ready();
}
