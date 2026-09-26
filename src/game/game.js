// Gameplay composition: createGame(app, { env, grass, vfx, hud, audio, interaction }) → { update(dt), ... }.
// Owner: gameplay (P). Used by scenes/full.js and scenes/combat.js.
//
// Self-registers with app.add (once per frame even if a caller also invokes game.update). Per frame:
//   input → autopilot (?demo) → director → player.think / AI think → integrate → actor separation → pose (animator,
//   secondary motion, blade samples) → combat sweeps + feedback → steps/trample, grass actors, shadow focus →
//   lateUpdate: slow-mo pulses (real dt) → camera (real dt).
// Characters for every wave are created up front (pooled, precompiled with the scene) so the first fight never
// hitches. Optional deps (env, vfx, interaction, hud, audio) are null-guarded; if no interaction module is given the
// grass actor slots in G.uActors are written directly.
import * as THREE from 'three';
import { createCharacter } from '../character/character.js';
import { bus } from '../core/bus.js';
import { G, WORLD, SUN_DIR, MAX_ACTORS } from '../core/globals.js';
import { Input } from './input.js';
import { CombatCamera } from './camera.js';
import { Player, PLAYER } from './player.js';
import { Enemy, KINDS } from './enemy.js';
import { Coordinator, think, assignSlots, onPlayerAttack } from './ai.js';
import { Combat } from './combat.js';
import { Director, WAVES } from './director.js';
import { Autopilot } from './autopilot.js';
import { makeRng, yawOf, clamp, wrapAngle } from './util.js';

// Enemy pool: as many of each kind as the level's busiest wave needs (+1 for kinds that recur while corpses sink)
function levelPool(waves) {
  // corpses of the previous wave may still be lying there (they sink after 7 s): one spare per kind that recurs
  const counts = waves.map((W) => { const c = {}; for (const k of W.enemies) c[k] = (c[k] ?? 0) + 1; return c; });
  const pool = {};
  counts.forEach((c, i) => {
    const prev = counts[i - 1] ?? {};
    for (const k of new Set([...Object.keys(c), ...Object.keys(prev)])) pool[k] = Math.max(pool[k] ?? 0, (c[k] ?? 0) + Math.min(prev[k] ?? 0, 1));
  });
  return pool;
}
const POOL = levelPool(WAVES);
const DEFAULT_LAYOUT = { arenaRadius: 150, playerSpawn: { x: 0, z: 18, yaw: Math.PI } };
const _v = new THREE.Vector3(), _f = new THREE.Vector3();

export async function createGame(app, deps = {}) {
  const game = new Game(app, deps);
  await game.init();
  return game;
}

export class Game {
  constructor(app, deps) {
    this.app = app;
    this.env = deps.env ?? null;
    this.vfx = deps.vfx ?? null;
    this.interaction = deps.interaction ?? null;
    this.hud = deps.hud ?? null;
    this.audio = deps.audio ?? null;
    this.grass = deps.grass ?? null;
    this.params = app.params ?? new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    // test hooks (node soak test): character factory + animator class can be injected
    this.makeCharacter = deps.createCharacter ?? createCharacter;
    this.AnimatorClass = deps.AnimatorClass ?? null;
    this.heightAt = (x, z) => app.world.heightAt(x, z);
    this.rng = makeRng(WORLD.seed + 4242);
    this.frame = 0; this.time = 0; this._lastFrame = -1;
    this.enemies = [];          // every pooled enemy (active or not)
    this.pool = {};
    this.state = 'title';
    this.paused = false;
    this.events = [];
    this.letterboxT = 0;
    this.quickStart = false;
    this.idleT = 0;
  }

  log(type, ...rest) {
    const line = `${this.time.toFixed(2)} ${type} ${rest.join(' ')}`.trim();
    this.events.push(line);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    if (this.params.has('verbose') || this.params.has('demo')) console.log('[game]', line);
  }

  async init() {
    const app = this.app;
    // layout (world owner) is optional: fall back to the bible anchors
    try { this.layout = (await import('../world/layout.js')).LAYOUT ?? DEFAULT_LAYOUT; } catch { this.layout = DEFAULT_LAYOUT; }
    this.arenaR = this.layout.arenaRadius ?? DEFAULT_LAYOUT.arenaRadius;
    this.input = new Input(app.renderer.domElement);
    this.camera = new CombatCamera(app, { heightAt: this.heightAt, colliders: app.world.colliders });
    this.coordinator = new Coordinator({ maxAttackers: 2 });
    // record mode (for trailers): H hides the HUD, O a slow orbit around the hero, T slow motion (×0.35); ?hud=0
    const hud = document.getElementById('hud');
    if (hud && this.params.get('hud') === '0') hud.style.visibility = 'hidden';
    addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'KeyH' && hud) hud.style.visibility = hud.style.visibility === 'hidden' ? '' : 'hidden';
      else if (e.code === 'KeyO') this.camera.toggleOrbit();
      else if (e.code === 'KeyT') app.time.userScale = app.time.userScale < 1 ? 1 : 0.35;
    });
    this.combat = new Combat(this);

    // characters: hero + pooled enemies, created in parallel
    const jobs = [this.makeCharacter({ kind: 'hero', seed: 1 })];
    const kinds = [];
    let seed = 11;
    for (const [kind, n] of Object.entries(POOL)) for (let i = 0; i < n; i++) { kinds.push(kind); jobs.push(this.makeCharacter({ kind, seed: seed++ })); }
    const chars = await Promise.all(jobs);
    this.player = new Player(this, chars[0]);
    app.scene.add(this.player.group);
    kinds.forEach((kind, i) => {
      const e = new Enemy(this, chars[i + 1], kind, i + 1);
      (this.pool[kind] ??= []).push(e);
      this.enemies.push(e);
      app.scene.add(e.group);
      // parked under the ground but VISIBLE until app.ready() has precompiled their programs
      e.place(i * 0.6, 0, 0);
      e.group.position.y -= 60;
      e.group.updateMatrixWorld(true);
    });
    this._hidePoolWhenReady = true;

    const sp = this.layout.playerSpawn ?? DEFAULT_LAYOUT.playerSpawn;
    this.spawn = { x: sp.x, z: sp.z, yaw: sp.yaw ?? Math.PI };
    this.player.place(this.spawn.x, this.spawn.z, this.spawn.yaw);
    this.player.setDrawn(false);

    this.director = new Director(this);
    const demo = this.params.has('demo');
    if (demo) this.autopilot = new Autopilot(this);

    // bus → AI reactions + log
    this._off = [
      bus.on('player:attack', () => { for (const e of this.enemies) onPlayerAttack(e, this.player, this.rng); }),
      bus.on('player:death', () => { this.log('player death'); this.director.onPlayerDeath(); }),
      // HUD screens (U): title click, pause-menu resume, restart from the end screens
      bus.on('ui:start', () => { if (this.state === 'title' && !this.autopilot) { this.director.begin(0); this.input.requestLock(); } }),
      bus.on('ui:resume', () => { if (this.paused) this.setPaused(false); }),
      bus.on('ui:restart', () => this.director.requestRestart()),
    ];
    this.input.onUnlock = () => { if (this.state === 'playing' && !this.params.has('harness')) this.setPaused(true); };

    // start state (URL): ?state=title|playing, ?wave=N (1-based) jumps straight into a wave, ?demo autostarts
    const wave = parseInt(this.params.get('wave') ?? '', 10);
    const startState = this.params.get('state') ?? (demo || Number.isFinite(wave) ? 'playing' : 'title');
    this.director.toTitle();
    if (startState === 'playing') {
      this.quickStart = this.params.has('nointro');
      this.director.begin(Number.isFinite(wave) ? clamp(wave - 1, 0, WAVES.length - 1) : 0);
      this.director.t = 0.9;
      this.player.setDrawn(true);
      this.camera.setMode('follow', { heading: this.camera.sunHeading, force: true });
    }
    this.camera.snap();
    bus.emit('player:hp', { hp: this.player.hp, max: this.player.maxHp });
    bus.emit('player:focus', { value: this.player.focus, max: PLAYER.focusMax });

    this._sys = { update: (dt, t, a, raw) => this._tick(dt, raw ?? dt), lateUpdate: (dt, t, a, raw) => this._late(dt, raw ?? dt) };
    app.add(this._sys);
    this.exposeDebug();
    return this;
  }

  /** Contract entry point. The game is self-registered, so this only ticks if nothing ticked this frame. */
  update(dt) { if (G.uFrame.value !== this._lastFrame) this._tick(dt, dt); }

  // ------------------------------------------------------------------------------------------ helpers
  /** Static colliders in 8 m cells (rebuilt when the list grows: a bamboo grove adds hundreds). */
  _colGrid() {
    const cs = this.app.world.colliders;
    if (!cs) return null;
    if (this._cg && this._cgN === cs.length) return this._cg;
    const cell = new Map(), C = 8;
    for (const c of cs) {
      const r = (c.r ?? 1) + 0.7;
      for (let gz = Math.floor((c.z - r) / C); gz <= Math.floor((c.z + r) / C); gz++)
        for (let gx = Math.floor((c.x - r) / C); gx <= Math.floor((c.x + r) / C); gx++) {
          const k = gx * 73856093 ^ gz * 19349663; let l = cell.get(k); if (!l) cell.set(k, l = []); l.push(c);
        }
    }
    this._cg = cell; this._cgN = cs.length;
    return cell;
  }
  collideStatic(pos, r) {
    const grid = this._colGrid();
    const l = grid?.get(Math.floor(pos.x / 8) * 73856093 ^ Math.floor(pos.z / 8) * 19349663);
    if (l) for (let i = 0; i < l.length; i++) {
      const c = l[i];
      const dx = pos.x - c.x, dz = pos.z - c.z, R = (c.r ?? 1) + r;
      const d2 = dx * dx + dz * dz;
      if (d2 < R * R && d2 > 1e-8) { const d = Math.sqrt(d2), k = (R - d) / d; pos.x += dx * k; pos.z += dz * k; }
    }
    // soft playable boundary
    const rr = Math.hypot(pos.x, pos.z), R = this.arenaR;
    if (rr > R) { const k = 1 - Math.min(1, (rr - R) * 0.08) * 0.1; pos.x *= k; pos.z *= k; if (rr > R + 12) { pos.x *= (R + 12) / rr; pos.z *= (R + 12) / rr; } }
  }
  clampToArena(x, z, margin = 0) {
    const r = Math.hypot(x, z), R = this.arenaR - margin;
    if (r > R) { x *= R / r; z *= R / r; }
    return { x, z };
  }

  spawnEnemy(kind, x, z, yaw, { name, sub } = {}) {
    const list = this.pool[kind] ?? this.pool.bandit;
    let e = list.find((o) => !o.active) ?? list.find((o) => !o.alive);
    if (!e) { console.warn('[game] pool exhausted for', kind); return null; }
    if (e.active) e.despawn();
    e.nameOverride = name ? { name, sub } : null;   // a level may give its boss another name (levels/*.js wave.name)
    e.spawn(x, z, yaw);
    this.log('spawn', e.id);
    return e;
  }

  resetArena() {
    for (const e of this.enemies) if (e.active) e.despawn();
    this.coordinator.reset();
    this.combat.clearTime();
    this.combat.qi.length = 0;
    const P = this.player;
    P.place(this.spawn.x, this.spawn.z, this.spawn.yaw);
    P.revive();
    P.lockOn(null);
    this.app.pipeline?.fx?.setDamage?.(0);
  }

  setPaused(on) {
    if (this.paused === on) return;
    if (on && this.state !== 'playing') return;
    this.paused = on;
    this.combat.paused = on;
    this.input.clear();
    this.director.setGameState(on ? 'paused' : 'playing');
    if (on) this.input.exitLock(); else this.input.requestLock();
  }

  // ------------------------------------------------------------------------------------------ frame
  _tick(dt, rawDt) {
    if (G.uFrame.value === this._lastFrame) return;
    this._lastFrame = G.uFrame.value;
    const input = this.input;
    if (this._hidePoolWhenReady && (typeof window === 'undefined' || window.__ready === true)) {
      this._hidePoolWhenReady = false;
      for (const e of this.enemies) if (!e.active) e.ch.setVisible(false);
    }
    this.autopilot?.update(dt, rawDt);
    input.update(rawDt);
    const swallowed = this._meta(input);
    if (this.paused) return;
    this.frame++;
    this.time += dt;
    const P = this.player;

    this.director.update(dt);

    // --- decisions
    const ds = this.director.state;
    P.controlEnabled = !swallowed && this.state === 'playing' && ds !== 'defeat' && ds !== 'defeatWait';
    // any real input during the intro shot hands the camera back
    // (human input only: the demo autopilot waits for the shot to finish)
    if (this.camera.mode === 'intro' && input.idle < 0.05 && (input.move.lengthSq() > 0.05 || input.look.lengthSq() > 1e-5 || input.b.light.pressed || input.b.dodge.pressed)) {
      this.camera.setMode('follow', { heading: this.camera.sunHeading, blend: 2.5 });
      this.letterboxT = Math.min(this.letterboxT, 0.01);
    }
    if (input.b.lock.pressed && P.alive && this.state === 'playing') P.toggleLock();
    if (P.lock && (!P.lock.alive || P.distTo(P.lock) > 32)) P.lockOn(P.alive ? P.bestLockCandidate(P.lock) : null);
    let near = false;
    for (const e of this.enemies) if (e.alive && e.active && e.distTo(P) < 14) { near = true; break; }
    P.inCombat = near;
    if (near && !P.drawn && P.state === 'loco' && this.state === 'playing') P.startDraw(null);
    P.think(dt, input);

    // ring slots are centred on the SUN side of the hero (70 %) nudged toward the view (30 %): the pack circles
    // into the light, so a locked-on camera shoots contre-jour and the bandits read as silhouettes (bible §1.3)
    const sunH = this.camera.sunHeading;
    assignSlots(this.enemies, sunH + wrapAngle(this.camera.heading - sunH) * 0.1);
    const ctx = this._ctx ??= { player: P, rng: this.rng, now: 0, coordinator: this.coordinator, onPhase: (e, n) => this._phase(e, n) };
    ctx.now = this.time;
    for (const e of this.enemies) if (e.active) think(e, dt, ctx);
    // head/spine aim (animator look-at layer): the hero watches his lock or swing target, bandits watch the hero
    P.lookTarget = P.lock?.alive ? P.lock : P.attackTarget?.alive && P.state === 'attack' ? P.attackTarget : null;
    for (const e of this.enemies) if (e.active) e.lookTarget = e.alive && P.alive && e.distTo(P) < 30 ? P : null;

    // --- physics
    P.integrate(dt);
    for (const e of this.enemies) if (e.active) e.integrate(dt);
    this._separate();

    // --- pose + events
    this._handleEvents(P, P.pose(dt, this.time));
    for (const e of this.enemies) {
      if (!e.active) continue;
      // far actors skip secondary motion every other frame (bible §8.3.16)
      const far = e.distTo(P) > 30;
      if (far && (this.frame & 1)) { e.syncGroup(); continue; }
      this._handleEvents(e, e.pose(far ? dt * 2 : dt, this.time));
    }

    // --- combat
    this.combat.update(dt, rawDt);

    // --- HUD: authoritative enemy hp/posture whenever they changed noticeably
    for (const e of this.enemies) {
      if (!e.active) continue;
      if (Math.abs(e.hp - (e._stateHp ?? -1)) > 0.5 || Math.abs(e.posture - (e._statePo ?? -1)) > e.maxPosture * 0.02) e.emitState();
    }

    // --- world coupling: grass actors, shadow focus, low-health look
    this._writeActors();
    try { this.env?.setShadowFocus?.(P.pos); } catch { /* optional */ }
    const low = P.alive ? clamp(1 - P.hp / (P.maxHp * 0.4), 0, 1) : 1;
    this.app.pipeline?.fx?.setDamage?.(low * 0.8);
    this.idleT = (input.idle > 10 && !near && this.state === 'playing') ? this.idleT + dt : 0;
  }

  _late(dt, rawDt) {
    this.combat.updateTime(rawDt);
    const P = this.player;
    const c = this._camCtx ??= { player: P, enemies: this.enemies, lock: null, input: null, sprinting: false, idleCine: false };
    c.lock = P.lock?.alive ? P.lock : null;
    c.input = this.paused ? null : this.input;
    c.sprinting = P.sprinting;
    // sun-seeking drift when idle and alone, and in the quiet after a wave is cleared (once the kill shot ends)
    c.idleCine = this.idleT > 0 || (this.director.state === 'clear' && this.camera.mode === 'follow' && !P.lock);
    this.camera.update(rawDt, c);
    this.input.endFrame();
  }

  /** Menu-level input: start, pause, restart, pointer lock. Returns true if it swallowed this frame's input. */
  _meta(input) {
    const b = input.b;
    if (this.state === 'title') {
      if (!this.autopilot && (b.start.pressed || b.light.pressed || b.dodge.pressed)) { this.director.begin(0); input.requestLock(); input.clear(); return true; }
      return true;
    }
    if (b.pause.pressed) { this.setPaused(!this.paused); return true; }
    if (this.paused && (b.light.pressed || b.start.pressed)) { this.setPaused(false); return true; }
    if (this.state === 'playing' && b.light.pressed && !input.locked && !this.autopilot && !this.params.has('harness')) {
      input.requestLock();
      if (!this._lockedOnce) { this._lockedOnce = true; return true; } // the first click only captures the mouse
    }
    return false;
  }

  _phase(e, n) {
    const W = WAVES[this.director.wave];
    if (n === 2 && W?.windPhase2) this.director.wind(W.windPhase2, 3);
    this.combat.slowmo(0.5, 0.25);
    this.camera.shake(0.3);
    if (n === 2) {
      // the master steps back out of the fight, the wind spikes, a close shot while he takes his second stance
      e.strike = null; e.chain = null; this.coordinator?.release(e);
      const P = this.player, dx = e.pos.x - P.pos.x, dz = e.pos.z - P.pos.z, d = Math.hypot(dx, dz) || 1;
      e.applyKnock(dx / d, dz / d, 5);
      e.state = 'taunt'; e.play('bossFlourish', { fade: 0.15 });   // the blade whirled round him: the second stance
      this.camera.setMode('kill', { victim: e.pos.clone(), duration: 2.2, blend: 1.6 });
      this.app.pipeline?.fx?.letterbox?.(true); this.letterboxT = 2.4;
      this.combat.slowmo(0.35, 0.6, 0.05, 0.5);
      this.combat.kick({ exposure: 0.25, ca: 0.02, ms: 200 });
      this.director.mood('ember', 4);
    }
    bus.emit('enemy:phase', { id: e.id, phase: n });
    this.log('boss phase', n);
  }

  _separate() {
    const list = this._all ??= [this.player, ...this.enemies];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.active || (!a.alive && a !== this.player)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.active || !b.alive) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const R = (a.radius + b.radius) * 0.95;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R || d2 < 1e-8) continue;
        const d = Math.sqrt(d2), push = (R - d) / d;
        // the player is heavier than bandits: enemies yield more
        const wa = a === this.player ? 0.3 : 0.5, wb = 1 - wa;
        a.pos.x -= dx * push * wa; a.pos.z -= dz * push * wa;
        b.pos.x += dx * push * wb; b.pos.z += dz * push * wb;
      }
    }
  }

  _handleEvents(a, events) {
    if (!events?.length) return;
    for (const ev of events) {
      if (ev.type === 'shoot' && a !== this.player && a.alive) { this.combat.fireProjectile(a); continue; }
      if (ev.type === 'vanish' && a !== this.player && a.alive) { a.vanish?.(); continue; }
      if (ev.type === 'blink' && a !== this.player && a.alive) { a.blink?.(); continue; }
      if (ev.type === 'stab' && a === this.player && a.execTarget && !a.execStabbed) { a.execStabbed = true; this.combat.executeStab(a, a.execTarget); continue; }
      if (ev.type !== 'step') continue;
      const foot = a.ch.rig?.bones?.[ev.foot === 'L' ? 'foot.L' : 'foot.R'];
      if (foot) foot.getWorldPosition(_v); else _v.copy(a.pos);
      const speed = Math.hypot(a.vel.x, a.vel.z);
      this.interaction?.trample?.(_v.x, _v.z, 0.35, 0.8);
      if (a === this.player) bus.emit('player:step', { foot: ev.foot, pos: _v.clone(), speed });
      else if (a.distTo(this.player) < 25) bus.emit('enemy:step', { id: a.id, foot: ev.foot, pos: _v.clone(), speed });
      // dust on the road / bare ground
      if (speed > 4 && this.app.world.pathAt) {
        const pth = this.app.world.pathAt(_v.x, _v.z);
        if (pth && pth.dist < pth.width) this.vfx?.dust?.(_v, 0.35);
      }
    }
  }

  /** Grass push + contact AO actors (slot 0 = player). */
  _writeActors() {
    const ix = this.interaction;
    const P = this.player;
    const set = (i, a, r) => {
      if (ix?.setActor) ix.setActor(i, a.pos.x, a.pos.y + a.hop, a.pos.z, r);
      else G.uActors.value[i].set(a.pos.x, a.pos.y + a.hop, a.pos.z, r);
    };
    // the hero leaps over the grass during the heavy cleave: shrink his push while airborne
    set(0, P, P.state === 'dodge' ? 0.7 : P.hop > 0.25 ? 0.25 : 0.45);
    // nearest active enemies get the remaining slots (insertion sort into a reused list: no allocations)
    const act = this._actList ??= [];
    act.length = 0;
    for (const e of this.enemies) {
      if (!e.active || e.sink >= 0.3) continue;
      e._dP = e.distTo(P);
      let k = act.length; act.push(e);
      while (k > 0 && act[k - 1]._dP > e._dP) { act[k] = act[k - 1]; k--; }
      act[k] = e;
    }
    let slot = 1;
    for (let i = 0; i < act.length && slot < MAX_ACTORS; i++) set(slot++, act[i], act[i].alive ? 0.45 : 0.75);
    for (; slot < MAX_ACTORS; slot++) {
      if (ix?.clearActor) ix.clearActor(slot); else G.uActors.value[slot].set(0, -999, 0, 0);
    }
  }

  // ------------------------------------------------------------------------------------------ debug / harness
  exposeDebug() {
    const game = this;
    const summary = (e) => ({ id: e.id, kind: e.kind, state: e.state, hp: Math.round(e.hp), posture: Math.round(e.posture), pos: [+e.pos.x.toFixed(2), +e.pos.z.toFixed(2)], d: +e.distTo(game.player).toFixed(2) });
    if (typeof window === 'undefined') return;
    window.__game = {
      game,
      get state() { return game.state; },
      get director() { return game.director.state; },
      get wave() { return game.director.wave + 1; },
      get hp() { return Math.round(game.player.hp); },
      get focus() { return Math.round(game.player.focus); },
      get player() { const P = game.player; return { state: P.state, clip: P.clip, hp: Math.round(P.hp), pos: [+P.pos.x.toFixed(2), +P.pos.z.toFixed(2)], yaw: +P.yaw.toFixed(2), drawn: P.drawn, lock: P.lock?.id ?? null }; },
      get enemies() { return game.enemies.filter((e) => e.active).map(summary); },
      get events() { return game.events.slice(-60); },
      get camera() { const c = game.camera; return { mode: c.mode, heading: +c.yaw.toFixed(3), pitch: +c.pitch.toFixed(3), dist: +c.dist.toFixed(2), fov: +c.fovNow.toFixed(1) }; },
      start(wave = 1) { game.director.begin(clamp(wave - 1, 0, WAVES.length - 1)); game.director.t = 0.9; return true; },
      spawn(kind = 'bandit', dist = 6, ang = 0) {
        const P = game.player, h = game.camera.heading + ang;
        return game.spawnEnemy(kind, P.pos.x + Math.sin(h) * dist, P.pos.z + Math.cos(h) * dist, h + Math.PI)?.id;
      },
      kill(id) { const e = game.enemies.find((o) => o.id === id || (!id && o.alive)); if (e) { e.hp = 1; game.combat.playerHits(game.player, e, e.chest(new THREE.Vector3()), 'torso', { damage: 99, posture: 0, kind: 'light', reach: 9, arc: 9 }); } return !!e; },
      setPlayer(x, z, yaw) { game.player.place(x, z, yaw ?? game.player.yaw); game.camera.snap(); },
      cam(heading, pitch, dist) { const c = game.camera; if (heading !== undefined) c.yaw = c.yawT = heading; if (pitch !== undefined) c.pitch = c.pitchT = pitch; if (dist !== undefined) c.dist = c.distT = c.userDist = dist; c.snap(); },
      mode(m, opts) { game.camera.setMode(m, opts ?? {}); },
      play(clip, who = 'player') { const a = who === 'player' ? game.player : game.enemies.find((e) => e.id === who); a?.play(clip); return !!a; },
      god(on = true) { game.player.invulnerable = on; },
      autopilot(on = true) { if (on && !game.autopilot) game.autopilot = new Autopilot(game); if (!on && game.autopilot) { game.autopilot.stop(); game.autopilot = null; } },
      pause(on = true) { game.setPaused(on); },
      stats() { return { ...game.app.stats(), enemies: game.enemies.filter((e) => e.active).length, state: game.state, frame: game.frame }; },
    };
  }

  dispose() {
    for (const off of this._off ?? []) off?.();
    this.app.remove(this._sys);
    this.input.dispose();
  }
}

export { WAVES, KINDS, SUN_DIR, yawOf };
