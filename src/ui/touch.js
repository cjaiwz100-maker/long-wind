// Touch controls for phones and tablets: DOM + CSS over the canvas (no draw calls), in the HUD's ink. A floating
// thumb-stick under the left thumb, camera look by dragging the right side, and a fan of brush-ensō buttons under the
// right thumb. Everything is written into input.touch (game/input.js), so gameplay sees exactly the actions of the
// keyboard, mouse and pad. Owner: UI (U).
//   createTouchControls(app, { game, hud }) → { el, layout(), dispose() } | null (not a touch device)
//   Shown on coarse-pointer devices; ?touch=1 forces it (a mouse can drive it), ?touch=0 turns it off.
//   · stick: lands wherever the left thumb goes down (left 40 %), rests faintly bottom-left; analog move, pushed past
//     the rim = sprint (疾)
//   · look: drag anywhere on the right side that is not a button
//   · 斩 light (hold = heavy charge; the glyph turns 劈) · 闪 dodge · 格 block (tap at impact = parry) · 气 sword-qi
//     (the ring fills with focus, gold when ready) · 锁 lock-on · 剑 draw/sheathe · ‖ pause
//   · portrait: a brush note to turn the phone (横屏游玩更佳); play still works
//   · the screens stay tap-driven by the HUD (title, pause menu, endings); here only their words change
// Only transform/opacity animate; geometry is written on resize, never read per frame.
import { bus } from '../core/bus.js';

// a: action, g: glyph, k: size class, ang: position round 斩 (screen degrees: 180 = left, 270 = up), ring: 1 | 2,
// rot: turn of the brush ensō so no two rings look stamped
const BUTTONS = [
  { a: 'light', g: '斩', k: 'main', rot: -18 },
  { a: 'dodge', g: '闪', k: 'mid', ang: 182, ring: 1, rot: 40 },
  { a: 'block', g: '格', k: 'mid', ang: 226, ring: 1, rot: 160 },
  { a: 'special', g: '气', k: 'mid', ang: 270, ring: 1, rot: 0 },
  { a: 'lock', g: '锁', k: 'small', ang: 204, ring: 2, rot: 250 },
  { a: 'draw', g: '剑', k: 'small', ang: 248, ring: 2, rot: 100 },
];
const SIZE = { main: 88, mid: 60, small: 46 };     // px at u = 1
const RING = [0, 102, 168];
const STICK_R = 54;                                // ring radius (px at u = 1); the knob travels to the rim
const DEAD = 0.14, SPRINT_ON = 1.12, SPRINT_OFF = 0.96, FOLLOW = 1.45;

// the in-game hint and the pause menu's 招式 list, for thumbs
const HINT = [['LEFT DRAG', '行', 'move · past the rim 疾 sprint'], ['RIGHT DRAG', '顾', 'look'], ['HOLD 斩', '劈', 'heavy'], ['TAP 格 AT IMPACT', '破', 'parry']];
const CONTROLS = [
  ['LEFT DRAG', '行', 'move'], ['PAST THE RIM', '疾', 'sprint'], ['RIGHT DRAG', '顾', 'look'], ['TAP 斩', '斩', 'strike'],
  ['HOLD 斩', '劈', 'heavy'], ['HOLD 格', '格', 'block · parry at impact'], ['闪', '闪', 'dodge'], ['锁', '锁', 'lock on'],
  ['气', '气', 'sword qi'], ['剑', '剑', 'draw · sheathe'], ['‖', '歇', 'pause'],
];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** Touch UI wanted? ?touch=1 / ?touch=0 win; otherwise a coarse primary pointer (phone, tablet). */
export function touchWanted(params) {
  const t = params?.get?.('touch');
  if (t === '0') return false;
  if (t === '1') return true;
  return coarse();
}

export function createTouchControls(app, { game, hud } = {}) {
  const input = game?.input, root = hud?.el;
  if (!input?.touch || !root || !touchWanted(app.params ?? new URLSearchParams(location.search))) return null;
  injectCSS();
  const T = input.touch;
  T.enabled = true;
  input.exitLock();
  const realTouch = coarse();

  // ---------------------------------------------------------------- DOM
  const layer = document.createElement('div');
  layer.className = 'wxt';
  layer.innerHTML = `
    <div class="zone zl"></div><div class="zone zr"></div>
    <div class="stick"><div class="wash"></div><div class="ring"></div><div class="g">行</div><div class="fast">疾</div><div class="knob"><i></i></div></div>
    ${BUTTONS.map((B) => `<div class="tb ${B.k}" data-a="${B.a}" style="--rot:${B.rot}deg"><i class="bg"></i>${B.a === 'special' ? '<i class="rt m"></i>' : ''}<i class="gl"></i><i class="r m"></i><i class="bl m"></i><b>${B.g}</b></div>`).join('')}
    <div class="tp"><i class="bg"></i><i class="r m"></i><i class="s m"></i><i class="s m"></i></div>
    <div class="probe"></div>`;
  root.insertBefore(layer, root.querySelector('.scr'));   // under the screens (title, pause, endings)
  const rot = document.createElement('div');
  rot.className = 'wxrot';
  rot.innerHTML = '<i class="ph"></i><b>横屏游玩更佳</b><em>best played sideways</em>';
  root.appendChild(rot);
  root.classList.add('touch');
  document.documentElement.classList.add('wx-touch');

  const $ = (s) => layer.querySelector(s);
  const zl = $('.zl'), zr = $('.zr'), stick = $('.stick'), knob = $('.knob'), pauseBtn = $('.tp'), probe = $('.probe');
  const buttons = BUTTONS.map((B) => ({ ...B, el: layer.querySelector(`.tb[data-a="${B.a}"]`), id: null, flip: false }));
  const btn = Object.fromEntries(buttons.map((B) => [B.a, B]));
  const glyphMain = btn.light.el.querySelector('b');

  // screens: tap words, and the touch list in the pause menu / in-game hint
  const rows = (list) => list.map(([k, zh, en]) => `<kbd>${k}</kbd><span>${zh}<i>${en}</i></span>`).join('');
  const setHTML = (sel, html) => { const n = root.querySelector(sel); if (n) n.innerHTML = html; };
  setHTML('.title .go .t i', 'tap to begin');
  setHTML('.pause .ctl', rows(CONTROLS));
  setHTML('.hint', rows(HINT));

  // ---------------------------------------------------------------- layout (on resize only)
  const S = {
    W: 0, H: 0, u: 1, R: STICK_R, rest: { x: 0, y: 0 }, sa: { t: 0, r: 0, b: 0, l: 0 }, k: 0.006,
    id: null, bx: 0, by: 0, sprint: false, look: null, lx: 0, ly: 0, state: '', portrait: false, rotT: 0,
  };
  const pointers = new Set();
  const count = () => { T.n = pointers.size; };
  function layout() {
    const cs = getComputedStyle(probe);                // env(safe-area-inset-*), read once per resize
    const sa = S.sa = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    const W = S.W = innerWidth, H = S.H = innerHeight;
    const portrait = H > W;
    if (portrait !== S.portrait) { S.portrait = portrait; S.rotT = 0; root.classList.toggle('portrait', portrait); root.classList.remove('rot-seen'); }
    const u = S.u = clamp(Math.min(W, H) / 400, 0.82, 1.3) * (portrait ? clamp(W / 460, 0.8, 1) : 1);
    const m = 18 * u;
    // the attack fan: 斩 in the corner, the rest on two arcs round it
    const cx = W - sa.r - m - SIZE.main * u / 2, cy = H - sa.b - m - SIZE.main * u / 2;
    for (const B of buttons) {
      const d = SIZE[B.k] * u, r = RING[B.ring ?? 0] * u, a = (B.ang ?? 0) * Math.PI / 180;
      box(B.el, cx + Math.cos(a) * r, cy + Math.sin(a) * r, d);
    }
    const pd = 42 * u;
    box(pauseBtn, W - sa.r - 14 * u - pd / 2, sa.t + 12 * u + pd / 2, pd);
    // the stick rests bottom-left; its zone is the left 40 % (half the width when upright)
    S.R = STICK_R * u;
    S.rest.x = sa.l + m + S.R + 6 * u; S.rest.y = H - sa.b - m - S.R;
    const zw = Math.round(W * (portrait ? 0.5 : 0.4));
    zl.style.width = `${zw}px`; zr.style.left = `${zw}px`;
    stick.style.width = stick.style.height = `${(2 * S.R).toFixed(1)}px`;
    stick.style.setProperty('--d', `${(2 * S.R).toFixed(1)}px`);
    if (S.id === null) placeStick(S.rest.x, S.rest.y);
    S.k = clamp(5.4 / W, 0.004, 0.009);             // look: a drag across the whole screen turns ~300°
    // the HUD on touch: vitals up in the top-left, sized to leave the boss bar the centre; the hint beneath them
    const vs = clamp(0.62 * u, 0.55, 0.8), fs = 84 * vs;
    const bossW = portrait ? W * 0.84 : clamp(W * 0.36, 220, 480);
    const avail = portrait ? W - sa.l - sa.r - 40 : (W - bossW) / 2 - 16 - sa.l - 12;
    const rs = root.style;
    rs.setProperty('--tvs', vs.toFixed(3)); rs.setProperty('--tvh', `${fs.toFixed(1)}px`);
    rs.setProperty('--thw', `${clamp(avail - fs - 10, 120, 300 * u).toFixed(1)}px`); rs.setProperty('--tbw', `${bossW.toFixed(1)}px`);
  }
  function box(el, x, y, d) {
    const s = el.style;
    s.left = `${(x - d / 2).toFixed(1)}px`; s.top = `${(y - d / 2).toFixed(1)}px`;
    s.width = s.height = `${d.toFixed(1)}px`;
    s.setProperty('--d', `${d.toFixed(1)}px`);
  }
  function placeStick(x, y) { stick.style.transform = `translate3d(${(x - S.R).toFixed(1)}px,${(y - S.R).toFixed(1)}px,0)`; }
  function placeKnob(x, y) { knob.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`; }

  // ---------------------------------------------------------------- stick
  function setSprint(on) {
    if (on === S.sprint) return;
    S.sprint = on;
    T.hold('sprint', on);
    stick.classList.toggle('fast', on);
  }
  function stickMove(x, y) {
    let dx = x - S.bx, dy = y - S.by, d = Math.hypot(dx, dy);
    const R = S.R, far = R * FOLLOW;
    if (d > far) {                                  // the ring follows a thumb that runs away from it
      const k = (d - far) / d;
      S.bx += dx * k; S.by += dy * k; dx = x - S.bx; dy = y - S.by; d = far;
      placeStick(S.bx, S.by);
    }
    const c = d > R ? R / d : 1;
    placeKnob(dx * c, dy * c);
    const raw = d / R, mag = raw < DEAD ? 0 : Math.min(1, (raw - DEAD) / (0.92 - DEAD));
    const nx = d > 1e-3 ? dx / d : 0, ny = d > 1e-3 ? dy / d : 0;
    T.setMove(nx * mag, -ny * mag);                 // screen up = forward
    setSprint(S.sprint ? raw > SPRINT_OFF : raw > SPRINT_ON);
  }
  function stickEnd() {
    if (S.id === null) return;
    pointers.delete(S.id); count();
    S.id = null;
    T.setMove(0, 0);
    setSprint(false);
    stick.classList.remove('live');
    placeKnob(0, 0);
    placeStick(S.rest.x, S.rest.y);
  }
  zl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (S.id !== null) return;
    S.id = e.pointerId; pointers.add(e.pointerId); count();
    try { zl.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const R = S.R, sa = S.sa;
    S.bx = clamp(e.clientX, sa.l + R + 6, S.W - R - 6);
    S.by = clamp(e.clientY, sa.t + R + 6, S.H - sa.b - R - 6);
    stick.classList.add('live');
    placeStick(S.bx, S.by);
    stickMove(e.clientX, e.clientY);
  });
  zl.addEventListener('pointermove', (e) => { if (e.pointerId === S.id) stickMove(e.clientX, e.clientY); });

  // ---------------------------------------------------------------- look
  function lookEnd() { if (S.look === null) return; pointers.delete(S.look); count(); S.look = null; }
  zr.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (S.look !== null) return;
    S.look = e.pointerId; pointers.add(e.pointerId); count();
    S.lx = e.clientX; S.ly = e.clientY;
    try { zr.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  });
  zr.addEventListener('pointermove', (e) => {
    if (e.pointerId !== S.look) return;
    const dx = e.clientX - S.lx, dy = e.clientY - S.ly;
    S.lx = e.clientX; S.ly = e.clientY;
    if (dx || dy) T.look(dx * S.k, dy * S.k * 0.8);   // the mouse's sense: drag right looks right, drag up looks up
  });

  // ---------------------------------------------------------------- buttons
  const buzz = (ms) => { try { if (realTouch) navigator.vibrate?.(ms); } catch { /* not allowed */ } };
  function release(B) {
    if (B.id === null) return;
    pointers.delete(B.id); count();
    B.id = null;
    T.hold(B.a, false);
    B.el.classList.remove('on');
  }
  for (const B of buttons) {
    B.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (B.id !== null) return;
      B.id = e.pointerId; pointers.add(e.pointerId); count();
      try { B.el.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      T.hold(B.a, true);                              // held like the key: 斩 held = charge, 格 held = guard
      B.flip = !B.flip;                               // alternate two keyframes: the ink bloom restarts without a reflow
      B.el.classList.remove('p1', 'p2');
      B.el.classList.add('on', B.flip ? 'p1' : 'p2');
      buzz(B.k === 'main' ? 9 : 6);
    });
  }
  let tapFlip = false;
  pauseBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    T.hold('pause', true); T.hold('pause', false);  // one press edge: gameplay's pause toggle, as Esc
    tapFlip = !tapFlip;
    pauseBtn.classList.remove('p1', 'p2'); pauseBtn.classList.add(tapFlip ? 'p1' : 'p2');
    buzz(6);
  });
  // lifts: pointer capture sends every up/cancel to the element that took the touch
  const ends = [[zl, stickEnd, () => S.id], [zr, lookEnd, () => S.look], ...buttons.map((B) => [B.el, () => release(B), () => B.id])];
  for (const [el, end, id] of ends) for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, (e) => { if (e.pointerId === id()) end(); });

  function releaseAll() {
    stickEnd(); lookEnd();
    for (const B of buttons) release(B);
    pointers.clear(); count();
    T.clear();
    S.sprint = false; stick.classList.remove('fast');
  }

  // ---------------------------------------------------------------- page behaviour on touch
  const noDefault = (e) => e.preventDefault();
  layer.addEventListener('contextmenu', noDefault);
  // no scroll, rubber-band or pinch-zoom anywhere in the game (the volume slider runs on pointer events)
  document.addEventListener('touchmove', noDefault, { passive: false });
  document.addEventListener('gesturestart', noDefault);
  // going to the background mid-fight pauses (on touch there is no pointer lock to lose)
  const onVis = () => { if (!document.hidden) return; if (root.dataset.state === 'playing') game.setPaused?.(true); releaseAll(); };
  document.addEventListener('visibilitychange', onVis);
  // the tap that leaves the title also asks for full screen in landscape (Android, iPad; iPhone Safari has no API).
  // S.state is last frame's: the HUD has already turned this very tap into ui:start by the time we see it.
  let fsArmed = false;
  const onDown = () => { fsArmed = S.state === 'title'; };
  const onUp = () => {
    if (!fsArmed || !realTouch) return;
    fsArmed = false;
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) return;
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    try {
      const p = req?.({ navigationUI: 'hide' });
      p?.then?.(() => screen.orientation?.lock?.('landscape')?.catch?.(() => {}))?.catch?.(() => {});
    } catch { /* not allowed */ }
  };
  addEventListener('pointerdown', onDown, true);
  addEventListener('pointerup', onUp, true);
  let focusMax = 100;
  const offFocus = bus.on('player:focus', (p) => { if (p?.max) focusMax = p.max; });

  // ---------------------------------------------------------------- per frame: poll the hero, flip classes on change
  const flags = { charge: false, guard: false, sheathed: false, lock: false, full: false, f: -1 };
  const flag = (k, v, el, cls) => { if (flags[k] === v) return; flags[k] = v; el.classList.toggle(cls, v); };
  function update(dt, t, _app, rawDt = dt) {
    const st = root.dataset.state;
    if (st !== S.state) { releaseAll(); S.state = st; }
    if (S.portrait && (st === 'playing' || st === 'title') && !root.classList.contains('rot-seen')) {
      S.rotT += Math.min(rawDt, 0.1);
      if (st === 'playing' && S.rotT > 7) root.classList.add('rot-seen');   // read by now: out of the way
    }
    if (st !== 'playing') return;
    const P = game.player;
    if (!P) return;
    const charge = P.state === 'charge';
    if (charge !== flags.charge) glyphMain.textContent = charge ? '劈' : '斩';
    flag('charge', charge, btn.light.el, 'charge');
    flag('guard', P.state === 'block' || P.state === 'parry', btn.block.el, 'act');
    flag('sheathed', !P.drawn, btn.draw.el, 'off');
    flag('lock', !!P.lock?.alive, btn.lock.el, 'lit');
    const f = clamp(P.focus / focusMax, 0, 1);
    if (Math.abs(f - flags.f) > 0.004) { flags.f = f; btn.special.el.style.setProperty('--f', f.toFixed(3)); }
    flag('full', f >= 0.999, btn.special.el, 'full');
  }

  layout();
  addEventListener('resize', layout);
  addEventListener('orientationchange', layout);

  const sys = {
    update, el: layer, layout,
    dispose() {
      releaseAll();
      offFocus?.();
      removeEventListener('resize', layout); removeEventListener('orientationchange', layout);
      removeEventListener('pointerdown', onDown, true); removeEventListener('pointerup', onUp, true);
      document.removeEventListener('touchmove', noDefault); document.removeEventListener('gesturestart', noDefault);
      document.removeEventListener('visibilitychange', onVis);
      app.remove(sys);
      layer.remove(); rot.remove();
      root.classList.remove('touch', 'portrait', 'rot-seen');
      document.documentElement.classList.remove('wx-touch');
      T.enabled = false;
    },
  };
  app.add(sys);
  return sys;
}

function injectCSS() {
  if (document.getElementById('wx-touch-css')) return;
  const s = document.createElement('style');
  s.id = 'wx-touch-css';
  s.textContent = TOUCH_CSS;
  document.head.appendChild(s);
}

// Scoped to .wx.touch / html.wx-touch and injected only when the controls are on: the desktop page never sees it.
// Brush textures (--t-enso, --t-splat, …) come from the HUD root (ui/textures.js), palette and fonts from HUD_CSS.
const TOUCH_CSS = /* css */`
html.wx-touch, html.wx-touch body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none; touch-action: none; }
.wx .wxt { position: absolute; inset: 0; pointer-events: none; opacity: 0; visibility: hidden;
  transition: opacity .5s var(--ease-ink), visibility 0s linear .5s; }
.wx[data-state=playing] .wxt { opacity: 1; visibility: visible; transition: opacity .9s var(--ease-ink) .2s, visibility 0s; }
.wxt .zone { position: absolute; top: 0; bottom: 0; pointer-events: auto; touch-action: none; }
.wxt .zl { left: 0; width: 40%; }
.wxt .zr { left: 40%; right: 0; }
.wxt .probe { position: absolute; visibility: hidden; pointer-events: none;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }

/* ---------- stick: a brush ensō under the thumb (行 at rest), a smaller one for the knob ---------- */
.wxt .stick { position: absolute; left: 0; top: 0; pointer-events: none; opacity: .42; will-change: transform, opacity;
  transition: transform .38s var(--ease-ink), opacity .45s var(--ease-ink); }
.wxt .stick.live { opacity: .92; transition: opacity .12s; }
.wxt .stick > * { position: absolute; }
.wxt .stick .wash { inset: 4%; border-radius: 50%; background: radial-gradient(closest-side, rgba(10,8,6,.34), rgba(10,8,6,.2) 70%, rgba(10,8,6,0)); }
.wxt .stick .ring { inset: 0; background: var(--ink); opacity: .75; transform: rotate(-18deg);
  -webkit-mask: var(--t-enso2) center / 100% 100% no-repeat; mask: var(--t-enso2) center / 100% 100% no-repeat; }
.wxt .stick .g { inset: 0; display: grid; place-items: center; padding-bottom: 5%; font: calc(var(--d) * .3)/1 var(--f-brush); color: var(--ink);
  opacity: .8; text-shadow: 0 1px 3px rgba(0,0,0,.5); transition: opacity .2s; }
.wxt .stick.live .g { opacity: 0; }
.wxt .stick .knob { left: 27%; top: 27%; width: 46%; height: 46%; will-change: transform; opacity: 0; transition: transform .25s var(--ease-ink), opacity .2s; }
/* the knob: a small ensō round a dot of pale ink (the lock reticle's vocabulary) */
.wxt .stick .knob::before, .wxt .stick .knob::after { content: ''; position: absolute; border-radius: 50%; }
.wxt .stick .knob::before { inset: -16%; background: radial-gradient(closest-side, rgba(10,8,6,.45), rgba(10,8,6,.2) 60%, rgba(10,8,6,0)); }
.wxt .stick .knob::after { inset: 27%; background: radial-gradient(closest-side, rgba(243,228,196,.96) 62%, rgba(243,228,196,0)); }
.wxt .stick .knob i { position: absolute; inset: 0; background: var(--ink-hi); opacity: .9; transform: rotate(70deg);
  -webkit-mask: var(--t-enso) center / 100% 100% no-repeat; mask: var(--t-enso) center / 100% 100% no-repeat; }
.wxt .stick.live .knob { opacity: 1; transition: opacity .12s; }
/* sprint: the ring turns gold and 疾 takes the centre the knob has left */
.wxt .stick .fast { inset: 0; display: grid; place-items: center; padding-bottom: 5%; font: calc(var(--d) * .32)/1 var(--f-brush); color: var(--gold);
  text-shadow: 0 0 12px rgba(255,186,90,.8), 0 1px 2px rgba(0,0,0,.6); opacity: 0; transform: scale(1.4); transition: opacity .18s, transform .3s var(--ease-brush); }
.wxt .stick.fast .ring { background: var(--gold); opacity: 1; }
.wxt .stick.fast .fast { opacity: 1; transform: none; }

/* ---------- buttons: a calligraphic glyph in a brush ensō over a soft ink wash ---------- */
.wxt .tb, .wxt .tp { position: absolute; left: 0; top: 0; border-radius: 50%; pointer-events: auto; touch-action: none;
  transition: transform .14s var(--ease-ink); will-change: transform; }
.wxt .tb::after { content: ''; position: absolute; inset: -14%; border-radius: 50%; }   /* a thumb is wider than the ink */
.wxt .tb > *, .wxt .tp > * { position: absolute; pointer-events: none; }
.wxt .tb .bg, .wxt .tp .bg { inset: 4%; border-radius: 50%;
  background: radial-gradient(closest-side, rgba(10,8,6,.44), rgba(10,8,6,.3) 62%, rgba(10,8,6,0)); }
.wxt .tb .r, .wxt .tb .rt { inset: 0; background: var(--ink); opacity: .6; -webkit-mask-image: var(--t-enso); mask-image: var(--t-enso); transform: rotate(var(--rot));
  transition: opacity .15s; }
.wxt .tb b { inset: 0; display: grid; place-items: center; padding-bottom: 6%; font: 400 calc(var(--d) * .5)/1 var(--f-brush); color: var(--ink-hi);
  text-shadow: 0 1px 3px rgba(0,0,0,.6), 0 0 14px rgba(0,0,0,.28); transition: color .15s, opacity .2s; }
.wxt .tb .bl { inset: -22%; background: var(--ink-hi); opacity: 0; -webkit-mask-image: var(--t-splat2); mask-image: var(--t-splat2); }
.wxt .tb .gl { inset: -12%; border-radius: 50%; opacity: 0; background: radial-gradient(closest-side, rgba(255,196,110,.45), rgba(255,186,90,.13) 60%, transparent); }
.wxt .tb.small b { font-size: calc(var(--d) * .46); }
.wxt .tb.small .r { opacity: .48; }
/* 斩: the big one, with a vermilion bloom */
.wxt .tb.main .r { opacity: .72; -webkit-mask-image: var(--t-enso2); mask-image: var(--t-enso2); }
.wxt .tb.main b { font-size: calc(var(--d) * .54); }
.wxt .tb.main .bl { background: var(--verm-hi); -webkit-mask-image: var(--t-splat); mask-image: var(--t-splat); }
/* 气: the ring fills with focus like the HUD's ensō */
.wxt .tb[data-a=special] .rt { opacity: .16; }
.wxt .tb[data-a=special] .r { opacity: .85;
  -webkit-mask-image: var(--t-enso), conic-gradient(from -36deg, #000 calc(var(--f) * 90%), transparent calc(var(--f) * 90% + 1.5%));
  mask-image: var(--t-enso), conic-gradient(from -36deg, #000 calc(var(--f) * 90%), transparent calc(var(--f) * 90% + 1.5%));
  -webkit-mask-composite: source-in; mask-composite: intersect; }
.wxt .tb[data-a=special] b { opacity: .5; }

/* states (after the kinds, so they win) */
.wxt .tb.on { transform: scale(.9); }
.wxt .tb.on .r { opacity: .95; }
.wxt .tb.on b { color: #fff6e2; }
.wxt .tb.p1 .bl { animation: wxt-bloom .5s var(--ease-ink) forwards; }
.wxt .tb.p2 .bl { animation: wxt-bloom2 .5s var(--ease-ink) forwards; }
.wxt .tb.main.charge .r { background: var(--gold); opacity: 1; }                      /* held: the heavy charge (劈) */
.wxt .tb.main.charge b { color: var(--gold); text-shadow: 0 0 16px rgba(255,186,90,.8), 0 1px 3px rgba(0,0,0,.5); }
.wxt .tb.main.charge .gl { animation: wxt-glow .45s ease-in-out infinite alternate; }
.wxt .tb.act .r { opacity: 1; background: var(--ink-hi); }                            /* 格: the guard is up */
.wxt .tb[data-a=special].full .r { background: var(--gold); }                         /* 气: ready */
.wxt .tb[data-a=special].full b { opacity: 1; color: var(--gold); text-shadow: 0 0 14px rgba(255,186,90,.75), 0 0 2px rgba(255,220,160,.9); }
.wxt .tb[data-a=special].full .gl { animation: wx-breathe 2.4s ease-in-out infinite; }
.wxt .tb.lit .r { background: var(--verm-hi); opacity: .95; }                         /* 锁: the reticle's vermilion */
.wxt .tb.lit b { color: #ffd9c8; }
.wxt .tb.off b { opacity: .55; }                                                      /* 剑: sheathed */

/* pause: two brush strokes in a faint ensō */
.wxt .tp .r { inset: 0; background: var(--ink); opacity: .4; -webkit-mask-image: var(--t-enso2); mask-image: var(--t-enso2); transform: rotate(130deg); }
.wxt .tp .s { left: 50%; top: 50%; width: calc(var(--d) * .46); height: calc(var(--d) * .13); margin: calc(var(--d) * -.065) 0 0 calc(var(--d) * -.23);
  background: var(--ink); opacity: .85; -webkit-mask-image: var(--t-thin); mask-image: var(--t-thin); transform: translateX(calc(var(--d) * -.11)) rotate(90deg); }
.wxt .tp .s + .s { transform: translateX(calc(var(--d) * .11)) rotate(-90deg); }
.wxt .tp.p1 { animation: wxt-tap .3s var(--ease-ink); }
.wxt .tp.p2 { animation: wxt-tap2 .3s var(--ease-ink); }

/* ---------- the HUD, rearranged for thumbs ---------- */
.wx.touch .vitals { left: calc(env(safe-area-inset-left) + 12px); top: calc(env(safe-area-inset-top) + 8px); bottom: auto; --s: var(--tvs, .6); }
.wx.touch .health { width: var(--thw, 220px); }
.wx.touch .boss.play { width: var(--tbw, 300px); top: calc(env(safe-area-inset-top) + clamp(10px, 3vh, 40px)); }   /* the bar (the boss-wave banner is .boss too) */
.wx.touch.portrait .boss.play { top: calc(env(safe-area-inset-top) + var(--tvh, 50px) + 34px); }
@media (max-height: 500px) { .wx.touch .banner.boss { top: 40%; } }   /* a short screen: the boss wave's title clears the boss bar */
.wx.touch .hint { left: calc(env(safe-area-inset-left) + 22px); right: auto; top: calc(env(safe-area-inset-top) + var(--tvh, 50px) + 30px); bottom: auto;
  gap: 4px 10px; font-size: 12px; }
.wx.touch .hint kbd { font-size: 11px; letter-spacing: .1em; }
.wx.touch .hint span, .wx.touch .hint span i { font-size: 12px; }
.wx.touch .combo { top: calc(env(safe-area-inset-top) + 64px); right: calc(env(safe-area-inset-right) + 24px); }
/* the calls to begin / go on, centred without the translateX their fade-in (wx-rise) overrides */
.wx.touch .title .go { left: 0; right: 0; justify-content: center; }
.wx.touch .end .go, .wx.touch .end .tr { left: 0; right: 0; margin-left: auto; margin-right: auto; }
@media (max-height: 500px) and (orientation: landscape) {
  /* a short landscape phone: 点击 · 启程 moves under the hero, clear of the LONG WIND lines under the column */
  .wx.touch .title .go { left: calc(env(safe-area-inset-left) + 13%); right: auto; bottom: 7vh; }
  .wx.touch .end .tr { display: none; }            /* no room under the poem columns: the English makes way */
}
/* pause menu: rows as wide as their words (a tapped row keeps its underline: touch has sticky hover); on a phone the
   招式 list takes the place of the sound / quality / chapter rows, in two columns */
.wx.touch .pause button { align-self: flex-start; }
.wx.touch.portrait .pause .pn { left: calc(env(safe-area-inset-left) + 26px); right: 14px; flex-direction: column; gap: 4px; }   /* upright: 歇 above */
.wx.touch.portrait .pause .hd { font-size: 64px; }
.wx.touch.portrait .pause .qual i { display: none; }
.wx.touch.portrait .pause .ctl { gap: 7px 12px; }
.wx.touch.portrait .pause .ctl span, .wx.touch.portrait .pause .ctl span i { font-size: 13px; }
@media (max-height: 600px) {
  .wx.touch .pause.show-ctl .mn > :is(.vol, .qual) { display: none; }
  .wx.touch .pause .ctl { grid-template-columns: repeat(4, auto); gap: 7px 14px; margin-top: 2px; padding-top: 6px; }
  .wx.touch .pause .ctl kbd { font-size: 11px; }
  .wx.touch .pause .ctl span, .wx.touch .pause .ctl span i { font-size: 12px; }
}

/* ---------- portrait: a note to turn the phone (it never blocks play) ---------- */
.wx .wxrot { position: absolute; left: 0; right: 0; top: calc(env(safe-area-inset-top) + 15%); display: none; text-align: center;
  pointer-events: none; white-space: nowrap; opacity: 0; transition: opacity 1.2s var(--ease-ink); }
.wx.touch.portrait .wxrot { display: block; }
.wx.touch.portrait[data-state=playing] .wxrot { top: 47%; }          /* in play: under the wave banner, over the hero */
.wx.touch.portrait:is([data-state=title], [data-state=playing]):not(.rot-seen) .wxrot { opacity: 1; }
.wx .wxrot::before { content: ''; position: absolute; left: 8%; right: 8%; top: -40%; bottom: -46%; z-index: -1; background: rgba(7,6,4,.4);
  -webkit-mask: var(--t-wash) center / 100% 100% no-repeat; mask: var(--t-wash) center / 100% 100% no-repeat; }
.wx .wxrot .ph { display: block; width: 20px; height: 34px; margin: 0 auto 12px; border: 2px solid var(--ink); border-radius: 4px; opacity: .85;
  box-shadow: inset 0 -3px 0 -1px rgba(232,211,173,.5); animation: wxt-turn 2.8s var(--ease-ink) infinite; }
.wx .wxrot b { display: block; font: 400 26px/1 var(--f-brush); letter-spacing: .3em; padding-left: .3em; color: var(--ink-hi); text-shadow: 0 1px 3px rgba(0,0,0,.5); }
.wx .wxrot em { display: block; margin-top: 8px; font: italic 400 12px/1 var(--f-latin); letter-spacing: .26em; padding-left: .26em; color: var(--ink-dim); text-transform: uppercase; }

@keyframes wxt-bloom { 0% { opacity: .5; transform: scale(.45) rotate(0deg); } 100% { opacity: 0; transform: scale(1.12) rotate(24deg); } }
@keyframes wxt-bloom2 { 0% { opacity: .5; transform: scale(.45) rotate(0deg); } 100% { opacity: 0; transform: scale(1.12) rotate(-24deg); } }
@keyframes wxt-glow { from { opacity: .35; } to { opacity: 1; } }
@keyframes wxt-tap { 0% { transform: scale(.84); } 100% { transform: none; } }
@keyframes wxt-tap2 { 0% { transform: scale(.84); } 100% { transform: none; } }
@keyframes wxt-turn { 0%, 30% { transform: rotate(0deg); } 55%, 85% { transform: rotate(-90deg); } 100% { transform: rotate(0deg); } }
@media (prefers-reduced-motion: reduce) { .wxt *, .wx .wxrot * { animation-duration: .01s !important; } }
`;
