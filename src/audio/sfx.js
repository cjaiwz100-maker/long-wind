// One-shot sound effects, all synthesised (bible §7.5 audio). Every function takes the engine E, a start time t and a
// placement { pan, gain, far } computed by audio.js from the camera, so they also render offline. Owner: audio (U).
//
//   whoosh   — noise band sweeping 800→3000 Hz over ~180 ms, gain and length from blade speed; heavy = lower, longer
//   clash    — blade modes ×(1, 2.756, 5.404, 8.933, 13.34) of ~1.8 kHz as detuned pairs (shimmer), transient click,
//              impact thud; long reverb + valley echo
//   parry    — perfect: a brighter, longer ring with a low bell underneath and a rising shimmer
//   hit      — 80 Hz thump + cloth noise + blade slice; kill adds a sub drop and a reverb swell
//   step     — grass crunch (heel + toe) and leg swish; road = gravel grains + more thud
//   dodge, hurt, telegraph (glint), danger (unblockable), special (sword qi), lockon, ui (brush/seal/tick/…)
//   evade (just-frame dodge: time slips), charge (heavy fully charged), posture (guard broken open), land (heavy landing)
const rnd = (E, a, b) => a + (b - a) * E.rng();

function noiseBand(E, t, dur, { type = 'bandpass', f = 1000, f2 = null, q = 1, buf = null, curve = 'exp' } = {}) {
  const src = E.noiseSrc(buf ?? E.noise.white, t, dur);
  const flt = E.ctx.createBiquadFilter(); flt.type = type; flt.Q.value = q;
  flt.frequency.setValueAtTime(f, t);
  if (f2) curve === 'exp' ? flt.frequency.exponentialRampToValueAtTime(f2, t + dur) : flt.frequency.linearRampToValueAtTime(f2, t + dur);
  src.connect(flt);
  return flt;
}
function envGain(E, t, peak, attack, decay, hold = 0) {
  const g = E.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  if (hold) g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.setTargetAtTime(0, t + attack + hold, decay / 3);
  return g;
}
function tone(E, t, f, { type = 'sine', f2 = null, glide = 0.1, peak = 0.5, attack = 0.002, decay = 0.2, dest }) {
  const o = E.ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + glide);
  const g = envGain(E, t, peak, attack, decay);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + attack + decay * 2.2 + 0.05);
  E.track(o, t + decay * 2);
  return o;
}
export { noiseBand, envGain, tone, ring, rnd };
export const place = (p = {}) => ({ pan: p.pan ?? 0, gain: p.gain ?? 1, far: p.far ?? 0 });

/**
 * Blade swing. kind: light (a fast thin swish with a whip-crack at the fastest point), heavy (a deep roar with a sub
 * "vwoom" under it), thrust (short, tight), spin (long, rolling). weight > 1 lowers everything (spears, great blades).
 * The band rises then falls (doppler) and pans across the listener.
 */
export function whoosh(E, t, { speed = 10, heavy = false, kind = heavy ? 'heavy' : 'light', weight = 1 } = {}, p) {
  const { pan, gain } = place(p);
  const k = Math.min(1, Math.max(0.15, (speed - 2.5) / 12));
  const fw = 1 / Math.sqrt(Math.max(0.6, weight));
  const big = kind === 'heavy' || kind === 'spin';
  const dur = kind === 'heavy' ? 0.42 : kind === 'spin' ? 0.5 : kind === 'thrust' ? 0.15 : 0.2 - 0.05 * k;
  const pk = kind === 'thrust' ? 0.35 : 0.55;           // where in the swing the blade is fastest
  const o = E.ctx.createGain();
  const swell = (node, peak, at = pk, floor = 0.0008) => {
    const g = E.ctx.createGain();
    g.gain.setValueAtTime(floor, t);
    g.gain.exponentialRampToValueAtTime(Math.max(floor * 2, peak), t + dur * at);
    g.gain.exponentialRampToValueAtTime(floor, t + dur);
    node.connect(g).connect(o);
    return g;
  };
  // air body: a pink band that rises to the fastest point and falls away
  const f0 = (big ? 380 : 700) * fw, f1 = (big ? 1900 : 2600 + 900 * k) * fw;
  const a = E.noiseSrc(E.noise.pink, t, dur + 0.05);
  const fa = E.ctx.createBiquadFilter(); fa.type = 'bandpass'; fa.Q.value = 1.2;
  fa.frequency.setValueAtTime(f0, t); fa.frequency.exponentialRampToValueAtTime(f1, t + dur * pk);
  fa.frequency.exponentialRampToValueAtTime(f0 * 1.3, t + dur);
  a.connect(fa); swell(fa, (big ? 0.75 : 0.62) * Math.pow(k, 0.7));
  // the edge: a narrow, bright band just ahead of the body
  const b = noiseBand(E, t, dur + 0.05, { f: 3200 * fw, f2: 7200 * fw, q: 3.2 });
  swell(b, (big ? 0.12 : 0.2) * k, pk * 0.9);
  // light cuts: a snap at the fastest point
  if (kind === 'light' || kind === 'thrust') {
    const tc = t + dur * pk;
    const c = noiseBand(E, tc - 0.006, 0.03, { f: 1900 * fw, q: 1.6 });
    c.connect(envGain(E, tc - 0.006, 0.28 * k, 0.004, 0.018)).connect(o);
  }
  if (big) {
    // sub vwoom: a low sine that swells and sags with the swing, a little saturated, plus a brown-noise roar
    const sub = E.ctx.createOscillator(); sub.type = 'sine';
    sub.frequency.setValueAtTime(52 * fw, t); sub.frequency.exponentialRampToValueAtTime(92 * fw, t + dur * pk); sub.frequency.exponentialRampToValueAtTime(46 * fw, t + dur);
    const sg = E.ctx.createGain(); sg.gain.setValueAtTime(0, t); sg.gain.linearRampToValueAtTime(0.42, t + dur * pk); sg.gain.linearRampToValueAtTime(0, t + dur + 0.04);
    sub.connect(sg).connect(E.shaper(1.8)).connect(o); sub.start(t); sub.stop(t + dur + 0.08); E.track(sub, t + dur);
    const r = noiseBand(E, t, dur + 0.05, { type: 'lowpass', f: 260 * fw, f2: 900 * fw, q: 0.8, buf: E.noise.brown });
    swell(r, 0.8, pk);
  }
  // the jian's thin edge: a faint singing tone
  tone(E, t + dur * 0.35, (5200 + 900 * k) * fw, { peak: 0.012 * k, attack: 0.03, decay: 0.12, dest: o });
  const pn = E.ctx.createStereoPanner();
  pn.pan.setValueAtTime(Math.max(-1, pan - 0.45), t); pn.pan.linearRampToValueAtTime(Math.min(1, pan + 0.45), t + dur);
  o.connect(pn);
  E.out(pn, { gain: gain * 0.9, rev: big ? 0.18 : 0.1 });
}

const MODES = [[1, 1, 1.25], [2.756, 0.62, 0.85], [5.404, 0.36, 0.55], [8.933, 0.2, 0.36], [13.34, 0.1, 0.22]];

function ring(E, t, f0, { amp = 1, decayK = 1, dest, detune = 1.2, modes = MODES }) {
  for (const [r, a, d] of modes) {
    const f = f0 * r;
    if (f > 17000) continue;
    for (const side of [-1, 1]) {
      const o = E.ctx.createOscillator();
      o.frequency.value = f + side * detune * (0.5 + E.rng()) * (1 + r * 0.3);
      const g = E.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * a * 0.5, t + 0.0015);
      g.gain.setTargetAtTime(0, t + 0.002, (d * decayK) / 3.2);
      o.connect(g).connect(dest);
      o.start(t); o.stop(t + d * decayK * 2.4 + 0.1);
    }
  }
}

export function clash(E, t, { strength = 0.6 } = {}, p) {
  const { pan, gain } = place(p);
  const s = Math.min(1.2, Math.max(0.2, strength));
  const o = E.ctx.createGain();
  const f0 = rnd(E, 1650, 1950);
  ring(E, t, f0, { amp: 0.16 * (0.5 + s), decayK: 0.7 + 0.6 * s, dest: o });
  // transient: bright click + clang band
  const c = noiseBand(E, t, 0.03, { type: 'highpass', f: 3200, q: 0.7 });
  c.connect(envGain(E, t, 0.5 * s, 0.0005, 0.008)).connect(o);
  const cl = noiseBand(E, t, 0.12, { f: 2400, f2: 1400, q: 1.5 });
  cl.connect(envGain(E, t, 0.28 * s, 0.001, 0.05)).connect(o);
  tone(E, t, 160, { f2: 90, glide: 0.06, peak: 0.25 * s, decay: 0.07, dest: o });
  // steel on steel: a short grinding scrape as the edges slide, and a saturated knock under the ring
  const sc = noiseBand(E, t + 0.004, 0.14, { f: 3600, f2: 2400, q: 7 });
  const am = E.ctx.createGain(); am.gain.value = 0.3;
  const lf = E.ctx.createOscillator(); lf.type = 'sawtooth'; lf.frequency.value = 90 + 60 * E.rng(); const lg = E.ctx.createGain(); lg.gain.value = 0.6;
  lf.connect(lg).connect(am.gain); lf.start(t); lf.stop(t + 0.2);
  sc.connect(am).connect(envGain(E, t + 0.004, 0.22 * s, 0.003, 0.07)).connect(o);
  const kn = E.ctx.createGain(); kn.connect(E.shaper(2.4)).connect(o);
  tone(E, t, 240, { f2: 110, glide: 0.03, peak: 0.35 * s, decay: 0.04, dest: kn });
  E.punch(t, 3 + 3 * Math.min(1, s), 0.22);
  E.out(o, { gain, pan, rev: 0.4, echo: 0.22 });
}

export function parry(E, t, { perfect = true } = {}, p) {
  const { pan, gain } = place(p);
  if (!perfect) return block(E, t, {}, p);
  const o = E.ctx.createGain();
  const f0 = rnd(E, 1850, 2050);
  ring(E, t, f0, { amp: 0.2, decayK: 2.2, dest: o, detune: 0.7 });
  ring(E, t, f0 * 0.5, { amp: 0.07, decayK: 2.6, dest: o, detune: 0.4, modes: [[1, 1, 1.6], [2.32, 0.5, 1.0], [4.25, 0.25, 0.6]] });
  // rising shimmer
  const sh = E.ctx.createOscillator(); sh.frequency.setValueAtTime(f0 * 2.02, t); sh.frequency.exponentialRampToValueAtTime(f0 * 2.14, t + 0.9);
  const shg = envGain(E, t, 0.035, 0.02, 0.9); sh.connect(shg).connect(o); sh.start(t); sh.stop(t + 3);
  const c = noiseBand(E, t, 0.03, { type: 'highpass', f: 4000 });
  c.connect(envGain(E, t, 0.55, 0.0005, 0.01)).connect(o);
  tone(E, t, 110, { f2: 60, glide: 0.3, peak: 0.35, decay: 0.35, dest: o });
  E.out(o, { gain, pan, rev: 0.6, echo: 0.3 });
}

export function block(E, t, { ring: withRing = true, broke = false } = {}, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  const f0 = rnd(E, 1200, 1400);
  if (withRing) ring(E, t, f0, { amp: 0.08, decayK: 0.35, dest: o, detune: 3 });
  if (broke) {
    // guard broken: the arm gives, a dull wooden crack and a low drop
    tone(E, t + 0.02, 70, { f2: 34, glide: 0.35, peak: 0.6, decay: 0.4, dest: o });
    const cr = noiseBand(E, t + 0.01, 0.12, { f: 900, f2: 300, q: 2 });
    cr.connect(envGain(E, t + 0.01, 0.4, 0.001, 0.06)).connect(o);
  }
  const n = noiseBand(E, t, 0.08, { f: 1800, f2: 900, q: 1.2 });
  n.connect(envGain(E, t, 0.35, 0.001, 0.035)).connect(o);
  tone(E, t, 130, { f2: 70, glide: 0.05, peak: 0.35, decay: 0.08, dest: o });
  E.out(o, { gain, pan, rev: 0.22 });
}

/**
 * A blade landing in a body, built in layers: a transient crack, the edge biting (a falling bright band), the wet flesh
 * band, a saturated low thump, then blood spatter grains. heavy adds a sub drop and bone crunch; kill adds a taiko
 * boom and a ringing blade; execute a long piercing drive. combo (hits in a row) lifts the pitch a little each time.
 */
export function hit(E, t, { damage = 20, kill = false, heavy = false, combo = 0, execute = false } = {}, p) {
  const { pan, gain } = place(p);
  const k = Math.min(1.4, 0.55 + damage / 55);
  const cp = 1 + Math.min(combo, 12) * 0.022;
  const o = E.ctx.createGain();
  const sat = E.ctx.createGain(); sat.connect(E.shaper(heavy || kill ? 2.8 : 2.2)).connect(o);
  // 1 transient crack
  const cr = noiseBand(E, t, 0.012, { type: 'highpass', f: 2600, q: 0.7 });
  cr.connect(envGain(E, t, 0.75 * k, 0.0004, 0.006)).connect(o);
  // 2 the edge biting in
  const bite = noiseBand(E, t + 0.002, 0.12, { f: 5400 * cp, f2: 2000 * cp, q: 2.2 });
  bite.connect(envGain(E, t + 0.002, 0.34 * k, 0.001, 0.06)).connect(o);
  // 3 flesh: a wet mid band falling fast, driven into the saturator
  const fl = noiseBand(E, t + 0.004, 0.16, { f: 1500 * cp, f2: 330 * cp, q: 1.5, buf: E.noise.pink });
  fl.connect(envGain(E, t + 0.004, 0.75 * k, 0.002, 0.075)).connect(sat);
  // 4 thump + body
  tone(E, t, 150 * cp, { f2: 50, glide: 0.075, peak: 0.95 * k, decay: 0.12, dest: sat });
  const body = noiseBand(E, t, 0.12, { type: 'lowpass', f: 480, buf: E.noise.brown, q: 0.7 });
  body.connect(envGain(E, t, 0.85 * k, 0.002, 0.06)).connect(o);
  // 5 blood spatter
  const grains = heavy || kill ? 9 : 5;
  for (let i = 0; i < grains; i++) {
    const tt = t + 0.025 + E.rng() * (heavy || kill ? 0.22 : 0.14);
    const g = noiseBand(E, tt, 0.03, { f: 1400 + E.rng() * 2600, q: 2.5 });
    g.connect(envGain(E, tt, (0.05 + 0.1 * E.rng()) * k, 0.001, 0.008 + 0.012 * E.rng())).connect(o);
  }
  if (heavy || kill) {
    tone(E, t + 0.006, 78, { f2: 30, glide: 0.4, peak: 0.75, decay: 0.42, dest: sat });
    for (let i = 0; i < 6; i++) {                        // bone crunch
      const tt = t + 0.004 + E.rng() * 0.035;
      const g = noiseBand(E, tt, 0.02, { f: 700 + E.rng() * 1300, q: 5 });
      g.connect(envGain(E, tt, 0.22, 0.0006, 0.006)).connect(o);
    }
  }
  if (kill) {
    taiko(E, t + 0.01, { big: execute ? 1.3 : 1 }, { pan, gain: gain * 0.9 });
    ring(E, t + 0.02, rnd(E, 3000, 3300), { amp: 0.035, decayK: 1.4, dest: o, detune: 2, modes: [[1, 1, 0.7], [2.756, 0.4, 0.4]] });
    const sw = noiseBand(E, t + 0.03, 1.0, { type: 'lowpass', f: 1400, f2: 260, buf: E.noise.pink });
    sw.connect(envGain(E, t + 0.03, 0.2, 0.09, 0.55)).connect(o);
  }
  if (execute) {
    // the blade driven home: a long, falling, gritty band
    const dr = noiseBand(E, t, 0.4, { f: 1100, f2: 260, q: 2.2, buf: E.noise.pink });
    dr.connect(envGain(E, t, 0.5, 0.02, 0.25)).connect(sat);
  }
  E.punch(t, heavy || kill ? 8 : 4.5, heavy || kill ? 0.4 : 0.2);
  E.out(o, { gain: gain * 0.9, pan, rev: kill ? 0.3 : 0.12, echo: kill ? 0.14 : 0 });
}

/** A war drum under a kill: membrane fundamental + second mode, the skin slap, a saturated body. */
export function taiko(E, t, { big = 1 } = {}, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  const sat = E.ctx.createGain(); sat.connect(E.shaper(1.6)).connect(o);
  tone(E, t, 112, { f2: 56, glide: 0.14, peak: 0.95 * big, attack: 0.003, decay: 0.5 * big, dest: sat });
  tone(E, t, 178, { f2: 120, glide: 0.1, peak: 0.3 * big, attack: 0.002, decay: 0.16, dest: sat });
  const sl = noiseBand(E, t, 0.1, { f: 240, q: 0.9, buf: E.noise.pink });
  sl.connect(envGain(E, t, 0.7 * big, 0.001, 0.05)).connect(o);
  const hd = noiseBand(E, t, 0.04, { f: 1800, q: 1.2 });
  hd.connect(envGain(E, t, 0.18, 0.0008, 0.012)).connect(o);
  E.out(o, { gain, pan, rev: 0.35, echo: 0.18 });
}

export function hurt(E, t, { damage = 20 } = {}, p) {
  const { pan, gain } = place(p);
  const k = Math.min(1.4, 0.6 + damage / 50);
  const o = E.ctx.createGain();
  tone(E, t, 95, { f2: 42, glide: 0.12, peak: 0.8 * k, decay: 0.18, dest: o });
  const body = noiseBand(E, t, 0.16, { type: 'lowpass', f: 500, buf: E.noise.brown });
  body.connect(envGain(E, t, 0.9 * k, 0.002, 0.1)).connect(o);
  // breath out: a short formant-filtered exhale
  const br = noiseBand(E, t + 0.03, 0.3, { f: 720, f2: 520, q: 3, buf: E.noise.pink });
  br.connect(envGain(E, t + 0.03, 0.12, 0.03, 0.18)).connect(o);
  E.out(o, { gain, pan, rev: 0.15 });
}

export function step(E, t, { speed = 3, road = false } = {}, p) {
  const { pan, gain } = place(p);
  const k = Math.min(1, 0.3 + speed / 7);
  const o = E.ctx.createGain();
  // heel then toe
  for (const [dt, a] of [[0, 1], [0.028 + 0.01 * E.rng(), 0.6]]) {
    const cr = noiseBand(E, t + dt, 0.07, { f: road ? 3600 : 2600 + 600 * E.rng(), q: road ? 1.4 : 0.8 });
    cr.connect(envGain(E, t + dt, (road ? 0.22 : 0.16) * a * k, 0.002, road ? 0.03 : 0.045)).connect(o);
  }
  tone(E, t, 75, { f2: 52, glide: 0.05, peak: (road ? 0.35 : 0.2) * k, decay: 0.06, dest: o });
  if (road) {
    for (let i = 0; i < 7; i++) {           // gravel grains
      const tt = t + E.rng() * 0.05;
      const g = noiseBand(E, tt, 0.012, { f: 3000 + E.rng() * 3000, q: 4 });
      g.connect(envGain(E, tt, 0.12 * k, 0.0005, 0.006)).connect(o);
    }
  } else {
    const sw = noiseBand(E, t - 0.04, 0.22, { type: 'highpass', f: 3800, buf: E.noise.pink });
    sw.connect(envGain(E, t - 0.04, 0.09 * k * k, 0.06, 0.1)).connect(o);
  }
  E.out(o, { gain: gain * 0.8, pan, rev: 0.05, bus: 'sfx' });
}

export function dodge(E, t, _o, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  const w = noiseBand(E, t, 0.34, { f: 350, f2: 1400, q: 0.9, buf: E.noise.pink });
  const gw = E.ctx.createGain(); gw.gain.setValueAtTime(0, t); gw.gain.linearRampToValueAtTime(0.5, t + 0.12); gw.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
  w.connect(gw).connect(o);
  // cloth flap: noise amplitude-modulated at ~22 Hz
  const flap = noiseBand(E, t, 0.3, { f: 600, q: 1.1 });
  const am = E.ctx.createGain(); am.gain.value = 0;
  const lfo = E.ctx.createOscillator(); lfo.frequency.value = 22; const lg = E.ctx.createGain(); lg.gain.value = 0.12;
  lfo.connect(lg).connect(am.gain); lfo.start(t); lfo.stop(t + 0.35);
  flap.connect(am).connect(envGain(E, t, 1, 0.04, 0.15)).connect(o);
  const gr = noiseBand(E, t + 0.02, 0.35, { type: 'highpass', f: 3000, buf: E.noise.pink });
  gr.connect(envGain(E, t + 0.02, 0.12, 0.08, 0.16)).connect(o);
  E.out(o, { gain, pan, rev: 0.08 });
  step(E, t + 0.3, { speed: 5 }, p);
}

export function telegraph(E, t, _o, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  tone(E, t, 4186, { peak: 0.06, attack: 0.004, decay: 0.3, dest: o });
  tone(E, t + 0.01, 6272, { peak: 0.035, attack: 0.004, decay: 0.22, dest: o });
  E.out(o, { gain, pan, rev: 0.5, echo: 0.2 });
}

export function danger(E, t, _o, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  tone(E, t, 92, { f2: 50, glide: 0.25, peak: 0.8, decay: 0.5, dest: o });
  const n = noiseBand(E, t, 0.06, { type: 'lowpass', f: 1500 });
  n.connect(envGain(E, t, 0.4, 0.001, 0.02)).connect(o);
  // dissonant bell: tritone
  for (const f of [740, 1046.5]) tone(E, t + 0.02, f, { peak: 0.06, attack: 0.003, decay: 0.9, dest: o });
  E.out(o, { gain, pan, rev: 0.55, echo: 0.25 });
}

export function special(E, t, { dark = false } = {}, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  // charge: rising band (dark: the enemy's qi, a lower growl)
  const ch = noiseBand(E, t, 0.38, { f: dark ? 120 : 220, f2: dark ? 1800 : 4200, q: 2.2, buf: E.noise.pink });
  const gc = E.ctx.createGain(); gc.gain.setValueAtTime(0, t); gc.gain.linearRampToValueAtTime(0.5, t + 0.34); gc.gain.linearRampToValueAtTime(0, t + 0.4);
  ch.connect(gc).connect(o);
  // release: big whoosh, boom, long shimmer
  const t2 = t + 0.36;
  const w = noiseBand(E, t2, 0.7, { f: 2600, f2: 400, q: 0.8 });
  w.connect(envGain(E, t2, 0.7, 0.01, 0.4)).connect(o);
  const sat = E.ctx.createGain(); sat.connect(E.shaper(2.2)).connect(o);
  tone(E, t2, dark ? 52 : 64, { f2: 26, glide: 0.8, peak: 0.95, decay: 0.8, dest: sat });
  ring(E, t2, dark ? 620 : 940, { amp: 0.09, decayK: 2.8, dest: o, detune: dark ? 2.5 : 0.6 });
  E.punch(t2, 9, 0.6);
  E.out(o, { gain, pan, rev: 0.6, echo: 0.35 });
}

export function lockon(E, t, _o, p) {
  const o = E.ctx.createGain();
  const n = noiseBand(E, t, 0.04, { f: 1250, q: 6 });
  n.connect(envGain(E, t, 0.22, 0.001, 0.02)).connect(o);
  tone(E, t, 2350, { peak: 0.025, attack: 0.002, decay: 0.05, dest: o });
  E.out(o, { bus: 'ui', gain: (p?.gain ?? 1) * 0.8, rev: 0.1 });
}

/** UI sounds: brush (on paper), seal (stamp), tick, hover, open/close (pause), focus (meter full). */
export function ui(E, t, { kind = 'tick' } = {}) {
  const o = E.ctx.createGain();
  if (kind === 'brush') {
    // bristles dragging on xuan paper: grainy band noise with a swelling-then-lifting envelope
    const n = noiseBand(E, t, 0.7, { f: 2200, f2: 3600, q: 0.7, buf: E.noise.pink });
    const g = E.ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.12); g.gain.linearRampToValueAtTime(0.1, t + 0.45); g.gain.linearRampToValueAtTime(0, t + 0.7);
    const grain = E.ctx.createGain(); grain.gain.value = 0.6;
    const lfo = E.ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 37; const lg = E.ctx.createGain(); lg.gain.value = 0.4;
    lfo.connect(lg).connect(grain.gain); lfo.start(t); lfo.stop(t + 0.75);
    n.connect(grain).connect(g).connect(o);
  } else if (kind === 'seal') {
    tone(E, t, 110, { f2: 70, glide: 0.05, peak: 0.45, decay: 0.08, dest: o });
    const n = noiseBand(E, t, 0.1, { f: 900, q: 3 });
    n.connect(envGain(E, t, 0.3, 0.001, 0.03)).connect(o);
    const cr = noiseBand(E, t + 0.02, 0.2, { type: 'highpass', f: 2500 });
    cr.connect(envGain(E, t + 0.02, 0.06, 0.005, 0.08)).connect(o);
  } else if (kind === 'open' || kind === 'close') {
    const up = kind === 'open';
    const n = noiseBand(E, t, 0.45, { f: up ? 500 : 1800, f2: up ? 1800 : 500, q: 1, buf: E.noise.pink });
    n.connect(envGain(E, t, 0.12, 0.15, 0.2)).connect(o);
    tone(E, t + 0.05, up ? 698.5 : 523.3, { peak: 0.05, attack: 0.004, decay: 1.2, dest: o });
  } else if (kind === 'focus') {
    for (const [dt, f] of [[0, 1396.9], [0.09, 2093], [0.18, 2793.8]]) tone(E, t + dt, f, { peak: 0.05, attack: 0.003, decay: 1.4, dest: o });
    const n = noiseBand(E, t, 0.5, { f: 600, f2: 3000, q: 1.2, buf: E.noise.pink });
    n.connect(envGain(E, t, 0.08, 0.3, 0.2)).connect(o);
  } else { // tick / hover
    tone(E, t, kind === 'hover' ? 2600 : 1900, { peak: kind === 'hover' ? 0.018 : 0.04, attack: 0.001, decay: 0.03, dest: o });
    const n = noiseBand(E, t, 0.02, { f: 1500, q: 5 });
    n.connect(envGain(E, t, kind === 'hover' ? 0.03 : 0.08, 0.0005, 0.01)).connect(o);
  }
  E.out(o, { bus: 'ui', gain: 1, rev: kind === 'hover' || kind === 'tick' ? 0.05 : 0.3 });
}

/** Just-frame dodge: the air folds, a reversed breath rising into a thin glassy tone. */
export function evade(E, t, _o, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  const n = noiseBand(E, t, 0.45, { f: 500, f2: 5200, q: 1.6, buf: E.noise.pink });
  const g = E.ctx.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.3); g.gain.linearRampToValueAtTime(0, t + 0.45);
  n.connect(g).connect(o);
  tone(E, t + 0.22, 2637, { f2: 2793.8, glide: 0.6, peak: 0.035, attack: 0.08, decay: 0.8, dest: o });
  E.out(o, { gain, pan, rev: 0.55, echo: 0.2 });
}

/** Heavy attack fully charged: a short rising ring, like a blade drawn along a whetstone and held. */
export function charge(E, t, _o, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  const n = noiseBand(E, t, 0.25, { f: 2500, f2: 6500, q: 3 });
  n.connect(envGain(E, t, 0.1, 0.12, 0.08)).connect(o);
  tone(E, t + 0.1, 1760, { peak: 0.045, attack: 0.01, decay: 0.6, dest: o });
  tone(E, t + 0.1, 2637, { peak: 0.02, attack: 0.01, decay: 0.45, dest: o });
  E.out(o, { gain, pan, rev: 0.3 });
}

/** Enemy posture broken: the guard opens with a heavy crack and a ringing drop, the moment to strike. */
export function posture(E, t, _o, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  tone(E, t, 180, { f2: 55, glide: 0.4, peak: 0.6, decay: 0.45, dest: o });
  const cr = noiseBand(E, t, 0.18, { f: 1400, f2: 500, q: 1.2 });
  cr.connect(envGain(E, t, 0.45, 0.001, 0.08)).connect(o);
  ring(E, t + 0.01, rnd(E, 880, 960), { amp: 0.09, decayK: 1.4, dest: o, detune: 2.5, modes: [[1, 1, 1.2], [2.32, 0.5, 0.8], [4.25, 0.25, 0.5]] });
  E.out(o, { gain, pan, rev: 0.45, echo: 0.2 });
}

/** A heavy landing (plunge / leap): body thump and the grass flattening around it. */
export function land(E, t, _o, p) {
  const { pan, gain } = place(p);
  const o = E.ctx.createGain();
  tone(E, t, 90, { f2: 38, glide: 0.18, peak: 0.8, decay: 0.25, dest: o });
  const body = noiseBand(E, t, 0.2, { type: 'lowpass', f: 600, buf: E.noise.brown });
  body.connect(envGain(E, t, 0.9, 0.002, 0.12)).connect(o);
  const gr = noiseBand(E, t + 0.01, 0.5, { type: 'highpass', f: 2500, buf: E.noise.pink });
  gr.connect(envGain(E, t + 0.01, 0.16, 0.01, 0.3)).connect(o);
  E.out(o, { gain, pan, rev: 0.2 });
}
