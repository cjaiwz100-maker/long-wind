// Combat ↔ vegetation interaction (bible §5.5–5.6): actors (push + contact AO), the persistent trample/cut/blood/
// dust map (tInteract), shockwave rings and slash gusts. Owner: vegetation (V). STABLE API:
//   const ix = createInteraction(app)
//   ix.setActor(i, x, y, z, r = 0.45) / ix.clearActor(i)        — i in 0..7 (0 = player). Call every frame for live actors.
//   ix.trample(x, z, r = 0.35, strength = 0.8)                   — footsteps / body rolls (R, recovers in ~12 s)
//   ix.cut(x0, z0, x1, z1, width = 0.3)                          — blade passed through grass along this chord (G, regrows over minutes)
//   ix.stain(x, z, r, amount = 1)                                — blood/ink on the ground (B)
//   ix.dust(x, z, r, amount = 1)                                 — scorch / kicked dust (A, fades in ~2 s)
//   ix.shock(x, z, strength = 1)                                 — expanding ring (heavy hits, landing): 9 m/s, 0.9 s life
//   ix.slash(x0, z0, x1, z1, strength = 1, height = 1)           — travelling gust perpendicular to the chord (0.35 s)
//   ix.update(dt)                                                — registered via app.add by createInteraction
// Extensions: ix.setFocus(x, z) (override the map centre; default = actor 0, else the camera), ix.autoTrample = true
// (weak trample under every active actor so walking leaves trails even without footstep calls), ix.rt (debug).
//
// Writes G: tInteract (RGBA16F 512², R trample, G cut, B blood/ink, A dust), uInteractRect (x0, z0, 64, 1/64,
// texel-snapped), uActors, uShock, uSlash/uSlashB, uCamGround (camera xz + clearing radius; the radius goes to 0
// when the camera is high above the ground so blades are only cleared around a low lens).
import * as THREE from 'three';
import { G, MAX_ACTORS } from '../core/globals.js';

const SIZE = 512;          // texels per side
const SPAN = 64;           // metres covered (±32 m)
const TEXEL = SPAN / SIZE; // 12.5 cm
const MAX_STAMPS = 256;    // per frame

// Per-channel exponential time constants (s). Bible: R ×0.9975/frame, G ×0.99995, B ×0.9998, A ×0.99 at 60 fps.
const TAU = [1 / (60 * 0.0025), 1 / (60 * 0.00005), 1 / (60 * 0.0002), 1 / (60 * 0.01)];

const FS_VERT = /* glsl */`
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Shift (integer texels) + decay copy. texelFetch keeps values exact; outside the old map is empty.
const COPY_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uShift;
uniform vec4 uDecay;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(uShift);
  vec4 v = vec4(0.0);
  if (p.x >= 0 && p.y >= 0 && p.x < ${SIZE} && p.y < ${SIZE}) v = texelFetch(tSrc, p, 0);
  gl_FragColor = v * uDecay;
}
`;

// Soft stamps: a capsule (disc when both ends coincide) rasterised into the map with MAX blending.
const STAMP_VERT = /* glsl */`
attribute vec4 iSeg;    // x0, z0, x1, z1 (world)
attribute vec4 iParam;  // radius, soft (0..1 inner fraction), noise edge, seed
attribute vec4 iVal;    // channel amounts
uniform vec4 uRect;     // x0, z0, span, 1/span
varying vec2 vW;
varying vec4 vSeg, vParam, vVal;
void main() {
  float r = iParam.x;
  vec2 a = iSeg.xy, b = iSeg.zw;
  vec2 lo = min(a, b) - r, hi = max(a, b) + r;
  vec2 w = mix(lo, hi, position.xy * 0.5 + 0.5);
  vW = w; vSeg = iSeg; vParam = iParam; vVal = iVal;
  vec2 uv = (w - uRect.xy) * uRect.w;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;
const STAMP_FRAG = /* glsl */`
precision highp float;
varying vec2 vW;
varying vec4 vSeg, vParam, vVal;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), u.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), u.x), u.y); }
void main() {
  vec2 a = vSeg.xy, b = vSeg.zw, pa = vW - a, ba = b - a;
  float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * hh);
  float r = vParam.x;
  // ragged edge for blood/dust splats
  if (vParam.z > 0.0) {
    float n = vn(vW * 7.0 + vParam.w * 17.0) * 0.65 + vn(vW * 19.0 - vParam.w * 5.0) * 0.35;
    r *= mix(1.0, 0.45 + 0.9 * n, vParam.z);
  }
  float f = 1.0 - smoothstep(r * vParam.y, r, d);
  if (f <= 0.0) discard;
  gl_FragColor = vVal * f;
}
`;

export function createInteraction(app) {
  const { renderer } = app;
  const rtOpts = {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  };
  let rtRead = new THREE.WebGLRenderTarget(SIZE, SIZE, rtOpts);
  let rtWrite = new THREE.WebGLRenderTarget(SIZE, SIZE, rtOpts);
  rtRead.texture.name = 'tInteractA'; rtWrite.texture.name = 'tInteractB';

  // clear both maps once
  {
    const prev = renderer.getRenderTarget();
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of [rtRead, rtWrite]) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setClearColor(cc, ca);
    renderer.setRenderTarget(prev);
  }

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

  const copyMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uShift: { value: new THREE.Vector2() }, uDecay: { value: new THREE.Vector4(1, 1, 1, 1) } },
    vertexShader: FS_VERT, fragmentShader: COPY_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const copyMesh = new THREE.Mesh(quadGeo, copyMat);
  copyMesh.frustumCulled = false;
  const copyScene = new THREE.Scene();
  copyScene.add(copyMesh);

  // stamp instancing
  const sg = new THREE.InstancedBufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  sg.setIndex([0, 1, 2, 0, 2, 3]);
  const aSeg = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aParam = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aVal = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  sg.setAttribute('iSeg', aSeg); sg.setAttribute('iParam', aParam); sg.setAttribute('iVal', aVal);
  const stampAttrs = [aSeg, aParam, aVal];
  sg.instanceCount = 0;
  const rect = G.uInteractRect.value;
  const stampMat = new THREE.ShaderMaterial({
    uniforms: { uRect: { value: rect } },
    vertexShader: STAMP_VERT, fragmentShader: STAMP_FRAG,
    depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation, blendEquationAlpha: THREE.MaxEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
  });
  const stampMesh = new THREE.Mesh(sg, stampMat);
  stampMesh.frustumCulled = false;
  const stampScene = new THREE.Scene();
  stampScene.add(stampMesh);

  let nStamps = 0, stampSeed = 0;
  function push(x0, z0, x1, z1, r, soft, noise, R, Gc, B, A) {
    if (nStamps >= MAX_STAMPS) return;
    // skip stamps fully outside the current map
    const lo = Math.min(x0, x1) - r, hi = Math.max(x0, x1) + r, loz = Math.min(z0, z1) - r, hiz = Math.max(z0, z1) + r;
    if (hi < rect.x || lo > rect.x + SPAN || hiz < rect.y || loz > rect.y + SPAN) return;
    const i = nStamps++ * 4;
    aSeg.array[i] = x0; aSeg.array[i + 1] = z0; aSeg.array[i + 2] = x1; aSeg.array[i + 3] = z1;
    aParam.array[i] = Math.max(r, TEXEL * 0.75); aParam.array[i + 1] = soft; aParam.array[i + 2] = noise; aParam.array[i + 3] = (stampSeed++ % 97) * 0.731;
    aVal.array[i] = R; aVal.array[i + 1] = Gc; aVal.array[i + 2] = B; aVal.array[i + 3] = A;
  }

  // map centre
  const origin = new THREE.Vector2(NaN, NaN);   // texel-snapped x0,z0 of the current map
  let focusOverride = null;
  const decayAcc = [0, 0, 0, 0], decayF = [1, 1, 1, 1];
  let shockI = 0, slashI = 0;
  const actorOn = new Array(MAX_ACTORS).fill(false);

  const ix = {
    rt: rtRead,
    autoTrample: true,
    setActor(i, x, y, z, r = 0.45) {
      if (i < 0 || i >= MAX_ACTORS) return;
      G.uActors.value[i].set(x, y, z, r); actorOn[i] = true;
    },
    clearActor(i) {
      if (i < 0 || i >= MAX_ACTORS) return;
      G.uActors.value[i].set(0, -999, 0, 0); actorOn[i] = false;
    },
    trample(x, z, r = 0.35, strength = 0.8) { push(x, z, x, z, r, 0.25, 0.15, Math.min(strength, 1), 0, 0, 0); },
    cut(x0, z0, x1, z1, width = 0.3) { push(x0, z0, x1, z1, Math.max(width * 0.5, 0.08), 0.55, 0, 0, 1, 0, 0); },
    stain(x, z, r = 0.4, amount = 1) { push(x, z, x, z, r, 0.35, 0.85, 0, 0, Math.min(amount, 1), 0); },
    dust(x, z, r = 0.8, amount = 1) { push(x, z, x, z, r, 0.2, 0.5, 0, 0, 0, Math.min(amount, 1)); },
    shock(x, z, strength = 1) { G.uShock.value[shockI++ % 4].set(x, z, G.uTime.value, strength); },
    slash(x0, z0, x1, z1, strength = 1, height = 1) {
      const i = slashI++ % 4;
      G.uSlash.value[i].set(x0, z0, x1, z1);
      G.uSlashB.value[i].set(G.uTime.value, strength, height, 0);
    },
    setFocus(x, z) { focusOverride = x === null || x === undefined ? null : { x, z }; },
    update(dt) {
      const c = app.camera.position;
      // camera clearing radius: only a lens close to the ground parts the blades
      const hAbove = c.y - app.world.heightAt(c.x, c.z);
      G.uCamGround.value.set(c.x, c.z, 0.8 * (1 - THREE.MathUtils.smoothstep(hAbove, 1.3, 2.4)));

      // focus: override → player (actor 0) → camera
      let fx = c.x, fz = c.z;
      const a0 = G.uActors.value[0];
      if (focusOverride) { fx = focusOverride.x; fz = focusOverride.z; }
      else if (a0.w > 0) { fx = a0.x; fz = a0.z; }
      const nx = Math.round((fx - SPAN / 2) / TEXEL) * TEXEL, nz = Math.round((fz - SPAN / 2) / TEXEL) * TEXEL;
      let sx = 0, sz = 0;
      if (Number.isNaN(origin.x)) origin.set(nx, nz);
      else { sx = Math.round((nx - origin.x) / TEXEL); sz = Math.round((nz - origin.y) / TEXEL); }
      origin.set(nx, nz);
      rect.set(nx, nz, SPAN, 1 / SPAN);

      // auto-trample under standing/walking actors (weak; footsteps add the strong prints)
      if (this.autoTrample) {
        for (let i = 0; i < MAX_ACTORS; i++) {
          const a = G.uActors.value[i];
          if (!actorOn[i] || a.w <= 0) continue;
          const gh = app.world.heightAt(a.x, a.z);
          if (a.y - gh > 0.6) continue; // airborne
          push(a.x, a.z, a.x, a.z, a.w * 0.8, 0.2, 0.2, 0.38, 0, 0, 0);
        }
      }

      // decay factors; slow channels accumulate time until the step is representable in half floats
      for (let k = 0; k < 4; k++) {
        decayAcc[k] += dt;
        const fk = Math.exp(-decayAcc[k] / TAU[k]);
        if (1 - fk >= 0.0012) { decayF[k] = fk; decayAcc[k] = 0; } else decayF[k] = 1;
      }
      copyMat.uniforms.uDecay.value.fromArray(decayF);

      const prevRT = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      renderer.autoClear = false;
      copyMat.uniforms.tSrc.value = rtRead.texture;
      copyMat.uniforms.uShift.value.set(sx, sz);
      renderer.setRenderTarget(rtWrite);
      renderer.render(copyScene, cam);
      if (nStamps > 0) {
        sg.instanceCount = nStamps;
        for (let k = 0; k < 3; k++) { const at = stampAttrs[k]; at.clearUpdateRanges(); at.addUpdateRange(0, nStamps * 4); at.needsUpdate = true; }
        renderer.setRenderTarget(rtWrite);
        renderer.render(stampScene, cam);
        nStamps = 0;
      }
      renderer.setRenderTarget(prevRT);
      renderer.autoClear = prevAuto;
      const t = rtRead; rtRead = rtWrite; rtWrite = t;
      ix.rt = rtRead;
      G.tInteract.value = rtRead.texture;
    },
    dispose() {
      rtRead.dispose(); rtWrite.dispose(); sg.dispose(); quadGeo.dispose(); copyMat.dispose(); stampMat.dispose();
      app.remove(ix);
    },
  };
  G.tInteract.value = rtRead.texture;
  app.add(ix);
  return ix;
}
