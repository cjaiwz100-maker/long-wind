// Model skins (owner: character C): dress a procedural character in an authored, rigged GLB (e.g. a Tripo3D model
// with a Mixamo skeleton) while every system keeps driving the contract rig.
//
//   await applyModelSkin(ch, url, opts?)   → ch.skin = { root, bones, update() } ; ch.update() retargets each frame
//
// How it works
//   • The contract rig (skeleton.js) stays the source of truth: the animator, IK, foot planting, hit capsules and
//     the sword socket all keep working on it. The procedural body/garment meshes are hidden, except the pieces
//     that ride the weapon, the scabbard and the tassel (the jian and its fittings stay ours).
//   • The GLB is scaled so its hips match the rig's hip height and placed in the character group.
//   • Retargeting is done in world space: both skeletons rest in a T-pose, so for every mapped bone
//       q_model(world) = q_rig(world) · q_rig(rest)⁻¹ · q_model(rest)
//     and the model's local rotations follow from its parents. Unmapped model bones (Spine1, toe ends) keep
//     their rest pose relative to their parents; fingers get a fixed grip (right) / 剑指 (left) curl.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSkeleton } from './skeleton.js';
import { LAYERS } from '../core/globals.js';
import { createBakedLayer } from './bakedAnim.js';
import { GRIP_R } from './ik.js';
import { retargetMixamo } from './mixamoAnims.js';

const loader = new GLTFLoader();
const cache = new Map();
const mxCache = new Map();   // retargeted Mixamo clips per (model, clip list): tracks address bones by name, so instances share them

/** Contract bone → Mixamo bone (prefix stripped). */
export const MIXAMO_MAP = {
  hips: 'Hips', spine: 'Spine', chest: 'Spine2', neck: 'Neck', head: 'Head',
  'shoulder.L': 'LeftShoulder', 'upperArm.L': 'LeftArm', 'lowerArm.L': 'LeftForeArm', 'hand.L': 'LeftHand',
  'shoulder.R': 'RightShoulder', 'upperArm.R': 'RightArm', 'lowerArm.R': 'RightForeArm', 'hand.R': 'RightHand',
  'upperLeg.L': 'LeftUpLeg', 'lowerLeg.L': 'LeftLeg', 'foot.L': 'LeftFoot', 'toes.L': 'LeftToeBase',
  'upperLeg.R': 'RightUpLeg', 'lowerLeg.R': 'RightLeg', 'foot.R': 'RightFoot', 'toes.R': 'RightToeBase',
};

// finger curls (radians per joint 1/2/3): right = a closed grip round the hilt, left = 剑指 (index + middle straight)
const CURL = {
  R: { Index: [1.15, 1.3, 0.9], Middle: [1.25, 1.35, 0.9], Ring: [1.3, 1.35, 0.9], Pinky: [1.35, 1.3, 0.9], Thumb: [0.35, 0.55, 0.4] },
  L: { Index: [0.05, 0.05, 0.05], Middle: [0.05, 0.05, 0.05], Ring: [1.35, 1.4, 1.0], Pinky: [1.4, 1.4, 1.0], Thumb: [0.55, 0.7, 0.5] },
};

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

function loadGLB(url) {
  if (!cache.has(url)) cache.set(url, loader.loadAsync(url));
  return cache.get(url);
}

/** Keep only the triangles of a skinned mesh whose vertices are driven by one of `keep` bone indices. */
function filterTriangles(mesh, keep) {
  const g = mesh.geometry, si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
  if (!si || !g.index) return false;
  const primary = (v) => { let best = -1, bw = -1; for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > bw) { bw = w; best = si.getComponent(v, k); } } return best; };
  const src = g.index.array, out = [];
  for (let t = 0; t < src.length; t += 3) {
    const a = src[t], b = src[t + 1], c = src[t + 2];
    if (keep.has(primary(a)) && keep.has(primary(b)) && keep.has(primary(c))) out.push(a, b, c);
  }
  if (!out.length) return false;
  const ng = g.clone(); ng.setIndex(out); mesh.geometry = ng;
  return true;
}

/** True when (almost) every vertex hangs off a single joint — a broken export. */
function degenerateWeights(g) {
  const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
  if (!si || !sw) return true;
  const count = new Map();
  for (let v = 0; v < si.count; v += 7) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > bw) { bw = w; best = si.getComponent(v, k); } }
    count.set(best, (count.get(best) ?? 0) + 1);
  }
  const n = Math.ceil(si.count / 7);
  return Math.max(...count.values()) > 0.9 * n;
}

/**
 * Distance-based automatic skinning onto the (Mixamo) skeleton: each vertex is weighted to its nearest bone
 * segments (inverse-distance^6 over the 4 closest, normalised), limbs never cross the body's midline, fingers
 * fold into the hand, and the hem of a robe below the hips blends pelvis ↔ thighs so it follows the legs softly.
 * W: Map bone → bind world matrix (mesh bind space).
 */
function autoSkin(mesh, W) {
  const bones = mesh.skeleton.bones, g = mesh.geometry, pos = g.getAttribute('position');
  const J = (name) => { const b = bones.find((x) => x.name.endsWith(name)); return b ? new THREE.Vector3().setFromMatrixPosition(W.get(b)) : null; };
  const idx = (name) => bones.findIndex((x) => x.name.endsWith(name));
  const segs = [];
  const seg = (bone, a, b, side = 0, r = 1) => { const i = idx(bone), A = J(a), B = typeof b === 'string' ? J(b) : b; if (i >= 0 && A && B) segs.push({ i, A, B, side, r }); };
  seg('Hips', 'Hips', 'Spine'); seg('Spine', 'Spine', 'Spine1'); seg('Spine1', 'Spine1', 'Spine2'); seg('Spine2', 'Spine2', 'Neck');
  seg('Neck', 'Neck', 'Head');
  const head = J('Head'); if (head) seg('Head', 'Head', head.clone().add(new THREE.Vector3(0, 0.22 * (J('Head').y - J('Hips').y), 0)));
  for (const [S, sd] of [['Left', 1], ['Right', -1]]) {
    seg(`${S}Shoulder`, `${S}Shoulder`, `${S}Arm`, sd); seg(`${S}Arm`, `${S}Arm`, `${S}ForeArm`, sd); seg(`${S}ForeArm`, `${S}ForeArm`, `${S}Hand`, sd);
    const hand = J(`${S}Hand`), tip = J(`${S}HandMiddle3`) ?? J(`${S}HandMiddle1`);
    if (hand && tip) seg(`${S}Hand`, `${S}Hand`, tip.clone().addScaledVector(tip.clone().sub(hand).normalize(), 0.03), sd);
    seg(`${S}UpLeg`, `${S}UpLeg`, `${S}Leg`, sd); seg(`${S}Leg`, `${S}Leg`, `${S}Foot`, sd); seg(`${S}Foot`, `${S}Foot`, `${S}ToeBase`, sd);
    const toe = J(`${S}ToeBase`), foot = J(`${S}Foot`);
    if (toe && foot) seg(`${S}ToeBase`, `${S}ToeBase`, toe.clone().addScaledVector(toe.clone().sub(foot).setY(0).normalize(), 0.08), sd);
  }
  // which side is +X? (the model's left arm)
  const lx = Math.sign((J('LeftArm')?.x ?? 1) - (J('Hips')?.x ?? 0)) || 1;
  const hipY = J('Hips').y, crotch = Math.min(J('LeftUpLeg').y, J('RightUpLeg').y);
  const n = pos.count, SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4);
  const v = new THREE.Vector3(), ab = new THREE.Vector3(), av = new THREE.Vector3();
  const cand = [];
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const vside = (v.x - J('Hips').x) * lx;               // > 0: the model's left
    cand.length = 0;
    for (const sg of segs) {
      if (sg.side && Math.sign(vside) !== sg.side && Math.abs(vside) > 0.012) continue;   // no cross-body limbs
      ab.subVectors(sg.B, sg.A); av.subVectors(v, sg.A);
      const t = Math.max(0, Math.min(1, av.dot(ab) / Math.max(1e-9, ab.lengthSq())));
      const d = av.addScaledVector(ab, -t).length() * sg.r;
      cand.push([sg.i, d]);
    }
    cand.sort((a, b) => a[1] - b[1]);
    // merge duplicate bones, keep 4
    const ws = [];
    for (const [bi, d] of cand) { if (ws.find((w) => w[0] === bi)) continue; ws.push([bi, 1 / Math.pow(d + 0.012, 6)]); if (ws.length === 4) break; }
    // robe hem: between the thighs and below the crotch, share with the pelvis so the cloth doesn't tear apart
    if (v.y < crotch && v.y > crotch - 0.55 * (hipY - 0) && Math.abs(vside) < 0.06) {
      const hi = idx('Hips'), k = 1 - Math.abs(vside) / 0.06;
      const tot = ws.reduce((a, w) => a + w[1], 0);
      const h = ws.find((w) => w[0] === hi); if (h) h[1] += tot * k; else { ws.pop(); ws.push([hi, tot * k]); }
    }
    const sum = ws.reduce((a, w) => a + w[1], 0) || 1;
    ws.forEach((w, k) => { SI[i * 4 + k] = w[0]; SW[i * 4 + k] = w[1] / sum; });
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(SW, 4));
}

/**
 * @param {object} ch  character from createCharacter()
 * @param {string} url GLB with a Mixamo-named skeleton in a T-pose
 */
export async function applyModelSkin(ch, url, { map = MIXAMO_MAP, prefix = 'mixamorig:', baked = null, extraAnims = [], mixamo = null } = {}) {
  const gltf = await loadGLB(url);
  // clips borrowed from another Tripo export (same Mixamo skeleton): cloned, with the pelvis height rescaled by the two
  // bodies' mean standing hip height ('idle' in both)
  const animations = [...(gltf.animations ?? [])];
  const hipY = (clips) => {
    const c = clips.find((a) => a.name === 'idle'); const t = c?.tracks.find((x) => /Hips\.position$/.test(x.name));
    if (!t) return 0;
    let sum = 0; for (let i = 1; i < t.values.length; i += 3) sum += t.values[i];
    return sum / (t.values.length / 3);
  };
  for (const u of extraAnims) {
    try {
      const src = await loadGLB(u);
      const k = hipY(src.animations) > 0 && hipY(animations) > 0 ? hipY(animations) / hipY(src.animations) : 1;
      for (const a of src.animations) { const c = a.clone(); c.userData = { hipScale: k }; animations.push(c); }
    } catch (e) { console.warn('[skin] extra animations failed', u, e); }
  }
  const scene = gltf.scene.clone(true);       // SkeletonUtils-free clone is fine: one instance per character
  // cloned skinned meshes must be re-bound to the cloned bones
  const byName = {};
  scene.traverse((o) => { if (o.isBone) byName[o.name] = o; });
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const bones = o.skeleton.bones.map((b) => byName[b.name]);
    // Some exporters (Tripo) leave every joint node at identity and keep the rest pose only in the inverse bind
    // matrices: rebuild each bone's rest transform from them (world_i = IBM_i⁻¹, local_i = world_parent⁻¹·world_i)
    const W = new Map(bones.map((b, i) => [b, o.bindMatrix.clone().multiply(o.skeleton.boneInverses[i].clone().invert())]));
    // ...and may have the skeleton turned about Y relative to the mesh (arms along ∓Z while the mesh's T-pose arms
    // run along ±X). Turn the rest skeleton so its left hand points to the mesh's +X (the character's left).
    const jp = (suffix) => { const b = bones.find((x) => x.name.endsWith(suffix)); return b ? new THREE.Vector3().setFromMatrixPosition(W.get(b)) : null; };
    const lh = jp('LeftHand'), hp = jp('Hips');
    let boneInverses = o.skeleton.boneInverses;
    if (lh && hp) {
      const d = lh.clone().sub(hp); d.y = 0;
      const ang = Math.atan2(d.z, d.x);                        // rotation about +Y taking d onto +X (x′ = x·cos + z·sin)
      if (Math.abs(ang) > 0.2) {
        const R = new THREE.Matrix4().makeRotationY(ang);
        for (const b of bones) W.set(b, R.clone().multiply(W.get(b)));
        boneInverses = bones.map((b) => o.bindMatrix.clone().invert().multiply(W.get(b)).invert());
      }
    }
    const allIdentity = bones.every((b) => b.position.lengthSq() < 1e-12 && Math.abs(b.quaternion.w - 1) < 1e-9);
    if (allIdentity || boneInverses !== o.skeleton.boneInverses) {
      for (const b of bones) {
        const pw = W.get(b.parent);
        const local = pw ? pw.clone().invert().multiply(W.get(b)) : W.get(b);
        local.decompose(b.position, b.quaternion, b.scale);
      }
    }
    o.bind(new THREE.Skeleton(bones, boneInverses), o.bindMatrix);
    if (degenerateWeights(o.geometry)) autoSkin(o, W);
    o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    o.layers.set(LAYERS.ACTORS);
    // own materials per character: a scene clone shares the GLB's, so one enemy's hit flash lit every enemy of the
    // same model (and their flash resets fought over it). Same material type → same program, no extra compile.
    if (Array.isArray(o.material)) o.material = o.material.map((m) => m.clone()); else o.material = o.material.clone();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { m.envMapIntensity = 0.9; if (m.emissive) ch.materials.list.push(m); }
  });
  // GLTFLoader sanitises node names ('mixamorig:Hips' → 'mixamorigHips')
  const mb = (n) => byName[prefix + n] ?? byName[prefix.replace(/[:.]/g, '') + n] ?? byName[n];

  // ---- scale / place: match the hip height of the rig's rest pose ----
  const rest = createSkeleton(ch.scale);        // a pristine rig in its rest (T) pose
  rest.root.updateMatrixWorld(true);
  const restHipY = rest.bones.hips.getWorldPosition(_v).y;
  scene.updateMatrixWorld(true);
  const modelHipY = mb('Hips').getWorldPosition(_v).y;
  const k = restHipY / modelHipY;
  scene.scale.setScalar(k);
  scene.name = 'modelSkin';
  scene.traverse((o) => o.layers.set(LAYERS.ACTORS));
  ch.group.add(scene);
  scene.updateMatrixWorld(true);

  // ---- rest orientations (world, relative to the character group) ----
  const groupInv = new THREE.Matrix4().copy(ch.group.matrixWorld).invert();

  // ---- Mixamo mocap (assets/anims/mixamo.glb) retargeted onto this skeleton while it is still at rest (per model) ----
  if (mixamo?.keys?.length) {
    const ck = `${url}|${mixamo.keys.join(',')}`;
    if (!mxCache.has(ck)) mxCache.set(ck, loadGLB(mixamo.url).then((pack) => retargetMixamo(pack, scene, mb, groupInv, mixamo.keys)));
    try { animations.push(...await mxCache.get(ck)); } catch (e) { console.warn('[skin] mixamo clips failed', e); }
  }
  const pairs = [];
  for (const [rn, mn] of Object.entries(map)) {
    const rb = rest.bones[rn], b = mb(mn), live = ch.rig.bones[rn];
    if (!rb || !b || !live) continue;
    const qRest = rb.getWorldQuaternion(new THREE.Quaternion());
    _m.multiplyMatrices(groupInv, b.matrixWorld).decompose(_p, _q, _s);
    pairs.push({ live, bone: b, off: qRest.clone().invert().multiply(_q.clone()) });
  }
  // parents before children (so each local rotation uses an up-to-date parent)
  const depth = (o) => { let d = 0; while (o.parent) { d++; o = o.parent; } return d; };
  pairs.sort((a, b) => depth(a.bone) - depth(b.bone));
  const hips = pairs.find((p) => p.live === ch.rig.bones.hips);

  // ---- anatomical arms (see fixArm): per side, the rest frames the pass needs, taken while the model is at rest ----
  const armOff = typeof location !== 'undefined' && new URLSearchParams(location.search).get('armfix') === '0';
  // the hand's own axes in its local frame: fingers (to the middle knuckle), across the knuckles toward the index,
  // and the palm normal (the side the thumb sits on) — wrist flexion turns about K, deviation about N
  function handAxes(hand, S) {
    const loc = (n) => { const b = mb(`${S}Hand${n}`); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
    const h = hand.getWorldPosition(new THREE.Vector3()), mid = loc('Middle1'), idx = loc('Index1'), pin = loc('Pinky1'), th = loc('Thumb1');
    if (!mid || !idx || !pin || !th) return {};
    const F = mid.sub(h).normalize(), K = idx.sub(pin); K.addScaledVector(F, -K.dot(F)).normalize();
    const N = new THREE.Vector3().crossVectors(F, K); if (th.sub(h).dot(N) < 0) N.negate();
    const inv = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
    return { axF: F.applyQuaternion(inv), axK: K.applyQuaternion(inv), axN: N.applyQuaternion(inv) };
  }
  const ARMS = armOff ? [] : ['Left', 'Right'].map((S) => {
    const arm = mb(`${S}Arm`), fore = mb(`${S}ForeArm`), hand = mb(`${S}Hand`);
    if (!arm || !fore || !hand) return null;
    const gq = (o) => { _m.multiplyMatrices(groupInv, o.matrixWorld).decompose(_p, _q, _s); return _q.clone(); };
    const gp = (o) => new THREE.Vector3().setFromMatrixPosition(_m.multiplyMatrices(groupInv, o.matrixWorld));
    const Qa0 = gq(arm), Qf0 = gq(fore);
    const u0 = gp(fore).sub(gp(arm)).normalize();
    // the elbow's flexion axis at rest: T-pose, humerus unrotated → the forearm flexes forward (+Z), about the vertical
    const hW = new THREE.Vector3().crossVectors(u0, new THREE.Vector3(0, 0, 1)).normalize();
    const aF = hand.position.clone().normalize();
    return {
      S, arm, fore, hand, aU: fore.position.clone().normalize(), aF,
      hU: hW.clone().applyQuaternion(Qa0.clone().invert()), hF: hW.clone().applyQuaternion(Qf0.clone().invert()),
      hRest: hand.quaternion.clone(), aFinH: aF.clone().applyQuaternion(hand.quaternion.clone().invert()),
      ...handAxes(hand, S),
    };
  }).filter(Boolean);

  // ---- fingers: a fixed curl on top of the rest pose, about the axis across the knuckles ----
  const fingerRest = [];
  for (const side of ['L', 'R']) {
    const S = side === 'L' ? 'Left' : 'Right';
    const hand = mb(`${S}Hand`); if (!hand) continue;
    for (const [f, amts] of Object.entries(CURL[side])) {
      for (let j = 1; j <= 3; j++) {
        const bone = mb(`${S}Hand${f}${j}`); if (!bone) continue;
        // curl axis in world: fingers along ±X, palm down → curl about ∓Z (thumb about the hand's long axis)
        const axW = f === 'Thumb' ? new THREE.Vector3(side === 'L' ? 1 : -1, 0, 0) : new THREE.Vector3(0, 0, side === 'L' ? -1 : 1);
        const qW = bone.getWorldQuaternion(new THREE.Quaternion());
        const axL = axW.clone().applyQuaternion(qW.clone().invert()).normalize();
        bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axL, amts[j - 1]));
        fingerRest.push(bone);
      }
    }
  }

  // ---- hide the procedural body; keep what rides the weapon, scabbard and tassel ----
  const skelBones = ch.rig.skeleton.bones;
  const keep = new Set();
  skelBones.forEach((b, i) => { if (b.name === 'weapon' || b.name === 'offhand' || b.name === 'sheath' || b.name.startsWith('tassel')) keep.add(i); });
  for (const m of ch.meshes) { if (!filterTriangles(m, keep)) m.visible = false; }

  const skinned = []; scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  const mHand = mb('RightHand');
  const oBone = ch.rig.skeleton.bones.find((b) => b.name === 'offhand') ?? null;
  const oOnArm = oBone?.parent === ch.rig.bones['lowerArm.L'];
  const oModel = oBone ? mb(oOnArm ? 'LeftForeArm' : 'LeftHand') : null;
  const oRig = oBone ? ch.rig.bones[oOnArm ? 'lowerArm.L' : 'hand.L'] : null;
  const qG = new THREE.Quaternion(), qParent = new THREE.Quaternion();

  // ---- baked clips (animations shipped in the GLB) ----
  // every model bone's rest local (fingers already curled): unmapped bones return to it each frame before the layers
  const restLocal = [];
  scene.traverse((o) => { if (o.isBone) restLocal.push([o, o.quaternion.clone(), o.position.clone()]); });
  const rFingers = new Set(); mHand?.traverse((o) => { if (o !== mHand && o.isBone) rFingers.add(o); });
  const lFingers = new Set(); mb('LeftHand')?.traverse((o) => { if (o !== mb('LeftHand') && o.isBone) lFingers.add(o); });
  // the sword arm (shoulder → hand): body-only layers keep the animator's world rotations for it
  const armPairs = pairs.filter((p) => ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'].some((n) => p.bone === mb(n)));
  const armSet = new Set(armPairs.map((p) => p.bone));
  // the free arm too, for 'arms' layers (a source whose off hand does something the character never should)
  const lArmPairs = pairs.filter((p) => ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'].some((n) => p.bone === mb(n)));
  const lArmSet = new Set(lArmPairs.map((p) => p.bone));
  for (const p of [...armPairs, ...lArmPairs]) p.wq = new THREE.Quaternion();
  // pelvis and legs: 'upper' layers (a guard held while walking) leave them to the gait
  const legSet = new Set();
  for (const n of ['Hips', 'LeftUpLeg', 'RightUpLeg']) mb(n)?.traverse((o) => { if (o.isBone && (n === 'Hips' ? o === mb('Hips') : true)) legSet.add(o); });
  function reseatArm(w, mask) {
    for (const p of mask === 'arms' ? [...armPairs, ...lArmPairs] : mask === 'left' ? lArmPairs : armPairs) {
      p.bone.parent.getWorldQuaternion(qParent).premultiply(qG);
      _q.copy(qParent.invert().multiply(_q2.copy(p.wq)));
      p.bone.quaternion.slerp(_q, w);
      p.bone.updateWorldMatrix(false, false);
    }
  }
  for (const A of ARMS) A.wrist = A.S === 'Right' ? swordWrist : (oBone && !oOnArm ? null : freeWrist);
  const layer = baked && animations.length
    ? createBakedLayer(scene, animations, baked, { mb, noTrack: (n, spec) => rFingers.has(n) || (spec.jianzhi && lFingers.has(n)), armOut: (n, mask) => (mask === 'upper' ? legSet.has(n) : (mask !== 'left' && armSet.has(n)) || ((mask === 'arms' || mask === 'left') && lArmSet.has(n))), onMasked: reseatArm }) : null;
  // the blade axis in the model hand's frame: rig blade = q_rig·GRIP_R·Z, q_rig = q_model·off⁻¹
  const handPair = pairs.find((p) => p.bone === mHand);
  const bladeInHand = handPair ? new THREE.Vector3(0, 0, 1).applyQuaternion(handPair.off.clone().invert().multiply(GRIP_R)) : null;
  const mArm = mb('RightArm'), mFore = mb('RightForeArm');
  const _sh = new THREE.Vector3(), _el = new THREE.Vector3(), _wr = new THREE.Vector3(), _bw = new THREE.Vector3(), _want = new THREE.Vector3();
  const _qh = new THREE.Quaternion(), _qd = new THREE.Quaternion();
  // A sword grip for clips authored with an empty hand: the blade leaves the fist on the thumb side and leans toward the
  // forearm's line as the arm extends (cuts and thrusts extend the line; a bent, guarding arm cocks the blade up).
  function solveGrip(w) {
    mArm.getWorldPosition(_sh); mFore.getWorldPosition(_el); mHand.getWorldPosition(_wr);
    const upper = _sh.distanceTo(_el), lower = _el.distanceTo(_wr);
    const reach = _sh.distanceTo(_wr) / (upper + lower);
    const fa = _el.sub(_wr).negate().normalize();                    // elbow → wrist
    const beta = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(85, 28, THREE.MathUtils.smoothstep(reach, 0.62, 0.97)));
    mHand.getWorldQuaternion(_qh);
    _bw.copy(bladeInHand).applyQuaternion(_qh);
    _want.copy(_bw).addScaledVector(fa, -_bw.dot(fa));
    if (_want.lengthSq() < 1e-6) return;
    _want.normalize().multiplyScalar(Math.sin(beta)).addScaledVector(fa, Math.cos(beta));
    _qd.setFromUnitVectors(_bw, _want);
    _qd.slerp(_q.identity(), 1 - w);
    _qh.premultiply(_qd);
    mHand.parent.getWorldQuaternion(qParent);
    mHand.quaternion.copy(qParent.invert().multiply(_qh));
    mHand.updateWorldMatrix(false, false);
  }
  // A two-handed pole (spear) over a take shot holding a rifle or staff: the shaft leaves the right fist through the left
  const mLHand = mb('LeftHand'), _lh = new THREE.Vector3();
  function solvePole(w) {
    mHand.getWorldPosition(_wr); mLHand.getWorldPosition(_lh);
    _want.subVectors(_lh, _wr);
    if (_want.lengthSq() < 0.01) return;
    _want.normalize();
    mHand.getWorldQuaternion(_qh);
    _bw.copy(bladeInHand).applyQuaternion(_qh);
    _qd.setFromUnitVectors(_bw, _want);
    _qd.slerp(_q.identity(), 1 - w);
    _qh.premultiply(_qd);
    mHand.parent.getWorldQuaternion(qParent);
    mHand.quaternion.copy(qParent.invert().multiply(_qh));
    mHand.updateWorldMatrix(false, false);
  }
  // Anatomical arms: whatever posed the model (mocap layers, the procedural rig, a grip solve), rebuild each arm's
  // rotations from its joint positions and the hand's orientation, which stay exactly as they were (so the blade, the
  // hurt capsules and the off-hand gear don't move):
  //   • the elbow is a hinge — the upper arm rolls so the forearm bends in its flexion plane (no sideways or backward
  //     kink; near-straight arms keep their roll, and a flipped hinge is corrected at most 90° per frame's solve);
  //   • pronation is shared — the skeleton has no twist bones, so a hand turned about the forearm's axis wrung the
  //     wrist like a towel; PRON of that turn now rides the forearm bone and only the rest stays at the wrist.
  const PRON = 0.6, PRON_MAX = THREE.MathUtils.degToRad(110);
  const _S = new THREE.Vector3(), _E = new THREE.Vector3(), _W = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
  const _n = new THREE.Vector3(), _hc = new THREE.Vector3(), _h = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
  const _t3 = new THREE.Vector3(), _t4 = new THREE.Vector3(), _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4();
  const _Qa = new THREE.Quaternion(), _Qh = new THREE.Quaternion(), _Qa2 = new THREE.Quaternion(), _F0 = new THREE.Quaternion();
  const _Qf2 = new THREE.Quaternion(), _N = new THREE.Quaternion(), _R = new THREE.Quaternion(), _Pq = new THREE.Quaternion();
  /** The rotation taking a bone's local (axis, reference) pair onto a world (axis, reference) pair. */
  function align(aL, hL, aW, hW, out) {
    _t1.copy(hL).addScaledVector(aL, -aL.dot(hL)).normalize(); _t2.crossVectors(aL, _t1);
    _mA.makeBasis(aL, _t1, _t2);
    _t3.copy(hW).addScaledVector(aW, -aW.dot(hW)).normalize(); _t4.crossVectors(aW, _t3);
    _mB.makeBasis(aW, _t3, _t4).multiply(_mA.transpose());
    return out.setFromRotationMatrix(_mB);
  }
  const twistAngle = (q, axis) => { let a = 2 * Math.atan2(q.x * axis.x + q.y * axis.y + q.z * axis.z, q.w); if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };
  function fixArm(A) {
    A.arm.getWorldPosition(_S); A.fore.getWorldPosition(_E); A.hand.getWorldPosition(_W);
    A.arm.getWorldQuaternion(_Qa); A.hand.getWorldQuaternion(_Qh);
    _u.subVectors(_E, _S).normalize(); _f.subVectors(_W, _E).normalize();
    const bend = Math.acos(THREE.MathUtils.clamp(_u.dot(_f), -1, 1));
    // the hinge the upper arm's roll gives now, and the one the arm's plane asks for
    _hc.copy(A.hU).applyQuaternion(_Qa); _hc.addScaledVector(_u, -_u.dot(_hc)).normalize();
    _h.copy(_hc);
    const w = THREE.MathUtils.smoothstep(bend, 0.14, 0.44);   // 8°…25°: a near-straight arm has no plane to speak of
    _n.crossVectors(_u, _f);
    if (w > 0 && _n.lengthSq() > 1e-8) {
      _n.normalize();
      let roll = Math.atan2(_u.dot(_t1.crossVectors(_hc, _n)), _hc.dot(_n));
      roll = THREE.MathUtils.clamp(roll, -Math.PI / 2, Math.PI / 2) * w;
      _h.applyAxisAngle(_u, roll);
    }
    align(A.aU, A.hU, _u, _h, _Qa2);
    // the forearm with no pronation: along the forearm, hinge shared with the upper arm
    align(A.aF, A.hF, _f, _h, _F0);
    _Nn.copy(_F0).multiply(A.hRest);   // the neutral hand on that forearm (world)
    // the wrist: keep it inside its range (sword hand: by turning the fist about the blade and letting the hilt rock
    // in the grip; a free hand: by easing the excess bend)
    let changed = false;
    if (A.axK && A.wrist) changed = A.wrist(A);
    // the hand's turn about the forearm's axis, measured from the neutral hand on that forearm
    _N.copy(_Nn).invert().multiply(_Qh);
    const P = THREE.MathUtils.clamp(twistAngle(_N, A.aFinH) * PRON, -PRON_MAX, PRON_MAX);
    _Qf2.copy(_F0).multiply(_R.setFromAxisAngle(A.aF, P));
    // write the locals (world: upper arm _Qa2, forearm _Qf2, hand unchanged)
    A.arm.parent.getWorldQuaternion(_Pq);
    A.arm.quaternion.copy(_Pq.invert().multiply(_Qa2));
    A.fore.quaternion.copy(_Qa2).invert().multiply(_Qf2);
    A.hand.quaternion.copy(_Qf2).invert().multiply(_Qh);
    A.arm.updateWorldMatrix(false, true);
    return changed;
  }
  // --- the wrist's anatomical range (degrees, relative to the forearm after its share of the pronation):
  //     flexion 70 / extension 60, radial 25 / ulnar 40, and what twist stays at the wrist 45
  const WL = { flex: 70, ext: 60, rad: 25, uln: 40, tw: 45 };
  const _Nn = new THREE.Quaternion(), _D = new THREE.Quaternion(), _Tw = new THREE.Quaternion(), _Hc = new THREE.Quaternion();
  const _wax = new THREE.Vector3(), _B = new THREE.Vector3(), _Rb = new THREE.Quaternion(), _Rn = new THREE.Quaternion();
  const ex2 = (x) => (x > 0 ? x * x : 0);
  /** How far hand orientation H (world) sits outside the wrist's range, on arm A's neutral hand _Nn. */
  function wristCost(A, H) {
    _D.copy(_Nn).invert().multiply(H);
    const tw = twistAngle(_D, A.aFinH), P = THREE.MathUtils.clamp(tw * PRON, -PRON_MAX, PRON_MAX);
    _Tw.setFromAxisAngle(A.aFinH, tw).invert();
    _D.multiply(_Tw);                                         // the swing (hand frame)
    if (_D.w < 0) _D.set(-_D.x, -_D.y, -_D.z, -_D.w);
    const ang = 2 * Math.acos(Math.min(1, _D.w)) * 57.2958, sn = Math.sqrt(Math.max(1e-12, 1 - _D.w * _D.w));
    _wax.set(_D.x / sn, _D.y / sn, _D.z / sn).applyAxisAngle(A.aFinH, -P);   // as seen from the rolled forearm
    const flex = ang * _wax.dot(A.axK), dev = ang * _wax.dot(A.axN), wt = Math.abs(tw - P) * 57.2958;
    return ex2(flex - WL.flex) + ex2(-flex - WL.ext) + ex2(dev - WL.rad) + ex2(-dev - WL.uln) + ex2(wt - WL.tw);
  }
  const D2R = Math.PI / 180, PHI_MAX = 85, DEL_MAX = 30, STEP = 6, RATE = 10;
  /** The sword hand: the blade's direction is kept, the fist may turn about it (φ) and the hilt rock in the grip (δ). */
  function swordWrist(A) {
    if (!ch.sword?.drawn || !bladeInHand) { A.phi = A.del = 0; return false; }
    _B.copy(bladeInHand).applyQuaternion(_Qh);   // _Qh: the hand as posed (H0)
    _Hc.copy(_Qh);
    const cand = (phi, del) => {
      _Rb.setFromAxisAngle(_B, phi * D2R); _Rn.setFromAxisAngle(A.axN, del * D2R);
      _H1.copy(_Rb).multiply(_Hc).multiply(_Rn);
      return wristCost(A, _H1) + 0.01 * (phi * phi + del * del);
    };
    const base = cand(0, 0);
    let bp = A.phi ?? 0, bd = A.del ?? 0, bc = cand(bp, bd);
    const tryAt = (p, d) => { p = THREE.MathUtils.clamp(p, -PHI_MAX, PHI_MAX); d = THREE.MathUtils.clamp(d, -DEL_MAX, DEL_MAX); const c = cand(p, d); if (c < bc - 1e-6) { bc = c; bp = p; bd = d; } };
    if (base < bc) { bc = base; bp = 0; bd = 0; }
    for (const dp of [-STEP, 0, STEP]) for (const dd of [-STEP, 0, STEP]) if (dp || dd) tryAt((A.phi ?? 0) + dp, (A.del ?? 0) + dd);
    if (bc > 50) for (const p of [-80, -60, -40, -20, 0, 20, 40, 60, 80]) for (const d of [-30, -15, 0, 15, 30]) tryAt(p, d);   // far out: look wider
    // move toward the best at a bounded rate (no snapping between frames)
    A.phi = (A.phi ?? 0) + THREE.MathUtils.clamp(bp - (A.phi ?? 0), -RATE, RATE);
    A.del = (A.del ?? 0) + THREE.MathUtils.clamp(bd - (A.del ?? 0), -RATE, RATE);
    let moved = false;
    if (Math.abs(A.phi) < 0.05 && Math.abs(A.del) < 0.05) A.phi = A.del = 0;
    else { _Rb.setFromAxisAngle(_B, A.phi * D2R); _Rn.setFromAxisAngle(A.axN, A.del * D2R); _Qh.copy(_Rb).multiply(_Hc).multiply(_Rn); moved = true; }
    // still out of range and no cut is live (outside the hit windows, the blade's exact line is free): let the hand —
    // and the sword with it — ease back toward a comfortable wrist, as a real swordsman's would
    const an = ch.rig.anim, act = an?.action, m = act?.clip.meta;
    // (a guard or a parry holds its blade line throughout: the line is the move)
    const live = m?.type === 'block' || m?.type === 'parry' || m?.hit?.some(([a, b]) => an.time > a - 0.12 && an.time < b + 0.04);
    if (!live) moved = freeWrist(A) || moved; else A.ease = Math.max(0, (A.ease ?? 0) - 0.08);
    return moved;
  }
  const _H1 = new THREE.Quaternion();
  /** A free hand: ease the bend back toward the neutral hand until the wrist is inside its range. */
  function freeWrist(A) {
    if (wristCost(A, _Qh) < 1) { A.ease = Math.max(0, (A.ease ?? 0) - 0.08); if (!A.ease) return false; }
    else {
      // the smallest pull toward neutral (twist kept) that brings the wrist inside
      _D.copy(_Nn).invert().multiply(_Qh);
      _Hc.copy(_Nn).multiply(_Tw.setFromAxisAngle(A.aFinH, twistAngle(_D, A.aFinH)));   // neutral hand, same twist
      let t = 0; for (const k of [0.15, 0.3, 0.45, 0.6]) { t = k; _H1.copy(_Qh).slerp(_Hc, k); if (wristCost(A, _H1) < 1) break; }
      A.ease = Math.max(t, (A.ease ?? 0) - 0.08);
    }
    _D.copy(_Nn).invert().multiply(_Qh);
    _Hc.copy(_Nn).multiply(_Tw.setFromAxisAngle(A.aFinH, twistAngle(_D, A.aFinH)));
    _Qh.slerp(_Hc, A.ease);
    return true;
  }
  /** Dev/QA: per arm { bend, lateral, pron, wristTwist, wristSwing } in degrees (lateral: out of the hinge plane). */
  function armStats() {
    const o = {}, D = THREE.MathUtils.radToDeg;
    for (const A of ARMS) {
      A.arm.getWorldPosition(_S); A.fore.getWorldPosition(_E); A.hand.getWorldPosition(_W);
      A.arm.getWorldQuaternion(_Qa); A.fore.getWorldQuaternion(_Qf2); A.hand.getWorldQuaternion(_Qh);
      _u.subVectors(_E, _S).normalize(); _f.subVectors(_W, _E).normalize();
      _hc.copy(A.hU).applyQuaternion(_Qa); _hc.addScaledVector(_u, -_u.dot(_hc)).normalize();
      const bend = Math.acos(THREE.MathUtils.clamp(_u.dot(_f), -1, 1)), side = _n.crossVectors(_u, _f).dot(_hc);
      align(A.aF, A.hF, _f, _hc, _F0);
      _N.copy(_F0).invert().multiply(_Qf2);
      const pron = twistAngle(_N, A.aF);
      _N.copy(_Qf2).multiply(A.hRest).invert().multiply(_Qh);
      const tw = twistAngle(_N, A.aFinH);
      // the wrist's swing as a rotation vector in the hand's rest frame, split over the knuckle axis (flexion) and the
      // palm normal (deviation); _N = hand relative to its neutral on this forearm
      let flex = 0, dev = 0;
      if (A.axK) {
        const q = _N.w < 0 ? _Pq.set(-_N.x, -_N.y, -_N.z, -_N.w) : _Pq.copy(_N);
        const ang = 2 * Math.acos(Math.min(1, q.w)), sn = Math.sqrt(Math.max(1e-12, 1 - q.w * q.w));
        _t1.set(q.x / sn, q.y / sn, q.z / sn);
        // q is in the neutral hand's frame, i.e. the hand rest frame: axes axK / axN apply directly
        flex = D(ang * _t1.dot(A.axK)); dev = D(ang * _t1.dot(A.axN));
      }
      o[A.S] = { bend: D(bend) * (side < -0.05 * Math.sin(bend) ? -1 : 1), lateral: D(Math.asin(Math.min(1, Math.abs(_f.dot(_hc))))), pron: D(pron), wristTwist: D(tw), wristSwing: D(2 * Math.acos(Math.min(1, Math.abs(_N.w)))), flex, dev };
    }
    return o;
  }
  // the rig follows the (baked) model pose so the sword socket, scabbard, hurt capsules and cloth ride along
  function rigFromModel() {
    for (const p of pairs) {
      p.bone.getWorldQuaternion(_q).premultiply(qG).multiply(_q2.copy(p.off).invert());
      p.live.parent.getWorldQuaternion(qParent).premultiply(qG);
      p.live.quaternion.copy(qParent.invert().multiply(_q));
      if (p === hips) { p.bone.getWorldPosition(_p); p.live.parent.worldToLocal(_p); p.live.position.copy(_p); }
      p.live.updateWorldMatrix(false, false);
    }
    ch.rig.root.updateMatrixWorld(true);   // sockets, cloth anchors and unmapped rig bones, once
  }
  // hit flinch: the spine bends about a (world) axis, spread over the vertebrae, the head snapping furthest, with a
  // little twist; each bone turns about the axis expressed in its parent's frame so the bend accumulates up the chain
  const FLINCH = [['Spine', 0.14, 0.1], ['Spine1', 0.18, 0.2], ['Spine2', 0.22, 0.3], ['Neck', 0.16, 0.1], ['Head', 0.3, 0.3]]
    .map(([n, w, tw]) => [mb(n), w, tw]).filter(([b]) => b);
  const _ax = new THREE.Vector3(), _up = new THREE.Vector3(), _qa = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qt = new THREE.Quaternion();
  function applyFlinch() {
    for (const [b, w, tw] of FLINCH) {
      b.parent.getWorldQuaternion(_qp);
      const inv = _qt.copy(_qp).invert();
      _ax.copy(skin.flinchAxis).applyQuaternion(inv).normalize();
      _up.set(0, 1, 0).applyQuaternion(inv).normalize();
      _qa.setFromAxisAngle(_ax, skin.flinch * w);
      _q.setFromAxisAngle(_up, skin.flinch * tw * (skin.flinchTwist || 0));
      b.quaternion.premultiply(_qa.multiply(_q));
      b.updateWorldMatrix(false, false);
    }
  }
  const skin = {
    root: scene, scale: k, flinch: 0, flinchAxis: null, flinchTwist: 0,
    /** Dev/QA: each model bone's rest local rotation (fingers curled), e.g. for joint-angle checks. */
    restOf: (b) => restLocal.find((r) => r[0] === b)?.[1],
    armStats, armFixOff: false,
    /** Copy the rig's pose onto the model (call after the animator, before rendering). */
    baked: layer,
    update(dt = 0) {
      ch.group.updateMatrixWorld(true);
      qG.copy(ch.group.getWorldQuaternion(_q2)).invert();
      if (layer) for (const [b, q, pp] of restLocal) { b.quaternion.copy(q); b.position.copy(pp); }
      for (const p of pairs) {
        // world (group-relative) rotation of the rig bone, carried onto the model bone
        p.live.getWorldQuaternion(_q).premultiply(qG).multiply(p.off);
        if (p.wq) p.wq.copy(_q);
        p.bone.parent.getWorldQuaternion(qParent).premultiply(qG);
        p.bone.quaternion.copy(qParent.invert().multiply(_q));
        if (p === hips) {
          // pelvis translation: the rig's hips position (group space) → the model's hips parent space
          p.live.getWorldPosition(_p);
          p.bone.parent.worldToLocal(_p);
          p.bone.position.copy(_p);
        }
        p.bone.updateWorldMatrix(false, false);   // this bone only: children are refreshed once, below
      }
      // mocap actions carry their own travel: the animator's root motion follows the take (contract units)
      const an = ch.rig.anim;
      if (layer && an && !an.rootSource) an.rootSource = (clip, t, out) => (layer.rootAt(clip, t, out) ? (out.multiplyScalar(1 / (an.solver?.s || 1)), true) : false);
      const bw = layer ? layer.update(dt, an) : null;
      if (bw && bw.w > 0 && ch.sword?.drawn && bladeInHand && bw.grip > 0) solveGrip(bw.grip);
      if (bw && bw.pole > 0 && ch.sword?.drawn && bladeInHand && mLHand) solvePole(bw.pole);
      const fl = Math.abs(skin.flinch) > 0.004 && skin.flinchAxis;
      if (fl) applyFlinch();
      let armMoved = false;
      if (ARMS.length && !skin.armFixOff) for (const A of ARMS) armMoved = fixArm(A) || armMoved;
      // the hilt rocking in the grip (sword wrist δ): the blade turns back the other way about the palm normal
      const RA = ARMS.find((A) => A.S === 'Right'), wb0 = ch.sword?.object;
      if (wb0 && ch.sword.drawn && RA && handPair) {
        if (!RA.axNw) RA.axNw = RA.axN.clone().applyQuaternion(handPair.off).applyQuaternion(GRIP_R.clone().invert()).normalize();
        wb0.quaternion.setFromAxisAngle(RA.axNw, -(skin.armFixOff ? 0 : RA.del ?? 0) * D2R);
      }
      if ((bw && bw.w > 0) || fl || armMoved) rigFromModel();
      // the sword rides the rig's hand; the model's forearm may be a little longer or shorter — carry the blade
      // by the difference so it sits in the model's fist (hits sample the same blade, so they stay honest)
      const wb = ch.sword?.object;
      if (wb && ch.sword.drawn && mHand && wb.parent) {
        wb.position.set(0, 0, 0);
        wb.parent.updateMatrixWorld(true);
        mHand.getWorldPosition(_v).sub(ch.rig.bones['hand.R'].getWorldPosition(_p));
        wb.getWorldPosition(_p).add(_v);
        wb.parent.worldToLocal(_p);
        wb.position.copy(_p);
        wb.updateMatrixWorld(true);
      }
      // off-hand gear (bow / shield) rides the rig's left hand or forearm: carry it by the model/rig difference too
      if (oBone && oModel && oRig) {
        oBone.position.set(0, 0, 0);
        oBone.parent.updateMatrixWorld(true);
        oModel.getWorldPosition(_v).sub(oRig.getWorldPosition(_p));
        oBone.getWorldPosition(_p).add(_v);
        oBone.parent.worldToLocal(_p);
        oBone.position.copy(_p);
        oBone.updateMatrixWorld(true);
      }
      // every model bone's world matrix once (fingers, unmapped spine/toes), then push the bone matrices ourselves: the
      // renderer only refreshes a skeleton's bone texture once per info.render.frame, and the app runs with
      // info.autoReset off
      scene.updateMatrixWorld(true);
      for (const m of skinned) m.skeleton.update();
    },
  };
  const baseUpdate = ch.update.bind(ch);
  ch.update = (dt, t) => { skin.update(dt); baseUpdate(dt, t); };
  ch.skin = skin;
  skin.update();
  return skin;
}
