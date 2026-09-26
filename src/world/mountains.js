// Distant mountains (bible §3.2): four 360° ring ribbons stepping back into the haze like the planes of a shan shui
// ink painting (远山). Each range reads as an ink-wash band: its ridge line is the densest ink, and the slope below
// fades through valley mist into the next plane. Broad rounded massifs carry sharper crests and the odd tall peak;
// the ranges part in a notch where the sun sets; a snow range stands on the anti-solar side and turns rose-gold
// (alpenglow) when the camera looks away from the sun. One merged mesh, one draw call, fog:false (it does its own
// sky-matched haze). Owner: world (W).
//
//   const mountains = createMountains(app, { seed })  → { mesh, material, layers }
//   material.uniforms.uInk   x ridge-ink darkening, y valley-mist amount, z snow amount, w alpenglow gain
//   MOUNTAIN_LAYERS          radius / H / base / depth / haze / snow per ring (bible table)
import * as THREE from 'three';
import { G, SUN_DIR, WORLD } from '../core/globals.js';
import { createNoise } from '../core/noise.js';
import { ATMOS_GLSL, atmosUniforms } from '../core/atmosphere.js';
import { U } from '../core/glsl.js';

// radius m, max height H, base, radial depth, constant haze, feature scale (noise units around the circle), snow
export const MOUNTAIN_LAYERS = [
  { radius: 1800, H: 170, base: -70, depth: 300, haze: 0.30, rho: 4.2, snow: 0, peaks: 0.25 },
  { radius: 2400, H: 330, base: -80, depth: 400, haze: 0.50, rho: 3.6, snow: 0, peaks: 0.45 },
  { radius: 3200, H: 540, base: -40, depth: 520, haze: 0.64, rho: 3.1, snow: 1, peaks: 0.7 },
  { radius: 4200, H: 800, base: -60, depth: 560, haze: 0.76, rho: 2.6, snow: 0.45, peaks: 1.0 },
];
const NA = 2880, NE = 16;

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function ridged3(nz, x, y, z, oct) {
  let s = 0, a = 0.5, f = 1, w = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    let h = 1 - Math.abs(nz.simplex3(x * f + o * 17.3, y * f - o * 9.1, z * f + o * 3.7));
    h *= h; h *= w; w = Math.min(1, h * 1.7);
    s += h * a; n += a; a *= 0.5; f *= 2.05;
  }
  return s / n;
}
function fbm3(nz, x, y, z, oct) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += a * nz.simplex3(x * f + o * 5.1, y * f + o * 1.7, z * f - o * 2.9); n += a; a *= 0.5; f *= 2.0; }
  return s / n;
}

function buildGeometry(seed) {
  const nz = createNoise(seed);
  const sunAz = Math.atan2(SUN_DIR.x, SUN_DIR.z);
  const antiAz = sunAz + Math.PI;
  const verts = MOUNTAIN_LAYERS.length * (NA + 1) * (NE + 1);
  const pos = new Float32Array(verts * 3), attr = new Float32Array(verts * 4); // local relH, layer, snow side, global relH
  const idx = [];
  const col = new Float32Array(NE + 1);
  let v = 0;
  const nrm = new Float32Array(verts * 3);
  MOUNTAIN_LAYERS.forEach((L, li) => {
    const v0 = v;
    const HH = new Float32Array((NA + 1) * (NE + 1));
    for (let a = 0; a <= NA; a++) {
      const th = -Math.PI + (a / NA) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      let dS = th - sunAz; dS = Math.atan2(Math.sin(dS), Math.cos(dS));
      let dA = th - antiAz; dA = Math.atan2(Math.sin(dA), Math.cos(dA));
      const notch = 1 - 0.55 * Math.exp(-(dS / 0.2) * (dS / 0.2));
      const prof = 0.65 + 0.35 * sstep(0.3, 1.2, Math.abs(dS));
      const snowSide = Math.exp(-(dA / 0.8) * (dA / 0.8));
      const lift = 1 + 0.4 * L.snow * snowSide;
      // broad massifs: smooth, sharpened fBm around the ring (2–4 big mountains per 90°)
      const m = fbm3(nz, c * L.rho * 0.45 + li * 7.7, s * L.rho * 0.45, li * 3.3, 3);
      const massif = sstep(-0.45, 0.55, m);
      // domain warp so crests wander instead of repeating
      const wx = fbm3(nz, c * 2.1 + 11, s * 2.1, li, 2) * 0.35, wz = fbm3(nz, c * 2.1 - 5, s * 2.1, li + 9, 2) * 0.35;
      // composed hero peaks (a painter's placement): two dark summits flanking the sun notch on the far range,
      // the snow massif's summits on the anti-solar side of range 3
      let hero = 0;
      const bump = (d, w, k) => k * Math.exp(-(d / w) * (d / w));
      if (li === 3) hero += bump(dS - 0.42, 0.09, 0.55) + bump(dS + 0.5, 0.12, 0.42) + bump(dA + 0.9, 0.2, 0.25);
      if (li === 2) hero += (bump(dA - 0.2, 0.1, 0.55) + bump(dA + 0.33, 0.08, 0.4) + bump(dA - 0.62, 0.12, 0.26)) * L.snow;
      if (li === 1) hero += bump(dS - 0.95, 0.1, 0.3);
      let ymax = -Infinity;
      for (let e = 0; e <= NE; e++) {
        const E = e / NE;
        const r = ridged3(nz, (c + wx) * L.rho + li * 11.1, (s + wz) * L.rho - li * 5.3, E * 1.4 + li * 2.7, 5);
        const crest = Math.pow(r, 1.25);
        const hk = hero * (0.7 + 0.3 * r);                                     // hero peaks keep a ridged texture
        const amp = (0.12 + 0.66 * massif + 0.26 * crest * (0.45 + 0.55 * massif) + hk) * notch * prof * lift;
        const front = Math.sin(Math.min(1, E * 2.0 + 0.04) * Math.PI / 2);
        const back = 1 - 0.6 * Math.pow(Math.max(0, E - 0.65) / 0.35, 2);   // the far edge falls away (no wall behind)
        col[e] = L.H * amp * front * back;
        ymax = Math.max(ymax, col[e]);
      }
      for (let e = 0; e <= NE; e++) {
        const E = e / NE;
        const rad = L.radius + E * L.depth;
        const y = L.base + col[e];
        HH[a * (NE + 1) + e] = y;
        pos[v * 3] = s * rad; pos[v * 3 + 1] = y; pos[v * 3 + 2] = c * rad;
        attr[v * 4] = col[e] / Math.max(ymax, 1);              // 0 base … 1 local ridge line
        attr[v * 4 + 1] = li;
        attr[v * 4 + 2] = snowSide * L.snow;
        attr[v * 4 + 3] = col[e] / (L.H * lift);               // height relative to the range's max
        v++;
      }
    }
    // shading normals from a smoothed copy of the heights: the silhouette keeps every crest, the slopes shade like
    // broad washes instead of vertical curtain folds
    const W = NE + 1, SM = new Float32Array(HH.length), R = 4;
    for (let a = 0; a <= NA; a++) for (let e = 0; e <= NE; e++) {
      let sum = 0, n = 0;
      for (let k = -R; k <= R; k++) { const aa = (a + k + NA) % NA; for (let q = -1; q <= 1; q++) { const ee = Math.min(NE, Math.max(0, e + q)); sum += HH[aa * W + ee]; n++; } }
      SM[a * W + e] = sum / n;
    }
    for (let a = 0; a <= NA; a++) for (let e = 0; e <= NE; e++) {
      const k = v0 + a * W + e;
      const a0 = (a - 1 + NA) % NA, a1 = (a + 1) % NA, e0 = Math.max(0, e - 1), e1 = Math.min(NE, e + 1);
      // tangents along the ring and along the radius (world space)
      const pA0 = v0 + a0 * W + e, pA1 = v0 + a1 * W + e, pE0 = v0 + a * W + e0, pE1 = v0 + a * W + e1;
      const tax = pos[pA1 * 3] - pos[pA0 * 3], tay = SM[a1 * W + e] - SM[a0 * W + e], taz = pos[pA1 * 3 + 2] - pos[pA0 * 3 + 2];
      const tex = pos[pE1 * 3] - pos[pE0 * 3], tey = SM[a * W + e1] - SM[a * W + e0], tez = pos[pE1 * 3 + 2] - pos[pE0 * 3 + 2];
      // n = te × ta (points up)
      let nx = tey * taz - tez * tay, ny = tez * tax - tex * taz, nz2 = tex * tay - tey * tax;
      if (ny < 0) { nx = -nx; ny = -ny; nz2 = -nz2; }
      const il = 1 / Math.hypot(nx, ny, nz2);
      nrm[k * 3] = nx * il; nrm[k * 3 + 1] = ny * il; nrm[k * 3 + 2] = nz2 * il;
    }
    for (let a = 0; a < NA; a++) for (let e = 0; e < NE; e++) {
      const i0 = v0 + a * (NE + 1) + e, i1 = i0 + NE + 1;
      idx.push(i0, i0 + 1, i1, i1, i0 + 1, i1 + 1);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aMtn', new THREE.BufferAttribute(attr, 4));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

const VERT = /* glsl */`
attribute vec4 aMtn;
varying vec3 vWp; varying vec3 vN; varying vec4 vMtn;
void main() {
  vMtn = aMtn;
  vN = normal;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWp = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
${ATMOS_GLSL}
${U('vec3', 'uAmbK')}${U('float', 'uNight')}
uniform float uHaze[4];
uniform vec4 uInk;       // ridge ink, valley mist, snow amount, alpenglow gain
varying vec3 vWp; varying vec3 vN; varying vec4 vMtn;
void main() {
  vec3 N = normalize(vN);
  float rel = clamp(vMtn.x, 0.0, 1.0);      // 0 at the foot … 1 on the local ridge line
  float relG = clamp(vMtn.w, 0.0, 1.0);     // height within the whole range
  int li = int(vMtn.y + 0.5);
  float haze0 = uHaze[li];
  vec3 rd = normalize(vWp - cameraPosition);
  // world-anchored, anisotropic 3D noise: gullies (皴) run down the slopes, never along screen columns
  vec3 wq = vWp * vec3(1.0, 0.6, 1.0);
  float gully = wx_vnoise3(wq * 0.004 + float(li) * 7.0) * 0.6 + wx_vnoise3(wq * 0.013) * 0.4;
  float rockT = smoothstep(0.45, 0.9, relG + (gully - 0.5) * 0.35);
  vec3 alb = mix(vec3(0.035, 0.05, 0.045), vec3(0.09, 0.084, 0.078), rockT);
  alb *= 0.9 + 0.2 * gully;
  // snow on the anti-solar range: caps on the summits, rock ribs showing through along the gullies
  float sn = wx_vnoise3(vWp * vec3(0.006, 0.0025, 0.006) + 3.0) * 0.65 + wx_vnoise3(vWp * vec3(0.02, 0.008, 0.02)) * 0.35;
  float snow = vMtn.z * uInk.z * smoothstep(0.7, 0.76, relG + (sn - 0.5) * 0.3 + (gully - 0.5) * 0.3) * smoothstep(0.4, 0.65, N.y + (sn - 0.5) * 0.3);
  alb = mix(alb, vec3(0.74, 0.76, 0.8), snow);
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 amb = vec3(0.30, 0.38, 0.46) * uAmbK * (0.55 + 0.45 * N.y);
  vec3 col = alb * (amb + uSunCol * ndl * 0.9);
  col += snow * uSunCol * vec3(1.0, 0.7, 0.76) * ndl * 0.12 * uInk.w;    // alpenglow on the snow
  // ink wash: toward the sun the crest is the densest ink; away from it the lit crests stay clear
  float toSun = pow(max(dot(rd, uSunDir), 0.0), 2.0);
  col *= 1.0 - uInk.x * smoothstep(0.55, 1.0, rel) * (1.0 - snow * 0.8) * (0.3 + 0.7 * toSun);
  float mistEdge = 0.42 + 0.22 * wx_vnoise(vWp.xz * 0.0011 + float(li) * 3.1) + 0.1 * wx_vnoise(vWp.xz * 0.006 + 1.5);
  float valley = (1.0 - smoothstep(mistEdge - 0.3, mistEdge + 0.12, rel)) * uInk.y;
  float haze0v = haze0 * mix(0.78, 1.08, toSun);                        // clearer air looking away from the sun
  float haze = haze0v + (1.0 - haze0v) * max(valley, (1.0 - smoothstep(0.0, 0.5, relG)) * 0.35);
  haze = min(haze + (1.0 - relG) * 0.05, 0.985);
  haze *= 1.0 - snow * 0.25;                                             // bright snow punches through the haze
  vec3 fc = wx_skyFogColor(normalize(vec3(rd.x, max(rd.y, -0.05), rd.z)));
  col = mix(col, fc, haze);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createMountains(app, { seed = WORLD.seed + 404 } = {}) {
  const geo = buildGeometry(seed);
  const material = new THREE.ShaderMaterial({
    name: 'mountains',
    uniforms: {
      ...atmosUniforms(),
      uAmbK: G.uAmbK, uNight: G.uNight,
      uHaze: { value: MOUNTAIN_LAYERS.map(l => l.haze) },
      uInk: { value: new THREE.Vector4(0.28, 0.85, 1.0, 1.0) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'mountains';
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  app.scene.add(mesh);
  return { mesh, material, layers: MOUNTAIN_LAYERS };
}
