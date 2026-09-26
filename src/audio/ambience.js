// Ambience: the steppe wind, the grass it moves, and a little distant life. Owner: audio (U).
//
// Every layer is a long-running node chain whose parameters are automated from one control call per frame (or per
// 50 ms step when rendering offline), so the whole bed costs a handful of nodes and zero allocations per frame.
//
//   wind body   pink noise → lowpass 260–700 Hz                     (the pressure of the air, felt more than heard)
//   wind air    pink noise → bandpass 200–1200 Hz (bible §7.5)       gain + centre follow windGust at the camera
//   whistles    white noise → 2 narrow bandpasses (Q≈14), wandering  only in gusts: (g − 0.75)² — the wind "singing"
//   grass hiss  pink noise → highpass 3.2 kHz → flutter AM           the whole field rustling; the honami you can hear
//   rustle      pink noise → bandpass 1–4 kHz, gated by movement     your own legs wading through the grass
//   life        far lark trills / a hawk cry in calm moods, crickets at blue hour and night (occasional, sparse)
//
//   const amb = createAmbience(E)
//   amb.set(t, { gust, gustAhead, flutter, strength, pan })   — wind state at the listener (t = context time)
//   amb.move(t, speed)                                        — movement gate for the rustle layer (m/s)
//   amb.life(t, { calm, mood })                               — maybe schedule a distant bird / crickets (call ~1/s)
//   amb.setLevel(k, t)                                        — overall ambience level (title / pause / combat mix)
const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

export function createAmbience(E) {
  const { ctx } = E;
  const out = ctx.createGain(); out.gain.value = 1;
  out.connect(E.buses.amb);
  // a touch of the valley on the wind itself (very little: wind has no source to reflect)
  const send = ctx.createGain(); send.gain.value = 0.08;
  out.connect(send).connect(E.reverb);

  const loop = (buf, rate = 1) => E.noiseSrc(buf, ctx.currentTime, Infinity, { loop: true, rate });

  // ---- wind body + air (stereo pink, two different loop offsets per layer so they never phase) ----
  const bodySrc = loop(E.noise.pink, 0.93);
  const bodyLP = ctx.createBiquadFilter(); bodyLP.type = 'lowpass'; bodyLP.frequency.value = 400; bodyLP.Q.value = 0.5;
  const bodyG = ctx.createGain(); bodyG.gain.value = 0;
  bodySrc.connect(bodyLP).connect(bodyG).connect(out);

  const airSrc = loop(E.noise.pink, 1.07);
  const airHP = ctx.createBiquadFilter(); airHP.type = 'highpass'; airHP.frequency.value = 200; airHP.Q.value = 0.4;
  const airBP = ctx.createBiquadFilter(); airBP.type = 'bandpass'; airBP.frequency.value = 520; airBP.Q.value = 0.55;
  const airLP = ctx.createBiquadFilter(); airLP.type = 'lowpass'; airLP.frequency.value = 1200; airLP.Q.value = 0.3;
  const airG = ctx.createGain(); airG.gain.value = 0;
  const airPan = ctx.createStereoPanner();
  airSrc.connect(airHP).connect(airBP).connect(airLP).connect(airG).connect(airPan).connect(out);

  // ---- whistles: two resonances that only sing in the strong part of a gust ----
  const whistles = [];
  for (let i = 0; i < 2; i++) {
    const src = loop(E.noise.white, 1 + i * 0.013);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 13 + i * 4; bp.frequency.value = 780 + i * 410;
    const bp2 = ctx.createBiquadFilter(); bp2.type = 'bandpass'; bp2.Q.value = 6; bp2.frequency.value = bp.frequency.value;
    const g = ctx.createGain(); g.gain.value = 0;
    const p = ctx.createStereoPanner(); p.pan.value = i ? 0.45 : -0.45;
    src.connect(bp).connect(bp2).connect(g).connect(p).connect(out);
    whistles.push({ bp, bp2, g, p, base: 780 + i * 410, ph: i * 2.1 });
  }

  // ---- grass hiss: the field itself; amplitude-modulated by the fast flutter channel of the wind noise ----
  const hissSrc = loop(E.noise.pink, 1.21);
  const hissHP = ctx.createBiquadFilter(); hissHP.type = 'highpass'; hissHP.frequency.value = 3200; hissHP.Q.value = 0.5;
  const hissShelf = ctx.createBiquadFilter(); hissShelf.type = 'highshelf'; hissShelf.frequency.value = 9000; hissShelf.gain.value = -9;
  const hissG = ctx.createGain(); hissG.gain.value = 0;
  hissSrc.connect(hissHP).connect(hissShelf).connect(hissG).connect(out);

  // ---- movement rustle: legs through the grass ----
  const rusSrc = loop(E.noise.pink, 0.97);
  const rusBP = ctx.createBiquadFilter(); rusBP.type = 'bandpass'; rusBP.frequency.value = 2000; rusBP.Q.value = 0.7;
  const rusHP = ctx.createBiquadFilter(); rusHP.type = 'highpass'; rusHP.frequency.value = 1000;
  const rusG = ctx.createGain(); rusG.gain.value = 0;
  rusSrc.connect(rusBP).connect(rusHP).connect(rusG).connect(E.buses.sfx);

  // ---- state for the control calls ----
  let whT = 0, lastLife = -99, nextLife = 6 + E.rng() * 8, level = 1;

  function set(t, { gust = 1, gustAhead = gust, flutter = 0, strength = 1, pan = 0 } = {}) {
    const tau = 0.12;
    // a gust is heard arriving: blend in the value a few metres upwind
    const g = Math.max(0, gust * 0.7 + gustAhead * 0.3);
    const s = Math.min(3, Math.max(0.2, strength));
    // body: slow pressure
    bodyG.gain.setTargetAtTime(level * 0.2 * Math.min(1.6, 0.35 + 0.65 * g), t, 0.3);
    bodyLP.frequency.setTargetAtTime(260 + 440 * smooth(0.3, 2.2, g), t, 0.3);
    // air: the main voice of the wind; brighter and louder in gusts
    airG.gain.setTargetAtTime(level * 0.2 * Math.pow(Math.min(2.4, g), 1.25), t, tau);
    airBP.frequency.setTargetAtTime(330 + 520 * smooth(0.2, 2.2, g), t, tau * 2);
    airLP.frequency.setTargetAtTime(850 + 900 * smooth(0.4, 2.4, g), t, tau * 2);
    airPan.pan.setTargetAtTime(Math.max(-0.7, Math.min(0.7, pan * 0.6)), t, 0.4);
    // whistles: only in the upper part of a gust, stronger in storms
    whT += 0.05;
    const wAmt = Math.pow(Math.max(0, g - 0.78 - 0.1 / s), 2) * 0.22 * level;
    for (const w of whistles) {
      const f = w.base * (1 + 0.1 * Math.sin(whT * 0.37 + w.ph) + 0.05 * Math.sin(whT * 1.3 + w.ph * 3) + 0.12 * (g - 1));
      w.bp.frequency.setTargetAtTime(f, t, 0.25);
      w.bp2.frequency.setTargetAtTime(f, t, 0.25);
      w.g.gain.setTargetAtTime(Math.min(0.16, wAmt), t, 0.2);
      w.p.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, pan + (w.ph ? 0.4 : -0.4))), t, 0.5);
    }
    // grass hiss follows the gust with a fast flutter on top
    const h = smooth(0.1, 1.6, g) * (0.8 + 0.35 * flutter);
    hissG.gain.setTargetAtTime(level * 0.06 * h, t, 0.06);
  }

  function move(t, speed = 0) {
    // speed → rustle gain; running through tall grass is loud, standing still is silent
    const k = smooth(0.3, 6.5, speed);
    rusG.gain.setTargetAtTime(0.1 * k * k + 0.03 * k, t, speed > 0.2 ? 0.05 : 0.25);
    rusBP.frequency.setTargetAtTime(1400 + 1800 * k, t, 0.1);
  }

  function setLevel(k, t = ctx.currentTime) { level = Math.max(0, k); out.gain.setTargetAtTime(Math.min(1.2, 0.35 + 0.65 * level), t, 0.6); }

  // ---- distant life (one-shots) ----
  function lark(t, pan) {
    // a skylark far above: a run of fast warbled chirps, high and small
    const o = ctx.createGain(); o.gain.value = 0.9;
    let tt = t;
    const n = 6 + Math.floor(E.rng() * 10);
    for (let i = 0; i < n; i++) {
      const f = 3400 + E.rng() * 2600, d = 0.03 + E.rng() * 0.05;
      const os = ctx.createOscillator(); os.type = 'sine';
      os.frequency.setValueAtTime(f, tt);
      os.frequency.exponentialRampToValueAtTime(f * (0.8 + E.rng() * 0.5), tt + d);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(0.012 + E.rng() * 0.01, tt + 0.006); g.gain.setTargetAtTime(0, tt + d * 0.6, d * 0.3);
      os.connect(g).connect(o); os.start(tt); os.stop(tt + d + 0.1);
      tt += d + 0.015 + E.rng() * 0.05;
    }
    E.out(o, { bus: 'amb', pan, gain: 0.8, rev: 0.35, echo: 0.1 });
  }
  function hawk(t, pan) {
    // a black kite's descending whistle, far away, answered by the ridge
    const o = ctx.createGain();
    for (const [dt, len] of [[0, 0.9], [1.05, 0.55]]) {
      const os = ctx.createOscillator(); os.type = 'triangle';
      const f0 = 2350 + E.rng() * 250;
      os.frequency.setValueAtTime(f0 * 0.96, t + dt);
      os.frequency.linearRampToValueAtTime(f0, t + dt + 0.08);
      os.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + dt + len);
      const vib = ctx.createOscillator(); vib.frequency.value = 28; const vg = ctx.createGain(); vg.gain.value = 22;
      vib.connect(vg).connect(os.frequency);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t + dt); g.gain.linearRampToValueAtTime(0.018, t + dt + 0.06); g.gain.setTargetAtTime(0, t + dt + len * 0.6, len * 0.2);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
      os.connect(lp).connect(g).connect(o);
      os.start(t + dt); os.stop(t + dt + len + 0.2); vib.start(t + dt); vib.stop(t + dt + len + 0.2);
    }
    E.out(o, { bus: 'amb', pan, gain: 1, rev: 0.5, echo: 0.3 });
  }
  function crickets(t, pan, seconds = 5) {
    // a field cricket: 4.6 kHz carrier gated in triplet chirps; far, so heavily softened
    const os = ctx.createOscillator(); os.frequency.value = 4400 + E.rng() * 500;
    const am = ctx.createGain(); am.gain.value = 0;
    const g = ctx.createGain(); g.gain.value = 0;
    const rate = 0.45 + E.rng() * 0.2;
    for (let c = t; c < t + seconds; c += rate) {
      for (let p = 0; p < 3; p++) {
        const a = c + p * 0.045;
        am.gain.setValueAtTime(0, a); am.gain.linearRampToValueAtTime(1, a + 0.006); am.gain.linearRampToValueAtTime(0, a + 0.03);
      }
    }
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.006, t + 1); g.gain.setValueAtTime(0.006, t + seconds - 1); g.gain.linearRampToValueAtTime(0, t + seconds);
    os.connect(am).connect(g);
    os.start(t); os.stop(t + seconds + 0.1);
    E.out(g, { bus: 'amb', pan, gain: 1, rev: 0.25 });
  }

  function life(t, { calm = true, mood = 'golden' } = {}) {
    if (t - lastLife < nextLife) return;
    lastLife = t;
    const night = mood === 'blue' || mood === 'night';
    nextLife = (calm ? 7 : 18) + E.rng() * (calm ? 12 : 20);
    const pan = (E.rng() * 2 - 1) * 0.8;
    if (night) crickets(t, pan, 4 + E.rng() * 5);
    else if (!calm) return;
    else if (E.rng() < 0.28) hawk(t, pan);
    else lark(t, pan);
  }

  return { set, move, life, setLevel, out };
}
