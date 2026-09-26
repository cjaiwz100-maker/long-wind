// Materials for the town (world/town.js): timber/plaster/paper building material, stone, roof tiles, misc
// (ridges, jars, cloth, iron), street paving, canal water, paper lanterns (instanced, swaying) and the painted sign /
// banner atlas. Plus the town light map: a baked 2-D field of lantern + shop-front light that every town material
// adds as warm diffuse irradiance (the 8 shader lamps only cover the few key lanterns). Owner: world (W).
//
//   G.tTownLight / G.uTownRect / G.uTownLightCol   shared uniforms (attached here; other modules may sample them:
//                                                  irradiance = uTownLightCol * texture(tTownLight, (xz - rect.xy) * rect.zw).r)
import * as THREE from 'three';
import { G } from '../core/globals.js';
import { U } from '../core/glsl.js';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { WIND_GLSL, windUniforms } from '../core/wind.js';
import { GROUND_GLSL } from './ground-glsl.js';

G.tTownLight ??= { value: null };
G.uTownRect ??= { value: new THREE.Vector4(-140, -70, 1 / 280, 1 / 140) };
G.uTownLightCol ??= { value: new THREE.Color(1.0, 0.46, 0.17) };

// ------------------------------------------------------------------------------------------------ town light
export const TOWN_LIGHT_GLSL = /* glsl */`
${GROUND_GLSL}
${U('sampler2D', 'tTownLight')}${U('vec4', 'uTownRect')}${U('vec3', 'uTownLightCol')}
// warm lantern / shop-front irradiance at world point wp with world normal nW (baked 2-D field, height-shaped)
vec3 town_light(vec3 wp, vec3 nW) {
  vec2 uv = (wp.xz - uTownRect.xy) * uTownRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
  float L = texture2D(tTownLight, uv).r;
  if (L < 0.002) return vec3(0.0);
#ifdef TW_ON_GROUND
  float y = 0.04;
#else
  float y = wp.y - wt_groundHeight(wp.xz);
#endif
  float g = (1.0 + 1.2 * exp(-(y - 3.2) * (y - 3.2) * 0.45)) * smoothstep(10.0, 5.0, y);
  float s = y < 3.2 ? 1.0 : -1.0;
  float nf = clamp(0.62 + 0.8 * nW.y * s, 0.0, 1.0);
  return uTownLightCol * (L * g * nf);
}
`;
const TOWN_LIGHT_APPLY = /* glsl */`
#include <lights_fragment_end>
{
  vec3 tlN = inverseTransformDirection(normal, viewMatrix);
  reflectedLight.indirectDiffuse += material.diffuseColor * town_light(vWxWorldPos, tlN);
}
`;
function addTownLight(sh, onGround = false) {
  sh.fragmentShader = sh.fragmentShader
    .replace('void main() {', (onGround ? '#define TW_ON_GROUND\n' : '') + TOWN_LIGHT_GLSL + '\nvoid main() {')
    .replace('#include <lights_fragment_end>', TOWN_LIGHT_APPLY);
}

/** Bake the light field: sources [{x, z, h, i}] (h = height above ground, i = intensity). */
export function bakeTownLight(sources, rect = { x0: -140, z0: -70, w: 280, d: 140 }, res = 0.5) {
  const W = Math.round(rect.w / res), H = Math.round(rect.d / res);
  const f = new Float32Array(W * H);
  const R = 9;
  for (const s of sources) {
    const i0 = Math.max(0, Math.floor((s.x - R - rect.x0) / res)), i1 = Math.min(W - 1, Math.ceil((s.x + R - rect.x0) / res));
    const j0 = Math.max(0, Math.floor((s.z - R - rect.z0) / res)), j1 = Math.min(H - 1, Math.ceil((s.z + R - rect.z0) / res));
    const h2 = s.h * s.h;
    for (let j = j0; j <= j1; j++) {
      const dz = rect.z0 + (j + 0.5) * res - s.z;
      for (let i = i0; i <= i1; i++) {
        const dx = rect.x0 + (i + 0.5) * res - s.x, d2 = dx * dx + dz * dz;
        if (d2 > R * R) continue;
        const k = 1 - Math.sqrt(d2) / R;
        f[j * W + i] += s.i / (d2 + h2) * k * k;
      }
    }
  }
  const half = new Uint16Array(W * H);
  for (let k = 0; k < f.length; k++) half[k] = THREE.DataUtils.toHalfFloat(Math.min(f[k], 60));
  const tex = new THREE.DataTexture(half, W, H, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  G.tTownLight.value = tex;
  G.uTownRect.value.set(rect.x0, rect.z0, 1 / rect.w, 1 / rect.d);
  return tex;
}

// ------------------------------------------------------------------------------------------------ atlas (canvas)
export const ATLAS_SIZE = 2048;
export const ATLAS = {};
{
  for (let i = 0; i < 12; i++) ATLAS['banner' + i] = [i * 170, 0, 170, 640];
  for (let i = 0; i < 4; i++) ATLAS['plaque' + i] = [i * 512, 640, 512, 256];
  for (let i = 0; i < 8; i++) ATLAS['sign' + i] = [(i % 4) * 512, 896 + Math.floor(i / 4) * 128, 512, 128];
  for (let i = 0; i < 8; i++) ATLAS['cloth' + i] = [i * 256, 1152, 256, 256];
  for (let i = 0; i < 8; i++) ATLAS['lchar' + i] = [i * 256, 1408, 256, 256];
  ATLAS.backdrop = [0, 1664, 1024, 384];
  ATLAS.door0 = [1024, 1664, 256, 384];
  ATLAS.door1 = [1280, 1664, 256, 384];
  ATLAS.valance = [1536, 1664, 512, 192];
  ATLAS.curtain = [1536, 1856, 512, 192];
}
/** [u0, v0, u1, v1] of an atlas region (v0 = bottom), with a half-texel inset. */
export function atlasUV(name) {
  const [x, y, w, h] = ATLAS[name], S = ATLAS_SIZE, e = 1.5;
  return [(x + e) / S, 1 - (y + h - e) / S, (x + w - e) / S, 1 - (y + e) / S];
}

export const BANNERS = [
  { t: '酒', bg: '#e6d8b8', fg: '#1b120c', edge: '#8c1c14' },
  { t: '茶', bg: '#27384f', fg: '#efe6cf', edge: '#d8c690' },
  { t: '藥', bg: '#ddd0ae', fg: '#15213a', edge: '#27384f' },
  { t: '當', bg: '#171310', fg: '#e8d7a8', edge: '#a4262a' },
  { t: '米', bg: '#b88834', fg: '#1a130b', edge: '#5c3a12' },
  { t: '布', bg: '#314a66', fg: '#f2ead5', edge: '#f2ead5' },
  { t: '麵', bg: '#e8dcc0', fg: '#8c1c14', edge: '#1b120c' },
  { t: '客棧', bg: '#8c1c14', fg: '#f0d488', edge: '#f0d488' },
  { t: '油', bg: '#ded2b0', fg: '#1b120c', edge: '#b88834' },
  { t: '糕', bg: '#a3262a', fg: '#fbeccd', edge: '#fbeccd' },
];
export const COUPLET = ['一曲長風吹古渡', '滿街燈火照歸人'];
export const PLAQUES = ['長街燈火', '風物清嘉', '聲遏行雲', '長風古鎮'];
export const SIGNS = ['陳記茶莊', '萬和酒家', '回春堂', '錦繡綢莊', '德昌米行', '聚福樓', '清風客棧', '老街麵館'];
export const LCHARS = ['福', '喜', '酒', '茶', '吉', '春', '壽', '燈'];

const FONT = '"STKaiti", "Kaiti SC", "KaiTi", "BiauKai", "Songti SC", "STSong", "Noto Serif CJK SC", serif';

export function buildAtlas() {
  const S = ATLAS_SIZE;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  const rng = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const grain = (x, y, w, h, a = 0.08, n = 900) => {   // cloth / wood grain speckle
    for (let i = 0; i < n; i++) {
      g.fillStyle = rng() < 0.5 ? `rgba(0,0,0,${a * rng()})` : `rgba(255,255,255,${a * 0.6 * rng()})`;
      g.fillRect(x + rng() * w, y + rng() * h, 1 + rng() * 3, 1 + rng() * 10);
    }
  };
  const text = (s, cx, cy, size, color, { vertical = false, gap = 1.0, stroke = null, weight = 'bold' } = {}) => {
    g.font = `${weight} ${size}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const chars = [...s];
    chars.forEach((ch, k) => {
      const off = (k - (chars.length - 1) / 2) * size * gap;
      const x = vertical ? cx : cx + off, y = vertical ? cy + off : cy;
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = size * 0.08; g.strokeText(ch, x, y); }
      g.fillStyle = color; g.fillText(ch, x, y);
    });
  };
  // --- vertical shop banners 招幌 (dog-tooth tails cut into alpha)
  BANNERS.forEach((b, i) => {
    const [x, y, w, h] = ATLAS['banner' + i];
    const tail = 70;
    g.save();
    g.beginPath();
    g.moveTo(x + 6, y); g.lineTo(x + w - 6, y); g.lineTo(x + w - 6, y + h - tail);
    const teeth = 3;
    for (let k = 0; k < teeth; k++) {
      const x0 = x + w - 6 - (k * (w - 12)) / teeth, x1 = x + w - 6 - ((k + 1) * (w - 12)) / teeth;
      g.lineTo((x0 + x1) / 2, y + h - 4); g.lineTo(x1, y + h - tail);
    }
    g.closePath(); g.clip();
    g.fillStyle = b.bg; g.fillRect(x, y, w, h);
    grain(x, y, w, h, 0.07, 700);
    g.fillStyle = b.edge; g.fillRect(x + 6, y, w - 12, 34); g.fillRect(x + 6, y + h - tail - 22, w - 12, 12);
    g.fillRect(x + 6, y, 12, h); g.fillRect(x + w - 18, y, 12, h);
    const n = [...b.t].length;
    text(b.t, x + w / 2, y + 34 + (h - tail - 56) / 2, n > 1 ? 104 : 128, b.fg, { vertical: true, gap: 1.1 });
    g.restore();
  });
  // couplets on red boards (banner10/11), gold
  COUPLET.forEach((s, k) => {
    const [x, y, w, h] = ATLAS['banner' + (10 + k)];
    g.fillStyle = '#6e120e'; g.fillRect(x, y, w, h);
    grain(x, y, w, h, 0.05, 400);
    g.strokeStyle = '#c9a24c'; g.lineWidth = 6; g.strokeRect(x + 10, y + 10, w - 20, h - 20);
    text(s, x + w / 2, y + h / 2, 76, '#e8c36a', { vertical: true, gap: 1.08 });
  });
  // --- plaques 匾 (paifang, stage): lacquer field, carved gilt frame
  PLAQUES.forEach((s, i) => {
    const [x, y, w, h] = ATLAS['plaque' + i];
    const bg = i === 2 ? '#20120c' : '#17302f';
    g.fillStyle = '#7a5520'; g.fillRect(x, y, w, h);
    g.fillStyle = '#c99a44'; g.fillRect(x + 8, y + 8, w - 16, h - 16);
    g.fillStyle = bg; g.fillRect(x + 26, y + 26, w - 52, h - 52);
    grain(x + 26, y + 26, w - 52, h - 52, 0.05, 300);
    text(s, x + w / 2, y + h / 2 + 4, 104, '#e9c56c', { gap: 1.08, stroke: '#5a3b10' });
  });
  // --- shop signboards 招牌: black lacquer + gold, or plain wood + black ink
  SIGNS.forEach((s, i) => {
    const [x, y, w, h] = ATLAS['sign' + i];
    const lacquer = i % 3 !== 2;
    g.fillStyle = lacquer ? '#140f0b' : '#8a6a44'; g.fillRect(x, y, w, h);
    grain(x, y, w, h, lacquer ? 0.05 : 0.12, 500);
    g.strokeStyle = lacquer ? '#b38a3e' : '#3a2616'; g.lineWidth = 6; g.strokeRect(x + 7, y + 7, w - 14, h - 14);
    const n = [...s].length;
    text(s, x + w / 2, y + h / 2 + 3, n > 3 ? 84 : 92, lacquer ? '#e4bf66' : '#17100a', { gap: n > 3 ? 1.12 : 1.4 });
  });
  // --- cloth patterns (stall awnings, curtains)
  const cloths = [
    () => { stripes(['#8c1c14', '#e6dcc4'], 32); },
    () => { fill('#28405e'); dots('#e9e4d4'); },
    () => { fill('#b8862e'); },
    () => { stripes(['#26364c', '#dcd5c2'], 24); },
    () => { fill('#d9cfb4'); },
    () => { fill('#6c1712'); },
    () => { fill('#3b4a3a'); },
    () => { stripes(['#a0342a', '#c9a24c'], 20); },
  ];
  let cx0 = 0, cy0 = 0;
  function fill(c) { g.fillStyle = c; g.fillRect(cx0, cy0, 256, 256); }
  function stripes(cs, wd) { for (let k = 0; k * wd < 256; k++) { g.fillStyle = cs[k % cs.length]; g.fillRect(cx0 + k * wd, cy0, wd, 256); } }
  function dots(c) { g.fillStyle = c; for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) { g.beginPath(); g.arc(cx0 + 16 + a * 32, cy0 + 16 + b * 32 + (a % 2) * 8, 5, 0, 7); g.fill(); } }
  cloths.forEach((f, i) => { [cx0, cy0] = ATLAS['cloth' + i]; f(); grain(cx0, cy0, 256, 256, 0.08, 500); });
  // --- lantern characters (black ink on transparent)
  LCHARS.forEach((c, i) => {
    const [x, y, w, h] = ATLAS['lchar' + i];
    text(c, x + w / 2, y + h / 2 + 6, 200, '#0c0806', { weight: 'bold' });
  });
  // --- stage backdrop 守舊: crimson brocade, gold border, central medallion with cloud scrolls
  {
    const [x, y, w, h] = ATLAS.backdrop;
    g.fillStyle = '#6a0f0c'; g.fillRect(x, y, w, h);
    grain(x, y, w, h, 0.06, 1500);
    g.strokeStyle = '#c9a24c'; g.lineWidth = 14; g.strokeRect(x + 14, y + 14, w - 28, h - 28);
    g.lineWidth = 4; g.strokeRect(x + 34, y + 34, w - 68, h - 68);
    const cx = x + w / 2, cy = y + h / 2;
    g.strokeStyle = '#d8b35a';
    for (const r of [120, 104, 60]) { g.lineWidth = r === 104 ? 3 : 8; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke(); }
    const scroll = (sx, sy, s, dir) => {
      g.lineWidth = 6; g.beginPath();
      for (let t = 0; t < 14; t += 0.1) { const r = s * (1 - t / 16), a = t * dir; const px = sx + Math.cos(a) * r * 0.3 * t / 2, py = sy + Math.sin(a) * r * 0.3 * t / 2; t === 0 ? g.moveTo(px, py) : g.lineTo(px, py); }
      g.stroke();
    };
    for (let k = 0; k < 6; k++) { scroll(x + 150 + k * 30, y + 120 + (k % 2) * 140, 22, k % 2 ? 1 : -1); scroll(x + w - 150 - k * 30, y + 120 + (k % 2) * 140, 22, k % 2 ? -1 : 1); }
    text('福', cx, cy + 6, 110, '#e9c56c');
  }
  ['出將', '入相'].forEach((s, k) => {
    const [x, y, w, h] = ATLAS['door' + k];
    g.fillStyle = '#7d1712'; g.fillRect(x, y, w, h);
    grain(x, y, w, h, 0.07, 500);
    g.fillStyle = '#c9a24c'; g.fillRect(x, y, w, 26);
    text(s, x + w / 2, y + h / 2, 92, '#ebc774', { vertical: true, gap: 1.2 });
  });
  // valance: scalloped red swags with gold fringe (alpha scallops)
  {
    const [x, y, w, h] = ATLAS.valance;
    g.save(); g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.lineTo(x + w, y + 90);
    const n = 4;
    for (let k = n; k > 0; k--) { const xa = x + (k * w) / n, xb = x + ((k - 1) * w) / n; g.quadraticCurveTo((xa + xb) / 2, y + h + 40, xb, y + 90); }
    g.closePath(); g.clip();
    g.fillStyle = '#8a1510'; g.fillRect(x, y, w, h);
    for (let k = 0; k < n; k++) { const gr = g.createRadialGradient(x + (k + 0.5) * w / n, y + 40, 10, x + (k + 0.5) * w / n, y + 60, 120); gr.addColorStop(0, 'rgba(255,120,90,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0.25)'); g.fillStyle = gr; g.fillRect(x + k * w / n, y, w / n, h); }
    g.fillStyle = '#c9a24c'; g.fillRect(x, y, w, 18);
    g.restore();
  }
  {
    const [x, y, w, h] = ATLAS.curtain;
    for (let k = 0; k < w; k += 4) { const f = 0.75 + 0.25 * Math.sin(k * 0.11); g.fillStyle = `rgb(${Math.round(130 * f)},${Math.round(20 * f)},${Math.round(16 * f)})`; g.fillRect(x + k, y, 4, h); }
    grain(x, y, w, h, 0.05, 300);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// ------------------------------------------------------------------------------------------------ building
// aP.x part: 0 dark timber · 1 weathered boards · 2 white plaster · 3 red lacquer · 4 paper lattice window
// (lit when seed > 0.42) · 5 lit shop interior · 6 rope / iron · 7 blue-green painted beam · 8 gilt carving ·
// 9 dark interior · 10 shutter boards 排門板 · 11 lattice window, never lit
const BUILDING_FRAG = /* glsl */`
{
  vec3 wp = vWxWorldPos;
  vec2 uvm = vTwUv;                                   // metres
  int part = int(vTwP.x + 0.5);
  float sd = vTwP.y;
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float n1 = wx_vnoise(wp.xz * 0.7 + wp.y * 0.9 + sd * 17.0);
  vec3 c = vec3(0.1);
  twRough = 0.8;
  if (part == 0) {                                     // dark lacquered timber, rubbed lighter at edges
    c = vec3(0.052, 0.03, 0.019) * (0.55 + 1.4 * lum) * (0.85 + 0.3 * sd);
    twRough = 0.55;
  } else if (part == 1 || part == 10) {                // boards: warm grey-brown weathered wood + seams
    float seam = part == 10 ? 0.26 : 0.22;
    float sx = abs(fract(uvm.x / seam + sd * 3.0) - 0.5);
    c = diffuseColor.rgb * vec3(0.62, 0.5, 0.4) * (part == 10 ? 0.62 : 0.85) * (0.8 + 0.4 * sd);
    c *= 1.0 - 0.55 * smoothstep(0.43, 0.49, sx);
    twRough = 0.82;
  } else if (part == 2) {                              // lime plaster: off-white, rain streaks, damp grey foot
    float streak = wx_vnoise(vec2(uvm.x * 5.0 + sd * 40.0, uvm.y * 0.35));
    float blot = wx_vnoise(uvm * 0.8 + sd * 9.0) * 0.6 + wx_vnoise(uvm * 3.1) * 0.4;
    c = vec3(0.56, 0.55, 0.52) * (0.88 + 0.14 * sd);
    c *= 1.0 - 0.34 * smoothstep(0.5, 0.9, streak) * smoothstep(0.3, 2.5, uvm.y);
    c *= 1.0 - 0.3 * smoothstep(0.45, 0.85, blot);
    c = mix(c, c * vec3(0.8, 0.84, 0.78), smoothstep(0.6, 0.8, wx_vnoise(uvm * 0.35 + 3.0)));
    c = mix(c, vec3(0.2, 0.2, 0.18), (1.0 - smoothstep(0.0, 0.9 + 0.5 * blot, uvm.y)) * 0.65);   // damp foot
    twRough = 0.95; twFlat = 1.0;
  } else if (part == 3) {                              // vermilion lacquer, worn
    c = mix(vec3(0.3, 0.04, 0.025), vec3(0.16, 0.05, 0.03), smoothstep(0.55, 0.8, n1));
    twRough = 0.5;
  } else if (part == 4 || part == 11) {                // paper lattice (step-fret or square grid)
    vec2 q = uvm / (sd > 0.7 ? 0.11 : 0.14);
    vec2 f = abs(fract(q) - 0.5);
    float bar = max(smoothstep(0.36, 0.42, f.x), smoothstep(0.36, 0.42, f.y));
    if (sd > 0.7) bar = max(bar, smoothstep(0.38, 0.44, abs(fract(q.x * 0.5 + q.y * 0.5) - 0.5)) * 0.8);
    bool lit = part == 4 && sd > 0.42;
    float flick = 0.9 + 0.1 * sin(uTime * (2.0 + sd * 3.0) + sd * 40.0);
    vec3 paper = lit ? vec3(0.4, 0.33, 0.24) : vec3(0.22, 0.2, 0.17);
    c = mix(paper, vec3(0.03, 0.02, 0.014), bar);
    if (lit) twEmis = vec3(1.0, 0.6, 0.3) * (0.9 + 1.0 * fract(sd * 7.3)) * flick * (1.0 - bar) * (0.75 + 0.5 * wx_vnoise(uvm * 1.3 + sd * 5.0));
    twRough = 0.9; twFlat = 1.0;
  } else if (part == 5) {                              // lit shop interior: dim lamp-warm room, shelves + wares in silhouette
    float h = uvm.y;
    float band = 0.0;
    for (int k = 0; k < 3; k++) {
      float y0 = 1.05 + float(k) * 0.62;
      band = max(band, step(y0, h) * step(h, y0 + 0.05));
      float w = wx_vnoise(vec2(uvm.x * 4.5 + sd * 31.0 + float(k) * 7.0, float(k)));
      float top = y0 + 0.08 + 0.34 * w;
      band = max(band, step(y0 + 0.05, h) * step(h, top) * step(0.45, w) * 0.85);
    }
    float counterZone = 1.0 - smoothstep(0.7, 1.0, h);
    c = vec3(0.06, 0.04, 0.028);
    float lamp = exp(-pow(h - 2.35, 2.0) * 0.9) * (0.7 + 0.6 * wx_vnoise(vec2(uvm.x * 0.8 + sd * 5.0, 1.0)));
    float glow = (0.1 + 0.55 * lamp) * (0.6 + 0.5 * sd);
    twEmis = vec3(1.0, 0.46, 0.17) * glow * (1.0 - 0.9 * band) * (1.0 - 0.7 * counterZone);
    twRough = 0.9; twFlat = 1.0;
  } else if (part == 6) {
    c = vec3(0.025, 0.022, 0.02); twRough = 0.7;
  } else if (part == 7) {                              // blue-green painted beams with gilt edge lines
    float e = abs(fract(uvm.y * 3.0) - 0.5);
    c = mix(vec3(0.03, 0.075, 0.07), vec3(0.3, 0.2, 0.06), smoothstep(0.42, 0.47, e));
    c = mix(c, vec3(0.1, 0.03, 0.02), step(0.6, wx_vnoise(uvm * 2.0)) * 0.4);
    twRough = 0.55;
  } else if (part == 8) {
    c = vec3(0.42, 0.27, 0.07) * (0.7 + 0.5 * lum); twRough = 0.38;
  } else {
    c = vec3(0.012, 0.01, 0.009); twRough = 0.95;
  }
  diffuseColor.rgb = c;
}
`;

function vtxP(sh) {
  sh.vertexShader = sh.vertexShader
    .replace('void main() {', 'attribute vec2 aP;\nvarying vec2 vTwP;\nvarying vec2 vTwUv;\nvoid main() {\nvTwP = aP; vTwUv = uv;');
  sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'varying vec2 vTwP;\nvarying vec2 vTwUv;\nvoid main() {');
}

function stdMat(name, set, extra = {}) {
  const m = new THREE.MeshStandardMaterial({
    name, map: set?.map || null, normalMap: set?.normalMap || null, roughnessMap: set?.armMap || null, roughness: 1, metalness: 0, ...extra,
  });
  return m;
}

export function createBuildingMaterial(woodSet) {
  const m = stdMat('town:building', { map: woodSet?.map });
  patchMaterial(m, { wetBias: -0.22 });           // under the eaves: walls stay drier than the street
  addShaderHook(m, 'twBuilding', (sh) => {
    vtxP(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'void main() {\nfloat twRough = 0.8; float twFlat = 0.0; vec3 twEmis = vec3(0.0);')
      .replace('#include <map_fragment>', 'diffuseColor *= texture2D(map, vMapUv * 0.45);\n' + BUILDING_FRAG)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = twRough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += twEmis;');
    addTownLight(sh);
  });
  return m;
}

// ------------------------------------------------------------------------------------------------ stone
// aP.x: 0 grey stone · 1 canal embankment (tide line, algae) · 2 pale granite (bridge, paifang, stage) · 3 dark kerb
const STONE_FRAG = /* glsl */`
{
  vec3 wp = vWxWorldPos;
  int part = int(vTwP.x + 0.5);
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 c = mix(diffuseColor.rgb, lum * vec3(0.86, 0.93, 1.02), 0.6);      // blue-grey 青石
  if (part == 2) c *= vec3(1.18, 1.15, 1.08);
  if (part == 3) c *= 0.55;
  c *= 0.85 + 0.3 * wx_vnoise(wp.xz * 0.4 + wp.y * 0.3);
  if (part == 1) {
    float wl = wp.y - uTwWater;
    c = mix(c, c * vec3(0.45, 0.5, 0.38), 1.0 - smoothstep(-0.1, 0.45 + 0.25 * wx_vnoise(wp.xz * 2.0 + wp.y), wl));   // tide stain
    c = mix(c, vec3(0.03, 0.045, 0.03), 1.0 - smoothstep(-0.3, 0.05, wl));
    twWetK = 1.0 - smoothstep(0.0, 0.35, wl);
  }
  diffuseColor.rgb = c;
}
`;
export function createStoneMaterial(stoneSet, waterY) {
  const m = stdMat('town:stone', stoneSet);
  if (stoneSet?.map) m.color.setScalar(0.9);
  patchMaterial(m);
  m.userData.uTwWater = { value: waterY };
  addShaderHook(m, 'twStone', (sh) => {
    vtxP(sh);
    sh.uniforms.uTwWater = m.userData.uTwWater;
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform float uTwWater;\nvoid main() {\nfloat twWetK = 0.0;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + STONE_FRAG)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.25, twWetK);');
    addTownLight(sh);
  });
  return m;
}

// ------------------------------------------------------------------------------------------------ roof tiles
const TILE_FRAG = /* glsl */`
{
  vec3 wp = vWxWorldPos;
  int part = int(vTwP.x + 0.5);
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float moss = smoothstep(0.0, 0.04, diffuseColor.g - diffuseColor.r * 0.95);
  vec3 c = lum * vec3(0.5, 0.54, 0.6) * 0.62;                           // fired grey-black 青瓦
  c = mix(c, lum * vec3(0.55, 0.6, 0.38), moss * 0.35);
  c *= 0.75 + 0.5 * wx_vnoise(wp.xz * 0.6 + vTwP.y * 13.0);
  if (part == 1) c = vec3(0.028, 0.03, 0.032) * (0.8 + 0.4 * wx_vnoise(wp.xz * 3.0));
  diffuseColor.rgb = c;
}
`;
export function createTileMaterial(tileSet) {
  const m = stdMat('town:tiles', { map: tileSet?.map });
  m.roughness = 0.62;
  patchMaterial(m, { wetBias: 0.25 });
  addShaderHook(m, 'twTiles', (sh) => {
    vtxP(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + TILE_FRAG);
  });
  return m;
}

// ------------------------------------------------------------------------------------------------ misc (untextured)
// aP.x: 0 ridge ceramic · 1 glazed jar · 2 red cloth / paper seal · 3 wicker · 4 iron · 5 gilt · 6 rope · 7 lime white ·
// 8 boat wood (dark tarred) · 9 black awning (乌篷)
const MISC_FRAG = /* glsl */`
{
  vec3 wp = vWxWorldPos;
  int part = int(vTwP.x + 0.5);
  float n = wx_vnoise(wp.xz * 3.0 + wp.y * 2.0 + vTwP.y * 11.0);
  vec3 c; float r;
  if (part == 0) { c = vec3(0.04, 0.042, 0.045) * (0.8 + 0.4 * n); r = 0.6; }
  else if (part == 1) { c = mix(vec3(0.05, 0.028, 0.015), vec3(0.11, 0.06, 0.03), n) * (0.7 + 0.6 * vTwP.y); r = 0.22; }
  else if (part == 2) { c = vec3(0.3, 0.035, 0.022) * (0.8 + 0.3 * n); r = 0.85; }
  else if (part == 3) { float w = abs(fract(vTwUv.x * 14.0) - 0.5) + abs(fract(vTwUv.y * 10.0) - 0.5); c = vec3(0.24, 0.16, 0.07) * (0.6 + 0.6 * w); r = 0.9; }
  else if (part == 4) { c = vec3(0.022, 0.02, 0.02); r = 0.5; }
  else if (part == 5) { c = vec3(0.5, 0.33, 0.09) * (0.8 + 0.3 * n); r = 0.35; }
  else if (part == 6) { c = vec3(0.06, 0.045, 0.03); r = 0.9; }
  else if (part == 7) { c = vec3(0.5, 0.49, 0.46) * (0.85 + 0.2 * n); r = 0.9; }
  else if (part == 8) { c = vec3(0.045, 0.03, 0.02) * (0.8 + 0.4 * n); r = 0.5; }
  else { c = vec3(0.02, 0.018, 0.016) * (0.8 + 0.4 * n); r = 0.75; }
  diffuseColor.rgb = c; twRough = r;
}
`;
export function createMiscMaterial() {
  const m = new THREE.MeshStandardMaterial({ name: 'town:misc', color: 0xffffff, roughness: 0.7, metalness: 0 });
  patchMaterial(m);
  addShaderHook(m, 'twMisc', (sh) => {
    vtxP(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'void main() {\nfloat twRough = 0.7;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + MISC_FRAG)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = twRough;');
    addTownLight(sh);
  });
  return m;
}

// ------------------------------------------------------------------------------------------------ signs / cloth
// aP.x = flutter weight (0 rigid … 1 free end), aP.y = phase
const SIGN_VERT = /* glsl */`
{
  float fw = aP.x;
  if (fw > 0.0) {
    vec3 wpS = (modelMatrix * vec4(transformed, 1.0)).xyz;
    float g = windGust(wpS);
    float ph = aP.y;
    vec3 dw = vec3(uWind.x, 0.0, uWind.y);
    float flap = sin(uTime * 3.1 + ph * 6.0 - fw * 3.5) * 0.09 + sin(uTime * 5.7 + ph * 3.0 - fw * 6.0) * 0.035;
    transformed += (dw * (0.1 + 0.22 * g) * uWind.z + normal * flap * (0.6 + g)) * fw * fw;
  }
}
`;
export function createSignMaterial(atlas) {
  const m = new THREE.MeshStandardMaterial({ name: 'town:signs', map: atlas, roughness: 0.85, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide });
  patchMaterial(m);
  addShaderHook(m, 'twSigns', (sh) => {
    Object.assign(sh.uniforms, windUniforms());
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'attribute vec2 aP;\nvarying float vOneSide;\n' + WIND_GLSL + '\nvoid main() {\nvOneSide = step(99.0, aP.y);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + SIGN_VERT);
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'varying float vOneSide;\nvoid main() {\nif (vOneSide > 0.5 && !gl_FrontFacing) discard;');
    // thin cloth: warm lantern light shines through a little
    addTownLight(sh);
  });
  return m;
}

// ------------------------------------------------------------------------------------------------ paving
const PAVE_FRAG = /* glsl */`
lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
{
  vec3 wp = vWxWorldPos;
  vec2 xz = wp.xz;
  vec3 c = lum * vec3(0.8, 0.88, 0.98) * 1.05;                         // blue-grey 青石板
  float groove = 0.0;
  float br = step(abs(xz.x - uTwBridge.x), uTwBridge.y) * step(abs(xz.y), 4.6);
  // street centre band: long granite slabs 條石 laid across the street (outside the plaza, off the bridge)
  float band = step(abs(xz.y), 1.05) * step(uTwPlaza.x, abs(xz.x - uTwPlaza.z)) * (1.0 - br);
  if (band > 0.5) {
    float k = floor(xz.x / 0.46);
    float fx = abs(fract(xz.x / 0.46) - 0.5);
    float h = wx_hash12(vec2(k, 3.0));
    vec2 suv = vec2(fract(xz.x / 0.46) * 0.46 + h * 7.0, xz.y + h * 3.0);
    vec3 s2 = texture2D(map, suv * 0.33).rgb;
    c = dot(s2, vec3(0.2126, 0.7152, 0.0722)) * vec3(0.9, 0.93, 0.98) * (0.75 + 0.45 * h);
    groove = smoothstep(0.44, 0.49, fx) + smoothstep(0.96, 1.03, abs(xz.y)) ;
  }
  // bridge: stepped slabs across the arch (dark riser line + worn nosing)
  if (br > 0.5) {
    float u = abs(xz.x - uTwBridge.x) / 0.42;
    float fx = fract(u), st = floor(u);
    float qz = xz.y / 1.3 + 0.5 * mod(st, 2.0);
    float h = wx_hash12(vec2(st, floor(qz)) + 7.0);
    vec3 s2 = texture2D(map, vec2(fx * 0.42 + h * 3.0, fract(qz) * 1.3) * 0.4).rgb;
    c = dot(s2, vec3(0.2126, 0.7152, 0.0722)) * vec3(0.92, 0.95, 1.0) * (0.8 + 0.35 * h);
    c *= 0.45 + 0.55 * smoothstep(0.0, 0.22, 1.0 - fx);                 // riser shadow on the uphill side
    groove = max(groove, max(1.0 - smoothstep(0.0, 0.06, 1.0 - fx), smoothstep(0.46, 0.5, abs(fract(qz) - 0.5))));
  }
  // plaza: running-bond granite slabs 1.2 × 0.6 m, a ring of dark stones round the centre
  if (abs(xz.x - uTwPlaza.z) < uTwPlaza.x - 4.0 && abs(xz.y - uTwPlaza.w) < uTwPlaza.y) {
    vec2 q = xz - uTwPlaza.zw;
    float row = floor(q.y / 0.6);
    float qx = q.x / 1.2 + 0.5 * mod(row, 2.0);
    vec2 cell = vec2(floor(qx), row);
    vec2 f = vec2(fract(qx), fract(q.y / 0.6));
    float h = wx_hash12(cell + 11.0);
    vec3 s2 = texture2D(map, (vec2(f.x * 1.2, f.y * 0.6) + h * 5.0) * 0.4).rgb;
    c = dot(s2, vec3(0.2126, 0.7152, 0.0722)) * vec3(0.84, 0.9, 0.98) * (0.78 + 0.4 * h);
    float r = length(q);
    c *= 1.0 - 0.35 * step(4.2, r) * step(r, 4.9) - 0.2 * step(0.0, r) * step(r, 0.9);
    groove = max(groove, max(smoothstep(0.46, 0.5, abs(f.x - 0.5)), smoothstep(0.44, 0.5, abs(f.y - 0.5))));
    groove = max(groove, smoothstep(0.035, 0.0, abs(r - 4.2)) + smoothstep(0.035, 0.0, abs(r - 4.9)));
  }
  // gutters 陰溝 along the facades: darker kerb stones
  float gut = smoothstep(4.35, 4.55, abs(xz.y)) * (1.0 - smoothstep(4.95, 5.1, abs(xz.y))) * step(uTwPlaza.x, abs(xz.x - uTwPlaza.z)) * (1.0 - br);
  c *= 1.0 - 0.45 * gut;
  c *= 1.0 - 0.6 * groove;
  // worn, polished traffic line, dust in the corners
  float wear = exp(-xz.y * xz.y * 0.12);
  c *= 0.85 + 0.3 * wx_vnoise(xz * 0.35) ;
  twRough = mix(0.82, 0.55, wear) + 0.2 * groove;
  diffuseColor.rgb = c;
}
`;
export function createPavingMaterial(stoneSet, { plazaW, plazaD, plazaX = 0, plazaZ = 0, bridgeX, bridgeHalf }) {
  const m = stdMat('town:paving', { map: stoneSet?.map, normalMap: stoneSet?.normalMap });
  patchMaterial(m, { wetBias: 0.05 });
  const uPlaza = { value: new THREE.Vector4(plazaW / 2, plazaD / 2, plazaX, plazaZ) };
  const uBridge = { value: new THREE.Vector2(bridgeX, bridgeHalf) };
  addShaderHook(m, 'twPave', (sh) => {
    sh.uniforms.uTwPlaza = uPlaza; sh.uniforms.uTwBridge = uBridge;
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform vec4 uTwPlaza;\nuniform vec2 uTwBridge;\nvoid main() {\nfloat twRough = 0.8; float lum = 0.2;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + PAVE_FRAG)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = twRough * (0.85 + 0.3 * lum);');
    addTownLight(sh, true);
  });
  return m;
}

// ------------------------------------------------------------------------------------------------ water
const WATER_PARS = /* glsl */`
${U('sampler2D', 'tSceneCopy')}
uniform mat4 projectionMatrix;
float twH(vec2 p) {
  vec2 q = p + vec2(0.0, uTime * 0.18);
  return wx_vnoise(q * vec2(0.9, 0.45)) * 0.55 + wx_vnoise(q * vec2(2.1, 1.3) + vec2(uTime * 0.2, 0.0)) * 0.3 + wx_vnoise(q * 5.0 - uTime * 0.35) * 0.15;
}
vec4 tw_ssr(vec3 P, vec3 R) {
  float t = 0.25;
  vec4 last = vec4(0.0);
  for (int i = 0; i < 14; i++) {
    vec3 Q = P + R * t;
    vec4 c = projectionMatrix * (viewMatrix * vec4(Q, 1.0));
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0) return vec4(0.0);
    if (uv.y > 1.0) break;
    vec4 sc = texture2D(tSceneCopy, uv);
    if (sc.a > 0.0 && sc.a < c.w && c.w - sc.a < max(t * 0.5, 0.4)) {
      float edge = smoothstep(0.0, 0.08, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
      return vec4(sc.rgb, edge);
    }
    last = sc;
    t *= 1.45;
  }
  return vec4(last.rgb, last.a > 0.0 ? (1.0 - smoothstep(40.0, 120.0, last.a)) * 0.8 : 0.0);
}
`;
const WATER_NORMAL = /* glsl */`
{
  vec2 p = vWxWorldPos.xz;
  float e = 0.06;
  float h0 = twH(p), hx = twH(p + vec2(e, 0.0)), hz = twH(p + vec2(0.0, e));
  float k = 0.022 * (0.6 + 0.6 * uWind.z);
  twNW = normalize(vec3(-(hx - h0) / e * k, 1.0, -(hz - h0) / e * k));
  normal = normalize((viewMatrix * vec4(twNW, 0.0)).xyz);
}
`;
const WATER_LIGHT = /* glsl */`
{
  vec3 V = normalize(cameraPosition - vWxWorldPos);
  vec3 R = reflect(-V, twNW); R.y = max(R.y, 0.02); R = normalize(R);
  float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(twNW, V), 0.0, 1.0), 5.0);
  vec3 sky = wx_skyFogColor(R) * F;
  reflectedLight.indirectSpecular = max(reflectedLight.indirectSpecular, sky);
  vec4 hit = tw_ssr(vWxWorldPos, R);
  reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, hit.rgb * (F * 0.9 + 0.1), hit.a);
  reflectedLight.indirectDiffuse *= 0.4;
}
`;
export function createWaterMaterial() {
  const m = new THREE.MeshStandardMaterial({ name: 'town:water', color: new THREE.Color(0.012, 0.02, 0.018), roughness: 0.06, metalness: 0 });
  patchMaterial(m);
  addShaderHook(m, 'twWater', (sh) => {
    sh.uniforms.tSceneCopy = G.tSceneCopy || (G.tSceneCopy = { value: null });
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', WATER_PARS + '\nvoid main() {\nvec3 twNW = vec3(0.0, 1.0, 0.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + WATER_NORMAL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + WATER_LIGHT);
  });
  return m;
}

// ------------------------------------------------------------------------------------------------ lanterns
// Instanced unit lantern hanging from its origin (body radius 1, height 1). aP.x: 0 body, 1 cap, 2 tassel/cord.
// aLant: x phase, y character cell (−1 none), z brightness, w height/radius (sway compensation);
// aTint: 0 red, 1 warm white paper
const LANT_VERT = /* glsl */`
{
  vec3 hp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float g = windGust(hp);
  float ph = aLant.x;
  vec2 wd = uWind.xy;
  float amp = (0.035 + 0.09 * g) * uWind.z;
  float ax = amp * (0.55 + 0.45 * sin(uTime * 1.6 + ph * 6.28));
  float ay = 0.035 * sin(uTime * 2.2 + ph * 11.0) * uWind.z;
  vec2 T = wd * ax + vec2(-wd.y, wd.x) * ay;
  vec3 c0 = normalize(instanceMatrix[0].xyz), c2 = normalize(instanceMatrix[2].xyz);
  vec3 T3 = vec3(T.x, 0.0, T.y);
  vec2 Tl = vec2(dot(T3, c0), dot(T3, c2)) * aLant.w;
  transformed.xz += -transformed.y * Tl;
  vLant = aLant; vLoc = position; vPart = aP.x; vTint = aTint;
}
`;
const LANT_FRAG = /* glsl */`
{
  vec3 V = normalize(cameraPosition - vWxWorldPos);
  vec3 N = normalize(vLNrm);
  float facing = abs(dot(N, V));
  float t = clamp((-vLoc.y - 0.14) / 0.98, 0.0, 1.0);
  float ang = atan(vLoc.z, vLoc.x);
  float line = smoothstep(0.36, 0.5, abs(fract(ang * 2.546479) - 0.5));  // 16 ribs
  vec3 red = mix(vec3(1.0, 0.1, 0.025), vec3(0.75, 0.38, 0.15), vTint);
  vec3 core = mix(vec3(1.0, 0.38, 0.09), vec3(0.85, 0.55, 0.28), vTint);
  float prof = sin(t * 3.14159);
  vec3 col = mix(red, core, clamp(pow(facing, 3.0) * prof * 0.85, 0.0, 1.0)) * (0.28 + 0.95 * pow(facing, 0.8) * (0.45 + 0.55 * prof));
  col *= 1.0 - 0.4 * line;
  col *= 1.0 - 0.75 * (1.0 - smoothstep(0.02, 0.08, t)) - 0.75 * smoothstep(0.92, 0.98, t);
  if (vLant.y >= 0.0) {
    float cell = floor(vLant.y + 0.5);
    for (int s = 0; s < 2; s++) {
      float a0 = s == 0 ? 1.5708 : -1.5708;
      float da = ang - a0; da = mod(da + 3.14159, 6.28318) - 3.14159;
      vec2 cu = vec2(-da / 1.35 + 0.5, (1.0 - t - 0.5) / 0.62 + 0.5);
      if (cu.x > 0.0 && cu.x < 1.0 && cu.y > 0.0 && cu.y < 1.0) {
        vec2 auv = vec2((cell * 256.0 + 2.0 + cu.x * 252.0) / 2048.0, 1.0 - (1408.0 + 2.0 + (1.0 - cu.y) * 252.0) / 2048.0);
        float a = texture2D(tTwAtlas, auv).a;
        col *= 1.0 - 0.88 * a;
      }
    }
  }
  float flick = 0.93 + 0.07 * sin(uTime * 9.0 + vLant.x * 30.0) * sin(uTime * 3.7 + vLant.x * 11.0);
  col *= vLant.z * flick;
  int part = int(vPart + 0.5);
  if (part == 1) col = vec3(0.05, 0.025, 0.012) + red * 0.08 * vLant.z * (1.0 - facing * 0.5);
  if (part == 2) col = red * vec3(0.5, 0.3, 0.3) * 0.18 * vLant.z;
  diffuseColor.rgb = col;
}
`;
export function createLanternMaterial(atlas) {
  const m = new THREE.MeshBasicMaterial({ name: 'town:lanterns', color: 0xffffff });
  patchMaterial(m);
  addShaderHook(m, 'twLantern', (sh) => {
    Object.assign(sh.uniforms, windUniforms());
    sh.uniforms.tTwAtlas = { value: atlas };
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'attribute vec4 aLant;\nattribute float aTint;\nattribute vec2 aP;\nvarying vec4 vLant;\nvarying vec3 vLoc;\nvarying float vPart;\nvarying float vTint;\nvarying vec3 vLNrm;\n' + WIND_GLSL + '\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + LANT_VERT)
      .replace('#include <project_vertex>', '#include <project_vertex>\nvLNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform sampler2D tTwAtlas;\nvarying vec4 vLant;\nvarying vec3 vLoc;\nvarying float vPart;\nvarying float vTint;\nvarying vec3 vLNrm;\nvoid main() {')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + LANT_FRAG);
  });
  return m;
}
