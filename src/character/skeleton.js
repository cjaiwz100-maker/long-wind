// Humanoid skeleton CONTRACT shared by character meshes (C1), the animator (C2) and gameplay (G).
// Owner: integrator. Do not rename bones or change the rest pose without updating every consumer.
//
// Conventions
//  - 1 unit = 1 m, +Y up. Character faces +Z. Character's LEFT is +X, RIGHT is -X.
//  - Rest pose = T-pose. EVERY bone's rest local rotation is IDENTITY, so each bone's local axes equal the
//    character axes in rest pose (X = character left, Y = up, Z = forward). Poses are local rotations.
//      Left arm points +X, right arm points -X, palms face down (-Y), thumbs forward (+Z).
//      Legs point down (-Y). Feet/toes point forward (+Z).
//  - `root` sits on the ground between the feet; gameplay moves/rotates `root` (never hips) in world space.
//    `hips` carries the pelvis translation for animation (bob, crouch, lunges) relative to root.
//  - Sockets are bones with no skin weights: weapon.R (grip center in right fist; blade along +Z, edges ±Y,
//    flat faces ±X in rest pose), weapon.L, sheath (left hip), back (between shoulder blades), hat (crown).
import * as THREE from 'three';

// [name, parent, [x, y, z] offset from parent in rest pose (m)]
export const BONE_DEFS = [
  ['root', null, [0, 0, 0]],
  ['hips', 'root', [0, 0.98, 0]],
  ['spine', 'hips', [0, 0.10, -0.01]],
  ['chest', 'spine', [0, 0.17, 0.0]],
  ['neck', 'chest', [0, 0.24, -0.01]],
  ['head', 'neck', [0, 0.10, 0.02]],
  ['hat', 'head', [0, 0.155, 0.0]],
  ['back', 'chest', [0, 0.10, -0.12]],

  ['shoulder.L', 'chest', [0.03, 0.17, -0.01]],
  ['upperArm.L', 'shoulder.L', [0.16, 0.0, 0.0]],
  ['lowerArm.L', 'upperArm.L', [0.28, 0.0, 0.0]],
  ['hand.L', 'lowerArm.L', [0.25, 0.0, 0.0]],
  ['weapon.L', 'hand.L', [0.085, -0.01, 0.0]],

  ['shoulder.R', 'chest', [-0.03, 0.17, -0.01]],
  ['upperArm.R', 'shoulder.R', [-0.16, 0.0, 0.0]],
  ['lowerArm.R', 'upperArm.R', [-0.28, 0.0, 0.0]],
  ['hand.R', 'lowerArm.R', [-0.25, 0.0, 0.0]],
  ['weapon.R', 'hand.R', [-0.085, -0.01, 0.0]],

  ['upperLeg.L', 'hips', [0.095, -0.06, 0.0]],
  ['lowerLeg.L', 'upperLeg.L', [0.0, -0.43, 0.005]],
  ['foot.L', 'lowerLeg.L', [0.0, -0.405, -0.025]],
  ['toes.L', 'foot.L', [0.0, -0.065, 0.135]],

  ['upperLeg.R', 'hips', [-0.095, -0.06, 0.0]],
  ['lowerLeg.R', 'upperLeg.R', [0.0, -0.43, 0.005]],
  ['foot.R', 'lowerLeg.R', [0.0, -0.405, -0.025]],
  ['toes.R', 'foot.R', [0.0, -0.065, 0.135]],

  ['sheath', 'hips', [0.17, 0.02, 0.03]],
];

export const SOCKETS = ['weapon.R', 'weapon.L', 'sheath', 'back', 'hat'];

/**
 * Build a fresh bone hierarchy in rest pose.
 * @param {number} scale uniform scale (e.g. 1.04 for a bigger bandit). Offsets are scaled; rotations untouched.
 * @returns {{ root: THREE.Bone, bones: Record<string, THREE.Bone>, skeleton: THREE.Skeleton, list: THREE.Bone[] }}
 */
export function createSkeleton(scale = 1) {
  const bones = {};
  const list = [];
  for (const [name, parent, off] of BONE_DEFS) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(off[0] * scale, off[1] * scale, off[2] * scale);
    bones[name] = b;
    list.push(b);
    if (parent) bones[parent].add(b);
  }
  const root = bones.root;
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  return { root, bones, skeleton, list, scale };
}

/**
 * Debug mannequin: rigid capsules parented to bones (no skinning). Lets animation/gameplay work proceed
 * before the real character mesh exists. Returns an Object3D whose child `root` bone drives everything.
 */
export function createMannequin({ color = 0xb9a58a, scale = 1 } = {}) {
  const rig = createSkeleton(scale);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const seg = (bone, child, r) => {
    const a = new THREE.Vector3(), b = child.position.clone();
    const len = b.length();
    const g = new THREE.CapsuleGeometry(r, Math.max(len - 2 * r, 0.01), 4, 10);
    const m = new THREE.Mesh(g, mat);
    m.position.copy(a.lerp(b, 0.5));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().normalize());
    m.castShadow = true;
    bone.add(m);
  };
  const B = rig.bones;
  seg(B.hips, B.spine, 0.13); seg(B.spine, B.chest, 0.14); seg(B.chest, B.neck, 0.15);
  seg(B.neck, B.head, 0.05);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), mat); head.position.y = 0.09; head.castShadow = true; B.head.add(head);
  for (const s of ['L', 'R']) {
    seg(B[`upperArm.${s}`], B[`lowerArm.${s}`], 0.05); seg(B[`lowerArm.${s}`], B[`hand.${s}`], 0.042);
    seg(B[`upperLeg.${s}`], B[`lowerLeg.${s}`], 0.075); seg(B[`lowerLeg.${s}`], B[`foot.${s}`], 0.055);
    seg(B[`foot.${s}`], B[`toes.${s}`], 0.04);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.09), mat);
    hand.position.x = s === 'L' ? 0.08 : -0.08; hand.castShadow = true; B[`hand.${s}`].add(hand);
  }
  // placeholder straight sword on weapon.R: blade along +Z
  const sword = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.035, 0.78), new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 1, roughness: 0.25 }));
  blade.position.z = 0.47; sword.add(blade);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.2, 8), new THREE.MeshStandardMaterial({ color: 0x2a1a12 }));
  grip.rotation.x = Math.PI / 2; grip.position.z = 0.0; sword.add(grip);
  B['weapon.R'].add(sword);
  const group = new THREE.Group();
  group.add(rig.root);
  return { group, ...rig, sword };
}
