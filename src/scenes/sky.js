// Look-dev scene for sky, lighting, shadows and atmosphere. Owner: sky/lighting (S).
// ?scene=sky [&mood=golden|ember|blue|night|afternoon] [&view=sun|away|card|hero|low|wide|up|side] [&terrain=local]
//            [&with=grass,mountains,trees,rocks,flora] (optional other areas, each guarded) [&storm=0.6] [&u=0.72]
// Contents: sky + environment, the terrain (W's, or a local stand-in), a 0.18-albedo grey card facing the sun (bible
// value test: must read sRGB 150–175 after the grade), a matte and a chrome sphere, a mannequin on the ACTORS layer
// (near shadow map) and two stone pillars (far shadow map).
// Harness hooks (window.__sky): view(name), readCard() → {rgb, mean} canvas sRGB at the card centre, stats(),
// env (the environment), mood(name, seconds).
import * as THREE from 'three';
import { LAYERS } from '../core/globals.js';
import { createEnvironment } from '../world/environment.js';

// Local stand-in ground (used when W's terrain is absent or ?terrain=local): gentle swells, low knoll.
function localHeight(x, z) {
  const r = Math.hypot(x, z);
  return 5 * Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.009 - 0.4) + 2.2 * Math.sin(x * 0.031 - z * 0.027)
    + 3.5 * Math.exp(-((r / 40) ** 2)) - 3.5;
}
function buildLocalGround(app) {
  const geo = new THREE.PlaneGeometry(3000, 3000, 300, 300);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, localHeight(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.16, 0.12, 0.045), roughness: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'localGround';
  mesh.receiveShadow = true; mesh.castShadow = true;
  app.scene.add(mesh);
  const normalAt = (x, z, out = new THREE.Vector3()) => {
    const e = 0.5; return out.set(localHeight(x - e, z) - localHeight(x + e, z), 2 * e, localHeight(x, z - e) - localHeight(x, z + e)).normalize();
  };
  Object.assign(app.world, { heightAt: localHeight, normalAt });
  return { mesh };
}

async function tryLoad(label, path, fn, ...args) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return await mod[fn](...args);
  } catch (e) { console.warn(`[sky scene] ${label} unavailable:`, e?.message || e); return null; }
}

export default async function (app) {
  const P = app.params;
  const withSet = new Set((P.get('with') || '').split(',').filter(Boolean));
  app.progress(0.1, '天 · sky');
  const env = createEnvironment(app, { mood: P.get('mood') || 'golden' });

  app.progress(0.25, '地 · earth');
  let terrain = null;
  if (P.get('terrain') !== 'local') terrain = await tryLoad('terrain', '../world/terrain.js', 'createTerrain', app);
  if (!terrain) terrain = buildLocalGround(app);
  const H = (x, z) => app.world.heightAt(x, z);

  if (withSet.has('mountains')) await tryLoad('mountains', '../world/mountains.js', 'createMountains', app);
  if (withSet.has('rocks')) await tryLoad('rocks', '../world/rocks.js', 'createRocks', app);
  if (withSet.has('trees')) await tryLoad('trees', '../world/trees.js', 'createTrees', app);
  let interaction = null;
  if (withSet.has('grass') || withSet.has('flora')) interaction = await tryLoad('interaction', '../world/interaction.js', 'createInteraction', app);
  if (withSet.has('grass')) await tryLoad('grass', '../world/grass.js', 'createGrass', app);
  if (withSet.has('flora')) await tryLoad('flora', '../world/flora.js', 'createFlora', app);
  app.progress(0.6, '光 · light');

  const sun = app.G.uSunDir.value.clone();
  const sunXZ = new THREE.Vector3(sun.x, 0, sun.z).normalize();
  const side = new THREE.Vector3(-sunXZ.z, 0, sunXZ.x);

  // --- grey card (0.18 albedo, pure diffuse) on a post, facing the sun squarely ---
  const cardPos = new THREE.Vector3(2.5, 0, 34);
  cardPos.y = H(cardPos.x, cardPos.z) + 1.3;
  const card = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.8), new THREE.MeshLambertMaterial({ color: new THREE.Color(0.18, 0.18, 0.18) }));
  card.position.copy(cardPos);
  card.lookAt(cardPos.clone().add(sun));
  card.castShadow = true; card.receiveShadow = true;
  card.name = 'greyCard';
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 8), new THREE.MeshStandardMaterial({ color: 0x2a221a, roughness: 0.9 }));
  post.position.set(cardPos.x - sunXZ.x * 0.12, cardPos.y - 0.65, cardPos.z - sunXZ.z * 0.12);   // behind the card
  post.castShadow = true;
  app.scene.add(card, post);

  // --- look-dev spheres: matte 0.18 and chrome (reads the env cube) ---
  const ballY = (x, z) => H(x, z) + 0.9;
  const matte = new THREE.Mesh(new THREE.SphereGeometry(0.35, 48, 32), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.18, 0.18, 0.18), roughness: 1 }));
  matte.position.set(3.6, ballY(3.6, 34), 34); matte.castShadow = matte.receiveShadow = true;
  const chrome = new THREE.Mesh(new THREE.SphereGeometry(0.35, 48, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.05 }));
  chrome.position.set(4.5, ballY(4.5, 34), 34); chrome.castShadow = chrome.receiveShadow = true;
  const stand = (x, z) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 6), post.material); m.position.set(x, H(x, z) + 0.3, z); m.castShadow = true; return m; };
  app.scene.add(matte, chrome, stand(3.6, 34), stand(4.5, 34));

  // --- stone pillars on the WORLD layer: long far-map shadows across the view into the sun ---
  const stoneMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.18, 0.17, 0.155), roughness: 0.85 });
  for (const [x, z, h, r] of [[-6, 14, 3.2, 0.45], [9, -8, 5.5, 0.7], [-22, -26, 7, 1.1]]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, h, 7), stoneMat);
    m.position.set(x, H(x, z) + h / 2 - 0.2, z);
    m.rotation.y = x * 0.37;
    m.castShadow = m.receiveShadow = true;
    app.scene.add(m);
  }

  // --- mannequin on the ACTORS layer (near shadow map only) ---
  const hero = new THREE.Group();
  hero.name = 'hero';
  const heroPos = new THREE.Vector3(0, 0, 36);
  heroPos.y = H(heroPos.x, heroPos.z);
  hero.position.copy(heroPos);
  hero.rotation.y = Math.atan2(sun.x, sun.z);          // faces the sun (+Z local forward)
  const skel = await tryLoad('mannequin', '../character/skeleton.js', 'createMannequin', { color: 0x9aa3a8 });
  if (skel) {
    hero.add(skel.group);
    const B = skel.bones;
    // a ready stance: sword arm forward, slight crouch
    if (B?.['upperArm.R']) B['upperArm.R'].rotation.x = -0.9;
    if (B?.['lowerArm.R']) B['lowerArm.R'].rotation.x = -0.5;
    if (B?.['upperArm.L']) B['upperArm.L'].rotation.z = 0.35;
  } else {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.2, 4, 12), new THREE.MeshStandardMaterial({ color: 0x9aa3a8, roughness: 0.7 }));
    m.position.y = 0.85; hero.add(m);
  }
  hero.traverse((o) => { o.layers.set(LAYERS.ACTORS); if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  app.scene.add(hero);
  env.setShadowFocus(heroPos);
  if (interaction?.setActor) interaction.setActor(0, heroPos.x, heroPos.y, heroPos.z, 0.45);

  // --- views ---
  const eye = (x, z, dy) => [x, H(x, z) + dy, z];
  const into = (p, dir, d, dy = 0) => [p[0] + dir.x * d, p[1] + dy, p[2] + dir.z * d];
  const views = {
    sun: () => { const p = eye(0, 44, 1.7); return { pos: p, target: into(p, sunXZ, 60, 3), fov: 48 }; },            // contre-jour
    away: () => { const p = eye(0, 44, 1.7); return { pos: p, target: into(p, sunXZ, -60, 1), fov: 48 }; },
    card: () => { const p = cardPos.clone().addScaledVector(sunXZ, 2.6).add(new THREE.Vector3(0.4, 0.1, 0)); return { pos: p.toArray(), target: cardPos.toArray(), fov: 40 }; },
    hero: () => { const b = heroPos.clone().addScaledVector(sunXZ, -4.2).addScaledVector(side, 1.2); b.y = H(b.x, b.z) + 1.6; return { pos: b.toArray(), target: [heroPos.x + sunXZ.x * 20, heroPos.y + 2.2, heroPos.z + sunXZ.z * 20], fov: 48 }; },
    side: () => { const b = heroPos.clone().addScaledVector(side, 5).addScaledVector(sunXZ, 1); b.y = H(b.x, b.z) + 1.3; return { pos: b.toArray(), target: [heroPos.x, heroPos.y + 1.0, heroPos.z], fov: 45 }; },
    low: () => { const p = eye(1, 46, 0.45); return { pos: p, target: into(p, sunXZ, 60, 2), fov: 52 }; },
    wide: () => { const p = eye(30, 90, 26); return { pos: p, target: [-40, H(-40, -60) + 4, -60], fov: 55 }; },
    up: () => { const p = eye(0, 44, 1.7); return { pos: p, target: [p[0] + sunXZ.x * 10, p[1] + 30, p[2] + sunXZ.z * 10], fov: 70 }; },
  };
  const setView = (name) => { const v = (views[name] || views.sun)(); app.setView(v); return name; };
  setView(P.get('view') || 'sun');

  const _v = new THREE.Vector3();
  window.__sky = {
    env, views: Object.keys(views), view: setView,
    mood: (name, s = 0) => env.setMood(name, s),
    stats: () => ({ ...app.stats(), farRefreshes: env.shadows.stats.farRefreshes, nearRefreshes: env.shadows.stats.nearRefreshes }),
    /** Canvas sRGB at the card centre (9x9 mean). Needs ?harness (preserveDrawingBuffer). */
    readCard() {
      const r = app.renderer, gl = r.getContext();
      _v.set(0, 0.2, 0).applyQuaternion(card.quaternion).add(cardPos).project(app.camera);   // upper half of the card
      const W = gl.drawingBufferWidth, Hh = gl.drawingBufferHeight;
      const px = Math.round((_v.x * 0.5 + 0.5) * W), py = Math.round((_v.y * 0.5 + 0.5) * Hh);
      r.setRenderTarget(null);
      const n = 9, buf = new Uint8Array(n * n * 4);
      gl.readPixels(px - 4, py - 4, n, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const rgb = [0, 0, 0];
      for (let i = 0; i < n * n; i++) for (let c = 0; c < 3; c++) rgb[c] += buf[i * 4 + c] / (n * n);
      const out = rgb.map((v) => Math.round(v));
      return { px, py, rgb: out, mean: Math.round((out[0] + out[1] + out[2]) / 3), hdr: this.hdrAt(px, Hh - py) };
    },
    /** Linear HDR scene radiance (pre-exposure, opaque pass) at a canvas pixel (x right, y DOWN), from the half-res copy. */
    hdrAt(x, y) {
      const rt = app.pipeline.rtCopy;
      if (!rt) return null;
      const W = app.renderer.getContext().drawingBufferWidth, Hh = app.renderer.getContext().drawingBufferHeight;
      const hx = Math.floor(x / W * rt.width), hy = Math.floor((1 - y / Hh) * rt.height);
      const buf = new Uint16Array(4);
      app.renderer.readRenderTargetPixels(rt, hx, hy, 1, 1, buf);
      return Array.from(buf).map((h) => +THREE.DataUtils.fromHalfFloat(h).toFixed(4));
    },
    /** Canvas sRGB at a pixel (x right, y DOWN). */
    ldrAt(x, y) {
      const gl = app.renderer.getContext(), b = new Uint8Array(4);
      app.renderer.setRenderTarget(null);
      gl.readPixels(x, gl.drawingBufferHeight - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
      return [b[0], b[1], b[2]];
    },
  };
  app.debugControls();
  const v0 = (views[P.get('view')] || views.sun)();
  app.controls.target.set(...v0.target); app.controls.update();

  app.progress(1, '');
  await app.ready();
}
