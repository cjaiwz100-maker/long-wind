// Director: title → the level's waves (src/levels: the steppe's end in the swordmaster duel, mood 'ember', wind
// 1.5 → 2.2) → victory (the steppe: blue hour settles; then the next level). Defeat fades to warm mist and restarts
// the current wave.
// Owner: gameplay (P). Game states on the bus: title | playing | paused | victory | defeat.
import * as THREE from 'three';
import { bus } from '../core/bus.js';
import { setWindStrength } from '../core/wind.js';
import { SUN_DIR } from '../core/globals.js';
import { yawOf, lerp } from './util.js';
import { LEVEL, markCleared } from '../levels/index.js';

// the waves come from the level (src/levels/*.js)
export const WAVES = LEVEL.waves;

const MIST = [0.80, 0.73, 0.62];

export class Director {
  constructor(game) {
    this.game = game;
    this.state = 'title';
    this.wave = -1;
    this.t = 0;
    this.pending = [];        // queued spawns {kind, x, z, at}
    this.alive = 0;
    this.spawnedThisWave = 0;
    this.clearT = 0;
    this.gameState = null;
  }

  setGameState(s) {
    if (this.gameState === s) return;
    this.gameState = s;
    this.game.state = s;
    bus.emit('game:state', { state: s });
    this.game.log('state', s);
  }

  mood(name, seconds) {
    const env = this.game.env;
    try { env?.setMood?.(name, seconds); } catch (e) { console.warn('[game] setMood failed', e); }
    bus.emit('mood', { name, seconds });
  }
  wind(strength, ease) {
    setWindStrength(strength, ease);
    this.game.combat.windBase = strength;
    bus.emit('wind', { strength, ease });
  }

  toTitle() {
    this.state = 'title'; this.t = 0; this.wave = -1;
    this.setGameState('title');
    this.game.resetArena();
    this.game.camera.setMode('title', { blend: 1.2 });
    this.game.player.setDrawn(false);
  }

  /** Free roam (?state=explore, for filming the land): playing, but no waves ever start. */
  explore() {
    this.setGameState('playing');
    this.state = 'explore'; this.t = 0;
  }

  /** Leave the title: short beat, then wave 1. */
  begin(startWave = 0) {
    this.setGameState('playing');
    this.game.camera.setMode('follow', { heading: this.game.camera.sunHeading, blend: 1.4 });
    this.state = 'prewave'; this.t = 0; this.nextWave = startWave;
  }

  startWave(i) {
    const g = this.game;
    const W = WAVES[i];
    this.wave = i;
    this.state = 'intro'; this.t = 0;
    this.pending.length = 0;
    this.spawnedThisWave = W.enemies.length;
    g.coordinator.reset();
    g.coordinator.max = W.maxAttackers ?? 2;
    // spawn on the sun side of the player so the enemies approach as silhouettes against the amber haze
    const P = g.player.pos;
    const sunH = Math.atan2(SUN_DIR.x, SUN_DIR.z);
    const n = W.enemies.length;
    const cx = P.x + Math.sin(sunH) * (W.boss ? 22 : 26), cz = P.z + Math.cos(sunH) * (W.boss ? 22 : 26);
    const SP = LEVEL.spawn;
    const TW = g.layout.town;
    if (SP?.ring && TW) {
      // the town: out of the street mouths and the alleys; some drop from the eaves round the plaza
      const mouths = [{ x: -26, z: 0 }, { x: 26, z: 0 }];
      for (const ax of TW.alleys) if (Math.abs(ax) < 70) for (const s of [-1, 1]) mouths.push({ x: ax, z: s * (TW.frontage + 1.2) });
      mouths.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
      const near = mouths.slice(0, 6);
      W.enemies.forEach((kind, k) => {
        const eaves = !W.boss && kind !== 'bandit_heavy' && kind !== 'shieldman' && g.rng.next() < (SP.eaves ?? 0);
        let p;
        const eav = (g.app.town?.eaves ?? []).filter((a) => Math.hypot(a.x, a.z) < 26);
        if (eaves && eav.length) {
          // a roof edge round the plaza (town.js anchors): land a step out from the facade
          const a = eav[Math.floor(g.rng.next() * eav.length)], gy = g.heightAt(a.x, a.z);
          p = { x: a.x + Math.sin(a.yaw) * 1.2, z: a.z + Math.cos(a.yaw) * 1.2, drop: Math.max(2.5, a.y - gy) };
        } else p = { ...near[k % near.length] };
        p.x += g.rng.range(-1, 1);
        this.pending.push({ kind, x: p.x, z: p.z, drop: p.drop, at: 0, hold: 0.35 + k * 0.45, name: W.name, sub: W.bossSub });
      });
      const f = this.pending[0];
      this.focus = new THREE.Vector3(f.x, g.heightAt(f.x, f.z), f.z);
    } else if (SP?.ring) {
      // a level without a sun side (the bamboo grove): they step out of the cover all round the clearing
      const C = g.layout.knoll ?? { x: 0, z: 0 }, a0 = g.rng.range(0, Math.PI * 2);
      W.enemies.forEach((kind, k) => {
        const a = a0 + (k / n) * Math.PI * 2 + g.rng.range(-0.25, 0.25), r = SP.r + g.rng.range(-1.5, 2.5);
        this.pending.push({ kind, x: C.x + Math.sin(a) * r, z: C.z + Math.cos(a) * r, at: 0, hold: 0.35 + k * 0.45, name: W.name, sub: W.bossSub });
      });
      const f = this.pending[0];
      this.focus = new THREE.Vector3(f.x, g.heightAt(f.x, f.z), f.z);
    } else W.enemies.forEach((kind, k) => {
      // a tight pack reads as one threat cresting the swell (±18° for three, ±26° for five)
      const fan = 0.14 + 0.06 * n;
      const spread = n <= 1 ? 0 : lerp(-fan, fan, k / (n - 1));
      const r = (W.boss ? 22 : 24) + g.rng.range(0, 5);
      const h = sunH + spread + g.rng.range(-0.08, 0.08);
      let x = P.x + Math.sin(h) * r, z = P.z + Math.cos(h) * r;
      ({ x, z } = g.clampToArena(x, z, 6));
      // everyone is placed on the first frame of the intro shot (no pop-in on camera); they set off one by one
      this.pending.push({ kind, x, z, at: 0, hold: 0.35 + k * 0.45 });
    });
    if (!SP?.ring) this.focus = new THREE.Vector3(cx, g.heightAt(cx, cz), cz);
    bus.emit('wave:start', { index: i + 1, title: W.title, sub: W.sub, count: n, boss: !!W.boss, total: WAVES.length });
    g.log('wave', `${i + 1} ${W.title} (${n})`);
    if (W.mood) this.mood(W.mood, W.moodSeconds ?? 6);
    this.wind(W.wind, 3);
    // cinematic intro: letterbox + low wide shot toward the enemies cresting the swell
    if (!g.quickStart) {
      g.camera.setMode('intro', { focus: this.focus, duration: 3.2, blend: 1.5 });
      g.app.pipeline?.fx?.letterbox?.(true);
      g.letterboxT = 3.2;
    }
    // bring the sword out when the pack is sighted
    if (!g.player.drawn && g.player.state === 'loco') g.player.startDraw(null);
  }

  isLastKill(e) {
    const g = this.game;
    if (this.pending.length) return false;
    let alive = 0;
    for (const o of g.enemies) if (o.alive && o.active && o !== e) alive++;
    return alive === 0 && !!WAVES[this.wave];
  }

  onKill(e, last) {
    if (last) { this.state = 'clear'; this.t = 0; this.lastKill = e; }
  }

  onPlayerDeath() {
    if (this.state === 'defeat' || this.state === 'defeatWait') return;
    const g = this.game;
    this.state = 'defeat'; this.t = 0;
    g.combat.slowmo(0.3, 1.2, 0.05, 0.8);
    g.camera.setMode('defeat', { heading: g.camera.heading, blend: 1.2 });
    g.app.pipeline?.fx?.letterbox?.(true);
    g.coordinator.reset();
  }

  update(dt) {
    const g = this.game;
    this.t += dt;
    switch (this.state) {
      case 'title': break;
      case 'prewave':
        if (this.t > 1.0) this.startWave(this.nextWave ?? 0);
        break;
      case 'intro':
      case 'fight': {
        for (let i = this.pending.length - 1; i >= 0; i--) {
          const p = this.pending[i];
          if (this.t >= p.at) {
            this.pending.splice(i, 1);
            const yaw = yawOf(g.player.pos.x - p.x, g.player.pos.z - p.z);
            const e = g.spawnEnemy(p.kind, p.x, p.z, yaw, { name: p.name, sub: p.sub });
            if (e) {
              e.holdUntil = e.clock + (p.hold ?? 0);
              if (p.drop) { e.lift = p.drop; e.liftV = 0.5; e.holdUntil += 0.6; }   // leaps down from the eaves
            }
          }
        }
        if (this.state === 'intro' && this.t > 3.2) { this.state = 'fight'; }
        if (g.letterboxT !== undefined && g.letterboxT > 0) { g.letterboxT -= dt; if (g.letterboxT <= 0) g.app.pipeline?.fx?.letterbox?.(false); }
        break;
      }
      case 'clear': {
        if (g.letterboxT > 0) { g.letterboxT -= dt; if (g.letterboxT <= 0) g.app.pipeline?.fx?.letterbox?.(false); }
        if (this.t > 0.05 && !this.clearSent) {
          this.clearSent = true;
          const W = WAVES[this.wave];
          bus.emit('wave:clear', { index: this.wave + 1, title: W.title, count: W.enemies.length, boss: !!W.boss });
          g.log('wave clear', this.wave + 1);
          g.player.lockOn(null);
        }
        // the signature beat: sheathe after the last kill
        if (this.t > 2.2 && !this.sheathed && this.wave < WAVES.length - 1) {
          this.sheathed = true;
          if (g.player.drawn && g.player.state === 'loco') g.player.startSheathe();
        }
        if (this.wave >= WAVES.length - 1 && this.t > 2.6) {
          this.state = 'victory'; this.t = 0;
          g.player.celebrate();
          g.camera.setMode('victory', { victim: this.lastKill?.pos?.clone() ?? g.player.pos.clone(), blend: 1.0 });
          g.app.pipeline?.fx?.letterbox?.(true);
          const vm = LEVEL.env?.victoryMood === undefined ? 'blue' : LEVEL.env.victoryMood;
          if (vm) this.mood(vm, 30);
          this.wind(0.8, 6);
          markCleared(LEVEL.id);
          this.setGameState('victory');
        } else if (this.wave < WAVES.length - 1 && this.t > 5.5) {
          this.clearSent = false; this.sheathed = false;
          this.startWave(this.wave + 1);
        }
        break;
      }
      case 'victory':
        if (this.t > 5 && g.input.anyPressed) { if (LEVEL.next) bus.emit('ui:next', {}); else this._restartAll(); }
        break;
      case 'defeat': {
        if (this.t > 2.2 && !this.fadedOut) {
          this.fadedOut = true;
          g.app.pipeline?.fx?.fade?.(1, 1.2, MIST);
        }
        if (this.t > 3.5) { this.state = 'defeatWait'; this.t = 0; this.setGameState('defeat'); }
        break;
      }
      case 'defeatWait':
        if ((this.t > 1.2 && (g.input.b.restart.pressed || g.input.b.start.pressed || g.input.b.light.pressed)) || (g.autopilot && this.t > 2.5)) {
          this.restartWave();
        }
        break;
      default: break;
    }
  }

  /** Restart from a HUD screen: victory → title, defeat or pause menu → the current wave. */
  requestRestart() {
    const g = this.game;
    if (this.state === 'victory') { if (LEVEL.next) { bus.emit('ui:next', {}); return; } return this._restartAll(); }
    if (this.state === 'title') return;
    if (g.paused) { g.paused = false; g.combat.paused = false; }
    this.restartWave();
  }

  restartWave() {
    const g = this.game;
    this.fadedOut = false;
    g.resetArena();
    g.app.pipeline?.fx?.fade?.(0, 1.6, MIST);
    g.app.pipeline?.fx?.letterbox?.(false);
    g.camera.setMode('follow', { heading: g.camera.sunHeading, force: true });
    g.camera.snap();
    this.setGameState('playing');
    this.clearSent = false; this.sheathed = false;
    const w = Math.max(0, this.wave);
    g.quickStart = true;
    this.startWave(w);
    g.quickStart = false;
  }

  _restartAll() {
    const g = this.game;
    g.app.pipeline?.fx?.letterbox?.(false);
    if (!LEVEL.env?.u) this.mood(LEVEL.env?.mood ?? 'golden', 4);
    this.wind(LEVEL.env?.wind ?? 1.0, 3);
    this.clearSent = false; this.sheathed = false;
    this.toTitle();
  }
}
