// World scene (W): environment + terrain + mountains + rocks + props, with camera bookmarks.
//   ?scene=terrain&view=hero|sun|away|aerial|knoll|pavilion   (default hero)
//   &grass=1   also load the vegetation (V) if present      &mood=golden|ember|blue|night|afternoon
//   &only=terrain,mountains,rocks,props   restrict what is built      &orbit=0 disables OrbitControls
// Harness hooks: window.__world = { terrain, mountains, rocks, props, env, view(name) }.
import * as THREE from 'three';
import { LAYOUT, viewBookmark } from '../world/layout.js';

const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

async function tryLoad(label, path, fn, ...args) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    if (typeof mod[fn] !== 'function') return null;
    return await mod[fn](...args);
  } catch (err) {
    console.error(`[terrain scene] ${label} failed:`, err);
    return null;
  }
}

/** Minimal golden-hour light rig used only when the environment module fails to load. */
function fallbackEnv(app) {
  const { G } = app;
  const sun = new THREE.DirectionalLight(new THREE.Color(1, 0.74, 0.47), 3.3);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 600 });
  sun.layers.enableAll();
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.42, 0.55, 0.68), new THREE.Color(0.21, 0.175, 0.08), 0.85);
  hemi.layers.enableAll();
  app.scene.add(sun, sun.target, hemi);
  const focus = new THREE.Vector3();
  const env = { sun, hemi, setShadowFocus(v) { focus.copy(v); }, update() {
    sun.position.copy(focus).addScaledVector(G.uSunDir.value, 300); sun.target.position.copy(focus); sun.target.updateMatrixWorld();
  } };
  app.add(env);
  return env;
}

export default async function (app) {
  const p = app.params;
  const only = p.get('only') ? new Set(p.get('only').split(',')) : null;
  const want = (k) => !only || only.has(k);
  const step = async (v, label) => { app.progress(v, label); await nextTick(); };

  await step(0.05, '天 · sky');
  const env = (await tryLoad('environment', '../world/environment.js', 'createEnvironment', app, { mood: p.get('mood') || 'golden' })) || fallbackEnv(app);

  await step(0.15, '地 · earth');
  const terrain = await tryLoad('terrain', '../world/terrain.js', 'createTerrain', app);
  const heightAt = app.world.heightAt;

  await step(0.55, '山 · mountains');
  const mountains = want('mountains') ? await tryLoad('mountains', '../world/mountains.js', 'createMountains', app) : null;
  await step(0.65, '石 · stone');
  const rocks = want('rocks') ? await tryLoad('rocks', '../world/rocks.js', 'createRocks', app) : null;
  await step(0.78, '亭 · pavilion');
  const props = want('props') ? await tryLoad('props', '../world/props.js', 'createProps', app) : null;

  let grass = null;
  if (p.get('grass') === '1') {
    await step(0.86, '草 · grass');
    await tryLoad('interaction', '../world/interaction.js', 'createInteraction', app);
    grass = await tryLoad('grass', '../world/grass.js', 'createGrass', app);
    await tryLoad('flora', '../world/flora.js', 'createFlora', app);
    await tryLoad('trees', '../world/trees.js', 'createTrees', app);
  }

  // camera bookmark
  const focus = new THREE.Vector3();
  const view = (name) => {
    const v = viewBookmark(name, heightAt);
    app.setView({ pos: v.pos, target: v.target, fov: 48 });
    focus.set(v.target[0], heightAt(v.target[0], v.target[2]), v.target[2]);
    // keep the shadow focus between camera and target so the near field is covered
    const c = app.camera.position;
    const f = new THREE.Vector3(c.x + (v.target[0] - c.x) * 0.35, 0, c.z + (v.target[2] - c.z) * 0.35);
    f.y = heightAt(f.x, f.z);
    env?.setShadowFocus?.(f);
    return v;
  };
  if (p.get('orbit') !== '0') app.debugControls();   // before the bookmark: OrbitControls starts at its own target
  view(p.get('view') || 'hero');

  window.__world = { terrain, mountains, rocks, props, env, grass, view, LAYOUT };
  app.progress(1, '');
  await app.ready();
}
