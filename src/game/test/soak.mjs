// Soak test: the whole game loop (director, AI, combat, camera, autopilot) runs headless in node with stand-in
// characters, the way core/app.js drives it (sim dt with hit-stop and slow-mo, real dt for the camera).
//   1. god mode: the demo autopilot must clear wave 1 → 2 → 3 (boss) and reach victory
//   2. mortal: an idle hero must be defeated, and the director must restart the wave
// Owner: gameplay (P).   node src/game/test/soak.mjs
import { G } from '../../core/globals.js';
import { bus } from '../../core/bus.js';
import { createGame } from '../game.js';
import { wrapAngle } from '../util.js';
import { FakeAnimator, fakeCharacter, fakeApp } from './fakes.mjs';

const DT = 1 / 60;
let failed = 0;
const check = (c, msg) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${msg}`); if (!c) failed++; };

function frame({ app, systems }) {
  const t = app.time;
  if (t._scaleLerp > 0) t.scale += (t._targetScale - t.scale) * Math.min(1, DT / t._scaleLerp * 3);
  let dt = DT * t.scale;
  if (t._hitstop > 0) { t._hitstop -= DT; dt *= 0.02; }
  t.t += dt; t.real += DT;
  G.uTime.value = t.t; G.uFrame.value++;
  for (const s of systems) s.update?.(dt, t.t, app, DT);
  for (const s of systems) s.lateUpdate?.(dt, t.t, app, DT);
}

async function run(query, seconds, stopWhen, setup) {
  const env = fakeApp(query);
  const counts = {};
  const off = bus.on('*', (p, type) => { counts[type] = (counts[type] ?? 0) + 1; });
  const game = await createGame(env.app, { createCharacter: async (o) => fakeCharacter(o), AnimatorClass: FakeAnimator });
  setup?.(game);
  const states = new Set(), directors = [];
  let maxAttackers = 0, fightFrames = 0, sunFrames = 0;
  for (let i = 0; i < seconds * 60; i++) {
    frame(env);
    if (game.director.state === 'fight') {
      fightFrames++;
      if (Math.abs(wrapAngle(game.camera.heading - game.camera.sunHeading)) < 0.87) sunFrames++;
    }
    states.add(game.state);
    if (directors[directors.length - 1] !== game.director.state) directors.push(game.director.state);
    let n = 0;
    for (const e of game.enemies) if (e.active && (e.state === 'attack' || e.state === 'close')) n++;
    maxAttackers = Math.max(maxAttackers, n);
    if (stopWhen?.(game)) break;
  }
  off();
  game.dispose();
  return { game, counts, states, directors, maxAttackers, simT: env.app.time.t, contreJour: sunFrames / Math.max(1, fightFrames) };
}

// 1 ---------------------------------------------------------------------------------------------------------------
{
  console.log('god-mode campaign (demo autopilot):');
  const r = await run('demo=1&nointro', 600, (g) => g.state === 'victory' && g.director.t > 2, (g) => { g.player.invulnerable = true; });
  const c = r.counts;
  console.log(`    director: ${r.directors.join(' → ')}`);
  console.log(`    events: ${Object.entries(c).map(([k, v]) => `${k}×${v}`).join(' ')}`);
  check(r.states.has('victory'), `reached victory (sim ${r.simT.toFixed(0)} s)`);
  check((c['wave:start'] ?? 0) >= 3 && (c['wave:clear'] ?? 0) >= 3, 'three waves started and cleared');
  check((c['enemy:death'] ?? 0) >= 9, `all nine enemies died (${c['enemy:death'] ?? 0})`);
  check((c['enemy:telegraph'] ?? 0) > 5 && (c['sword:whoosh'] ?? 0) > 20, 'telegraphs and whooshes fire');
  check((c['player:parry'] ?? 0) > 0, 'the autopilot parried at least once');
  check(r.maxAttackers <= 2, `at most two committed attackers (${r.maxAttackers})`);
  check(r.contreJour > 0.6, `camera within ±50° of the sun for ${(r.contreJour * 100).toFixed(0)} % of the fighting`);
  check((c.mood ?? 0) >= 2 && (c.wind ?? 0) >= 3, 'boss mood + wind escalation');
}
// 2 ---------------------------------------------------------------------------------------------------------------
{
  console.log('defeat + restart (idle hero):');
  let restarted = false;
  const r = await run('wave=1&nointro&state=playing', 240, (g) => {
    if (g.director.state === 'defeatWait' && g.director.t > 1.5) { g.director.restartWave(); restarted = true; }
    return restarted && g.director.state === 'fight';
  });
  check(r.states.has('defeat'), 'the idle hero was defeated');
  check(restarted && r.game.player.alive && r.game.player.hp === r.game.player.maxHp, 'restart revives the hero with full health');
  check(r.game.enemies.filter((e) => e.active).length === 3, 'wave 1 respawned (3 bandits)');
}
console.log(failed ? `\n${failed} checks failed` : '\nall soak checks passed');
process.exit(failed ? 1 : 0);
