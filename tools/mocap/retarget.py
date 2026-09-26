"""Video mocap → rig channel keys.

  python tools/mocap/retarget.py <mocap.json from pose_video.py> <out.js> [--name NAME] [--min 1.0]

Input: MediaPipe world landmarks per frame (hip-centred, metres, camera axes: x right, y down, z away).
Output: an ES module exporting { fps, segments: [{ t0, t1, keys: [K-style channel objects] }] } in the rig's
channel vocabulary (clips/track.js): hip, pel, sp, ch, nk, hd (deg, YXZ), lf/rf (ground anchor, yaw/pitch),
lk, sw ({p,d,e} weapon frame from the right-hand knuckles), lh ({p,f,n}), tw (two-handed weight).
Positions are scaled to the rig by leg length; every shot (camera cut) becomes its own segment, expressed in the
heading of its first frame, with gaps filled and a light zero-phase smoothing.
"""
import json, sys, math, numpy as np

A = sys.argv[1:]
src, out = A[0], A[1]
name = A[A.index('--name') + 1] if '--name' in A else 'mocap'
MIN_LEN = float(A[A.index('--min') + 1]) if '--min' in A else 1.0
D = json.load(open(src)); fps = D['fps']; F = D['frames']

LEG = 0.9            # rig hip → ankle length (m)
HIP0 = 0.98          # rig pelvis rest height
ANKLE_H = 0.075      # ankle height above the ground when planted

def V(f, i): p = f['w'][i]; return np.array([p[0], -p[1], -p[2]])   # → right-handed, y up, z toward camera
def nrm(v): n = np.linalg.norm(v); return v / n if n > 1e-9 else v
def frame(x, y):     # orthonormal (x, y, z = x × y) with x kept
    x = nrm(x); y = nrm(y - x * np.dot(x, y)); return np.stack([x, y, np.cross(x, y)], 1)
def eul_yxz(R):      # R = Ry(yaw) Rx(pitch) Rz(roll) → degrees [pitch, yaw, roll]
    p = math.asin(max(-1, min(1, -R[1, 2]))); y = math.atan2(R[0, 2], R[2, 2]); r = math.atan2(R[1, 0], R[1, 1])
    return [math.degrees(p), math.degrees(y), math.degrees(r)]

# ---- split into shots (camera cuts / tracking loss) ----
segs, cur = [], []
for f in F:
    if f.get('cut') and cur: segs.append(cur); cur = []
    cur.append(f)
if cur: segs.append(cur)

result = []
for seg in segs:
    good = [f for f in seg if 'w' in f and min(f['w'][i][3] for i in (11, 12, 23, 24)) > 0.5]
    if len(good) < 3 or seg[-1]['t'] - seg[0]['t'] < MIN_LEN: continue
    legs_ok = np.mean([min(f['w'][i][3] for i in (25, 26, 27, 28)) for f in good]) > 0.33
    # scale from leg length (median); upper-body-only shots scale by shoulder width instead
    if legs_ok:
        L = np.median([np.linalg.norm(V(f, 23) - V(f, 25)) + np.linalg.norm(V(f, 25) - V(f, 27)) for f in good]); k = LEG / L
    else:
        W = np.median([np.linalg.norm(V(f, 11) - V(f, 12)) for f in good]); k = 0.34 / W
    # true vertical: the camera may look up or down, so "up" is taken from the ground plane — the plane through
    # heels and toes in frames where both feet are planted (the two lowest points of each foot), averaged
    up = np.array([0, 1.0, 0])
    if legs_ok:
        ns = []
        for f in good:
            pts = np.array([V(f, i) for i in (29, 30, 31, 32)])
            if min(f['w'][i][3] for i in (29, 30, 31, 32)) < 0.4: continue
            c = pts.mean(0); _, sv, vt = np.linalg.svd(pts - c)
            nvec = vt[2] * (1 if vt[2][1] > 0 else -1)
            spread = np.linalg.norm(pts[0] - pts[1])                   # heels apart → well-conditioned plane
            if sv[2] < 0.03 and spread > 0.25 and nvec[1] > 0.8: ns.append(nvec)
        if len(ns) >= 3: up = nrm(np.median(np.array(ns), 0))
    # reference heading: the pelvis at the first good frame (yaw about the true vertical)
    f0 = good[0]
    left0 = V(f0, 23) - V(f0, 24); left0 = nrm(left0 - up * np.dot(left0, up))
    REF = frame(left0, up)                               # columns: left, up, forward
    toRef = REF.T
    rows = []
    for f in good:
        P = {i: toRef @ V(f, i) for i in range(33)}
        mh = (P[23] + P[24]) / 2; ms = (P[11] + P[12]) / 2
        trunk_up = nrm(ms - mh)
        Rp = frame(P[23] - P[24], nrm(trunk_up * 0.45 + np.array([0, 1.0, 0]) * 0.55))
        Rc = frame(P[11] - P[12], trunk_up)
        ear = (P[7] + P[8]) / 2
        Rh = frame(P[7] - P[8], nrm(np.cross(nrm(P[0] - ear), nrm(P[7] - P[8]))) * -1 + trunk_up * 0.0) if True else Rc
        # head: x = ears line, forward = ears → nose; up = forward × x ... build from x & forward
        hx = nrm(P[7] - P[8]); hf = nrm(P[0] - ear); hf = nrm(hf - hx * np.dot(hf, hx)); Rh = np.stack([hx, np.cross(hf, hx), hf], 1)
        rel_sc = Rp.T @ Rc; rel_h = Rc.T @ Rh
        # ground: lowest of heels / toes / ankles
        gy = min(P[i][1] for i in (27, 28, 29, 30, 31, 32)) if legs_ok else -LEG / k - ANKLE_H / k
        hipY = -gy * k                                     # pelvis height above ground in rig metres
        hy = max(-0.5, min(0.08, hipY - HIP0 - 0.02))
        base = np.array([0, HIP0 + hy, 0])
        def rig(i): return base + P[i] * k
        r = {'t': f['t'], 'hip': [0, hy, 0], 'pel': eul_yxz(Rp), 'rel_sc': rel_sc, 'rel_h': rel_h}
        for side, (ank, heel, toe) in (('lf', (27, 29, 31)), ('rf', (28, 30, 32))):
            a, h, t = rig(ank), rig(heel), rig(toe)
            fd = t - h; yaw = math.degrees(math.atan2(fd[0], fd[2])); pitch = math.degrees(math.atan2(fd[1], math.hypot(fd[0], fd[2])))
            lift = max(0.0, min(h[1], t[1]) - 0.0)
            r[side] = [a[0], lift, a[2], yaw, pitch if legs_ok else 0, 0]
        # right hand: grip at the palm, blade along pinky → index knuckles (exits by the index), edge = knuckle side
        w, ix, pk = rig(16), rig(20), rig(18); kn = (ix + pk) / 2
        grip = w + (kn - w) * 0.7
        d = nrm(ix - pk + (kn - w) * 0.35); e = nrm(kn - w); e = nrm(e - d * np.dot(e, d))
        r['sw'] = {'p': grip, 'd': d, 'e': e}
        wl, il, pl = rig(15), rig(19), rig(17); knl = (il + pl) / 2
        fl = nrm(knl - wl); nl = nrm(np.cross(il - wl, pl - wl))
        r['lh'] = {'p': wl + (knl - wl) * 0.7, 'f': fl, 'n': nl}
        r['tw'] = float(np.clip((0.2 - np.linalg.norm(grip - (wl + (knl - wl) * 0.7))) / 0.08, 0, 1))
        r['vis'] = float(np.mean([f['w'][i][3] for i in (15, 16, 25, 26, 27, 28)]))
        rows.append(r)
    # ---- smoothing (zero-phase moving average on vectors; rotations via their matrices) ----
    n = len(rows)
    def sm(get, setv, win=2):
        vals = [np.array(get(r), dtype=float) for r in rows]
        for i, r in enumerate(rows):
            lo, hi = max(0, i - win), min(n, i + win + 1)
            wts = np.array([1.0 / (1 + abs(j - i)) for j in range(lo, hi)])
            setv(r, sum(vals[j] * wts[j - lo] for j in range(lo, hi)) / wts.sum())
    for key in ('hip', 'lf', 'rf', 'tw'): sm(lambda r, key=key: r[key], lambda r, v, key=key: r.__setitem__(key, v))
    for key in ('p', 'd', 'e'): sm(lambda r, key=key: r['sw'][key], lambda r, v, key=key: r['sw'].__setitem__(key, v))
    for key in ('p', 'f', 'n'): sm(lambda r, key=key: r['lh'][key], lambda r, v, key=key: r['lh'].__setitem__(key, v))
    for key in ('rel_sc', 'rel_h'): sm(lambda r, key=key: r[key], lambda r, v, key=key: r.__setitem__(key, v))
    sm(lambda r: r['pel'], lambda r, v: r.__setitem__('pel', v))
    keys = []
    t0 = rows[0]['t']
    for r in rows:
        U, _, Vt = np.linalg.svd(r['rel_sc']); rsc = U @ Vt
        U, _, Vt = np.linalg.svd(r['rel_h']); rh = U @ Vt
        # split the pelvis→chest rotation evenly between spine and chest, pelvis→head over neck and head
        def half(R):
            ang = math.acos(max(-1, min(1, (np.trace(R) - 1) / 2)))
            if ang < 1e-6: return np.eye(3)
            ax = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2 * math.sin(ang))
            a = ang / 2; K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
            return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K
        hs, hh = half(rsc), half(half(rh))   # the head is noisy (hair, hat, blur): keep half of its motion
        lock_l = 1.0 if r['lf'][1] < 0.04 else 0.0; lock_r = 1.0 if r['rf'][1] < 0.04 else 0.0
        R3 = lambda v: [round(float(x), 3) for x in v]
        R1 = lambda v: [round(float(x), 1) for x in v]
        keys.append({'t': round(r['t'] - t0, 3), 'hip': R3(r['hip']), 'pel': R1(r['pel']), 'sp': R1(eul_yxz(hs)), 'ch': R1(eul_yxz(hs)),
                     'nk': R1(np.clip(eul_yxz(hh), -30, 30)), 'hd': R1(np.clip(eul_yxz(hh), -30, 30)),
                     'lf': R3(r['lf'][:3]) + R1(r['lf'][3:]), 'rf': R3(r['rf'][:3]) + R1(r['rf'][3:]), 'lk': [lock_l, lock_r],
                     'sw': {'p': R3(r['sw']['p']), 'd': R3(r['sw']['d']), 'e': R3(r['sw']['e'])},
                     'lh': {'p': R3(r['lh']['p']), 'f': R3(r['lh']['f']), 'n': R3(r['lh']['n'])},
                     'tw': round(float(r['tw']), 2)})
    print('segment', round(t0,2), 'up', [round(float(x), 3) for x in up], 'scale', round(float(k), 3))
    result.append({'t0': round(t0, 3), 't1': round(rows[-1]['t'], 3), 'fullBody': bool(legs_ok), 'scale': round(float(k), 3), 'keys': keys})

with open(out, 'w') as fo:
    fo.write('// Generated by tools/mocap/retarget.py from video pose tracking — do not edit by hand.\n')
    fo.write(f'export const {name.upper()} = ' + json.dumps({'fps': fps, 'segments': result}, separators=(',', ':')) + ';\n')
print('up', [round(float(x),3) for x in up]) if False else None
print(len(result), 'segments:', [(s['t0'], s['t1'], s['fullBody'], len(s['keys'])) for s in result])
