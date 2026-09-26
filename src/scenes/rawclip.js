// Raw clip viewer (owner: animation A): a GLB's own animation clips as a filmstrip, no retarget, no game logic — for
// choosing source material for the baked layers (character.js BAKED tables).
//   ?scene=rawclip&url=assets/models/hero-tripo.glb&clip=<index | name prefix>&n=8&t0=0&t1=<dur>&view=side|front|three
//   ?scene=rawclip&url=...&list=1        prints every clip (index, duration, name) to the console and window.__clips
//   ?scene=rawclip&mx=ssSlash&clip=mx:ssSlash   a Mixamo take (assets/anims/mixamo.glb) retargeted onto the model
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { LAYERS } from '../core/globals.js';

const VIEWS = { side: [-1, 0.12, 0], front: [0, 0.12, 1], three: [-0.8, 0.28, 0.85], back: [0, 0.2, -1] };

export default async function (app) {
  const P = app.params;
  const { scene } = app;
  // the same review lighting as the anim scene (the environment sets the shared fog/sky uniforms)
  try { const m = await import('../world/environment.js'); m.createEnvironment(app, { mood: 'golden' }); } catch (e) { console.warn('[rawclip] environment failed', e); }
  const key = new THREE.DirectionalLight(0xfff1dc, 2.4); key.position.set(-7, 10, 6); key.layers.enableAll(); scene.add(key, key.target);
  const fill = new THREE.HemisphereLight(0xc8d6e4, 0x5a4a35, 1.1); fill.layers.enableAll(); scene.add(fill);
  scene.add(new THREE.GridHelper(80, 160, 0x5a5448, 0x6a6456));

  const gltf = await new GLTFLoader().loadAsync(P.get('url') || 'assets/models/hero-tripo.glb');
  const clips = gltf.animations;
  // &mx=key1,key2: Mixamo takes from assets/anims/mixamo.glb, retargeted onto this model (clip names 'mx:<key>')
  if (P.get('mx')) {
    const { retargetMixamo } = await import('../character/mixamoAnims.js');
    const pack = await new GLTFLoader().loadAsync('assets/anims/mixamo.glb');
    const mb = (n) => gltf.scene.getObjectByName('mixamorig' + n) ?? gltf.scene.getObjectByName('mixamorig:' + n);
    clips.push(...retargetMixamo(pack, gltf.scene, mb, new THREE.Matrix4(), P.get('mx').split(',')));
  }
  window.__clips = clips.map((c, i) => [i, +c.duration.toFixed(2), c.name]);
  if (P.has('list')) console.log(window.__clips.map((x) => x.join(' ')).join('\n'));
  const want = P.get('clip') ?? '0';
  const clip = /^\d+$/.test(want) ? clips[+want] : clips.find((c) => c.name.startsWith(want));
  const n = +(P.get('n') || 8);
  const t0 = +(P.get('t0') || 0), t1 = +(P.get('t1') || clip.duration);
  // fit the model to ~1.8 m
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const k = 1.8 / Math.max(0.01, box.max.y - box.min.y);
  const vd = new THREE.Vector3(...(VIEWS[P.get('view')] || VIEWS.side)).normalize();
  const across = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), vd).normalize();
  const spacing = +(P.get('spacing') || 1.6);
  for (let i = 0; i < n; i++) {
    const m = SkeletonUtils.clone(gltf.scene);
    m.scale.setScalar(k);
    m.traverse((o) => { o.layers.set(LAYERS.ACTORS); o.frustumCulled = false; });
    const mixer = new THREE.AnimationMixer(m);
    const a = mixer.clipAction(clip); a.play();
    mixer.setTime(t0 + (t1 - t0) * (i / (n - 1)));
    // keep the root travel but lay the frames out side by side
    m.position.copy(across).multiplyScalar((i - (n - 1) / 2) * spacing);
    scene.add(m);
  }
  const width = n * spacing + 1;
  const fov = 7, dist = (width / 2) / Math.tan((fov * Math.PI / 180) / 2) / (innerWidth / innerHeight) * 1.05;
  const target = new THREE.Vector3(0, 0.95, 0);
  app.setView({ pos: target.clone().addScaledVector(vd, Math.max(dist, 12)).toArray(), target: target.toArray(), fov });
  app.camera.far = 400; app.camera.updateProjectionMatrix();
  const lab = document.createElement('div');
  lab.style.cssText = 'position:fixed;left:0;right:0;top:6px;text-align:center;color:#fff;font:600 14px sans-serif;text-shadow:0 0 3px #000;z-index:9';
  lab.textContent = `[${clips.indexOf(clip)}] ${clip.name} · ${t0.toFixed(2)}–${t1.toFixed(2)}s`;
  document.body.appendChild(lab);
  app.freeze(true);
  app.ready();
}
