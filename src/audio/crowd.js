// Crowd sound for the market town (level 3 · 长街灯火). Owner: audio (U). Driven by the 'crowd' bus event that
// world/citizens.js emits ~4×/s: { calm 0..1, panic 0..1, scream 0..1, pos, call }.
//
//   murmur   the market's many voices: pink noise through two talker-band filters, amplitude-modulated at syllable
//            rate by slow noise (the "babble"), plus three faint formant talkers whose vowels and pitch wander —
//            chatter you can't make out. Level follows the calm crowd near the listener (low in the mix).
//   calls    now and then a vendor's sung call (吆喝): a short falling pentatonic phrase on open vowels, from the
//            nearest calm citizen
//   panic    when the crowd scatters: a gasp (noise swell), a burst of screams and shouts, a hurried high babble
//            that fades as they reach cover
//
//   const crowd = createCrowd(E)
//   crowd.set(t, p, place, callPlace)   — bus payload + placements ({pan, gain} of the crowd centroid / the caller)
//   crowd.tick(t, dt)                   — control rate (talkers' syllables, vendor timing); cheap no-op when silent
// Everything is built on the first event with a crowd in it: the other levels pay nothing.
import { noiseBand, envGain } from './sfx.js';

// formants (Hz): [F1, F2, F3]; the talkers only need the first two to read as speech
const VOW = { a: [800, 1250, 2600], o: [540, 900, 2500], e: [480, 1850, 2600], i: [320, 2250, 3000], u: [380, 800, 2400] };
const VKEYS = Object.keys(VOW);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const waves = new WeakMap();
function glottal(E) {
  let w = waves.get(E.ctx);
  if (!w) {
    const n = 40, re = new Float32Array(n), im = new Float32Array(n);
    for (let h = 1; h < n; h++) { im[h] = Math.pow(h, -1.25) * (h % 2 ? 1 : 0.8); re[h] = 0.12 * Math.pow(h, -1.6); }
    w = E.ctx.createPeriodicWave(re, im);
    waves.set(E.ctx, w);
  }
  return w;
}

export function createCrowd(E) {
  const { ctx } = E;
  let built = false, bed = null;
  const S = { calm: 0, panic: 0, lastScream: -9, lastBurst: -9, nextCall: 0, panicPrev: 0, callPlace: null, pan: 0, gain: 1 };

  function build(t) {
    built = true;
    const out = ctx.createGain(); out.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.4;
    out.connect(lp).connect(pan).connect(E.buses.amb);
    const send = ctx.createGain(); send.gain.value = 0.22; pan.connect(send).connect(E.reverb);
    // babble: two voice bands, each gated by its own syllable-rate noise
    const babble = [];
    for (const [f, q, level, rate] of [[420, 0.9, 1, 0.9], [1150, 1.3, 0.55, 1.13]]) {
      const src = E.noiseSrc(E.noise.pink, t, Infinity, { loop: true, rate });
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const am = ctx.createGain(); am.gain.value = 0.5;
      const mod = E.noiseSrc(E.noise.brown, t, Infinity, { loop: true, rate: 2.6 * rate });
      const modLP = ctx.createBiquadFilter(); modLP.type = 'lowpass'; modLP.frequency.value = 7;
      const modG = ctx.createGain(); modG.gain.value = 0.9;
      mod.connect(modLP).connect(modG).connect(am.gain);
      const g = ctx.createGain(); g.gain.value = level;
      src.connect(bp).connect(am).connect(g).connect(out);
      babble.push({ bp, g, base: f });
    }
    // talkers: glottal source → two formant bands, syllables gated in tick()
    const talkers = [];
    for (let i = 0; i < 3; i++) {
      const f0 = [118, 205, 142][i];
      const osc = ctx.createOscillator(); osc.setPeriodicWave(glottal(E)); osc.frequency.value = f0;
      const vib = ctx.createOscillator(); vib.frequency.value = 4.6 + i * 0.7;
      const vg = ctx.createGain(); vg.gain.value = f0 * 0.02; vib.connect(vg).connect(osc.frequency);
      const syl = ctx.createGain(); syl.gain.value = 0;
      osc.connect(syl);
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 7; f1.frequency.value = 600;
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 11; f2.frequency.value = 1400;
      const g1 = ctx.createGain(); g1.gain.value = 0.9; const g2 = ctx.createGain(); g2.gain.value = 0.45;
      const tp = ctx.createStereoPanner(); tp.pan.value = [-0.5, 0.35, 0.05][i];
      const tg = ctx.createGain(); tg.gain.value = 0.3;
      syl.connect(f1).connect(g1).connect(tp); syl.connect(f2).connect(g2).connect(tp);
      tp.connect(tg).connect(out);
      osc.start(t); vib.start(t);
      talkers.push({ osc, syl, f1, f2, f0, next: t + i * 0.3 });
    }
    // panic babble: a higher, faster band (hurried voices), its own level
    const pSrc = E.noiseSrc(E.noise.pink, t, Infinity, { loop: true, rate: 1.31 });
    const pBP = ctx.createBiquadFilter(); pBP.type = 'bandpass'; pBP.frequency.value = 1500; pBP.Q.value = 1.1;
    const pAM = ctx.createGain(); pAM.gain.value = 0.45;
    const pMod = E.noiseSrc(E.noise.brown, t, Infinity, { loop: true, rate: 5.5 });
    const pModLP = ctx.createBiquadFilter(); pModLP.type = 'lowpass'; pModLP.frequency.value = 11;
    const pModG = ctx.createGain(); pModG.gain.value = 1.1;
    pMod.connect(pModLP).connect(pModG).connect(pAM.gain);
    const pG = ctx.createGain(); pG.gain.value = 0;
    pSrc.connect(pBP).connect(pAM).connect(pG).connect(pan);
    bed = { out, pan, lp, babble, talkers, pG };
  }

  // ---- one sung / shouted utterance: glottal source, pitch contour, formant pair glides ----
  function utter(t, { f0, notes, vowel = 'a', vowels = null, dur, peak = 0.3, pan = 0, gain = 1, bright = 1, rev = 0.25, breath = 0.2 }) {
    const osc = ctx.createOscillator(); osc.setPeriodicWave(glottal(E));
    osc.frequency.setValueAtTime(f0 * notes[0][1], t);
    for (const [dt, r, glide] of notes.slice(1)) {
      if (glide === 'step') osc.frequency.setTargetAtTime(f0 * r, t + dt, 0.025);
      else osc.frequency.exponentialRampToValueAtTime(f0 * r, t + dt);
    }
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2 + E.rng() * 1.2;
    const vg = ctx.createGain(); vg.gain.value = f0 * 0.022; vib.connect(vg).connect(osc.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.035);
    env.gain.setValueAtTime(peak, t + dur * 0.7);
    env.gain.linearRampToValueAtTime(0, t + dur);
    const src = ctx.createGain();
    osc.connect(src);
    const asp = noiseBand(E, t, dur + 0.05, { type: 'highpass', f: 900, q: 0.5, buf: E.noise.pink });
    const ag = ctx.createGain(); ag.gain.value = breath; asp.connect(ag).connect(src);
    const vl = vowels ?? [[0, vowel]];
    const mix = ctx.createGain();
    for (let i = 0; i < 3; i++) {
      const f = ctx.createBiquadFilter(); f.type = 'bandpass';
      const v0 = VOW[vl[0][1]];
      f.frequency.setValueAtTime(v0[i] * bright, t); f.Q.value = [9, 12, 14][i];
      for (const [dt, name] of vl.slice(1)) f.frequency.linearRampToValueAtTime(VOW[name][i] * bright, t + dt);
      const g = ctx.createGain(); g.gain.value = [1.6, 1.1, 0.45][i];
      src.connect(f).connect(g).connect(mix);
    }
    const body = ctx.createBiquadFilter(); body.type = 'lowpass'; body.frequency.value = 700;
    const bg = ctx.createGain(); bg.gain.value = 0.15; src.connect(body).connect(bg).connect(mix);
    mix.connect(env);
    const hs = ctx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 4500; hs.gain.value = -9;
    env.connect(hs);
    E.out(hs, { bus: 'amb', pan, gain, rev });
    osc.start(t); osc.stop(t + dur + 0.05); vib.start(t); vib.stop(t + dur + 0.05);
    E.track(osc, t + dur);
  }

  // 吆喝: a vendor's call — two or three held notes falling through a pentatonic phrase, open vowels
  const PENTA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
  function vendorCall(t, P) {
    const f0 = 150 + E.rng() * 60;
    const n = 2 + Math.floor(E.rng() * 3);
    const notes = [], vowels = [];
    let at = 0;
    let deg = 3 + Math.floor(E.rng() * 3);
    const VS = ['a', 'o', 'a', 'e', 'o'];
    for (let k = 0; k < n; k++) {
      const len = k === n - 1 ? 0.55 + E.rng() * 0.35 : 0.22 + E.rng() * 0.18;
      notes.push([at, PENTA[clamp(deg, 0, 5)], 'step']);
      vowels.push([at, VS[(k + Math.floor(E.rng() * 3)) % VS.length]]);
      at += len;
      deg -= 1 + Math.floor(E.rng() * 2);
    }
    notes.push([at, PENTA[clamp(deg + 1, 0, 5)] * 0.92]);                 // the tail sags off the last note
    utter(t, { f0, notes, vowels, dur: at + 0.08, peak: 0.22, pan: P?.pan ?? 0, gain: 0.55 * (P?.gain ?? 0.5), rev: 0.35, breath: 0.12 });
  }
  // a scream (high, rising then breaking down) or a shout (lower, "ah!" / "wa!")
  function scream(t, P, female) {
    const f0 = female ? 330 + E.rng() * 140 : 190 + E.rng() * 60;
    const dur = female ? 0.55 + E.rng() * 0.5 : 0.3 + E.rng() * 0.25;
    const notes = female ? [[0, 1.0], [0.09, 1.35], [dur * 0.7, 1.2], [dur, 0.85]] : [[0, 1.1], [0.06, 1.3], [dur, 0.9]];
    const vowels = female ? [[0, 'i'], [0.08, 'a'], [dur, 'a']] : [[0, 'u'], [0.05, 'a']];
    utter(t, { f0, notes, vowels, dur, peak: 0.34, pan: clamp((P?.pan ?? 0) + (E.rng() - 0.5) * 0.7, -0.9, 0.9), gain: (female ? 0.42 : 0.5) * (P?.gain ?? 0.5), bright: female ? 1.12 : 1, rev: 0.3, breath: 0.3 });
  }
  function gasp(t, P, k) {
    // the whole crowd drawing breath and crying out at once: a rising noise swell in the voice band
    const o = ctx.createGain();
    const nb = noiseBand(E, t, 2.2, { f: 900, f2: 1300, q: 0.8, buf: E.noise.pink });
    nb.connect(envGain(E, t, 0.22 * k, 0.12, 1.6)).connect(o);
    const hi = noiseBand(E, t + 0.05, 1.6, { f: 2300, f2: 1800, q: 1.4, buf: E.noise.pink });
    hi.connect(envGain(E, t + 0.05, 0.1 * k, 0.08, 1.1)).connect(o);
    E.out(o, { bus: 'amb', pan: P?.pan ?? 0, gain: 0.6 * (P?.gain ?? 0.5), rev: 0.3 });
  }

  function set(t, p, P, callP) {
    const calm = clamp(+p.calm || 0, 0, 1), panic = clamp(+p.panic || 0, 0, 1);
    if (!built) { if (calm + panic < 0.02) return; build(t); }
    S.calm = calm; S.panic = panic; S.callPlace = callP; S.pan = P?.pan ?? 0; S.gain = P?.gain ?? 1;
    const k = clamp(0.35 + 0.65 * (P?.gain ?? 1), 0, 1);           // the crowd surrounds you: distance matters less
    // calm murmur, low in the mix; it thins while they run (they aren't chatting) and comes back as they settle
    bed.out.gain.setTargetAtTime(0.62 * calm * k, t, 0.6);
    bed.pan.pan.setTargetAtTime(clamp(S.pan * 0.5, -0.6, 0.6), t, 0.5);
    bed.pG.gain.setTargetAtTime(0.3 * panic * k, t, panic > S.panicPrev ? 0.08 : 1.2);
    // the scatter: a gasp and a burst of screams on the rising edge, single cries while more of them break and run
    if (p.scream > 0 && t - S.lastScream > 0.3) {
      S.lastScream = t;
      if (t - S.lastBurst > 3 && panic > 0.15) {
        S.lastBurst = t;
        gasp(t, P, 0.6 + 0.4 * panic);
        const n = 3 + Math.floor(E.rng() * 3);
        for (let i = 0; i < n; i++) scream(t + 0.05 + i * (0.12 + E.rng() * 0.25), P, E.rng() < 0.55);
      } else if (E.rng() < 0.6) scream(t + E.rng() * 0.1, P, E.rng() < 0.5);
    }
    S.panicPrev = panic;
  }

  function tick(t, dt) {
    if (!built) return;
    // talkers: new syllables at speaking rate, vowel formants and pitch hop per syllable
    const live = S.calm > 0.02;
    for (const tk of bed.talkers) {
      if (t < tk.next) continue;
      if (!live) { tk.syl.gain.setTargetAtTime(0, t, 0.05); tk.next = t + 0.5; continue; }
      const pause = E.rng() < 0.18;
      const len = pause ? 0.25 + E.rng() * 0.5 : 0.11 + E.rng() * 0.13;
      if (!pause) {
        const v = VOW[VKEYS[Math.floor(E.rng() * VKEYS.length)]], female = tk.f0 > 180 ? 1.12 : 1;
        tk.f1.frequency.setTargetAtTime(v[0] * female, t, 0.02);
        tk.f2.frequency.setTargetAtTime(v[1] * female, t, 0.02);
        tk.osc.frequency.setTargetAtTime(tk.f0 * (0.9 + E.rng() * 0.25), t, 0.04);
        tk.syl.gain.setTargetAtTime(0.5 + E.rng() * 0.5, t, 0.015);
        tk.syl.gain.setTargetAtTime(0, t + len * 0.7, 0.03);
      }
      tk.next = t + len;
    }
    // a vendor's call every so often while the market is calm
    if (S.nextCall === 0) S.nextCall = t + 3 + E.rng() * 5;
    if (t > S.nextCall) {
      S.nextCall = t + 7 + E.rng() * 10;
      if (S.calm > 0.3 && S.panic < 0.05 && S.callPlace) vendorCall(t + 0.02, S.callPlace);
    }
  }

  return { set, tick, vendorCall, scream, get built() { return built; }, S };
}
