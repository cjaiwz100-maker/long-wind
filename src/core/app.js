// App bootstrap: renderer, camera, scene, pipeline, main loop, time control, harness hooks.
// Owner: integrator. STABLE API (every scene/system relies on it):
//   const app = await createApp({ canvas })
//   app.renderer / app.scene / app.camera / app.pipeline
//   app.add(system)            — system: { update?(dt, t, app), lateUpdate?(dt, t, app), dispose?() } ; returns system
//   app.remove(system)
//   app.world                  — cross-module registry: { heightAt(x,z), normalAt(x,z,out), colliders: [], ... }
//   app.time                   — { t (game s), real (wall s), scale (slow-mo multiplier), hitstop(seconds), setScale(k, lerpSeconds) }
//   app.progress(p, label)     — loading progress 0..1 (drives the loader UI)
//   app.ready()                — call once the scene is built; runs precompile, removes loader, sets window.__ready after 2 frames
//   app.setView({pos:[x,y,z], target:[x,y,z], fov?})   — harness/debug: place camera
//   app.freeze(bool)           — harness: stop game time (rendering continues)
//   app.stats()                — {fps, ms, calls, tris, programs, W, H}
//   app.debugControls()        — enable OrbitControls (debug scenes only)
//   Per frame: wind strength easing (core/wind.js) and virtual lamps (core/lamps.js) are updated here.
import * as THREE from 'three';
import './matrixFix.js';   // first: typed matrix storage (see the file; ?nomxfix disables it for A/B)
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { G } from './globals.js';
import { Pipeline } from './pipeline.js';
import { installChunks } from './chunks.js';
import { updateWind } from './wind.js';
import { lamps } from './lamps.js';
import { applyQuality, getQuality } from './quality.js';

export async function createApp({ canvas }) {
  const params = new URLSearchParams(location.search);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
    preserveDrawingBuffer: params.has('harness'),
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // tonemapping happens in the pipeline composite
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false; // reset once per frame so stats() covers every pass

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8aa0b8);
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.3, 7000);
  camera.layers.enableAll(); // the pipeline narrows layers per pass (opaque {0,2,3}, transparent {1})
  camera.position.set(0, 2.2, 8);
  camera.lookAt(0, 1.2, 0);

  const app0 = { renderer, scene, camera, params };
  installChunks(app0);
  const pipeline = new Pipeline(renderer);
  const systems = [];

  const time = {
    t: 0, real: 0, scale: 1, userScale: 1, _targetScale: 1, _scaleLerp: 0, _hitstop: 0, frozen: params.has('freeze'),
    hitstop(seconds) { this._hitstop = Math.max(this._hitstop, seconds); },
    setScale(k, lerpSeconds = 0) { this._targetScale = k; this._scaleLerp = lerpSeconds; if (lerpSeconds <= 0) this.scale = k; },
  };

  const world = {
    heightAt: () => 0,
    normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0),
    colliders: [],    // [{x, z, r}] static circular obstacles (trees/rocks) for movement + camera
  };

  const app = {
    renderer, scene, camera, pipeline, world, time, G, params,
    add(sys) { systems.push(sys); return sys; },
    remove(sys) { const i = systems.indexOf(sys); if (i >= 0) systems.splice(i, 1); },
    progress(p, label) { window.__load?.(p, label); },
    controls: null,
    debugControls() {
      if (this.controls) return this.controls;
      this.controls = new OrbitControls(camera, canvas);
      this.controls.target.set(0, 1.2, 0);
      this.controls.enableDamping = true;
      this.controls.update();
      return this.controls;
    },
    setView({ pos, target, fov }) {
      if (pos) camera.position.set(...pos);
      if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
      if (target) { camera.lookAt(...target); if (this.controls) { this.controls.target.set(...target); this.controls.update(); } }
      camera.updateMatrixWorld();
    },
    freeze(v = true) { time.frozen = v; },
    stats() {
      const i = renderer.info;
      return { fps: +fps.toFixed(1), ms: +(1000 / Math.max(fps, 1e-3)).toFixed(2), calls: i.render.calls, tris: i.render.triangles, programs: i.programs?.length ?? 0, W: pipeline.W, H: pipeline.H, t: +time.t.toFixed(2) };
    },
    async ready() {
      // precompile every program before the first visible frame to avoid hitches
      try { await renderer.compileAsync(scene, camera); } catch (e) { console.warn('compileAsync failed', e); }
      readyFrames = 2;
      const load = document.getElementById('load');
      if (load) { load.classList.add('done'); setTimeout(() => load.remove(), 1400); }
    },
  };

  // ---- sizing (with adaptive resolution) ----
  const maxDpr = Math.min(window.devicePixelRatio || 1, params.has('harness') ? 1 : 1.25); // heavy grass + post: cap retina rendering, adaptive res scales below
  // perf.scale (adaptive) multiplies the quality preset's render scale: the scene shrinks, the output size never does
  const perf = { scale: 1, acc: 0, n: 0, cool: 0, locked: params.has('harness') || params.has('lockres') };
  app.perf = perf;
  function resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const pr = Math.max(0.5, maxDpr);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pipeline.setSize(w, h, pr);
  }
  resize();
  window.addEventListener('resize', resize);
  // quality preset (render scale + post sample counts; the grass density is applied when the grass exists)
  if (!params.has('harness') || params.has('q')) applyQuality(app, getQuality());
  const applyScale = () => pipeline.setRenderScale((app.quality?.scale ?? 1) * perf.scale);

  // ---- loop ----
  let last = performance.now(), fps = 60, readyFrames = -1;
  function frame(now) {
    renderer.info.reset();
    const rawDt = Math.min(Math.max((now - last) / 1000, 0), 0.1);
    last = now;
    fps = fps * 0.95 + (1 / Math.max(rawDt, 1e-4)) * 0.05;
    // time scale easing (slow-mo)
    if (time._scaleLerp > 0) { time.scale += (time._targetScale - time.scale) * Math.min(1, rawDt / time._scaleLerp * 3); }
    let dt = Math.min(rawDt, 1 / 20) * time.scale * time.userScale;   // userScale: record mode's slow-mo (T)
    if (time._hitstop > 0) { time._hitstop -= rawDt; dt *= 0.02; }
    if (time.frozen) dt = 0;
    time.t += dt; time.real += rawDt;
    G.uTime.value = time.t;
    G.uRealTime.value = time.real;
    G.uFrame.value++;
    updateWind(dt);

    for (const s of systems) s.update?.(dt, time.t, app, rawDt);
    if (app.controls) app.controls.update();
    for (const s of systems) s.lateUpdate?.(dt, time.t, app, rawDt);
    camera.updateMatrixWorld();
    G.uCamPos.value.copy(camera.position);
    lamps.update(dt, camera.position);

    pipeline.render(scene, camera, rawDt);

    if (readyFrames > 0 && --readyFrames === 0) window.__ready = true;

    // adaptive resolution: target ~60fps
    if (!perf.locked && readyFrames === 0 && !document.hidden) {
      perf.acc += rawDt; perf.n++;
      if (perf.n >= 90) {
        const avg = perf.acc / perf.n; perf.acc = 0; perf.n = 0;
        const prev = perf.scale;
        const lo = (app.quality?.minScale ?? 0.6) / (app.quality?.scale ?? 1);
        if (avg > 1 / 50 && perf.scale > lo) { perf.scale = Math.max(lo, perf.scale * (avg > 1 / 30 ? 0.88 : 0.95)); perf.cool = now + 6000; }
        else if (avg < 1 / 58 && perf.scale < 1 && now > perf.cool) { perf.scale = Math.min(1, perf.scale + 0.04); perf.cool = now + 2500; }
        if (prev !== perf.scale) applyScale();
      }
    }
  }
  renderer.setAnimationLoop(frame);

  window.__app = app;
  return app;
}
