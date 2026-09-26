// Ink-brush HUD (bible §M4, CONTRACTS UI). Pure DOM/CSS over the canvas (zero draw calls), subscribing to the bus only.
// Owner: UI (U). API:
//   const hud = createHUD(app)
//   hud.update(dt, t, app, rawDt) / hud.lateUpdate(...)   — registered automatically with app.add(); UI runs on real dt
//   hud.track(id, getWorldPos, opts?)  — anchor marks above an enemy. getWorldPos(out: Vector3) → Vector3 (feet/root),
//                                        or pass an Object3D / a live Vector3. opts: { height = 1.8, anchor: 'feet'|'head',
//                                        name, sub, boss, actor?: { pos, hp, maxHp, posture, maxPosture, active } (read
//                                        live, no allocation), stats?: () => ({ hp, hpMax, posture, postureMax }) }
//                                        Enemies announced only by `enemy:spawn` are resolved to live actors through
//                                        createHUD(app, { resolve(id) }) or, by default, the gameplay debug handle.
//   hud.untrack(id)
//   hud.setEnemy(id, { hp, hpMax, posture, postureMax })   — push enemy values (alternative to opts.stats / events)
//   hud.boss(id | null, { name, sub })                     — show / hide the boss bar for a tracked enemy
//   hud.setState(state)            — 'title' | 'playing' | 'paused' | 'victory' | 'defeat' (normally from game:state)
//   hud.banner(title, { no, en, seal, hold })              — manual calligraphy banner
//   hud.setPlayer({ hp, max, focus, focusMax })
//   hud.flourish(kind, worldPos?)  — 'parry' | 'block' | 'hit' | 'kill' | 'hurt' | 'special' | 'evade'
//   hud.showHint(seconds)          — re-show the controls hint
//   hud.reset()                    — blank slate: untrack everything, clear banners/screens, full health (state 'boot')
//   hud.el / hud.ready (Promise: textures + fonts done) / hud.dispose()
// Listens: game:state, wave:start {index (1-based), title, sub, boss}, wave:clear, player:hp, player:focus, player:hurt,
//   player:parry, player:evade, player:death, enemy:spawn {id, kind, pos, name?, sub?, boss?}, enemy:hit {…, hp?, max?},
//   enemy:death, enemy:parried, enemy:telegraph, enemy:posture {id, broken}, enemy:phase {id, phase}, lockon, special,
//   and optional enemy:state {id, hp, hpMax|max, posture, postureMax}, boss {id, name, sub}.
// Emits: ui:start (title click/key), ui:resume, ui:restart, ui:volume {value 0..1}, ui:sfx {kind} (for audio).
//   If nothing answers ui:resume within 160 ms, the menu presses Esc (gameplay's pause toggle) so it can never trap.
import * as THREE from 'three';
import { bus } from '../core/bus.js';
import { HUD_CSS } from './style.js';
import { HUD_HTML, WAVES, BOSS_WAVE, WAVE_EN, BOSS_NAMES, VICTORY, DEFEAT, fillEnding, numeral, esc } from './screens.js';
import { buildTextures } from './textures.js';

const CJK = /[㐀-鿿]/;
const MARK_RANGE = 42;          // m: marks beyond this fade out
const MARK_LINGER = 5.5;        // s: marks stay after the last change
const FX_POOL = 14;

function injectCSS() {
  if (document.getElementById('wx-hud-css')) return;
  const s = document.createElement('style');
  s.id = 'wx-hud-css';
  s.textContent = HUD_CSS;
  document.head.appendChild(s);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt);

export function createHUD(app, opts = {}) {
  injectCSS();
  const host = opts.host || document.getElementById('hud') || document.body;
  const root = document.createElement('div');
  root.className = 'wx';
  root.dataset.state = 'boot';
  root.innerHTML = HUD_HTML;
  host.appendChild(root);
  const $ = (sel) => root.querySelector(sel);

  const el = {
    marks: $('.marks'), fxl: $('.fxl'), edge: $('.edge'), qi: $('.qi'),
    focus: $('.focus'), health: $('.health'), boss: $('.boss'), bossName: $('.boss .nm'), bossSub: $('.boss .sb'),
    ret: $('.ret'), banner: $('.banner'), hint: $('.hint'),
    title: $('.title'), pause: $('.pause'), victory: $('.end.victory'), defeat: $('.end.defeat'),
    slider: $('.pause .sl'),
  };

  // ---------------------------------------------------------------- textures (async; CSS falls back to invisible)
  const seals = {};
  const ready = buildTextures(root).then((r) => {
    Object.assign(seals, r.seals);
    $('.title .seal').src = seals.title;
    el.banner.querySelector('.seal').src = seals.sword;
    fillEnding(el.victory, VICTORY, seals.xia);
    fillEnding(el.defeat, DEFEAT, seals.fall);
  }).catch((e) => console.warn('[hud] textures failed', e));
  fillEnding(el.victory, VICTORY, null);
  fillEnding(el.defeat, DEFEAT, null);

  // ---------------------------------------------------------------- state
  const S = {
    state: 'boot', hp: 1, hpMax: 1, hpShow: 1, ghost: 1, ghostHold: 0, focus: 0, focusMax: 1, focusShow: 0, full: false,
    lock: null, bossId: null, bossHp: 1, bossGhost: 1, bossGhostHold: 0, bossPo: 0,
    waveBase: null, waveCount: 0, bannerT: 0, hintT: 0, hintShown: false,
    playTime: 0, kills: 0, perfect: 0, W: 1, H: 1, volume: 0.8,
  };
  try { const v = parseFloat(localStorage.getItem('wx.volume')); if (Number.isFinite(v)) S.volume = clamp01(v); } catch { /* storage blocked */ }
  el.slider.style.setProperty('--v', S.volume.toFixed(3));

  const measure = () => { S.W = root.clientWidth || innerWidth; S.H = root.clientHeight || innerHeight; };
  measure();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
  ro?.observe(root);

  // ---------------------------------------------------------------- projection
  const cam = app.camera;
  const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();
  const scr = { x: 0, y: 0, z: 0, ok: false };
  function project(p) {
    _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
    scr.z = -_v.z;
    if (scr.z < 0.2) { scr.ok = false; return scr; }
    _v.applyMatrix4(cam.projectionMatrix);
    scr.x = (_v.x * 0.5 + 0.5) * S.W;
    scr.y = (0.5 - _v.y * 0.5) * S.H;
    scr.ok = scr.x > -80 && scr.x < S.W + 80 && scr.y > -80 && scr.y < S.H + 80;
    return scr;
  }

  // ---------------------------------------------------------------- tracked enemies
  const tracks = new Map();
  function toGetter(src) {
    if (typeof src === 'function') return src;
    if (src && src.isObject3D) return (out) => src.getWorldPosition(out);
    if (src && src.isVector3) return (out) => out.copy(src);
    if (src && typeof src.x === 'number') return (out) => out.set(src.x, src.y ?? 0, src.z);
    return null;
  }
  function ensure(id) {
    let e = tracks.get(id);
    if (e) return e;
    const m = document.createElement('div');
    m.className = 'mk';
    m.innerHTML = '<div class="tr m"></div><div class="fl m"></div><div class="po m"></div><div class="x m"></div><div class="gl"></div><div class="wr">危</div><div class="bk">破</div>';
    el.marks.appendChild(m);
    e = {
      id, get: null, height: 1.8, anchor: 'feet', stats: null, actor: null, boss: false, name: '', sub: '', kind: '',
      el: m, wr: m.querySelector('.wr'), gl: m.querySelector('.gl'), bk: m.querySelector('.bk'),
      hp: 1, hpMax: 1, po: 0, poMax: 1, est: true, last: -99, dead: false, deadT: 0, on: false,
      tx: '', v: -1, p: -1, pos: new THREE.Vector3(), has: false,
    };
    tracks.set(id, e);
    return e;
  }
  function track(id, getWorldPos, o = {}) {
    const e = ensure(id);
    const g = toGetter(getWorldPos);
    if (g) e.get = g;
    if (o.height) e.height = o.height;
    if (o.anchor) e.anchor = o.anchor;
    if (o.stats) { e.stats = o.stats; e.est = false; }
    if (o.actor) { e.actor = o.actor; e.est = false; }
    if (o.name) e.name = o.name;
    if (o.sub) e.sub = o.sub;
    if (o.kind) e.kind = o.kind;
    if (o.boss) boss(id, o);
    return e;
  }
  function untrack(id) {
    const e = tracks.get(id);
    if (!e) return;
    e.el.remove();
    tracks.delete(id);
    if (S.lock === id) setLock(null);
    if (S.bossId === id) boss(null);
  }
  function setEnemy(id, v) {
    const e = ensure(id);
    if (v.hpMax ?? v.max) e.hpMax = v.hpMax ?? v.max;
    if (v.hp !== undefined) { if (v.hp < e.hp) e.last = S.now; e.hp = v.hp; }
    if (v.postureMax) e.poMax = v.postureMax;
    if (v.posture !== undefined) { if (v.posture > e.po + 1e-3) e.last = S.now; e.po = v.posture; }
    e.est = false;
  }
  // Live actor lookup for enemies announced only by bus events (their spawn payload carries a copy of the position).
  // opts.resolve(id) wins; otherwise the gameplay debug handle is consulted. The actor must expose pos (Vector3) and
  // hp/maxHp/posture/maxPosture, which gameplay's Enemy does.
  function resolveActor(id) {
    try {
      if (opts.resolve) return opts.resolve(id) ?? null;
      const list = window.__game?.game?.enemies;
      if (list) for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    } catch { /* optional */ }
    return null;
  }
  function attachActor(e, a) {
    if (!a || !a.pos?.isVector3) return false;
    e.actor = a; e.est = false;
    e.get = (out) => out.copy(a.pos);
    return true;
  }
  function anchorPos(e, out, up) {
    if (!e.get) { if (!e.has) return null; out.copy(e.pos); }
    else { const r = e.get(out); if (r && r !== out) out.copy(r); }
    out.y += e.anchor === 'head' ? up - e.height : up;
    return out;
  }

  // ---------------------------------------------------------------- boss bar
  function boss(id, o = {}) {
    if (id === null || id === undefined) {
      S.bossId = null;
      el.boss.classList.remove('on', 'danger');
      return;
    }
    const e = ensure(id);
    e.boss = true;
    const def = BOSS_NAMES[e.kind] || BOSS_NAMES.boss;
    e.name = o.name || e.name || def.name;
    e.sub = o.sub || e.sub || def.sub;
    S.bossId = id;
    el.bossName.textContent = e.name;
    el.bossSub.textContent = e.sub;
    S.bossHp = S.bossGhost = e.hpMax ? e.hp / e.hpMax : 1;
    el.boss.classList.add('on');
  }

  // ---------------------------------------------------------------- flourishes (pooled)
  const fx = [];
  for (let i = 0; i < FX_POOL; i++) { const d = document.createElement('div'); d.className = 'fx'; el.fxl.appendChild(d); fx.push({ el: d, busy: 0 }); }
  let fxI = 0;
  function spawnFx(cls, x, y, anim, dur, tf = '', bg = '') {
    const f = fx[fxI = (fxI + 1) % FX_POOL];
    const d = f.el;
    d.className = 'fx';
    d.style.left = `${x.toFixed(1)}px`; d.style.top = `${y.toFixed(1)}px`;
    d.style.setProperty('--tf', tf || 'rotate(0deg)');
    d.style.setProperty('--anim', `${anim} ${dur}s var(--ease-ink)`);
    d.style.backgroundImage = bg;
    void d.offsetWidth; // restart the animation
    d.className = `fx ${cls} go`;
    return d;
  }
  function screenOf(pos, fallbackX = 0.5, fallbackY = 0.45) {
    if (pos && typeof pos.x === 'number') {
      _q.set(pos.x, pos.y ?? 0, pos.z);
      const s = project(_q);
      if (s.ok) return s;
    }
    scr.x = S.W * fallbackX; scr.y = S.H * fallbackY; scr.ok = true;
    return scr;
  }
  function flourish(kind, pos, dir) {
    if (S.state !== 'playing' && S.state !== 'boot') return;
    const r = Math.random;
    if (kind === 'hit' || kind === 'kill') {
      const s = screenOf(pos);
      let ang = (r() - 0.5) * 50 - 20;
      if (dir && typeof dir.x === 'number') {          // orient the tick along the cut, projected to screen
        _q.set(pos.x + dir.x * 0.5, (pos.y ?? 0) + (dir.y ?? 0) * 0.5, pos.z + dir.z * 0.5);
        const x0 = s.x, y0 = s.y, s2 = project(_q);
        if (s2.ok) ang = Math.atan2(s2.y - y0, s2.x - x0) * 180 / Math.PI;
        s.x = x0; s.y = y0;
      }
      const k = Math.min(1.3, Math.max(0.55, 7 / Math.max(2, s.z || 7)));
      spawnFx('tick', s.x, s.y, 'wx-tick', 0.42, `rotate(${ang.toFixed(1)}deg) scale(${(k * 0.8).toFixed(2)})`);
      if (kind === 'kill') spawnFx(`splat${r() < 0.5 ? ' b' : ''}`, s.x, s.y, 'wx-splat', 1.1, `rotate(${(r() * 360) | 0}deg) scale(${(k * 0.9).toFixed(2)})`);
    } else if (kind === 'parry') {
      const s = screenOf(pos, 0.5, 0.42);
      spawnFx('enso', s.x, s.y, 'wx-ensofx', 0.75, `rotate(${(r() * 360) | 0}deg)`);
      if (seals.parry) spawnFx('sealfx', s.x + 70, s.y - 60, 'wx-sealfx', 1.1, '', `url("${seals.parry}")`).style.backgroundSize = '100% 100%';
    } else if (kind === 'block') {
      const s = screenOf(pos, 0.5, 0.42);
      spawnFx('tick', s.x, s.y, 'wx-tick', 0.3, `rotate(${((r() - 0.5) * 40 + 90) | 0}deg) scale(0.5)`);
    } else if (kind === 'hurt') {
      el.edge.classList.remove('hurt'); void el.edge.offsetWidth; el.edge.classList.add('hurt');
      el.health.classList.remove('hit'); void el.health.offsetWidth; el.health.classList.add('hit');
    } else if (kind === 'evade') {
      // a dry stroke whips past the lower frame: the blade missed
      spawnFx('tick evade', S.W * 0.5, S.H * 0.66, 'wx-tick', 0.55, `rotate(${(178 + (r() - 0.5) * 8).toFixed(1)}deg) scale(1.6, 0.8)`);
    } else if (kind === 'special') {
      el.qi.classList.remove('go'); void el.qi.offsetWidth; el.qi.classList.add('go');
    }
  }

  // ---------------------------------------------------------------- lock-on
  function setLock(id) {
    S.lock = id ?? null;
    el.ret.classList.toggle('on', S.lock !== null && tracks.has(S.lock));
    if (S.lock !== null) { const e = tracks.get(S.lock); if (e) e.last = S.now; }
  }

  // ---------------------------------------------------------------- banners
  let bannerTimer = 0;
  function banner(title, o = {}) {
    let no = o.no ?? '', tt = String(title ?? ''), en = o.en ?? '';
    if (tt.includes('·')) { const [a, b] = tt.split('·').map((s) => s.trim()); if (CJK.test(b)) { no = no || a; tt = b; } }
    if (!en) en = WAVE_EN[tt] || '';
    const b = el.banner;
    b.classList.remove('on', 'off', 'small', 'boss');
    if (o.boss) b.classList.add('boss');
    b.querySelector('.no').textContent = no;
    b.querySelector('.tt').textContent = tt;
    b.querySelector('.en').textContent = en;
    b.querySelector('.seal').style.display = o.seal === false ? 'none' : '';
    void b.offsetWidth;
    b.classList.add('on');
    S.bannerT = o.hold ?? 4.6;
    bannerTimer = 1;
    bus.emit('ui:sfx', { kind: 'brush' });
  }
  function waveBanner(p = {}) {
    // director indices are 1-based (wave 1 = 第一回); anything else falls back to counting banners
    const n = Number.isFinite(p.index) && p.index >= 1 ? p.index : ++S.waveCount;
    S.waveCount = n;
    let title = typeof p.title === 'string' ? p.title.trim() : '';
    let no = `第${numeral(Math.max(1, n))}回`, tt, en = typeof p.sub === 'string' ? p.sub : '';
    if (title.includes('·')) { const [a, b] = title.split('·').map((x) => x.trim()); if (CJK.test(a)) no = a; title = b; }
    if (title && CJK.test(title)) { tt = title; en = en || WAVE_EN[tt] || ''; }
    else { const d = p.boss ? BOSS_WAVE : WAVES[(Math.max(1, n) - 1) % WAVES.length]; tt = d.tt; en = en || title || d.en; }
    banner(tt, { no, en, boss: !!p.boss });
  }

  // ---------------------------------------------------------------- screens & state
  const screens = { title: el.title, paused: el.pause, victory: el.victory, defeat: el.defeat };
  function setState(st) {
    if (!st || st === S.state) return;
    const prev = S.state;
    S.state = st;
    S.stateT = S.now ?? 0;
    root.dataset.state = st;
    for (const [k, node] of Object.entries(screens)) {
      const on = k === st;
      if (on && !node.classList.contains('on')) { void node.offsetWidth; }
      node.classList.toggle('on', on);
    }
    if (st !== 'paused') el.pause.classList.remove('show-ctl');
    if (st === 'playing' && !S.hintShown) { S.hintShown = true; showHint(16); }
    if (st !== 'playing') el.hint.classList.remove('on');
    if (st === 'title') { S.waveBase = null; S.waveCount = 0; S.playTime = 0; S.kills = 0; S.perfect = 0; }
    if (st === 'victory') fillStats();
    if (st === 'title' || st === 'victory' || st === 'defeat') { setLock(null); boss(null); }
    if (st === 'paused' || prev === 'paused') bus.emit('ui:sfx', { kind: st === 'paused' ? 'open' : 'close' });
  }
  function fillStats() {
    const t = Math.round(S.playTime), mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, '0');
    el.victory.querySelector('.st').innerHTML =
      `<div><b>${mm}:${ss}</b><i>用时</i></div><div><b>${S.kills}</b><i>斩敌</i></div><div><b>${S.perfect}</b><i>识破</i></div>`;
  }
  function showHint(sec = 14) { el.hint.classList.add('on'); S.hintT = sec; }
  /** Back to a blank slate (arena reset / harness): forget enemies, clear banners and screens, full health. */
  function reset() {
    for (const id of [...tracks.keys()]) untrack(id);
    setLock(null); boss(null);
    Object.assign(S, { hp: 1, hpShow: 1, ghost: 1, ghostHold: 0, focus: 0, focusShow: 0, full: false, waveBase: null, waveCount: 0,
      bannerT: 0, hintT: 0, hintShown: false, playTime: 0, kills: 0, perfect: 0, state: 'boot' });
    for (const k in cache) cache[k] = -1;
    bannerTimer = 0;
    el.banner.classList.remove('on', 'off', 'boss');
    el.hint.classList.remove('on');
    el.focus.classList.remove('full', 'fill');
    el.health.classList.remove('low', 'hit');
    el.edge.classList.remove('low', 'hurt');
    el.boss.classList.remove('on', 'danger', 'broken', 'phase');
    for (const node of Object.values(screens)) node.classList.remove('on', 'show-ctl');
    root.dataset.state = 'boot';
  }

  // ---------------------------------------------------------------- input on screens
  const emitOnce = (() => { let last = 0; return (type, p) => { const n = performance.now(); if (n - last < 350) return; last = n; bus.emit(type, p); }; })();
  // If nothing answers ui:resume (gameplay toggles pause on Esc), press Esc for the player so the menu never traps them.
  let resumeTimer = 0;
  function resumeFallback() {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (S.state !== 'paused') return;
      for (const type of ['keydown', 'keyup']) dispatchEvent(new KeyboardEvent(type, { code: 'Escape', key: 'Escape', bubbles: true }));
    }, 160);
  }
  function onPointerDown(ev) {
    if (S.state === 'title') { emitOnce('ui:start', {}); bus.emit('ui:sfx', { kind: 'seal' }); return; }
    if ((S.state === 'victory' || S.state === 'defeat') && S.now - S.stateT > 5) { emitOnce('ui:restart', {}); bus.emit('ui:sfx', { kind: 'seal' }); return; }
    const act = ev.target?.closest?.('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'resume') { emitOnce('ui:resume', {}); bus.emit('ui:sfx', { kind: 'tick' }); resumeFallback(); }
    else if (act === 'restart') { emitOnce('ui:restart', {}); bus.emit('ui:sfx', { kind: 'seal' }); resumeFallback(); }
    else if (act === 'controls') { el.pause.classList.toggle('show-ctl'); bus.emit('ui:sfx', { kind: 'brush' }); }
  }
  function onKey(ev) {
    if (S.state === 'title' && (ev.code === 'Enter' || ev.code === 'Space')) emitOnce('ui:start', {});
    else if ((S.state === 'victory' || S.state === 'defeat') && ev.code === 'Enter') emitOnce('ui:restart', {});
    else if (S.state === 'paused' && ev.code === 'Escape' && el.pause.classList.contains('show-ctl')) el.pause.classList.remove('show-ctl');
  }
  addEventListener('pointerdown', onPointerDown, true);
  addEventListener('keydown', onKey);
  root.addEventListener('pointerover', (ev) => { if (ev.target?.closest?.('button')) bus.emit('ui:sfx', { kind: 'hover' }); });

  // volume slider (brush stroke)
  let drag = false;
  const setVol = (clientX) => {
    const r = el.slider.getBoundingClientRect();
    S.volume = clamp01((clientX - r.left - r.width * 0.03) / (r.width * 0.94));
    el.slider.style.setProperty('--v', (S.volume * 0.94 + 0.03).toFixed(3));
    bus.emit('ui:volume', { value: S.volume });
    try { localStorage.setItem('wx.volume', S.volume.toFixed(3)); } catch { /* ignore */ }
  };
  el.slider.addEventListener('pointerdown', (e) => { drag = true; el.slider.setPointerCapture?.(e.pointerId); setVol(e.clientX); });
  el.slider.addEventListener('pointermove', (e) => { if (drag) setVol(e.clientX); });
  el.slider.addEventListener('pointerup', () => { drag = false; });
  el.slider.style.setProperty('--v', (S.volume * 0.94 + 0.03).toFixed(3));

  // graphics quality (流畅 / 均衡 / 极致): the scene applies it (core/quality.js) and answers with 'quality'
  const qualEl = root.querySelector('.pause .qual');
  const markQ = (name) => qualEl?.querySelectorAll('.qo').forEach((o) => o.classList.toggle('on', o.dataset.q === name));
  qualEl?.addEventListener('click', (e) => {
    const q = e.target?.closest?.('.qo')?.dataset.q;
    if (!q) return;
    bus.emit('ui:quality', { name: q }); bus.emit('ui:sfx', { kind: 'tick' }); markQ(q);
  });
  try { markQ(localStorage.getItem('wx.quality') || 'med'); } catch { markQ('med'); }
  bus.on('quality', (p) => markQ(p?.name));   // (the `on` helper is declared further down)

  // ---------------------------------------------------------------- player values
  function setPlayer({ hp, max, focus, focusMax } = {}) {
    if (max) S.hpMax = max;
    if (hp !== undefined) {
      const v = clamp01(hp / S.hpMax);
      if (v < S.hp - 1e-4) S.ghostHold = 0.7; else if (v > S.ghost) S.ghost = v;
      S.hp = v;
    }
    if (focusMax) S.focusMax = focusMax;
    if (focus !== undefined) S.focus = clamp01(focus / S.focusMax);
  }

  // ---------------------------------------------------------------- bus
  const offs = [];
  const on = (type, fn) => offs.push(bus.on(type, fn));
  const autoplay = () => { if (S.state === 'boot') setState('playing'); };
  on('game:state', (p) => setState(p.state));
  on('wave:start', (p) => { autoplay(); waveBanner(p); });
  on('wave:clear', (p) => { if (!p?.final) banner('风定', { no: '', en: 'The field falls still', seal: false, hold: 2.6 }); });
  on('player:hp', (p) => { autoplay(); setPlayer({ hp: p.hp, max: p.max }); });
  on('player:focus', (p) => { autoplay(); setPlayer({ focus: p.value, focusMax: p.max }); });
  on('player:hurt', (p) => flourish('hurt', p.pos, p.dir));
  on('player:parry', (p) => { if (p.perfect) { S.perfect++; flourish('parry', p.pos); } else flourish('block', p.pos); });
  on('special', (p) => flourish('special', p.pos, p.dir));
  on('lockon', (p) => setLock(p?.id ?? null));
  on('enemy:spawn', (p) => {
    const e = ensure(p.id);
    if (e.dead) {                                          // pooled enemy back from the dead: fresh mark
      e.dead = false; e.deadT = 0; e.hp = e.hpMax; e.po = 0; e.v = e.p = -1; e.on = false;
      e.el.classList.remove('dead', 'on');
    }
    e.kind = p.kind || e.kind;
    if (!e.actor) attachActor(e, resolveActor(p.id));
    if (!e.get && p.pos) {
      if (p.pos.isVector3) e.get = toGetter(p.pos);        // a live reference keeps the mark attached
      else { e.pos.set(p.pos.x, p.pos.y ?? 0, p.pos.z); e.has = true; }
    }
    if (p.hp) { e.hp = p.hp; e.hpMax = p.hpMax ?? p.hp; }
    if (p.kind === 'bandit_heavy') e.height = 1.95;
    if (p.boss || p.kind === 'swordmaster' || p.kind === 'assassin' || p.kind === 'boss') boss(p.id, p);
  });
  on('boss', (p) => boss(p?.id ?? null, p || {}));
  on('enemy:state', (p) => setEnemy(p.id, p));
  on('enemy:hit', (p) => {
    const e = ensure(p.id);
    if (!e.actor) attachActor(e, resolveActor(p.id));
    if (p.pos && !e.get) { e.pos.set(p.pos.x, (p.pos.y ?? 0) - 1.2, p.pos.z); e.has = true; }
    if (Number.isFinite(p.hp) && Number.isFinite(p.max) && !e.actor && !e.stats) { e.hpMax = p.max; e.hp = p.hp; e.est = false; }
    if (e.est) {                                           // no authoritative values: estimate from damage
      e.hp = Math.max(0, e.hp - (p.damage ?? 10) / (e.hpMax > 1 ? 1 : 100));
      e.po = Math.min(e.poMax, e.po + (p.damage ?? 10) * 0.006 * e.poMax);
    }
    e.last = S.now;
    flourish(p.kill ? 'kill' : 'hit', p.pos, p.dir);
  });
  on('enemy:parried', (p) => {
    const e = ensure(p.id);
    if (e.est) e.po = Math.min(e.poMax, e.po + 0.25 * e.poMax);
    e.last = S.now;
    e.gl.classList.remove('go'); void e.gl.offsetWidth; e.gl.classList.add('go');
  });
  on('enemy:telegraph', (p) => {
    const e = tracks.get(p.id);
    if (!e) return;
    e.last = S.now;
    const n = p.unblockable ? e.wr : e.gl;
    n.classList.remove('go'); void n.offsetWidth; n.classList.add('go');
    if (p.unblockable && S.bossId === p.id) { el.boss.classList.add('danger'); setTimeout(() => el.boss.classList.remove('danger'), 900); }
  });
  on('enemy:posture', (p) => {
    if (p.broken === false) return;
    const e = tracks.get(p.id);
    if (e) {
      e.last = S.now;
      e.bk.classList.remove('go'); void e.bk.offsetWidth; e.bk.classList.add('go');
      e.gl.classList.remove('go'); void e.gl.offsetWidth; e.gl.classList.add('go');
    }
    if (S.bossId === p.id) { el.boss.classList.remove('broken'); void el.boss.offsetWidth; el.boss.classList.add('broken'); }
  });
  on('enemy:phase', (p) => {
    if (S.bossId !== p.id) return;
    el.boss.classList.remove('phase'); void el.boss.offsetWidth; el.boss.classList.add('phase');
  });
  on('player:evade', () => flourish('evade'));
  // combo counter (gameplay emits player:combo {n}; 0 = chain broken)
  const combo = document.createElement('div');
  combo.className = 'combo';
  combo.innerHTML = '<span class="n"></span><span class="l">连斩</span>';
  root.appendChild(combo);
  let comboFade = 0;
  on('player:combo', (p) => {
    const n = p?.n ?? 0;
    if (n < 2) { if (n === 0) comboFade = Math.min(comboFade, 0.4); return; }
    combo.querySelector('.n').textContent = n;
    combo.style.setProperty('--c', Math.min(n, 30));
    combo.classList.add('on');
    combo.classList.toggle('hot', n >= 10);
    combo.classList.remove('pop'); void combo.offsetWidth; combo.classList.add('pop');
    comboFade = 2.2;
  });
  on('enemy:death', (p) => {
    S.kills++;
    const e = tracks.get(p.id);
    if (!e) return;
    e.dead = true; e.deadT = 0; e.hp = 0;
    e.el.classList.add('dead', 'on');
    if (S.lock === p.id) setLock(null);
    if (S.bossId === p.id) setTimeout(() => { if (S.bossId === p.id) boss(null); }, 2200);
  });

  // ---------------------------------------------------------------- per-frame
  S.now = 0;
  const setVar = (node, name, v, cacheObj, key) => {
    if (Math.abs(cacheObj[key] - v) < 0.002) return;
    cacheObj[key] = v;
    node.style.setProperty(name, v.toFixed(3));
  };
  const cache = { hp: -1, gh: -1, f: -1, bhp: -1, bgh: -1, bpo: -1, low: -1 };
  const reorder = () => { app.remove(sys); app.add(sys); };

  function update(dt, t, _app, rawDt = dt) {
    if (comboFade > 0) { comboFade -= rawDt; if (comboFade <= 0) combo.classList.remove('on'); }
    const d = Math.min(rawDt ?? dt, 0.1);
    S.now += d; S.dt = d;
    if (S.state === 'playing') S.playTime += d;
    queueMicrotask(reorder); // keep the HUD last so marks project with this frame's final camera
    // hint / banner timers
    if (S.hintT > 0 && (S.hintT -= d) <= 0) el.hint.classList.remove('on');
    if (bannerTimer && (S.bannerT -= d) <= 0) { bannerTimer = 0; el.banner.classList.add('off'); }
    // player health: fill eases, ghost holds then drains
    S.hpShow += (S.hp - S.hpShow) * lerpK(14, d);
    if (S.ghostHold > 0) S.ghostHold -= d; else S.ghost += (S.hpShow - S.ghost) * lerpK(3.2, d);
    if (S.ghost < S.hpShow) S.ghost = S.hpShow;
    setVar(el.health, '--v', S.hpShow, cache, 'hp');
    setVar(el.health, '--gh', S.ghost, cache, 'gh');
    const low = S.hp < 0.3 && S.hp > 0;
    el.health.classList.toggle('low', low);
    el.edge.classList.toggle('low', low);
    setVar(el.edge, '--low', low ? 1 - S.hp / 0.3 : 0, cache, 'low');
    // focus
    S.focusShow += (S.focus - S.focusShow) * lerpK(8, d);
    setVar(el.focus, '--f', S.focusShow, cache, 'f');
    const full = S.focus >= 0.999;
    if (full !== S.full) {
      S.full = full;
      el.focus.classList.toggle('full', full);
      if (full) { el.focus.classList.remove('fill'); void el.focus.offsetWidth; el.focus.classList.add('fill'); bus.emit('ui:sfx', { kind: 'focus' }); }
    }
  }

  function lateUpdate() {
    cam.updateMatrixWorld();
    const now = S.now, dt = S.dt || 0.016;
    let lockShown = false;
    for (const e of tracks.values()) {
      let gone = false;
      if (e.actor) {
        const a = e.actor;
        if (a.hp < e.hp - 1e-3 || a.posture > e.po + 1e-3) e.last = now;
        e.hp = a.hp; e.hpMax = a.maxHp || e.hpMax; e.po = a.posture; e.poMax = a.maxPosture || e.poMax;
        gone = a.active === false;                        // returned to the pool (arena reset): hide, then forget
        if (gone && !e.dead) { e.dead = true; e.deadT = 1.6; }
      } else if (e.stats) { const s = e.stats(); if (s) setEnemy(e.id, s); }
      const v = e.hpMax > 0 ? clamp01(e.hp / e.hpMax) : 0, p = e.poMax > 0 ? clamp01(e.po / e.poMax) : 0;
      if (e.est && !e.dead) e.po = Math.max(0, e.po - e.poMax * 0.05 * (now - e.last > 2 ? 1 : 0) * dt); // estimated posture recovers
      if (e.dead) { e.deadT += dt; if (e.deadT > 2.4) { untrack(e.id); continue; } }
      const pos = anchorPos(e, _p, e.height + 0.34);
      let show = false;
      if (pos) {
        const s = project(pos);
        const engaged = e.dead || S.lock === e.id || now - e.last < MARK_LINGER || p > 0.04;
        show = s.ok && s.z < MARK_RANGE && engaged && !e.boss && !gone && S.state === 'playing';
        if (s.ok) {
          const k = Math.min(1.15, Math.max(0.6, 7.5 / s.z));
          const tx = `translate3d(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px,0) scale(${k.toFixed(3)})`;
          if (tx !== e.tx) { e.tx = tx; e.el.style.transform = tx; }
        }
        if (S.lock === e.id && !e.dead) {
          const rp = anchorPos(e, _p, e.height * 0.62);
          const r = rp && project(rp);
          if (r && r.ok) {
            lockShown = true;
            el.ret.style.transform = `translate3d(${r.x.toFixed(1)}px,${r.y.toFixed(1)}px,0) scale(${Math.min(1.2, Math.max(0.7, 8 / r.z)).toFixed(3)})`;
          }
        }
      }
      if (show !== e.on) { e.on = show; e.el.classList.toggle('on', show); }
      if (Math.abs(e.v - v) > 0.002) { e.v = v; e.el.style.setProperty('--v', (v * 0.92 + 0.04).toFixed(3)); }
      if (Math.abs(e.p - p) > 0.002) { e.p = p; e.el.style.setProperty('--p', p.toFixed(3)); }
      if (e.boss && e.id === S.bossId) {
        if (v < S.bossHp - 1e-4) S.bossGhostHold = 0.8;
        S.bossHp += (v - S.bossHp) * lerpK(12, dt);
        S.bossPo += (p - S.bossPo) * lerpK(10, dt);
      }
    }
    el.ret.classList.toggle('on', lockShown && S.state === 'playing');
    if (S.bossId !== null) {
      if (S.bossGhostHold > 0) S.bossGhostHold -= dt; else S.bossGhost += (S.bossHp - S.bossGhost) * lerpK(2.8, dt);
      if (S.bossGhost < S.bossHp) S.bossGhost = S.bossHp;
      setVar(el.boss, '--v', S.bossHp, cache, 'bhp');
      setVar(el.boss, '--gh', S.bossGhost, cache, 'bgh');
      setVar(el.boss, '--p', S.bossPo, cache, 'bpo');
    }
  }

  const sys = {
    update, lateUpdate, el: root, ready,
    track, untrack, setEnemy, boss, setState, banner, setPlayer, flourish, showHint, reset,
    get state() { return S.state; },
    get volume() { return S.volume; },
    stats: () => ({ tracks: tracks.size, state: S.state, kills: S.kills, perfect: S.perfect, playTime: +S.playTime.toFixed(1) }),
    dispose() {
      offs.forEach((f) => f());
      removeEventListener('pointerdown', onPointerDown, true);
      removeEventListener('keydown', onKey);
      ro?.disconnect();
      app.remove(sys);
      root.remove();
    },
  };
  app.add(sys);
  return sys;
}

export { esc };
