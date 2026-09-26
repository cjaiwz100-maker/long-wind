// Carved stone for the world props: the weathered stele (石碑) on its plinth, the road markers and the grave
// headstones, plus the material they share with the pavilion plaque (all mapped into ONE carve atlas → one draw
// call). Owner: world (W).
//
//   createCarvedMaterial(atlas)                          → MeshStandardMaterial (patched; procedural stone albedo)
//   steleGeometry(atlas) / plinthGeometry(atlas)         → BufferGeometry in local space (y up, base at y = 0,
//   markerGeometry(atlas, i) / headstoneGeometry(atlas, i)   front face toward +z), non-indexed, uv into the atlas
//   extrudeFace(shape, depth, bevel, frontRegion, backRegion, atlas)   generic carved slab
//
// Stone look (shader, world space so every slab differs): dark blue-grey bluestone (青石) weathered to pale grey in
// patches, ochre and white crustose lichen, vertical rain streaks, dirt in the carved recesses, faded vermilion
// pigment left in the main inscription, soil creeping up from the ground line. The plaque region is dark lacquer
// with worn gilding instead (atlas B / G channels).
import * as THREE from 'three';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { GROUND_GLSL } from './ground-glsl.js';

const STONE_PX_PER_M = 400;   // plain-stone regions are mapped metrically (atlas px per metre)

// ------------------------------------------------------------------------------------------------ material
const CARVE_PARS = /* glsl */`
${GROUND_GLSL}
uniform sampler2D tCarve;
uniform vec4 uCarveTint;   // rgb stone base (linear), w lichen amount
`;
const CARVE_ALBEDO = /* glsl */`
vec4 cvT = texture2D(tCarve, vNormalMapUv);
float cvRoughness = 0.9, cvMetal = 0.0;
{
  vec3 wp = vWxWorldPos;
  float recess = 1.0 - smoothstep(0.35, 0.96, cvT.r);            // 1 in the deepest carve
  // bluestone base with weathered pale patches
  float n1 = wx_vnoise(wp.xz * 1.7 + wp.y * 2.3), n2 = wx_vnoise(vec2(wp.x + wp.z, wp.y) * 7.0);
  float n3 = wx_vnoise(vec2(wp.x * 23.0 + wp.z * 23.0, wp.y * 23.0));
  vec3 base = uCarveTint.rgb * (0.85 + 0.3 * n2);
  vec3 alb = mix(base, vec3(0.19, 0.185, 0.17) * (0.9 + 0.2 * n3), smoothstep(0.45, 0.85, n1) * 0.7);
  // rain streaks running down from the top edges (darker, vertical)
  float streak = wx_vnoise(vec2((wp.x + wp.z) * 26.0, wp.y * 0.9)) * wx_vnoise(vec2((wp.x - wp.z) * 9.0, wp.y * 0.4 + 3.0));
  alb *= 1.0 - 0.35 * smoothstep(0.25, 0.6, streak);
  // lichen: ochre rosettes and white crust dots, mostly on weathered, upward / windward faces
  float lic = smoothstep(0.62, 0.8, wx_vnoise(wp.xz * 6.0 + wp.y * 4.0) * 0.6 + wx_vnoise(wp.xz * 19.0 - wp.y * 11.0) * 0.4 + (1.0 - cvT.a) * 0.3);
  alb = mix(alb, mix(vec3(0.30, 0.23, 0.09), vec3(0.24, 0.22, 0.12), n3), lic * uCarveTint.w);
  float crust = smoothstep(0.78, 0.9, wx_vnoise(wp.xz * 41.0 + wp.y * 37.0));
  alb = mix(alb, vec3(0.40, 0.40, 0.36), crust * 0.6 * uCarveTint.w);
  // carved recesses hold dust and shadow; faded vermilion pigment in the main inscription
  alb *= mix(1.0, 0.42, recess);
  alb = mix(alb, vec3(0.30, 0.045, 0.03) * (0.8 + 0.4 * n2), cvT.g * (1.0 - cvT.b) * recess * 0.85);
  // painted board (plaque): dark lacquer with grain, gilded characters and frame
  if (cvT.b > 0.5) {
    float grain = wx_vnoise(vec2(wp.x * 3.0 + wp.z * 3.0, wp.y * 90.0));
    vec3 lac = vec3(0.028, 0.022, 0.018) * (0.8 + 0.4 * grain);
    alb = mix(lac, vec3(0.50, 0.34, 0.10), cvT.g);
    cvRoughness = mix(0.62, 0.38, cvT.g); cvMetal = cvT.g * 0.75;
  } else {
    cvRoughness = mix(0.86, 0.97, recess);
  }
  // soil creeping up from the ground line
  if (wt_inWorld(wp.xz) > 0.5) {
    float hA = wp.y - wt_groundHeight(wp.xz);
    float k = 1.0 - smoothstep(0.0, 0.28 + 0.2 * n2, hA);
    alb = mix(alb, vec3(0.12, 0.095, 0.065), k * 0.8);
    alb *= mix(0.55, 1.0, smoothstep(-0.02, 0.35, hA));
  }
  diffuseColor.rgb = alb;
}
`;

export function createCarvedMaterial(atlas) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, normalMap: atlas.normal });
  mat.name = 'props:carved';
  mat.normalScale.set(1, 1);
  const uniforms = { tCarve: { value: atlas.carve }, uCarveTint: { value: new THREE.Vector4(0.085, 0.092, 0.094, 0.85) } };
  mat.userData.uniforms = uniforms;
  patchMaterial(mat);
  addShaderHook(mat, 'wtCarved', (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', CARVE_PARS + '\nvoid main() {')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + CARVE_ALBEDO)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = cvRoughness;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = cvMetal;');
  });
  return mat;
}

// ------------------------------------------------------------------------------------------------ geometry
/**
 * Extrude a 2D profile (x right, y up, metres) to a slab of `depth` (centred on z = 0). The front cap (+z) maps the
 * profile's bounding box onto `frontRegion`, the back cap onto `backRegion` (mirrored so it reads correctly from
 * behind); side walls and bevels map metrically into the plain `stone` region.
 */
export function extrudeFace(shape, depth, bevel, frontRegion, backRegion, atlas, { curveSegments = 10, bevelSegments = 2 } = {}) {
  const pts = shape.getPoints(curveSegments);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const sr = atlas.region('stone');
  const su = (sr.u1 - sr.u0) / (256 / STONE_PX_PER_M), sv = (sr.v1 - sr.v0) / (1024 / STONE_PX_PER_M);
  const V2 = THREE.Vector2;
  const capUV = (x, y, front) => {
    const u = (x - x0) / (x1 - x0), v = (y - y0) / (y1 - y0);
    const reg = front ? frontRegion : backRegion;
    if (!reg) return new V2(sr.u0 + 0.05 * (sr.u1 - sr.u0) + (x - x0) * su, sr.v0 + (y - y0) * sv);
    return atlas.uv(reg, front ? u : 1 - u, v);
  };
  const uvGen = {
    generateTopUV(geometry, V, a, b, c) {
      const front = V[a * 3 + 2] > 0;
      return [capUV(V[a * 3], V[a * 3 + 1], front), capUV(V[b * 3], V[b * 3 + 1], front), capUV(V[c * 3], V[c * 3 + 1], front)];
    },
    generateSideWallUV(geometry, V, a, b, c, d) {
      const ax = V[a * 3], ay = V[a * 3 + 1], bx = V[b * 3], by = V[b * 3 + 1];
      const horiz = Math.abs(ay - by) < Math.abs(ax - bx);
      const f = (i) => new V2(
        sr.u0 + (V[i * 3 + 2] + bevel + 0.03) * su,
        sr.v0 + ((horiz ? V[i * 3] - x0 : V[i * 3 + 1] - y0) + 0.05) * sv);
      return [f(a), f(b), f(c), f(d)];
    },
  };
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments, curveSegments, UVGenerator: uvGen,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g.index ? g.toNonIndexed() : g;
}

/** Deterministic jagged notch helper: returns points along a from→to chip line. */
function chip(shape, from, to, n, amp, seed) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    shape.lineTo(from.x + (to.x - from.x) * t + (r() - 0.5) * amp, from.y + (to.y - from.y) * t + (r() - 0.5) * amp);
  }
  shape.lineTo(to.x, to.y);
}

/** The stele: 0.84 × 2.2 m bluestone slab, round-headed (圓首), a broken upper-right shoulder, chipped edges. */
export const STELE = { w: 0.84, h: 2.04, arch: 0.17, t: 0.22, bevel: 0.016, sinkIntoPlinth: 0.12 };
export function steleGeometry(atlas) {
  const { w, h, arch } = STELE, hw = w / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw, 0);
  s.lineTo(hw, 0);
  s.lineTo(hw, h * 0.62);
  chip(s, { x: hw, y: h * 0.62 }, { x: hw - 0.012, y: h * 0.66 }, 2, 0.01, 3);   // small edge spall
  s.lineTo(hw - 0.01, h - 0.07);
  // broken shoulder: a sheared corner with a jagged fracture line
  chip(s, { x: hw - 0.01, y: h - 0.07 }, { x: hw - 0.19, y: h + arch * 0.72 }, 5, 0.022, 11);
  // round head (segmental arch) back to the left shoulder
  const R = (hw * hw + arch * arch) / (2 * arch), cy = h + arch - R;
  const a0 = Math.atan2(h + arch * 0.72 - cy, hw - 0.19), a1 = Math.PI - Math.atan2(h - cy, hw);
  const N = 16;
  for (let i = 1; i <= N; i++) { const a = a0 + (a1 - a0) * (i / N); s.lineTo(Math.cos(a) * R, cy + Math.sin(a) * R); }
  s.lineTo(-hw, h * 0.3);
  chip(s, { x: -hw, y: h * 0.3 }, { x: -hw, y: h * 0.22 }, 2, 0.014, 5);
  s.lineTo(-hw, 0);
  return extrudeFace(s, STELE.t, STELE.bevel, 'steleFront', 'steleBack', atlas, { curveSegments: 4, bevelSegments: 2 });
}

/** Plinth (方趺): a low rough-hewn block the stele is set into. Local: top at y = PLINTH.h. */
export const PLINTH = { w: 1.32, d: 0.66, h: 0.46 };
export function plinthGeometry(atlas) {
  const { w, d, h } = PLINTH;
  const s = new THREE.Shape();
  const c = 0.08;   // chamfered corners
  s.moveTo(-w / 2 + c, -d / 2); s.lineTo(w / 2 - c, -d / 2); s.lineTo(w / 2, -d / 2 + c); s.lineTo(w / 2, d / 2 - c);
  s.lineTo(w / 2 - c, d / 2); s.lineTo(-w / 2 + c, d / 2); s.lineTo(-w / 2, d / 2 - c); s.lineTo(-w / 2, -d / 2 + c); s.lineTo(-w / 2 + c, -d / 2);
  const g = extrudeFace(s, h, 0.03, null, null, atlas, { bevelSegments: 2 });
  g.rotateX(-Math.PI / 2);         // extrusion axis → +y (the top cap faces up)
  g.translate(0, h / 2, 0);
  return g;
}

/** Road marker: a tapered post with a gabled top; the inscription faces +z. */
export function markerGeometry(atlas, i) {
  const w0 = 0.30, w1 = 0.26, h = 1.05, s = new THREE.Shape();
  s.moveTo(-w0 / 2, 0); s.lineTo(w0 / 2, 0); s.lineTo(w1 / 2, h); s.lineTo(0, h + 0.09); s.lineTo(-w1 / 2, h); s.lineTo(-w0 / 2, 0);
  return extrudeFace(s, 0.19, 0.012, 'marker' + (i % 4), null, atlas, { bevelSegments: 1 });
}

/** Grave headstone: a small round-headed tablet. */
export function headstoneGeometry(atlas, i) {
  const w = 0.44, h = 0.62, s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h);
  s.absarc(0, h, w / 2, 0, Math.PI, false);
  s.lineTo(-w / 2, 0);
  return extrudeFace(s, 0.12, 0.012, 'head' + (i % 3), null, atlas, { curveSegments: 10, bevelSegments: 1 });
}
