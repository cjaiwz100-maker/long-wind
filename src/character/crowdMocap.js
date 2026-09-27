// Townsfolk mocap (owner: character C): Mixamo takes played on a procedural crowd body's contract rig (skeleton.js),
// the way model skins play them on their own skeletons (bakedAnim.js over the animator).
//
//   const layer = await crowdLayer(ch, kind, { alias })   → a baked layer, or null if the pack failed to load
//   layer.update(dt, anim)                                  after anim.update, before the group's matrices update
//
// The takes are retargeted once per body size onto a bare rest rig (the contract rest is a T-pose with identity
// locals, like the Mixamo X Bot's) and shared by every citizen of that size. Walks and the flight loop at the gait
// speed; standing is an idle picked by what the citizen is doing (`alias`: 'idle' → 'idle:chat' / 'idle:browse');
// the cower drops into a crouch with the head covered and then trembles there. The head and neck of a standing
// citizen stay the animator's, so they still turn to a partner or a shop front (lookAt).
import * as THREE from 'three';
import { createSkeleton } from './skeleton.js';
import { retargetMixamo } from './mixamoAnims.js';
import { createBakedLayer } from './bakedAnim.js';
import { MIXAMO_MAP, loadGLB } from './modelSkin.js';

const PACK = 'assets/anims/mixamo.glb';
const TO_RIG = Object.fromEntries(Object.entries(MIXAMO_MAP).map(([rig, mx]) => [mx, rig]));   // Mixamo short → contract

const walk = (src, extra = {}) => ({ src, rate: 'speed', fade: 0.3, ...extra });
const idle = (src, extra = {}) => ({ src, loop: true, fade: 0.45, head: false, ...extra });
// the flinch into the crouch (stretched over the game clip), then the long trembling middle of the take, looped
const COWER = {
  cower: { src: 'mx:cTerrified', t0: 0.15, t1: 1.7, fade: 0.2 },
  'cower:hold': { src: 'mx:cTerrified', t0: 2.0, t1: 17.0, loop: true, pingpong: true, fade: 0.3 },
};
const RUN = { run: walk('mx:cRun', { fade: 0.2 }), sprint: walk('mx:cRun', { fade: 0.2 }) };
/** Per body kind: gait, idle and the talking variant (browsing a stall is the plain idle, the head on the goods). */
const table = (walkSrc, idleSrc, talkSrc) => ({
  walk: walk(walkSrc), ...RUN, idle: idle(idleSrc), 'idle:chat': idle(talkSrc), 'idle:browse': idle(idleSrc), ...COWER,
});
const TABLES = {
  male: table('mx:cWalk', 'mx:cIdle', 'mx:cTalk'),
  female: table('mx:cWalkF', 'mx:cIdleF', 'mx:cTalkF'),
  female2: table('mx:cWalkF', 'mx:cIdleF', 'mx:cTalkFunny'),   // the second voice of a pair: laughing along
  old: table('mx:cWalkOld', 'mx:cIdleOld', 'mx:cTalk'),
};
/** Every take the crowd uses (the pack keys). */
export const CROWD_KEYS = [...new Set(Object.values(TABLES).flatMap((t) => Object.values(t).map((e) => e.src.slice(3))))];

const bySize = new Map();
function clipsFor(scale) {
  const k = scale.toFixed(3);
  if (!bySize.has(k)) {
    const base = import.meta.env?.BASE_URL ?? '/';
    bySize.set(k, loadGLB(base + PACK).then((pack) => {
      const rig = createSkeleton(scale);
      new THREE.Group().add(rig.root);
      rig.root.updateMatrixWorld(true);
      return retargetMixamo(pack, rig.root, (n) => rig.bones[TO_RIG[n]], new THREE.Matrix4(), CROWD_KEYS, { nameOf: (o) => MIXAMO_MAP[o.name] ?? null });
    }));
  }
  return bySize.get(k);
}

/** Which table a citizen kind plays (variant: an index to alternate the talkers). */
function tableFor(kind, variant) {
  if (kind === 'citizen_old') return TABLES.old;
  if (kind === 'citizen_f') return variant % 2 ? TABLES.female2 : TABLES.female;
  return TABLES.male;
}

/**
 * @param {object} ch   a procedural character (createCharacter)
 * @param {string} kind  citizen_m | citizen_f | citizen_s | citizen_old | citizen_child
 * @param {{ alias?: (name: string) => string, variant?: number }} [opts]
 */
export async function crowdLayer(ch, kind, { alias = null, variant = 0 } = {}) {
  let clips;
  try { clips = await clipsFor(ch.scale); } catch (e) { console.warn('[crowd] mocap failed, procedural gait kept', e); return null; }
  const B = ch.rig.bones;
  return createBakedLayer(ch.rig.root, clips, tableFor(kind, variant), {
    mb: (n) => B[TO_RIG[n]],
    noTrack: (node, spec) => spec.head === false && (node === B.neck || node === B.head),
    alias,
  });
}
