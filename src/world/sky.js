// Sky dome (bible §3.1): horizon from the shared fog in-scatter (seamless with every fogged surface), 3-stop
// gradient, three sun lobes + disc, painted clouds (self-shadow tap, backlit silver lining, aerial haze) under a high
// cirrus layer, the Belt of Venus / Earth's shadow at dusk, and stars / Milky Way / moon at night. Owner: S.
// STABLE API:
//   const sky = createSky(app)       → { mesh, material, captureMesh, cloudNoise }   (mesh already added to app.scene)
//   SKY_GLSL                          GLSL: `vec3 wx_skyColor(vec3 rd)` (needs ATMOS_GLSL + the sky uniforms of G)
//   G.uCloudCover                     shared uniform (added here): x coverage offset, y opacity (env writes per mood)
//   G.tCloudNoise                     shared uniform (added here): 512² RGBA8 tileable, mipmapped cloud noise
//                                     R warped billow fBm · G wind-streak fBm (x = along) · B cellular puffs · A detail fBm
// The dome is drawn LAST among opaques (renderOrder 10) with gl_Position = p.xyww (depth 1, LessEqual), so its fragment
// work only runs where no geometry covers the pixel. Clouds cost 5 texture taps (baked once at load on the GPU) instead
// of ~25 procedural noise evaluations. It reads only the view rotation (mat3(viewMatrix)), so it needs no re-centring,
// and serves the env-cube capture too (captureMesh: no disc, lower hemisphere = sunlit meadow).
import * as THREE from 'three';
import { G, LAYERS } from '../core/globals.js';
import { U } from '../core/glsl.js';
import { ATMOS_GLSL } from '../core/atmosphere.js';

G.tCloudNoise ??= { value: null };
G.uCloudCover ??= { value: new THREE.Vector4(0, 1, 0, 0) };   // x coverage offset (−0.3 clear … +0.3 overcast), y opacity

export const SKY_GLSL = /* glsl */`
${U('vec3', 'uSkyZen')}${U('vec3', 'uSkyUp')}${U('vec3', 'uCloudLit')}${U('vec3', 'uCloudShade')}
${U('float', 'uSunVis')}${U('vec3', 'uMoonDir')}${U('float', 'uNight')}${U('sampler2D', 'tCloudNoise')}${U('vec4', 'uCloudCover')}

// ---- night: two jittered star layers on cube-face grids, Milky Way band, moon with maria ----
// One jittered star per cell for the brightest ~(1-thr) of cells; magnitude ramps linearly above the threshold so
// the field has a few bright stars and many faint ones. Colour temperature varies (blue-white … warm).
vec3 wx_starLayer(vec2 uv, float cells, float thr, float seed) {
  vec2 g = uv * cells, id = floor(g), f = g - id;
  float px = max(fwidth(g.x) + fwidth(g.y), 1e-4) * 0.5;   // ~1 px wide whatever the resolution (uniform flow)
  float hsh = wx_hash12(id * 1.37 + seed * 0.71);
  if (hsh < thr) return vec3(0.0);
  float m = (hsh - thr) / (1.0 - thr);
  m *= m;
  vec2 j = wx_hash22(id + seed) * 0.8 + 0.1;
  vec2 d = (f - j) / px;
  float tw = 0.7 + 0.3 * sin(uTime * (1.5 + 4.0 * wx_hash12(id + 3.1)) + 6.2832 * wx_hash12(id + 9.7));
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.7), wx_hash12(id + 5.3));
  return tint * m * tw * exp(-dot(d, d));
}
vec3 wx_nightSky(vec3 rd, float h) {
  vec3 a = abs(rd); vec2 uv; float face;
  if (a.x >= a.y && a.x >= a.z) { uv = rd.yz / a.x; face = rd.x > 0.0 ? 1.0 : 2.0; }
  else if (a.y >= a.z) { uv = rd.xz / a.y; face = rd.y > 0.0 ? 3.0 : 4.0; }
  else { uv = rd.xy / a.z; face = rd.z > 0.0 ? 5.0 : 6.0; }
  // bright stars appear first (blue hour), the faint field only in full night
  float nb = smoothstep(0.3, 0.75, uNight), nf = smoothstep(0.6, 1.0, uNight);
  vec3 st = wx_starLayer(uv, 55.0, 0.985, face * 17.0) * 0.9 * nb + wx_starLayer(uv, 150.0, 0.988, face * 31.0 + 5.0) * 0.28 * nf;
  vec3 col = st * smoothstep(0.0, 0.2, h);
  // Milky Way: a great-circle band broken by dust lanes (baked noise: cheap)
  vec3 ax = normalize(vec3(0.55, 0.35, 0.76));
  float bd = dot(rd, ax);
  float mw = exp(-(bd * 3.2) * (bd * 3.2));
  vec2 mp = vec2(atan(rd.z, rd.x) * 0.31831, bd * 0.45);          // x spans exactly 2 tiles: seamless
  float dust = textureLod(tCloudNoise, mp * 2.0 + 0.3, 1.5).r;
  float glow = textureLod(tCloudNoise, mp + 0.7, 2.5).a;
  col += vec3(0.05, 0.06, 0.09) * 0.55 * mw * (0.45 + 1.2 * glow) * (1.0 - 0.75 * smoothstep(0.45, 0.68, dust)) * smoothstep(0.0, 0.3, h) * nf;
  return col;
}
vec3 wx_moon(vec3 rd) {
  float mu = dot(rd, uMoonDir);
  vec3 col = vec3(0.5, 0.58, 0.72) * (pow(max(mu, 0.0), 60.0) * 0.06 + pow(max(mu, 0.0), 900.0) * 0.18);
  if (mu > 0.9998) {
    vec3 t = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 b = cross(t, uMoonDir);
    vec3 q = rd - uMoonDir * mu;
    vec2 p = vec2(dot(q, t), dot(q, b)) / 0.0155;                 // disc radius ~0.9 deg
    float r2 = dot(p, p);
    float maria = smoothstep(0.42, 0.68, wx_fbm3v(p * 1.6 + 3.0)) * 0.34 + wx_vnoise(p * 7.0) * 0.08;
    float limb = sqrt(max(1.0 - r2, 0.0));
    col += vec3(1.9, 2.0, 2.15) * (1.0 - maria) * (0.55 + 0.45 * limb) * smoothstep(1.0, 0.93, sqrt(r2));
  }
  return col * smoothstep(-0.02, 0.03, uMoonDir.y);
}

// ---- clouds: painted, analytic (not raymarched) ----
// Cloud-plane coordinates: rd.xz/(h+0.06) compresses the deck toward the horizon (perspective), rotated so the
// texture's streak axis (x) runs downwind; the deck drifts downwind.
vec2 wx_cloudUV(vec3 rd, float h, out vec2 sunUV) {
  vec2 W = normalize(uWind.xy + vec2(1e-4, 0.0));
  vec2 P = vec2(-W.y, W.x);
  vec2 uv = rd.xz / (h + 0.06) * 0.9;
  vec2 sxz = normalize(uSunDir.xz + vec2(1e-4, 0.0));
  sunUV = vec2(dot(sxz, W), dot(sxz, P));
  return vec2(dot(uv, W), dot(uv, P)) - vec2(uTime * (0.0042 + 0.012 * uStorm) * uWind.z, 0.0);
}
// Coverage field from the baked noise (3 taps). Returns (coverage, thickness proxy).
vec2 wx_cloudField(vec2 uv) {
  vec4 a = texture2D(tCloudNoise, uv * 0.075);                        // masses, ~13 units per tile
  vec4 b = texture2D(tCloudNoise, uv * 0.23 + vec2(0.37, 0.61));        // puffs + detail
  float st = texture2D(tCloudNoise, uv * vec2(0.035, 0.06) + 0.13).g;   // long wind-combed bands
  float cov = a.r * 0.78 + st * 0.42 + (b.b - 0.5) * 0.22 + (b.a - 0.5) * 0.12 - 0.17;
  return vec2(cov, a.r * 0.7 + b.b * 0.3);
}
// Returns the cloud colour (rgb) and coverage (a). s = dot(rd, sun), band = horizon band, bg = sky behind.
vec4 wx_clouds(vec3 rd, float h, float s, float band, vec3 bg) {
  float clear = 1.0 - uStorm;
  vec2 sunUV;
  vec2 uv = wx_cloudUV(rd, h, sunUV);
  vec2 f = wx_cloudField(uv);
  float cov = f.x + uCloudCover.x + uStorm * 0.55 - uNight * 0.08 * clear;
  float d = smoothstep(0.52 - 0.3 * uStorm, 0.74 - 0.1 * uStorm, cov);
  d *= smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.26, 0.62, h) * 0.9 * clear);   // mass lives 3–30 deg up
  if (d < 0.003) return vec4(0.0);
  float thick = clamp(smoothstep(0.58, 0.95, cov) * 0.85 + (f.y - 0.5) * 0.3 + 0.6 * uStorm, 0.0, 1.0);
  // self-shadow tap toward the sun (bible §3.1): sun-facing edges light up, far sides and cores deepen
  vec2 fS = wx_cloudField(uv + sunUV * 0.09);
  float edge = clamp((f.x - fS.x) * 3.5, -1.0, 1.0);
  thick = clamp(thick + 0.4 * max(-edge, 0.0), 0.0, 1.0);
  // front-lit (sun behind the viewer / to the side): gold-cream sun-facing sides, cool violet shade in the cores
  float litK = clamp(0.62 + 0.55 * edge - 0.75 * thick, 0.0, 1.0);
  vec3 front = mix(uCloudShade, uCloudLit * (1.0 + 0.25 * max(edge, 0.0)), litK);
  front += uHorizonGlow * 0.16 * band * (1.0 - thick) * clear;                  // the low sun warms the undersides
  // backlit (looking toward the sun): thin veils glow a little brighter than the sky behind, thick bodies stand
  // dark against the glow, every thin edge gets a silver-gold lining
  float fwd = smoothstep(0.55, 0.98, s);
  vec3 back = mix(bg * 1.12, uCloudShade * 0.85 + bg * 0.12, smoothstep(0.12, 0.65, thick));
  back += uSunCol * vec3(1.0, 0.8, 0.55) * pow(s, 10.0) * pow(1.0 - thick, 3.0) * 0.45 * clear;
  vec3 cc = mix(front, back, fwd * clear);
  // aerial perspective: the low deck is kilometres away, it melts into the horizon haze
  cc = mix(cc, bg, smoothstep(0.1, 0.0, h) * 0.55);
  return vec4(cc, d * (0.92 + 0.06 * uStorm) * uCloudCover.y);
}
// High cirrus: thin wind-combed streaks, lit gold near the sun, above the low deck. Finer texture scale than the deck
// (it stays crisp overhead, where the flatter projection magnifies it).
vec4 wx_cirrus(vec3 rd, float h, float s) {
  vec2 W = normalize(uWind.xy + vec2(1e-4, 0.0));
  vec2 uv = rd.xz / (h + 0.25) * 0.35;
  uv = vec2(dot(uv, W), dot(uv, vec2(-W.y, W.x))) - vec2(uTime * 0.0012, 0.0);
  float g = texture2D(tCloudNoise, uv * vec2(0.45, 1.6) + 0.51).g;
  float a = texture2D(tCloudNoise, uv * vec2(1.8, 3.6) + 0.17).a;
  float m = texture2D(tCloudNoise, uv * 0.12 + 0.77).r;                  // patchiness: cirrus comes in fields
  float ci = smoothstep(0.55, 0.85, g * 0.8 + a * 0.35) * smoothstep(0.45, 0.7, m) * 0.32;
  ci *= smoothstep(0.04, 0.3, h) * (1.0 - uStorm) * (1.0 - 0.6 * uNight) * uCloudCover.y;
  vec3 c = mix(uCloudLit * 0.9, uSunCol * vec3(1.0, 0.8, 0.6) * 0.35, pow(s, 3.0));
  return vec4(c, ci);
}

// The warm white balance + amber grade (post) neutralise mid blues: pre-saturate the open-sky stops (not the horizon,
// which must equal the fog colour).
vec3 wx_skySat(vec3 c, float k) { float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); return max(vec3(l) + (c - l) * k, 0.0); }

vec3 wx_skyColor(vec3 rd) {
  float h = rd.y;
  float clear = 1.0 - uStorm;
  vec3 hd = normalize(vec3(rd.x, max(h, 0.0), rd.z));
  vec3 gd = h > 0.0 ? rd : hd;                         // below the horizon the sky is the horizon (== fog colour)
  float s = max(dot(gd, uSunDir), 0.0);
  float band = exp(-max(h, 0.0) * 7.0);
  // 3-stop gradient: horizon (= fog in-scatter) → mid sky → zenith. The mid sky warms toward the sun (aureole).
  vec3 sT = wx_sunTrue();
  vec3 col = wx_fogBase(hd);
  col = mix(col, wx_skySat(uSkyUp, 1.25), smoothstep(0.0, 0.22, h));
  col = mix(col, wx_skySat(uSkyZen, 1.08), smoothstep(0.18, 0.75, h));
  // dusk: Earth's shadow (cool band) under the Belt of Venus (rose band) opposite the sun
  float dusk = smoothstep(0.08, 0.0, sT.y) * smoothstep(-0.2, -0.06, sT.y) * clear;
  if (dusk > 0.001) {
    float anti = max(-dot(normalize(hd.xz + vec2(1e-5)), normalize(sT.xz + vec2(1e-5))), 0.0);
    anti = anti * anti * dusk * smoothstep(0.0, 0.03, h);
    col *= 1.0 - 0.35 * anti * exp(-pow(h / 0.05, 2.0));
    col += (uHorizonGlow * vec3(0.9, 0.62, 0.8) + vec3(0.02, 0.0, 0.02)) * 0.22 * anti * exp(-pow((h - 0.11) / 0.07, 2.0));
  }
  col += wx_sunGlow(gd);
  if (uNight > 0.001) col += (wx_nightSky(gd, h) + wx_moon(gd) * smoothstep(0.05, 0.45, uNight)) * (1.0 - 0.85 * uStorm);
#ifndef ENV_CAPTURE
  // sun disc (~0.9 deg) with limb darkening; the bloom pass turns it into a glare ball
  float sd = dot(gd, uSunDir);
  float disc = smoothstep(0.99986, 0.99991, sd);
  float limb = clamp((sd - 0.99986) / (1.0 - 0.99986), 0.0, 1.0);
  col += uSunCol * vec3(1.0, 0.9, 0.8) * 9.0 * disc * (0.55 + 0.45 * sqrt(limb)) * uSunVis * clear;
#endif
  if (h > -0.01) {
    vec4 ci = wx_cirrus(gd, max(h, 0.0), s);
    col = mix(col, ci.rgb, ci.a);
    vec4 cl = wx_clouds(gd, max(h, 0.0), s, band, col);
    col = mix(col, cl.rgb, cl.a);
  }
#ifdef ENV_CAPTURE
  // lower hemisphere: the sunlit golden meadow (canopy albedo x ground irradiance / pi) for IBL and the blade
  vec3 E = uSunCol * 0.6 * max(uSunDir.y, 0.0) + uSkyUp * 2.2 + uFogCool * 0.6;
  vec3 gnd = vec3(0.16, 0.12, 0.05) * E * 0.3183;
  col = mix(col, gnd, smoothstep(0.0, 0.16, -h));
#endif
  return col;
}
`;

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);   // rotation only: infinitely far
  gl_Position = p.xyww;                                                  // depth 1 → drawn behind everything
}
`;

const FRAG = /* glsl */`
${ATMOS_GLSL}
${SKY_GLSL}
varying vec3 vDir;
void main() {
  gl_FragColor = vec4(wx_skyColor(normalize(vDir)), 1.0);
}
`;

// ---- tileable cloud noise, baked once on the GPU ----
// Every octave hashes its lattice modulo its own period, so all four channels tile exactly at the texture border
// (warps are periodic too). Mipmapped: the horizon, where the deck compresses, reads soft instead of aliasing.
const BAKE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float pn(vec2 p, vec2 P) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  float a = h12(mod(i, P)), b = h12(mod(i + vec2(1.0, 0.0), P)), c = h12(mod(i + vec2(0.0, 1.0), P)), d = h12(mod(i + vec2(1.0, 1.0), P));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 p, vec2 P, int oct, float gain) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * pn(p, P); n += a;
    p = p * 2.0 + vec2(13.0, 7.0); P *= 2.0; a *= gain;
  }
  return s / n;
}
float pworley(vec2 p, vec2 P) {
  vec2 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 r = g + h22(mod(i + g, P)) * 0.9 + 0.05 - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
// contrast-normalise an fBm (mean ~0.5, most values in 0.25..0.75) to use the full 8-bit range
float spread(float v) { return clamp((v - 0.5) * 1.7 + 0.5, 0.0, 1.0); }
void main() {
  vec2 uv = vUv;
  // R: warped billows — soft cumulus / stratocumulus masses
  vec2 p = uv * 5.0; vec2 P = vec2(5.0);
  vec2 w = vec2(pfbm(p + vec2(1.7, 9.2), P, 4, 0.5), pfbm(p + vec2(8.3, 2.8), P, 4, 0.5)) - 0.5;
  float r = pfbm(p + w * 2.2, P, 6, 0.52);
  // G: wind-combed streaks (x = along the wind: 5x longer than wide)
  float g = pfbm(uv * vec2(3.0, 15.0) + vec2(0.0, pn(uv * vec2(3.0, 6.0), vec2(3.0, 6.0)) * 2.0), vec2(3.0, 15.0), 5, 0.5);
  // B: cellular puffs (inverted Worley, two octaves) — cauliflower tops
  float b = (1.0 - pworley(uv * 9.0, vec2(9.0))) * 0.62 + (1.0 - pworley(uv * 21.0, vec2(21.0))) * 0.38;
  // A: fine detail fBm for edge erosion / wisps
  float a = pfbm(uv * 26.0, vec2(26.0), 4, 0.55);
  gl_FragColor = vec4(spread(r), spread(g), clamp(b * 1.15 - 0.1, 0.0, 1.0), spread(a));
}
`;

function bakeCloudNoise(renderer, size = 512) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, depthBuffer: false,
  });
  rt.texture.name = 'cloudNoise';
  rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE_FRAG, depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);            // three regenerates the mip chain after rendering into rt
  renderer.setRenderTarget(prev);
  mat.dispose(); quad.geometry.dispose();
  return rt;
}

function makeMaterial(capture) {
  return new THREE.ShaderMaterial({
    name: capture ? 'skyCapture' : 'sky',
    uniforms: { ...G },          // shared by reference: env writes G, the sky follows
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: capture ? { ENV_CAPTURE: '' } : {},
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
}

export function createSky(app) {
  if (!G.tCloudNoise.value) G.tCloudNoise.value = bakeCloudNoise(app.renderer).texture;
  const geo = new THREE.SphereGeometry(5000, 64, 32);
  const material = makeMaterial(false);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;             // last among opaques (bible §2.3)
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.layers.set(LAYERS.WORLD);
  mesh.matrixAutoUpdate = false;
  app.scene.add(mesh);

  const captureMesh = new THREE.Mesh(geo, makeMaterial(true));
  captureMesh.name = 'skyCapture';
  captureMesh.frustumCulled = false;
  captureMesh.matrixAutoUpdate = false;
  return { mesh, material, captureMesh, cloudNoise: G.tCloudNoise.value };
}
