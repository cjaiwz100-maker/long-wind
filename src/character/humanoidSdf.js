// Geometry toolkit for procedural characters (owner: character C).
// Signed-distance primitives + a surface-nets polygoniser + mesh utilities (clip-and-snap, rolled hems,
// box-projected UVs, Laplacian smoothing). Bodies, heads, hands and garment shells are all authored as smooth
// unions of a few dozen primitives in BIND space, polygonised once at load and cached.
//
// All hot functions take plain numbers (x, y, z) and never allocate, because a body polygonisation evaluates the
// SDF a few hundred thousand times.
import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------------------------
// primitives. Each returns { d(x,y,z) → signed distance (m), bone?, tag? } — extra fields are for the callers.
// ---------------------------------------------------------------------------------------------------------------

/** Polynomial smooth min (iq). k = blend radius (m). */
export function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}
export function smax(a, b, k) { return -smin(-a, -b, k); }

/** Round cone (tapered capsule) from a (radius ra) to b (radius rb). iq's exact SDF. */
export function roundCone(a, b, ra, rb) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb, a2 = l2 - rr * rr, il2 = 1 / l2;
  const ax = a.x, ay = a.y, az = a.z;
  return {
    a: a.clone(), b: b.clone(), ra, rb,
    d(x, y, z) {
      const pax = x - ax, pay = y - ay, paz = z - az;
      const yy = pax * bax + pay * bay + paz * baz;
      const zz = yy - l2;
      const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
      const x2 = qx * qx + qy * qy + qz * qz;
      const y2 = yy * yy * l2, z2 = zz * zz * l2;
      const k = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
      if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
      return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - ra;
    },
  };
}

/**
 * Ellipsoid with centre c, radii r (Vector3) and optional orientation q (Quaternion, local → bind).
 * iq's bound (k0·(k0−1)/k1) — accurate near the surface, which is all the polygoniser needs.
 */
export function ellipsoid(c, r, q = null) {
  const m = new THREE.Matrix3();
  if (q) m.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)).transpose(); // bind → local
  else m.identity();
  const e = m.elements; // column-major
  const cx = c.x, cy = c.y, cz = c.z, rx = r.x, ry = r.y, rz = r.z;
  return {
    c: c.clone(), r: r.clone(),
    d(x, y, z) {
      const px = x - cx, py = y - cy, pz = z - cz;
      const lx = e[0] * px + e[3] * py + e[6] * pz;
      const ly = e[1] * px + e[4] * py + e[7] * pz;
      const lz = e[2] * px + e[5] * py + e[8] * pz;
      const ax = lx / rx, ay = ly / ry, az = lz / rz;
      const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
      const bx = lx / (rx * rx), by = ly / (ry * ry), bz = lz / (rz * rz);
      const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
      return k1 < 1e-9 ? -Math.min(rx, ry, rz) : k0 * (k0 - 1) / k1;
    },
  };
}

/** Rounded box, half extents h, corner radius rad, centre c, orientation q. */
export function roundBox(c, h, rad, q = null) {
  const m = new THREE.Matrix3();
  if (q) m.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)).transpose();
  const e = m.elements;
  const cx = c.x, cy = c.y, cz = c.z, hx = h.x - rad, hy = h.y - rad, hz = h.z - rad;
  return {
    d(x, y, z) {
      const px = x - cx, py = y - cy, pz = z - cz;
      const qx = Math.abs(e[0] * px + e[3] * py + e[6] * pz) - hx;
      const qy = Math.abs(e[1] * px + e[4] * py + e[7] * pz) - hy;
      const qz = Math.abs(e[2] * px + e[5] * py + e[8] * pz) - hz;
      const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
      return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - rad;
    },
  };
}

/**
 * Smooth union of a list of primitives. Each item: { d, k? } where k is the blend radius used when that primitive
 * is merged into the running result (default kDefault). Items with sub = true are smooth-subtracted.
 * Returns a function f(x,y,z) with extra fields so the polygoniser can evaluate only the items near each block:
 *   f.relevant(cx, cy, cz, reach, out) → count of item indices written to out (Int32Array)
 *   f.subset(list, n, x, y, z)        → distance using only those items
 */
export function unionSDF(items, kDefault = 0.02) {
  const n = items.length;
  const ks = new Float64Array(items.map(i => i.k ?? kDefault));
  const subs = items.map(i => !!i.sub);
  const f = (x, y, z) => {
    let d = 1e9;
    for (let i = 0; i < n; i++) {
      const di = items[i].d(x, y, z);
      d = subs[i] ? smax(d, -di, ks[i]) : smin(d, di, ks[i]);
    }
    return d;
  };
  let kMax = 0;
  for (let i = 0; i < n; i++) kMax = Math.max(kMax, ks[i]);
  f.items = items;
  f.relevant = (cx, cy, cz, reach, out) => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      // an item further than reach + blend radius from every point of the block cannot change the union there
      // (the 1.4 factor covers the ellipsoid bound's under-estimation)
      if (items[i].d(cx, cy, cz) < (reach + kMax) * 1.4) out[c++] = i;
    }
    return c;
  };
  f.subset = (list, m, x, y, z) => {
    let d = 1e9;
    for (let j = 0; j < m; j++) {
      const i = list[j];
      const di = items[i].d(x, y, z);
      d = subs[i] ? smax(d, -di, ks[i]) : smin(d, di, ks[i]);
    }
    return d;
  };
  return f;
}

// ---------------------------------------------------------------------------------------------------------------
// surface nets
// ---------------------------------------------------------------------------------------------------------------

/**
 * Polygonise sdf < 0 inside the box [min, max] with voxel size h. Coarse 4³ blocks far from the surface are
 * skipped (Lipschitz test), cell vertices are projected onto the true surface along the gradient, normals come
 * from the SDF gradient. Returns { positions: Float32Array, normals: Float32Array, indices: Uint32Array }.
 */
export function polygonize(sdf, min, max, h, { refine = 2 } = {}) {
  const nx = Math.ceil((max.x - min.x) / h) + 2, ny = Math.ceil((max.y - min.y) / h) + 2, nz = Math.ceil((max.z - min.z) / h) + 2;
  const ox = min.x - h * 0.5, oy = min.y - h * 0.5, oz = min.z - h * 0.5;
  const sxy = nx * ny;
  const vals = new Float32Array(nx * ny * nz);
  // --- coarse block classification
  const B = 4, bx = Math.ceil(nx / B), by = Math.ceil(ny / B), bz = Math.ceil(nz / B);
  const near = new Uint8Array(bx * by * bz), bsign = new Int8Array(bx * by * bz);
  const reach = B * h * 0.8660254 * 1.35 + h;
  for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    const d = sdf(ox + (i * B + B * 0.5) * h, oy + (j * B + B * 0.5) * h, oz + (k * B + B * 0.5) * h);
    const bi = i + j * bx + k * bx * by;
    near[bi] = Math.abs(d) < reach ? 1 : 0;
    bsign[bi] = d < 0 ? -1 : 1;
  }
  const isNear = (i, j, k) => {
    // a sample on a block boundary belongs to both neighbouring blocks
    const i0 = Math.min(Math.floor(i / B), bx - 1), j0 = Math.min(Math.floor(j / B), by - 1), k0 = Math.min(Math.floor(k / B), bz - 1);
    for (let dk = 0; dk <= (k % B === 0 && k0 > 0 ? 1 : 0); dk++)
      for (let dj = 0; dj <= (j % B === 0 && j0 > 0 ? 1 : 0); dj++)
        for (let di = 0; di <= (i % B === 0 && i0 > 0 ? 1 : 0); di++)
          if (near[(i0 - di) + (j0 - dj) * bx + (k0 - dk) * bx * by]) return 0;
    return bsign[i0 + j0 * bx + k0 * bx * by];
  };
  const culled = typeof sdf.relevant === 'function';
  const list = culled ? new Int32Array(sdf.items.length) : null;
  const blockLists = culled ? new Map() : null;
  const done = new Uint8Array(nx * ny * nz);
  // exact samples block by block (so each block evaluates only the primitives near it)
  for (let kb = 0; kb < bz; kb++) for (let jb = 0; jb < by; jb++) for (let ib = 0; ib < bx; ib++) {
    if (!near[ib + jb * bx + kb * bx * by]) continue;
    const i0 = ib * B, j0 = jb * B, k0 = kb * B;
    let m = 0;
    if (culled) {
      m = sdf.relevant(ox + (i0 + B * 0.5) * h, oy + (j0 + B * 0.5) * h, oz + (k0 + B * 0.5) * h, reach + h, list);
      blockLists.set(ib + jb * bx + kb * bx * by, list.slice(0, m));
    }
    for (let k = k0; k <= Math.min(k0 + B, nz - 1); k++) for (let j = j0; j <= Math.min(j0 + B, ny - 1); j++) for (let i = i0; i <= Math.min(i0 + B, nx - 1); i++) {
      const o = i + j * nx + k * sxy;
      if (done[o]) continue;
      done[o] = 1;
      vals[o] = culled ? sdf.subset(list, m, ox + i * h, oy + j * h, oz + k * h) : sdf(ox + i * h, oy + j * h, oz + k * h);
    }
  }
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const o = i + j * nx + k * sxy;
    if (done[o]) continue;
    const s = isNear(i, j, k);
    vals[o] = s === 0 ? sdf(ox + i * h, oy + j * h, oz + k * h) : s * 1e3;
  }
  // --- one vertex per sign-changing cell
  const cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
  const cellV = new Int32Array(cnx * cny * cnz).fill(-1);
  const pos = [];
  const cornerOff = [0, 1, nx, 1 + nx, sxy, 1 + sxy, nx + sxy, 1 + nx + sxy];
  const cornerXYZ = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++) {
    const base = i + j * nx + k * sxy;
    let neg = 0;
    for (let c = 0; c < 8; c++) { cv[c] = vals[base + cornerOff[c]]; if (cv[c] < 0) neg++; }
    if (neg === 0 || neg === 8) continue;
    let ax = 0, ay = 0, az = 0, n = 0;
    for (const [e0, e1] of edges) {
      const a = cv[e0], b = cv[e1];
      if ((a < 0) === (b < 0)) continue;
      const t = a / (a - b);
      const A = cornerXYZ[e0], Bc = cornerXYZ[e1];
      ax += A[0] + (Bc[0] - A[0]) * t; ay += A[1] + (Bc[1] - A[1]) * t; az += A[2] + (Bc[2] - A[2]) * t; n++;
    }
    cellV[i + j * cnx + k * cnx * cny] = pos.length / 3;
    pos.push(ox + (i + ax / n) * h, oy + (j + ay / n) * h, oz + (k + az / n) * h);
  }
  // --- quads across every sign-changing grid edge
  const idx = [];
  const cell = (i, j, k) => cellV[i + j * cnx + k * cnx * cny];
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = vals[i + j * nx + k * sxy];
    // x edge
    if (i < nx - 1 && (v0 < 0) !== (vals[i + 1 + j * nx + k * sxy] < 0) && i < cnx) {
      quad(idx, cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), v0 < 0);
    }
    if (j < ny - 1 && (v0 < 0) !== (vals[i + (j + 1) * nx + k * sxy] < 0) && j < cny) {
      quad(idx, cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), v0 < 0);
    }
    if (k < nz - 1 && (v0 < 0) !== (vals[i + j * nx + (k + 1) * sxy] < 0) && k < cnz) {
      quad(idx, cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), v0 < 0);
    }
  }
  const positions = new Float32Array(pos);
  const normals = new Float32Array(positions.length);
  // --- project onto the surface, normals from the gradient (block-local primitive subsets when available)
  const e = h * 0.25;
  for (let v = 0; v < positions.length; v += 3) {
    let x = positions[v], y = positions[v + 1], z = positions[v + 2];
    let f = sdf;
    if (culled) {
      const ib = Math.min(Math.max(Math.floor((x - ox) / h / B), 0), bx - 1), jb = Math.min(Math.max(Math.floor((y - oy) / h / B), 0), by - 1), kb = Math.min(Math.max(Math.floor((z - oz) / h / B), 0), bz - 1);
      const L = blockLists.get(ib + jb * bx + kb * bx * by);
      if (L) f = (a, b, c) => sdf.subset(L, L.length, a, b, c);
    }
    const x0 = x, y0 = y, z0 = z;
    let gx = 0, gy = 1, gz = 0;
    for (let it = 0; it <= refine; it++) {
      const d = f(x, y, z);
      gx = f(x + e, y, z) - f(x - e, y, z);
      gy = f(x, y + e, z) - f(x, y - e, z);
      gz = f(x, y, z + e) - f(x, y, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      if (it === refine) break;
      x -= gx * d; y -= gy * d; z -= gz * d;
      // stay near the cell (protects thin features from collapsing)
      x = Math.min(Math.max(x, x0 - h), x0 + h); y = Math.min(Math.max(y, y0 - h), y0 + h); z = Math.min(Math.max(z, z0 - h), z0 + h);
    }
    positions[v] = x; positions[v + 1] = y; positions[v + 2] = z;
    normals[v] = gx; normals[v + 1] = gy; normals[v + 2] = gz;
  }
  const indices = new Uint32Array(idx);
  orientFaces(positions, normals, indices);
  return { positions, normals, indices };
}

function quad(out, a, b, c, d) {
  if (a < 0 || b < 0 || c < 0 || d < 0) return;
  out.push(a, b, c, a, c, d);
}

/** Flip triangles whose geometric normal disagrees with the averaged vertex normals. */
export function orientFaces(P, N, I) {
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
    if (fx * nx + fy * ny + fz * nz < 0) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// mesh utilities. A "mesh" here is { positions, normals, indices } (+ optional per-vertex extras).
// ---------------------------------------------------------------------------------------------------------------

/**
 * Keep the part of a mesh where clip(x,y,z) ≤ 0. Triangles fully outside are dropped; outside vertices of kept
 * triangles are snapped onto the clip boundary (Newton steps along the clip gradient), which gives clean hems and
 * cuffs instead of voxel staircases. Returns a compacted mesh.
 */
export function clipMesh(mesh, clip, { snap = true } = {}) {
  const P = mesh.positions, N = mesh.normals, I = mesh.indices;
  const nv = P.length / 3;
  const cv = new Float32Array(nv);
  for (let v = 0; v < nv; v++) cv[v] = clip(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
  const keepTri = [];
  const used = new Uint8Array(nv);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const outs = (cv[a] > 0) + (cv[b] > 0) + (cv[c] > 0);
    if (outs === 3) continue;
    // drop slivers that would be squashed to nothing after snapping two vertices
    if (outs === 2 && snap) {
      const inV = cv[a] <= 0 ? a : cv[b] <= 0 ? b : c;
      if (cv[inV] > -1e-4) continue;
    }
    keepTri.push(a, b, c); used[a] = used[b] = used[c] = 1;
  }
  const P2 = new Float32Array(P);
  if (snap) {
    const e = 1e-3;
    for (let v = 0; v < nv; v++) {
      if (!used[v] || cv[v] <= 0) continue;
      let x = P2[v * 3], y = P2[v * 3 + 1], z = P2[v * 3 + 2];
      for (let it = 0; it < 4; it++) {
        const d = clip(x, y, z);
        if (Math.abs(d) < 1e-5) break;
        const gx = (clip(x + e, y, z) - clip(x - e, y, z)) / (2 * e);
        const gy = (clip(x, y + e, z) - clip(x, y - e, z)) / (2 * e);
        const gz = (clip(x, y, z + e) - clip(x, y, z - e)) / (2 * e);
        const g2 = gx * gx + gy * gy + gz * gz || 1;
        x -= gx * d / g2; y -= gy * d / g2; z -= gz * d / g2;
      }
      P2[v * 3] = x; P2[v * 3 + 1] = y; P2[v * 3 + 2] = z;
    }
  }
  return compact({ ...mesh, positions: P2, normals: N }, new Uint32Array(keepTri));
}

/** Drop unreferenced vertices (carries every per-vertex Float32Array field listed in mesh.extra). */
export function compact(mesh, indices) {
  const nv = mesh.positions.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let i = 0; i < indices.length; i++) if (remap[indices[i]] < 0) remap[indices[i]] = n++;
  const out = { positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), indices: new Uint32Array(indices.length), extra: {} };
  const extra = mesh.extra || {};
  for (const k in extra) out.extra[k] = { size: extra[k].size, array: new Float32Array(n * extra[k].size) };
  for (let v = 0; v < nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    for (let c = 0; c < 3; c++) { out.positions[r * 3 + c] = mesh.positions[v * 3 + c]; out.normals[r * 3 + c] = mesh.normals[v * 3 + c]; }
    for (const k in extra) { const s = extra[k].size; for (let c = 0; c < s; c++) out.extra[k].array[r * s + c] = extra[k].array[v * s + c]; }
  }
  for (let i = 0; i < indices.length; i++) out.indices[i] = remap[indices[i]];
  return out;
}

/** Recompute smooth vertex normals from triangles (area weighted). */
export function computeNormals(mesh) {
  const P = mesh.positions, I = mesh.indices, N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { N[o] += fx; N[o + 1] += fy; N[o + 2] += fz; }
  }
  for (let v = 0; v < N.length; v += 3) {
    const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1;
    N[v] /= l; N[v + 1] /= l; N[v + 2] /= l;
  }
  mesh.normals = N;
  return mesh;
}

/** Vertex adjacency lists (CSR) from triangles. */
export function adjacency(nv, I) {
  const deg = new Uint32Array(nv + 1);
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) { deg[I[t + e]] += 2; }
  const start = new Uint32Array(nv + 1);
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
  const fill = new Uint32Array(nv);
  const nb = new Uint32Array(start[nv]);
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = I[t + e], b = I[t + (e + 1) % 3], c = I[t + (e + 2) % 3];
    nb[start[a] + fill[a]++] = b; nb[start[a] + fill[a]++] = c;
  }
  return { start, nb };
}

/** Laplacian-smooth a per-vertex Float32Array field (size components) `passes` times, strength lambda. */
export function smoothField(field, size, adj, passes = 2, lambda = 0.5, mask = null) {
  const nv = field.length / size;
  const tmp = new Float32Array(field.length);
  for (let p = 0; p < passes; p++) {
    for (let v = 0; v < nv; v++) {
      const s = adj.start[v], e = adj.start[v + 1];
      if (e === s || (mask && !mask[v])) { for (let c = 0; c < size; c++) tmp[v * size + c] = field[v * size + c]; continue; }
      for (let c = 0; c < size; c++) {
        let acc = 0;
        for (let k = s; k < e; k++) acc += field[adj.nb[k] * size + c];
        const avg = acc / (e - s);
        tmp[v * size + c] = field[v * size + c] + (avg - field[v * size + c]) * lambda;
      }
    }
    field.set(tmp);
  }
  return field;
}

/**
 * Boundary loops (edges used by exactly one triangle), each as an ordered vertex list. For every loop vertex,
 * `opp[i]` is the opposite vertex of the triangle owning the edge (v_i → v_i+1); it tells which side is interior.
 */
export function boundaryLoops(I) {
  const edge = new Map();
  const key = (a, b) => a < b ? a * 4194304 + b : b * 4194304 + a;
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = I[t + e], b = I[t + (e + 1) % 3], c = I[t + (e + 2) % 3];
    const k = key(a, b);
    const cur = edge.get(k);
    if (cur) cur.n++; else edge.set(k, { a, b, c, n: 1 });
  }
  const next = new Map(), opp = new Map();
  for (const { a, b, c, n } of edge.values()) if (n === 1) { next.set(a, b); opp.set(a, c); }
  const loops = [], seen = new Set();
  for (const s of next.keys()) {
    if (seen.has(s)) continue;
    const loop = [], o = [];
    let v = s, guard = 0;
    while (v !== undefined && !seen.has(v) && guard++ < 1e6) { seen.add(v); loop.push(v); o.push(opp.get(v)); v = next.get(v); }
    if (loop.length > 2) loops.push({ verts: loop, opp: o, closed: v === s });
  }
  return loops;
}

/**
 * Give open garment edges a thickness: every boundary loop gets a rolled hem — a rim ring pushed out past the edge
 * and an inner ring folded back under the cloth — so cuffs and hems read as real doubled fabric instead of paper.
 * `filter(x,y,z)` restricts which loops get a hem. Per-vertex extras are copied from the source vertex.
 */
export function addHems(mesh, t = 0.008, back = 0.02, filter = null) {
  const loops = boundaryLoops(mesh.indices);
  const P = Array.from(mesh.positions), N = Array.from(mesh.normals), I = Array.from(mesh.indices);
  const extra = mesh.extra || {};
  const ex = {};
  for (const k in extra) ex[k] = Array.from(extra[k].array);
  const copyExtra = (v) => { for (const k in extra) { const s = extra[k].size; for (let c = 0; c < s; c++) ex[k].push(ex[k][v * s + c]); } };
  let nv = P.length / 3;
  for (const { verts, opp, closed } of loops) {
    const v0 = verts[0];
    if (filter && !filter(P[v0 * 3], P[v0 * 3 + 1], P[v0 * 3 + 2])) continue;
    const L = verts.length;
    // outward (edge-normal, in the surface plane) direction per loop vertex
    const out = new Float32Array(L * 3);
    for (let i = 0; i < L; i++) {
      const v = verts[i], w = verts[(i + 1) % L], x = opp[i];
      const ex_ = P[w * 3] - P[v * 3], ey = P[w * 3 + 1] - P[v * 3 + 1], ez = P[w * 3 + 2] - P[v * 3 + 2];
      const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      let ox = ey * nz - ez * ny, oy = ez * nx - ex_ * nz, oz = ex_ * ny - ey * nx;
      const mx = (P[v * 3] + P[w * 3]) * 0.5 - P[x * 3], my = (P[v * 3 + 1] + P[w * 3 + 1]) * 0.5 - P[x * 3 + 1], mz = (P[v * 3 + 2] + P[w * 3 + 2]) * 0.5 - P[x * 3 + 2];
      if (ox * mx + oy * my + oz * mz < 0) { ox = -ox; oy = -oy; oz = -oz; }
      const l = Math.hypot(ox, oy, oz) || 1;
      for (const j of [i, (i + 1) % L]) { out[j * 3] += ox / l; out[j * 3 + 1] += oy / l; out[j * 3 + 2] += oz / l; }
    }
    const rim = nv, inner = nv + L;
    for (let i = 0; i < L; i++) {
      const v = verts[i];
      let ox = out[i * 3], oy = out[i * 3 + 1], oz = out[i * 3 + 2];
      const l = Math.hypot(ox, oy, oz) || 1; ox /= l; oy /= l; oz /= l;
      const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      P.push(P[v * 3] + ox * t * 0.45 - nx * t * 0.5, P[v * 3 + 1] + oy * t * 0.45 - ny * t * 0.5, P[v * 3 + 2] + oz * t * 0.45 - nz * t * 0.5);
      N.push(ox, oy, oz); copyExtra(v);
    }
    for (let i = 0; i < L; i++) {
      const v = verts[i];
      let ox = out[i * 3], oy = out[i * 3 + 1], oz = out[i * 3 + 2];
      const l = Math.hypot(ox, oy, oz) || 1; ox /= l; oy /= l; oz /= l;
      const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      P.push(P[v * 3] - nx * t - ox * back, P[v * 3 + 1] - ny * t - oy * back, P[v * 3 + 2] - nz * t - oz * back);
      N.push(-nx, -ny, -nz); copyExtra(v);
    }
    nv += 2 * L;
    const segs = closed ? L : L - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % L;
      const a = verts[i], b = verts[j];
      I.push(a, rim + i, b, b, rim + i, rim + j);
      I.push(rim + i, inner + i, rim + j, rim + j, inner + i, inner + j);
    }
  }
  const outM = { positions: new Float32Array(P), normals: new Float32Array(N), indices: new Uint32Array(I), extra: {} };
  for (const k in extra) outM.extra[k] = { size: extra[k].size, array: new Float32Array(ex[k]) };
  if (mesh.uvs) outM.uvs = mesh.uvs; // (hems are added before UVs in the normal flow)
  return outM;
}

/**
 * Box-projected UVs in metres × scale, with vertices duplicated where triangles choose different projection axes
 * (so the derivative tangent frame never straddles a UV jump). Extras are carried.
 */
export function boxUV(mesh, scale = 1) {
  const P = mesh.positions, N = mesh.normals, I = mesh.indices;
  const extra = mesh.extra || {};
  const map = new Map();
  const outP = [], outN = [], outUV = [], outI = [];
  const ex = {};
  for (const k in extra) ex[k] = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = Math.abs(uy * vz - uz * vy), fy = Math.abs(uz * vx - ux * vz), fz = Math.abs(ux * vy - uy * vx);
    const axis = fx >= fy && fx >= fz ? 0 : fy >= fz ? 1 : 2;
    for (let e = 0; e < 3; e++) {
      const v = I[t + e];
      const key = v * 3 + axis;
      let o = map.get(key);
      if (o === undefined) {
        o = outP.length / 3;
        map.set(key, o);
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        outP.push(x, y, z); outN.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
        if (axis === 0) outUV.push(z * scale, y * scale); else if (axis === 1) outUV.push(x * scale, z * scale); else outUV.push(x * scale, y * scale);
        for (const k in extra) { const s = extra[k].size; for (let cc = 0; cc < s; cc++) ex[k].push(extra[k].array[v * s + cc]); }
      }
      outI.push(o);
    }
  }
  const out = { positions: new Float32Array(outP), normals: new Float32Array(outN), indices: new Uint32Array(outI), uvs: new Float32Array(outUV), extra: {} };
  for (const k in extra) out.extra[k] = { size: extra[k].size, array: new Float32Array(ex[k]) };
  return out;
}

/** Transform a mesh's positions/normals by a Matrix4 in place (mirror-safe: flips winding if det < 0). */
export function transformMesh(mesh, m) {
  const P = mesh.positions, N = mesh.normals;
  const e = m.elements;
  const nm = new THREE.Matrix3().getNormalMatrix(m).elements;
  for (let v = 0; v < P.length; v += 3) {
    const x = P[v], y = P[v + 1], z = P[v + 2];
    P[v] = e[0] * x + e[4] * y + e[8] * z + e[12];
    P[v + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    P[v + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const a = N[v], b = N[v + 1], c = N[v + 2];
    let nx = nm[0] * a + nm[3] * b + nm[6] * c, ny = nm[1] * a + nm[4] * b + nm[7] * c, nz = nm[2] * a + nm[5] * b + nm[8] * c;
    const l = Math.hypot(nx, ny, nz) || 1;
    N[v] = nx / l; N[v + 1] = ny / l; N[v + 2] = nz / l;
  }
  if (m.determinant() < 0) {
    const I = mesh.indices;
    for (let t = 0; t < I.length; t += 3) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; }
  }
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------
// quadric-error-metric decimation (Garland–Heckbert) with flip and link-condition checks
// ---------------------------------------------------------------------------------------------------------------

/**
 * Reduce a triangle mesh to about `targetTris` triangles, keeping detail where curvature is (nose, knuckles, folds).
 * Boundary edges are protected with perpendicular penalty planes. Returns a compacted { positions, indices }
 * (normals are left for the caller: usually re-derived from the SDF gradient).
 */
export function decimate(mesh, targetTris, { closed = true } = {}) {
  const P = Float64Array.from(mesh.positions);
  const F = Int32Array.from(mesh.indices);
  const nv = P.length / 3, nf = F.length / 3;
  if (nf <= targetTris) return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices };
  const Q = new Float64Array(nv * 10);
  // vertex → incident faces, as growable per-vertex arrays
  const vFaces = new Array(nv);
  for (let v = 0; v < nv; v++) vFaces[v] = [];
  const fAlive = new Uint8Array(nf).fill(1);
  const vAlive = new Uint8Array(nv).fill(1);
  const ver = new Uint32Array(nv);
  const addQ = (v, a, b, c, d, w) => {
    const o = v * 10;
    Q[o] += w * a * a; Q[o + 1] += w * a * b; Q[o + 2] += w * a * c; Q[o + 3] += w * a * d;
    Q[o + 4] += w * b * b; Q[o + 5] += w * b * c; Q[o + 6] += w * b * d;
    Q[o + 7] += w * c * c; Q[o + 8] += w * c * d; Q[o + 9] += w * d * d;
  };
  // closed meshes (straight from the polygoniser) have no boundary: skip the edge census entirely
  const edgeCount = closed ? null : new Map();
  const ek = (a, b) => a < b ? a * 4194304 + b : b * 4194304 + a;
  const bump = (x, y) => { const k = ek(x, y); edgeCount.set(k, (edgeCount.get(k) || 0) + 1); };
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    vFaces[a].push(f); vFaces[b].push(f); vFaces[c].push(f);
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!closed) { bump(a, b); bump(b, c); bump(c, a); }
    if (l < 1e-14) continue;
    nx /= l; ny /= l; nz /= l;
    const d = -(nx * P[a * 3] + ny * P[a * 3 + 1] + nz * P[a * 3 + 2]);
    const w = l * 0.5;
    addQ(a, nx, ny, nz, d, w); addQ(b, nx, ny, nz, d, w); addQ(c, nx, ny, nz, d, w);
  }
  // boundary penalty planes keep open edges (hems, cuts) in place
  if (!closed) for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = F[f * 3 + e], b = F[f * 3 + (e + 1) % 3], c = F[f * 3 + (e + 2) % 3];
      if (edgeCount.get(ek(a, b)) !== 1) continue;
      const ex = P[b * 3] - P[a * 3], ey = P[b * 3 + 1] - P[a * 3 + 1], ez = P[b * 3 + 2] - P[a * 3 + 2];
      const ux = P[c * 3] - P[a * 3], uy = P[c * 3 + 1] - P[a * 3 + 1], uz = P[c * 3 + 2] - P[a * 3 + 2];
      const fx = ey * uz - ez * uy, fy = ez * ux - ex * uz, fz = ex * uy - ey * ux;
      let px = fy * ez - fz * ey, py = fz * ex - fx * ez, pz = fx * ey - fy * ex;
      const l = Math.hypot(px, py, pz); if (l < 1e-14) continue;
      px /= l; py /= l; pz /= l;
      const d = -(px * P[a * 3] + py * P[a * 3 + 1] + pz * P[a * 3 + 2]);
      const w = (ex * ex + ey * ey + ez * ez) * 20;
      addQ(a, px, py, pz, d, w); addQ(b, px, py, pz, d, w);
    }
  }
  // --- candidate pool (typed arrays) + binary min-heap of pool indices
  let cap = 1 << 17, pn = 0, hn = 0;
  let eCost = new Float64Array(cap), eU = new Int32Array(cap), eV = new Int32Array(cap), eVu = new Uint32Array(cap), eVv = new Uint32Array(cap), eP = new Float64Array(cap * 3);
  let heap = new Int32Array(cap);
  const grow = () => {
    cap *= 2;
    const g = (A, T, k = 1) => { const B = new T(cap * k); B.set(A); return B; };
    eCost = g(eCost, Float64Array); eU = g(eU, Int32Array); eV = g(eV, Int32Array); eVu = g(eVu, Uint32Array); eVv = g(eVv, Uint32Array);
    eP = g(eP, Float64Array, 3); heap = g(heap, Int32Array);
  };
  const q = new Float64Array(10);
  const pushEdge = (u, v) => {
    for (let i = 0; i < 10; i++) q[i] = Q[u * 10 + i] + Q[v * 10 + i];
    const a11 = q[0], a12 = q[1], a13 = q[2], a22 = q[4], a23 = q[5], a33 = q[7];
    const b1 = -q[3], b2 = -q[6], b3 = -q[8];
    const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
    const mx = (P[u * 3] + P[v * 3]) * 0.5, my = (P[u * 3 + 1] + P[v * 3 + 1]) * 0.5, mz = (P[u * 3 + 2] + P[v * 3 + 2]) * 0.5;
    let x = mx, y = my, z = mz;
    const el = Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
    if (Math.abs(det) > 1e-18) {
      const sx = (b1 * (a22 * a33 - a23 * a23) - a12 * (b2 * a33 - a23 * b3) + a13 * (b2 * a23 - a22 * b3)) / det;
      const sy = (a11 * (b2 * a33 - a23 * b3) - b1 * (a12 * a33 - a23 * a13) + a13 * (a12 * b3 - b2 * a13)) / det;
      const sz = (a11 * (a22 * b3 - b2 * a23) - a12 * (a12 * b3 - b2 * a13) + b1 * (a12 * a23 - a22 * a13)) / det;
      if (Math.hypot(sx - mx, sy - my, sz - mz) < el) { x = sx; y = sy; z = sz; }
    }
    const cost = Math.max(0, q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9]) + el * 1e-9;
    if (pn >= cap) grow();
    const e = pn++;
    eCost[e] = cost; eU[e] = u; eV[e] = v; eVu[e] = ver[u]; eVv[e] = ver[v]; eP[e * 3] = x; eP[e * 3 + 1] = y; eP[e * 3 + 2] = z;
    let i = hn++;
    while (i > 0) { const p = (i - 1) >> 1; if (eCost[heap[p]] <= cost) break; heap[i] = heap[p]; i = p; }
    heap[i] = e;
  };
  const popTop = () => {
    const top = heap[0], last = heap[--hn];
    if (hn > 0) {
      const c = eCost[last];
      let i = 0;
      for (;;) {
        let m = 2 * i + 1; if (m >= hn) break;
        if (m + 1 < hn && eCost[heap[m + 1]] < eCost[heap[m]]) m++;
        if (eCost[heap[m]] >= c) break;
        heap[i] = heap[m]; i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  for (let f = 0; f < nf; f++) for (let e = 0; e < 3; e++) {
    const a = F[f * 3 + e], b = F[f * 3 + (e + 1) % 3];
    // each interior edge appears in two faces with opposite direction: push it once (a < b), boundary edges always
    if (a < b || (!closed && edgeCount.get(ek(a, b)) === 1)) pushEdge(a, b);
  }
  // neighbour marks with stamps (no Set allocation)
  const markU = new Int32Array(nv), markV = new Int32Array(nv);
  let stamp = 0;
  const nbrU = [], nbrV = [];
  const gather = (v, mark, out) => {
    out.length = 0;
    const fl = vFaces[v];
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i]; if (!fAlive[f]) continue;
      for (let e = 0; e < 3; e++) { const w = F[f * 3 + e]; if (w !== v && mark[w] !== stamp) { mark[w] = stamp; out.push(w); } }
    }
  };
  const flips = (v, other, x, y, z) => {
    const fl = vFaces[v];
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i]; if (!fAlive[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === other || b === other || c === other) continue;
      let ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
      const n0x = (by - ay) * (cz - az) - (bz - az) * (cy - ay), n0y = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), n0z = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (a === v) { ax = x; ay = y; az = z; } else if (b === v) { bx = x; by = y; bz = z; } else { cx = x; cy = y; cz = z; }
      const n1x = (by - ay) * (cz - az) - (bz - az) * (cy - ay), n1y = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), n1z = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const l0 = Math.hypot(n0x, n0y, n0z), l1 = Math.hypot(n1x, n1y, n1z);
      if (l1 < 1e-16) return true;
      if ((n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1 + 1e-30) < 0.3) return true;
    }
    return false;
  };
  let alive = nf;
  while (alive > targetTris && hn > 0) {
    const e = popTop();
    const u = eU[e], v = eV[e];
    if (!vAlive[u] || !vAlive[v] || ver[u] !== eVu[e] || ver[v] !== eVv[e]) continue;
    const x = eP[e * 3], y = eP[e * 3 + 1], z = eP[e * 3 + 2];
    // link condition: shared neighbours must be exactly the edge's opposite vertices
    stamp++; gather(u, markU, nbrU);
    if (markU[v] !== stamp) continue;
    gather(v, markV, nbrV);
    let shared = 0; for (let i = 0; i < nbrV.length; i++) if (markU[nbrV[i]] === stamp) shared++;
    let edgeFaces = 0;
    for (const f of vFaces[u]) if (fAlive[f] && (F[f * 3] === v || F[f * 3 + 1] === v || F[f * 3 + 2] === v)) edgeFaces++;
    if (shared !== edgeFaces) continue;
    if (flips(u, v, x, y, z) || flips(v, u, x, y, z)) continue;
    // collapse v → u
    P[u * 3] = x; P[u * 3 + 1] = y; P[u * 3 + 2] = z;
    for (let i = 0; i < 10; i++) Q[u * 10 + i] += Q[v * 10 + i];
    const fu = vFaces[u];
    for (const f of vFaces[v]) {
      if (!fAlive[f]) continue;
      if (F[f * 3] === u || F[f * 3 + 1] === u || F[f * 3 + 2] === u) { fAlive[f] = 0; alive--; continue; }
      for (let k = 0; k < 3; k++) if (F[f * 3 + k] === v) F[f * 3 + k] = u;
      fu.push(f);
    }
    let w = 0; for (let i = 0; i < fu.length; i++) if (fAlive[fu[i]]) fu[w++] = fu[i];
    fu.length = w;
    vAlive[v] = 0; vFaces[v] = [];
    ver[u]++;
    // only edges incident to u changed (its quadric and position); ver[u]++ invalidated their old entries
    stamp++; gather(u, markU, nbrU);
    for (let i = 0; i < nbrU.length; i++) pushEdge(u, nbrU[i]);
  }
  const idx = [];
  for (let f = 0; f < nf; f++) if (fAlive[f]) idx.push(F[f * 3], F[f * 3 + 1], F[f * 3 + 2]);
  return compact({ positions: Float32Array.from(P), normals: new Float32Array(P.length) }, new Uint32Array(idx));
}

function triN(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Snap vertices back onto an SDF surface (Newton steps) and take normals from its gradient. */
export function projectToSDF(mesh, sdf, steps = 2, e = 0.001) {
  const P = mesh.positions, N = mesh.normals.length === P.length ? mesh.normals : (mesh.normals = new Float32Array(P.length));
  const culled = typeof sdf.relevant === 'function';
  const list = culled ? new Int32Array(sdf.items.length) : null;
  let m = 0;
  const f = culled ? (a, b, c) => sdf.subset(list, m, a, b, c) : sdf;
  for (let v = 0; v < P.length; v += 3) {
    let x = P[v], y = P[v + 1], z = P[v + 2], gx = 0, gy = 1, gz = 0;
    if (culled) m = sdf.relevant(x, y, z, 0.012, list);
    for (let it = 0; it <= steps; it++) {
      const d = f(x, y, z);
      gx = f(x + e, y, z) - f(x - e, y, z); gy = f(x, y + e, z) - f(x, y - e, z); gz = f(x, y, z + e) - f(x, y, z - e);
      const l = Math.hypot(gx, gy, gz) || 1; gx /= l; gy /= l; gz /= l;
      if (it === steps) break;
      const step = Math.max(-0.004, Math.min(0.004, d));
      x -= gx * step; y -= gy * step; z -= gz * step;
    }
    P[v] = x; P[v + 1] = y; P[v + 2] = z; N[v] = gx; N[v + 1] = gy; N[v + 2] = gz;
  }
  return mesh;
}

/** polygonize → decimate → re-project: a clean adaptive mesh of an SDF. */
/** Triangle-budget multiplier for every meshSDF call (level-of-detail builds set it < 1 for their duration). */
export const MESH_LOD = { tris: 1 };

export function meshSDF(sdf, min, max, h, targetTris, { refine = 1, project = true } = {}) {
  let m = polygonize(sdf, min, max, h, { refine });
  if (targetTris) targetTris = Math.max(60, Math.round(targetTris * MESH_LOD.tris));
  if (targetTris && m.indices.length / 3 > targetTris * 1.15) m = decimate(m, targetTris);
  if (project) projectToSDF(m, sdf, 1, h * 0.25);
  else computeNormals(m);
  return m;
}
