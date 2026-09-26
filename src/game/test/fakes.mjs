// Light stand-ins for the art areas, so gameplay can be tested in node: an animator that only records the clip it
// was asked to play, and a character with a sword socket (base/tip), capsules and the Character API surface.
// Owner: gameplay (P).
import * as THREE from 'three';

export class FakeAnimator {
  constructor() { this.current = null; this.armed = false; this._out = { rootMotion: new THREE.Vector3(), rootYaw: 0, events: [] }; }
  play(name) { this.current = name; }
  stop() { this.current = null; }
  setLocomotion() {}
  setArmed(v) { this.armed = v; }
  lookAt() {}
  update() { return this._out; }
}

/** A character whose blade is held out in front at chest height (so swings connect with a target ~1.4 m ahead). */
export function fakeCharacter({ kind = 'hero' } = {}) {
  const group = new THREE.Group();
  group.name = `fake:${kind}`;
  const hand = new THREE.Object3D(); hand.position.set(-0.25, 1.2, 0.35); group.add(hand);
  const base = new THREE.Object3D(); base.position.set(0, 0, 0.1); hand.add(base);
  const tip = new THREE.Object3D(); tip.position.set(0, 0, 0.95); hand.add(tip);
  const caps = [['torso', 0.9, 1.5, 0.22], ['head', 1.55, 1.75, 0.12], ['leg', 0.1, 0.85, 0.12]];
  return {
    kind, group, rig: { bones: {} }, sword: { base, tip, drawn: true, setDrawn(v) { this.drawn = v; } },
    update() {}, flash() {}, setVisible(v) { group.visible = v; }, dispose() {},
    hurtCapsules(out = []) {
      out.length = 0;
      group.updateMatrixWorld(true);
      for (const [part, y0, y1, r] of caps) {
        out.push({ a: new THREE.Vector3(0, y0, 0).applyMatrix4(group.matrixWorld), b: new THREE.Vector3(0, y1, 0).applyMatrix4(group.matrixWorld), r, part });
      }
      return out;
    },
  };
}

/** Minimal app: world, time (hit-stop + slow-mo like core/app.js), systems, no renderer/pipeline. */
export function fakeApp(query = '') {
  const systems = [];
  const time = {
    t: 0, real: 0, scale: 1, _targetScale: 1, _scaleLerp: 0, _hitstop: 0,
    hitstop(s) { this._hitstop = Math.max(this._hitstop, s); },
    setScale(k, lerp = 0) { this._targetScale = k; this._scaleLerp = lerp; if (lerp <= 0) this.scale = k; },
  };
  const app = {
    renderer: { domElement: null }, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(48, 16 / 9, 0.3, 7000),
    pipeline: null, time, params: new URLSearchParams(query),
    world: { heightAt: () => 0, normalAt: (x, z, o = new THREE.Vector3()) => o.set(0, 1, 0), colliders: [] },
    add(s) { systems.push(s); return s; }, remove(s) { const i = systems.indexOf(s); if (i >= 0) systems.splice(i, 1); },
    progress() {}, async ready() {}, stats() { return {}; },
  };
  return { app, systems };
}
