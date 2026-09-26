// Bamboo grove review scene (V): environment + terrain + createBamboo around the origin.
// URL: /?scene=bamboo[&mood=golden|night|...][&view=clear|up|edge|deep|high|far][&storm=0.8][&grass=1][&nobamboo]
//      [&density=1][&wind=1][&freeze]
// Hooks: window.__bamboo = { bamboo, env, view(name), lightning() }
import * as THREE from 'three';

const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

export default async function (app) {
  const p = app.params;
  app.progress(0.05, '天 · sky');
  const { createEnvironment } = await import('../world/environment.js');
  const env = createEnvironment(app, { mood: p.get('mood') || 'golden' });
  await nextTick();
  app.progress(0.2, '地 · earth');
  const { createTerrain } = await import('../world/terrain.js');
  await createTerrain(app);
  await nextTick();
  const C = { x: +(p.get('cx') ?? 0), z: +(p.get('cz') ?? 40) };
  if (p.get('grass') === '1') {
    const { createInteraction } = await import('../world/interaction.js');
    createInteraction(app);
    const { createGrass } = await import('../world/grass.js');
    createGrass(app, { density: 0.8 });
  }
  app.progress(0.5, '竹 · bamboo');
  let bamboo = null;
  if (!p.has('nobamboo')) {
    const { createBamboo } = await import('../world/bamboo.js');
    bamboo = await createBamboo(app, {
      center: C, density: +(p.get('density') ?? 1), seed: +(p.get('seed') ?? 1),
      keepOut: [{ x: C.x + 6, z: C.z + 30, r: 3 }],
      path: (x, z) => {
        // a footpath leaving the clearing toward +z (S-curve)
        const dz = z - C.z;
        if (dz < 0) return null;
        const px = C.x + Math.sin(dz * 0.05) * 6;
        return Math.abs(x - px);
      },
    });
  }
  // ?bbhide=culm0,crown0,culm1,crown1,far — cost breakdown
  for (const n of (p.get('bbhide') || '').split(',').filter(Boolean)) if (bamboo?.meshes[n]) bamboo.meshes[n].material.visible = false;
  if (p.has('wind')) bamboo?.setWindResponse?.(+p.get('wind'));

  const Hh = (x, z) => app.world.heightAt(x, z);
  // stand-in hero for the occlusion view
  const hero = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.1, 4, 10), new THREE.MeshStandardMaterial({ color: 0x8a1c1c, roughness: 0.7 }));
  hero.geometry.translate(0, 0.83, 0); hero.visible = false; hero.layers.set(3); app.scene.add(hero);
  function view(name) {
    let pos, target, fov = 50;
    hero.visible = false; bamboo?.setFocus(null);
    const y0 = Hh(C.x, C.z);
    switch (name) {
      case 'up': pos = [C.x - 4, y0 + 1.6, C.z + 5]; target = [C.x - 16, y0 + 9, C.z - 12]; fov = 60; break;
      case 'edge': pos = [C.x - 3, Hh(C.x - 3, C.z + 8) + 1.7, C.z + 8]; target = [C.x - 30, y0 + 3.5, C.z - 5]; break;
      case 'deep': { const x = C.x + 35, z = C.z - 10; pos = [x, Hh(x, z) + 1.7, z]; target = [x - 20, Hh(x, z) + 3, z - 14]; break; }
      case 'high': pos = [C.x + 30, y0 + 26, C.z + 40]; target = [C.x, y0 + 4, C.z]; break;
      case 'far': pos = [C.x + 120, y0 + 45, C.z + 160]; target = [C.x, y0, C.z]; fov = 45; break;
      case 'path': pos = [C.x + 1, Hh(C.x + 1, C.z + 30) + 1.7, C.z + 30]; target = [C.x, y0 + 2.5, C.z]; break;
      case 'occl': { // 3rd-person camera backed into the grove: a clump sits right between camera and hero
        const cl = bamboo.colliders.find((c) => Math.hypot(c.x - C.x, c.z - C.z) > 19.5) ?? { x: C.x - 20, z: C.z };
        const d = Math.hypot(cl.x - C.x, cl.z - C.z), ux = (cl.x - C.x) / d, uz = (cl.z - C.z) / d;
        const hx = cl.x - ux * 3.2, hz = cl.z - uz * 3.2, cx = cl.x + ux * 2.8 + uz * 0.3, cz = cl.z + uz * 2.8 - ux * 0.3;
        pos = [cx, Hh(cx, cz) + 2.3, cz]; target = [hx - ux * 3, Hh(hx, hz) + 1.3, hz - uz * 3];
        const f = new THREE.Vector3(hx, Hh(hx, hz) + 1.3, hz);
        hero.position.set(hx, Hh(hx, hz), hz); hero.visible = true;
        bamboo?.setFocus(f); break;
      }
      case 'crown': { // under the edge crowns, looking up into the sprays
        const cl = bamboo.colliders.find((c) => Math.hypot(c.x - C.x, c.z - C.z) > 19) ?? { x: C.x - 20, z: C.z };
        const d = Math.hypot(cl.x - C.x, cl.z - C.z), ux = (cl.x - C.x) / d, uz = (cl.z - C.z) / d;
        const cx = cl.x - ux * 5, cz = cl.z - uz * 5;
        pos = [cx, Hh(cx, cz) + 1.7, cz]; target = [cl.x + ux * 2, Hh(cl.x, cl.z) + 9, cl.z + uz * 2]; fov = 55; break;
      }
      case 'away': pos = [C.x - 6, y0 + 1.75, C.z - 7]; target = [C.x + 14, y0 + 4.2, C.z + 12]; break;
      case 'clear':
      default: pos = [C.x + 6, y0 + 1.75, C.z + 7]; target = [C.x - 14, y0 + 4.2, C.z - 12]; break;
    }
    app.setView({ pos, target, fov });
    env.setShadowFocus?.(new THREE.Vector3(C.x, y0, C.z));
    bamboo?.cull?.();
  }
  if (!p.has('harness')) app.debugControls();
  view(p.get('view') || 'clear');

  window.__bamboo = { bamboo, env, view, lightning: () => env.lightning?.() };
  app.progress(1, '');
  await app.ready();
}
