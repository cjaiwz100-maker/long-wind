// Offline audio verification: renders scripted scenarios through the real event→sound mapping on an
// OfflineAudioContext, measures them (peak, RMS, loudest second, clipping, NaN, DC) and encodes 16-bit WAV.
// Used by scenes/ui.js ?state=audiotest[&only=a,b]; results land on window.__audioTest = [{ name, stats, wav (base64) }]
// and window.__audioTestDone = true. Owner: audio (U).
import { renderOffline } from './audio.js';
import { windGust, windFlutter } from '../core/wind.js';
import { G } from '../core/globals.js';

const P = (x, y, z) => ({ x, y, z });
const L = { pos: [0, 1.6, 6], yaw: 0 };   // listener behind the player, looking down −z

// A light combo on a bandit 3 m ahead: whoosh, hit; then its answer.
function exchange(t0, id, x = 0.6) {
  return [
    [t0, 'sword:whoosh', { speed: 13, heavy: false, pos: P(x, 1.3, 2.6) }],
    [t0 + 0.12, 'enemy:hit', { id, pos: P(x, 1.3, 2.4), damage: 18, kill: false }],
    [t0 + 0.55, 'sword:whoosh', { speed: 15, heavy: false, pos: P(x - 0.5, 1.4, 2.6) }],
    [t0 + 0.66, 'enemy:hit', { id, pos: P(x, 1.3, 2.4), damage: 20, kill: false }],
  ];
}
function steps(t0, n, speed = 3.5, dt = 0.36) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([t0 + i * dt, 'player:step', { foot: i & 1 ? 'R' : 'L', pos: P(0, 0, 3), speed }]);
  return out;
}

export const SCENARIOS = {
  // the steppe alone: calm wind swelling to a storm-strength gust field
  wind: {
    seconds: 24,
    wind: (t) => ({ strength: t < 8 ? 1 : t < 16 ? 1.5 : 2.4 }),
    script: [[0, 'game:state', { state: 'playing' }], ...steps(3, 10, 3.2, 0.42), ...steps(12, 16, 5.8, 0.3)],
  },
  // title: guqin and xiao over the wind
  title: { seconds: 40, script: [[0, 'game:state', { state: 'title' }]] },
  // wave 1: drums in, exchanges, a parry, a hurt, kills, clear
  battle: {
    seconds: 36,
    script: [
      [0, 'game:state', { state: 'playing' }],
      ...steps(0.5, 6),
      [2, 'wave:start', { index: 1, title: '风起', count: 3 }],
      [2.6, 'enemy:spawn', { id: 'b1', kind: 'bandit', pos: P(-3, 0, -20) }],
      [3.0, 'enemy:spawn', { id: 'b2', kind: 'bandit', pos: P(2, 0, -22) }],
      [3.4, 'enemy:spawn', { id: 'b3', kind: 'bandit', pos: P(5, 0, -21) }],
      ...steps(6, 12, 5.5, 0.3),
      [10, 'lockon', { id: 'b1' }],
      ...exchange(10.5, 'b1'),
      [12.2, 'enemy:telegraph', { id: 'b2', pos: P(1, 1.6, 2.5), unblockable: false }],
      [12.8, 'player:parry', { perfect: true, pos: P(0.3, 1.4, 2.2) }],
      [12.8, 'enemy:parried', { id: 'b2', pos: P(0.3, 1.4, 2.2) }],
      [12.8, 'sword:clash', { pos: P(0.3, 1.4, 2.2), strength: 1.6, perfect: true }],
      [13.6, 'sword:whoosh', { speed: 17, heavy: true, pos: P(0.5, 1.4, 2.6) }],
      [13.8, 'enemy:hit', { id: 'b2', pos: P(0.4, 1.2, 2.4), damage: 45, kill: true, heavy: true }],
      [13.8, 'enemy:death', { id: 'b2', pos: P(0.4, 0, 2.4) }],
      [15.0, 'enemy:telegraph', { id: 'b3', pos: P(2, 1.6, 2.5), unblockable: true }],
      [15.7, 'player:dodge', { dir: { x: 1, z: 0 } }],
      [15.75, 'player:evade', { perfect: true }],
      [17.0, 'sword:clash', { pos: P(-0.8, 1.4, 2.4), strength: 0.9 }],
      [17.0, 'player:parry', { perfect: false, blocked: true, pos: P(-0.8, 1.4, 2.4) }],
      [18.2, 'player:hurt', { damage: 22, pos: P(1.2, 1.3, 2), dir: { x: 0, y: 0, z: 1 } }],
      [18.2, 'player:hp', { hp: 58, max: 100 }],
      ...exchange(19.5, 'b1', -0.4),
      [20.9, 'enemy:hit', { id: 'b1', pos: P(-0.4, 1.3, 2.4), damage: 30, kill: true }],
      [20.9, 'enemy:death', { id: 'b1', pos: P(-0.4, 0, 2.4) }],
      [22.5, 'player:hurt', { damage: 35, pos: P(1.5, 1.3, 2), dir: { x: 0, y: 0, z: 1 } }],
      [22.5, 'player:hp', { hp: 22, max: 100 }],
      [24, 'special', { pos: P(0, 1.2, 4), dir: { x: 0, y: 0, z: -1 } }],
      [24.5, 'enemy:hit', { id: 'b3', pos: P(2, 1.3, -4), damage: 80, kill: true, heavy: true }],
      [24.5, 'enemy:death', { id: 'b3', pos: P(2, 0, -4) }],
      [24.6, 'wave:clear', { index: 1, title: '风起' }],
      ...steps(29, 8, 1.6, 0.55),
    ],
  },
  // the duel: boss drums, a phase change, the final cut, silence, victory
  boss: {
    seconds: 40,
    wind: (t) => ({ strength: t < 12 ? 1.5 : 2.2 }),
    script: [
      [0, 'game:state', { state: 'playing' }],
      [0.5, 'wave:start', { index: 3, title: '剑鸣', count: 1, boss: true }],
      [1.2, 'enemy:spawn', { id: 'sm', kind: 'swordmaster', pos: P(0, 0, -20), boss: true }],
      ...exchange(6, 'sm'),
      [8, 'sword:clash', { pos: P(0.2, 1.5, 2.3), strength: 1.5 }],
      [8, 'player:parried', { id: 'sm', pos: P(0.2, 1.5, 2.3) }],
      [9.5, 'enemy:telegraph', { id: 'sm', pos: P(0, 1.7, 2.6), unblockable: false }],
      [10.1, 'player:parry', { perfect: true, pos: P(0, 1.4, 2.2) }],
      [10.1, 'sword:clash', { pos: P(0, 1.4, 2.2), strength: 1.6, perfect: true }],
      [10.6, 'enemy:posture', { id: 'sm', broken: true }],
      [12, 'enemy:phase', { id: 'sm', phase: 2 }],
      ...exchange(15, 'sm', -0.3),
      [17.5, 'player:charged', { pos: P(0.2, 1.4, 4.5) }],
      [18.2, 'sword:whoosh', { speed: 18, heavy: true, pos: P(0, 1.4, 2.6) }],
      [18.4, 'enemy:hit', { id: 'sm', pos: P(0, 1.3, 2.4), damage: 60, kill: true, heavy: true }],
      [18.4, 'enemy:death', { id: 'sm', pos: P(0, 0, 2.4), boss: true }],
      [18.45, 'wave:clear', { index: 3, boss: true }],
      [21.1, 'mood', { name: 'blue', seconds: 30 }],
      [21.1, 'game:state', { state: 'victory' }],
    ],
  },
  defeat: {
    seconds: 22,
    script: [
      [0, 'game:state', { state: 'playing' }],
      [0.3, 'wave:start', { index: 2, title: '草动', count: 5 }],
      [1, 'enemy:spawn', { id: 'h1', kind: 'bandit_heavy', pos: P(0, 0, -20) }],
      [4, 'player:hp', { hp: 20, max: 100 }],
      [6, 'enemy:telegraph', { id: 'h1', pos: P(0, 1.7, 2.6), unblockable: true }],
      [6.8, 'player:hurt', { damage: 40, pos: P(0, 1.3, 2.2), dir: { x: 0, y: 0, z: 1 } }],
      [6.8, 'player:hp', { hp: 0, max: 100 }],
      [6.85, 'player:death', {}],
      [10.3, 'game:state', { state: 'defeat' }],
    ],
  },
  // the new layer: voices, impacts, combos, launches and bodies, bows and shields (a short brawl)
  impact: {
    seconds: 30,
    wind: () => ({ strength: 0.4, gust: 0.1, gustAhead: 0.1, flutter: 0, pan: 0 }),
    script: (() => {
      const H = (x = 0.4) => P(x, 1.3, 2.4);
      const out = [[0, 'game:state', { state: 'playing' }], [0.2, 'wave:start', { index: 2, title: '草动', count: 5 }]];
      // a four-hit chain on a bandit, the finisher launches him; the body lands
      const clips = ['attack1', 'attack2', 'attack3', 'attack4'];
      clips.forEach((c, i) => {
        const t = 2 + i * 0.42;
        out.push([t, 'sword:whoosh', { speed: 14, heavy: false, pos: H(), id: 'hero', team: 0, clip: c, skind: 'slash', win: 0 }]);
        out.push([t + 0.08, 'enemy:hit', { id: 'bandit-1', kind: 'bandit', pos: H(), damage: i === 3 ? 70 : 18, kill: i === 3, heavy: i === 3, combo: i + 1, result: i === 3 ? 'kill' : 'react' }]);
      });
      out.push([3.8, 'enemy:fall', { id: 'bandit-1', kind: 'bandit', pos: P(0.5, 0, 4.2), weight: 1.1 }]);
      // the heavy on a shieldman: the shield holds, then caves in
      out.push([5.5, 'enemy:telegraph', { id: 'shieldman-1', pos: H(), clip: 'shieldBash' }]);
      out.push([6.2, 'sword:whoosh', { speed: 14, pos: H(), id: 'hero', team: 0, clip: 'attack1', skind: 'slash', win: 0 }]);
      out.push([6.28, 'enemy:shieldblock', { id: 'shieldman-1', pos: H() }]);
      out.push([7.2, 'sword:whoosh', { speed: 18, heavy: true, pos: H(), id: 'hero', team: 0, clip: 'heavy', skind: 'heavy', win: 0 }]);
      out.push([7.35, 'enemy:shieldbreak', { id: 'shieldman-1', pos: H() }]);
      // the archer: release, a near miss, one in the ground, one that hurts
      out.push([9.0, 'enemy:shoot', { id: 'archer-1', pos: P(-6, 1.4, -8) }]);
      out.push([9.4, 'arrow:pass', { pos: P(0.5, 1.4, 5), side: 1 }]);
      out.push([9.6, 'arrow:land', { pos: P(1, 0, 7), soft: true }]);
      out.push([10.6, 'enemy:shoot', { id: 'archer-1', pos: P(-6, 1.4, -8) }]);
      out.push([11.0, 'player:hurt', { damage: 12, pos: P(0, 1.3, 5.6), id: 'archer-1' }]);
      // a spearman's heavy: war cry, danger, the sweep whoosh; the hero's execution
      out.push([12.5, 'enemy:telegraph', { id: 'spearman-2', pos: H(), unblockable: true, clip: 'spearSweep' }]);
      out.push([13.2, 'sword:whoosh', { speed: 15, pos: H(), id: 'spearman-2', team: 1, actor: 'spearman', clip: 'spearSweep', skind: 'slash', win: 0 }]);
      out.push([13.3, 'player:hurt', { damage: 30, pos: P(0, 1.3, 5.6), id: 'spearman-2' }]);
      out.push([15.0, 'player:execute', { id: 'spearman-2', lethal: true }]);
      out.push([15.0, 'enemy:hit', { id: 'spearman-2', kind: 'spearman', pos: H(), damage: 999, kill: true, heavy: true, execute: true, combo: 1 }]);
      out.push([15.8, 'enemy:fall', { id: 'spearman-2', kind: 'spearman', pos: P(0.5, 0, 3), weight: 1 }]);
      // a long chain (pitch climbing) and the special; the boss's qi
      for (let i = 0; i < 12; i++) {
        const t = 17.5 + i * 0.3;
        out.push([t, 'sword:whoosh', { speed: 14, pos: H(), id: 'hero', team: 0, clip: ['attack1', 'attack2', 'attack3', 'airFlurry'][i % 4], skind: 'slash', win: 0 }]);
        out.push([t + 0.06, 'enemy:hit', { id: 'swordmaster-0', kind: 'swordmaster', pos: H(), damage: 20, combo: i + 1, result: 'react' }]);
      }
      out.push([22, 'sword:whoosh', { speed: 18, heavy: true, pos: H(), id: 'hero', team: 0, clip: 'special', skind: 'special', win: 0 }]);
      out.push([22.1, 'special', { pos: P(0, 1.2, 4) }]);
      out.push([24.5, 'enemy:qi', { id: 'swordmaster-0', pos: P(0, 1.4, -4) }]);
      return out;
    })(),
  },
  // voices alone, 1.5 s apart: hero breath/ha/hya/haa/grunt/pain, then bandit grunt/pain/death/roar
  voices: {
    seconds: 16,
    wind: () => ({ strength: 0.05, gust: 0.01, gustAhead: 0.01, flutter: 0, pan: 0 }),
    script: [
      [0.5, 'sword:whoosh', { speed: 0, pos: P(0, 1.4, 3), id: 'hero', team: 0, clip: 'attack1', skind: 'slash', win: 1 }],
      ...[['attack4', false], ['heavy', true], ['special', true]].map(([clip, heavy], i) =>
        [1 + i * 1.5, 'sword:whoosh', { speed: 2.5, heavy: false, pos: P(0, 1.4, 30), id: 'hero' + i, team: 0, clip: clip === 'heavy' ? 'x' : clip, skind: 'slash', win: 0, ...(heavy ? {} : {}) }]),
      [5.5, 'player:hurt', { damage: 10, pos: P(0, 1.4, 30) }],
      [7, 'player:hurt', { damage: 40, pos: P(0, 1.4, 30) }],
      [8.5, 'enemy:hit', { id: 'bandit-7', kind: 'bandit', pos: P(0, 1.4, 60), damage: 1, result: 'stagger' }],
      [10, 'enemy:hit', { id: 'bandit-7', kind: 'bandit', pos: P(0, 1.4, 60), damage: 1, kill: true }],
      [12.5, 'enemy:telegraph', { id: 'bandit-8', pos: P(0, 1.4, 60), clip: 'enemyHeavy' }],
    ],
  },
  // night storm (竹林夜雨): rain rises from a drizzle to a downpour; far rolls, then close strikes with cracks; one
  // strike during a fight exchange; the rain eases off at the end
  storm: {
    seconds: 40,
    wind: (t) => ({ strength: t < 10 ? 1.6 : 2.4 }),
    script: [
      [0, 'game:state', { state: 'playing' }],
      [0, 'mood', { name: 'night' }],
      [0.2, 'weather', { rain: 0.25 }],
      [4, 'thunder', { delay: 4.5, strength: 0.18, pan: -0.6 }],
      [7, 'weather', { rain: 0.6 }],
      [9, 'weather', { rain: 1 }],
      [12, 'thunder', { delay: 2.2, strength: 0.45, pan: 0.5 }],
      [19, 'thunder', { delay: 0.5, strength: 0.9, pan: -0.2 }],
      ...steps(20, 8, 3.2, 0.42),
      ...exchange(23.5, 'b1'),
      [26, 'thunder', { delay: 0.15, strength: 1, pan: 0.3 }],
      [30, 'thunder', { delay: 3.5, strength: 0.3, pan: 0.8 }],
      [33, 'weather', { rain: 0.35 }],
    ],
  },
  // the market town: a calm crowd murmuring with vendors calling; the fight starts (a gasp, screams, the scatter),
  // they cower, the fight ends and the market slowly comes back (world/citizens.js 'crowd' events at 4 Hz)
  crowd: {
    seconds: 26,
    wind: () => ({ strength: 0.5 }),
    script: (() => {
      const out = [[0, 'game:state', { state: 'playing' }]];
      for (let t = 0.1; t < 26; t += 0.25) {
        let calm = 0.75, panic = 0, scream = 0;
        if (t >= 8 && t < 17) { calm = t < 9 ? 0.75 * (9 - t) : 0.04; panic = t < 10 ? 1 : t < 13 ? 1 - (t - 10) / 3 * 0.8 : 0.2 * (17 - t) / 4; }
        if (t >= 17) calm = Math.min(0.75, (t - 17) / 6 * 0.75);
        if (t >= 8 && t < 11 && Math.round(t * 4) % 3 === 0) scream = 1;
        out.push([t, 'crowd', { calm, panic, scream, pos: P(3, 1.5, -4), call: t < 8 || t > 20 ? P(-2, 1.5, -6) : null }]);
      }
      out.push([8, 'wave:start', { index: 1, title: '灯市', count: 4 }]);
      out.push([16, 'wave:clear', { index: 1 }]);
      return out;
    })(),
  },
  // the crowd alone (no score): murmur and calls, the scatter, the return — for levels and listening
  crowdOnly: {
    seconds: 26,
    wind: () => ({ strength: 0.3 }),
    get script() { return SCENARIOS.crowd.script.filter(([, type]) => type === 'crowd'); },
  },
  crowdBase: {
    seconds: 26,
    wind: () => ({ strength: 0.3 }),
    script: [],
  },
  // every one-shot, one per second, for audition
  sfx: {
    seconds: 34,
    script: (() => {
      const list = [
        ['sword:whoosh', { speed: 8, pos: P(0, 1.4, 3) }], ['sword:whoosh', { speed: 15, pos: P(0, 1.4, 3) }],
        ['sword:whoosh', { speed: 18, heavy: true, pos: P(0, 1.4, 3) }], ['sword:clash', { strength: 0.5, pos: P(0, 1.4, 3) }],
        ['sword:clash', { strength: 1.2, pos: P(0, 1.4, 3) }], ['player:parry', { perfect: true, pos: P(0, 1.4, 3) }],
        ['player:parry', { perfect: false, pos: P(0, 1.4, 3) }], ['player:parry', { perfect: false, broke: true, pos: P(0, 1.4, 3) }],
        ['enemy:hit', { damage: 15, pos: P(0, 1.4, 3) }], ['enemy:hit', { damage: 40, heavy: true, pos: P(0, 1.4, 3) }],
        ['enemy:hit', { damage: 40, kill: true, pos: P(0, 1.4, 3) }], ['player:hurt', { damage: 25, pos: P(0, 1.4, 3) }],
        ['player:step', { speed: 2, pos: P(0, 0, 5) }], ['player:step', { speed: 6, pos: P(0, 0, 5) }],
        ['player:dodge', {}], ['player:evade', {}], ['enemy:telegraph', { pos: P(0, 1.6, 3) }],
        ['enemy:telegraph', { unblockable: true, pos: P(0, 1.6, 3) }], ['special', { pos: P(0, 1.4, 4) }],
        ['lockon', { id: 1 }], ['enemy:posture', { broken: true }], ['player:land', {}], ['player:charged', {}],
        ['ui:sfx', { kind: 'brush' }], ['ui:sfx', { kind: 'seal' }], ['ui:sfx', { kind: 'tick' }], ['ui:sfx', { kind: 'hover' }],
        ['ui:sfx', { kind: 'open' }], ['ui:sfx', { kind: 'close' }], ['ui:sfx', { kind: 'focus' }],
      ];
      return list.map(([type, p], i) => [1 + i, type, p]);   // no game:state → the score stays silent
    })(),
    wind: () => ({ strength: 0.2, gust: 0.05, gustAhead: 0.05, flutter: 0, pan: 0 }),
  },
};

/** Levels and sanity checks. */
export function analyse(buf) {
  const n = buf.length, sr = buf.sampleRate, chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  let peak = 0, sum = 0, nan = 0, clip = 0, dc = 0;
  const win = sr, secs = [];
  let ws = 0, wc = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const d of chs) {
      const x = d[i];
      if (!Number.isFinite(x)) { nan++; continue; }
      const a = Math.abs(x);
      if (a > peak) peak = a;
      if (a >= 0.999) clip++;
      sum += x * x; dc += x; m += x * x;
    }
    ws += m / chs.length; wc++;
    if (wc === win) { secs.push(Math.sqrt(ws / wc)); ws = 0; wc = 0; }
  }
  const db = (x) => (x > 0 ? +(20 * Math.log10(x)).toFixed(1) : -Infinity);
  const rms = Math.sqrt(sum / (n * chs.length));
  return {
    seconds: +(n / sr).toFixed(2), peakDb: db(peak), rmsDb: db(rms), loudestSecDb: db(Math.max(...secs, 0)), quietestSecDb: db(Math.min(...secs)),
    clipped: clip, nan, dc: +(dc / (n * chs.length)).toExponential(2), perSecondDb: secs.map((x) => db(x)),
  };
}

/** 16-bit PCM WAV, base64. */
export function wavBase64(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const bytes = 44 + n * ch * 2, ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const d = []; for (let c = 0; c < ch; c++) d.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const x = Math.max(-1, Math.min(1, d[c][i] || 0)); v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2; }
  const u8 = new Uint8Array(ab);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function runAudioTest(app) {
  const only = (app.params.get('only') || '').split(',').filter(Boolean);
  const root = document.getElementById('hud');
  root.style.cssText += ';background:#12110d;color:#e8d3ad;font:13px/1.5 ui-monospace,monospace;padding:24px;white-space:pre;overflow:auto;pointer-events:auto';
  root.textContent = 'rendering…\n';
  app.progress(1, '');
  await app.ready();
  const results = [];
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    if (only.length && !only.includes(name)) continue;
    const t0 = performance.now();
    const windFn = typeof sc.wind === 'function' ? sc.wind : null;
    let r;
    try {
      r = await renderOffline({
        seconds: sc.seconds, sampleRate: 48000, script: sc.script, listener: L,
        wind: windFn ? ((t) => { const w = windFn(t); return w.gust !== undefined ? w : { ...gustAt(t, w.strength ?? 1) }; }) : { strength: 1 },
      });
    } catch (e) { root.textContent += `${name}: FAILED ${e.stack || e}\n`; results.push({ name, error: String(e) }); continue; }
    const stats = analyse(r.buffer);
    const ms = Math.round(performance.now() - t0);
    results.push({ name, stats, music: r.music, ms, wav: wavBase64(r.buffer) });
    root.textContent += `${name.padEnd(8)} ${String(ms).padStart(6)} ms  peak ${stats.peakDb} dBFS  rms ${stats.rmsDb}  loudest 1s ${stats.loudestSecDb}  ` +
      `quietest ${stats.quietestSecDb}  clip ${stats.clipped}  nan ${stats.nan}  dc ${stats.dc}  renders ${r.music.renders}\n`;
  }
  window.__audioTest = results;
  window.__audioTestDone = true;
}

// gust field at the default listener spot, scaled to a strength (renderOffline's function form)
function gustAt(t, strength) {
  const w = G.uWind.value, z0 = w.z;
  w.z = strength;
  const x = 0, z = 6;
  const r = { gust: windGust(x, z, t), gustAhead: windGust(x - w.x * 14, z - w.y * 14, t), flutter: windFlutter(x, z, t), strength, pan: 0.3 };
  w.z = z0;
  return r;
}
