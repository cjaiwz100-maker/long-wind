// Generative score: guqin (古琴) and xiao (箫) over the wind, rising into tanggu (堂鼓) drums for the fights.
// Owner: audio (U).
//
// Pitch world: the guqin's standard tuning (正调) is an F-gong pentatonic, F G A C D. We sit in the 羽 mode (tonic D):
// the minor-coloured mode of long-distance, solitary music. Phrases walk mostly by step, leap by fourths and fifths,
// end on D or A, and are separated by silence (留白) — the rests matter as much as the notes.
//
// Structure: an event queue filled one bar at a time by the generator for the current state, drained ~0.25 s ahead of
// the audio clock. Guqin notes are Karplus–Strong renders (instruments.js); they are pre-rendered up to 2 s ahead
// under a per-frame time budget and cached, so a render never lands on a frame that is also scheduling a hit.
//
//   const m = createMusic(E)
//   m.update(now, budgetMs = 3)       — drive from the frame loop (or from an offline stepper with budget Infinity)
//   m.setState(name, now)             — 'title' | 'calm' | 'battle' | 'boss' | 'victory' | 'defeat' | 'silence'
//   m.setIntensity(x)                 — 0..1 inside battle/boss (enemies alive, telegraphs, low health)
//   m.setLowHealth(bool)              — heartbeat drum under the fight
//   m.sting(kind, now)                — 'wave' | 'boss' | 'clear' | 'phase' | 'kill' | 'finalKill'
//   m.state / m.stats()
import { renderQin, renderHarmonic, playBuffer, playXiao, playDrum, playGong } from './instruments.js';

// 正调 pentatonic pitch classes F G A C D, from C2 (the qin's lowest open string) to D6.
const PCS = new Set([5, 7, 9, 0, 2]);
const SCALE = [];
for (let m = 36; m <= 86; m++) if (PCS.has(m % 12)) SCALE.push(m);
const idxOf = (midi) => { let b = 0, d = 99; SCALE.forEach((m, i) => { const e = Math.abs(m - midi); if (e < d) { d = e; b = i; } }); return b; };
const STABLE = new Set([2, 9]);            // D and A: where phrases come to rest in 羽 mode

const TEMPO = { title: 52, calm: 56, battle: 84, boss: 96, victory: 54, defeat: 48, silence: 60 };
const LEVEL = { title: 1, calm: 0.8, battle: 0.62, boss: 0.7, victory: 1, defeat: 0.9, silence: 0 };
const LOOKAHEAD = 0.25, PRERENDER = 2.2, HORIZON = 3.0, CACHE = 48;

export function createMusic(E) {
  const { ctx } = E;
  const rng = E.rng;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const chance = (p) => rng() < p;

  // ---- output: layer buses → master music gain → E.buses.music. The qin gets its body resonance here, once. ----
  const master = ctx.createGain(); master.gain.value = 0;
  master.connect(E.buses.music);
  const qinBody = ctx.createBiquadFilter(); qinBody.type = 'peaking'; qinBody.frequency.value = 105; qinBody.Q.value = 1.1; qinBody.gain.value = 4;
  const qinWood = ctx.createBiquadFilter(); qinWood.type = 'peaking'; qinWood.frequency.value = 260; qinWood.Q.value = 1.4; qinWood.gain.value = 2.5;
  const qinAir = ctx.createBiquadFilter(); qinAir.type = 'lowpass'; qinAir.frequency.value = 5200; qinAir.Q.value = 0.5;
  const layers = {};
  for (const name of ['qin', 'xiao', 'drum']) { layers[name] = ctx.createGain(); layers[name].gain.value = 1; }
  layers.qin.connect(qinBody).connect(qinWood).connect(qinAir).connect(master);
  layers.xiao.connect(master);
  layers.drum.connect(master);
  // per-layer sends so every layer lives in the same valley (reverb + ridge echo)
  const sends = {};
  for (const [name, rev, echo] of [['qin', 0.34, 0.1], ['xiao', 0.5, 0.14], ['drum', 0.26, 0.16]]) {
    const r = ctx.createGain(); r.gain.value = rev; const e = ctx.createGain(); e.gain.value = echo;
    (name === 'qin' ? qinAir : layers[name]).connect(r).connect(E.reverb);
    (name === 'qin' ? qinAir : layers[name]).connect(e).connect(E.echo);
    sends[name] = { r, e };
  }

  // ---- state ----
  const S = {
    state: 'silence', tempo: 60, beat: 1, bar: 0, cursor: 0, intensity: 0.3, lowHp: false,
    lastPhraseEnd: -99, pendingVictory: false, qinRenders: 0, cacheHits: 0, scheduled: 0, dropped: 0,
    lastIdx: idxOf(62), section: 0,
  };
  const queue = [];                       // pending events sorted by t: { t, kind, ...params, buf? }
  const cache = new Map();                // qin render cache (LRU by insertion order)

  function push(ev) {
    let i = queue.length;
    while (i > 0 && queue[i - 1].t > ev.t) i--;
    queue.splice(i, 0, ev);
  }
  function clearFrom(t) { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].t >= t) queue.splice(i, 1); }

  // ---- qin rendering (cached) ----
  function qinKey(ev) { return `${ev.midi}|${ev.orn}|${ev.to ?? ''}|${Math.round(ev.dur * 2)}|${Math.round(ev.vel * 5)}|${ev.harm ? 1 : 0}|${ev.t60 ?? ''}`; }
  function ornPath(ev) {
    const hold = Math.min(ev.dur * 0.45, 0.35 + rng() * 0.3);
    switch (ev.orn) {
      case 'up': case 'down': {           // 上 / 下: pluck, hold, then the left hand walks to the next pitch (走手音)
        const d = (ev.to ?? ev.midi) - ev.midi;
        return { path: [[0, 0], [hold, 0], [hold + 0.22 + 0.08 * Math.abs(d) / 3, d]], vib: null };
      }
      case 'chuo': return { path: [[0, -2], [0.14, 0]], vib: null };                  // 绰: slide up into the note
      case 'zhu': return { path: [[0, 2], [0.16, 0]], vib: null };                    // 注: slide down into the note
      case 'yin': return { path: null, vib: { rate: 5.2, depth: 0.22, start: 0.35, decay: 0.55 } };  // 吟: small, quick
      case 'nao': return { path: [[0, 0], [0.3, 0.35], [0.55, 0]], vib: { rate: 3.4, depth: 0.45, start: 0.55, decay: 0.45 } }; // 猱: wide
      case 'sigh': return { path: [[0, 0], [0.6, 0], [2.2, -5]], vib: { rate: 4.2, depth: 0.2, start: 2.2, decay: 0.8 } };     // defeat
      default: return { path: null, vib: null };
    }
  }
  function renderEv(ev) {
    const key = qinKey(ev);
    let buf = cache.get(key);
    if (buf) { cache.delete(key); cache.set(key, buf); S.cacheHits++; return buf; }
    if (ev.harm) buf = renderHarmonic(ctx, { midi: ev.midi, dur: ev.dur, vel: ev.vel, seed: ev.midi });
    else {
      const { path, vib } = ornPath(ev);
      const bright = ev.bright ?? (0.35 + 0.25 * ev.vel);
      buf = renderQin(ctx, { midi: ev.midi, dur: ev.dur, vel: ev.vel, path, vib, bright, t60: ev.t60 ?? null, pluckPos: ev.midi < 48 ? 0.2 : 0.13, seed: (ev.midi * 7 + ev.dur * 13) | 0 });
    }
    S.qinRenders++;
    cache.set(key, buf);
    if (cache.size > CACHE) cache.delete(cache.keys().next().value);
    return buf;
  }

  // ---- event builders ----
  const B = () => 60 / S.tempo;                // seconds per beat
  function qin(t, midi, beats, { vel = 0.7, orn = 'plain', to, pan = -0.12, cuo = false, harm = false, damp = 0 } = {}) {
    // damp > 0: the right hand stops the string (fights), so notes are short and the texture stays clear
    const dur = damp ? Math.min(3, beats * B() + 0.9) : Math.min(6.5, Math.max(1.2, beats * B() + (harm ? 2.5 : 1.8)));
    const t60 = damp ? damp : null;
    const jit = (rng() - 0.5) * (damp ? 0.012 : 0.05);            // human rubato (tighter in the fight)
    push({ t: t + jit, kind: 'qin', midi, dur, vel, orn, to, pan, harm, t60 });
    if (cuo) push({ t: t + jit + 0.012, kind: 'qin', midi: midi - 12, dur, vel: vel * 0.7, orn: 'plain', pan: pan - 0.08, t60 }); // 撮: octave pair
  }
  function xiao(t, midi, beats, { vel = 0.5, scoop = 0.45, vib = 0.18, pan = 0.22 } = {}) {
    push({ t, kind: 'xiao', midi, dur: beats * B(), vel, scoop, vib, pan });
  }
  function drum(t, vel, { tone = 0, pitch = 1, big = false, pan = 0 } = {}) { push({ t, kind: 'drum', vel, tone, pitch, big, pan }); }
  function gong(t, vel = 0.7) { push({ t, kind: 'gong', vel }); }
  /** 滚拂: the hand sweeps across the strings, down then back up — the qin's great gesture of wind and water. */
  function gunfu(t, { up = true, n = 9, vel = 0.5, top = 74 } = {}) {
    const hi = idxOf(top), lo = Math.max(0, hi - n + 1);
    for (let k = 0; k < n; k++) {
      const i = up ? lo + k : hi - k;
      qin(t + k * 0.055 + rng() * 0.012, SCALE[i], 1.2, { vel: vel * (0.75 + 0.35 * (k / n)), pan: -0.3 + 0.5 * (k / n) });
    }
  }

  // ---- phrase generators ----
  function stepIdx(i, lo, hi) {
    const r = rng();
    const d = r < 0.32 ? -1 : r < 0.64 ? 1 : r < 0.74 ? -2 : r < 0.86 ? 2 : r < 0.93 ? 3 : -3;
    let j = i + d;
    if (j < lo) j = lo + (lo - j); if (j > hi) j = hi - (j - hi);
    return Math.max(lo, Math.min(hi, j));
  }
  function toStable(i, lo, hi) {
    for (let d = 0; d < 4; d++) {
      for (const s of [i - d, i + d]) if (s >= lo && s <= hi && STABLE.has(SCALE[s] % 12)) return s;
    }
    return i;
  }
  /** A qin phrase starting at t; returns its end time. */
  function qinPhrase(t, { lo = idxOf(48), hi = idxOf(69), notes = 3 + Math.floor(rng() * 4), vel = 0.66 } = {}) {
    let i = Math.max(lo, Math.min(hi, S.lastIdx + (rng() < 0.5 ? 0 : pick([-2, 2]))));
    let tt = t;
    for (let k = 0; k < notes; k++) {
      const last = k === notes - 1;
      let ni = last ? toStable(stepIdx(i, lo, hi), lo, hi) : stepIdx(i, lo, hi);
      const beats = last ? pick([3, 4, 4, 5]) : pick([0.5, 1, 1, 1, 1.5, 2]);
      const v = vel * (k === 0 ? 1.1 : 0.85 + rng() * 0.2);
      // a step to the next note is often walked with the left hand instead of plucked again (走手音)
      if (!last && Math.abs(ni - i) === 1 && chance(0.3)) {
        qin(tt, SCALE[i], beats + 1, { vel: v, orn: ni > i ? 'up' : 'down', to: SCALE[ni] });
        tt += (beats + 1) * B();
        i = ni;
        continue;
      }
      const orn = last ? pick(['yin', 'nao', 'yin', 'plain']) : beats >= 1.5 ? pick(['yin', 'plain', 'chuo', 'zhu']) : pick(['plain', 'plain', 'chuo']);
      qin(tt, SCALE[i], beats, { vel: v, orn, cuo: last && chance(0.45) && SCALE[i] - 12 >= 36 });
      tt += beats * B();
      i = ni;
    }
    S.lastIdx = i;
    return tt;
  }
  function harmonics(t, n = 2 + Math.floor(rng() * 3)) {
    let i = idxOf(74 + Math.floor(rng() * 6));
    let tt = t;
    for (let k = 0; k < n; k++) {
      qin(tt, SCALE[i], 1, { vel: 0.5 + rng() * 0.2, harm: true, pan: 0.1 });
      tt += pick([0.5, 1, 1, 1.5]) * B();
      i = Math.max(idxOf(72), Math.min(idxOf(86), i + pick([-1, 1, 2, -2])));
    }
    return tt;
  }
  function xiaoPhrase(t, { lo = idxOf(62), hi = idxOf(81), notes = 2 + Math.floor(rng() * 2), vel = 0.5 } = {}) {
    let i = Math.max(lo, Math.min(hi, idxOf(69) + pick([-1, 0, 1, 2])));
    let tt = t;
    for (let k = 0; k < notes; k++) {
      const last = k === notes - 1;
      const beats = last ? pick([4, 5, 6]) : pick([1.5, 2, 3]);
      xiao(tt, SCALE[i], beats, { vel: vel * (0.9 + rng() * 0.2), scoop: 0.3 + rng() * 0.4, vib: last ? 0.22 : 0.12 });
      tt += beats * B() + 0.05;
      i = last ? i : (k === notes - 2 ? toStable(stepIdx(i, lo, hi), lo, hi) : stepIdx(i, lo, hi));
    }
    return tt;
  }

  // ---- bar planners per state ----
  function planAmbient(t0, bars, { density = 0.6, xiaoP = 0.35, harmP = 0.2 } = {}) {
    // free-time music: a phrase, then silence. Plans in multi-bar chunks so phrases can cross bar lines.
    if (t0 < S.lastPhraseEnd) return;
    const barLen = 4 * B();
    if (rng() > density) { S.lastPhraseEnd = t0 + barLen * (1 + Math.floor(rng() * 2)); return; }
    let end;
    if (chance(harmP)) end = harmonics(t0 + rng() * B());
    else end = qinPhrase(t0 + rng() * B() * 0.5);
    if (chance(xiaoP)) end = Math.max(end, xiaoPhrase(end - B() * (0.5 + rng())));
    // an open low string under the phrase now and then, like a distant bell
    if (chance(0.35)) qin(t0, pick([38, 45, 36]), 4, { vel: 0.5, orn: 'plain', pan: -0.25 });
    S.lastPhraseEnd = end + barLen * (0.4 + rng() * bars);  // 留白
  }

  const PAT = {
    // 16-step drum grids per bar: [step, vel, opts]
    1: [[0, 0.8, { big: true }], [8, 0.45], [12, 0.25, { tone: 1 }]],
    2: [[0, 0.85, { big: true }], [6, 0.4], [8, 0.6], [11, 0.35], [12, 0.5], [4, 0.2, { tone: 1 }], [14, 0.25, { tone: 1 }]],
    3: [[0, 1, { big: true }], [3, 0.45], [6, 0.55], [8, 0.85, { big: true }], [10, 0.4], [11, 0.5], [12, 0.6], [14, 0.45], [15, 0.4],
      [2, 0.25, { tone: 1 }], [5, 0.2, { tone: 1 }], [13, 0.3, { tone: 1 }]],
  };
  const OSTINATO = [
    [[0, 38, 'plain', true], [6, 45, 'plain'], [10, 48, 'chuo'], [12, 50, 'down', false, 48]],
    [[0, 41, 'plain', true], [6, 48, 'plain'], [8, 45, 'zhu'], [12, 38, 'yin']],
    [[0, 38, 'plain', true], [4, 45, 'plain'], [8, 50, 'up', false, 53], [14, 48, 'plain']],
    [[0, 36, 'plain', true], [6, 43, 'plain'], [8, 45, 'plain'], [12, 38, 'down', false, 36]],
  ];
  function planFight(t0, boss) {
    const st = B() / 4, bar = S.bar, x = S.intensity;
    const lvl = boss ? 3 : x > 0.62 ? 2 : 1;
    const barLen = 16 * st;
    // drums
    for (const [s, v, o = {}] of PAT[lvl]) {
      if (lvl < 3 && o.tone && rng() < 0.3) continue;
      drum(t0 + s * st + (rng() - 0.5) * 0.008, v * (0.5 + 0.3 * x), { ...o, pitch: o.tone ? 1 : (o.big ? 0.95 : 1.05 + rng() * 0.08), pan: o.tone ? 0.25 : (rng() - 0.5) * 0.2 });
    }
    // a roll into every 4th downbeat (and every 2nd in the boss fight)
    if (bar % (boss ? 2 : 4) === 3 || (boss && bar % 2 === 1)) {
      const n = boss ? 8 : 5;
      for (let k = 0; k < n; k++) drum(t0 + (16 - n + k) * st, 0.28 + 0.5 * (k / n), { pitch: 1.1, pan: 0.1 });
    }
    // heartbeat under the fight when health is low (lub-dub)
    if (S.lowHp) for (const s of [0, 8]) { drum(t0 + s * st, 0.45, { pitch: 0.62 }); drum(t0 + (s + 1.5) * st, 0.3, { pitch: 0.6 }); }
    // qin ostinato (two-bar cells)
    const cell = OSTINATO[(Math.floor(bar / 2) + (boss ? 1 : 0)) % OSTINATO.length];
    if (bar % 2 === 0 || boss || x > 0.6) {
      for (const [s, m, orn, cuo, to] of cell) qin(t0 + s * st, m, 1.5, { vel: 0.55 + 0.2 * x, orn, cuo: !!cuo && (boss || x > 0.45), to, pan: -0.18, damp: 1.6 });
    }
    // high tension: repeated-note figure (a qin tremolo of plucks) or a 滚拂 sweep at section climaxes
    if (boss && bar % 8 === 7) gunfu(t0 + 11 * st, { up: true, n: 10, vel: 0.55, top: 79 });
    else if (x > 0.55 && bar % 2 === 1) {
      const m = pick([57, 60, 62]);
      for (let k = 0; k < 4; k++) qin(t0 + (8 + k * 2) * st, k === 3 ? SCALE[idxOf(m) - 1] : m, 0.5, { vel: 0.36 + 0.08 * k, pan: 0.05, damp: 1.1 });
    }
    // xiao: a long high cry every few bars
    if (bar % (boss ? 4 : 8) === 2 && chance(0.85)) xiao(t0 + 2 * st, pick(boss ? [74, 77, 79] : [72, 74, 77]), boss ? 9 : 7, { vel: 0.5 + 0.1 * x, scoop: 0.8, vib: 0.26 });
    // gong at the head of each boss section
    if (boss && bar % 8 === 0) gong(t0, 0.55);
    return barLen;
  }

  // ---- the generator: extends the queue up to the horizon ----
  function extend(now) {
    while (S.cursor < now + HORIZON) {
      const t0 = S.cursor, beat = B();
      let len = 4 * beat;
      switch (S.state) {
        case 'title': planAmbient(t0, 2, { density: 0.8, xiaoP: 0.45, harmP: 0.25 }); break;
        case 'calm': planAmbient(t0, 3, { density: 0.55, xiaoP: 0.3, harmP: 0.25 }); break;
        case 'victory': planAmbient(t0, 2, { density: 0.75, xiaoP: 0.6, harmP: 0.3 }); break;
        case 'defeat': planAmbient(t0, 4, { density: 0.3, xiaoP: 0.2, harmP: 0 }); break;
        case 'battle': len = planFight(t0, false); break;
        case 'boss': len = planFight(t0, true); break;
        default: break;                                   // silence
      }
      S.cursor = t0 + len;
      S.bar++;
    }
  }

  // ---- scheduling ----
  function fire(ev) {
    S.scheduled++;
    switch (ev.kind) {
      case 'qin': playBuffer(E, ev.buf ?? renderEv(ev), ev.t, { dest: layers.qin, gain: 0.95, pan: ev.pan }); break;
      case 'xiao': playXiao(E, { t: ev.t, midi: ev.midi, dur: ev.dur, vel: ev.vel, scoop: ev.scoop, vibDepth: ev.vib, dest: layers.xiao, pan: ev.pan }); break;
      case 'drum': playDrum(E, { t: ev.t, vel: ev.vel, tone: ev.tone, pitch: ev.pitch, big: ev.big, dest: layers.drum, pan: ev.pan }); break;
      case 'gong': playGong(E, { t: ev.t, vel: ev.vel, dest: layers.drum }); break;
      default: break;
    }
  }

  function update(now, budgetMs = 3) {
    extend(now);
    // pre-render guqin notes that start soon, oldest first, within the frame budget
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    for (let i = 0; i < queue.length; i++) {
      const ev = queue[i];
      if (ev.t > now + PRERENDER) break;
      if (ev.kind === 'qin' && !ev.buf) {
        ev.buf = renderEv(ev);
        if (budgetMs !== Infinity && performance.now() - t0 > budgetMs) break;
      }
    }
    // fire everything inside the lookahead window
    while (queue.length && queue[0].t < now + LOOKAHEAD) {
      const ev = queue.shift();
      if (ev.t < now - 0.08) { S.dropped++; continue; }      // missed (tab was asleep): never play late
      fire(ev);
    }
  }

  // ---- state changes ----
  function setState(name, now = ctx.currentTime) {
    if (!(name in TEMPO) || name === S.state) return;
    const prev = S.state;
    S.state = name;
    // re-plan from the next beat of the old grid (fights start at once; calm music lets the current phrase ring)
    const hard = name === 'battle' || name === 'boss' || name === 'silence' || name === 'defeat' || prev === 'battle' || prev === 'boss';
    const b = 60 / S.tempo;
    const next = hard ? now + 0.12 : Math.max(now + 0.12, S.lastPhraseEnd > now ? Math.min(S.lastPhraseEnd, now + 6) : now + b);
    clearFrom(next);
    S.tempo = TEMPO[name];
    S.cursor = next; S.bar = 0; S.lastPhraseEnd = next;
    master.gain.setTargetAtTime(LEVEL[name], now, name === 'silence' ? 0.4 : 1.2);
    if (name === 'defeat') {
      // one low string, pressed and let fall a fourth: a sigh; then long silence
      qin(next + 0.3, 50, 6, { vel: 0.75, orn: 'sigh', pan: -0.1 });
      S.lastPhraseEnd = next + 9;
    }
    if (name === 'victory') {
      // a resolving cadence: harmonics, then the tonic with its octave, the xiao answering above
      const e1 = harmonics(next + 0.6, 3);
      qin(e1 + 0.2, 62, 5, { vel: 0.72, orn: 'nao', cuo: true });
      xiaoPhrase(e1 + 1.6 * (60 / S.tempo), { notes: 3, vel: 0.55 });
      S.lastPhraseEnd = e1 + 12;
    }
  }

  function sting(kind, now = ctx.currentTime) {
    const t = now + 0.05;
    if (kind === 'wave' || kind === 'boss') {
      // a drum roll swelling into one great hit; the boss gets the gong
      const n = kind === 'boss' ? 14 : 9;
      for (let k = 0; k < n; k++) drum(t + k * 0.075, 0.2 + 0.55 * Math.pow(k / n, 1.5), { pitch: 1.12, pan: (k & 1 ? 0.12 : -0.12) });
      drum(t + n * 0.075 + 0.04, 1, { big: true, pitch: 0.9 });
      if (kind === 'boss') gong(t + n * 0.075 + 0.05, 0.85);
      if (S.cursor < t + n * 0.075 + 0.5) S.cursor = t + n * 0.075 + 0.04;   // the first bar lands on the big hit
    } else if (kind === 'clear') {
      gunfu(t + 0.4, { up: true, n: 8, vel: 0.5, top: 74 });
      harmonics(t + 1.6, 2);
    } else if (kind === 'phase') {
      gong(t, 0.9); drum(t, 1, { big: true, pitch: 0.85 }); drum(t + 0.42, 0.7, { big: true, pitch: 0.8 });
    } else if (kind === 'kill') {
      drum(t, 0.55, { pitch: 0.9, big: true });
    } else if (kind === 'finalKill') {
      // the Hero moment: everything stops; one gong far away; the wind takes the silence
      setState('silence', now);
      gong(t + 0.9, 0.5);
    }
  }

  return {
    update, setState, sting,
    setIntensity(x) { S.intensity = Math.max(0, Math.min(1, x)); },
    setLowHealth(on) { S.lowHp = !!on; },
    get state() { return S.state; },
    stats: () => ({ state: S.state, queue: queue.length, renders: S.qinRenders, cacheHits: S.cacheHits, cache: cache.size, scheduled: S.scheduled, dropped: S.dropped }),
    output: master,
  };
}
