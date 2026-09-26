// Character factory (owner: character C). Real procedural wuxia characters behind the CONTRACTS API:
//
//   const ch = await createCharacter({ kind: 'hero' | 'bandit' | 'bandit_heavy' | 'swordmaster', seed: 1 });
//   ch.group            Object3D (gameplay sets group.position / group.rotation.y)
//   ch.rig              { root, bones, skeleton } — the contract skeleton (skeleton.js); bones by contract name
//   ch.sword            { object, base, tip, setDrawn(bool), drawn } — base/tip = blade segment for hits/trails
//   ch.update(dt, t)    secondary motion (skirts, sleeves, sash tails, hair, tassel, headband tails) — AFTER the animator
//   ch.hurtCapsules(out = [])   world-space [{a, b, r, part}] (objects are reused frame to frame)
//   ch.flash(color?, strength?); ch.setVisible(bool); ch.dispose()
//   extras: ch.resetCloth(), ch.stats (triangles per material), ch.meshes, ch.materials, ch.cloth, ch.kind, ch.seed
//
// Pipeline: geometry is built by a small worker pool (humanoidWorker.js → humanoidBuild.js: SDF body, garments,
// hat, hair, weapon; ~8 SkinnedMeshes, one per material) and cached per (kind, seed). The main thread only makes
// the skeleton (contract bones + cloth-chain bones + the weapon frame), the materials (charmat.js) and the cloth
// simulation (cloth.js).
import * as THREE from 'three';
import { createSkeleton } from './skeleton.js';
import { buildMeshes } from './humanoidAssembly.js';
import { ClothSim, COL, makeSimBone } from './cloth.js';
import { createCharMaterials, createCharUniforms } from './charmat.js';
import { windVector } from '../core/wind.js';
import { G, LAYERS } from '../core/globals.js';
import { applyModelSkin } from './modelSkin.js';

/** Authored, rigged GLB skins per kind (Tripo3D model, Mixamo skeleton). `?skin=0` falls back to the procedural body. */
const MODEL_SKINS = {
  hero: 'assets/models/hero-tripo.glb',
  bandit: 'assets/models/enemy-bandit.glb',
  bandit_heavy: 'assets/models/enemy-shieldman.glb',
  spearman: 'assets/models/enemy-spearman.glb',
  archer: 'assets/models/enemy-archer.glb',
  shieldman: 'assets/models/enemy-shieldman.glb',
  swordmaster: 'assets/models/enemy-swordmaster.glb',
  assassin: 'assets/models/enemy-assassin.glb',
};

/**
 * Baked clips per game clip, layered over the procedural animator (bakedAnim.js): src = an animation name prefix in the
 * skin's GLB (Tripo Animate), or 'mx:<key>' = a Mixamo mocap take (tools/mixamo → assets/anims/mixamo.glb, retargeted
 * onto each skin at load by mixamoAnims.js). Actions map [t0, t1] of the take onto the game clip, with `key`/`keys`
 * (the take's strike instants) landing mid hit window; travelling takes drive the root motion (their own footwork).
 * mask 'body': the weapon arm stays with the animator (the Tripo presets are empty-handed: swung arms whipped the blade
 * round, and the flinching hands drove it through the head); grip 'hand': the take was shot holding a weapon.
 */
// Falls, deaths and the get-up for everyone: the Tripo 'fall' preset curled into a kneeling heap and never lay down;
// these topple and lie out, and the get-up starts from that lying pose.
const FALLS = {
  knockdown: { src: 'mx:fallBackDeath', t0: 0.12, t1: 1.75, fade: 0.08 },        // reel back, feet go up, flat on the back
  getUp: { src: 'mx:getUp', t0: 0.15, t1: 2.45, fade: 0.2 },                     // from the back: roll up, crouch, stand
  death: { src: 'mx:fallFwdDeath', t0: 0.05, t1: 2.5, fade: 0.1 },               // folds at the knees, slumps forward
  deathBack: { src: 'mx:fallBackDeath', t0: 0.05, t1: 2.2, fade: 0.1 },
  deathLaunch: { src: 'mx:flyingBackDeath', t0: 0.1, t1: 2.9, fade: 0.12, root: false },   // gameplay throws the body
};
const ENEMY_BAKED = {
  walk: { src: 'walk', rate: 'speed', fade: 0.25, mask: 'body' },
  run: { src: 'run', rate: 'speed', fade: 0.2, mask: 'body' },
  sprint: { src: 'run', rate: 'speed', fade: 0.2, mask: 'body' },
  hitFront: { src: 'hit_to_body_01', t0: 0.05, t1: 1.1, fade: 0.06, mask: 'body' },
  hitBack: { src: 'hit_to_body_01', t0: 0.05, t1: 1.1, fade: 0.06, mask: 'body' },
  hitHeavy: { src: 'hit_to_head', t0: 0.05, t1: 1.6, fade: 0.06, mask: 'body' },
  ...FALLS,
};
/** A looping take that follows the gait speed (locomotion). */
const gait = (src, fade = 0.25, extra = {}) => ({ src, rate: 'speed', fade, grip: 'hand', ...extra });
// bandits (and the heavy): a one-handed-axe fighter's mocap — the dao hangs low and heavy, every swing is a haymaker
const BANDIT_BAKED = {
  ...ENEMY_BAKED,
  combatIdle: { src: 'mx:axeIdle', loop: true, fade: 0.3, grip: 'hand' },
  walk: gait('mx:axeWalk'), run: gait('mx:axeRun', 0.2), sprint: gait('mx:axeRun', 0.2),
  walkBack: gait('mx:axeWalkBack'), strafeL: gait('mx:axeWalkL'), strafeR: gait('mx:axeWalkR'),
  enemyAttack1: { src: 'mx:axeHorizontal', t0: 0.35, t1: 1.75, key: 0.93, fade: 0.12, grip: 'hand' },   // R→L haymaker
  enemyAttack2: { src: 'mx:axeSpin', t0: 0.3, t1: 1.8, key: 1.03, fade: 0.12, grip: 'hand' },            // spinning L→R
  enemyHeavy: { src: 'mx:axeDown', t0: 0.05, t1: 1.9, key: 0.83, fade: 0.12, grip: 'hand' },             // overhead chop
  enemyThrust: { src: 'mx:thrustSlash', t0: 0.1, t1: 1.6, key: 0.85, fade: 0.12, grip: 'hand', align: true },
  block: { src: 'mx:axeBlock', loop: true, fade: 0.1, grip: 'hand', mask: 'upper' },
  taunt: { src: 'mx:axeBattlecry', t0: 0, t1: 2.8, fade: 0.2, grip: 'hand' },
  hitFront: { src: 'mx:axeHitGut', t0: 0, t1: 1.3, fade: 0.06, grip: 'hand' },
};
// the shieldman: sword-and-shield mocap (the rattan shield rides the left forearm through all of it)
const SHIELD_BAKED = {
  ...ENEMY_BAKED,
  combatIdle: { src: 'mx:ssIdle', loop: true, fade: 0.3, grip: 'hand' },
  walk: gait('mx:ssWalk'), run: gait('mx:ssRun', 0.2), sprint: gait('mx:ssRun', 0.2),
  walkBack: gait('mx:ssWalkBack'), strafeL: gait('mx:ssStrafeL'), strafeR: gait('mx:ssStrafeR'),
  shieldGuard: { src: 'mx:ssBlockIdle', loop: true, fade: 0.15, grip: 'hand', mask: 'upper' },   // held over the walk
  blockHit: { src: 'mx:ssBlockedImpact', t0: 0, t1: 0.75, fade: 0.05, grip: 'hand' },
  shieldBash: { src: 'mx:ssKick', t0: 0, t1: 1.15, key: 0.55, fade: 0.1, grip: 'hand' },   // shield up, boot in the gut
  enemyAttack1: { src: 'mx:ssDownSlash', t0: 0, t1: 1.45, key: 0.6, fade: 0.12, grip: 'hand' },
  enemyAttack2: { src: 'mx:ssCrossSlash', t0: 0.1, t1: 1.5, key: 0.83, fade: 0.12, grip: 'hand' },
  hitFront: { src: 'mx:ssImpact', t0: 0, t1: 0.95, fade: 0.06, grip: 'hand' },
  hitHeavy: { src: 'mx:ssHeadImpact', t0: 0, t1: 0.7, fade: 0.06, grip: 'hand' },
};
// the archer (blade sheathed, bow in the left hand): longbow mocap — reach to the quiver, nock, draw, loose
const ARCHER_BAKED = {
  ...ENEMY_BAKED,
  idle: { src: 'mx:bowIdle', loop: true, fade: 0.3 }, combatIdle: { src: 'mx:bowIdle', loop: true, fade: 0.3 },
  walk: gait('mx:bowWalk'), run: gait('mx:bowRun', 0.2), sprint: gait('mx:bowRun', 0.2),
  'walk~free': gait('mx:bowWalk'), 'run~free': gait('mx:bowRun', 0.2), 'sprint~free': gait('mx:bowRun', 0.2),
  walkBack: gait('mx:bowWalkBack'), strafeL: gait('mx:bowWalkL'), strafeR: gait('mx:bowWalkR'),
  // reach to the quiver, nock, draw (the telegraph), loose on the clip's shootAt (a composite take, tools/mixamo)
  bowShot: { src: 'mx:bowShotFull', t0: 0, t1: 2.63, sync: [[0.8, 1.9], [1.12, 2.31]], fade: 0.15 },
  enemyKick: { src: 'mx:axeKick', t0: 0.2, t1: 1.5, key: 0.75, fade: 0.1, mask: 'arms' },
  hitFront: { src: 'mx:bowHit', t0: 0, t1: 1.2, fade: 0.06 },
  death: { src: 'mx:bowDeath', t0: 0, t1: 3.0, fade: 0.1 }, deathBack: { src: 'mx:bowDeath', t0: 0, t1: 3.0, fade: 0.1 },
};
// the spearman: bayonet / staff mocap, the shaft laid from fist to fist
const SPEAR_BAKED = {
  ...ENEMY_BAKED,
  enemyThrust: { src: 'mx:bayonetStab', t0: 0.3, t1: 1.8, key: 1.0, fade: 0.12, grip: 'pole' },
  spearJab2: { src: 'mx:bayonetSlash', t0: 0.2, t1: 1.9, keys: [0.75, 1.3], fade: 0.12, grip: 'pole' },
};
// the two bosses: the hero's sword mocap at enemy pacing (long windups: the telegraph)
const DUEL_BAKED = {
  enemyAttack1: { src: 'mx:ssSlash', t0: 0, t1: 1.4, key: 0.7, fade: 0.12, grip: 'hand', jianzhi: true },
  enemyAttack2: { src: 'mx:inwardSlash', t0: 0.4, t1: 1.9, key: 1.2, fade: 0.12, grip: 'hand' },
  enemyThrust: { src: 'mx:thrustSlash', t0: 0.1, t1: 1.6, key: 0.85, fade: 0.12, grip: 'hand', align: true },
  enemyHeavy: { src: 'mx:ssJumpAttack', t0: 0, t1: 2.0, key: 1.2, fade: 0.12, grip: 'hand', jianzhi: true },
  bossFlurry: { src: 'mx:oneHandCombo', t0: 0.5, t1: 3.5, keys: [1.0, 2.01, 3.0], fade: 0.12, grip: 'hand' },
  bossDash: { src: 'mx:ssHighAttack', t0: 0.1, t1: 1.2, key: 0.57, fade: 0.1, grip: 'hand', jianzhi: true, align: true },
  bossLeap: { src: 'mx:ssJumpAttack', t0: 0, t1: 2.2, key: 1.2, fade: 0.1, grip: 'hand', jianzhi: true },
  bossQi: { src: 'mx:ssPowerSlash', t0: 0.5, t1: 2.1, fade: 0.1, grip: 'hand', jianzhi: true },
};
// the swordmaster borrows three bodies from the hero's library (EXTRA_ANIMS): a poised ready stance, the hands-on-hip
// once-over (the sword arm keeps hanging the blade point-down), and the sword whirled round him for the second phase
const MASTER_BAKED = {
  ...ENEMY_BAKED,
  ...DUEL_BAKED,
  // the poised horse stance, arms on the animator: the source holds its free hand over its mouth the whole loop
  combatIdle: { src: 'A Chinese swordsman stands in a poised martial arts', loop: true, pingpong: true, fade: 0.3, mask: 'arms' },
  bossTaunt: { src: '自信地叉腰站立', t0: 0.3, t1: 3.2, fade: 0.25, mask: 'body' },
  bossFlourish: { src: 'A swordsman whirls a sword in fast circles', t0: 1.6, t1: 4.0, fade: 0.2, mask: 'left' },   // the whirl itself is 2.1–3.3 s; the source's free hand hides the mouth
};
const EXTRA_ANIMS = { swordmaster: ['assets/models/hero-tripo.glb'] };
/** Mixamo mocap pack (tools/mixamo): table entries with src 'mx:<key>' are retargeted from it (mixamoAnims.js). */
const MIXAMO_PACK = 'assets/anims/mixamo.glb';
const BAKED = {
  bandit: BANDIT_BAKED, bandit_heavy: BANDIT_BAKED, spearman: SPEAR_BAKED, archer: ARCHER_BAKED, shieldman: SHIELD_BAKED, swordmaster: MASTER_BAKED,
  assassin: { ...ENEMY_BAKED, ...DUEL_BAKED },
  hero: {
    idle: { src: 'idle', loop: true, fade: 0.35 },
    combatIdle: { src: 'A calm swordsman stands in a relaxed ready stance', loop: true, pingpong: true, fade: 0.3, mask: 'body' },   // sword arm: the stance's low blade (every cut ends there)
    walk: { src: 'walk', rate: 'speed', speed0: 1.16, fade: 0.25, mask: 'body' },
    // armed run: a take shot running with a sword in the right hand (the blade carried low and back, arm pumping)
    run: { src: 'mx:runSword', rate: 'speed', fade: 0.2, grip: 'hand' },
    sprint: { src: 'mx:runSword', rate: 'speed', fade: 0.2, grip: 'hand' },
    // sheathed: both arms swing with the gait (the masked sword arm held a guard shape that read stiff and lopsided)
    'walk~free': { src: 'walk', rate: 'speed', speed0: 1.16, fade: 0.25 },
    'run~free': { src: 'run', rate: 'speed', speed0: 4.1, fade: 0.2 },
    'sprint~free': { src: 'run', rate: 'speed', speed0: 4.1, fade: 0.2 },
    // dodgeB stays procedural (a guarded back-step, blade on line): the Tripo back-jump held both fists up by the face
    dodgeL: { src: 'A man facing forward quickly leaps sideways to his left', t0: 0.3, t1: 1.25, fade: 0.08 },
    dodgeR: { src: 'A man facing forward quickly leaps sideways to his right', t0: 0.3, t1: 1.25, fade: 0.08 },
    hitFront: { src: 'hit_to_body_01', t0: 0.05, t1: 1.1, fade: 0.06, mask: 'body' },
    hitHeavy: { src: 'hit_to_head', t0: 0.05, t1: 1.6, fade: 0.06, mask: 'body' },
    hitBack: { src: 'mx:reactSmallBack', t0: 0.0, t1: 1.0, fade: 0.06, mask: 'body' },
    stagger: { src: 'mx:reactLargeFront', t0: 0.0, t1: 1.37, fade: 0.08, mask: 'body' },   // reeling back, arms thrown out
    ...FALLS,
    // drawing from / returning to the left hip, upper body over the gait; `sync` puts the hand on the hilt at the
    // clip's 'drawn' / 'sheathed' event (the frame the sword changes parent)
    draw: { src: 'mx:drawSword', t0: 0.1, t1: 1.35, sync: [[0.378, 0.62]], fade: 0.12, grip: 'hand', mask: 'upper' },
    sheathe: { src: 'mx:sheathSword', t0: 0.2, t1: 1.62, sync: [[0.782, 1.2]], fade: 0.15, grip: 'hand', mask: 'upper' },
    // the forward dodge: a real shoulder roll (in and out of it with the blade kept clear)
    dodgeF: { src: 'mx:sprintRoll', t0: 0.12, t1: 1.08, fade: 0.06, grip: 'hand' },   // the cancel point lands as he comes up
    // Attacks: Mixamo sword mocap (whole-body commitment the hand-keyed cuts lacked). [t0, t1] of the take is mapped
    // onto the game clip with `key` (the take's hand-speed peak) landing in the middle of the first hit window.
    attack1: { src: 'mx:ssSlash', t0: 0.35, t1: 1.15, key: 0.7, fade: 0.08, grip: 'hand', jianzhi: true },           // R→L lunge cut
    attack2: { src: 'mx:inwardSlash', t0: 0.95, t1: 1.62, key: 1.2, fade: 0.08, grip: 'hand' },                        // L→R backhand
    attack3: { src: 'mx:ssCrossSlash', t0: 0.3, t1: 1.45, key: 0.83, fade: 0.08, grip: 'hand', jianzhi: true },       // L→R rising
    attack4: { src: 'mx:ssDownSlash', t0: 0.05, t1: 1.45, key: 0.6, fade: 0.08, grip: 'hand', jianzhi: true },        // overhead into a lunge
    thrust: { src: 'mx:thrustSlash', t0: 0.35, t1: 1.25, key: 0.85, fade: 0.08, grip: 'hand', align: true },          // chest-high thrust
    heavy: { src: 'mx:ssJumpAttack', t0: 0.25, t1: 2.0, key: 1.2, fade: 0.1, grip: 'hand', jianzhi: true },           // leaping cleave
    special: { src: 'mx:ssPowerSlash', t0: 0.3, t1: 2.3, key: 1.36, fade: 0.1, grip: 'hand', jianzhi: true },         // spin, slam: the qi wave
  },
};

// ---------------------------------------------------------------------------------------------------------------
// geometry: worker pool with an inline fallback, cached per kind:seed
// ---------------------------------------------------------------------------------------------------------------

const dataCache = new Map();
let pool = null;

function makePool() {
  const n = Math.max(1, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const workers = [];
  const pending = new Map();
  let nextId = 1, rr = 0, broken = false;
  for (let i = 0; i < n; i++) {
    try {
      const w = new Worker(new URL('./humanoidWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.data);
      };
      w.onerror = (e) => { broken = true; console.warn('[character] worker error', e.message); for (const p of pending.values()) p.reject(new Error('worker failed')); pending.clear(); };
      workers.push(w);
    } catch (e) { broken = true; }
  }
  return {
    get ok() { return !broken && workers.length > 0; },
    run(kind, seed, lod = 0) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        workers[rr++ % workers.length].postMessage({ id, kind, seed, lod });
      });
    },
  };
}

async function buildInline(kind, seed, lod = 0) {
  const { buildCharacterData } = await import('./humanoidBuild.js');
  return buildCharacterData(kind, seed, lod);
}

/** Geometry + rig data for (kind, seed[, lod]), built once. */
export function characterData(kind, seed, lod = 0) {
  const key = `${kind}:${seed}:${lod}`;
  if (!dataCache.has(key)) {
    const job = (async () => {
      if (!pool && typeof Worker !== 'undefined') pool = makePool();
      if (pool?.ok) {
        try { return await pool.run(kind, seed, lod); } catch (e) { console.warn('[character] worker build failed, building inline', e); }
      }
      return buildInline(kind, seed, lod);
    })();
    dataCache.set(key, job);
  }
  return dataCache.get(key);
}

/** Start building characters early (e.g. while the terrain bakes). */
export function prefetchCharacters(list) { for (const { kind, seed } of list) characterData(kind, seed); }

// ---------------------------------------------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------------------------------------------

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _v = new THREE.Vector3(), _w2 = new THREE.Vector2();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();

/**
 * @param {{kind?: 'hero'|'bandit'|'bandit_heavy'|'swordmaster', seed?: number}} opts
 */
export async function createCharacter({ kind = 'hero', seed = 1 } = {}) {
  const [data, matsU] = await Promise.all([characterData(kind, seed), (async () => { const U = createCharUniforms(); return { U, M: await createCharMaterials(U) }; })()]);
  const { U, M } = matsU;
  const s = data.scale;
  const rig = createSkeleton(s);
  const B = rig.bones;

  // --- extra bones: the weapon frame (in the hierarchy) and cloth-chain nodes (world matrices written by the sim)
  const extras = data.rig.extras.map((e) => {
    if (e.kind === 'rigid') { const b = new THREE.Bone(); b.name = e.name; B[e.parent].add(b); return b; }
    return makeSimBone(e.name);
  });
  const allBones = [...rig.list, ...extras];
  const inverses = [];
  for (let i = 0; i < rig.list.length; i++) inverses.push(new THREE.Matrix4().fromArray(data.bindInverses, i * 16));
  for (const e of data.rig.extras) inverses.push(new THREE.Matrix4().fromArray(e.inverse));
  const skeleton = new THREE.Skeleton(allBones, inverses);
  const bindMatrices = inverses.map(m => m.clone().invert());

  const group = new THREE.Group();
  group.name = `character:${kind}:${seed}`;
  group.add(rig.root);
  const meshes = buildMeshes(data.packed, M, skeleton, { scale: s });
  for (const m of meshes) group.add(m);
  group.layers.set(LAYERS.ACTORS);
  rig.root.traverse(o => o.layers.set(LAYERS.ACTORS));
  group.updateMatrixWorld(true);

  // --- weapon: base/tip sockets on the weapon bone; drawn ↔ sheathed by re-parenting
  const wBone = extras[data.weapon.bone - rig.list.length];
  const base = new THREE.Object3D(); base.name = 'blade.base'; base.position.z = data.weapon.base; wBone.add(base);
  const tip = new THREE.Object3D(); tip.name = 'blade.tip'; tip.position.z = data.weapon.tip; wBone.add(tip);
  const sheathM = new THREE.Matrix4().fromArray(data.weapon.sheathFrame);
  const sheathPos = new THREE.Vector3(), sheathQ = new THREE.Quaternion();
  sheathM.decompose(sheathPos, sheathQ, _s);
  let tasselReset = true;

  // --- cloth
  const b = data.build;
  const capsDef = [
    // [boneA, boneB, radius, mask, offsetA(y), offsetB(y)]
    ['upperLeg.L', 'upperLeg.R', 0.125 * b.waist, COL.PELVIS, 0.015, 0.015],
    ['upperLeg.L', 'lowerLeg.L', 0.085 * b.leg + 0.028, COL.LEGS, 0, 0],
    ['upperLeg.R', 'lowerLeg.R', 0.085 * b.leg + 0.028, COL.LEGS, 0, 0],
    ['lowerLeg.L', 'foot.L', 0.058 * b.leg + 0.018, COL.LEGS, 0, 0],
    ['lowerLeg.R', 'foot.R', 0.058 * b.leg + 0.018, COL.LEGS, 0, 0],
    ['spine', 'neck', 0.15 * b.girth + 0.03, COL.TORSO, 0, -0.04],
    ['hips', 'spine', 0.15 * b.waist + 0.03, COL.TORSO | COL.PELVIS, -0.05, 0],
    ['head', 'head', 0.105, COL.HEAD, 0.07, 0.07],
    ['upperArm.L', 'lowerArm.L', 0.06 * b.arm, COL.ARMS, 0, 0],
    ['upperArm.R', 'lowerArm.R', 0.06 * b.arm, COL.ARMS, 0, 0],
  ].map(([a, bb, r, mask, oa, ob]) => ({ a: B[a], b: B[bb], r: r * s, mask, oa: oa * s, ob: ob * s }));
  const capsuleFn = (out) => {
    let n = 0;
    for (const c of capsDef) {
      const ea = c.a.matrixWorld.elements, eb = c.b.matrixWorld.elements, o = n * 8;
      out[o] = ea[12]; out[o + 1] = ea[13] + c.oa; out[o + 2] = ea[14];
      out[o + 3] = eb[12]; out[o + 4] = eb[13] + c.ob; out[o + 5] = eb[14];
      out[o + 6] = c.r; out[o + 7] = c.mask;
      n++;
    }
    return n;
  };
  const cloth = new ClothSim({ chains: data.rig.chains, links: data.rig.links }, allBones, bindMatrices, { capsules: capsuleFn, rootBone: rig.root, iterations: 5 });
  cloth.reset();

  // --- hurt capsules (world space, objects reused)
  const hurtDef = [
    ['neck', 'hat', 0.11, 'head', 0, -0.05],
    ['hips', 'chest', 0.17 * b.waist, 'torso', 0, 0],
    ['chest', 'neck', 0.17 * b.girth, 'torso', 0, 0],
    ['upperArm.L', 'lowerArm.L', 0.055 * b.arm, 'arm', 0, 0], ['lowerArm.L', 'hand.L', 0.047 * b.arm, 'arm', 0, 0],
    ['upperArm.R', 'lowerArm.R', 0.055 * b.arm, 'arm', 0, 0], ['lowerArm.R', 'hand.R', 0.047 * b.arm, 'arm', 0, 0],
    ['upperLeg.L', 'lowerLeg.L', 0.085 * b.leg, 'leg', 0, 0], ['lowerLeg.L', 'foot.L', 0.062 * b.leg, 'leg', 0, 0],
    ['upperLeg.R', 'lowerLeg.R', 0.085 * b.leg, 'leg', 0, 0], ['lowerLeg.R', 'foot.R', 0.062 * b.leg, 'leg', 0, 0],
  ].map(([a, bb, r, part, oa, ob]) => ({ A: B[a], B: B[bb], r: r * s, part, oa: oa * s, ob: ob * s }));
  const hurt = hurtDef.map(h => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: h.r, part: h.part }));

  // --- flash
  const flashColor = new THREE.Color(1, 0.25, 0.15);
  // hit flash: a quick warm glow over the lit colours (at 2.5 the body went flat white under a combo)
  const FLASH_PEAK = 1.2;
  let flashT = 0, flashK = 1;
  const setEmissive = (k) => { for (const m of M.list) if (m.emissive) m.emissive.copy(flashColor).multiplyScalar(k); };

  let visible = true;
  const ch = {
    kind, seed, group, scale: s, meshes, materials: M, uniforms: U, cloth, stats: data.stats, buildMs: data.ms,
    rig: { root: rig.root, bones: B, skeleton, twoHandGap: data.weapon.twoHandGap ?? 0.105 },
    sword: {
      object: wBone, base, tip, drawn: true, mount: data.weapon.mount,
      setDrawn(v) {
        v = !!v;
        if (v === this.drawn && wBone.parent) return;
        this.drawn = v;
        if (v) { B['weapon.R'].add(wBone); wBone.position.set(0, 0, 0); wBone.quaternion.identity(); }
        else { B[data.weapon.mount].add(wBone); wBone.position.copy(sheathPos); wBone.quaternion.copy(sheathQ); }
        wBone.updateMatrixWorld(true);
        tasselReset = true;
      },
    },
    /** Secondary motion; call after the animator posed the rig this frame. */
    update(dt = 0, t = G.uTime.value) {
      if (!visible) return;
      group.updateMatrixWorld(true);
      if (tasselReset && data.weapon.tassel) { cloth.resetChain(data.weapon.tassel); tasselReset = false; }
      // cloth LOD by camera distance (bible §8.3.16): full < 25 m, reduced < 50 m, rigid beyond
      const e = rig.root.matrixWorld.elements;
      const d2 = (e[12] - G.uCamPos.value.x) ** 2 + (e[14] - G.uCamPos.value.z) ** 2;
      // mesh LOD: the ~28% version beyond 14 m (back to full detail inside 11 m: no popping at the boundary)
      if (lod.meshes) {
        const far = lod.on ? d2 > 11 * 11 : d2 > 14 * 14;
        if (far !== lod.on) { lod.on = far; for (const m of meshes) m.visible = !far; for (const m of lod.meshes) m.visible = far; }
      }
      const q = d2 < 25 * 25 ? 1 : d2 < 50 * 50 ? 0.5 : 0;
      if (q > 0) cloth.step(dt, t, q); else { cloth.reset(); cloth.writeBones(); }
      // material uniforms: ground contact + wind in character space
      U.uContact.value.x = e[13];
      windVector(e[12], e[14], t, _w2);
      const yaw = Math.atan2(e[8], e[10]);
      const c = Math.cos(-yaw), sn = Math.sin(-yaw);
      U.uWindLocal.value.set(_w2.x * c + _w2.y * sn, 0, -_w2.x * sn + _w2.y * c);
      if (flashT > 0) { flashT = Math.max(0, flashT - dt * 8 - 1e-3); setEmissive(flashT * flashT * FLASH_PEAK * flashK); }
    },
    resetCloth() { group.updateMatrixWorld(true); cloth.reset(); cloth.writeBones(); },
    hurtCapsules(out = []) {
      out.length = 0;
      for (let i = 0; i < hurtDef.length; i++) {
        const h = hurtDef[i], o = hurt[i];
        const ea = h.A.matrixWorld.elements, eb = h.B.matrixWorld.elements;
        o.a.set(ea[12], ea[13] + h.oa, ea[14]);
        o.b.set(eb[12], eb[13] + h.ob, eb[14]);
        out.push(o);
      }
      return out;
    },
    flash(color, strength = 1) {
      if (color !== undefined && color !== null) flashColor.set(color); else flashColor.setRGB(1, 0.25, 0.15);
      // emissive is absolute: at night the exposure is 2–5× the day's, so the same flash would white a body out
      const ex = globalThis.__app?.pipeline?.params?.exposure ?? 1;
      flashT = 1; flashK = strength * Math.min(1, 1.1 / Math.max(0.5, ex));
      setEmissive(FLASH_PEAK * flashK);
    },
    setVisible(v) { visible = !!v; group.visible = visible; if (visible) ch.resetCloth(); },
    dispose() {
      group.removeFromParent();
      for (const m of meshes) m.geometry.dispose();
      for (const m of lod.meshes ?? []) m.geometry.dispose();
      lod.disposed = true;
      for (const m of M.list) m.dispose();
      skeleton.dispose();
    },
  };
  ch.sword.setDrawn(true);
  group.updateMatrixWorld(true);
  cloth.reset();
  cloth.writeBones();
  // distant LOD (not for authored model skins): built in the background on the same rig, swapped in by distance.
  // Both builds must produce the same bone list (contract rig + extras) to share the skeleton; otherwise skip.
  const lod = { meshes: null, on: false, disposed: false };
  ch.lod = lod;
  if (!MODEL_SKINS[kind] && typeof location !== 'undefined' && new URLSearchParams(location.search).get('lod') !== '0') {
    characterData(kind, seed, 1).then((d1) => {
      if (lod.disposed) return;
      const same = d1.rig.extras.length === data.rig.extras.length && d1.rig.extras.every((x, i) => x.name === data.rig.extras[i].name);
      if (!same) { console.warn('[character] LOD rig differs, skipped', kind, seed); return; }
      lod.meshes = buildMeshes(d1.packed, M, skeleton, { scale: s });
      for (const m of lod.meshes) { m.visible = false; m.layers.set(LAYERS.ACTORS); group.add(m); }
      ch.stats.lod1 = d1.stats;
    }).catch((err) => console.warn('[character] LOD build failed', err));
  }
  const skinUrl = MODEL_SKINS[kind];
  const skinOff = typeof location !== 'undefined' && new URLSearchParams(location.search).get('skin') === '0';
  if (skinUrl && !skinOff) {
    const base = import.meta.env?.BASE_URL ?? '/';
    const baked = typeof location !== 'undefined' && new URLSearchParams(location.search).get('baked') === '0' ? null : BAKED[kind];
    // the Mixamo takes this kind's table asks for ('mx:<key>'), retargeted onto its model at load
    // (&mxall=1, dev: every take in the pack, for auditioning with ch.skin.baked.add)
    const mxAll = typeof location !== 'undefined' && new URLSearchParams(location.search).has('mxall');
    const mxKeys = mxAll ? ['*'] : baked ? [...new Set(Object.values(baked).map((e) => e.src).filter((s) => s.startsWith('mx:')).map((s) => s.slice(3)))] : [];
    try { await applyModelSkin(ch, base + skinUrl, { baked, extraAnims: (EXTRA_ANIMS[kind] ?? []).map((u) => base + u), mixamo: mxKeys.length ? { url: base + MIXAMO_PACK, keys: mxKeys } : null }); }
    catch (e) { console.warn('[character] model skin failed, keeping the procedural body', e); }
  }
  return ch;
}
