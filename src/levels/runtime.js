// Level runtime: the level's own beats that no world module owns. Owner: integrator.
//   createLevelRuntime(app, { env, level }) → { next() }
//   · lightning: fx/storm.js at the level's interval (level.env.lightning = [min, max] s) — flash + bus 'thunder'
//   · title screen: the chapter's name and tagline instead of the game's (level 2 onward)
//   · lanterns: stone lanterns (石灯笼) with a flickering warm lamp each (level.lanterns = [{x, z, yaw?}])
//   · victory: the 'go' seal reads 前行 and bus 'ui:next' loads the next level (a fade, then the page reloads with
//     ?level=next; the quality/audio params survive)
import * as THREE from 'three';
import { bus } from '../core/bus.js';
import { lamps } from '../core/lamps.js';
import { patchMaterial } from '../core/atmosphere.js';
import { LAYERS } from '../core/globals.js';
import { levelUrl, LEVELS, LEVEL_ORDER } from './index.js';
import { createLightning } from '../fx/storm.js';

export function createLevelRuntime(app, { env = null, level } = {}) {
  const EV = level.env ?? {};
  let leaving = false;
  if (EV.lightning) createLightning(app, env, { interval: EV.lightning });

  // ---- stone lanterns: plinth, post, fire box (glowing paper windows), roof, finial; one lamp each
  if (level.lanterns?.length && app.world?.heightAt) {
    const stone = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x6b6a62, roughness: 0.92 }));
    const glow = new THREE.MeshStandardMaterial({ color: 0x1a1008, emissive: 0xff9a40, emissiveIntensity: 0.9, roughness: 0.8 });
    const parts = (y0) => [
      [new THREE.CylinderGeometry(0.34, 0.4, 0.18, 6), y0 + 0.09, stone],
      [new THREE.CylinderGeometry(0.11, 0.14, 0.72, 6), y0 + 0.54, stone],
      [new THREE.CylinderGeometry(0.3, 0.26, 0.1, 6), y0 + 0.95, stone],
      [new THREE.BoxGeometry(0.3, 0.26, 0.3), y0 + 1.13, glow],
      [new THREE.ConeGeometry(0.46, 0.26, 6), y0 + 1.39, stone],
      [new THREE.SphereGeometry(0.07, 8, 6), y0 + 1.56, stone],
    ];
    const root = new THREE.Group(); root.name = 'lanterns';
    for (const L of level.lanterns) {
      const y0 = app.world.heightAt(L.x, L.z) - 0.05;
      for (const [g, y, m] of parts(y0)) {
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(L.x, y, L.z); mesh.rotation.y = L.yaw ?? 0;
        mesh.castShadow = m === stone; mesh.receiveShadow = true;
        mesh.layers.set(LAYERS.WORLD);
        root.add(mesh);
      }
      lamps.add({ pos: new THREE.Vector3(L.x, y0 + 1.15, L.z), color: [1.0, 0.55, 0.22], weight: L.weight ?? 3.2, flicker: 0.35 });
      app.world.colliders?.push({ x: L.x, z: L.z, r: 0.42 });
    }
    app.scene.add(root);
  }

  // ---- screens
  const hud = document.querySelector('.wx');
  const title = hud?.querySelector('.scr.title');
  if (title && level.id !== 'steppe') {
    const tt = title.querySelector('.col .tt'), tg = title.querySelector('.col .tg');
    const en = title.querySelector('.en b'), ei = title.querySelector('.en i');
    if (tt) {
      tt.textContent = level.title;
      // two characters fill the column; four need a smaller brush so the English line below stays clear
      if (level.title.length > 2) tt.style.fontSize = `clamp(64px, ${(17 * 2.1 / level.title.length).toFixed(1)}vh, 140px)`;
    }
    if (tg) tg.textContent = level.tagline ?? level.no;
    if (en) en.textContent = (level.en ?? '').toUpperCase();
    if (ei) ei.textContent = level.enTagline ?? '';
  }
  // pause menu: 章 — every chapter of the journey (the current one marked)
  const qual = hud?.querySelector('.pause .qual');
  if (qual && !hud.querySelector('.pause .chap')) {
    const row = document.createElement('div');
    row.className = 'qual chap';
    row.innerHTML = '<b>章</b>' + LEVEL_ORDER.map((id) => `<span class="qo${id === level.id ? ' on' : ''}" data-level="${id}">${LEVELS[id].title}</span>`).join('') + '<i>chapter</i>';
    qual.after(row);
    row.addEventListener('click', (e) => {
      const id = e.target?.closest?.('[data-level]')?.dataset.level;
      if (!id || id === level.id || leaving) return;
      leaving = true;
      bus.emit('ui:sfx', { kind: 'seal' });
      app.pipeline?.fx?.fade?.(1, 0.8, 'black');
      setTimeout(() => { location.href = levelUrl(id); }, 850);
    });
  }
  const setVictorySeal = () => {
    const go = hud?.querySelector('.scr.victory .go');
    if (go && level.next) { go.dataset.act = 'next'; go.innerHTML = '<b>前行</b><i>journey on</i>'; }
  };
  setVictorySeal();
  bus.on('game:state', (p) => { if (p?.state === 'victory') setTimeout(setVictorySeal, 50); });

  function next() {
    if (leaving || !level.next) return;
    leaving = true;
    bus.emit('ui:sfx', { kind: 'seal' });
    app.pipeline?.fx?.fade?.(1, 1.1, 'black');
    setTimeout(() => { location.href = levelUrl(level.next); }, 1200);
  }
  bus.on('ui:next', next);
  // the victory seal (HUD 'data-act' buttons): a click on 前行 goes on
  hud?.addEventListener('click', (e) => { if (e.target?.closest?.('[data-act="next"]')) next(); }, true);

  return { next };
}
