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
 * table: { gameClip: { src: name prefix, t0?, t1?, key?, keys?, sync?: [[gameT, srcT], …], loop?, pingpong?, rate?: number | 'speed', speed0?: m/s at rate 1,
 *                      fade?: s, hold?: bool, mask?: 'body' | 'arms' | 'left' | 'upper', grip?: 'hand' | 'pole', jianzhi?: bool, root?: false, align?: bool } }   ('<clip>~free' = the variant
 *   used while sheathed; mask 'body' keeps the sword arm on the animator, 'arms' both arms, 'left' only the free arm,
 *   'upper' the pelvis and legs (a guard held over the walk);
 *   grip 'hand' skips the empty-hand grip solve for takes shot with a sword in the hand, e.g. Mixamo 'mx:' clips, and
 *   grip 'pole' lays a two-handed shaft from the right fist through the left (spear over a rifle or staff take);
 *   jianzhi: the free hand's fingers keep the 剑指 curl, e.g. over a take whose off hand gripped a shield)
 */
export function createBakedLayer(root, animations, table, { mb, noTrack = () => false, armOut = () => false, onMasked = null }) {
  const byName = {}; root.traverse((o) => { byName[o.name] = o; });
  const hips = mb('Hips');
  const entries = {};
  // the pelvis parent's frame ↔ the character group's (the model hangs rigidly in the group): travel and turns are
  // measured on the ground of the group
  root.updateMatrixWorld(true);
  const HP = new THREE.Matrix4().copy(root.parent ? root.parent.matrixWorld : new THREE.Matrix4()).invert().multiply(hips.parent.matrixWorld);
  const HPinv = HP.clone().invert();
  const upP = new THREE.Vector3(0, 1, 0).transformDirection(HPinv);   // the group's up in the pelvis parent's frame
  for (const [game, spec] of Object.entries(table)) build(game, spec);
  function build(game, spec) {
    const clip = animations.find((a) => a.name === spec.src) ?? animations.find((a) => a.name.startsWith(spec.src) || (a.name.length > 40 && spec.src.startsWith(a.name.trimEnd())));   // exporters truncate long names
    if (!clip) { console.warn('[baked] missing clip for', game, spec.src); return; }
    const tracks = [];
    for (const tr of clip.tracks) {
      const dot = tr.name.lastIndexOf('.');
      const node = byName[tr.name.slice(0, dot)] ?? byName[tr.name.slice(0, dot).replace(/[:.]/g, '')];
      const path = tr.name.slice(dot + 1);
      if (!node || (path !== 'quaternion' && path !== 'position') || noTrack(node, spec)) continue;
      if (spec.mask && armOut(node, spec.mask)) continue;   // 'body': the sword arm stays the animator's; 'arms': both arms; 'left': the free arm
      if (path === 'position' && node !== hips) continue;        // bone lengths stay the rest skeleton's
      tracks.push({ node, path, it: tr.createInterpolant(), isHips: node === hips, k: clip.userData?.hipScale ?? 1 });
    }
    const t0 = spec.t0 ?? 0, t1 = Math.min(spec.t1 ?? clip.duration, clip.duration);
    const e = entries[game] = { game, spec, clip, tracks, t0, t1, fade: spec.fade ?? 0.18, speed0: spec.speed0 ?? 1 };
    // Mocap actions carry their own footwork: the game body travels along the take's pelvis path (rootAt, via the
    // animator's rootSource) and the pelvis stays over its start. `align`: the take is turned about the vertical so
    // its net travel over [t0, t1] heads straight forward (a thrust that drifts sideways still flies at the target).
    const hp = tracks.find((x) => x.isHips && x.path === 'position');
    if (hp && spec.root !== false && !spec.loop && spec.rate === undefined && clip.userData?.mixamo) {
      const g = (t, v) => v.fromArray(hp.it.evaluate(t)).applyMatrix4(HP);
      e.hp = hp; e.g = g;
      e.start = g(t0, new THREE.Vector3());
      e.startP = e.start.clone().applyMatrix4(HPinv);
      let yaw = 0;
      if (spec.align) { const d = g(t1, new THREE.Vector3()).sub(e.start); if (Math.hypot(d.x, d.z) > 0.2) yaw = -Math.atan2(d.x, d.z); }
      e.yawG = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      e.yawP = new THREE.Quaternion().setFromAxisAngle(upP, yaw);
      e.turned = Math.abs(yaw) > 1e-4;
    }
    if (spec.rate === 'speed') {
      // ground speed of the authored cycle (m/s in the character's space) from the hips' travel over the clip
      const ht = tracks.find((x) => x.isHips && x.path === 'position');
      if (ht) {
        root.updateMatrixWorld(true);
        const a = new THREE.Vector3().fromArray(ht.it.evaluate(t0)), b = new THREE.Vector3().fromArray(ht.it.evaluate(t1));
        hips.parent.localToWorld(a); hips.parent.localToWorld(b);
        a.y = b.y = 0;
        const sc = root.parent ? root.parent.getWorldScale(new THREE.Vector3()).x : 1;
        const v = a.distanceTo(b) / sc / Math.max(1e-3, t1 - t0);
        if (v > 0.1) e.speed0 = v;   // an in-place take keeps spec.speed0
      }
    }
  }

  const layers = [];               // [{ e, t, w, target }], newest last
  const out = { w: 0, grip: 0, pole: 0 };

  /**
   * Game-clip progress u (0..1) → source time, piecewise linear: `key` (the take's strike) lands mid first hit window;
   * `keys: [k1, k2, …]` put one strike in each hit window (multi-hit clips).
   */
  function warp(e, u, hits, d) {
    const s = e.spec;
    if (s.sync) {   // [[game clip time, take time], …]: e.g. the hand on the hilt when the clip's 'drawn' event swaps the sword
      let pu = 0, pt = e.t0;
      for (const [g, st] of s.sync) { const ug = g / d; if (u < ug) return pt + ((u - pu) / Math.max(1e-3, ug - pu)) * (st - pt); pu = ug; pt = st; }
      return pt + ((u - pu) / Math.max(1e-3, 1 - pu)) * (e.t1 - pt);
    }
    const ks = s.keys ?? (s.key != null ? [s.key] : null);
    if (!ks || !hits?.length) return e.t0 + u * (e.t1 - e.t0);
    let pu = 0, pt = e.t0;
    for (let i = 0; i < ks.length && i < hits.length; i++) {
      const uk = THREE.MathUtils.clamp((hits[i][0] + hits[i][1]) / 2 / d, pu + 0.02, 0.97);
      if (u < uk) return pt + ((u - pu) / (uk - pu)) * (ks[i] - pt);
      pu = uk; pt = ks[i];
    }
    return pt + ((u - pu) / Math.max(1e-3, 1 - pu)) * (e.t1 - pt);
  }

  function srcTime(L, anim, dt) {
    const { e } = L, s = e.spec, len = e.t1 - e.t0;
    if (L.action) {
      // map the game clip clock onto [t0, t1]
      const d = anim.duration || 1;
      const u = Math.min(1, Math.max(0, (L.live ? anim.time : L.lastU * d) / d));
      L.lastU = u;
      return warp(e, u, L.actionRef?.clip.meta?.hit, d);
    }
    const rate = s.rate === 'speed' ? THREE.MathUtils.clamp((anim.gait?.speed ?? 0) / e.speed0, 0.55, 1.8) : (s.rate ?? 1);
    L.clock += dt * rate;
    if (s.pingpong) { const p = L.clock % (2 * len); return e.t0 + (p < len ? p : 2 * len - p); }
    return e.t0 + (L.clock % len);
  }

  function pick(anim) {
    const name = anim.action ? anim.action.clip.name : anim.current;
    // '<clip>~free': the sheathed variant (both arms swing as authored; the sword arm is only the animator's while armed)
    if (!anim.action && !anim.armed && entries[name + '~free']) return entries[name + '~free'];
    return entries[name] ?? null;
  }

  const _t = new THREE.Vector3();
  return {
    entries,
    /**
     * Root travel of the take behind game clip `clip` at clip time t (cumulative, character-group metres, horizontal)
     * → true, or false when the clip has no travelling take (the animator then uses its own authored root).
     */
    rootAt(clip, t, out) {
      const e = entries[clip.name];
      if (!e?.hp) return false;
      const d = clip.duration || 1;
      e.g(warp(e, THREE.MathUtils.clamp(t / d, 0, 1), clip.meta?.hit, d), _t).sub(e.start);
      _t.y = 0;
      out.copy(_t.applyQuaternion(e.yawG));
      return true;
    },
    /** Dev: (re)define the baked entry for a game clip at runtime (e.g. auditioning a take: ?scene=anim&mxall=1). */
    add(game, spec) { build(game, spec); layers.length = 0; return entries[game]; },
    clipNames: () => animations.map((a) => a.name),
    /** Blend the baked layers over the current (retargeted) model pose → { w: total baked weight, grip: weight of full-body layers }. */
    update(dt, anim) {
      if (!anim) { out.w = out.grip = out.pole = 0; return out; }
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
      let total = 0, grip = 0, pole = 0;
      for (const L of layers) {
        const t = srcTime(L, anim, dt);
        if (L.w <= 0) continue;
        // blending in sequence gives the newest layer priority (a standard cross-fade stack)
        const w = L.w;
        const trav = L.action && L.e.hp;
        for (const tr of L.e.tracks) {
          const r = tr.it.evaluate(t);
          if (tr.path === 'quaternion') {
            _q.fromArray(r);
            if (trav && L.e.turned && tr.isHips) _q.premultiply(L.e.yawP);
            tr.node.quaternion.slerp(_q, w);
          } else if (tr.isHips) {
            // root travel stripped: keep the current XZ, take the baked height (relative to the rest height)
            tr.node.position.y += (r[1] * tr.k - tr.node.position.y) * w;   // k: borrowed clips rescaled to this body
            // a travelling take: the body rides its path (rootAt), so the pelvis sits over where the take started
            if (trav) { tr.node.position.x += (L.e.startP.x - tr.node.position.x) * w; tr.node.position.z += (L.e.startP.z - tr.node.position.z) * w; }
          }
        }
        total = total + (1 - total) * w;
        // masked layers leave the sword arm to the animator: re-seat it on the moved shoulders (world rotations kept)
        const masked = !!L.e.spec.mask && L.e.spec.mask !== 'upper';   // an arm left to the animator
        if (masked) onMasked?.(w, L.e.spec.mask);
        // 'left' layers still author the sword hand; grip 'hand' = the take was shot holding a sword: keep its wrist as is
        grip = grip * (1 - w) + ((masked && L.e.spec.mask !== 'left') || L.e.spec.grip === 'hand' || L.e.spec.grip === 'pole' ? 0 : w);
        pole = pole * (1 - w) + (L.e.spec.grip === 'pole' ? w : 0);   // 'pole': a two-handed shaft runs from fist to fist
      }
      out.w = total; out.grip = grip; out.pole = pole;
      return out;
    },
    get active() { return layers.length > 0; },
    reset() { layers.length = 0; },
  };
}
