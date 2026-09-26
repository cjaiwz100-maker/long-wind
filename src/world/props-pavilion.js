// Hexagonal wayside pavilion 亭 (bible §4.6, CONTRACTS props): a stone terrace with steps, six faded-vermilion
// columns on drum bases, blue-green architraves with a hanging fret, benches with outward-leaning backrests
// (美人靠) on four sides, bracket arms, rafters under the eaves, and a concave hexagonal tiled roof (攒尖顶) whose
// corners sweep up (翼角起翘), with curved hip ridges and a gourd finial. The name board 「長風亭」 hangs over the
// road-side entrance. Owner: world (W).
//
//   buildPavilion(atlas) → { geos: { stone, wood, tiles, ceramic, carved }, dims }
//     Local frame: centre at the origin, y = 0 at ground level, entrances face ±z (the +z one gets the plaque).
//     wood parts carry 'aPart': 0 vermilion lacquer, 1 blue-green painted beams, 2 bare weathered wood, 3 dark lacquer
//   createPavilionMaterials(sets) → { stone, wood, tiles, ceramic }   (sets = { stone, wood, tiles } from loadPBR)
import * as THREE from 'three';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { box, cyl, beam, place, merge, partAttr } from './props-geo.js';
import { extrudeFace } from './props-stone.js';
import { GROUND_GLSL } from './ground-glsl.js';

export const PAVILION = {
  Rp: 3.75, Hp: 0.5,            // terrace circumradius / height
  Rc: 2.7, colH: 2.75,          // column circle / column height (above the terrace)
  Re: 4.3, yEave: 3.3, lift: 0.62, flare: 0.09, yApex: 5.8,
};
const P = PAVILION;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const corner = (k, r, y = 0) => V3(Math.cos(k * Math.PI / 3) * r, y, Math.sin(k * Math.PI / 3) * r);

// ------------------------------------------------------------------------------------------------ roof surface
function eaveXZ(k, t, out) {
  const a = corner(k, P.Re), b = corner(k + 1, P.Re);
  const wc = Math.pow(Math.abs(2 * t - 1), 3);
  out.set(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t).multiplyScalar(1 + P.flare * wc);
  return out;
}
const yEave = (t) => P.yEave + P.lift * Math.pow(Math.abs(2 * t - 1), 2.6);
const yRoof = (s, t) => P.yApex - (P.yApex - yEave(t)) * (1 - Math.pow(1 - s, 1.75));
/** Point on the tiled surface (s 0 apex → 1 eave, t 0..1 across sector k); drop lowers it (underside). */
function roofPoint(k, s, t, out, drop = 0, inset = 1) {
  eaveXZ(k, t, out);
  out.multiplyScalar(s * inset);
  out.y = yRoof(s, t) - drop;
  return out;
}

function roofGeometries() {
  const NS = 18, NT = 26;
  const top = { pos: [], uv: [], idx: [] }, under = { pos: [], uv: [], idx: [] }, fascia = { pos: [], uv: [], idx: [] };
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  const inr = P.Re * Math.cos(Math.PI / 6);
  const thick = (s) => 0.1 + 0.14 * s;
  for (let k = 0; k < 6; k++) {
    const e = corner(k + 1, 1).sub(corner(k, 1)).normalize();           // along the eave
    const m = corner(k, 1).add(corner(k + 1, 1)).normalize();           // toward the side midpoint
    const b0 = top.pos.length / 3, b1 = under.pos.length / 3;
    for (let i = 0; i <= NS; i++) {
      const s = i / NS;
      for (let j = 0; j <= NT; j++) {
        const t = j / NT;
        roofPoint(k, s, t, p);
        top.pos.push(p.x, p.y, p.z);
        // tiles: channels perpendicular to the eave (u along it), rows parallel to it; 2.6 m per texture repeat
        top.uv.push(p.x * e.x + p.z * e.z, (inr - (p.x * m.x + p.z * m.z)) * 1.3);
        roofPoint(k, s, t, q, thick(s), 0.985);
        under.pos.push(q.x, q.y, q.z);
        under.uv.push(q.x * e.x + q.z * e.z, q.x * m.x + q.z * m.z);
      }
    }
    for (let i = 0; i < NS; i++) for (let j = 0; j < NT; j++) {
      const a = i * (NT + 1) + j, b = a + 1, c = a + NT + 1, d = c + 1;
      top.idx.push(b0 + a, b0 + b, b0 + c, b0 + b, b0 + d, b0 + c);
      under.idx.push(b1 + a, b1 + c, b1 + b, b1 + b, b1 + c, b1 + d);
    }
    // fascia board: eave edge of the tiles down to the underside edge
    const f0 = fascia.pos.length / 3;
    for (let j = 0; j <= NT; j++) {
      const t = j / NT;
      roofPoint(k, 1, t, p); roofPoint(k, 1, t, q, thick(1), 0.985);
      const u = p.x * e.x + p.z * e.z;
      fascia.pos.push(p.x, p.y + 0.01, p.z, q.x, q.y, q.z);
      fascia.uv.push(u, 0.3, u, 0);
    }
    for (let j = 0; j < NT; j++) { const a = f0 + j * 2; fascia.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const mk = (o, scale) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv.map((v) => v * scale), 2));
    g.setIndex(o.idx);
    g.computeVertexNormals();
    return g.toNonIndexed();
  };
  return { top: mk(top, 1 / 2.6), under: partAttr(mk(under, 1), 1), fascia: partAttr(mk(fascia, 1), 3) };
}

function ridgeGeometries() {
  const list = [];
  const p = new THREE.Vector3();
  for (let k = 0; k < 6; k++) {
    // hip ridge along the corner line t = 0 of sector k, then an upturned hook beyond the eave corner
    const pts = [];
    for (let i = 1; i <= 10; i++) { roofPoint(k, 0.05 + 0.95 * (i / 10), 0, p); pts.push(p.clone().add(V3(0, 0.075, 0))); }
    const tip = pts[pts.length - 1], dir = tip.clone().setY(0).normalize();
    pts.push(tip.clone().addScaledVector(dir, 0.22).add(V3(0, 0.1, 0)));
    pts.push(tip.clone().addScaledVector(dir, 0.36).add(V3(0, 0.24, 0)));
    pts.push(tip.clone().addScaledVector(dir, 0.4).add(V3(0, 0.33, 0)));
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, 40, 0.075, 7, false);
    list.push(tube.toNonIndexed());
    // small ridge-end ornament block at the eave corner
    list.push(place(box(0.14, 0.16, 0.22), { pos: [tip.x, tip.y + 0.02, tip.z], rotY: -Math.atan2(dir.z, dir.x) + Math.PI / 2 }));
  }
  // apex collar + gourd finial (宝顶)
  const prof = [[0, 0], [0.42, 0], [0.42, 0.07], [0.3, 0.12], [0.26, 0.2], [0.32, 0.34], [0.3, 0.48], [0.14, 0.58], [0.1, 0.64],
    [0.2, 0.74], [0.21, 0.86], [0.12, 0.96], [0.05, 1.02], [0.035, 1.18], [0, 1.24]].map(([r, y]) => new THREE.Vector2(r, y));
  const lathe = new THREE.LatheGeometry(prof, 14).toNonIndexed();
  lathe.translate(0, P.yApex - 0.12, 0);
  list.push(lathe);
  for (const g of list) { g.deleteAttribute('uv'); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2)); }
  return list;
}

// ------------------------------------------------------------------------------------------------ build
export function buildPavilion(atlas) {
  const stone = [], wood = [], carved = [];
  const { Rp, Hp, Rc, colH } = P;
  // terrace: base course, body, cap stones (three stacked hexagonal prisms)
  const prism = (r, y0, y1) => {
    const g = new THREE.CylinderGeometry(r, r, y1 - y0, 6, 1).toNonIndexed();
    g.rotateY(Math.PI / 6);           // flat sides toward ±z (corners at k·60° from +x)
    g.translate(0, (y0 + y1) / 2, 0);
    g.computeVertexNormals();
    return g;
  };
  const uvStone = (g) => {
    // metric planar UVs, 2 m per texture repeat; side walls use the wall's own horizontal axis
    const Pp = g.getAttribute('position'), N = g.getAttribute('normal'), uv = new Float32Array(Pp.count * 2);
    for (let i = 0; i < Pp.count; i++) {
      const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i);
      if (Math.abs(ny) > 0.7) { uv[i * 2] = Pp.getX(i) / 2; uv[i * 2 + 1] = Pp.getZ(i) / 2; }
      else { const tx = -nz, tz = nx; uv[i * 2] = (Pp.getX(i) * tx + Pp.getZ(i) * tz) / 2; uv[i * 2 + 1] = Pp.getY(i) / 2; }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return partAttr(g, 0);
  };
  stone.push(uvStone(prism(Rp + 0.1, -0.35, 0.14)), uvStone(prism(Rp, 0.14, Hp - 0.09)), uvStone(prism(Rp + 0.06, Hp - 0.09, Hp)));
  // steps at both entrances (±z)
  const apoth = Rp * Math.cos(Math.PI / 6);
  for (const sgn of [1, -1]) {
    stone.push(uvStone(place(new THREE.BoxGeometry(2.0, 0.52, 0.66).toNonIndexed(), { pos: [0, -0.09, sgn * (apoth + 0.29)] })));
    stone.push(uvStone(place(new THREE.BoxGeometry(1.9, 0.34, 0.36).toNonIndexed(), { pos: [0, 0.34 - 0.17 + 0.0, sgn * (apoth + 0.14)] })));
  }
  // columns (vermilion), drum bases (stone)
  for (let k = 0; k < 6; k++) {
    const c = corner(k, Rc);
    wood.push(place(cyl(0.132, 0.115, colH, 14, { part: 0 }), { pos: [c.x, Hp, c.z] }));
    const base = cyl(0.21, 0.19, 0.16, 14, { part: 0 });
    base.deleteAttribute('aPart'); stone.push(partAttr(uvStone(place(base, { pos: [c.x, Hp - 0.02, c.z] })), 0));
  }
  const yTop = Hp + colH;
  for (let k = 0; k < 6; k++) {
    const a = corner(k, Rc), b = corner(k + 1, Rc), d = b.clone().sub(a).normalize();
    const a2 = a.clone().addScaledVector(d, -0.16), b2 = b.clone().addScaledVector(d, 0.16);
    // architrave (額枋) + lower tie beam (由額), blue-green
    wood.push(beam(a2.clone().setY(yTop - 0.14), b2.clone().setY(yTop - 0.14), 0.15, 0.27, { part: 1 }));
    wood.push(beam(a.clone().setY(yTop - 0.47), b.clone().setY(yTop - 0.47), 0.1, 0.12, { part: 1 }));
    // eave purlin sitting on the brackets
    wood.push(beam(a2.clone().setY(yTop + 0.2), b2.clone().setY(yTop + 0.2), 0.16, 0.16, { part: 3 }));
    // hanging fret (掛落): frame + vertical bars under the tie beam
    const L = Rc, n = 11;
    for (let i = 1; i < n; i++) {
      const p = a.clone().addScaledVector(d, (L * i) / n);
      wood.push(place(box(0.03, 0.26, 0.03, { part: 1 }), { pos: [p.x, yTop - 0.66, p.z] }));
    }
    wood.push(beam(a.clone().setY(yTop - 0.79), b.clone().setY(yTop - 0.79), 0.035, 0.035, { part: 1 }));
    // benches + outward backrests on four sides (sides 1 and 4 are the ±z entrances)
    if (k !== 1 && k !== 4) {
      const mid = a.clone().add(b).multiplyScalar(0.5), out = mid.clone().setY(0).normalize();
      const inset = 0.1;
      const s0 = a.clone().addScaledVector(out, -inset), s1 = b.clone().addScaledVector(out, -inset);
      s0.addScaledVector(d, 0.14); s1.addScaledVector(d, -0.14);
      wood.push(beam(s0.clone().setY(Hp + 0.43), s1.clone().setY(Hp + 0.43), 0.34, 0.06, { part: 2 }));
      wood.push(beam(s0.clone().addScaledVector(out, 0.1).setY(Hp + 0.21), s1.clone().addScaledVector(out, 0.1).setY(Hp + 0.21), 0.05, 0.42, { part: 3 }));
      // 美人靠: slats leaning outward, top rail
      const slats = 12, lean = 0.42;
      for (let i = 0; i <= slats; i++) {
        const p = s0.clone().lerp(s1, i / slats).addScaledVector(out, 0.14).setY(Hp + 0.46);
        const top = p.clone().addScaledVector(out, lean * 0.5).setY(Hp + 0.46 + 0.46);
        wood.push(beam(p, top, 0.03, 0.022, { part: 0 }));
      }
      const r0 = s0.clone().addScaledVector(out, 0.14 + lean * 0.5).setY(Hp + 0.93), r1 = s1.clone().addScaledVector(out, 0.14 + lean * 0.5).setY(Hp + 0.93);
      wood.push(beam(r0, r1, 0.07, 0.05, { part: 0 }));
    }
  }
  // brackets: cap block on each column + a cantilever arm out to the eave
  for (let k = 0; k < 6; k++) {
    const c = corner(k, Rc), dir = c.clone().normalize();
    wood.push(place(box(0.3, 0.14, 0.3, { part: 1 }), { pos: [c.x, yTop + 0.07, c.z], rotY: -k * Math.PI / 3 }));
    wood.push(beam(dir.clone().multiplyScalar(Rc - 0.35).setY(yTop + 0.1), dir.clone().multiplyScalar(Rc + 1.1).setY(yTop + 0.45), 0.12, 0.15, { part: 3 }));
  }
  // roof: tiles on top, painted soffit + rafters underneath, fascia board
  const roof = roofGeometries();
  wood.push(roof.under, roof.fascia);
  const pt = new THREE.Vector3(), pb = new THREE.Vector3();
  for (let k = 0; k < 6; k++) {
    const nR = 17;
    for (let i = 1; i < nR; i++) {
      const t = i / nR;
      roofPoint(k, 0.58, t, pt, 0.1 + 0.14 * 0.58 + 0.04, 0.985);
      roofPoint(k, 1.0, t, pb, 0.1 + 0.14 + 0.03, 0.985);
      wood.push(beam(pt, pb, 0.065, 0.065, { part: 1 }));
    }
  }
  // plaque over the +z entrance (carved atlas: lacquer board + gilded 長風亭)
  {
    const s = new THREE.Shape();
    const w = 1.12, h = 0.35;
    s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.lineTo(-w / 2, 0);
    const g = extrudeFace(s, 0.04, 0.008, 'plaque', 'plaque', atlas, { bevelSegments: 1 });
    const zf = Rc * Math.cos(Math.PI / 6) + 0.1;
    carved.push(place(g, { pos: [0, yTop - 0.42, zf], rotX: 0.2 }));
  }
  const ceramic = ridgeGeometries();
  return {
    geos: { stone: merge(stone), wood: merge(wood), tiles: roof.top, ceramic: merge(ceramic), carved: merge(carved) },
    dims: { ...P, top: P.yApex + 1.1 },
  };
}

// ------------------------------------------------------------------------------------------------ materials
const WOOD_PARS = /* glsl */`
varying float vPart;
`;
const WOOD_ALBEDO = /* glsl */`
{
  vec3 wp = vWxWorldPos;
  float n1 = wx_vnoise(wp.xz * 2.3 + wp.y * 3.1), n2 = wx_vnoise(vec2(wp.x + wp.z, wp.y) * 9.0);
  float grain = wx_vnoise(vec2((wp.x - wp.z) * 40.0, wp.y * 2.0));
  vec3 bare = diffuseColor.rgb;                                        // the weathered planks scan (calibrated)
  int part = int(vPart + 0.5);
  vec3 paint = part == 0 ? vec3(0.26, 0.036, 0.024) : part == 1 ? vec3(0.055, 0.105, 0.092) : vec3(0.03, 0.026, 0.022);
  // sun-bleached paint and flaking: more loss low on the columns and on exposed faces
  paint = mix(paint, paint * vec3(1.45, 1.6, 1.55) + vec3(0.03, 0.02, 0.015), smoothstep(0.4, 0.9, n1) * 0.6);
  float peel = smoothstep(0.52, 0.66, n1 * 0.55 + n2 * 0.35 + grain * 0.2 + (part == 2 ? 1.0 : 0.0) - smoothstep(0.3, 2.0, wp.y - ${'${Y0}'}) * 0.12);
  diffuseColor.rgb = mix(paint * (0.85 + 0.3 * grain), bare, peel);
  wdRough = mix(0.62, 0.9, peel);
}
`;
const TILE_ALBEDO = /* glsl */`
{
  vec3 wp = vWxWorldPos;
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float moss = smoothstep(0.0, 0.04, diffuseColor.g - diffuseColor.r * 0.95);
  vec3 grey = lum * vec3(0.8, 0.86, 0.92);                            // fired grey tiles (青瓦), a trace of warmth kept
  vec3 c = mix(grey, diffuseColor.rgb * 0.8, 0.14);
  c = mix(c, lum * vec3(1.3, 1.08, 0.6), moss * 0.8);                 // moss → dry ochre lichen
  c *= 0.85 + 0.3 * wx_vnoise(wp.xz * 0.9);                            // weathering blotches across the roof
  diffuseColor.rgb = c;
}
`;
const STONE_ALBEDO = /* glsl */`
{
  vec3 wp = vWxWorldPos;
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, lum * vec3(1.08, 1.0, 0.86), 0.5);   // warm the grey scan toward the steppe
  if (wt_inWorld(wp.xz) > 0.5) {
    float hA = wp.y - wt_groundHeight(wp.xz);
    float k = 1.0 - smoothstep(0.0, 0.35 + 0.25 * wx_vnoise(wp.xz * 4.0), hA);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.095, 0.065), k * 0.75);
    diffuseColor.rgb *= mix(0.6, 1.0, smoothstep(-0.05, 0.4, hA));
  }
}
`;

function calibrate(mat, target) {
  // scale the scan's albedo by a luminance gain toward a linear target (measured on a thumbnail)
  try {
    const img = mat.map?.image;
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      s += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
    }
    const k = target / Math.max(s / 256, 1e-3);
    mat.color.setScalar(k);
  } catch { /* keep 1 */ }
}

export function createPavilionMaterials(sets, groundY = 0) {
  const std = (set, name, target) => {
    const m = new THREE.MeshStandardMaterial({
      name, map: set?.map || null, normalMap: set?.normalMap || null, roughnessMap: set?.armMap || null,
      roughness: 1, metalness: 0,
    });
    if (set?.map) calibrate(m, target);
    patchMaterial(m);
    return m;
  };
  const stone = std(sets.stone, 'pavilion:stone', 0.16);
  addShaderHook(stone, 'wtPavStone', (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', GROUND_GLSL + '\nvoid main() {')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + STONE_ALBEDO);
  });
  const wood = std(sets.wood, 'pavilion:wood', 0.11);
  addShaderHook(wood, 'wtPavWood', (sh) => {
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'attribute float aPart;\nvarying float vPart;\nvoid main() {\nvPart = aPart;');
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', WOOD_PARS + '\nvoid main() {\nfloat wdRough = 0.85;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + WOOD_ALBEDO.replace('${Y0}', groundY.toFixed(3)))
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = wdRough;');
  });
  wood.side = THREE.DoubleSide;
  const tiles = std(sets.tiles, 'pavilion:tiles', 0.09);
  addShaderHook(tiles, 'wtPavTiles', (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + TILE_ALBEDO);
  });
  tiles.side = THREE.DoubleSide;
  const ceramic = new THREE.MeshStandardMaterial({ name: 'pavilion:ceramic', color: new THREE.Color(0.05, 0.053, 0.056), roughness: 0.5, metalness: 0 });
  patchMaterial(ceramic);
  return { stone, wood, tiles, ceramic };
}
