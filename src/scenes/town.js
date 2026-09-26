// Town review scene (W): level-3 look-dev for world/town.js — environment (ember dusk, u 0.772, exposure ×1.25),
// terrain, mountains, the town. Load as ?scene=town&level=town (the level is chosen from the URL).
//   &view=street|plaza|game|stage|bridge|canal|quay|east|aerial|alley   &town=0 (A/B: no town)   &hero=0   &orbit=0
// Hooks: window.__town = { town, env, view(name), views }.
import * as THREE from 'three';
import { G } from '../core/globals.js';

const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

// [pos (y above ground), target (y above ground), fov]
const VIEWS = {
  street: [[-46, 1.7, 1.6], [-10, 2.6, -0.6], 55],        // eye height down the street toward the plaza
  plaza: [[0, 1.7, 11], [0, 3.4, -15], 55],               // from the teahouse steps to the opera stage
  game: [[13.5, 2.6, 2.2], [5.5, 1.3, 0.2], 55],          // 3rd-person: ~5 m behind the hero, 2.5 m up
  stage: [[-9, 2.2, -2], [2, 4.2, -15], 52],
  bridge: [[28, 1.7, -1.2], [44, 2.2, 0.5], 55],          // walking up to the bridge
  canal: [[40, 1.7, 4.2], [40, 0.6, 40], 55],             // from the bridge crest along the canal
  quay: [[33.6, 1.7, 26], [40.5, 0.2, 2], 55],            // from the quay: the arch and its reflection
  east: [[92, 1.7, -1.5], [40, 3.5, 1.5], 50],
  alley: [[-38, 1.7, 3.2], [-38, 2.2, 12], 60],
  aerial: [[70, 42, 80], [0, 0, 0], 45],
  top: [[10, 120, 1], [10, 0, 0], 50],
  signN: [[-100, 1.7, 1.5], [-100, 3.6, -5.2], 60],
  signS: [[-100, 1.7, -1.5], [-100, 3.6, 5.2], 60],
  plaque: [[0, 3.2, -5], [0, 5.6, -11.6], 40],
  paifang: [[-8, 1.7, 0.5], [-18.5, 4.8, 0], 50],
  high: [[-30, 14, 30], [10, 2, -5], 50],
};

export default async function (app) {
  const p = app.params;
  app.progress(0.05, '天 · sky');
  const { LEVEL } = await import('../levels/index.js');
  const EV = LEVEL.env ?? {};
  const { createEnvironment } = await import('../world/environment.js');
  const env = createEnvironment(app, { mood: p.get('mood') || EV.mood || 'ember', drift: false });
  if (!p.has('mood') && EV.u !== undefined) env.setU?.(+(p.get('u') ?? EV.u), 0);
  env.exposureMul = +(p.get('exp') ?? EV.exposure ?? 1);
  G.uWet.value = +(p.get('wet') ?? EV.wet ?? 0);
  const { setWindStrength } = await import('../core/wind.js');
  setWindStrength?.(EV.wind ?? 0.7, 0.01);
  await nextTick();
  app.progress(0.2, '地 · earth');
  const { createTerrain } = await import('../world/terrain.js');
  await createTerrain(app);
  if (p.get('mountains') !== '0') { try { await (await import('../world/mountains.js')).createMountains(app); } catch (e) { console.error(e); } }
  await nextTick();
  app.progress(0.5, '镇 · town');
  let town = null;
  if (p.get('town') !== '0') {
    const { createTown } = await import('../world/town.js');
    town = await createTown(app);
    console.log('[town]', JSON.stringify(town.stats()));
  }
  if (town && p.get('colliders') === '1') {   // debug: collider circles as translucent columns
    const cs = town.colliders;
    const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0x33ff66, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }), cs.length);
    const m = new THREE.Matrix4();
    cs.forEach((c, i) => { m.makeScale(c.r, 2.5, c.r); m.setPosition(c.x, app.world.heightAt(c.x, c.z) + 1.25, c.z); im.setMatrixAt(i, m); });
    im.layers.set(1); im.frustumCulled = false; app.scene.add(im);
  }
  // stand-in hero for the gameplay framing
  const hero = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.1, 4, 10), new THREE.MeshStandardMaterial({ color: 0x9aa7b4, roughness: 0.7 }));
  hero.geometry.translate(0, 0.83, 0); hero.layers.set(3); hero.visible = false; app.scene.add(hero);

  const H = (x, z) => app.world.heightAt(x, z);
  function view(name) {
    const v = VIEWS[name] || VIEWS.street;
    const [pp, tt, fov] = v;
    const pos = [pp[0], H(pp[0], pp[2]) + pp[1], pp[2]], target = [tt[0], H(tt[0], tt[2]) + tt[1], tt[2]];
    app.setView({ pos, target, fov });
    hero.visible = name === 'game' && p.get('hero') !== '0';
    if (hero.visible) hero.position.set(8.5, H(8.5, 0.8), 0.8);
    const f = new THREE.Vector3(pos[0] + (target[0] - pos[0]) * 0.4, 0, pos[2] + (target[2] - pos[2]) * 0.4);
    f.y = H(f.x, f.z);
    env.setShadowFocus?.(f);
  }
  if (p.get('orbit') !== '0') app.debugControls();
  view(p.get('view') || 'street');
  window.__town = { town, env, view, views: VIEWS, hero };
  app.progress(1, '');
  await app.ready();
}
