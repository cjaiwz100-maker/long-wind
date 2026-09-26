// Mesh LOD builder for the scanned rocks: crack-free vertex clustering. Owner: world (W).
//
//   simplify(geometry, targetTris) → BufferGeometry (position, normal, uv, index) with ≈ targetTris triangles
//   prepGeometry(geometry)         → non-interleaved clone with exactly position / normal / uv (+ Uint32 index)
//
// Clustering works on a uniform spatial grid. Every vertex in a cell moves to the cell's mean position (so the two
// sides of a UV seam stay welded — no pinholes at distance), but vertices keep separate UV "charts": a cell emits one
// output vertex per coarse-UV bucket, averaging only the UVs in that bucket. Triangles whose corners fall into fewer
// than three distinct cells are dropped. The cell size is found by bisection to hit the triangle target. O(n) per
// pass, ~10 ms for a 90k-triangle scan. PURE geometry (three.js BufferGeometry in/out).
import * as THREE from 'three';

/** Clone with only position/normal/uv, de-interleaved, indexed (Uint32). Missing normals/uvs are generated. */
export function prepGeometry(src) {
  const g = src; // indexed or not, attributes are read per vertex below
  const out = new THREE.BufferGeometry();
  const take = (name, size) => {
    const a = g.getAttribute(name);
    if (!a) return null;
    const arr = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) arr[i * size + c] = a.getComponent(i, c);
    return new THREE.BufferAttribute(arr, size);
  };
  out.setAttribute('position', take('position', 3));
  const n = take('normal', 3);
  const uv = take('uv', 2);
  const idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: g.getAttribute('position').count }, (_, i) => i);
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  if (n) out.setAttribute('normal', n); else out.computeVertexNormals();
  out.setAttribute('uv', uv || new THREE.BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
  return out;
}

function clusterPass(P, N, UV, I, cell, uvq) {
  const nv = P.length / 3;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  for (let i = 0; i < nv; i++) { x0 = Math.min(x0, P[i * 3]); y0 = Math.min(y0, P[i * 3 + 1]); z0 = Math.min(z0, P[i * 3 + 2]); }
  const inv = 1 / cell;
  const cellOf = new Int32Array(nv), vOut = new Int32Array(nv);
  const cellMap = new Map(), keyMap = new Map();
  const cP = [], cN = [], cC = [];            // per cell: position sum, normal sum, count
  const oUV = [], oC = [], oCell = [];        // per output vertex: uv sum, count, cell
  for (let i = 0; i < nv; i++) {
    const ix = Math.floor((P[i * 3] - x0) * inv), iy = Math.floor((P[i * 3 + 1] - y0) * inv), iz = Math.floor((P[i * 3 + 2] - z0) * inv);
    const ckey = ix + iy * 4096 + iz * 16777216;   // exact in a double (≤ 4096 cells per axis)
    let c = cellMap.get(ckey);
    if (c === undefined) { c = cC.length; cellMap.set(ckey, c); cP.push(0, 0, 0); cN.push(0, 0, 0); cC.push(0); }
    cellOf[i] = c;
    cP[c * 3] += P[i * 3]; cP[c * 3 + 1] += P[i * 3 + 1]; cP[c * 3 + 2] += P[i * 3 + 2];
    cN[c * 3] += N[i * 3]; cN[c * 3 + 1] += N[i * 3 + 1]; cN[c * 3 + 2] += N[i * 3 + 2];
    cC[c]++;
    const u = ((Math.floor(UV[i * 2] * uvq) % 32) + 32) % 32, v = ((Math.floor(UV[i * 2 + 1] * uvq) % 32) + 32) % 32;
    const okey = c * 1024 + u * 32 + v;
    let o = keyMap.get(okey);
    if (o === undefined) { o = oC.length; keyMap.set(okey, o); oUV.push(0, 0); oC.push(0); oCell.push(c); }
    vOut[i] = o;
    oUV[o * 2] += UV[i * 2]; oUV[o * 2 + 1] += UV[i * 2 + 1]; oC[o]++;
  }
  const tris = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ca = cellOf[a], cb = cellOf[b], cc = cellOf[c];
    if (ca === cb || cb === cc || ca === cc) continue;
    tris.push(vOut[a], vOut[b], vOut[c]);
  }
  return { tris, cP, cN, cC, oUV, oC, oCell };
}

/** Simplify to ≈ targetTris triangles (returns a prepGeometry clone when the source is already small enough). */
export function simplify(src, targetTris) {
  const g = src.getAttribute('uv') && src.index && !src.getAttribute('position').isInterleavedBufferAttribute ? src : prepGeometry(src);
  const P = g.getAttribute('position').array, N = g.getAttribute('normal').array, UV = g.getAttribute('uv').array, I = g.index.array;
  if (I.length / 3 <= targetTris * 1.1) return g === src ? prepGeometry(src) : g;
  g.computeBoundingBox();
  const size = new THREE.Vector3(); g.boundingBox.getSize(size);
  const diag = size.length();
  // bisection on the cell size (log space): more cells → more triangles
  let lo = diag / 3000, hi = diag / 3, best = null;
  for (let it = 0; it < 14; it++) {
    const cell = Math.sqrt(lo * hi);
    const r = clusterPass(P, N, UV, I, cell, 24);
    const n = r.tris.length / 3;
    if (!best || Math.abs(n - targetTris) < Math.abs(best.tris.length / 3 - targetTris)) best = r;
    if (Math.abs(n - targetTris) < targetTris * 0.06) break;
    if (n > targetTris) lo = cell; else hi = cell;
  }
  const { tris, cP, cN, cC, oUV, oC, oCell } = best;
  // compact: keep only referenced output vertices
  const remap = new Int32Array(oC.length).fill(-1);
  let nOut = 0;
  for (const v of tris) if (remap[v] < 0) remap[v] = nOut++;
  const pos = new Float32Array(nOut * 3), nrm = new Float32Array(nOut * 3), uv = new Float32Array(nOut * 2);
  for (let o = 0; o < oC.length; o++) {
    const k = remap[o]; if (k < 0) continue;
    const c = oCell[o], n = cC[c];
    pos[k * 3] = cP[c * 3] / n; pos[k * 3 + 1] = cP[c * 3 + 1] / n; pos[k * 3 + 2] = cP[c * 3 + 2] / n;
    const nx = cN[c * 3], ny = cN[c * 3 + 1], nz = cN[c * 3 + 2], il = 1 / (Math.hypot(nx, ny, nz) || 1);
    nrm[k * 3] = nx * il; nrm[k * 3 + 1] = ny * il; nrm[k * 3 + 2] = nz * il;
    uv[k * 2] = oUV[o * 2] / oC[o]; uv[k * 2 + 1] = oUV[o * 2 + 1] / oC[o];
  }
  const idx = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i++) idx[i] = remap[tris[i]];
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
