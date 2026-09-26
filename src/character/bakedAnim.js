// Baked clips (owner: character C): authored/mocap-quality animation clips that ship inside a model skin's GLB (e.g.
// Tripo Animate exports) layered over the procedural animator on the model's own skeleton.
//
//   const baked = createBakedLayer(modelRoot, gltf.animations, table, { mb, keepRest })
//   baked.update(dt, anim, drawn) → true when a baked layer is visible this frame (call after the rig→model retarget)
//
// • The animator keeps running: gameplay timing, events, root motion and hit windows are untouched. Each frame the
//   game clip (anim.current / anim.time) picks a baked clip from `table`; it is sampled on the model bones and
//   cross-faded over whatever the retarget wrote (weights ramp over `fade`).
// • Root travel is stripped (gameplay moves the character): the hips keep the retarget's XZ, the baked height/sway.
// • Right-hand fingers keep the sword grip; everything else (spine twist, toes, the free hand) plays as authored.
// • Timing: `rate: 'speed'` loops at the gait speed (walk/run), loops otherwise run on their own clock, and actions map
//   [t0, t1] of the source onto the game clip's duration.
import * as THREE from 'three';

const _q = new THREE.Quaternion();

/**
 * table: { gameClip: { src: name prefix, t0?, t1?, loop?, pingpong?, rate?: number | 'speed', speed0?: m/s at rate 1,
 *                      fade?: s, hold?: bool } }
 */
export function createBakedLayer(root, animations, table, { mb, noTrack = () => false, armOut = () => false, onMasked = null }) {
  const byName = {}; root.traverse((o) => { byName[o.name] = o; });
  const hips = mb('Hips');
  const entries = {};
  for (const [game, spec] of Object.entries(table)) {
    const clip = animations.find((a) => a.name === spec.src) ?? animations.find((a) => a.name.startsWith(spec.src) || (a.name.length > 40 && spec.src.startsWith(a.name.trimEnd())));   // exporters truncate long names
    if (!clip) { console.warn('[baked] missing clip for', game, spec.src); continue; }
    const tracks = [];
    for (const tr of clip.tracks) {
      const dot = tr.name.lastIndexOf('.');
      const node = byName[tr.name.slice(0, dot)] ?? byName[tr.name.slice(0, dot).replace(/[:.]/g, '')];
      const path = tr.name.slice(dot + 1);
      if (!node || (path !== 'quaternion' && path !== 'position') || noTrack(node)) continue;
      if (spec.mask === 'body' && armOut(node)) continue;       // the sword arm stays the animator's
      if (path === 'position' && node !== hips) continue;        // bone lengths stay the rest skeleton's
      tracks.push({ node, path, it: tr.createInterpolant(), isHips: node === hips, k: clip.userData?.hipScale ?? 1 });
    }
    const t0 = spec.t0 ?? 0, t1 = Math.min(spec.t1 ?? clip.duration, clip.duration);
    const e = entries[game] = { game, spec, clip, tracks, t0, t1, fade: spec.fade ?? 0.18, speed0: spec.speed0 ?? 1 };
    if (spec.rate === 'speed') {
      // ground speed of the authored cycle (m/s in the character's space) from the hips' travel over the clip
      const ht = tracks.find((x) => x.isHips && x.path === 'position');
      if (ht) {
        root.updateMatrixWorld(true);
        const a = new THREE.Vector3().fromArray(ht.it.evaluate(t0)), b = new THREE.Vector3().fromArray(ht.it.evaluate(t1));
        hips.parent.localToWorld(a); hips.parent.localToWorld(b);
        a.y = b.y = 0;
        const sc = root.parent ? root.parent.getWorldScale(new THREE.Vector3()).x : 1;
        e.speed0 = a.distanceTo(b) / sc / Math.max(1e-3, t1 - t0);
      }
    }
  }

  const layers = [];               // [{ e, t, w, target }], newest last
  const out = { w: 0, grip: 0 };

  function srcTime(L, anim, dt) {
    const { e } = L, s = e.spec, len = e.t1 - e.t0;
    if (L.action) {
      // map the game clip clock onto [t0, t1]
      const d = anim.duration || 1;
      const u = Math.min(1, Math.max(0, (L.live ? anim.time : L.lastU * d) / d));
      L.lastU = u;
      // optional key: the source instant that lands on the game clip's first hit (piecewise-linear warp)
      const hit = L.actionRef?.clip.meta?.hit?.[0];
      if (s.key != null && hit) {
        const uk = THREE.MathUtils.clamp((hit[0] + hit[1]) / 2 / d, 0.05, 0.95);
        return u < uk ? e.t0 + (u / uk) * (s.key - e.t0) : s.key + ((u - uk) / (1 - uk)) * (e.t1 - s.key);
      }
      return e.t0 + u * len;
    }
    const rate = s.rate === 'speed' ? THREE.MathUtils.clamp((anim.gait?.speed ?? 0) / e.speed0, 0.55, 1.8) : (s.rate ?? 1);
    L.clock += dt * rate;
    if (s.pingpong) { const p = L.clock % (2 * len); return e.t0 + (p < len ? p : 2 * len - p); }
    return e.t0 + (L.clock % len);
  }

  function pick(anim) {
    const name = anim.action ? anim.action.clip.name : anim.current;
    return entries[name] ?? null;
  }

  return {
    entries,
    /** Blend the baked layers over the current (retargeted) model pose → { w: total baked weight, grip: weight of full-body layers }. */
    update(dt, anim) {
      if (!anim) { out.w = out.grip = 0; return out; }
      const e = pick(anim);
      const top = layers[layers.length - 1];
      const action = !!anim.action;
      if (e && (!top || top.e !== e || top.action !== action || (action && top.actionRef !== anim.action))) {
        for (const L of layers) L.live = false;
        layers.push({ e, clock: 0, w: 0, live: true, action, actionRef: anim.action, lastU: 0 });
      } else if (!e && top) for (const L of layers) L.live = false;
      else if (top && top.e === e) top.live = true;
      // weights: the live layer rises, the rest fall
      for (const L of layers) {
        const k = dt / Math.max(0.04, L.e.fade);
        L.w = L.live ? Math.min(1, L.w + k) : Math.max(0, L.w - k);
      }
      while (layers.length && layers[0].w <= 0 && !layers[0].live) layers.shift();
      let total = 0, grip = 0;
      for (const L of layers) {
        const t = srcTime(L, anim, dt);
        if (L.w <= 0) continue;
        // blending in sequence gives the newest layer priority (a standard cross-fade stack)
        const w = L.w;
        for (const tr of L.e.tracks) {
          const r = tr.it.evaluate(t);
          if (tr.path === 'quaternion') { _q.fromArray(r); tr.node.quaternion.slerp(_q, w); }
          else if (tr.isHips) {
            // root travel stripped: keep the current XZ, take the baked height (relative to the rest height)
            tr.node.position.y += (r[1] * tr.k - tr.node.position.y) * w;   // k: borrowed clips rescaled to this body
          }
        }
        total = total + (1 - total) * w;
        // masked layers leave the sword arm to the animator: re-seat it on the moved shoulders (world rotations kept)
        const masked = L.e.spec.mask === 'body';
        if (masked) onMasked?.(w);
        grip = grip * (1 - w) + (masked ? 0 : w);
      }
      out.w = total; out.grip = grip;
      return out;
    },
    get active() { return layers.length > 0; },
    reset() { layers.length = 0; },
  };
}
