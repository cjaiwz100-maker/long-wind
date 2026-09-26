# 长风 · Long Wind — architecture & contracts

A lone wuxia swordsman (剑客: straight jian sword, conical bamboo douli hat, long layered robes with flowing
sash ribbons) fights mountain bandits on a vast golden-hour grassland. three.js r186, WebGL2, plain JS ES modules, Vite.
Goal: **extreme realism + extreme aesthetic polish**, matching or beating the reference `docs/ref/valley-*.png` (screenshots of a third-party site, kept out of the public repo)
(the "Sakura River Valley" site). Art/tech spec: `docs/BIBLE.md` (read it). Reference technique notes (`docs/ref-notes/*.md`) were a local teardown of the reference and are not published.

## Running & verifying

- Shared dev server: `http://127.0.0.1:5173` (already running; do NOT start another on 5173 — if it is down,
  start it with `npx vite --port 5173 --strictPort --host 127.0.0.1` in the background).
- Scenes: `src/scenes/<name>.js` default-exports `async function (app)`; open with `?scene=<name>`.
  Build content, `app.add(system)`, then `await app.ready()` (precompiles shaders, removes the loader, sets `window.__ready`).
- **Screenshot harness (real Apple GPU, headless Chrome):**
  `node tools/shot.mjs --scene <name> --out shots/<area>/<file>.png [--w 1600 --h 900] [--wait 2500] [--eval "<js>"] [--eval2 "<js>" --wait2 1000] [--q "k=v&k2=v2"]`
  Then **Read the PNG to look at it.** It prints console errors + `app.stats()` (fps, draw calls, tris). Exit 2 = errors/not ready.
  `--eval` runs after ready, e.g. `--eval "__app.setView({pos:[3,2,6],target:[0,1,0]})"`. Scenes can expose more hooks on `window`.
  Harness runs at pixel ratio 1 and locks adaptive resolution. `?freeze` stops game time.
- Iterate visually: screenshot → critique honestly against the bible + reference shots → improve. Several rounds.

## Ownership (only edit files you own; create new files only inside your area)

| key | area | owns |
|---|---|---|
| I | integrator | `index.html`, `src/main.js`, `src/core/app.js`, `globals.js`, `noise.js`, `assets.js`, `bus.js`, `wind.js`, `lamps.js`, `glsl.js`, `src/character/skeleton.js`, `src/scenes/full.js`, `src/scenes/sandbox.js`, `CONTRACTS.md`, `tools/*` |
| R | post-processing | `src/core/pipeline.js`, `src/core/post*.js` (new pass files), `src/scenes/post.js` |
| S | sky, lighting, shadows, atmosphere | `src/core/chunks.js`, `src/core/prelude*.js`, `src/core/atmosphere.js` (internals; keep API), `src/world/environment.js`, `src/world/sky*.js`, `src/world/shadows*.js`, `src/scenes/sky.js` |
| W | world | `src/world/terrain*.js`, `src/world/ground*.js`, `src/world/texbake*.js`, `src/world/layout.js`, `src/world/mountains*.js`, `src/world/rocks*.js`, `src/world/props*.js`, `src/scenes/terrain.js` |
| V | vegetation | `src/world/grass*.js`, `src/world/flora*.js`, `src/world/plumes*.js`, `src/world/flowers*.js`, `src/world/trees*.js`, `src/world/foliage*.js`, `src/world/interaction.js`, `src/scenes/grass.js` |
| C | character | `src/character/humanoid*.js`, `outfits*.js`, `cloth*.js`, `sword*.js`, `charmat*.js`, `modelSkin.js`, `bakedAnim.js`, `mixamoAnims.js`, `src/character/character.js`, `src/scenes/character.js`, `tools/mixamo/` |
| A | animation | `src/character/animator.js`, `src/character/clips/**`, `src/character/ik*.js`, `src/scenes/anim.js` |
| P | gameplay | `src/game/**` (input, camera, player, enemy, ai, combat, director, game.js), `src/scenes/combat.js` |
| U | UI + audio | `src/ui/**`, `src/audio/**`, `src/scenes/ui.js` |
| X | VFX | `src/fx/**`, `src/scenes/vfx.js` |

If you need something from another area that doesn't exist yet, write a small local shim inside your own area and
list the request under "REQUESTS" in your final report. Never edit someone else's file.

## BIBLE ↔ CONTRACTS reconciliation (read this)

`docs/BIBLE.md` is the authority for **look, techniques and numbers**. This file is the authority for **file paths,
ownership and APIs**. The bible's Appendix A module map is superseded as follows:
`src/render/pipeline.js` → `src/core/pipeline.js` (R) · `src/render/shadows.js` → `src/world/shadows.js` (S) ·
`src/core/env.js` → `src/world/environment.js` (S) · `src/core/prelude.glsl.js`, `chunks.js`, `patch.js` → S (`patchMaterial`
stays exported from `core/atmosphere.js`) · `src/core/wind.js`, `lamps.js` → exist (I) · `src/core/time.js` → `app.time`
(`hitstop(seconds)`, `setScale(k, lerpSeconds)`) · `src/world/ground.js` → `src/world/terrain.js` exports (W) ·
`src/veg/*` → `src/world/grass|plumes|flowers|trees*.js` (V) · `src/fx/interaction.js` → `src/world/interaction.js` (V) ·
`src/fx/ambient.js`, `src/fx/vfx.js` → X · `src/char/*` → `src/character/*` (C mesh/cloth/materials, A anim/moves/ik) ·
`src/game/*` → P, except `audio.js`/`hud.js` → `src/audio/`, `src/ui/` (U).
Bible names the post API `post.params / post.kick`: implement them as `pipeline.params` / `pipeline.fx.*` (a `kick()` alias is fine).
Bible `vfx.trail(ownerId) → {push(base, tip, t), end()}` is the canonical trail API (see VFX below).

**Shared GLSL**: guard every shared uniform declaration with `U(type, name)` from `core/glsl.js` (macro `WXU_<name>`), so
the prelude, `ATMOS_GLSL`, `WIND_GLSL` and your own chunks can coexist in one shader. Wind: `WIND_GLSL` + `windUniforms()`
(GPU) and `windGust/windSway/windVector/windFlutter` (CPU mirror) from `core/wind.js`. Lamps: `lamps.add/flash` (`core/lamps.js`).
**Uniform block `G`** (`core/globals.js`) follows bible §0.3. Modules may attach extra shared uniforms at runtime
in their own files (`G.tFoo = { value }`) — never edit `globals.js`; report additions.
**Layers** (bible §0.2) are in `LAYERS`: put grass/flowers on `MAIN_ONLY` (2), actors on `ACTORS` (3), blended VFX on
`TRANSPARENT` (1). The camera has all layers enabled; the pipeline narrows them per pass.

## Global rules

1. **HDR linear.** Everything renders into HalfFloat targets (MSAA is the post owner's call); tonemapping/grading happen only in `pipeline.js`.
   Materials output linear radiance. Sky and emissives may exceed 1.0 (bloom picks them up).
2. **Atmosphere everywhere.** Built-in materials: `patchMaterial(mat)` (from `core/atmosphere.js`). Custom ShaderMaterials:
   include `ATMOS_GLSL`, spread `atmosUniforms()`, and end with `col = wx_applyAtmosphere(col, worldPos)`.
   Use `addShaderHook(mat, key, fn)` for your own onBeforeCompile edits (it chains safely with patchMaterial).
3. **Shared uniforms** live in `G` (`core/globals.js`): time, sun, fog, wind, benders. Reference the same objects.
4. **Deterministic** randomness: `mulberry32(WORLD.seed + k)` from `core/noise.js`. CPU noise: `noise.simplex2/fbm2/ridged2`.
   GLSL noise: `GLSL_NOISE` (`wx_hash12`, `wx_vnoise`, `wx_fbm`, `wx_snoise`...).
5. **Performance budget** (Apple M-series, 1600×900): full game ≥ 60 fps; ≤ ~450 draw calls; grass ≤ ~2.5M tris near.
   Instancing/merging everywhere; shadows only where they matter; no per-frame allocations in hot loops.
6. Units: meters, seconds, radians. +Y up. Characters face +Z locally. `yaw = 0` faces +Z; `yaw = π` faces -Z.
7. three r186 notes: `PCFSoftShadowMap` is removed (use `PCFShadowMap`/`VSMShadowMap`); use `HDRLoader`
   (not RGBELoader); `renderer.compileAsync` exists; `import ... from 'three/addons/...'`.
8. No new npm dependencies without a strong reason (then list it in REQUESTS). No external network at runtime except Google Fonts.
9. Assets: Poly Haven CC0 in `public/assets/ph` via `core/assets.js` (`loadPBR(id)`, `loadModel(id)`, `loadHDR(id)`).
   Available ids: see `public/assets/ph/manifest.json`. Procedural generation is encouraged for everything else.

## Core API (exists — integrator)

`app` (`core/app.js`): `renderer, scene, camera, pipeline, world, time, G, params`, `add(sys)/remove(sys)`
(sys: `{update?(dt,t,app,rawDt), lateUpdate?(dt,t,app,rawDt)}`), `progress(p,label)`, `ready()`, `setView({pos,target,fov})`,
`freeze(bool)`, `stats()`, `debugControls()` (OrbitControls for debug scenes).
`app.time`: `t`, `real`, `scale`, `hitstop(seconds)`, `setScale(k, lerpSeconds)` (slow-mo). `dt` passed to systems is scaled.
`app.world`: `heightAt(x,z)`, `normalAt(x,z,out)`, `pathAt(x,z)`, `colliders: [{x,z,r}]` (static circles for movement + camera).

`bus` (`core/bus.js`): `bus.on(type, fn)`, `bus.emit(type, payload)`.

## Post-processing (R)

- `Pipeline` (`core/pipeline.js`): `new Pipeline(renderer)`, `setSize(w,h,pr)`, `render(scene,camera,dt)`, `params`
  (exposure, bloom, vol, warm, ao, sat, …), `fx.flash(i,color)`, `fx.impact(strength)` (radial blur + CA kick),
  `fx.kick({exposure, ca, radial, ms})`, `fx.setSlowmo(k)`, `fx.setDamage(k)`, `fx.fade(to,s,color?)`, `fx.letterbox(on)`,
  `depthTexture`, `sceneTexture`, `copyTexture` (half-res rgb + linear depth in a), `setShadowSources({far, near})`
  (lights whose shadow maps the volumetric shafts raymarch). Pass order/params: bible §2.2–2.4, §2.8–2.9.

## Sky, lighting, shadows, atmosphere (S)

- `createEnvironment(app, {mood})` (`world/environment.js`) → `{ sunFar, sunNear, sun (=sunFar), hemi, fill, sky,
  mood, setMood(name, seconds), setShadowFocus(vec3), update(dt) }`. Moods `golden|ember|blue|night|afternoon`
  (`?mood=`). Owns sky dome + painted clouds + sun/moon/stars (bible §3.1), keyframes → `G` + lights + `pipeline.params`
  (bible §3.4), env cube/PMREM (§2.7), dual shadow maps with texel snapping + refresh (§2.5), cloud shadows,
  `installChunks(app)` global ShaderChunk patches (§2.6) incl. atmosphere, lamp loop, `SUNLIGHT_TERMS` translucency,
  and `patchMaterial` (keep it working for built-in materials either way).

## World (W)

- `terrain.js`: `heightAt(x,z)`, `normalAt(x,z,out)`, `pathAt(x,z) → {dist,width}`, `groundInfo(x,z) → {grass,dry,rock,dirt,moisture,grassH}`,
  `isBlocked(x,z,margin)`, `createTerrain(app) → {mesh}` (registers `app.world.*`, bakes `G.tHeight/tGround/tSplat/uWorldRect`,
  bible §4.1–4.5). Terrain material: scanned + procedural ground sets blended by the splat bake, anti-tiling, macro
  variation, far "canopy" term that continues grass colour + honami to the horizon.
- `layout.js`: `LAYOUT` named places (spawn, old tree, pavilion, stele, duel circle, rock outcrops, road polyline, enemy spawns).
- `createMountains(app)` distant layered karst peaks fading into haze; `createRocks(app) → {colliders}` (scanned rocks);
  `createProps(app)` (pavilion 亭, stele, road markers, banners — optional).

## Vegetation (V)

- `createGrass(app) → { update(dt), setDensity(k) }` — GPU-procedural tiers (bible §5.2–5.4), wind from `WIND_GLSL`,
  actor push from `G.uActors`, interaction map, backlit translucency, honami sheen.
- `createInteraction(app)` (`world/interaction.js`, stub exists) → `{ setActor(i,x,y,z,r), clearActor(i), trample(x,z,r,s),
  cut(x0,z0,x1,z1,width), stain(x,z,r,amount), dust(x,z,r,amount), shock(x,z,strength), slash(x0,z0,x1,z1,strength,height), update(dt) }`.
- `createFlora(app)` wildflowers (higanbana etc.) + silver-grass plumes; `createTrees(app) → {colliders}` (hero golden tree + few).

## Character (C) — mesh, outfit, sword, secondary motion

```js
import { createCharacter } from './character/character.js';
const ch = await createCharacter({ kind: 'hero' | 'bandit' | 'bandit_heavy' | 'swordmaster', seed: 1 });
ch.group            // Object3D: add to scene; gameplay sets group.position / group.rotation.y
ch.rig              // { root, bones, skeleton } from createSkeleton() (skeleton.js contract)
ch.sword            // { object, base: Object3D, tip: Object3D, setDrawn(bool), drawn }  base/tip = blade segment for hits/trails
ch.update(dt, t)    // secondary motion (cloth, ribbons, hair, hat tassels) — call AFTER the animator each frame
ch.hurtCapsules(out = []) // world-space [{a: Vector3, b: Vector3, r, part: 'head'|'torso'|'arm'|'leg'}]
ch.flash(color?, strength?) // brief hit tint
ch.setVisible(bool); ch.dispose()
```
Model skins + mocap layers: `modelSkin.js` dresses the rig in a rigged GLB and plays baked clips over it
(`bakedAnim.js`, tables `BAKED` in `character.js`). Sources: the skin's own Tripo clips, or Mixamo takes (`src: 'mx:<key>'`)
from `assets/anims/mixamo.glb`, retargeted per skin at load by `mixamoAnims.js`. The pack is built by
`tools/mixamo` (download → `ingest.mjs` → `clips.json` → `convert.mjs`, which ships only the keys the tables use).
A travelling mocap action supplies the animator's root motion (`anim.rootSource`), so its footwork stays planted.

## Animation (A)

```js
import { Animator, CLIPS } from './character/animator.js';
const anim = new Animator(ch.rig, { heightAt });   // works with createMannequin() too
anim.play(name, { fade = 0.1, speed = 1, loop })   // action clip (overrides locomotion until it ends)
anim.setLocomotion({ speed, dirX, dirZ, combat, turn }) // speed m/s; dir in character-local space (+Z fwd, +X left)
const out = anim.update(dt, worldGroup)             // → { rootMotion: Vector3 (local m this frame), rootYaw: rad, events: [{type, clip}] }
anim.current / anim.time / anim.normalizedTime / anim.isActing
```
Clip names (contract): `idle, combatIdle, walk, run, sprint, walkBack, strafeL, strafeR, turnL, turnR,
dodgeF, dodgeB, dodgeL, dodgeR, attack1, attack2, attack3, attack4, heavy, heavyCharge, thrust, special,
block, blockHit, parry, parried, hitFront, hitBack, hitHeavy, stagger, knockdown, getUp, death, deathBack,
draw, sheathe, taunt, victory, enemyAttack1, enemyAttack2, enemyHeavy, enemyThrust`.
`CLIPS[name].meta` = `{ duration, loop, type: 'light'|'heavy'|'thrust'|'special'|'enemy', hit: [[t0,t1],...] seconds,
combo: [t0,t1] (input window to chain), cancel: t (earliest cancel into dodge/block), damage, posture, reach (m),
lunge (m, root motion), unblockable?: bool }`. Events: `hitOn, hitOff, comboOpen, comboClose, step (foot:'L'|'R'), whoosh, end`.

## Gameplay (P)

`createGame(app, { env, grass, vfx, hud, audio }) → { update(dt) }` (`game/game.js`) — used by `scenes/full.js`.
Owns: input (keyboard+mouse, pointer lock; gamepad nice-to-have), third-person camera (orbit, collision, lock-on, shake,
FOV kicks, kill-cam), player controller & combat state machine, enemy AI (bandits: approach, circle, telegraph, attack,
block, stagger; "only 1–2 attack at once"), hit detection (blade segment sweep vs hurt capsules), damage/posture, parry
(perfect-parry window), dodge i-frames, hit-stop, slow-mo, waves/director, writes `G.uBenders`. Emits bus events.

Controls: WASD move · Mouse look · LMB light combo · hold LMB/RMB-tap heavy · RMB hold block (tap at impact = parry)
· Space dodge · Shift sprint · Q/Tab lock-on · E sword-qi special (when focus meter full) · F draw/sheathe · Esc pause.

## UI + Audio (U)

`createHUD(app) → {update(dt)}` (`ui/hud.js`) ink-brush minimal HUD, title screen, wave banners (calligraphy), pause,
controls hint, damage numbers optional, victory/defeat. `createAudio(app) → {update(dt)}` (`audio/audio.js`) fully
synthesized WebAudio: wind ambience synced to `G.uWind`, grass rustle, footsteps, sword whoosh/clash/parry ring,
flesh hits, guqin/xiao-like pentatonic ambient music (Karplus–Strong). Both subscribe to the bus only.

## VFX (X)

`createVFX(app, { interaction? }) → { update(dt), trail(ownerId) → { push(base: Vector3, tip: Vector3, t), end(), setIntensity(k) },
sparks(pos, normal, power), blood(pos, dir, amount, ink = false), dust(pos, amount), clippings(points[], dir),
shockwave(x, z, strength), hitGlow(pos, size), leafBurst(pos, n), qiWave(origin, dir) → {update(dt), dead, pos} }`
(bible §6.2) and `createAmbient(app) → { update(dt) }` (bible §6.1: motes lit through shadows, seeds, leaves from the
tree, fireflies at blue hour/night, low mist cards). Soft particles read `pipeline.copyTexture` (linear depth in a) or
`pipeline.depthTexture`. Sparks/qi call `lamps.flash()`. Blood/dust also stamp `interaction.stain/dust` when given.

## Events (bus)

| event | payload |
|---|---|
| `game:state` | `{ state: 'title'|'playing'|'paused'|'victory'|'defeat' }` |
| `wave:start` / `wave:clear` | `{ index, title, count }` |
| `player:hp` | `{ hp, max }` · `player:focus` `{ value, max }` |
| `player:attack` | `{ clip, heavy }` · `player:dodge` `{ dir }` · `player:block` `{ on }` |
| `player:parry` | `{ perfect, pos }` · `player:hurt` `{ damage, pos, dir }` · `player:death` `{}` |
| `player:step` | `{ foot, pos, speed }` |
| `sword:whoosh` | `{ speed, heavy, pos }` · `sword:clash` `{ pos, strength }` |
| `enemy:spawn` | `{ id, kind, pos }` · `enemy:telegraph` `{ id, pos, unblockable }` |
| `enemy:hit` | `{ id, pos, dir, damage, kill, part }` · `enemy:death` `{ id, pos }` · `enemy:parried` `{ id, pos }` |
| `lockon` | `{ id|null }` · `special` `{ pos, dir }` |
| `mood` | `{ name, seconds }` (director → environment) · `wind` `{ strength, ease }` |
