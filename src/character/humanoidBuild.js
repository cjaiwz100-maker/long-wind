// Character data builder (owner: character C). Pure: runs in a worker (humanoidWorker.js) or inline.
// buildCharacterData(kind, seed) → {
//   kind, seed, scale, packed (per-material typed arrays, see humanoidAssembly.js),
//   rig: RigSpec JSON (extras, chains, links), bindInverses: Float32Array(16 × 27) for the contract bones,
//   weapon: { bone, base, tip, mount, sheathFrame: number[16], tassel: chain name | null },
//   build (body params), stats (triangles per material), ms (build time)
// }
import * as THREE from 'three';
import { buildBody, bodyBuild, skinMesh, BONE_INDEX, BONE_NAMES } from './humanoid.js';
import { Assembly } from './humanoidAssembly.js';
import { RigSpec } from './humanoidRig.js';
import { recipe } from './outfitsRecipes.js';
import { buildWeapon, buildOffhand, tasselMesh } from './sword.js';
import { skinRigid, xform, tube, paint, merge } from './outfitsKit.js';
import { COL } from './cloth.js';
import { mulberry32 } from '../core/noise.js';
import { MESH_LOD } from './humanoidSdf.js';

/** Number of distinct body shapes per bandit pool (bodies are cached per shape). */
const BANDIT_BODIES = 3;

/** lod 0 = full detail; lod 1 = the distant version (same rig, ~28% of the triangles). */
export function buildCharacterData(kind = 'hero', seed = 1, lod = 0) {
  const prevLod = MESH_LOD.tris;
  MESH_LOD.tris = lod ? 0.28 : 1;
  try { return buildCharacterDataAt(kind, seed); } finally { MESH_LOD.tris = prevLod; }
}

function buildCharacterDataAt(kind, seed) {
  const t0 = performance.now();
  const rng = mulberry32(9173 + seed * 7919 + kind.length * 131);
  const bodyRng = kind === 'bandit' ? mulberry32(4441 + (seed % BANDIT_BODIES) * 1013) : mulberry32(4441 + kind.length * 17);
  const b = bodyBuild(kind, bodyRng);
  const rec = recipe(kind, rng);
  const body = buildBody({ kind, build: b, handPoses: rec.hands, faceSeed: bodyRng(), skin: rec.skin });
  const s = b.scale;
  const rig = new RigSpec();
  const asm = new Assembly();
  const ctx = { kind, seed, rng, b, s, bind: body.bind, J: body.bind.J, prims: body.prims, weightsAt: body.weightsAt, rig, asm };

  // --- skin: visible body parts, head, hands
  const W = (x, y, z) => body.weightsAt(x, y, z);
  for (const part of [body.body, body.head, body.hands.L, body.hands.R]) {
    if (!part.positions.length) continue;
    skinMesh(part, W, { passes: 2 });
    part.extra.skinIndex = { size: 4, array: part.skin.index };
    part.extra.skinWeight = { size: 4, array: part.skin.weight };
    asm.add('skin', part, { cloth: [1, 0, 1, 1], uvScale: 8 });
  }

  // --- weapon (a rigid extra bone re-parented between the hand and the scabbard at runtime)
  const wBone = rig.rigid('weapon', 'weapon.R');
  const wp = buildWeapon(rec.weapon.type, { ...rec.weapon.opts, s });
  for (const { mat, mesh } of wp.parts) { skinRigid(mesh, wBone); asm.add(mat, mesh, { uvScale: 20 }); }
  let tasselName = null;
  if (wp.tassel) {
    tasselName = 'tassel';
    const c = rig.chain({ name: 'tassel', parent: 'weapon', nodes: wp.tassel.nodes, pin: [1], side: [1, 0, 0], radius: 0.012, mask: COL.LEGS | COL.PELVIS, drag: 1.5, stiff: 0.1, flutter: 1.0, gravity: 1 });
    asm.add('cloth', tasselMesh(wp.tassel, c.bone0), { uvScale: 30 });
  }
  // scabbard (mount-local → bind: mount bones have identity bind rotation)
  const mount = wp.sheath?.mount ?? 'sheath';
  const mountM = new THREE.Matrix4().makeTranslation(body.bind.J[mount].x, body.bind.J[mount].y, body.bind.J[mount].z);
  const frame = wp.sheath?.frame ?? new THREE.Matrix4();
  for (const [mat, mesh] of wp.sheath?.parts ?? []) {
    xform(mesh, frame); xform(mesh, mountM);
    skinRigid(mesh, BONE_INDEX[mount]);
    asm.add(mat, mesh, { uvScale: 10 });
  }
  if (wp.hangers) {
    // two short cords from the scabbard rings up to the sash
    const cords = [];
    for (const f of [0.22, 0.38]) {
      const a = new THREE.Vector3(0, 0.03, 0.1 + f).applyMatrix4(frame);
      const b2 = a.clone().add(new THREE.Vector3(-0.035 * s, 0.075 * s, 0.01));
      cords.push(tube([a.toArray(), [a.x - 0.01, (a.y + b2.y) / 2, a.z + 0.004], b2.toArray()], 0.0028, { sides: 5, samples: 8 }));
    }
    const cm = merge(cords);
    paint(cm, { color: [0.03, 0.02, 0.015], color2: [0.02, 0.015, 0.01], cloth: [0, 0, 1, 0.8] });
    xform(cm, mountM);
    skinRigid(cm, BONE_INDEX[mount]);
    asm.add('leather', cm, { uvScale: 30 });
  }

  // --- off-hand gear (bow in the left fist, shield on the left forearm): rigid on an 'offhand' extra bone
  if (rec.offhand) {
    const oh = buildOffhand(rec.offhand, { s });
    const oBone = rig.rigid('offhand', oh.parent);
    for (const { mat, mesh } of oh.parts) { skinRigid(mesh, oBone); asm.add(mat, mesh, { uvScale: 20 }); }
  }

  // --- garments, hair, headwear
  rec.dress(ctx);

  const packed = asm.pack();
  const inv = new Float32Array(16 * BONE_NAMES.length);
  body.bind.inverses.forEach((m, i) => inv.set(m.elements, i * 16));
  return {
    kind, seed, scale: s, build: b, packed, rig: rig.toJSON(), bindInverses: inv,
    weapon: { bone: wBone, base: wp.base, tip: wp.tip, mount, sheathFrame: frame.toArray(), tassel: tasselName, type: wp.type, twoHandGap: wp.twoHandGap ?? 0.105 },
    stats: asm.stats(), ms: Math.round(performance.now() - t0),
  };
}
