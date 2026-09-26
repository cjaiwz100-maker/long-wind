// Animation review scene. Owner: animation (A).
//
//   ?scene=anim&clip=attack1&t=0.2         pose one clip at one time (frozen)
//   ?scene=anim&play=attack1               loop a clip live (add &loco=1.6 to see upper-body layering while moving)
//   ?scene=anim&strip=attack1&n=8          filmstrip: n frames side by side, onion-skin ghosts + sword-tip path
//          &view=side|left|front|back|three|over|top|low   &t0=0&t1=<dur>   &ghosts=2   &spacing=1.9
//          &mesh=char (real character instead of the clay mannequin)   &kind=bandit
//   ?scene=anim&loco=5.2&strip=cycle&n=8   one gait cycle as a filmstrip (dir=, combat=1, armed=0)
//   ?scene=anim&loco=5.2&dir=fwd|back|left|right|fl|fr&combat=1&armed=0&turn=1.5   live locomotion
//          &strobe=1  stroboscopic trail of the gait (planted feet must overlap exactly)   &lockcam=1  camera glued to the figure
//   ?scene=anim&ground=terrain             use the real terrain (foot IK on slopes)
//   ?scene=anim&duel=enemyHeavy            hero vs bandit: the bandit plays the clip, the hero blocks/parries
//   ?scene=anim                            showreel: cycles every combat clip
// Hooks: window.__anim = { anim, ch, pose(name,t), play(name), setLoco({...}), slide(speed, dirX, dirZ) }.
import * as THREE from 'three';
import { createMannequin } from '../character/skeleton.js';
import { Animator, CLIPS } from '../character/animator.js';
import { COMPILED } from '../character/clips/index.js';

const VIEWS = {
  side: { dir: [-1, 0.14, 0], fov: 24 },     // from the character's right
  left: { dir: [1, 0.14, 0], fov: 24 },
  front: { dir: [0, 0.12, 1], fov: 24 },
  back: { dir: [0, 0.2, -1], fov: 24 },
  three: { dir: [-0.8, 0.28, 0.85], fov: 24 },
  threeL: { dir: [0.8, 0.28, 0.85], fov: 24 },
  over: { dir: [-0.35, 0.5, -1], fov: 24 },  // over-the-shoulder, like the game camera
  low: { dir: [-0.9, 0.02, 0.5], fov: 24 },  // hero-shot low angle
  top: { dir: [0, 1, 0.05], fov: 24 },
};

const CLAY = { hero: 0xc9c2b4, bandit: 0xa48a70, bandit_heavy: 0x947a62, swordmaster: 0x8a8490 };

/** Figure factory: clay mannequin (default: reads best for motion review) or the real character (mesh=char). */
async function makeFigure(kind, seed, useChar) {
  if (useChar) {
    try {
      const mod = await import('../character/character.js');
      return await mod.createCharacter({ kind, seed });
    } catch (e) { console.warn('[anim] createCharacter failed, using mannequin', e); }
  }
  const man = createMannequin({ color: CLAY[kind] ?? 0xc9c2b4, scale: kind === 'bandit_heavy' ? 1.08 : 1 });
  // brighter steel so the blade reads in the strips
  man.sword.traverse((o) => { if (o.isMesh && o.material.metalness > 0.5) { o.material = o.material.clone(); o.material.color.set(0xf4f6f8); o.material.emissive = new THREE.Color(0x303840); } });
  const group = new THREE.Group(); group.add(man.group);
  const tip = new THREE.Object3D(); tip.position.z = 0.86; man.sword.add(tip);
  const base = new THREE.Object3D(); base.position.z = 0.1; man.sword.add(base);
  return {
    group, rig: { root: man.root, bones: man.bones, skeleton: man.skeleton },
    sword: { object: man.sword, base, tip, drawn: true, setDrawn(v) { this.drawn = v; man.sword.visible = v; } },
    update() {}, setVisible(v) { group.visible = v; },
  };
}

/** Ghost mannequin (translucent) that copies bone transforms from a source rig. */
function makeGhost(color, opacity) {
  const man = createMannequin({ color });
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  man.group.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; } });
  const g = new THREE.Group(); g.add(man.group);
  return { group: g, rig: man };
}
function copyPose(srcRig, dstRig) {
  for (const n in dstRig.bones) {
    const s = srcRig.bones[n], d = dstRig.bones[n];
    if (s && d) { d.position.copy(s.position); d.quaternion.copy(s.quaternion); }
  }
}

function checkerGround(size = 80) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#6d6453'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#62594a';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) & 1) g.fillRect(x * 32, y * 32, 32, 32);
  g.strokeStyle = 'rgba(255,240,210,0.18)'; g.lineWidth = 2;
  for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 256); g.stroke(); g.beginPath(); g.moveTo(0, i * 32); g.lineTo(256, i * 32); g.stroke(); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(size / 4, size / 4); tex.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  m.rotation.x = -Math.PI / 2; m.receiveShadow = true;
  return m;
}

function label(text, x, y, color = '#f3ead8') {
  const d = document.createElement('div');
  d.textContent = text;
  Object.assign(d.style, { position: 'fixed', left: `${x}px`, top: `${y}px`, color, font: '600 14px/1.2 ui-monospace, Menlo, monospace', textShadow: '0 1px 3px #000', pointerEvents: 'none', zIndex: 20, transform: 'translate(-50%, 0)', whiteSpace: 'nowrap' });
  document.body.appendChild(d);
  return d;
}

/** Gameplay-side vertical hop for clips that declare meta.leap (the player controller adds it in the game). */
function leapAt(meta, t) {
  const L = meta.leap;
  if (!L) return 0;
  const u = (t - L.t0) / (L.t1 - L.t0);
  return u > 0 && u < 1 ? L.h * 4 * u * (1 - u) : 0;
}

const DIRS = { fwd: [0, 1], back: [0, -1], left: [1, 0], right: [-1, 0], fl: [0.707, 0.707], fr: [-0.707, 0.707], bl: [0.707, -0.707], br: [-0.707, -0.707] };

export default async function (app) {
  const P = app.params;
  const scene = app.scene;
  app.progress(0.1, 'anim');

  // ---- environment ----
  let env = null;
  try { const m = await import('../world/environment.js'); env = m.createEnvironment(app, { mood: P.get('mood') || 'golden' }); } catch (e) { console.warn('[anim] environment failed', e); }
  let heightAt = () => 0, normalAt = (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0);
  if (P.get('ground') === 'terrain') {
    try { const m = await import('../world/terrain.js'); await m.createTerrain(app); heightAt = app.world.heightAt; normalAt = app.world.normalAt; } catch (e) { console.warn('[anim] terrain failed', e); }
  } else {
    scene.add(checkerGround(240));
  }
  // review key light (front-side, readable) + soft fill, independent of the mood
  const key = new THREE.DirectionalLight(0xfff1dc, P.has('nokey') ? 0 : 2.4);
  key.position.set(-7, 10, 6); key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 0.5, far: 60 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  key.layers.enableAll();
  scene.add(key, key.target);
  const fill = new THREE.HemisphereLight(0xc8d6e4, 0x5a4a35, 1.1); fill.layers.enableAll(); scene.add(fill);

  const view = VIEWS[P.get('view') || 'three'] ?? VIEWS.three;
  const labels = [];
  const hooks = (window.__anim = {});
  const kind = P.get('kind') || 'hero';
  const style = kind === 'hero' ? 'hero' : 'bandit';
  const useChar = P.get('mesh') === 'char';
  const strip = P.get('strip');
  const locoSpeed = P.has('loco') ? parseFloat(P.get('loco') || '1.6') : null;
  const [dX, dZ] = DIRS[P.get('dir') || 'fwd'] ?? DIRS.fwd;
  const combat = P.get('combat') === '1';
  const armed = P.get('armed') !== '0';

  /** Numeric foot-slide check: simulate the gait and measure how fast the DESIRED anchor of a planted foot moves. */
  hooks.slide = async (speed = 1.6, dirX = 0, dirZ = 1, cmb = false, seconds = 3) => {
    const f = await makeFigure(kind, 1, false);
    const a = new Animator(f.rig, { heightAt, normalAt, style });
    const dt = 1 / 120, pos = new THREE.Vector3(), w = new THREE.Vector3(dirX, 0, dirZ).normalize();
    const prev = [new THREE.Vector3(), new THREE.Vector3()], has = [false, false];
    let max = 0, sum = 0, n = 0;
    for (let t = 0; t < seconds; t += dt) {
      a.setLocomotion({ speed, dirX, dirZ, combat: cmb });
      pos.addScaledVector(w, a.gait.speed * dt);
      f.group.position.copy(pos); f.group.updateMatrixWorld(true);
      a.update(dt, f.group);
      if (t < 1.2) continue;
      for (let i = 0; i < 2; i++) {
        const p = _tmp.copy(a.out.foot[i]).applyMatrix4(f.rig.root.matrixWorld);
        if (a.out.lock[i] > 0.95) {
          if (has[i]) { const v = Math.hypot(p.x - prev[i].x, p.z - prev[i].z) / dt; max = Math.max(max, v); sum += v; n++; }
          prev[i].copy(p); has[i] = true;
        } else has[i] = false;
      }
    }
    return { speed, maxSlide: +max.toFixed(3), meanSlide: +(sum / Math.max(1, n)).toFixed(4), cycle: +a.gait.cycle.toFixed(3) };
  };
  const _tmp = new THREE.Vector3();

  if (strip && (COMPILED[strip] || (strip === 'cycle' && locoSpeed !== null))) {
    // ================= filmstrip =================
    const isCycle = strip === 'cycle';
    const c = isCycle ? null : COMPILED[strip];
    const n = Math.max(2, Math.min(14, parseInt(P.get('n') || '8', 10)));
    const dur = isCycle ? 1 : c.duration;
    const t0 = parseFloat(P.get('t0') ?? '0'), t1 = parseFloat(P.get('t1') ?? String(dur));
    const nGhost = parseInt(P.get('ghosts') ?? '2', 10);
    const vd = new THREE.Vector3(...view.dir).normalize();
    const across = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), vd);
    if (across.lengthSq() < 1e-4) across.set(1, 0, 0);
    across.normalize();
    const spacing = parseFloat(P.get('spacing') ?? '1.9');
    const times = Array.from({ length: n }, (_, i) => t0 + (t1 - t0) * (i / (isCycle ? n : n - 1)));
    const figures = [];
    const root = new THREE.Vector3();
    const ghostSrc = await makeFigure(kind, 1, false);
    const ghostAnim = new Animator(ghostSrc.rig, { heightAt, normalAt, style });
    if (!armed) ghostAnim.setArmed(false);
    ghostSrc.group.visible = false; scene.add(ghostSrc.group);

    // evaluates `anim` at time t, returns the root transform (position offset + yaw)
    const evalAt = (anim, t, outPos) => {
      if (isCycle) {
        anim.poseLoco(locoSpeed, dX, dZ, t, { combat, armed });
        outPos.set(dX, 0, dZ).normalize().multiplyScalar(locoSpeed * anim.gait.cycle * t * (P.has('travel') ? 1 : 0));
        return 0;
      }
      anim.poseAt(strip, t);
      const yaw = c.rootAt(t, outPos);
      outPos.y = leapAt(c.meta, t);
      return yaw;
    };
    for (let i = 0; i < n; i++) {
      const ch = await makeFigure(kind, 1, useChar);
      const anim = new Animator(ch.rig, { heightAt, normalAt, style });
      if (!armed) { anim.setArmed(false); ch.sword.setDrawn?.(false); }
      const cell = across.clone().multiplyScalar((i - (n - 1) / 2) * spacing);
      scene.add(ch.group);
      const yaw = evalAt(anim, times[i], root);
      ch.group.position.copy(cell).add(root);
      ch.group.rotation.y = yaw;
      ch.update?.(0, 0);
      figures.push({ ch, anim, cell, t: times[i] });
      // onion skins between the previous frame time and this one
      const tPrev = i === 0 ? times[i] : times[i - 1];
      for (let k = 1; k <= nGhost && i > 0; k++) {
        const tg = tPrev + (times[i] - tPrev) * (k / (nGhost + 1));
        const gh = makeGhost(0x9fc4ff, 0.07 + 0.05 * k);
        const gy = evalAt(ghostAnim, tg, root);
        copyPose(ghostSrc.rig, gh.rig);
        gh.group.position.copy(cell).add(root); gh.group.rotation.y = gy;
        scene.add(gh.group);
      }
      // sword tip path over the whole clip (faint) and up to this frame (bright)
      if (!isCycle && armed) {
        const pts = [], ptsNow = [];
        const N = 120;
        for (let k = 0; k <= N; k++) {
          const tt = dur * (k / N);
          const gy = evalAt(ghostAnim, tt, root);
          ghostSrc.group.position.copy(cell).add(root); ghostSrc.group.rotation.y = gy;
          ghostSrc.group.updateMatrixWorld(true);
          const p = ghostSrc.sword.tip.getWorldPosition(new THREE.Vector3());
          pts.push(p);
          if (tt <= times[i] + 1e-4) ptsNow.push(p);
        }
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8fb3d9, transparent: true, opacity: 0.3 })));
        if (ptsNow.length > 1) scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ptsNow), new THREE.LineBasicMaterial({ color: 0xffb347 })));
      }
    }
    const m = c?.meta;
    const inHit = (t) => !!m && m.hit.some(([a, b]) => t >= a - 1e-4 && t <= b + 1e-4);
    // camera: fit the row
    const width = n * spacing + 1.5;
    const aspect = innerWidth / innerHeight;
    // near-orthographic long lens: every cell is seen from the same angle (a wide lens shows the end figures from
    // the side and fakes torso twists)
    const stripFov = parseFloat(P.get('fov') || '7');
    const vfov = stripFov * Math.PI / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const dist = Math.max((width * 0.5) / Math.tan(hfov / 2), 1.3 / Math.tan(vfov / 2) + 2);
    const target = new THREE.Vector3(0, parseFloat(P.get('ty') ?? '0.95'), 0);
    const pos = target.clone().addScaledVector(vd, dist);
    app.setView({ pos: pos.toArray(), target: target.toArray(), fov: stripFov });
    app.camera.far = Math.max(app.camera.far, dist * 3); app.camera.updateProjectionMatrix();
    app.freeze(true);
    const place = () => {
      for (const l of labels) l.remove();
      labels.length = 0;
      app.camera.updateMatrixWorld();
      figures.forEach((f) => {
        const p = f.cell.clone().setY(-0.12).project(app.camera);
        const x = (p.x * 0.5 + 0.5) * innerWidth, y = (-p.y * 0.5 + 0.5) * innerHeight;
        const txt = isCycle ? `φ ${f.t.toFixed(2)}` : `${f.t.toFixed(2)}s${inHit(f.t) ? ' ◆' : ''}`;
        labels.push(label(txt, x, y, inHit(f.t) ? '#ffb347' : '#f3ead8'));
      });
      const head = isCycle ? `gait ${locoSpeed} m/s dir (${dX},${dZ}) combat ${combat} armed ${armed}`
        : `${strip} · ${m.duration}s · hit ${JSON.stringify(m.hit)} · combo ${JSON.stringify(m.combo)} · cancel ${m.cancel} · reach ${m.reach} · lunge ${m.lunge}${m.iframes ? ` · iframes ${JSON.stringify(m.iframes)}` : ''}`;
      labels.push(label(head, innerWidth / 2, 12));
    };
    place();
    window.addEventListener('resize', place);
    hooks.figures = figures;
  } else if (P.get('duel')) {
    // ================= duel: bandit strike vs hero guard =================
    const clipName = P.get('duel');
    const hero = await makeFigure('hero', 1, useChar), bandit = await makeFigure(P.get('ekind') || 'bandit', 2, useChar);
    const ha = new Animator(hero.rig, { heightAt, normalAt, style: 'hero' });
    const ba = new Animator(bandit.rig, { heightAt, normalAt, style: 'bandit' });
    hero.group.position.set(0, 0, -1.2); bandit.group.position.set(0, 0, 1.4); bandit.group.rotation.y = Math.PI;
    scene.add(hero.group, bandit.group);
    const reply = P.get('reply') || 'block';
    const tFix = P.has('t') ? parseFloat(P.get('t')) : null;
    const vd = new THREE.Vector3(...view.dir).normalize();
    const target = new THREE.Vector3(0, 1.0, 0.1);
    app.setView({ pos: target.clone().addScaledVector(vd, parseFloat(P.get('dist') || '6.5')).toArray(), target: target.toArray(), fov: view.fov });
    if (tFix !== null) {
      ha.poseAt(COMPILED[reply] ? reply : 'combatIdle', Math.min(tFix, COMPILED[reply]?.duration ?? 0));
      ba.poseAt(clipName, tFix);
      const r = new THREE.Vector3(); COMPILED[clipName].rootAt(tFix, r);
      bandit.group.position.set(-r.x, 0, 1.4 - r.z);
      app.freeze(true);
    } else {
      let clk = 0;
      app.add({ update(dt) {
        clk += dt;
        ha.setLocomotion({ speed: 0, combat: true }); ba.setLocomotion({ speed: 0, combat: true });
        if (!ba.isActing && clk > 0.6) { ba.play(clipName, { fade: 0.12 }); clk = 0; }
        const hw = CLIPS[clipName]?.meta.hit?.[0];
        if (hw && ba.isActing && !ha.isActing && ba.time > hw[0] - 0.25) ha.play(reply, { fade: 0.08 });
        const out = ba.update(dt, bandit.group);
        const rm = out.rootMotion.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), bandit.group.rotation.y);
        bandit.group.position.add(rm);
        if (!ba.isActing) bandit.group.position.lerp(new THREE.Vector3(0, 0, 1.4), 1 - Math.exp(-dt * 2));
        ha.update(dt, hero.group);
      } });
    }
    labels.push(label(`duel · ${clipName} vs ${reply}${tFix !== null ? ` @ ${tFix.toFixed(2)}s` : ''}`, innerWidth / 2, 12));
  } else {
    // ================= single character (pose / play / loco / showreel) =================
    const ch = await makeFigure(kind, 1, useChar);
    scene.add(ch.group);
    const anim = new Animator(ch.rig, { heightAt, normalAt, style, kind });
    hooks.anim = anim; hooks.ch = ch;
    const clip = P.get('clip'), tFix = P.has('t') ? parseFloat(P.get('t')) : null;
    const play = P.get('play');
    const loco = { speed: locoSpeed ?? 0, dirX: dX, dirZ: dZ, combat, turn: parseFloat(P.get('turn') || '0') };
    if (!armed) { anim.setArmed(false); ch.sword.setDrawn?.(false); }
    const vel = new THREE.Vector3();
    const camFollow = new THREE.Vector3();
    const vd = new THREE.Vector3(...view.dir).normalize();
    const camDist = parseFloat(P.get('dist') || '5.6');
    let showIdx = 0, showT = 0;
    const SHOW = ['attack1', 'attack2', 'attack3', 'attack4', 'thrust', 'heavyCharge', 'heavy', 'special', 'dodgeL', 'dodgeR', 'dodgeB', 'dodgeF', 'parry', 'block', 'hitFront', 'stagger', 'sheathe', 'draw'];
    const footprints = [];
    const fpMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.8 });
    const fpGeo = new THREE.CircleGeometry(0.045, 12).rotateX(-Math.PI / 2);
    hooks.pose = (name, t) => { anim.poseAt(name, t); ch.update?.(0, 0); };
    hooks.play = (name, o) => anim.play(name, o);
    hooks.setLoco = (l) => Object.assign(loco, l);
    const UP = new THREE.Vector3(0, 1, 0);

    if (clip && tFix !== null) {
      anim.poseAt(clip, tFix);
      const root = new THREE.Vector3();
      const yaw = COMPILED[clip]?.rootAt(tFix, root) ?? 0;
      root.y = COMPILED[clip] ? leapAt(COMPILED[clip].meta, tFix) : 0;
      ch.group.position.copy(root); ch.group.rotation.y = yaw;
      app.freeze(true);
      ch.group.updateMatrixWorld(true);
      ch.update?.(0, 0);   // model skins retarget here
      const hp = ch.rig.bones.hips.getWorldPosition(new THREE.Vector3());
      const target = new THREE.Vector3(hp.x, Math.max(0.5, hp.y), hp.z);
      app.setView({ pos: target.clone().addScaledVector(vd, camDist).toArray(), target: target.toArray(), fov: view.fov });
      labels.push(label(`${clip} @ ${tFix.toFixed(2)}s`, innerWidth / 2, 12));
    } else {
      // strobe: pre-simulate the gait and freeze snapshots
      if (P.has('strobe') && locoSpeed !== null) {
        const simCh = await makeFigure(kind, 1, false);
        const simAnim = new Animator(simCh.rig, { heightAt, normalAt, style });
        if (!armed) simAnim.setArmed(false);
        simCh.group.visible = false; scene.add(simCh.group);
        const dt = 1 / 120;
        const dirW = new THREE.Vector3(dX, 0, dZ).normalize();
        const pos = new THREE.Vector3(0, 0, 0);
        const cyc = parseFloat(P.get('every') || '0');
        const settle = 1.6, total = settle + parseFloat(P.get('span') || '1.2');
        let acc = 0, every = cyc || 0.1;
        for (let t = 0; t < total; t += dt) {
          simAnim.setLocomotion({ ...loco });
          pos.addScaledVector(dirW, simAnim.gait.speed * dt);
          simCh.group.position.copy(pos); simCh.group.updateMatrixWorld(true);
          const out = simAnim.update(dt, simCh.group);
          if (!cyc) every = simAnim.gait.cycle / 8;
          if (t > settle) {
            for (const e of out.events) if (e.type === 'step' && e.pos) { const m = new THREE.Mesh(fpGeo, fpMat); m.position.copy(e.pos).setY(e.pos.y + 0.004); scene.add(m); }
            acc += dt;
            if (acc >= every) {
              acc = 0;
              const gh = makeGhost(0xe6ecf2, 0.3);
              copyPose(simCh.rig, gh.rig); gh.group.position.copy(pos);
              scene.add(gh.group);
            }
          }
        }
        ch.group.visible = false;
        const mid = pos.clone().addScaledVector(dirW, -simAnim.gait.speed * (total - settle) * 0.5).setY(0.95);
        app.setView({ pos: mid.clone().addScaledVector(vd, Math.max(camDist, simAnim.gait.speed * 1.6 + 5)).toArray(), target: mid.toArray(), fov: view.fov });
        app.freeze(true);
      }
      app.add({
        update(dt) {
          if (play) {
            if (!anim.isActing) anim.play(play, { fade: 0.15 });
          } else if (locoSpeed === null && !clip) {
            // showreel
            showT += dt;
            if (!anim.isActing && showT > 0.5) { anim.play(SHOW[showIdx % SHOW.length], { fade: 0.12 }); showIdx++; showT = 0; }
            loco.combat = true;
          }
          anim.setLocomotion(loco);
          // move the root with the locomotion (+ authored root motion)
          const moving = !(anim.isActing && COMPILED[anim.current]?.layer !== 'upper');
          vel.set(loco.dirX, 0, loco.dirZ).normalize().applyAxisAngle(UP, ch.group.rotation.y).multiplyScalar(moving ? anim.gait.speed : 0);
          ch.group.position.addScaledVector(vel, dt);
          ch.group.rotation.y += (loco.turn || 0) * dt;
          const out = anim.update(dt, ch.group);
          const rm = _tmp.copy(out.rootMotion).applyAxisAngle(UP, ch.group.rotation.y);
          ch.group.position.add(rm);
          ch.group.rotation.y += out.rootYaw;
          const act = anim.isActing ? COMPILED[anim.current] : null;
          ch.group.position.y = heightAt(ch.group.position.x, ch.group.position.z) + (act ? leapAt(act.meta, anim.time) : 0);
          if (locoSpeed === null && !play && Math.hypot(ch.group.position.x, ch.group.position.z) > 6) ch.group.position.set(0, 0, 0);
          for (const e of out.events) if (e.type === 'step' && e.pos) {
            const m = new THREE.Mesh(fpGeo, fpMat); m.position.copy(e.pos).setY(e.pos.y + 0.004); scene.add(m); footprints.push(m);
            if (footprints.length > 24) scene.remove(footprints.shift());
          }
          ch.update?.(dt, app.time.t);
          env?.setShadowFocus?.(ch.group.position);
          key.target.position.copy(ch.group.position); key.position.copy(ch.group.position).add(new THREE.Vector3(-7, 10, 6));
        },
        lateUpdate(dt, t, a, rawDt) {
          if (P.has('fixedcam')) return;
          const k = P.has('lockcam') ? 1 : 1 - Math.exp(-rawDt * 6);   // lockcam: glued to the figure (fast gaits, dashes)
          camFollow.lerp(ch.group.position, camFollow.lengthSq() === 0 ? 1 : k);
          const target = camFollow.clone().setY(camFollow.y + 1.0);
          app.camera.position.copy(target).addScaledVector(vd, camDist);
          app.camera.lookAt(target);
          if (app.camera.fov !== view.fov) { app.camera.fov = view.fov; app.camera.updateProjectionMatrix(); }
        },
      });
      if (!P.has('strobe')) app.setView({ pos: new THREE.Vector3(0, 1, 0).addScaledVector(vd, camDist).toArray(), target: [0, 1, 0], fov: view.fov });
    }
  }
  app.progress(1, '');
  await app.ready();
}
