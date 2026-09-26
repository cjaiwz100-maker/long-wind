// Weather audio: rain bed + thunder. Fully synthesised, works on live and offline contexts. Owner: audio (U).
//
//   rain bed (one long-running chain per layer, levels automated from setRain; built lazily on the first rain/thunder):
//     wash      pink noise → HP 250 Hz → LP 4.5 kHz                     the broadband roar of rain on a whole grove
//     hiss      white noise → HP 6 kHz → high shelf −6 dB                 the fine spray at the top of the spectrum
//     patter    generated stereo buffer (5.3 s): ~1400 droplet ticks / s  damped sines 1.6–7 kHz, 0.6–3 ms, random level
//     leaves    generated stereo buffer (7.1 s): ~70 close drops / s      bandpassed noise bursts 900 Hz–3.4 kHz on leaves,
//                                                                        plus fat drips (pitch-falling plinks), panned wide
//     low       brown noise → LP 180 Hz                                   heavy-rain weight felt more than heard
//   thunder(t, { strength, pan }): close strikes (strength > 0.5) open with a tearing crack (white noise, jagged gain
//     steps over ~0.3 s, falling lowpass) and a boom; every strike rolls: brown + pink noise through a lowpass that sweeps
//     down while 3–6 swells roll across 4–9 s, heavy reverb + echo. Far strikes are a slower, darker, quieter roll.
//
//   const W = createWeather(E);  W.setRain(k 0..1, t);  W.thunder(t, { strength = 0.7, pan = 0 });  W.rain
import { mulberry32 } from '../core/noise.js';

const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

// ---- generated droplet buffers ----
function patterBuffer(ctx, seconds, rate, seed) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c), rng = mulberry32(seed + c * 911);
    const count = Math.floor(rate * seconds);
    for (let k = 0; k < count; k++) {
      const at = Math.floor(rng() * n);
      const f = 1600 * Math.pow(7000 / 1600, rng());
      const dec = (0.0006 + rng() * 0.0024) * sr;
      const amp = Math.pow(rng(), 2.2) * 0.22 + 0.01;
      const len = Math.min(Math.floor(dec * 5), 900);
      const w = (2 * Math.PI * f) / sr, ph = rng() * 6.283;
      for (let i = 0; i < len; i++) {
        const j = (at + i) % n;                       // wrap: seamless loop
        d[j] += amp * Math.exp(-i / dec) * Math.sin(ph + w * i);
      }
    }
  }
  return buf;
}
function leavesBuffer(ctx, seconds, rate, seed) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1), rng = mulberry32(seed);
  const count = Math.floor(rate * seconds);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(rng() * n);
    const pan = rng() * 2 - 1, gl = Math.sqrt(0.5 * (1 - pan)), gr = Math.sqrt(0.5 * (1 + pan));
    if (rng() < 0.12) {
      // a fat drip off a leaf: short sine plink falling in pitch (bubble-like), soft attack
      const f0 = 900 + rng() * 1600, len = Math.floor((0.02 + rng() * 0.03) * sr), amp = 0.12 + rng() * 0.2;
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const u = i / len, f = f0 * (1 - 0.35 * u);
        ph += (2 * Math.PI * f) / sr;
        const e = Math.min(1, i / (0.0015 * sr)) * Math.pow(1 - u, 2.5);
        const x = amp * e * Math.sin(ph), j = (at + i) % n;
        L[j] += x * gl; R[j] += x * gr;
      }
    } else {
      // a drop smacking a leaf: resonant noise burst (two-pole bandpass on white noise)
      const fc = 900 * Math.pow(3400 / 900, rng()), q = 4 + rng() * 6, len = Math.floor((0.004 + rng() * 0.012) * sr);
      const amp = Math.pow(rng(), 1.6) * 0.5 + 0.04;
      const w = (2 * Math.PI * fc) / sr, r = Math.exp(-w / (2 * q)), a1 = 2 * r * Math.cos(w), a2 = -r * r;
      let y1 = 0, y2 = 0;
      for (let i = 0; i < len + 200; i++) {
        const e = i < len ? Math.pow(1 - i / len, 2) : 0;
        const y = (rng() * 2 - 1) * e * (1 - r) + a1 * y1 + a2 * y2;
        y2 = y1; y1 = y;
        const x = amp * y * 3, j = (at + i) % n;
        L[j] += x * gl; R[j] += x * gr;
      }
    }
  }
  return buf;
}

export function createWeather(E) {
  const { ctx } = E;
  let built = null, rain = 0;

  function build() {
    const t = ctx.currentTime;
    const out = ctx.createGain(); out.gain.value = 1;
    out.connect(E.buses.amb);
    const send = ctx.createGain(); send.gain.value = 0.12;       // the grove answers a little
    out.connect(send).connect(E.reverb);
    const loop = (buf, rate = 1) => E.noiseSrc(buf, t, Infinity, { loop: true, rate });
    const gain = () => { const g = ctx.createGain(); g.gain.value = 0; return g; };
    const filt = (type, f, Q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; };

    const wash = gain(), washLP = filt('lowpass', 4500, 0.5);
    loop(E.noise.pink, 1.13).connect(filt('highpass', 250, 0.5)).connect(washLP).connect(wash).connect(out);
    const hiss = gain(), shelf = filt('highshelf', 11000); shelf.gain.value = -6;
    loop(E.noise.white, 1).connect(filt('highpass', 6000, 0.5)).connect(shelf).connect(hiss).connect(out);
    const patter = gain();
    loop(patterBuffer(ctx, 5.3, 1400, 4101)).connect(filt('highpass', 900, 0.5)).connect(patter).connect(out);
    const leaves = gain();
    loop(leavesBuffer(ctx, 7.1, 70, 5303)).connect(filt('highpass', 500, 0.5)).connect(leaves).connect(out);
    const low = gain();
    loop(E.noise.brown, 0.9).connect(filt('lowpass', 180, 0.5)).connect(low).connect(out);
    built = { wash, washLP, hiss, patter, leaves, low };
  }

  function setRain(k, t = ctx.currentTime) {
    rain = Math.min(1, Math.max(0, +k || 0));
    if (!built) { if (rain <= 0) return; build(); }
    const B = built, tau = 1.2;
    const soft = smooth(0, 0.35, rain), heavy = smooth(0.3, 1, rain);
    B.wash.gain.setTargetAtTime(0.22 * (0.25 * soft + 0.75 * heavy), t, tau);
    B.washLP.frequency.setTargetAtTime(2600 + 2400 * heavy, t, tau);
    B.hiss.gain.setTargetAtTime(0.035 * (0.3 * soft + 0.7 * heavy), t, tau);
    B.patter.gain.setTargetAtTime(0.6 * soft * (0.6 + 0.4 * heavy), t, tau);
    B.leaves.gain.setTargetAtTime(0.32 * soft * (0.75 + 0.25 * heavy), t, tau);
    B.low.gain.setTargetAtTime(0.12 * heavy, t, tau);
  }

  function thunder(t, { strength = 0.7, pan = 0 } = {}) {
    const s = Math.min(1, Math.max(0.05, strength));
    const close = smooth(0.5, 0.9, s);
    const o = ctx.createGain(); o.gain.value = 1;
    const rng = E.rng;

    // ---- the crack (close strikes): jagged tearing noise, bright then darkening
    if (close > 0) {
      const dur = 0.25 + 0.2 * rng();
      const src = E.noiseSrc(E.noise.white, t, dur + 0.6);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 350;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.4;
      E.env(lp.frequency, t, [[0, 7000, 'set'], [dur + 0.4, 900, 'exp']]);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
      let tt = t;
      const steps = 12 + Math.floor(rng() * 10);
      for (let i = 0; i < steps; i++) {
        const u = i / steps;
        g.gain.setValueAtTime((0.25 + 0.75 * rng()) * (1 - 0.6 * u) * 0.55 * close, tt);
        tt += (dur / steps) * (0.5 + rng());
      }
      g.gain.setTargetAtTime(0, tt, 0.12);
      src.connect(hp).connect(lp).connect(g).connect(o);
      // the boom under it
      const bsrc = E.noiseSrc(E.noise.brown, t, 2.5, { loop: true });
      const blp = ctx.createBiquadFilter(); blp.type = 'lowpass'; blp.frequency.value = 140;
      const bg = ctx.createGain();
      E.env(bg.gain, t, [[0, 0, 'set'], [0.02, 0.9 * close, 'lin'], [0.08, 0.9 * close, 'lin'], [0.1, 0, 'tgt', 0.5]]);
      bsrc.connect(blp).connect(bg).connect(o);
      E.punch(t, 3 * close, 0.8);
    }

    // ---- the roll: low noise through a falling lowpass, swelling 3–6 times
    const len = 4 + 5 * s + 1.5 * rng();
    const lag = close > 0 ? 0.12 : 0;
    const t0 = t + lag;
    const rb = E.noiseSrc(E.noise.brown, t0, len + 2.5, { loop: true, rate: 0.8 + 0.3 * rng() });
    const rp = E.noiseSrc(E.noise.pink, t0, len + 2.5, { loop: true, rate: 0.6 });
    const pinkG = ctx.createGain(); pinkG.gain.value = 0.25 + 0.35 * s;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.6;
    const f0 = 180 + 900 * s * s;
    E.env(lp.frequency, t0, [[0, f0, 'set'], [len * 0.4, 70 + 120 * s, 'exp'], [len, 55, 'exp']]);
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 900; lp2.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t0);
    const peak = (0.35 + 0.65 * s) * 0.9;
    const attack = close > 0 ? 0.05 : 0.35 + 0.5 * (1 - s);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    // rolling swells (echoes of the bolt off the cloud deck and the hills)
    const swells = 3 + Math.floor(rng() * 4);
    let ts = t0 + attack + 0.2;
    for (let i = 0; i < swells && ts < t0 + len; i++) {
      const lvl = peak * (0.35 + 0.6 * rng()) * (1 - (ts - t0) / (len * 1.2));
      g.gain.setTargetAtTime(lvl * 0.45, ts, 0.18);
      ts += 0.25 + 0.5 * rng();
      g.gain.setTargetAtTime(Math.max(lvl, 0.02), ts, 0.12 + 0.2 * rng());
      ts += 0.4 + 0.9 * rng();
    }
    g.gain.setTargetAtTime(0, Math.max(ts, t0 + len * 0.7), 0.9);
    rb.connect(lp);
    rp.connect(pinkG).connect(lp);
    lp.connect(lp2).connect(g).connect(o);
    E.out(o, { bus: 'amb', pan: Math.max(-0.8, Math.min(0.8, pan * 0.7)), gain: 0.9, rev: 0.55 + 0.25 * (1 - s), echo: 0.18 });
  }

  return { setRain, thunder, get rain() { return rain; } };
}
