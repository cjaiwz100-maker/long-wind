# Mixamo mocap pipeline

1. **Download** takes from mixamo.com (X Bot, FBX, *without skin*, 30 fps, no keyframe reduction). Any logged-in
   export works; files land in `~/Downloads` named after the product.
2. **Ingest**: `node tools/mixamo/ingest.mjs "<motion number>|<product name>" …` moves them to `src/<number>.fbx`
   (gitignored — raw Mixamo files are not redistributed).
3. **Name** the take in `clips.json`: `"key": { "num": "<motion number>", "desc": "…" }`. A composite plays segments
   of other takes back to back: `"key": { "compose": [["take", t0, t1], …], "blend": 0.12 }`.
4. **Pack** (dev server running): `node tools/mixamo/convert.mjs` → `public/assets/anims/mixamo.glb`, only the keys
   `src/character/character.js` references as `'mx:<key>'` (`--all` packs everything, for auditioning). Right-hand
   fingers are dropped (the sword grip owns them) and keys are thinned within 0.3° / 3 mm.
5. **Use** it in a `BAKED` table (`character.js`): `{ src: 'mx:key', t0, t1, key | keys | sync, grip, mask, … }` —
   see `src/character/bakedAnim.js`. `?scene=anim&mesh=char&kind=<kind>&mxall=1` retargets every packed take so
   `__anim.ch.skin.baked.add(clip, spec)` can audition one live; `?scene=rawclip&mx=<key>&clip=mx:<key>` shows a
   take on a bare model.
