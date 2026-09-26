// Mesh assembly (owner: character C): collects body, garment, hair, hat and weapon parts per material and emits one
// SkinnedMesh per material (≈8–10 draw calls per character). All parts share one Skeleton: the contract rig bones
// followed by the character's extra bones (cloth-chain nodes, the weapon frame).
//
// Two halves so the heavy part can run in a worker:
//   Assembly.add()/pack()   pure: merges parts into flat typed arrays per material (transferable)
//   buildMeshes(packed,…)   main thread: BufferGeometry + SkinnedMesh per material
//
// Per-vertex attributes:
//   position, normal, uv          (bind space; uv box-projected in metres when a part has none)
//   color / color2                linear albedo of the front / back (lining) face
//   skinIndex/skinWeight          4 influences
//   aCloth                        x translucency, y flutter weight, z rim mask, w cavity AO
import * as THREE from 'three';
import { boxUV } from './humanoidSdf.js';
import { LAYERS } from '../core/globals.js';

const ATTRS = [['color', 3], ['color2', 3], ['cloth', 4], ['skinIndex', 4], ['skinWeight', 4]];

export class Assembly {
  constructor() {
    this.parts = new Map();
  }

  /**
   * Add a mesh part.
   * mesh: { positions, normals, indices, uvs?, extra?: { color, color2, cloth, skinIndex, skinWeight } }
   * opts: { color: [r,g,b] (when no per-vertex colour), color2, cloth: [trans, flutter, rim, ao], rigid: boneIndex,
   *         uvScale (box UVs, per metre) }
   */
  add(mat, mesh, opts = {}) {
    if (!mesh || !mesh.positions?.length) return this;
    const nv = mesh.positions.length / 3;
    const ex = { ...(mesh.extra || {}) };
    const constant = (size, c) => { const a = new Float32Array(nv * size); for (let v = 0; v < nv; v++) a.set(c, v * size); return { size, array: a }; };
    if (!ex.color) ex.color = constant(3, opts.color || [0.5, 0.5, 0.5]);
    if (!ex.color2) ex.color2 = opts.color2 ? constant(3, opts.color2) : { size: 3, array: ex.color.array.map(c => c * 0.8) };
    if (!ex.cloth) ex.cloth = constant(4, opts.cloth || [0, 0, 1, 1]);
    if (!ex.skinIndex) {
      ex.skinIndex = constant(4, [opts.rigid ?? 0, 0, 0, 0]);
      ex.skinWeight = constant(4, [1, 0, 0, 0]);
    }
    let m = { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, uvs: mesh.uvs, extra: ex };
    if (!m.uvs) m = boxUV(m, opts.uvScale ?? 4);
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(m);
    return this;
  }

  /** Triangle counts per material (for budgets / debugging). */
  stats() {
    const out = {};
    let total = 0;
    for (const [k, list] of this.parts) { const t = list.reduce((a, m) => a + m.indices.length / 3, 0); out[k] = t; total += t; }
    out.total = total;
    return out;
  }

  /** Merge every material's parts into flat typed arrays: { key: { position, normal, uv, color, color2, cloth,
   * skinIndex (Uint16), skinWeight, index } }. The arrays are fresh (safe to transfer). */
  pack() {
    const out = {};
    for (const [key, list] of this.parts) {
      let nv = 0, ni = 0;
      for (const m of list) { nv += m.positions.length / 3; ni += m.indices.length; }
      const g = {
        position: new Float32Array(nv * 3), normal: new Float32Array(nv * 3), uv: new Float32Array(nv * 2),
        color: new Float32Array(nv * 3), color2: new Float32Array(nv * 3), cloth: new Float32Array(nv * 4),
        skinIndex: new Uint16Array(nv * 4), skinWeight: new Float32Array(nv * 4),
        index: nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni),
      };
      let vo = 0, io = 0;
      for (const m of list) {
        const n = m.positions.length / 3;
        g.position.set(m.positions, vo * 3); g.normal.set(m.normals, vo * 3); g.uv.set(m.uvs, vo * 2);
        for (const [a, s] of ATTRS) g[a].set(m.extra[a].array, vo * s);
        for (let i = 0; i < m.indices.length; i++) g.index[io + i] = m.indices[i] + vo;
        vo += n; io += m.indices.length;
      }
      out[key] = g;
    }
    return out;
  }
}

/** Transferable buffers of a packed assembly (for postMessage). */
export function packedTransferables(packed) {
  const t = [];
  for (const k in packed) for (const a in packed[k]) t.push(packed[k][a].buffer);
  return t;
}

/**
 * Build one SkinnedMesh per material from packed arrays. materials: { key: Material }. Returns the meshes.
 * Bounds: a fixed sphere around the character (posed bounds are never computed per frame).
 */
export function buildMeshes(packed, materials, skeleton, { castShadow = true, receiveShadow = true, renderOrder = -5, scale = 1 } = {}) {
  const meshes = [];
  const bindIdentity = new THREE.Matrix4();
  for (const key in packed) {
    const mat = materials[key];
    if (!mat) { console.warn(`[character] no material "${key}"`); continue; }
    const p = packed[key];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(p.normal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(p.color, 3));
    g.setAttribute('color2', new THREE.BufferAttribute(p.color2, 3));
    g.setAttribute('aCloth', new THREE.BufferAttribute(p.cloth, 4));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(p.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(p.skinWeight, 4));
    g.setIndex(new THREE.BufferAttribute(p.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0 * scale, 0), 2.6 * scale);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-2, -0.5, -2).multiplyScalar(scale), new THREE.Vector3(2, 3, 2).multiplyScalar(scale));
    const mesh = new THREE.SkinnedMesh(g, mat);
    mesh.name = `char:${key}`;
    mesh.bind(skeleton, bindIdentity);
    // posed bounds: a generous static sphere around the rig (cheap culling; skinned bounds are never recomputed)
    mesh.boundingSphere = g.boundingSphere.clone();
    mesh.boundingBox = g.boundingBox.clone();
    mesh.frustumCulled = true;
    mesh.castShadow = castShadow && key !== 'gauze';
    mesh.receiveShadow = receiveShadow;
    mesh.renderOrder = renderOrder;
    mesh.layers.set(LAYERS.ACTORS);
    meshes.push(mesh);
  }
  return meshes;
}
