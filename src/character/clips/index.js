// Clip registry: compiles every authored clip and exposes the contract `CLIPS[name] = { name, meta }`.
// Owner: animation (A).
import { compileClip } from './track.js';
import { NEUTRAL, STANCE, IDLE } from './poses.js';
import { LOCOMOTION_CLIPS } from './loco-clips.js';
import { ATTACK_CLIPS } from './attacks.js';
import { ENEMY2_CLIPS } from './enemy2.js';
import { DEFENSE_CLIPS, DEFENSE_CLIPS_BANDIT } from './defense.js';
import { REACTION_CLIPS, REACTION_CLIPS_BANDIT } from './reactions.js';
import { MISC_CLIPS } from './misc.js';
import { ENEMY_CLIPS } from './enemy.js';
import { MOCAP_JIAN } from '../mocap/jian-demo.js';
import { CITIZEN_CLIPS } from './citizen.js';

// Contract clip names (CONTRACTS.md §Animation). Every one must exist.
export const CLIP_NAMES = ['idle', 'combatIdle', 'walk', 'run', 'sprint', 'walkBack', 'strafeL', 'strafeR', 'turnL', 'turnR',
  'dodgeF', 'dodgeB', 'dodgeL', 'dodgeR', 'attack1', 'attack2', 'attack3', 'attack4', 'heavy', 'heavyCharge', 'thrust', 'special',
  'block', 'blockHit', 'parry', 'parried', 'hitFront', 'hitBack', 'hitHeavy', 'stagger', 'knockdown', 'getUp', 'death', 'deathBack',
  'draw', 'sheathe', 'taunt', 'victory', 'enemyAttack1', 'enemyAttack2', 'enemyHeavy', 'enemyThrust'];

/** Default meta so every field of the contract exists. */
function fullMeta(m) {
  return {
    duration: 1, loop: false, type: 'misc', hit: [], combo: null, cancel: m.duration ?? 1, damage: 0, posture: 0, reach: 0, lunge: 0,
    ...m,
  };
}

// Video-mocap reference takes (tools/mocap): one clip per shot, `mocap0`…, for review in the anim scene
// (?scene=anim&play=mocap6) and as the source of the hero's jian key poses.
const MOCAP_CLIPS = Object.fromEntries(MOCAP_JIAN.segments.map((sg, i) => [`mocap${i}`, {
  meta: { duration: Math.max(0.1, sg.keys[sg.keys.length - 1].t), loop: true, type: 'misc', source: `video ${sg.t0}–${sg.t1}s` },
  keys: sg.keys,
}]));
const SPECS = { ...LOCOMOTION_CLIPS, ...ATTACK_CLIPS, ...DEFENSE_CLIPS, ...REACTION_CLIPS, ...MISC_CLIPS, ...ENEMY_CLIPS, ...ENEMY2_CLIPS, ...MOCAP_CLIPS, ...CITIZEN_CLIPS };
// Style variants `<name>@<style>` (e.g. bandit reactions from their own stance). Not part of CLIPS: gameplay keeps
// reading the base name's meta, and a variant always shares it (timing, windows) — only the motion differs.
const VARIANTS = { ...REACTION_CLIPS_BANDIT, ...DEFENSE_CLIPS_BANDIT };

export const COMPILED = {};
export const CLIPS = {};
for (const name of new Set([...CLIP_NAMES, ...Object.keys(SPECS)])) {
  let spec = SPECS[name];
  if (!spec) {
    console.warn(`[anim] clip ${name} not authored — using a placeholder`);
    spec = { meta: { duration: 1 }, base: STANCE, keys: [] };
  }
  const meta = fullMeta(spec.meta);
  const clip = compileClip(name, { ...spec, meta }, spec.defaults ?? NEUTRAL);
  COMPILED[name] = clip;
  CLIPS[name] = { name, meta };
}
for (const [vname, spec] of Object.entries(VARIANTS)) {
  const base = vname.split('@')[0];
  const meta = CLIPS[base]?.meta ?? fullMeta(spec.meta);
  COMPILED[vname] = compileClip(base, { ...spec, meta }, spec.defaults ?? NEUTRAL);
}
export { NEUTRAL, STANCE, IDLE };
