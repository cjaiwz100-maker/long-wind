// Mixamo clips (owner: character C): mocap takes downloaded from Mixamo (X Bot, T-pose rest; packed by
// tools/mixamo/convert.mjs into assets/anims/mixamo.glb) retargeted onto a model skin's own skeleton, so the baked
// layer (bakedAnim.js) can play them exactly like the clips that ship inside the skin's GLB.
//
//   const clips = retargetMixamo(pack, modelScene, mb, groupInv, keys)   → AnimationClip[] named 'mx:<key>'
//   (a skeleton with other bone names, e.g. the procedural contract rig: pass { nameOf: bone → Mixamo short name | null })
//
// Retargeting is done in world space against both rest (T) poses: every source bone's rotation away from its rest,
//   D = W_src(t) · S⁻¹        (S = source rest, world)
// is applied to the target bone's rest, W_tgt = D · T, and the target's local rotation follows from its (retargeted)
// parent. Facing is matched by a yaw that takes the source's left→right shoulder line onto the target's. The pelvis
// translation is the source's offset from its rest, scaled by the two hip heights, in the target hips' parent space.
import * as THREE from 'three';

const _q = new THREE.Quaternion(), _v = new THREE.Vector3();

/** Short Mixamo name ('mixamorig:LeftArm' / 'mixamorigLeftArm' → 'LeftArm'). */
const short = (n) => n.replace(/^mixamorig[:_]?/, '');

/**
 * @param {{ scene: THREE.Object3D, animations: THREE.AnimationClip[] }} pack  the loaded mixamo.glb
 * @param {THREE.Object3D} target   the model skin's scene (bones at rest, world matrices current)
 * @param {(name: string) => THREE.Object3D} mb  target bone by short Mixamo name
 * @param {THREE.Matrix4} groupInv  inverse world matrix of the character group (the frame both rests are compared in)
 * @param {string[]} keys  which clips to retarget (manifest keys; ['*'] = all)
 * @param {{ nameOf?: (bone: THREE.Object3D) => string | null }} [opts]  target bone → Mixamo short name (default: its own)
 */
export function retargetMixamo(pack, target, mb, groupInv, keys, { nameOf = null } = {}) {
  // --- source skeleton at rest (world = relative to the pack's scene root)
  const src = [];
  pack.scene.updateMatrixWorld(true);
  const srcRoot = pack.scene;
  const srcByShort = {};
  srcRoot.traverse((o) => { if (o.isBone || /^mixamorig/.test(o.name)) { srcByShort[short(o.name)] = o; } });
  const hipsS = srcByShort.Hips;
  hipsS.traverse((o) => {
    const S = o.getWorldQuaternion(new THREE.Quaternion());
    src.push({ o, name: short(o.name), S, Sinv: S.clone().invert(), restL: o.quaternion.clone(), parent: src.find((p) => p.o === o.parent) ?? null });
  });
  const srcHipRest = hipsS.getWorldPosition(new THREE.Vector3());

  // --- target skeleton at rest, in the character group's frame
  target.updateMatrixWorld(true);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const worldQ = (o) => { m.multiplyMatrices(groupInv, o.matrixWorld).decompose(p, _q, s); return _q.clone(); };
  const worldP = (o) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(groupInv);
  const hipsT = mb('Hips');
  const tgt = [];
  hipsT.traverse((o) => {
    if (!o.isBone && !/^mixamorig/.test(o.name)) return;
    const nm = nameOf ? nameOf(o) : short(o.name);
    const sb = nm ? src.find((x) => x.name === nm) : null;
    tgt.push({ o, name: short(o.name), T: worldQ(o), restL: o.quaternion.clone(), src: sb ?? null, parent: null });
  });
  for (const t of tgt) t.parent = tgt.find((x) => x.o === t.o.parent) ?? null;
  const hipsParentQ = worldQ(hipsT.parent);
  const hipsParentM = new THREE.Matrix4().multiplyMatrices(groupInv, hipsT.parent.matrixWorld);
  const hipsParentInv = hipsParentM.clone().invert();
  const tgtHipRest = worldP(hipsT);

  // --- facing: the yaw taking the source's right→left shoulder line onto the target's
  const line = (a, b) => { const d = b.clone().sub(a); d.y = 0; return d.normalize(); };
  const sL = line(srcByShort.RightArm.getWorldPosition(new THREE.Vector3()), srcByShort.LeftArm.getWorldPosition(new THREE.Vector3()));
  const tL = line(worldP(mb('RightArm')), worldP(mb('LeftArm')));
  const R = new THREE.Quaternion().setFromUnitVectors(sL, tL);
  const Rinv = R.clone().invert();
  // hip heights above the ground (both skeletons stand on y = 0 at rest)
  const hipK = tgtHipRest.y / Math.max(1e-6, srcHipRest.y);

  const out = [];
  if (keys.includes('*')) keys = pack.animations.map((a) => a.name);
  for (const key of keys) {
    const clip = pack.animations.find((a) => a.name === key);
    if (!clip) { console.warn('[mixamo] no clip', key); continue; }
    const its = {};
    let times = null, posIt = null;
    for (const tr of clip.tracks) {
      const dot = tr.name.lastIndexOf('.'), node = short(tr.name.slice(0, dot)), prop = tr.name.slice(dot + 1);
      if (prop === 'quaternion') { its[node] = tr.createInterpolant(); if (!times || tr.times.length > times.length) times = tr.times; }
      else if (prop === 'position' && node === 'Hips') posIt = tr.createInterpolant();
    }
    if (!times) continue;
    // resample every track on one clock (optimize() may have thinned some)
    const n = times.length;
    const Wsrc = new Map(), qs = tgt.map(() => new Float32Array(n * 4)), pos = new Float32Array(n * 3);
    const Wt = new Map();
    const q = new THREE.Quaternion(), D = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const t = times[i];
      // source world rotations down the hierarchy
      for (const b of src) {
        const it = its[b.name];
        const L = it ? q.fromArray(it.evaluate(t)) : b.restL;
        const W = Wsrc.get(b) ?? new THREE.Quaternion(); Wsrc.set(b, W);
        W.copy(b.parent ? Wsrc.get(b.parent) : b.o.parent.getWorldQuaternion(_q)).multiply(L);
      }
      // target world = (R · W_src · S⁻¹ · R⁻¹) · T ; unmatched bones keep their rest local under their parent
      for (let k = 0; k < tgt.length; k++) {
        const t2 = tgt[k];
        const W = Wt.get(t2) ?? new THREE.Quaternion(); Wt.set(t2, W);
        const pW = t2.parent ? Wt.get(t2.parent) : hipsParentQ;
        if (t2.src) {
          D.copy(R).multiply(Wsrc.get(t2.src)).multiply(t2.src.Sinv).multiply(Rinv);
          W.copy(D).multiply(t2.T);
        } else W.copy(pW).multiply(t2.restL);
        // local = parentWorld⁻¹ · world, sign-continuous with the previous key
        const L = _q.copy(pW).invert().multiply(W);
        const a = qs[k];
        if (i > 0 && a[(i - 1) * 4] * L.x + a[(i - 1) * 4 + 1] * L.y + a[(i - 1) * 4 + 2] * L.z + a[(i - 1) * 4 + 3] * L.w < 0) { L.x = -L.x; L.y = -L.y; L.z = -L.z; L.w = -L.w; }
        a[i * 4] = L.x; a[i * 4 + 1] = L.y; a[i * 4 + 2] = L.z; a[i * 4 + 3] = L.w;
      }
      // pelvis: the source's offset from its rest, turned and scaled onto the target's rest, in the hips' parent space
      const sp = posIt ? _v.fromArray(posIt.evaluate(t)) : _v.copy(srcHipRest);
      sp.sub(srcHipRest).applyQuaternion(R).multiplyScalar(hipK).add(tgtHipRest).applyMatrix4(hipsParentInv);
      pos[i * 3] = sp.x; pos[i * 3 + 1] = sp.y; pos[i * 3 + 2] = sp.z;
    }
    const tracks = [new THREE.VectorKeyframeTrack(`${hipsT.name}.position`, times, pos)];
    tgt.forEach((t2, k) => { if (t2.src && its[t2.src.name]) tracks.push(new THREE.QuaternionKeyframeTrack(`${t2.o.name}.quaternion`, times, qs[k])); });
    const c = new THREE.AnimationClip(`mx:${key}`, clip.duration, tracks);
    c.userData = { mixamo: true };
    out.push(c);
  }
  return out;
}
