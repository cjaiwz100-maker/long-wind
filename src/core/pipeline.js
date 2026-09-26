// HDR post-processing pipeline (bible §2.2–2.4, §2.8–2.9). Owner: post-processing (R).
//
// STABLE API (app.js, environment, gameplay, VFX):
//   const pipe = new Pipeline(renderer)
//   pipe.setSize(cssW, cssH, pixelRatio)      — app.js owns resize; full res = css·pr, effects at min(pr,1.3)·css/2
//   pipe.render(scene, camera, dt)            — dt = REAL seconds (post fx never freeze in hit-stop)
//   pipe.params                               — live numbers, see DEFAULTS below (env writes exposure/bloom/vol/warm)
//   pipe.fx.flash(i = 1, color?)              — brief additive HDR flash (parry, perfect dodge)
//   pipe.fx.impact(strength = 1, worldPos?)   — radial zoom blur + CA + exposure kick centred on the hit (or screen centre)
//   pipe.fx.kick({ exposure, ca, radial: {x, y, strength} | {pos: Vector3, strength}, flash, ms = 90 })
//   pipe.fx.setSlowmo(k)                      — 0..1 drained/cold "focus" look while time is slowed (eased)
//   pipe.fx.setDamage(k)                      — 0..1 low-health look: darker vignette floor, desaturation, crimson heartbeat
//   pipe.fx.fade(to, seconds = 1, color = 'black')  — to 0 visible … 1 covered; color 'black' | 'mist' | [r,g,b] (display sRGB)
//   pipe.fx.letterbox(on, seconds = 0.6)      — cinematic 2.39:1 bars
//   pipe.fx.dust(amount)                      — combat dust in the shafts (0..1, decays over 1.5 s)
//   pipe.setShadowSources({ far, near })      — DirectionalLights whose shadow maps the shafts raymarch (either optional).
//                                               If never called, the first two castShadow DirectionalLights in the scene are used.
//   pipe.heightAt = (x, z) => y               — optional; defaults to window.__app.world.heightAt (shaft ground-haze base)
//   pipe.depthTexture                         — full-res opaque depth (DepthTexture, D32F). Safe to sample in the transparent pass.
//   pipe.copyTexture                          — half-res: rgb = opaque HDR colour, a = linear view depth (m). Stable object.
//   pipe.sceneTexture                         — final HDR scene colour of the last frame (TAA output when on). Do NOT sample it
//                                               in the transparent pass — use copyTexture for refraction/soft particles.
//   pipe.stats() / window.__perf              — { gpu: {pass: ms}, aa, W, H, hw, hh } (GPU timings with ?perf or params.profile)
// Shared uniforms attached to G (spread G into your ShaderMaterial or reference them):
//   G.tSceneCopy (= copyTexture), G.tSceneDepth (= depthTexture), G.uCamNearFar (vec2 near, far), G.uCopyTexel (vec2 1/half size)
//
// Frame order: OPAQUE (layers {0,2,3,7}, jittered if TAA) → [depth copy] → COPY (half) → TRANSPARENT (layers {1}) →
// [TAA] → VOLUMETRIC (raymarch, bilateral, reprojected history) → SSAO → BLOOM → COMPOSITE → FINAL (FXAA/sharpen/grain/fade).
//
// Anti-aliasing (params.aa, URL ?aa=): 'msaa' (default: 4× MSAA scene target + FXAA), 'taa' (Halton jitter + TAA +
// sharpen), 'msaa+taa', 'fxaa' (cheapest). MSAA works with the opaque→copy→transparent-in-the-same-RT pattern here
// because three r186 only invalidates the multisampled colour after a resolve on Oculus Browser
// (WebGLTextures.supportsInvalidateFramebuffer); elsewhere the MSAA renderbuffer keeps its contents.
import * as THREE from 'three';
import { G } from './globals.js';
import { fsPass, makeRT, postMaterial, POST_GLSL } from './postCommon.js';
import { VolumetricPass } from './postVolumetric.js';
import { AOPass } from './postAO.js';
import { BloomPass } from './postBloom.js';
import { TAAPass } from './postTAA.js';
import { createCompositeMaterial, DEBUG_VIEWS } from './postComposite.js';
import { createFinalMaterial } from './postFinal.js';
import { GPUProfiler } from './postProfiler.js';

const OPAQUE_MASK = (1 << 0) | (1 << 2) | (1 << 3) | (1 << 7);   // world, main-only, actors, debug
const TRANSPARENT_MASK = 1 << 1;
const MIST_SRGB = [0.906, 0.871, 0.808];                          // warm mist (0.80,0.73,0.62) linear, display-encoded

const DEFAULTS = {
  // keyframed by the environment (bible §3.4)
  exposure: 1.05, bloom: 0.055, vol: 0.85, warm: 1.0,
  // constants (bible §2.4.7)
  ao: 0.55, sat: 1.10, hueKeep: 0.4, ca: 0.0065, vigFloor: 0.68, grain: 0.028, sharpen: 0.35, taaSharpen: 0.25,
  // state that other modules may also drive directly (combined with fx.* by max)
  fade: 0, fadeMist: 0, letterbox: 0, lowHealth: 0,
  // bloom
  bloomThreshold: 0.9, bloomKnee: 1.2, bloomSpread: 0.85, bloomLevels: 6,
  // shafts
  volSteps: 14, volMaxDist: 220, volDensity: 1.0, volClouds: 1.0, volBlend: 0.22, volExtinction: 0.03, volScale: 0.014, volBroad: 0.3, volOcclusion: 0.6, volOccPow: 3,
  // ssao
  aoSamples: 8,
  // anti-aliasing: 'msaa' | 'taa' | 'msaa+taa' | 'fxaa' | 'none'
  aa: 'fxaa', msaaSamples: 4,   // fxaa default: MSAA costs ~12 ms at 1600×900 on M-series; ?aa=msaa|taa for high end
  taaBlend: 0.1, taaGamma: 1.0,
  // 'none' | 'ao' | 'vol' | 'bloom' | 'depth' | 'copy'
  debugView: 'none',
  // GPU timings: false | 'query' (timer queries) | 'sync' (gl.finish per pass; profiling runs only)
  profile: false,
};

const COPY_FRAG = /* glsl */`
${POST_GLSL}
uniform sampler2D tColor, tDepth;
uniform vec2 uNearFar;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture(tColor, vUv).rgb, wxp_linearDepth(texture(tDepth, vUv).x, uNearFar)); }
`;

const _v4 = new THREE.Vector4(), _col = new THREE.Color();

/** A decaying pulse: value = peak·(1 − age/dur)² */
class Pulse {
  constructor() { this.peak = 0; this.age = 0; this.dur = 1; }
  hit(v, dur) { if (v >= this.value) { this.peak = v; this.age = 0; this.dur = Math.max(1e-3, dur); } }
  get value() { const k = Math.max(0, 1 - this.age / this.dur); return this.peak * k * k; }
  tick(dt) { this.age += dt; }
}

export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.params = createParams(q);
    this.harness = q.has('harness');
    this.heightAt = null;

    this.W = 1; this.H = 1; this.hw = 1; this.hh = 1; this.pr = 1;
    this.SW = 1; this.SH = 1;               // scene render size (= W×H, or smaller with temporal upsampling)
    this.renderScale = 1; this._css = [1, 1, 1];
    this._msaa = -1; this._taaOn = false; this._fxaaOn = true;

    // scene target: HDR colour + D32F depth texture (resolved when multisampled)
    this.rtScene = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.rtScene.texture.name = 'hdrScene';
    this.rtScene.depthTexture.name = 'hdrSceneDepth';
    // non-MSAA modes: the scene depth is attached while drawing transparents, so VFX get a blitted copy instead
    this.rtDepth = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType, format: THREE.RedFormat, depthBuffer: true, stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.rtDepth.depthTexture.name = 'sceneDepthCopy';
    this.rtCopy = makeRT(1, 1, { name: 'copy' });
    this.rtLDR = makeRT(1, 1, { name: 'ldr', type: THREE.UnsignedByteType });

    this.vol = new VolumetricPass();
    this.ao = new AOPass();
    this.bloomPass = new BloomPass(6);
    this.taa = new TAAPass();
    this.copyMat = postMaterial({ name: 'copy', fragmentShader: COPY_FRAG, uniforms: { tColor: { value: null }, tDepth: { value: null }, uNearFar: { value: new THREE.Vector2() } } });
    this.composite = createCompositeMaterial();
    this.final = createFinalMaterial(true);
    this.profiler = new GPUProfiler(renderer);

    // camera record shared by the passes (no per-frame allocations)
    this.frame = {
      index: 0, proj: new THREE.Matrix4(), invProj: new THREE.Matrix4(), view: new THREE.Matrix4(), viewProj: new THREE.Matrix4(),
      prevViewProj: new THREE.Matrix4(), jitViewProj: new THREE.Matrix4(), camWorld: new THREE.Matrix4(), camPos: new THREE.Vector3(),
      prevPos: new THREE.Vector3(), fwd: new THREE.Vector3(), prevFwd: new THREE.Vector3(0, 0, -1),
      groundY: 0, historyOk: false, near: 0.3, far: 7000,
    };

    // shadow sources: explicit (setShadowSources) or discovered
    this._shadowExplicit = false;
    this._scanFrame = -1; this._scanChildren = -1;

    // fx state (real time)
    this._fx = {
      flash: new Pulse(), flashCol: new THREE.Color(1, 1, 1),
      exp: new Pulse(), ca: new Pulse(), radial: new Pulse(), radialUV: new THREE.Vector2(0.5, 0.5),
      fade: { v: 0, from: 0, to: 0, t: 0, dur: 0, col: new THREE.Vector3(0, 0, 0) },
      lb: { v: 0, from: 0, to: 0, t: 0, dur: 0 },
      slowmo: 0, slowmoT: 0, damage: 0, damageT: 0, beat: 0,
      intro: this.harness ? 2 : 0,          // 0 waiting for __ready, 1 fading in, 2 done
    };
    if (!this.harness) this._fx.fade.v = 1;
    this.fx = this._makeFx();

    // shared uniforms for VFX / water / soft particles
    G.tSceneCopy = { value: this.rtCopy.texture };
    G.tSceneDepth = { value: this.rtScene.depthTexture };
    G.uCamNearFar = { value: new THREE.Vector2(0.3, 7000) };
    G.uCopyTexel = { value: new THREE.Vector2(1, 1) };

    this.perf = { gpu: {}, aa: '', W: 1, H: 1, hw: 1, hh: 1, calls: 0 };
    if (q.has('perf')) this.params.profile = q.get('perf') === 'sync' ? 'sync' : 'query';
    if (typeof window !== 'undefined') window.__perf = this.perf;

    this._wrapCompile();
    this._applyAA(true);
  }

  // ---------------------------------------------------------------- public API
  get depthTexture() { return this._msaa > 0 ? this.rtScene.depthTexture : this.rtDepth.depthTexture; }
  get sceneTexture() { return this._taaOn ? this.taa.texture : this.rtScene.texture; }
  get copyTexture() { return this.rtCopy.texture; }

  setShadowSources({ far = null, near = null } = {}) {
    this._shadowExplicit = !!(far || near);
    this.vol.setShadowSources(far || near, far ? near : null);
    for (const l of [far, near]) if (l) l.layers.enableAll();
  }

  /** Temporal upsampling: the scene renders at s × the output size and TAA reconstructs full resolution (s < 1
   *  turns TAA on whatever params.aa says). */
  setRenderScale(s) {
    s = Math.min(1, Math.max(0.4, s));
    if (Math.abs(s - this.renderScale) < 1e-3) return;
    this.renderScale = s;
    this.setSize(...this._css);
    this._applyAA(false);
  }

  setSize(cssW, cssH, pr = 1) {
    this._css = [cssW, cssH, pr];
    const W = Math.max(1, Math.round(cssW * pr)), H = Math.max(1, Math.round(cssH * pr));
    const s = this.renderScale;
    const SW = Math.max(1, Math.round(W * s)), SH = Math.max(1, Math.round(H * s));
    const k = Math.min(pr, 1.3) * 0.5;
    const hw = Math.max(1, Math.round(cssW * k)), hh = Math.max(1, Math.round(cssH * k));
    this.pr = pr;
    if (W === this.W && H === this.H && SW === this.SW && SH === this.SH && hw === this.hw && hh === this.hh) return;
    this.W = W; this.H = H; this.SW = SW; this.SH = SH; this.hw = hw; this.hh = hh;
    this.rtScene.setSize(SW, SH);
    this.rtDepth.setSize(SW, SH);
    this.rtLDR.setSize(W, H);
    this.taa.setSize(W, H, SW, SH);
    this.rtCopy.setSize(hw, hh);
    this.vol.setSize(hw, hh);
    this.ao.setSize(hw, hh);
    this.bloomPass.setSize(hw, hh);
    G.uResolution.value.set(W, H);
    G.uCopyTexel.value.set(1 / hw, 1 / hh);
    Object.assign(this.perf, { W, H, hw, hh });
  }

  stats() { return { ...this.perf, gpu: this.profiler.snapshot() }; }

  /** Compile scene programs against the HDR target (linear output), the way they are actually rendered. */
  async precompile(scene, camera) {
    await this.renderer.compileAsync(scene, camera);
  }

  // ---------------------------------------------------------------- frame
  render(scene, camera, dt = 1 / 60) {
    const r = this.renderer, p = this.params, prof = this.profiler;
    prof.mode = p.profile === 'sync' ? 'sync' : p.profile ? 'query' : 'off';
    this._tickFx(dt);
    this._applyAA(false);
    this._scanScene(scene);
    this._updateFrame(camera);
    const autoClear = r.autoClear;
    this._scenePasses(scene, camera);
    this._postPasses(camera);
    prof.end();
    prof.frame();
    r.autoClear = autoClear;
    this._endFrame();
    if (prof.mode !== 'off') { this.perf.gpu = prof.snapshot(); this.perf.gpuTotal = +prof.total.toFixed(3); }
  }

  /** OPAQUE → [depth copy] → COPY → TRANSPARENT → [TAA]. Leaves this._sceneTex = the HDR scene for the post chain. */
  _scenePasses(scene, camera) {
    const r = this.renderer, prof = this.profiler, F = this.frame;
    const msaa = this._msaa > 0, taa = this._taaOn;

    // ---- OPAQUE (layers {0,2,3,7}); with TAA the projection carries this frame's Halton sub-pixel jitter
    const mask = camera.layers.mask;
    if (taa) {
      this.taa.jitter(camera, this.SW, this.SH);
      F.jitViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    } else F.jitViewProj.copy(F.viewProj);
    prof.begin('opaque');
    camera.layers.mask = OPAQUE_MASK;
    r.autoClear = true;
    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);

    // ---- depth copy (non-MSAA) + COPY (half-res colour + linear depth)
    prof.begin('copy');
    if (!msaa) { r.initRenderTarget(this.rtDepth); r.copyTextureToTexture(this.rtScene.depthTexture, this.rtDepth.depthTexture); }
    const cu = this.copyMat.uniforms;
    cu.tColor.value = this.rtScene.texture; cu.tDepth.value = this.rtScene.depthTexture; cu.uNearFar.value.set(F.near, F.far);
    fsPass(r, this.copyMat, this.rtCopy);

    // ---- TRANSPARENT (after the copy snapshot, same RT, no shadow re-render, no second matrix update)
    prof.begin('transparent');
    const sm = r.shadowMap, smAuto = sm.autoUpdate, smNeeds = sm.needsUpdate, sceneAuto = scene.matrixWorldAutoUpdate;
    sm.autoUpdate = false; sm.needsUpdate = false; scene.matrixWorldAutoUpdate = false;
    camera.layers.mask = TRANSPARENT_MASK;
    r.autoClear = false;
    if (msaa) this.rtScene.resolveDepthBuffer = false;   // transparents don't change the depth we publish
    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);
    this.rtScene.resolveDepthBuffer = true;
    sm.autoUpdate = smAuto; sm.needsUpdate = smNeeds; scene.matrixWorldAutoUpdate = sceneAuto;
    camera.layers.mask = mask;
    r.autoClear = true;
    if (taa) this.taa.restore();

    // ---- TAA (resolves into its own history target, which becomes the scene colour for everything after)
    this._sceneTex = this.rtScene.texture;
    if (taa) {
      prof.begin('taa');
      this.taa.render(r, this.rtScene.texture, this.rtScene.depthTexture, F, this.params);
      this._sceneTex = this.taa.texture;
    }
  }

  /** VOLUMETRIC → SSAO → BLOOM → COMPOSITE → FINAL (canvas). Reads only render targets (repeatable for benchmarks). */
  _postPasses(camera) {
    const r = this.renderer, p = this.params, prof = this.profiler, F = this.frame, sceneTex = this._sceneTex;

    // ---- VOLUMETRIC
    prof.begin('vol');
    this.vol.steps = Math.max(4, p.volSteps | 0);
    this.vol.maxDist = p.volMaxDist;
    if (p.vol > 0) this.vol.render(r, F, this.rtCopy.texture, p);
    else if (!this._volCleared) this.vol.clear(r);
    this._volCleared = p.vol <= 0;

    // ---- SSAO
    prof.begin('ao');
    this.ao.samples = Math.max(4, p.aoSamples | 0);
    if (p.ao > 0) this.ao.render(r, F, this.rtCopy.texture);
    else if (!this._aoCleared) this.ao.clear(r);
    this._aoCleared = p.ao <= 0;

    // ---- BLOOM
    prof.begin('bloom');
    this.bloomPass.levels = p.bloomLevels | 0;
    this.bloomPass.render(r, sceneTex, this.vol.texture, this.W, this.H, p);

    // ---- COMPOSITE → rtLDR
    prof.begin('composite');
    this._updateComposite(sceneTex, camera);
    fsPass(r, this.composite, this.rtLDR);

    // ---- FINAL → canvas
    prof.begin('final');
    const fu = this.final.uniforms, fx = this._fx;
    fu.tLDR.value = this.rtLDR.texture;
    fu.uTexel.value.set(1 / this.W, 1 / this.H);
    // upsampled frames are a little soft: sharpen more the further below full resolution the scene renders
    fu.uSharpen.value = this._taaOn ? p.taaSharpen + (1 - this.renderScale) * 0.8 : p.sharpen;
    fu.uGrain.value = p.grain;
    fu.uFrame.value = F.index;
    const fade = Math.max(fx.fade.v, p.fade);
    fu.uFade.value = fade;
    if (p.fade > fx.fade.v) fu.uFadeColor.value.set(MIST_SRGB[0] * p.fadeMist, MIST_SRGB[1] * p.fadeMist, MIST_SRGB[2] * p.fadeMist);
    else fu.uFadeColor.value.copy(fx.fade.col);
    fsPass(r, this.final, null);
  }

  _endFrame() {
    const F = this.frame;
    F.prevViewProj.copy(F.viewProj);
    F.prevPos.copy(F.camPos); F.prevFwd.copy(F.fwd);
    F.index++;
  }

  /**
   * Wall-clock GPU cost per section, measured the only way that is trustworthy on ANGLE/Metal: run the section
   * `n` times back to back, then force completion by reading one pixel of the LAST target that section wrote
   * (ANGLE waits only for the command buffers that touched the read resource, so reading anything else returns
   * early). Blocks the main thread (debug only). → ms per run: { frame, scene, post, vol, ao, bloom, grade }.
   */
  benchmark(scene, camera, n = 30, only = null) {
    const r = this.renderer, gl = r.getContext(), p = this.params, F = this.frame;
    const u8 = new Uint8Array(4), f32 = new Float32Array(4);
    const sync = (rt) => {
      r.setRenderTarget(rt);
      if (rt && rt.texture.type !== THREE.UnsignedByteType) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, f32);
      else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    };
    const time = (fn, rt) => {
      fn(); sync(rt);                                  // warm (programs, targets)
      let best = Infinity;
      for (let rep = 0; rep < 3; rep++) {              // the GPU is shared: keep the best of 3 batches
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        sync(rt);
        best = Math.min(best, (performance.now() - t0) / n);
      }
      return +best.toFixed(3);
    };
    const recopy = () => fsPass(r, this.copyMat, this.rtCopy);   // makes rtCopy depend on the finished scene target
    this._updateFrame(camera);
    const out = {};
    const want = (k) => !only || only.includes(k);
    const sec = (k, fn, rt) => { if (want(k)) out[k] = time(fn, rt); };
    sec('empty', () => {}, null);
    sec('frame', () => { this._updateFrame(camera); this._scenePasses(scene, camera); this._postPasses(camera); this._endFrame(); }, null);
    sec('scene', () => { this._updateFrame(camera); this._scenePasses(scene, camera); recopy(); this._endFrame(); }, this.rtCopy);
    sec('post', () => this._postPasses(camera), null);
    sec('vol', () => this.vol.render(r, F, this.rtCopy.texture, p), this.vol.rtVol2);
    sec('volMarch', () => { this.vol._ensureMarch(this.vol._numShadows); fsPass(r, this.vol.march, this.vol.rtVol); }, this.vol.rtVol);
    sec('ao', () => this.ao.render(r, F, this.rtCopy.texture), this.ao.rtA);
    sec('bloom', () => this.bloomPass.render(r, this._sceneTex, this.vol.texture, this.W, this.H, p), this.bloomPass.ups[0]);
    sec('composite', () => fsPass(r, this.composite, this.rtLDR), this.rtLDR);
    sec('final', () => fsPass(r, this.final, null), null);
    out.aa = this.perf.aa; out.W = this.W; out.H = this.H; out.hw = this.hw; out.hh = this.hh;
    return out;
  }

  // ---------------------------------------------------------------- internals
  _updateFrame(camera) {
    const F = this.frame;
    F.near = camera.near; F.far = camera.far;
    F.proj.copy(camera.projectionMatrix);
    F.invProj.copy(camera.projectionMatrixInverse);
    F.view.copy(camera.matrixWorldInverse);
    F.viewProj.multiplyMatrices(F.proj, F.view);
    F.camWorld.copy(camera.matrixWorld);
    F.camPos.setFromMatrixPosition(camera.matrixWorld);
    F.fwd.set(0, 0, -1).transformDirection(camera.matrixWorld);
    // camera cut → drop histories (vol, TAA). A fast combat camera still reprojects fine below these limits.
    const cut = F.index === 0 || F.camPos.distanceToSquared(F.prevPos) > 16 || F.fwd.dot(F.prevFwd) < 0.9;
    F.historyOk = !cut;
    const h = this.heightAt || (typeof window !== 'undefined' ? window.__app?.world?.heightAt : null);
    F.groundY = h ? h(F.camPos.x, F.camPos.z) : G.uFogParams.value.z;
    G.uCamNearFar.value.set(F.near, F.far);
    G.tSceneDepth.value = this.depthTexture;
  }

  /** Occasionally: enable every layer on lights (else the {1} transparent pass drops them → program churn) and
   *  discover the sun shadow lights when nobody called setShadowSources. */
  _scanScene(scene) {
    const F = this.frame;
    if (scene.children.length === this._scanChildren && F.index - this._scanFrame < 120) return;
    this._scanChildren = scene.children.length; this._scanFrame = F.index;
    const dirs = [];
    scene.traverse((o) => {
      if (!o.isLight) return;
      if ((o.layers.mask & TRANSPARENT_MASK) === 0 || (o.layers.mask & OPAQUE_MASK) !== OPAQUE_MASK) o.layers.enableAll();
      if (o.isDirectionalLight && o.castShadow) dirs.push(o);
    });
    if (!this._shadowExplicit) {
      const far = dirs[0] || null, near = dirs[1] || null;
      if (far !== this.vol.far || near !== this.vol.near) this.vol.setShadowSources(far, near);
    }
  }

  _applyAA(force) {
    const mode = String(this.params.aa || 'msaa').toLowerCase();
    const msaa = mode.includes('msaa') ? Math.max(0, this.params.msaaSamples | 0) : 0;
    const taa = mode.includes('taa') || this.renderScale < 0.999;
    const fxaa = !taa && mode !== 'none';
    if (!force && msaa === this._msaa && taa === this._taaOn && fxaa === this._fxaaOn) return;
    if (msaa !== this._msaa) {
      this.rtScene.samples = msaa;
      this.rtScene.dispose();                  // re-created with the new sample count on next bind
      this._msaa = msaa;
    }
    if (taa !== this._taaOn) { this.taa.valid = false; this._taaOn = taa; }
    if (fxaa !== this._fxaaOn || force) {
      this.final.dispose();
      this.final = createFinalMaterial(fxaa);
      this._fxaaOn = fxaa;
    }
    this.perf.aa = mode;
  }

  _updateComposite(sceneTex, camera) {
    const u = this.composite.uniforms, p = this.params, fx = this._fx, F = this.frame;
    u.tScene.value = sceneTex;
    u.tDepth.value = this.rtScene.depthTexture;
    u.tCopy.value = this.rtCopy.texture;
    u.tAO.value = this.ao.texture;
    u.tVol.value = this.vol.texture;
    u.tBloom.value = this.bloomPass.texture;
    u.uNearFar.value.set(F.near, F.far);
    u.uHalfSize.value.set(this.hw, this.hh);
    u.uTexel.value.set(1 / this.W, 1 / this.H);
    u.uAspect.value = this.W / this.H;
    u.uCA.value = p.ca + fx.ca.value;
    u.uAO.value = p.ao;
    u.uVolAmt.value = p.vol;
    u.uVolOcc.value = p.volOcclusion;
    u.uBloom.value = p.bloom;
    u.uExposure.value = p.exposure * (1 + fx.exp.value);
    u.uWarm.value = p.warm;
    u.uSat.value = p.sat;
    u.uHueKeep.value = p.hueKeep;
    u.uVigFloor.value = p.vigFloor;
    u.uLowHealth.value = Math.max(p.lowHealth, fx.damage);
    u.uPulse.value = fx.beat;
    u.uSlowmo.value = fx.slowmo;
    u.uLetterbox.value = Math.max(p.letterbox, fx.lb.v);
    u.uRadial.value.set(fx.radialUV.x, fx.radialUV.y, fx.radial.value);
    const fl = fx.flash.value;
    u.uFlash.value.set(fx.flashCol.r, fx.flashCol.g, fx.flashCol.b, fl);
    // sun on screen for the veil
    const sd = G.uSunDir.value;
    _v4.set(F.camPos.x + sd.x * 1000, F.camPos.y + sd.y * 1000, F.camPos.z + sd.z * 1000, 1).applyMatrix4(F.viewProj);
    const facing = F.fwd.dot(sd);
    if (_v4.w > 0) u.uSunScreen.value.set(_v4.x / _v4.w * 0.5 + 0.5, _v4.y / _v4.w * 0.5 + 0.5, THREE.MathUtils.smoothstep(facing, 0.0, 0.25));
    else u.uSunScreen.value.set(0.5, 0.5, 0);
    u.uDebug.value = DEBUG_VIEWS[p.debugView] ?? 0;
  }

  _tickFx(dt) {
    const fx = this._fx;
    dt = Math.min(Math.max(dt, 0), 0.1);
    fx.flash.tick(dt); fx.exp.tick(dt); fx.ca.tick(dt); fx.radial.tick(dt);
    this.vol.tick(dt);
    // fade
    const f = fx.fade;
    if (fx.intro === 0 && typeof window !== 'undefined' && window.__ready) { fx.intro = 1; this.fx.fade(0, 2.2, 'black'); }
    if (f.dur > 0) {
      f.t = Math.min(f.t + dt, f.dur);
      const k = f.t / f.dur;
      f.v = f.from + (f.to - f.from) * k * k * (3 - 2 * k);
      if (f.t >= f.dur) f.dur = 0;
    }
    // letterbox
    const lb = fx.lb;
    if (lb.dur > 0) {
      lb.t = Math.min(lb.t + dt, lb.dur);
      const k = lb.t / lb.dur;
      lb.v = lb.from + (lb.to - lb.from) * k * k * (3 - 2 * k);
      if (lb.t >= lb.dur) lb.dur = 0;
    }
    // eased slow-mo and damage looks; a ~66 bpm heartbeat while hurt
    fx.slowmo += (fx.slowmoT - fx.slowmo) * Math.min(1, dt * 6);
    fx.damage += (fx.damageT - fx.damage) * Math.min(1, dt * 3);
    const tb = (performance.now() / 1000) * 1.1 % 1;
    fx.beat = Math.exp(-Math.pow((tb - 0.08) * 14, 2)) + 0.6 * Math.exp(-Math.pow((tb - 0.3) * 14, 2));
  }

  _makeFx() {
    const fx = this._fx, self = this;
    const setRadialFrom = (pos, x, y) => {
      if (pos) {
        _v4.set(pos.x, pos.y, pos.z, 1).applyMatrix4(self.frame.viewProj);
        if (_v4.w > 0) fx.radialUV.set(THREE.MathUtils.clamp(_v4.x / _v4.w * 0.5 + 0.5, 0, 1), THREE.MathUtils.clamp(_v4.y / _v4.w * 0.5 + 0.5, 0, 1));
        else fx.radialUV.set(0.5, 0.5);
      } else fx.radialUV.set(x ?? 0.5, y ?? 0.5);
    };
    return {
      flash(i = 1, color) {
        if (color !== undefined && color !== null) (Array.isArray(color) ? _col.setRGB(...color) : _col.set(color));
        else _col.setRGB(1, 0.92, 0.8);
        if (i * 0.6 >= fx.flash.value) fx.flashCol.copy(_col);
        fx.flash.hit(i * 0.6, 0.22);
        fx.exp.hit(0.2 * i, 0.12);
      },
      impact(strength = 1, worldPos = null) {
        const s = Math.max(0, strength);
        setRadialFrom(worldPos);
        fx.radial.hit(Math.min(0.035, 0.03 * s), 0.14);
        fx.ca.hit(0.016 * s, 0.16);
        fx.exp.hit(0.12 * s, 0.09);
      },
      kick({ exposure = 0, ca = 0, radial = null, flash = 0, ms = 90 } = {}) {
        const d = ms / 1000;
        if (exposure) fx.exp.hit(exposure, d);
        if (ca) fx.ca.hit(ca, d * 1.4);
        if (radial) { setRadialFrom(radial.pos, radial.x, radial.y); fx.radial.hit(Math.min(0.035, radial.strength ?? 0.02), Math.max(d, 0.12)); }
        if (flash) this.flash(flash);
      },
      setSlowmo(k) { fx.slowmoT = THREE.MathUtils.clamp(k, 0, 1); },
      setDamage(k) { fx.damageT = THREE.MathUtils.clamp(k, 0, 1); },
      fade(to, seconds = 1, color = 'black') {
        const f = fx.fade;
        if (color === 'mist') f.col.set(...MIST_SRGB);
        else if (color === 'black' || color === undefined || color === null) f.col.set(0, 0, 0);
        else if (Array.isArray(color)) f.col.set(color[0], color[1], color[2]);
        else { _col.set(color); f.col.set(_col.r, _col.g, _col.b); }
        fx.intro = 2;
        Object.assign(f, { from: f.v, to: THREE.MathUtils.clamp(to, 0, 1), t: 0, dur: Math.max(seconds, 1e-3) });
      },
      letterbox(on = true, seconds = 0.6) {
        Object.assign(fx.lb, { from: fx.lb.v, to: on ? 1 : 0, t: 0, dur: Math.max(seconds, 1e-3) });
      },
      dust(amount = 0.5) { self.vol.addDust(amount); },
    };
  }

  /** app.ready() calls renderer.compileAsync(scene, camera) with no target bound, which would compile the canvas
   *  (sRGB-output) variants. Bind the HDR target around compile calls so the real programs get built. */
  _wrapCompile() {
    const r = this.renderer, self = this;
    if (r.__wxCompileWrapped) return;
    r.__wxCompileWrapped = true;
    const wrap = (fn) => function (scene, camera, target) {
      const prev = r.getRenderTarget();
      const bind = prev === null;
      const mask = camera?.layers?.mask;
      if (bind) r.setRenderTarget(self.rtScene);
      if (camera?.layers) camera.layers.enableAll();
      try { return fn.call(r, scene, camera, target); }
      finally { if (bind) r.setRenderTarget(prev); if (camera?.layers && mask !== undefined) camera.layers.mask = mask; }
    };
    r.compile = wrap(r.compile);
    r.compileAsync = wrap(r.compileAsync);
  }

  dispose() {
    for (const rt of [this.rtScene, this.rtDepth, this.rtCopy, this.rtLDR]) rt.dispose();
    this.vol.dispose(); this.ao.dispose(); this.bloomPass.dispose(); this.taa.dispose();
    this.copyMat.dispose(); this.composite.dispose(); this.final.dispose();
  }
}

// params object with legacy aliases used by early stubs (saturation, vignette)
function createParams(q) {
  const p = { ...DEFAULTS };
  Object.defineProperty(p, 'saturation', { get() { return p.sat; }, set(v) { p.sat = v; }, enumerable: false });
  Object.defineProperty(p, 'vignette', { get() { return 1 - p.vigFloor; }, set(v) { p.vigFloor = 1 - v; }, enumerable: false });
  if (q.has('aa')) p.aa = q.get('aa');
  const dbg = q.get('debug');
  if (dbg && dbg in DEBUG_VIEWS) p.debugView = dbg;
  return p;
}
