// Character test scene (owner: character C). Lineup of every kind under golden light, turntable, close-ups and
// static pose tests that drive bones directly (no animator dependency) to validate deformation and cloth.
//   ?scene=character&kinds=hero,bandit,bandit_heavy,swordmaster&pose=relaxed&cam=front&spin=0
//   poses: bind, tpose, relaxed, guard, stride, overhead, lunge, crouch, twist, run (animated), anim (Animator)
//   cams : front, back, side, sun (contre-jour), close, face, hat, low, lineup, feet, hand
// Harness hooks: window.__char = { chars, setPose(name), setCam(name), spin(on) }.
import * as THREE from 'three';
import { SUN_DIR } from '../core/globals.js';

const D = Math.PI / 180;

/** Static test poses: bone → [x, y, z] Euler degrees (rest = identity), plus hips offset. */
export const POSES = {
  bind: null,
  tpose: {},
  relaxed: { 'upperArm.L': [0, 8, -74], 'upperArm.R': [0, -8, 74], 'lowerArm.L': [0, -14, 0], 'lowerArm.R': [0, 14, 0], 'hand.R': [0, 0, 0], neck: [4, 0, 0], head: [-4, 0, 0] },
  guard: {
    'upperArm.R': [0, 60, 58], 'lowerArm.R': [0, 42, 0], 'hand.R': [-10, 0, -20],
    'upperArm.L': [0, -40, -62], 'lowerArm.L': [0, -95, 0], 'hand.L': [0, 0, 10],
    spine: [6, -12, 0], chest: [0, -10, 0], head: [0, 18, 0],
    'upperLeg.L': [-18, 0, -4], 'lowerLeg.L': [20, 0, 0], 'upperLeg.R': [16, -20, 6], 'lowerLeg.R': [22, 0, 0], 'foot.L': [-4, 0, 0], 'foot.R': [-8, 0, 0], hips: { y: -0.06 },
  },
  stride: {
    'upperLeg.L': [-38, 0, -3], 'lowerLeg.L': [18, 0, 0], 'foot.L': [18, 0, 0], 'upperLeg.R': [28, 0, 3], 'lowerLeg.R': [42, 0, 0], 'foot.R': [-12, 0, 0],
    'upperArm.L': [30, 8, -72], 'upperArm.R': [0, -60, 70], 'lowerArm.R': [0, 30, 0], 'lowerArm.L': [0, -20, 0],
    spine: [8, 10, 0], chest: [0, 6, 0], hips: { y: -0.05 },
  },
  overhead: {
    'upperArm.R': [0, 10, -95], 'lowerArm.R': [0, 20, 0], 'hand.R': [0, 0, -30],
    'upperArm.L': [0, -10, 95], 'lowerArm.L': [0, -30, 0],
    spine: [-10, 0, 0], chest: [-8, 0, 0], head: [10, 0, 0],
    'upperLeg.L': [-20, 0, -6], 'lowerLeg.L': [20, 0, 0], 'upperLeg.R': [15, 0, 6], 'lowerLeg.R': [10, 0, 0], hips: { y: -0.04 },
  },
  lunge: {
    'upperLeg.L': [-85, 0, -6], 'lowerLeg.L': [80, 0, 0], 'foot.L': [5, 0, 0], 'upperLeg.R': [42, 0, 8], 'lowerLeg.R': [20, 0, 0], 'foot.R': [-30, 0, 0],
    spine: [22, 0, 0], chest: [6, 0, 0], neck: [-10, 0, 0], head: [-14, 0, 0],
    'upperArm.R': [0, 88, 8], 'lowerArm.R': [0, 6, 0], 'upperArm.L': [0, 30, -20], 'lowerArm.L': [0, -10, 0], hips: { y: -0.36, z: 0.05 },
  },
  crouch: {
    'upperLeg.L': [-105, 0, -12], 'lowerLeg.L': [135, 0, 0], 'foot.L': [-25, 0, 0], 'upperLeg.R': [-95, 0, 12], 'lowerLeg.R': [140, 0, 0], 'foot.R': [-40, 0, 0],
    spine: [32, 0, 0], chest: [12, 0, 0], neck: [-18, 0, 0], head: [-20, 0, 0],
    'upperArm.L': [0, 30, -60], 'lowerArm.L': [0, -40, 0], 'upperArm.R': [0, -30, 60], 'lowerArm.R': [0, 40, 0], hips: { y: -0.5, z: -0.12 },
  },
  twist: {
    spine: [0, 32, 0], chest: [0, 28, 6], neck: [0, -18, 0], head: [0, -22, 0],
    'upperArm.R': [0, 75, 40], 'lowerArm.R': [0, 20, 0], 'upperArm.L': [0, 50, -60], 'lowerArm.L': [0, -60, 0],
    'upperLeg.L': [-10, 20, -8], 'upperLeg.R': [10, 20, 8], hips: { y: -0.03 },
  },
};

function applyPose(ch, name, t = 0) {
  const B = ch.rig.bones;
  for (const n in B) B[n].quaternion.identity();
  const hips = B.hips; hips.position.set(0, 0.98 * (ch.scale || 1), 0);
  let p = POSES[name];
  if (name === 'run') p = runPose(t);
  if (!p) return false; // bind: leave identity (T-pose) → shows the mesh in rest
  const e = new THREE.Euler();
  for (const k in p) {
    if (k === 'hips') continue;
    const [x, y, z] = p[k];
    B[k]?.quaternion.setFromEuler(e.set(x * D, y * D, z * D, 'XYZ'));
  }
  if (p.hips) { hips.position.y += p.hips.y || 0; hips.position.z += p.hips.z || 0; }
  return true;
}

function runPose(t) {
  const ph = t * 2 * Math.PI * 1.35, s = Math.sin(ph), c = Math.cos(ph);
  return {
    'upperLeg.L': [-40 * s - 5, 0, -3], 'lowerLeg.L': [35 + 35 * Math.max(0, c), 0, 0], 'foot.L': [10 * s, 0, 0],
    'upperLeg.R': [40 * s - 5, 0, 3], 'lowerLeg.R': [35 + 35 * Math.max(0, -c), 0, 0], 'foot.R': [-10 * s, 0, 0],
    'upperArm.L': [40 * s, 10, -70], 'lowerArm.L': [0, -40, 0], 'upperArm.R': [-30 * s, -60, 65], 'lowerArm.R': [0, 30, 0],
    spine: [14, 8 * s, 0], chest: [0, -10 * s, 0], hips: { y: -0.04 - 0.03 * Math.abs(c) },
  };
}

async function tryImport(path) {
  try { return await import(/* @vite-ignore */ path); } catch (e) { console.warn(`[character scene] ${path} unavailable`, e); return null; }
}

export default async function (app) {
  const q = app.params;
  const kinds = (q.get('kinds') || 'hero,bandit,bandit_heavy,swordmaster').split(',').filter(Boolean);
  let poseName = q.get('pose') || 'relaxed';
  app.progress(0.1, 'environment');
  const envMod = await tryImport('../world/environment.js');
  let env = null;
  try { env = envMod?.createEnvironment?.(app, { mood: q.get('mood') || 'golden' }); } catch (e) { console.warn('environment failed', e); }
  const terMod = await tryImport('../world/terrain.js');
  try { await terMod?.createTerrain?.(app); } catch (e) { console.warn('terrain failed', e); }
  ensureLighting(app, env);

  app.progress(0.3, 'characters');
  const { createCharacter } = await import('../character/character.js');
  const chars = [];
  const spacing = +(q.get('spacing') || 1.25);
  const t0 = performance.now();
  const built = await Promise.all(kinds.map((k, i) => { const [kind, seedS] = k.split(':'); return createCharacter({ kind, seed: +(seedS || i + 1) }); }));
  console.log(`[character scene] built ${kinds.length} characters in ${(performance.now() - t0).toFixed(0)} ms`, built.map(c => `${c.kind}:${c.seed} ${c.buildMs}ms ${c.stats.total} tris`).join(' | '));
  for (let i = 0; i < kinds.length; i++) {
    const ch = built[i];
    const x = (i - (kinds.length - 1) / 2) * spacing;
    const z = 0;
    ch.group.position.set(x, app.world.heightAt(x, z), z);
    ch.group.rotation.y = +(q.get('yaw') || 0) * D;
    app.scene.add(ch.group);
    chars.push(ch);
    app.progress(0.3 + 0.6 * (i + 1) / kinds.length, ch.kind);
  }

  // optional: the real animator (only if it can drive our rig)
  let anims = null;
  if (poseName === 'anim') {
    const am = await tryImport('../character/animator.js');
    if (am?.Animator) anims = chars.map(ch => { try { return new am.Animator(ch.rig, { heightAt: app.world.heightAt }); } catch (e) { console.warn(e); return null; } });
  }

  let spin = +(q.get('spin') || 0), t = 0;
  app.add({
    update(dt) {
      t += dt;
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (anims?.[i]) { const clip = q.get('clip'); if (clip && !anims[i].isActing) anims[i].play(clip); else if (!clip) anims[i].setLocomotion({ speed: 1.6 }); anims[i].update(dt, ch.group); }
        else if (poseName === 'run') applyPose(ch, 'run', t);
        if (spin) ch.group.rotation.y += dt * spin;
        ch.update?.(dt, t);
      }
    },
  });

  const setPose = (name) => { poseName = name; for (const ch of chars) { applyPose(ch, name, t); ch.resetCloth?.(); } };
  setPose(poseName);

  // ---- cameras (character at x, facing +Z). The sun is toward −x −z (contre-jour = camera on the +x +z side).
  const focus = chars.length === 1 ? chars[0].group.position : new THREE.Vector3(0, chars[0].group.position.y, 0);
  const sunXZ = new THREE.Vector2(SUN_DIR.x, SUN_DIR.z).normalize();
  const setCam = (name) => {
    const f = focus.clone();
    const y = f.y;
    const views = {
      front: { pos: [f.x + 0.4, y + 1.35, f.z + 4.2], target: [f.x, y + 1.0, f.z], fov: 40 },
      back: { pos: [f.x - 0.3, y + 1.4, f.z - 4.0], target: [f.x, y + 1.0, f.z], fov: 40 },
      side: { pos: [f.x + 4.2, y + 1.3, f.z + 0.2], target: [f.x, y + 1.0, f.z], fov: 40 },
      sun: { pos: [f.x - sunXZ.x * 4.2, y + 1.2, f.z - sunXZ.y * 4.2], target: [f.x, y + 1.15, f.z], fov: 42 },
      close: { pos: [f.x + 0.35, y + 1.55, f.z + 1.6], target: [f.x, y + 1.3, f.z], fov: 38 },
      face: { pos: [f.x + 0.15, y + 1.62, f.z + 0.75], target: [f.x, y + 1.6, f.z], fov: 35 },
      hat: { pos: [f.x + 0.6, y + 1.9, f.z + 1.1], target: [f.x, y + 1.62, f.z], fov: 38 },
      low: { pos: [f.x + 1.2, y + 0.5, f.z + 2.6], target: [f.x, y + 1.1, f.z], fov: 45 },
      lineup: { pos: [f.x + 0.2, y + 1.5, f.z + 6.5], target: [f.x, y + 0.95, f.z], fov: 42 },
      feet: { pos: [f.x + 0.5, y + 0.45, f.z + 1.4], target: [f.x, y + 0.3, f.z], fov: 40 },
      hand: { pos: [f.x - 0.5, y + 1.1, f.z + 0.9], target: [f.x - 0.3, y + 0.95, f.z + 0.2], fov: 36 },
    };
    const v = views[name] || views.front;
    app.setView(v);
    try { env?.setShadowFocus?.(f); } catch { /* optional */ }
  };
  setCam(q.get('cam') || (chars.length > 1 ? 'lineup' : 'front'));
  if (q.has('orbit')) app.debugControls();

  // camera relative to the focus point on the ground (harness: __char.view([x,y,z], [tx,ty,tz], fov))
  const view = (p, t2, fov = 40) => { const f = focus; app.setView({ pos: [f.x + p[0], f.y + p[1], f.z + p[2]], target: [f.x + t2[0], f.y + t2[1], f.z + t2[2]], fov }); };
  // debug: material term toggles (__char.mat({ trans: 0, rim: 0 }))
  const mat = (o) => { for (const ch of chars) for (const m of ch.materials.list) { const u = m.userData.wxc; if (!u) continue; if (o.trans !== undefined) u.uTransK.value.multiplyScalar(o.trans); if (o.rim !== undefined) u.uRimK.value *= o.rim; } };
  window.__char = { chars, setPose, setCam, view, mat, spin(v) { spin = v; }, POSES, stats: chars.map(c => c.stats) };
  app.progress(1, '');
  await app.ready();
}

/** If the environment module doesn't provide a camera-side fill or an env map yet, add minimal stand-ins. */
function ensureLighting(app, env) {
  const scene = app.scene;
  let hasFill = !!env?.fill;
  if (!hasFill) {
    const fill = new THREE.DirectionalLight(new THREE.Color(0.62, 0.6, 0.58), 0.42);
    fill.position.set(0.55, 0.35, 0.76).multiplyScalar(100);
    fill.layers.enableAll();
    scene.add(fill);
  }
  if (!scene.environment) {
    // tiny gradient sky → PMREM so metals and sheen have something to reflect
    const s = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uSun: { value: SUN_DIR.clone() } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uSun; varying vec3 vD; void main(){ vec3 d = normalize(vD); float h = d.y;
        vec3 zen = vec3(0.085,0.16,0.27), up = vec3(0.26,0.36,0.45), hor = mix(vec3(0.33,0.43,0.50), vec3(1.05,0.66,0.36), pow(max(dot(d,uSun),0.0),2.5));
        vec3 c = h > 0.0 ? mix(hor, mix(up, zen, smoothstep(0.18,0.75,h)), smoothstep(0.0,0.22,h)) : mix(hor, vec3(0.21,0.175,0.08)*0.8, smoothstep(0.0,-0.15,h));
        c += vec3(5.6,3.55,1.75) * (pow(max(dot(d,uSun),0.0), 200.0) * 2.0 + pow(max(dot(d,uSun),0.0), 12.0)*0.06);
        gl_FragColor = vec4(c, 1.0); }`,
    });
    s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat));
    const pm = new THREE.PMREMGenerator(app.renderer);
    scene.environment = pm.fromScene(s, 0, 0.1, 100).texture;
    scene.environmentIntensity = 0.55;
    pm.dispose();
  }
}
