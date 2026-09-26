// Dual sun shadow maps (bible §2.5): a static-world far map refreshed on demand plus a tiny per-frame actor map.
// Owner: sky/lighting (S).
// STABLE API (used by environment.js; others go through env):
//   const sh = createShadows(app, { quality })  → { sunFar, sunNear, setFocus(v3), refresh(), update(sunDir), stats }
//     sunFar   the real key light (castShadow, 4096², ±150 m, static casters on layer 0); add to the scene FIRST
//     sunNear  shadow-only helper (intensity 0, 2048², ±20 m ≈ 2 cm texels, casters on layer 3 = ACTORS only)
// The light-loop patch in core/chunks.js multiplies light 1's shadow into light 0 and never lights light 1.
// Refresh: both lights have shadow.autoUpdate = false. Once per frame, at the start of the first render of the scene
// (scene.onBeforeRender, after three updated the world matrices and before it projects anything), the near map is
// re-rendered by a nested render(scene, camActors) into a 1x1 target; the far map the same way with camWorld, only when
// the focus moved > 40 m, the sun turned > 0.25°, the scene gained/lost top-level objects, or refresh() was called.
// Casters are split by the layers of the throwaway cameras (WebGLShadowMap filters casters by the viewing camera's
// layers). Both centres are snapped to whole texels in light space, so nothing shimmers while the camera moves.
import * as THREE from 'three';
import { G, LAYERS } from '../core/globals.js';

const UP = new THREE.Vector3(0, 1, 0);

function configure(light, size, half, near, far, bias, normalBias, radius) {
  light.castShadow = true;
  const s = light.shadow;
  s.mapSize.set(size, size);
  s.camera.left = -half; s.camera.right = half; s.camera.top = half; s.camera.bottom = -half;
  s.camera.near = near; s.camera.far = far;
  s.camera.updateProjectionMatrix();
  s.bias = bias; s.normalBias = normalBias; s.radius = radius;
  s.autoUpdate = false; s.needsUpdate = false;
  light.layers.enableAll();
}

export function createShadows(app, { quality = 'high' } = {}) {
  const { renderer, scene } = app;
  const lowQ = quality === 'low' || quality === 'medium';
  const far = { size: lowQ ? 2048 : 4096, half: 150, dist: 300 };
  const near = { size: lowQ ? 1024 : 2048, half: 20, dist: 70 };

  const sunFar = new THREE.DirectionalLight(0xffffff, 3.3);
  sunFar.name = 'sunFar';
  configure(sunFar, far.size, far.half, 10, 700, -4e-4, 0.04, 2);
  const sunNear = new THREE.DirectionalLight(0xffffff, 0);
  sunNear.name = 'sunNear';
  configure(sunNear, near.size, near.half, 1, 140, -2e-4, 0.02, 1.5);
  for (const l of [sunFar, sunNear]) { l.target.name = l.name + '.target'; l.target.layers.enableAll(); }

  // Throwaway viewing cameras: their layers pick the casters of each map; their tiny frustum far below the world
  // keeps the nested render itself from drawing anything but frustumCulled=false objects into the 1x1 target.
  const mkCam = (...layers) => {
    const c = new THREE.OrthographicCamera(-1e-3, 1e-3, 1e-3, -1e-3, 0.1, 0.2);
    c.position.set(0, -1e6, 0); c.lookAt(0, -2e6, 0); c.updateMatrixWorld();
    c.layers.disableAll(); for (const l of layers) c.layers.enable(l);
    return c;
  };
  const camActors = mkCam(LAYERS.ACTORS);
  const camWorld = mkCam(LAYERS.WORLD);   // MAIN_ONLY (grass, flowers) never casts: leave it out entirely
  const rt1x1 = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });

  const state = {
    focus: new THREE.Vector3(), hasFocus: false,          // near-map subject (player feet)
    farCenter: new THREE.Vector3(), farDirty: true,
    shadowSun: new THREE.Vector3().copy(G.uSunDir.value), // sun direction the maps were built for
    lastFrame: -1, childCount: -1,
    farRefreshes: 0, nearRefreshes: 0,
  };
  const _c = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _f = new THREE.Vector3();

  // Snap a world centre to whole shadow texels in the light basis three's lookAt will build (z = sun, x = up×z).
  function place(light, center, cfg) {
    const z = state.shadowSun;
    _x.crossVectors(UP, z).normalize();
    _y.crossVectors(z, _x);
    const texel = (2 * cfg.half) / cfg.size;
    const cx = Math.round(center.dot(_x) / texel) * texel;
    const cy = Math.round(center.dot(_y) / texel) * texel;
    const cz = center.dot(z);
    _c.copy(_x).multiplyScalar(cx).addScaledVector(_y, cy).addScaledVector(z, cz);
    light.target.position.copy(_c);
    light.position.copy(_c).addScaledVector(z, cfg.dist);
  }

  // A nested renderer.render(scene, cam) into 1x1 is the supported way to refresh one map with a caster filter:
  // it updates skeletons (projectObject) and runs WebGLShadowMap.render for every light whose needsUpdate is set.
  function shadowPass(cam) {
    const prevRT = renderer.getRenderTarget();
    const auto = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;          // the outer render just updated the world
    renderer.setRenderTarget(rt1x1);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevRT);
    scene.matrixWorldAutoUpdate = auto;
  }

  const renderHook = () => {
    const frame = G.uFrame.value;
    if (frame === state.lastFrame) return;       // once per frame (the pipeline may render the scene twice)
    state.lastFrame = frame;
    if (!renderer.shadowMap.enabled) return;
    // only static-world casters (layer WORLD) invalidate the far map: VFX (layer 1), grass (2) and characters (3) come
    // and go all the time (every qi wave, spawn and corpse) and re-rendering 4096² of world for them cost ~0.4 s
    let nWorld = 0;
    for (const c of scene.children) if (c.layers.isEnabled(LAYERS.WORLD)) nWorld++;
    if (nWorld !== state.childCount) { state.childCount = nWorld; state.farDirty = true; }
    sunFar.shadow.needsUpdate = false;
    sunNear.shadow.needsUpdate = true;
    shadowPass(camActors);
    state.nearRefreshes++;
    if (state.farDirty) {
      state.farDirty = false;
      sunFar.shadow.needsUpdate = true;
      shadowPass(camWorld);
      state.farRefreshes++;
    }
    sunFar.shadow.needsUpdate = false; sunNear.shadow.needsUpdate = false;
  };
  const prevHook = scene.onBeforeRender;
  scene.onBeforeRender = function (r, s, cam, rt) {
    renderHook();
    prevHook?.call(this, r, s, cam, rt);
  };

  return {
    sunFar, sunNear, camActors, camWorld, stats: state,
    setFocus(v) { state.focus.copy(v); state.hasFocus = true; },
    refresh() { state.farDirty = true; },
    /** Per frame (env.update): follow the sun and the camera; decide whether the far map is stale. */
    update(sunDir, camera) {
      // the maps (and their texel grid) follow the sun in 0.25° steps; lighting direction uses the exact sun
      if (sunDir.angleTo(state.shadowSun) > THREE.MathUtils.degToRad(0.25)) { state.shadowSun.copy(sunDir); state.farDirty = true; }
      camera.getWorldDirection(_f); _f.y = 0;
      if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1);
      _f.normalize();
      const fc = _c.copy(camera.position).addScaledVector(_f, 40);
      fc.y = app.world.heightAt(fc.x, fc.z);
      if (fc.distanceTo(state.farCenter) > 40 || state.farDirty) {
        state.farCenter.copy(fc); state.farDirty = true;
        place(sunFar, state.farCenter, far);
      }
      // near map: subject + 7 m along the shadow direction (a 1.8 m figure casts ~10 m at 9.5°)
      const subj = state.hasFocus ? state.focus : _f.multiplyScalar(5).add(camera.position);
      _c.set(-state.shadowSun.x, 0, -state.shadowSun.z);
      if (_c.lengthSq() > 1e-6) _c.normalize();
      _c.multiplyScalar(7).add(subj);
      place(sunNear, _c, near);
    },
  };
}
