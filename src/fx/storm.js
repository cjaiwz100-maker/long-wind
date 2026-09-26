// Lightning scheduler 雷: fires env.lightning() at random intervals and emits the matching
// bus 'thunder' so the audio layer rolls the thunder in after the flash. Owner: X.
//
//   const storm = createLightning(app, env, { interval = [5, 14], enabled = true })
//   storm.strike({ distance?, dir? })   one strike now; distance in metres (300 … 3000, default random, closer = louder,
//                                       shorter delay, a crack on top of the rumble); dir = world Vector3 toward the bolt
//   storm.enabled = false               pause the random schedule (strike() still works)
//   storm.interval = [a, b]             seconds between random strikes
//   storm.update(dt)                    registered with app.add (sim time)
//
// bus 'thunder' { delay, strength, pan, distance }: delay = distance/343·0.55 s (compressed so it still feels
// connected), strength 0..1 (≈1 at 300 m, ≈0.2 at 3 km), pan −1..1 from the bolt direction vs the camera's right.
import * as THREE from 'three';
import { bus } from '../core/bus.js';

const _d = new THREE.Vector3(), _r = new THREE.Vector3();

export function createLightning(app, env, { interval = [5, 14], enabled = true } = {}) {
  let next = interval[0] + Math.random() * (interval[1] - interval[0]);
  const storm = {
    enabled, interval,
    strike({ distance, dir } = {}) {
      const dist = distance ?? 300 + Math.pow(Math.random(), 1.4) * 2700;
      if (dir) _d.copy(dir);
      else {
        app.camera.getWorldDirection(_d);
        _d.y = 0; if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
        _d.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, (Math.random() - 0.5) * 1.6);
        _d.y = 0.3 + 0.25 * Math.random();
      }
      _d.normalize();
      env?.lightning?.(_d);
      _r.setFromMatrixColumn(app.camera.matrixWorld, 0);
      const pan = Math.max(-1, Math.min(1, _r.x * _d.x + _r.z * _d.z));
      const strength = Math.max(0.12, Math.min(1, 1.25 - Math.log10(dist / 300) * 1.05));
      bus.emit('thunder', { delay: (dist / 343) * 0.55, strength, pan, distance: dist });
      return dist;
    },
    update(dt) {
      if (!storm.enabled) return;
      next -= dt;
      if (next > 0) return;
      next = storm.interval[0] + Math.random() * (storm.interval[1] - storm.interval[0]);
      storm.strike();
    },
    dispose() { app.remove?.(storm); },
  };
  app.add(storm);
  return storm;
}
