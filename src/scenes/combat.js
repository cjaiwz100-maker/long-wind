// Combat test arena: the gameplay loop on whatever real world/VFX/UI modules exist right now. Owner: gameplay (P).
//   ?scene=combat                 title screen (click / Enter to start)
//   ?scene=combat&demo=1          autopilot plays (harness screenshots show real fights)
//   &wave=N (1-based) · &state=playing · &nointro · &lite (no vegetation/decor) · &mood=golden|ember|… · &verbose
// Every optional module is discovered with import.meta.glob and loaded defensively, so a missing or broken area
// never takes the arena down (failures are listed in window.__combat.failed).
import * as THREE from 'three';
import { createGame } from '../game/game.js';

const MODS = import.meta.glob(['../world/*.js', '../fx/*.js', '../ui/*.js', '../audio/*.js']);
const report = (window.__combat = { ok: [], failed: [], missing: [] });

async function opt(path, fn, ...args) {
  // the glob only tells which area files exist; the import itself is a plain URL import (like scenes/full.js),
  // because glob loaders pin the HMR timestamp of the file's last save and keep failing if that save was broken
  if (!MODS[path]) { report.missing.push(path); return null; }
  try {
    const mod = await import(/* @vite-ignore */ path);
    if (typeof mod[fn] !== 'function') { report.missing.push(`${path}#${fn}`); return null; }
    const out = await mod[fn](...args);
    report.ok.push(`${path}#${fn}`);
    return out ?? null;
  } catch (err) {
    console.error(`[combat] ${path} ${fn} failed:`, err);
    report.failed.push({ path, fn, error: String(err?.stack || err) });
    return null;
  }
}

const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

export default async function (app) {
  const p = app.params;
  const lite = p.has('lite');
  const step = async (v, label) => { app.progress(v, label); await nextTick(); };

  await step(0.05, '天 · sky');
  const env = await opt('../world/environment.js', 'createEnvironment', app, { mood: p.get('mood') || 'golden' });
  await step(0.15, '地 · earth');
  const terrain = await opt('../world/terrain.js', 'createTerrain', app);
  if (!lite) {
    await step(0.28, '山 · mountains');
    await opt('../world/mountains.js', 'createMountains', app);
    await opt('../world/rocks.js', 'createRocks', app);
    await opt('../world/props.js', 'createProps', app);
  }
  await step(0.42, '风 · wind');
  const interaction = await opt('../world/interaction.js', 'createInteraction', app);
  let grass = null;
  if (!lite) {
    await step(0.5, '草 · grass');
    grass = await opt('../world/grass.js', 'createGrass', app);
    await opt('../world/flora.js', 'createFlora', app);
    await opt('../world/trees.js', 'createTrees', app);
  }
  await step(0.7, '尘 · motes');
  const vfx = await opt('../fx/vfx.js', 'createVFX', app, { interaction });
  if (!lite) await opt('../fx/ambient.js', 'createAmbient', app);
  await step(0.8, '声 · sound');
  const hud = await opt('../ui/hud.js', 'createHUD', app);
  const audio = await opt('../audio/audio.js', 'createAudio', app);

  await step(0.88, '剑 · sword');
  const game = await createGame(app, { env, terrain, grass, vfx, hud, audio, interaction });
  if (hud) await opt('../ui/touch.js', 'createTouchControls', app, { game, hud });   // phones, tablets, ?touch=1
  window.__full = { env, terrain, grass, vfx, hud, audio, game, interaction };
  if (report.failed.length) console.warn('[combat] optional modules failed:', report.failed.map((f) => f.path).join(', '));

  app.progress(1, '');
  await app.ready();
  void THREE;
}
