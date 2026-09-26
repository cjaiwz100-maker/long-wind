// Post-processing test scene (R): exercises every pass of core/pipeline.js.
//   environment + terrain (+ real grass when V's module loads, else a local blade field for AA/shimmer tests),
//   a posed mannequin with a jian (ACTORS), tall stone pillars, a gate and a golden tree between the camera and the
//   low sun (shafts + dappled shafts), HDR emissive orbs (bloom), a 0.18 grey card (grade check), additive motes and a
//   soft mist card on the TRANSPARENT layer (copy/depth soft-particle test).
// URL: /?scene=post[&view=sun|hero|card|back|wide|low][&debug=ao|vol|bloom|depth|copy][&aa=msaa|taa|fxaa|msaa+taa]
//      [&grass=real|local|none][&fx=hit|slowmo|damage|mist|letterbox][&perf][&freeze]
// Harness: node tools/shot.mjs --scene post --q "view=sun" --out shots/R/sun.png
// Hooks: window.__post = { pipeline, view(name), hit(), pan(degPerSec), orbit(stop?) }
import * as THREE from 'three';
import { G, LAYERS, SUN_DIR } from '../core/globals.js';
import { patchMaterial, addShaderHook } from '../core/atmosphere.js';
import { createMannequin } from '../character/skeleton.js';
import { mulberry32 } from '../core/noise.js';

const imp = (path) => import(/* @vite-ignore */ path);
async function tryLoad(label, fn) {
  try { return await fn(); } catch (e) { console.warn(`[post scene] ${label} unavailable:`, e?.message ?? e); return null; }
}
const nextTick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

export default async function (app) {
  const q = app.params;
  const { scene, pipeline } = app;
  app.progress(0.05, '天 · sky');
  const env = await tryLoad('environment', async () => (await imp('../world/environment.js')).createEnvironment(app, { mood: q.get('mood') || 'golden' }));
  await nextTick();
  app.progress(0.2, '地 · earth');
  const terrain = await tryLoad('terrain', async () => (await imp('../world/terrain.js')).createTerrain(app));
  if (!terrain) {
    const g = new THREE.PlaneGeometry(2000, 2000, 1, 1); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, patchMaterial(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.16, 0.12, 0.045), roughness: 1 })));
    m.receiveShadow = true; scene.add(m);
  }
  await tryLoad('mountains', async () => (await imp('../world/mountains.js')).createMountains?.(app));
  await nextTick();

  const H = (x, z) => app.world.heightAt(x, z);
  const sunXZ = new THREE.Vector2(SUN_DIR.x, SUN_DIR.z).normalize();     // toward the sun
  const side = new THREE.Vector2(-sunXZ.y, sunXZ.x);                     // right-hand, looking into the sun
  const at = (d, s) => new THREE.Vector2(sunXZ.x * d + side.x * s, sunXZ.y * d + side.y * s);
  const hero = new THREE.Vector3(0, H(0, 0), 0);

  // ---- grass: real (V) or a local thin-blade field (good enough to judge AA/shimmer) ----
  app.progress(0.4, '草 · grass');
  const grassMode = q.get('grass') || 'real';
  let grass = null;
  if (grassMode === 'real') {
    await tryLoad('interaction', async () => (await imp('../world/interaction.js')).createInteraction(app));
    grass = await tryLoad('grass', async () => (await imp('../world/grass.js')).createGrass(app, { density: +(q.get('density') ?? 1) }));
  }
  if (!grass && grassMode !== 'none') grass = localGrass(app, hero, H);
  await nextTick();

  // ---- the swordsman (debug mannequin, ACTORS layer) in a raised-blade guard ----
  app.progress(0.6, '剑 · sword');
  const man = createMannequin({ color: 0x9a9fa3 });
  poseGuard(man.bones);
  man.group.position.copy(hero);
  man.group.rotation.y = Math.atan2(-sunXZ.x, -sunXZ.y) + 0.5;          // faces away from the sun, three-quarter to camera
  man.group.traverse((o) => { o.layers.set(LAYERS.ACTORS); if (o.isMesh) { patchMaterial(o.material); o.castShadow = true; } });
  scene.add(man.group);
  // a sword glint (HDR emissive, well above the bloom threshold)
  const glint = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(40, 30, 18) }));
  glint.position.set(0, 0, 0.84); man.sword.add(glint);
  glint.layers.set(LAYERS.ACTORS);

  // ---- occluders between the camera and the low sun: pillars, a gate, a golden tree ----
  app.progress(0.7, '石 · stone');
  const stoneMat = patchMaterial(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.18, 0.17, 0.155), roughness: 0.92 }));
  const pillar = (d, s, h, r, lean = 0) => {
    const p2 = at(d, s), y = H(p2.x, p2.y);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r, h, 14, 1), stoneMat);
    m.position.set(p2.x, y + h / 2 - 0.3, p2.y); m.rotation.z = lean; m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  pillar(16, -7, 9, 0.55); pillar(24, 6.5, 12, 0.7); pillar(34, -13, 7, 0.6, 0.08); pillar(48, 11, 14, 0.8);
  pillar(62, -4, 10, 0.7, -0.05); pillar(20, 15, 6, 0.5);
  // a stone gate (two posts + lintel): a big shaft window
  {
    const g = at(38, 1.5), y = H(g.x, g.y);
    const grp = new THREE.Group(); grp.position.set(g.x, y, g.y); grp.rotation.y = Math.atan2(sunXZ.x, sunXZ.y) + Math.PI / 2;
    for (const sx of [-2.6, 2.6]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 8, 0.7), stoneMat); m.position.set(sx, 3.8, 0); m.castShadow = true; grp.add(m); }
    const lint = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.8, 1.0), stoneMat); lint.position.set(0, 8.0, 0); lint.castShadow = true; grp.add(lint);
    const lint2 = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.45, 0.6), stoneMat); lint2.position.set(0, 6.7, 0); lint2.castShadow = true; grp.add(lint2);
    scene.add(grp);
  }
  const tree = goldenTree(at(28, -3), H);
  scene.add(tree);

  // ---- HDR emissive orbs (bloom) ----
  const orbMat = (r, g, b) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
  const orbs = [];
  for (const [d, s, y, c] of [[3, 2.2, 1.6, [30, 14, 4]], [5, -2.5, 2.3, [18, 10, 5]], [9, 3.5, 0.9, [8, 3, 1]]]) {
    const p2 = at(d, s);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), orbMat(...c));
    m.position.set(p2.x, H(p2.x, p2.y) + y, p2.y);
    scene.add(m); orbs.push(m);
  }

  // ---- 0.18 grey card facing the sun (grade check: must read sRGB ≈ 150–175) ----
  const card = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.3), patchMaterial(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.18, 0.18, 0.18), roughness: 1, metalness: 0 })));
  {
    const p2 = at(-2, 4.5);
    card.position.set(p2.x, H(p2.x, p2.y) + 1.2, p2.y);
    card.lookAt(card.position.clone().add(new THREE.Vector3(SUN_DIR.x, 0.0, SUN_DIR.z)));
    card.castShadow = true;
    scene.add(card);
  }

  // ---- transparent layer: additive motes + a soft ground-mist card, depth-faded against pipeline.copyTexture ----
  scene.add(motes(hero, H));
  scene.add(mistCard(at(10, 0), H, sunXZ));

  // shadows: wire the sun(s) into the shafts; widen the stub light's frustum so the far pillars cast
  const sunFar = env?.sunFar ?? env?.sun ?? null, sunNear = env?.sunNear ?? null;
  if (sunFar && !env?.sunNear) {
    const c = sunFar.shadow.camera; c.left = -90; c.right = 90; c.top = 90; c.bottom = -90; c.far = 600; c.updateProjectionMatrix();
    sunFar.shadow.mapSize.set(4096, 4096); sunFar.shadow.map?.dispose(); sunFar.shadow.map = null;
  }
  if (sunFar) pipeline.setShadowSources({ far: sunFar, near: sunNear });
  const focus = new THREE.Vector3(hero.x + sunXZ.x * 18, hero.y, hero.z + sunXZ.y * 18);
  env?.setShadowFocus?.(env?.sunNear ? hero : focus);

  // ---- views ----
  const views = {
    sun: () => { const c = at(-8.5, 1.8); const t = at(20, -1); return { pos: [c.x, H(c.x, c.y) + 1.35, c.y], target: [t.x, hero.y + 3.2, t.y], fov: 48 }; },
    hero: () => { const c = at(-3.6, 1.2); return { pos: [c.x, hero.y + 1.45, c.y], target: [hero.x, hero.y + 1.25, hero.z], fov: 40 }; },
    low: () => { const c = at(-6, 0.5); const t = at(20, 0); return { pos: [c.x, H(c.x, c.y) + 0.45, c.y], target: [t.x, hero.y + 2.5, t.y], fov: 50 }; },
    wide: () => { const c = at(-22, 6); const t = at(30, -2); return { pos: [c.x, H(c.x, c.y) + 2.4, c.y], target: [t.x, hero.y + 3.5, t.y], fov: 50 }; },
    card: () => { const c = at(1.2, 5.6); return { pos: [c.x, card.position.y + 0.1, c.y], target: [card.position.x, card.position.y, card.position.z], fov: 30 }; },
    back: () => { const c = at(6, -1); const t = at(-30, 2); return { pos: [c.x, H(c.x, c.y) + 1.5, c.y], target: [t.x, hero.y + 1.8, t.y], fov: 48 }; },
  };
  const view = (name) => { const v = (views[name] || views.sun)(); app.setView(v); };
  app.debugControls();
  view(q.get('view') || 'sun');

  // camera motion for shimmer / reprojection tests
  let panRate = 0, orbitOn = false;
  const target = new THREE.Vector3(), off = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  app.add({
    update(dt, t, app_, rawDt) {
      man.update?.(dt);
      for (let i = 0; i < orbs.length; i++) orbs[i].position.y += Math.sin(t * 1.3 + i * 2.1) * 0.0015;
      if (panRate || orbitOn) {
        const c = app.camera, ctl = app.controls;
        if (ctl) target.copy(ctl.target);
        off.copy(c.position).sub(target);
        off.applyAxisAngle(UP, THREE.MathUtils.degToRad(panRate) * rawDt);
        c.position.copy(target).add(off); c.lookAt(target);
      }
    },
  });

  // scripted post fx for screenshots
  const fx = pipeline.fx;
  const hit = () => { fx.impact(1, man.sword.getWorldPosition(new THREE.Vector3())); fx.flash(0.8); fx.dust(0.8); };
  const fxName = q.get('fx');
  if (fxName === 'hit') setInterval(hit, 900);
  if (fxName === 'slowmo') fx.setSlowmo(1);
  if (fxName === 'damage') fx.setDamage(1);
  if (fxName === 'letterbox') fx.letterbox(true, 0.01);
  if (fxName === 'mist') setTimeout(() => fx.fade(0.55, 0.3, 'mist'), 500);

  // per-pass timing: gl.finish() around each pass for n frames, medians (the GPU is shared → use medians)
  const bench = async (n = 90, mode = 'sync') => {
    pipeline.params.profile = mode; pipeline.profiler.reset();
    await new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const m = pipeline.profiler.medians();
    pipeline.params.profile = false;
    m.post = +(m.total - (m.opaque ?? 0) - (m.transparent ?? 0)).toFixed(3);
    return m;
  };
  window.__post = { pipeline, env, grass, man, view, hit, card, bench, benchmark: (n = 30, only = null) => pipeline.benchmark(scene, app.camera, n, only), pan(d = 6) { panRate = d; }, orbit(on = true) { orbitOn = on; panRate = on ? 8 : 0; } };
  app.progress(1, '');
  await app.ready();
}

// A rakish guard: sword raised high over the right shoulder, left hand forward (sword-fingers 剑指).
function poseGuard(B) {
  const D = Math.PI / 180, e = (b, x, y, z) => B[b]?.rotation.set(x * D, y * D, z * D);
  e('spine', 4, -12, 0); e('chest', 2, -14, 0); e('neck', 0, 18, 0); e('head', -4, 10, 0);
  e('upperArm.R', 0, 25, 120); e('lowerArm.R', 0, -60, 0); e('hand.R', -25, 0, -30);
  e('upperArm.L', 0, -55, -20); e('lowerArm.L', 0, 30, 0);
  e('upperLeg.L', -28, 0, 6); e('lowerLeg.L', 18, 0, 0); e('foot.L', 8, 0, 0);
  e('upperLeg.R', 22, 0, -8); e('lowerLeg.R', 30, 0, 0); e('foot.R', -10, 0, 0);
  B.hips.position.y -= 0.07;
}

// ---- local thin-blade field (only when V's grass is unavailable) ----
function localGrass(app, c, H) {
  const N = 140000, R = 38;
  const segs = 4;
  const pos = [], col = [], idx = [];
  for (let r = 0; r <= segs; r++) {
    const t = r / segs, w = 0.022 * (1 - t * 0.85);
    pos.push(-w, t, 0, w, t, 0);
    const k = Math.pow(t, 1.4);
    const root = [0.035, 0.028, 0.010], mid = [0.26, 0.19, 0.06], tip = [0.62, 0.46, 0.16];
    const cc = k < 0.5 ? root.map((v, i) => v + (mid[i] - v) * k * 2) : mid.map((v, i) => v + (tip[i] - v) * (k - 0.5) * 2);
    col.push(...cc, ...cc);
    if (r < segs) { const a = r * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  const off = new Float32Array(N * 4), rnd = mulberry32(77);
  for (let i = 0; i < N; i++) {
    const r = Math.sqrt(rnd()) * R, a = rnd() * Math.PI * 2;
    const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
    off[i * 4] = x; off[i * 4 + 1] = H(x, z); off[i * 4 + 2] = z; off[i * 4 + 3] = rnd();
  }
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
  g.instanceCount = N;
  const mat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }));
  addShaderHook(mat, 'postLocalGrass', (sh) => {
    sh.uniforms.uTimeL = G.uTime;
    sh.vertexShader = 'attribute vec4 aOff;\nuniform float uTimeL;\n' + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      float hgt = 0.55 + 0.6 * fract(aOff.w * 13.7);
      float yaw = aOff.w * 40.0;
      vec3 transformed = vec3(position.x * cos(yaw), position.y * hgt, position.x * sin(yaw));
      float sway = sin(uTimeL * 1.7 + aOff.x * 0.35 + aOff.z * 0.21) * 0.12 + 0.18;
      transformed.xz += vec2(0.62, 0.78) * sway * position.y * position.y * hgt;
      transformed += aOff.xyz;`);
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.renderOrder = -4;
  mesh.layers.set(LAYERS.MAIN_ONLY);
  app.scene.add(mesh);
  return { mesh, local: true };
}

// ---- a golden poplar silhouette: trunk, branches, alpha-tested leaf cards (dappled shafts) ----
function goldenTree(p2, H) {
  const grp = new THREE.Group();
  const y0 = H(p2.x, p2.y);
  grp.position.set(p2.x, y0, p2.y);
  const bark = patchMaterial(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.07, 0.055, 0.04), roughness: 0.95 }));
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.5, 7, 10), bark);
  trunk.position.y = 3.3; trunk.rotation.z = 0.06; trunk.castShadow = true; grp.add(trunk);
  const rnd = mulberry32(5);
  const centres = [];
  for (let i = 0; i < 7; i++) {
    const a = i / 7 * Math.PI * 2 + rnd() * 0.5, len = 2.5 + rnd() * 2.2, tilt = 0.55 + rnd() * 0.5;
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.16, len, 6), bark);
    const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const base = new THREE.Vector3(0, 5.2 + rnd() * 1.6, 0);
    br.position.copy(base).addScaledVector(dir, len / 2);
    br.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    br.castShadow = true; grp.add(br);
    centres.push(base.clone().addScaledVector(dir, len));
  }
  centres.push(new THREE.Vector3(0, 9.2, 0));
  // leaf texture
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  for (const [x, y, s] of [[20, 22, 1], [42, 20, 0.9], [30, 42, 1.1]]) {
    ctx.beginPath(); ctx.ellipse(x, y, 9 * s, 14 * s, 0.6, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const leafMat = patchMaterial(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.62, 0.40, 0.06), alphaMap: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 }));
  leafMat.map = tex; // the shadow depth material needs map + alphaTest to cut the leaves
  const n = 2600;
  const leaves = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.55, 0.55), leafMat, n);
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < n; i++) {
    const c = centres[i % centres.length];
    v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize().multiplyScalar(Math.pow(rnd(), 0.6) * 2.4);
    v.y *= 0.7; v.add(c);
    e.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28); q4.setFromEuler(e);
    m4.compose(v, q4, s); leaves.setMatrixAt(i, m4);
  }
  leaves.castShadow = true;
  grp.add(leaves);
  return grp;
}

// ---- transparent-layer helpers ----
function motes(c, H) {
  const N = 500, pos = new Float32Array(N * 3), rnd = mulberry32(9);
  for (let i = 0; i < N; i++) {
    const x = c.x + (rnd() - 0.5) * 24, z = c.z + (rnd() - 0.5) * 24;
    pos[i * 3] = x; pos[i * 3 + 1] = H(x, z) + 0.3 + rnd() * 3.5; pos[i * 3 + 2] = z;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: G.uTime, tSceneCopy: G.tSceneCopy, uCamNearFar: G.uCamNearFar, uRes: G.uResolution },
    vertexShader: /* glsl */`
      uniform float uTime; uniform vec2 uRes; varying float vDepth; varying float vA;
      void main() {
        vec3 p = position; float ph = p.x * 1.7 + p.z * 0.9;
        p += vec3(sin(uTime * 0.4 + ph), sin(uTime * 0.7 + ph * 1.3) * 0.4, cos(uTime * 0.33 + ph)) * 0.35;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDepth = -mv.z; vA = 0.5 + 0.5 * sin(uTime * 1.3 + ph * 3.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uRes.y / 900.0 * 26.0 / vDepth, 1.5, 14.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tSceneCopy; uniform vec2 uRes; varying float vDepth; varying float vA;
      void main() {
        vec2 d = gl_PointCoord - 0.5; float r2 = dot(d, d) * 4.0; if (r2 > 1.0) discard;
        float sceneD = texture2D(tSceneCopy, gl_FragCoord.xy / uRes).a;
        float soft = clamp((sceneD - vDepth) / 0.4, 0.0, 1.0);
        float a = (1.0 - r2) * (1.0 - r2) * soft * (0.35 + 0.65 * vA);
        gl_FragColor = vec4(vec3(2.4, 1.6, 0.8) * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false; pts.layers.set(LAYERS.TRANSPARENT);
  return pts;
}

function mistCard(p2, H, sunXZ) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: G.uTime, tSceneCopy: G.tSceneCopy, uRes: G.uResolution, uFogWarm: G.uFogWarm },
    vertexShader: `varying vec2 vUv; varying float vDepth; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform sampler2D tSceneCopy; uniform vec2 uRes; uniform vec3 uFogWarm; varying vec2 vUv; varying float vDepth;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main() {
        float sceneD = texture2D(tSceneCopy, gl_FragCoord.xy / uRes).a;
        float soft = clamp((sceneD - vDepth) / 2.5, 0.0, 1.0);
        float edge = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x) * smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.25, vUv.y);
        float m = n(vUv * vec2(6.0, 2.0) + vec2(uTime * 0.05, 0.0)) * 0.6 + 0.4;
        gl_FragColor = vec4(uFogWarm * 0.55, 0.35 * soft * edge * m);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(26, 3.2), mat);
  m.position.set(p2.x, H(p2.x, p2.y) + 1.2, p2.y);
  m.rotation.y = Math.atan2(sunXZ.x, sunXZ.y);
  m.layers.set(LAYERS.TRANSPARENT);
  return m;
}
