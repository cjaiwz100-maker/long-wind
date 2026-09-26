// Vegetation test scene (V): environment + terrain + interaction + grass + flora + trees.
// URL: /?scene=grass[&view=hero|sun|away|top|tree|close|wide|down|ix|lilies|plumes][&test=push|shock|slash|trample|all][&mood=golden]
//      [&density=1][&freeze]
// Harness: node tools/shot.mjs --scene grass --q "view=hero" --out shots/V/hero.png
// Hooks: window.__veg = { grass, ix, flora, trees, env, view(name), actor }  (view() re-frames the camera)
import * as THREE from 'three';
import { G, LAYERS, SUN_DIR } from '../core/globals.js';

async function tryLoad(label, fn) {
  try { return await fn(); } catch (e) { console.error(`[grass scene] ${label} failed:`, e); return null; }
}
// dynamic imports through a variable so Vite doesn't fail on modules other areas haven't created yet
const imp = (path) => import(/* @vite-ignore */ path);
const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

// Local stand-in terrain (?terrain=local) so vegetation can be judged while the world area is mid-edit.
async function localTerrain(app) {
  const { noise } = await import('../core/noise.js');
  const { patchMaterial } = await import('../core/atmosphere.js');
  const sm = THREE.MathUtils.smoothstep;
  const heightAt = (x, z) => {
    const r = Math.hypot(x, z);
    return noise.fbm2(x * 0.0035, z * 0.0035, 4) * 16 * (0.3 + 0.7 * sm(r, 30, 200)) + noise.fbm2(x * 0.014, z * 0.014, 3) * 2.5
      + 4.2 * Math.exp(-((r / 40) ** 2)) + noise.fbm2(x * 0.07, z * 0.07, 2) * 0.25;
  };
  const normalAt = (x, z, out = new THREE.Vector3()) => {
    const e = 0.5;
    return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
  };
  const geo = new THREE.PlaneGeometry(1400, 1400, 350, 350);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, patchMaterial(new THREE.MeshLambertMaterial({ color: new THREE.Color(0.16, 0.12, 0.05) })));
  mesh.receiveShadow = true; mesh.castShadow = true;
  app.scene.add(mesh);
  Object.assign(app.world, { heightAt, normalAt, pathAt: () => ({ dist: 99, width: 3 }) });
  return { mesh };
}

export default async function (app) {
  const p = app.params;
  app.progress(0.05, '天 · sky');
  const env = await tryLoad('environment', async () => (await imp('../world/environment.js')).createEnvironment(app, { mood: p.get('mood') || 'golden' }));
  await nextTick();
  app.progress(0.15, '地 · earth');
  if (p.get('terrain') === 'local') await localTerrain(app);
  else await tryLoad('terrain', async () => (await imp('../world/terrain.js')).createTerrain(app));
  await nextTick();
  if (!p.has('nomountains')) await tryLoad('mountains', async () => (await imp('../world/mountains.js')).createMountains?.(app));
  app.progress(0.35, '风 · wind');
  const { createInteraction } = await import('../world/interaction.js');
  const ix = createInteraction(app);
  app.progress(0.45, '草 · grass');
  const { createGrass } = await import('../world/grass.js');
  const grass = createGrass(app, { density: +(p.get('density') ?? 1) });
  await nextTick();
  app.progress(0.6, '花 · flowers');
  const flora = p.has('noflora') ? null : await tryLoad('flora', async () => (await imp('../world/flora.js')).createFlora(app));
  await nextTick();
  app.progress(0.75, '树 · tree');
  const trees = p.has('notrees') ? null : await tryLoad('trees', async () => (await imp('../world/trees.js')).createTrees(app));
  await nextTick();

  const H = (x, z) => app.world.heightAt(x, z);
  // sun azimuth (xz) — "into the sun" views follow whatever the environment set
  const sunXZ = () => { const s = G.uSunDir.value; const v = new THREE.Vector2(s.x, s.z); return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector2(SUN_DIR.x, SUN_DIR.z).normalize(); };

  // ---- fake actor for interaction tests (a dark robe-ish capsule on the ACTORS layer) ----
  const test = p.get('test');
  let actor = null;
  if (test) {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.44, 0.45), roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.1, 6, 12), mat);
    body.position.y = 0.83;
    body.castShadow = true;
    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.22, 20), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.32, 0.17), roughness: 0.9 }));
    hat.position.y = 1.72; hat.castShadow = true;
    actor = new THREE.Group();
    actor.add(body, hat);
    actor.traverse((o) => o.layers.set(LAYERS.ACTORS));
    app.scene.add(actor);
  }

  // ---- views ----
  const spawn = { x: 0, z: 40 };
  function frame(name) {
    const s = sunXZ();
    const side = new THREE.Vector2(-s.y, s.x);
    let pos, target, fov = 48;
    const P = new THREE.Vector3(spawn.x, H(spawn.x, spawn.z), spawn.z);
    switch (name) {
      case 'sun': { // mid-height looking into the sun: backlit gold field
        const c = new THREE.Vector3(P.x - s.x * 6, 0, P.z - s.y * 6); c.y = H(c.x, c.z) + 2.6;
        pos = c; target = new THREE.Vector3(c.x + s.x * 60, H(c.x + s.x * 60, c.z + s.y * 60) + 3.2, c.z + s.y * 60);
        break;
      }
      case 'away': { // turned 180°: cool side, front-lit grass
        const c = new THREE.Vector3(P.x, 0, P.z); c.y = H(c.x, c.z) + 2.2;
        pos = c; target = new THREE.Vector3(c.x - s.x * 60, H(c.x - s.x * 60, c.z - s.y * 60) + 2.5, c.z - s.y * 60);
        break;
      }
      case 'top': {
        pos = new THREE.Vector3(P.x - s.x * 10, H(P.x, P.z) + 14, P.z - s.y * 10 + 8);
        target = new THREE.Vector3(P.x, H(P.x, P.z), P.z - 4);
        break;
      }
      case 'ix': { // front-lit (camera on the sun side) 40° view onto the interaction test area
        const f = new THREE.Vector3(P.x + s.x * 4, 0, P.z + s.y * 4); f.y = H(f.x, f.z);
        pos = new THREE.Vector3(f.x + s.x * 7 + side.x * 1.5, f.y + 5.5, f.z + s.y * 7 + side.y * 1.5);
        target = new THREE.Vector3(f.x, f.y + 0.2, f.z);
        break;
      }
      case 'down': { // steep view onto the interaction area
        pos = new THREE.Vector3(P.x + 0.5, H(P.x, P.z) + 7, P.z + 6.5);
        target = new THREE.Vector3(P.x, H(P.x, P.z), P.z);
        break;
      }
      case 'tree': {
        const t = trees?.hero?.position ?? new THREE.Vector3(-20, H(-20, -14), -14);
        const c = new THREE.Vector3(t.x - s.x * 28 + side.x * 6, 0, t.z - s.y * 28 + side.y * 6); c.y = H(c.x, c.z) + 1.8;
        pos = c; target = new THREE.Vector3(t.x, t.y + 6, t.z);
        break;
      }
      case 'lilies': { // the higanbana patch by the stele, low, into the sun
        const f = { x: 6.5, z: 5.5 };
        const c = new THREE.Vector3(f.x - s.x * 5.5 + side.x * 1.2, 0, f.z - s.y * 5.5 + side.y * 1.2); c.y = H(c.x, c.z) + 1.1;
        pos = c; target = new THREE.Vector3(f.x + s.x * 4, H(f.x, f.z) + 0.5, f.z + s.y * 4); fov = 42;
        break;
      }
      case 'plumes': { // nearest silver-grass drift to the spawn, seen against the sun
        const t = flora?.plumes?.nearest?.(spawn.x + s.x * 20, spawn.z + s.y * 20) ?? new THREE.Vector3(P.x + s.x * 20, P.y, P.z + s.y * 20);
        const c = new THREE.Vector3(t.x - s.x * 7 + side.x * 1.5, 0, t.z - s.y * 7 + side.y * 1.5); c.y = H(c.x, c.z) + 1.5;
        pos = c; target = new THREE.Vector3(t.x + s.x * 3, t.y + 1.3, t.z + s.y * 3); fov = 45;
        break;
      }
      case 'close': { // ground-level macro into the sun
        const c = new THREE.Vector3(P.x, 0, P.z); c.y = H(c.x, c.z) + 0.55;
        pos = c; target = new THREE.Vector3(c.x + s.x * 10, c.y + 0.5, c.z + s.y * 10); fov = 40;
        break;
      }
      case 'wide': { // high establishing shot toward the sun
        const c = new THREE.Vector3(P.x - s.x * 20, 0, P.z - s.y * 20); c.y = H(c.x, c.z) + 9;
        pos = c; target = new THREE.Vector3(c.x + s.x * 100, H(c.x + s.x * 100, c.z + s.y * 100) + 4, c.z + s.y * 100);
        break;
      }
      case 'hero':
      default: { // 3rd-person: pivot 1.45 m above the player, camera 4.2 m behind (away from the sun), horizon low
        const pivot = new THREE.Vector3(P.x, P.y + 1.45, P.z);
        pos = new THREE.Vector3(pivot.x - s.x * 4.2 + side.x * 0.9, pivot.y + 0.28, pivot.z - s.y * 4.2 + side.y * 0.9);
        target = new THREE.Vector3(pivot.x + s.x * 12, pivot.y + 0.95, pivot.z + s.y * 12);
        break;
      }
    }
    app.setView({ pos: pos.toArray(), target: target.toArray(), fov });
    env?.setShadowFocus?.(new THREE.Vector3(spawn.x, H(spawn.x, spawn.z), spawn.z));
  }
  const viewName = p.get('view') || 'hero';
  if (!p.has('harness')) app.debugControls();
  frame(viewName);

  // ---- test driver ----
  let tt = 0, stepT = 0, foot = 0, evT = 0;
  const cutPts = [];
  app.add({
    update(dt) {
      if (!actor) return;
      tt += dt;
      const s = sunXZ();
      // walk a slow figure-eight ahead of the hero camera
      const ang = tt * 0.35;
      const cx = spawn.x + s.x * 4, cz = spawn.z + s.y * 4;
      const x = cx + Math.sin(ang) * 3.2, z = cz + Math.sin(ang * 2) * 1.6;
      const y = H(x, z);
      const hd = Math.atan2(Math.cos(ang) * 3.2, Math.cos(ang * 2) * 3.2);
      actor.position.set(x, y, z);
      actor.rotation.y = hd;
      if (test === 'push' || test === 'trample' || test === 'all' || test === 'slash') ix.setActor(0, x, y, z, 0.45);
      if (test === 'trample' || test === 'all') {
        stepT += dt;
        if (stepT > 0.42) {
          stepT = 0; foot ^= 1;
          const sx = Math.cos(hd) * (foot ? 0.14 : -0.14), sz = -Math.sin(hd) * (foot ? 0.14 : -0.14);
          ix.trample(x + sx, z + sz, 0.35, 0.85);
        }
      }
      evT += dt;
      if ((test === 'shock' || test === 'all') && evT > 2.2) { evT = 0; ix.shock(cx, cz, 1.2); ix.dust(cx, cz, 1.4, 1); }
      if ((test === 'slash' || test === 'all') && evT > 1.1) {
        evT = 0;
        const fx = Math.sin(hd), fz = Math.cos(hd);
        const x0 = x + fx * 0.6 - fz * 1.3, z0 = z + fz * 0.6 + fx * 1.3, x1 = x + fx * 0.6 + fz * 1.3, z1 = z + fz * 0.6 - fx * 1.3;
        ix.slash(x0, z0, x1, z1, 1.2, 0.6);
        ix.cut(x0, z0, x1, z1, 0.35);
        ix.stain(x + fx * 1.2, z + fz * 1.2, 0.5, 1);
        cutPts.push(x0, z0);
      }
    },
  });

  // ?atlas=flowers|plumes|leaves|pine|far — show a vegetation canvas atlas over the view (texture debugging)
  const atlasName = p.get('atlas');
  if (atlasName) {
    const src = { flowers: flora?.flowers?.atlas?.canvas, plumes: flora?.plumes?.atlas?.canvas }[atlasName] ?? trees?.atlases?.[atlasName]?.canvas;
    if (src) {
      src.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;object-fit:contain;z-index:99;background:#6b7a86';
      document.body.appendChild(src);
    }
  }

  window.__veg = { grass, ix, flora, trees, env, actor, view: frame, stats: () => ({ grass: grass.stats(), flora: flora?.stats?.() }) };
  app.progress(1, '');
  await app.ready();
}
