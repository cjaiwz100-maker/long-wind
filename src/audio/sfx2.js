// More one-shots (same conventions as sfx.js: engine E, start time t, options, placement p). Owner: audio (U).
//
//   voice     — formant-synthesised shouts and cries: kiai (ha / hya / haa), breath, grunt, pain, death, roar. A glottal
//               pulse (harmonics rolling off ~1/n^1.3, vibrato + jitter, a sub-octave "strain" for effort) plus
//               aspiration noise, through four parallel formant bands that glide between vowels.
//   bodyfall  — a body hitting the grass: saturated thud, cloth, flattened grass, the limbs landing a beat later
//   clatter   — a dropped blade: two short metal knocks, dulled by the grass
//   bow       — string release: a low twang, the pluck, the arrow leaving
//   arrowWhiz — an arrow passing close: a narrow band sweeping down (doppler) with a faint whistle
//   arrowThunk— an arrow striking wood / earth: a knock and the shaft quivering
//   shield    — rattan shield: a dull woody knock and creak; broke = splintering crack and a heavy drop
import { noiseBand, envGain, tone, ring, rnd, place } from './sfx.js';

// male formants (Hz, bandwidth Hz, relative amp)
const V = {
  a: [[760, 90, 1], [1150, 100, 0.55], [2500, 140, 0.28], [3500, 180, 0.12]],
  uh: [[640, 90, 1], [1190, 100, 0.45], [2390, 140, 0.2], [3400, 180, 0.08]],
  e: [[530, 70, 1], [1840, 100, 0.42], [2480, 130, 0.25], [3500, 180, 0.1]],
  o: [[560, 80, 1], [860, 90, 0.5], [2420, 140, 0.14], [3400, 180, 0.06]],
  i: [[300, 60, 1], [2200, 110, 0.35], [2950, 150, 0.25], [3700, 180, 0.1]],
};

// glottal pulse wave (cached per context)
const waves = new WeakMap();
function glottal(E) {
  let w = waves.get(E.ctx);
  if (!w) {
    const n = 48, re = new Float32Array(n), im = new Float32Array(n);
    for (let h = 1; h < n; h++) { im[h] = Math.pow(h, -1.3) * (h % 2 ? 1 : 0.8); re[h] = 0.15 * Math.pow(h, -1.6); }
    w = E.ctx.createPeriodicWave(re, im);
    waves.set(E.ctx, w);
  }
  return w;
}

/**
 * One utterance. shape: { dur, pitch: [[dt, ratio], ...], vowels: [[dt, name], ...], breath (0..1 aspiration),
 * onsetH (seconds of /h/), strain (sub-octave roughness 0..1), peak, fry (vocal fry at the end 0..1) }.
 */
function utter(E, t, f0, S, dest) {
  const { dur, pitch, vowels, breath = 0.3, onsetH = 0.03, strain = 0.2, peak = 0.5, fry = 0, attack = 0.015 } = S;
  const src = E.ctx.createGain();
  // voiced source
  const osc = E.ctx.createOscillator(); osc.setPeriodicWave(glottal(E));
  osc.frequency.setValueAtTime(f0 * pitch[0][1], t);
  for (const [dt, r] of pitch.slice(1)) osc.frequency.exponentialRampToValueAtTime(f0 * r, t + dt);
  // vibrato + jitter
  const vib = E.ctx.createOscillator(); vib.frequency.value = 5.5 + E.rng() * 1.5;
  const vg = E.ctx.createGain(); vg.gain.value = f0 * 0.018; vib.connect(vg).connect(osc.frequency);
  const jit = E.noiseSrc(E.noise.brown, t, dur + 0.1);
  const jg = E.ctx.createGain(); jg.gain.value = f0 * 0.05; jit.connect(jg).connect(osc.frequency);
  const vox = E.ctx.createGain();
  vox.gain.setValueAtTime(0, t);
  vox.gain.linearRampToValueAtTime(0, t + onsetH);
  vox.gain.linearRampToValueAtTime(1, t + onsetH + attack);
  vox.gain.setValueAtTime(1, t + dur * 0.55);
  vox.gain.linearRampToValueAtTime(0, t + dur);
  // strain: amplitude modulated at half the pitch (the rasp of a shout), fry: slow pulsing at the end
  if (strain > 0 || fry > 0) {
    const am = E.ctx.createGain(); am.gain.value = 1 - strain * 0.5;
    const sub = E.ctx.createOscillator(); sub.frequency.setValueAtTime(f0 * pitch[0][1] * 0.5, t);
    for (const [dt, r] of pitch.slice(1)) sub.frequency.exponentialRampToValueAtTime(f0 * r * 0.5, t + dt);
    const sg = E.ctx.createGain(); sg.gain.value = strain * 0.5;
    sub.connect(sg).connect(am.gain);
    if (fry > 0) {
      const fr = E.ctx.createOscillator(); fr.type = 'square'; fr.frequency.value = 38 + E.rng() * 10;
      const fg = E.ctx.createGain(); fg.gain.setValueAtTime(0, t); fg.gain.linearRampToValueAtTime(0, t + dur * 0.5); fg.gain.linearRampToValueAtTime(fry * 0.6, t + dur * 0.8);
      fr.connect(fg).connect(am.gain); fr.start(t); fr.stop(t + dur + 0.05);
    }
    osc.connect(am).connect(vox);
    sub.start(t); sub.stop(t + dur + 0.05);
  } else osc.connect(vox);
  vox.connect(src);
  // aspiration: strong for the /h/ onset, then a breath under the voice
  const asp = noiseBand(E, t, dur + 0.05, { type: 'highpass', f: 600, q: 0.5, buf: E.noise.pink });
  const ag = E.ctx.createGain();
  ag.gain.setValueAtTime(0, t);
  ag.gain.linearRampToValueAtTime(0.9, t + Math.max(0.006, onsetH * 0.6));
  ag.gain.linearRampToValueAtTime(breath, t + onsetH + attack);
  ag.gain.linearRampToValueAtTime(0, t + dur);
  asp.connect(ag).connect(src);
  osc.start(t); osc.stop(t + dur + 0.05); vib.start(t); vib.stop(t + dur + 0.05);
  E.track(osc, t + dur);
  // formants
  const env = E.ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + Math.min(0.02, dur * 0.2));
  env.gain.setValueAtTime(peak, t + dur * 0.5);
  env.gain.linearRampToValueAtTime(0, t + dur + 0.02);
  const v0 = V[vowels[0][1]];
  for (let i = 0; i < 4; i++) {
    const f = E.ctx.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.setValueAtTime(v0[i][0], t); f.Q.value = v0[i][0] / v0[i][1];
    for (const [dt, name] of vowels.slice(1)) f.frequency.linearRampToValueAtTime(V[name][i][0], t + dt);
    const g = E.ctx.createGain(); g.gain.value = v0[i][2] * (i === 0 ? 1.4 : 2.2);
    src.connect(f).connect(g).connect(env);
  }
  // a little of the raw source for body, darkened
  const lp = E.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
  const lg = E.ctx.createGain(); lg.gain.value = 0.18; src.connect(lp).connect(lg).connect(env);
  env.connect(dest);
}

const SHAPES = {
  // light cut: a sharp breath out, barely voiced
  breath: (r) => ({ dur: 0.16 + r * 0.05, pitch: [[0, 1.2], [0.15, 1.0]], vowels: [[0, 'uh']], breath: 0.9, onsetH: 0.05, strain: 0, peak: 0.2 }),
  // kiai: "ha!"
  ha: (r) => ({ dur: 0.26 + r * 0.06, pitch: [[0, 1.3], [0.08, 1.42], [0.28, 1.0]], vowels: [[0, 'a']], breath: 0.35, onsetH: 0.03, strain: 0.3, peak: 0.55 }),
  // heavy: "hyah!" — /i/ gliding into /a/
  hya: (r) => ({ dur: 0.4 + r * 0.06, pitch: [[0, 1.45], [0.1, 1.6], [0.4, 1.05]], vowels: [[0, 'i'], [0.07, 'e'], [0.13, 'a']], breath: 0.3, onsetH: 0.035, strain: 0.4, peak: 0.62 }),
  // special / execution: a long rising "haaa—"
  haa: (r) => ({ dur: 0.72 + r * 0.1, pitch: [[0, 1.25], [0.25, 1.5], [0.72, 1.12]], vowels: [[0, 'a'], [0.6, 'uh']], breath: 0.28, onsetH: 0.05, strain: 0.45, peak: 0.6 }),
  // hit: a short "uh"
  grunt: (r) => ({ dur: 0.15 + r * 0.06, pitch: [[0, 1.15], [0.16, 0.85]], vowels: [[0, 'uh']], breath: 0.4, onsetH: 0.008, strain: 0.55, peak: 0.42, attack: 0.008 }),
  // heavy hit: "agh"
  pain: (r) => ({ dur: 0.32 + r * 0.08, pitch: [[0, 1.5], [0.06, 1.6], [0.35, 0.9]], vowels: [[0, 'a'], [0.25, 'uh']], breath: 0.4, onsetH: 0.01, strain: 0.6, peak: 0.5, attack: 0.01 }),
  // death: a long falling cry that breaks into fry
  death: (r) => ({ dur: 0.85 + r * 0.25, pitch: [[0, 1.55], [0.08, 1.7], [0.9, 0.72]], vowels: [[0, 'a'], [0.5, 'o'], [0.85, 'uh']], breath: 0.45, onsetH: 0.012, strain: 0.55, peak: 0.52, fry: 0.8, attack: 0.012 }),
  // enemy war cry before a heavy blow: "hoa!"
  roar: (r) => ({ dur: 0.48 + r * 0.1, pitch: [[0, 1.1], [0.14, 1.35], [0.5, 1.0]], vowels: [[0, 'o'], [0.12, 'a']], breath: 0.3, onsetH: 0.04, strain: 0.5, peak: 0.55 }),
};

/** A voiced shout/cry. voice: base pitch in Hz (hero ≈ 125). */
export function voice(E, t, { kind = 'ha', pitch = 125 } = {}, p) {
  const { pan, gain } = place(p);
  const S = (SHAPES[kind] ?? SHAPES.ha)(E.rng());
  const o = E.ctx.createGain();
  utter(E, t, pitch * (0.96 + 0.08 * E.rng()), S, o);
  // chest resonance + presence
  const lo = E.ctx.createBiquadFilter(); lo.type = 'peaking'; lo.frequency.value = 220; lo.gain.value = 3; lo.Q.value = 0.8;
  const hi = E.ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 5000; hi.gain.value = -8;
  o.connect(lo).connect(hi);
  E.out(hi, { gain: gain * 0.8, pan, rev: kind === 'death' || kind === 'haa' ? 0.3 : 0.16, echo: kind === 'haa' || kind === 'roar' ? 0.1 : 0 });
}

export function bodyfall(E, t, { weight = 1 } = {}, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  const sat = E.ctx.createGain(); sat.connect(E.shaper(2)).connect(o);
  for (const [dt, a] of [[0, 1], [0.13 + E.rng() * 0.05, 0.5]]) {
    tone(E, t + dt, 82 / Math.sqrt(weight), { f2: 38, glide: 0.12, peak: 0.85 * a * weight, decay: 0.2, dest: sat });
    const b = noiseBand(E, t + dt, 0.18, { type: 'lowpass', f: 380, buf: E.noise.brown });
    b.connect(envGain(E, t + dt, 0.9 * a * weight, 0.003, 0.1)).connect(o);
    const cl = noiseBand(E, t + dt, 0.25, { f: 900, f2: 500, q: 0.9, buf: E.noise.pink });
    cl.connect(envGain(E, t + dt, 0.22 * a, 0.004, 0.12)).connect(o);
  }
  const gr = noiseBand(E, t + 0.01, 0.6, { type: 'highpass', f: 2600, buf: E.noise.pink });
  gr.connect(envGain(E, t + 0.01, 0.16, 0.01, 0.35)).connect(o);
  E.punch(t, 3, 0.2);
  E.out(o, { gain, pan, rev: 0.14 });
}

export function clatter(E, t, { metal = 1 } = {}, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  const lp = E.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4200;
  lp.connect(o);
  let tt = t;
  for (const a of [1, 0.45, 0.2]) {
    ring(E, tt, rnd(E, 1050, 1350), { amp: 0.06 * a * metal, decayK: 0.3, dest: lp, detune: 7 });
    const c = noiseBand(E, tt, 0.02, { f: 2600, q: 1.2 });
    c.connect(envGain(E, tt, 0.25 * a, 0.0005, 0.008)).connect(lp);
    tone(E, tt, 190, { f2: 120, glide: 0.04, peak: 0.2 * a, decay: 0.05, dest: lp });
    tt += 0.09 + E.rng() * 0.06;
  }
  E.out(o, { gain, pan, rev: 0.12 });
}

export function bow(E, t, _o, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  // the string: a low triangle twang with a fast pitch settle, a little vibrato from the limbs
  const s = E.ctx.createOscillator(); s.type = 'triangle';
  s.frequency.setValueAtTime(205, t); s.frequency.exponentialRampToValueAtTime(162, t + 0.05);
  const vb = E.ctx.createOscillator(); vb.frequency.value = 24; const vg = E.ctx.createGain(); vg.gain.value = 5; vb.connect(vg).connect(s.frequency);
  const sg = envGain(E, t, 0.45, 0.001, 0.32); s.connect(sg).connect(o);
  s.start(t); s.stop(t + 0.8); vb.start(t); vb.stop(t + 0.8); E.track(s, t + 0.7);
  const pl = noiseBand(E, t, 0.02, { f: 1600, q: 1.5 });
  pl.connect(envGain(E, t, 0.5, 0.0005, 0.008)).connect(o);
  tone(E, t, 120, { f2: 70, glide: 0.05, peak: 0.3, decay: 0.06, dest: o });
  // the arrow leaves
  const w = noiseBand(E, t + 0.01, 0.2, { f: 2200, f2: 4800, q: 2.5 });
  w.connect(envGain(E, t + 0.01, 0.18, 0.02, 0.1)).connect(o);
  E.out(o, { gain, pan, rev: 0.25, echo: 0.12 });
}

export function arrowWhiz(E, t, { side = 0 } = {}, p) {
  const { gain } = place(p);
  const o = E.ctx.createGain();
  const n = noiseBand(E, t, 0.32, { f: 4200, f2: 1500, q: 7 });
  const g = E.ctx.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.55, t + 0.12); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  n.connect(g).connect(o);
  tone(E, t + 0.04, 2300, { f2: 1500, glide: 0.24, peak: 0.03, attack: 0.05, decay: 0.12, dest: o });
  const pn = E.ctx.createStereoPanner();
  pn.pan.setValueAtTime(-0.8 * (side || 1), t); pn.pan.linearRampToValueAtTime(0.8 * (side || 1), t + 0.3);
  o.connect(pn);
  E.out(pn, { gain, rev: 0.1 });
}

export function arrowThunk(E, t, { soft = false } = {}, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  tone(E, t, soft ? 150 : 240, { f2: soft ? 80 : 130, glide: 0.04, peak: 0.5, decay: 0.05, dest: o });
  const k = noiseBand(E, t, 0.05, { f: soft ? 700 : 1400, q: 1.8 });
  k.connect(envGain(E, t, 0.4, 0.0006, 0.02)).connect(o);
  // the shaft quivering
  const q = E.ctx.createOscillator(); q.type = 'triangle'; q.frequency.value = soft ? 240 : 380;
  const am = E.ctx.createGain(); am.gain.value = 0;
  const lf = E.ctx.createOscillator(); lf.frequency.value = 32; const lg = E.ctx.createGain(); lg.gain.value = 1; lf.connect(lg).connect(am.gain);
  q.connect(am).connect(envGain(E, t, soft ? 0.03 : 0.07, 0.003, 0.25)).connect(o);
  q.start(t); q.stop(t + 0.6); lf.start(t); lf.stop(t + 0.6); E.track(q, t + 0.5);
  E.out(o, { gain, pan, rev: 0.12 });
}

export function shield(E, t, { broke = false } = {}, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  const sat = E.ctx.createGain(); sat.connect(E.shaper(2)).connect(o);
  tone(E, t, 175, { f2: 105, glide: 0.05, peak: 0.8, decay: 0.09, dest: sat });
  const k = noiseBand(E, t, 0.09, { f: 620, q: 2.2, buf: E.noise.pink });
  k.connect(envGain(E, t, 0.7, 0.0008, 0.04)).connect(o);
  // rattan creak: a buzzy band, amplitude-chopped
  const cr = noiseBand(E, t + 0.01, 0.14, { f: 1300, f2: 900, q: 4 });
  const am = E.ctx.createGain(); am.gain.value = 0.2;
  const lf = E.ctx.createOscillator(); lf.type = 'sawtooth'; lf.frequency.value = 70; const lg = E.ctx.createGain(); lg.gain.value = 0.5; lf.connect(lg).connect(am.gain);
  lf.start(t); lf.stop(t + 0.2);
  cr.connect(am).connect(envGain(E, t + 0.01, 0.35, 0.004, 0.08)).connect(o);
  if (broke) {
    tone(E, t + 0.01, 68, { f2: 32, glide: 0.35, peak: 0.8, decay: 0.4, dest: sat });
    const c = noiseBand(E, t, 0.2, { f: 1900, f2: 500, q: 1.2 });
    c.connect(envGain(E, t, 0.6, 0.0006, 0.08)).connect(o);
    for (let i = 0; i < 12; i++) {                       // splinters
      const tt = t + 0.01 + E.rng() * 0.18;
      const g = noiseBand(E, tt, 0.02, { f: 1500 + E.rng() * 3500, q: 4 });
      g.connect(envGain(E, tt, 0.08 + 0.12 * E.rng(), 0.0005, 0.008)).connect(o);
    }
    E.punch(t, 6, 0.3);
  }
  E.out(o, { gain, pan, rev: broke ? 0.3 : 0.14 });
}
