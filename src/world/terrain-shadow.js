// Terrain sun visibility (long hill shadows beyond the far shadow map). Owner: world (W).
//
// At a 9.5° sun a 20 m swell throws a 120 m shadow, but the far shadow map only covers ±150 m around the camera.
// This bakes the terrain's self-shadowing over the whole mesh (±1536 m, 3 m texels) on the GPU: every texel marches
// toward the sun over a float height texture and keeps a soft angular clearance (≈2° penumbra). It is re-rendered
// only when the key light turns by more than 0.3° (at most twice a second during mood transitions).
//
//   const sh = createTerrainShadow(app)  → { texture, uniforms: { tWtSunVis, uWtSunRect }, update(), render() }
//   Shared uniforms (attached to G for other areas): G.tWtSunVis (RGBA8, R = sun visibility 0..1), G.uWtSunRect
//   (x0, z0, size, 1/size). GLSL: vis = texture(tWtSunVis, (xz - uWtSunRect.xy) * uWtSunRect.w).r (1 outside).
import * as THREE from 'three';
import { G } from '../core/globals.js';
import { grid, GRID } from './terrain-field.js';

const N = 1024, HALF = 1536;

/** Mesh heights on an N² lattice over ±HALF (texel centres), straight from the vertex grid (fast, exact). */
function heightLattice() {
  const g = grid(), n = g.n, H = g.H, xs = g.xs;
  const T = (2 * HALF) / N;
  const ci = new Int32Array(N), cf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = Math.min(GRID.edge - 1e-3, Math.max(-GRID.edge + 1e-3, -HALF + (i + 0.5) * T));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= v) lo = m; else hi = m; }
    ci[i] = lo; cf[i] = (v - xs[lo]) / (xs[lo + 1] - xs[lo]);
  }
  const out = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    const j = ci[r], fz = cf[r], row = j * n;
    for (let c = 0; c < N; c++) {
      const i = ci[c], fx = cf[c], k = row + i;
      const a = H[k] + (H[k + 1] - H[k]) * fx, b = H[k + n] + (H[k + n + 1] - H[k + n]) * fx;
      out[r * N + c] = a + (b - a) * fz;
    }
  }
  return out;
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const FRAG = /* glsl */`
precision highp float;
uniform highp sampler2D tH;
uniform vec4 uRect;
uniform vec3 uSun;
varying vec2 vUv;
float hAt(vec2 xz) {
  vec2 t = (xz - uRect.xy) * uRect.w * ${N}.0 - 0.5;
  if (t.x < 0.0 || t.y < 0.0 || t.x > ${N - 1}.0 || t.y > ${N - 1}.0) return -1e4;
  ivec2 i = ivec2(floor(t)); vec2 f = t - vec2(i);
  float a = texelFetch(tH, i, 0).r, b = texelFetch(tH, min(i + ivec2(1, 0), ivec2(${N - 1})), 0).r;
  float c = texelFetch(tH, min(i + ivec2(0, 1), ivec2(${N - 1})), 0).r, d = texelFetch(tH, min(i + ivec2(1, 1), ivec2(${N - 1})), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec2 xz = uRect.xy + vUv * uRect.z;
  float h0 = hAt(xz) + 0.6;
  vec3 L = normalize(uSun);
  float lh = max(length(L.xz), 1e-3);
  vec2 d = L.xz / lh;
  float tanE = L.y / lh;
  float vis = 1.0, t = 2.5;
  for (int i = 0; i < 56; i++) {
    vec2 p = xz + d * t;
    float clear = h0 + t * tanE - hAt(p);
    vis = min(vis, clamp(clear / (t * 0.035) + 0.5, 0.0, 1.0));   // ~2° soft penumbra
    t = t * 1.1 + 1.2;
    if (t > 1600.0 || vis <= 0.0) break;
  }
  gl_FragColor = vec4(vis, vis, vis, 1.0);
}
`;

export function createTerrainShadow(app) {
  const { renderer } = app;
  const hTex = new THREE.DataTexture(heightLattice(), N, N, THREE.RedFormat, THREE.FloatType);
  hTex.minFilter = hTex.magFilter = THREE.NearestFilter;
  hTex.generateMipmaps = false;
  hTex.needsUpdate = true;
  const rt = new THREE.WebGLRenderTarget(N, N, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });
  rt.texture.minFilter = THREE.LinearFilter; rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;
  rt.texture.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    uniforms: { tH: { value: hTex }, uRect: { value: new THREE.Vector4(-HALF, -HALF, 2 * HALF, 1 / (2 * HALF)) }, uSun: { value: new THREE.Vector3() } },
    vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  G.tWtSunVis = G.tWtSunVis || { value: null };
  G.uWtSunRect = G.uWtSunRect || { value: new THREE.Vector4() };
  G.tWtSunVis.value = rt.texture;
  G.uWtSunRect.value.set(-HALF, -HALF, 2 * HALF, 1 / (2 * HALF));

  const last = new THREE.Vector3(0, -2, 0);
  let lastT = -1e9;
  const sh = {
    texture: rt.texture,
    uniforms: { tWtSunVis: G.tWtSunVis, uWtSunRect: G.uWtSunRect },
    render() {
      mat.uniforms.uSun.value.copy(G.uSunDir.value);
      last.copy(G.uSunDir.value);
      const prev = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
      renderer.setRenderTarget(rt);
      renderer.autoClear = true;
      renderer.render(scene, cam);
      renderer.setRenderTarget(prev);
      renderer.autoClear = prevAuto;
    },
    update(dt, t, _app, rawDt) {
      const s = G.uSunDir.value;
      const now = performance.now();
      if (s.dot(last) < 0.999986 && now - lastT > 500) { lastT = now; sh.render(); }   // > 0.3°
    },
  };
  sh.render();
  app.add(sh);
  return sh;
}
