// UI + audio test scene: the HUD over a simple golden-hour scene, driven by a scripted bus-event sequence.
//   ?scene=ui                         — demo loop: title → waves → hits/parries → boss → victory (click to start audio)
//   ?scene=ui&state=title|hud|banner|boss|combat|lowhp|pause|victory|defeat|brushes   — static states for screenshots
//   ?scene=ui&state=audiotest[&only=name]  — offline renders of scripted scenarios → window.__audioTest (WAV + levels)
// Other areas are imported defensively: if one is missing or broken the scene falls back to simple stand-ins.
// Hooks: window.__ui = { hud, audio, bus, emit(type, payload), enemies, run(state), show(state) (reset + run) }. Owner: UI (U).
import * as THREE from 'three';
import { bus } from '../core/bus.js';
import { createHUD } from '../ui/hud.js';

async function tryImport(path, fn, ...args) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return await mod[fn](...args);
  } catch (e) {
    console.warn(`[ui scene] ${path}:${fn} unavailable —`, e?.message ?? e);
    return null;
  }
}

// Dark silhouette stand-ins for enemies (used when the character module is unavailable).
function standIn(height = 1.8) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, height - 0.75, 4, 10), mat);
  body.position.y = height * 0.5; g.add(body);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.22, 16), mat);
  hat.position.y = height - 0.02; g.add(hat);
  g.traverse((o) => { o.castShadow = true; o.layers.set(3); });
  return g;
}

export default async function (app) {
  const state = app.params.get('state') || 'demo';
  const heightAt = (x, z) => app.world.heightAt(x, z);

  if (state === 'brushes') return brushGallery(app);
  if (state === 'audiotest') return (await import('../audio/test.js')).runAudioTest(app);

  // ---- world backdrop (guarded) ----
  app.progress(0.1, '天 · sky');
  const env = await tryImport('../world/environment.js', 'createEnvironment', app, { mood: app.params.get('mood') || 'golden' });
  app.progress(0.25, '地 · earth');
  await tryImport('../world/terrain.js', 'createTerrain', app);
  await tryImport('../world/mountains.js', 'createMountains', app);
  if (!app.params.has('nograss')) {
    app.progress(0.45, '草 · grass');
    await tryImport('../world/grass.js', 'createGrass', app);
  }

  // ---- stand-in enemies ----
  const spots = [[-2.2, 29], [2.8, 26.5], [0.4, 22.5], [5.5, 31]];
  const enemies = [];
  for (let i = 0; i < spots.length; i++) {
    const [x, z] = spots[i];
    let obj = null;
    const kind = i === 2 ? 'swordmaster' : 'bandit';
    const ch = app.params.has('chars') ? await tryImport('../character/character.js', 'createCharacter', { kind, seed: i + 1 }) : null;
    obj = ch?.group ?? standIn(i === 2 ? 1.85 : 1.78);
    obj.position.set(x, heightAt(x, z), z);
    obj.rotation.y = Math.atan2(0 - x, 36 - z);
    app.scene.add(obj);
    enemies.push({ id: 100 + i, kind, obj, hp: 1, po: 0 });
  }
  const camPos = [1.1, 0, 36.5], camTgt = [0.4, 0, 24];
  const y0 = heightAt(camPos[0], camPos[2]);
  app.setView({ pos: [camPos[0], y0 + 1.75, camPos[2]], target: [camTgt[0], heightAt(camTgt[0], camTgt[2]) + 1.25, camTgt[2]] });
  env?.setShadowFocus?.(new THREE.Vector3(0, heightAt(0, 30), 30));

  // ---- HUD + audio ----
  app.progress(0.8, '声 · sound');
  const hud = createHUD(app);
  const audio = await tryImport('../audio/audio.js', 'createAudio', app);
  try {
    await Promise.race([
      Promise.all([hud.ready, document.fonts.load('64px "Ma Shan Zheng"', '长风天苍野茫第一回风起草动剑鸣终歇继续重来招式声十步杀人千里不留行事了拂衣去深藏身与名萧兮易水寒壮士复还寒山客气危破'),
        document.fonts.load('400 20px "Noto Serif SC"', '天苍苍野茫茫点击启程第一回行斩格闪锁气剑歇用时斩敌识破'), document.fonts.load('italic 400 16px "Cormorant Garamond"', 'LONG WIND')]),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  } catch { /* ignore */ }

  const emit = (t, p = {}) => bus.emit(t, p);
  const E = (i) => enemies[i];
  const posOf = (i, up = 1.3) => { const o = E(i).obj.position; return { x: o.x, y: o.y + up, z: o.z }; };
  function spawnAll(only = null) {
    enemies.forEach((e, i) => {
      if (only && !only.includes(i)) return;
      hud.track(e.id, e.obj, { height: i === 2 ? 1.85 : 1.78, stats: () => ({ hp: e.hp, hpMax: 1, posture: e.po, postureMax: 1 }) });
      emit('enemy:spawn', { id: e.id, kind: e.kind, pos: e.obj.position });
    });
  }
  function hit(i, dmg, kill = false) {
    const e = E(i);
    e.hp = Math.max(0, e.hp - dmg); e.po = Math.min(1, e.po + dmg * 0.9);
    emit('enemy:hit', { id: e.id, pos: posOf(i), dir: { x: 1, y: -0.3, z: 0 }, damage: dmg * 100, kill, part: 'torso', hp: e.hp, max: 1 });
    if (kill) emit('enemy:death', { id: e.id, pos: posOf(i) });
  }

  // ---- static states for screenshots (timers go through at() so show() can cancel them) ----
  let demoTimers = [];
  function at(sec, fn) { demoTimers.push(setTimeout(fn, sec * 1000)); }
  function playingSetup(only = null) {
    emit('game:state', { state: 'playing' });
    emit('player:hp', { hp: 100, max: 100 });
    emit('player:focus', { value: 0, max: 100 });
    spawnAll(only);
  }
  const runs = {
    title() { emit('game:state', { state: 'title' }); },
    hud() {
      playingSetup();
      E(0).hp = 0.55; E(0).po = 0.35; E(1).hp = 0.85; E(1).po = 0.6; E(2).hp = 0.72; E(2).po = 0.55;
      emit('lockon', { id: E(2).id });
      emit('player:hp', { hp: 58, max: 100 });
      emit('player:focus', { value: 72, max: 100 });
      hit(0, 0.1); hit(1, 0.05);
    },
    banner() { playingSetup([0, 1, 3]); emit('wave:start', { index: 1, title: '风起', sub: 'The Wind Rises', count: 3 }); },
    boss() { playingSetup([2]); emit('wave:start', { index: 3, title: '剑鸣', sub: 'The Sword Sings', count: 1, boss: true }); },
    // mid-fight: a parry ensō, cut ticks, a kill splat and a warning, frozen at their peak for critique
    combat() {
      playingSetup([0, 1, 3]);
      E(0).hp = 0.62; E(1).hp = 0.9; E(1).po = 0.8;
      emit('player:hp', { hp: 64, max: 100 }); emit('player:focus', { value: 100, max: 100 });
      emit('lockon', { id: E(1).id });
      at(0.4, () => {
        hit(0, 0.12);
        emit('player:parry', { perfect: true, pos: posOf(1, 1.4) }); emit('enemy:parried', { id: E(1).id, pos: posOf(1, 1.4) });
        emit('enemy:telegraph', { id: E(3).id, pos: posOf(3), unblockable: true });
      });
      at(0.52, () => { hit(3, 1, true); });
      at(0.7, () => { document.getAnimations?.().forEach((a) => { try { a.pause(); } catch { /* */ } }); });
    },
    lowhp() {
      playingSetup([0, 1, 3]);
      emit('player:hp', { hp: 18, max: 100 }); emit('player:focus', { value: 30, max: 100 });
      at(0.3, () => { emit('player:hurt', { damage: 20, pos: posOf(0), dir: { x: 0, y: 0, z: 1 } }); });
    },
    pause() { runs.hud(); at(0.3, () => emit('game:state', { state: 'paused' })); },
    victory() { playingSetup(); at(0.2, () => emit('game:state', { state: 'victory' })); },
    defeat() { playingSetup(); emit('player:hp', { hp: 0, max: 100 }); at(0.2, () => emit('game:state', { state: 'defeat' })); },
    demo() { demo(); },
  };

  // ---- demo loop: a scripted fight told only through bus events ----
  function demo() {
    demoTimers.forEach(clearTimeout); demoTimers = [];
    enemies.forEach((e) => { e.hp = 1; e.po = 0; });
    emit('game:state', { state: 'title' });
    const off = bus.on('ui:start', () => { off(); fight(); });
    at(6, () => { off(); fight(); }); // auto-start for unattended runs
  }
  function fight() {
    demoTimers.forEach(clearTimeout); demoTimers = [];
    playingSetup();
    at(0.8, () => emit('wave:start', { index: 1, title: '风起', sub: 'The Wind Rises', count: 3 }));
    at(5.5, () => { emit('lockon', { id: E(0).id }); emit('player:attack', { clip: 'attack1' }); emit('sword:whoosh', { speed: 9, heavy: false, pos: posOf(0) }); });
    at(5.75, () => hit(0, 0.3));
    at(6.3, () => { emit('sword:whoosh', { speed: 11, heavy: false, pos: posOf(0) }); });
    at(6.5, () => hit(0, 0.3));
    at(7.4, () => emit('enemy:telegraph', { id: E(1).id, pos: posOf(1), unblockable: false }));
    at(8.0, () => { emit('player:parry', { perfect: true, pos: posOf(1) }); emit('enemy:parried', { id: E(1).id, pos: posOf(1) }); E(1).po = 0.7; emit('player:focus', { value: 45, max: 100 }); });
    at(9.2, () => { emit('sword:whoosh', { speed: 16, heavy: true, pos: posOf(0) }); });
    at(9.5, () => hit(0, 0.5, true));
    at(10.5, () => emit('enemy:telegraph', { id: E(3).id, pos: posOf(3), unblockable: true }));
    at(11.3, () => { emit('player:hurt', { damage: 24, pos: posOf(3), dir: { x: 0, y: 0, z: 1 } }); emit('player:hp', { hp: 76, max: 100 }); });
    at(13, () => { emit('lockon', { id: E(1).id }); hit(1, 0.4); });
    at(13.6, () => hit(1, 0.7, true));
    at(14.2, () => { emit('player:focus', { value: 100, max: 100 }); });
    at(15.5, () => { emit('player:hurt', { damage: 50, pos: posOf(3), dir: { x: 0, y: 0, z: 1 } }); emit('player:hp', { hp: 24, max: 100 }); });
    at(16.5, () => { emit('special', { pos: posOf(3, 1), dir: { x: 0, y: 0, z: -1 } }); hit(3, 1, true); emit('player:focus', { value: 0, max: 100 }); });
    at(17.5, () => emit('wave:clear', { index: 0 }));
    at(21, () => { emit('wave:start', { index: 3, title: '剑鸣', sub: 'The Sword Sings', count: 1, boss: true }); emit('lockon', { id: E(2).id }); });
    at(26, () => { hit(2, 0.25); });
    at(27, () => emit('enemy:telegraph', { id: E(2).id, pos: posOf(2), unblockable: true }));
    at(28, () => { hit(2, 0.3); E(2).po = 0.95; });
    at(29.5, () => { hit(2, 0.5, true); });
    at(32, () => emit('game:state', { state: 'victory' }));
    at(46, () => demo());
  }
  bus.on('ui:restart', () => { if (state === 'demo') demo(); });
  bus.on('ui:resume', () => emit('game:state', { state: 'playing' }));
  addEventListener('keydown', (e) => { if (e.code === 'KeyP') emit('game:state', { state: hud.state === 'paused' ? 'playing' : 'paused' }); });

  // switch to another static state without reloading (harness: several screenshots per page load)
  function show(s) {
    demoTimers.forEach(clearTimeout); demoTimers = [];
    document.getAnimations?.().forEach((a) => { try { a.play(); } catch { /* */ } });
    hud.reset();
    enemies.forEach((e) => { e.hp = 1; e.po = 0; });
    (runs[s] || runs.demo)();
  }
  window.__ui = { hud, audio, bus, emit, enemies, run: (s) => runs[s]?.(), show };
  app.progress(1, '');
  await app.ready();
  (runs[state] || runs.demo)();
}

async function brushGallery(app) {
  // every HUD brush texture, as the HUD builds them, over a golden-hour gradient (ink colour = HUD cream)
  const { strokeTex, ensoTex, splatTex, washTex, sealTex, toURL } = await import('../ui/brush.js');
  await document.fonts.load('900 64px "Noto Serif SC"', '长风剑气破');
  const root = document.getElementById('hud');
  root.style.cssText += ';background:linear-gradient(180deg,#c9a46a,#6f5a36 60%,#2b2419);display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:18px 28px;padding:28px;pointer-events:auto';
  const add = async (c, bg = '#e8d3ad', w = '100%', label = '') => {
    const url = await toURL(c);
    const d = document.createElement('div');
    d.title = label;
    d.style.cssText = `width:${w};aspect-ratio:${c.width}/${c.height};background:${bg};-webkit-mask:url(${url}) center/contain no-repeat;mask:url(${url}) center/contain no-repeat;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))`;
    root.appendChild(d);
  };
  await add(strokeTex({ w: 1024, h: 120, seed: 1, dry: 0.45, thick: 0.32, taper: 0.14, swell: 0.1 }), undefined, '100%', 'health');
  await add(strokeTex({ w: 1400, h: 96, seed: 2, dry: 0.62, thick: 0.3, taper: 0.12, rise: 0.05 }), undefined, '100%', 'boss');
  await add(strokeTex({ w: 1024, h: 128, seed: 7, dry: 0.62, thick: 0.3, taper: 0.1, rise: 0.14 }), undefined, '100%', 'rule');
  await add(strokeTex({ w: 1024, h: 120, seed: 3, dry: 0.3, thick: 0.3, end: 'press' }), undefined, '100%', 'press');
  await add(strokeTex({ w: 512, h: 48, seed: 4, dry: 0.5, thick: 0.28, taper: 0.1 }), undefined, '80%', 'thin');
  await add(strokeTex({ w: 512, h: 128, seed: 11, dry: 0.55, thick: 0.2, taper: 0.04, rise: 0.25 }), undefined, '80%', 'tick');
  await add(ensoTex({ size: 256, seed: 3, sweep: 0.9, start: -2.2, thick: 0.07 }), undefined, '45%', 'enso');
  await add(ensoTex({ size: 192, seed: 8, sweep: 0.86, start: -1.4, thick: 0.06, dry: 0.65 }), undefined, '35%', 'enso2');
  await add(splatTex({ size: 256, seed: 5 }), '#b8322a', '35%', 'splat');
  await add(washTex({ w: 256, h: 128, seed: 9 }), '#000', '60%', 'wash');
  const im = document.createElement('img'); im.src = await toURL(sealTex({ text: '长风', h: 192 })); im.style.width = '90px'; root.appendChild(im);
  app.progress(1, '');
  await app.ready();
}
