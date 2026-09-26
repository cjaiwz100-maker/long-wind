# 风过草原 · Wind over the Steppe — Art & Tech Bible

Spec for a three.js (r186, already in `node_modules`, Vite, ES modules) action game: **a lone wuxia swordsman (剑客) fights
bandits on a vast golden-hour grassland**, with photographic golden-hour light and ink-painting depth, aiming to match or beat
the reference "Sakura River Valley" (valley.mengto.here.now). Everything below comes from the six teardown notes
(`post-pipeline.md`, `sky-lighting.md`, `terrain-materials.md`, `vegetation-wind.md`, `water-fx-weather.md`,
`characters-camera.md`), verified against the reference bundle and three r186 sources.

**How to use this document.** Parallel implementers own the modules in Appendix A and must honour the shared contracts in §0.
Numbers are starting values to tune against the acceptance checklist in Appendix C. Where the text says **MUST**, other modules
depend on it. All colours are **linear** floats unless marked sRGB. Units are metres, seconds and radians, with Y up.

> Protagonist: the user wrote 剑客 and the package is `wuxia-grassland`, so the canonical hero is a **Chinese wuxia swordsman
> with a jian** (straight double-edged sword). The generated brief also said "samurai/ronin". A katana ronin is only a
> reskin: blade mesh, two-handed grip IK (§7.4), and a straw kasa instead of the douli.

---

## 0. Conventions and shared contracts (read first)

### 0.1 Coordinate frame and world anchors
| thing | value |
|---|---|
| Sun direction (to the sun), golden hour | `SUN_DIR = normalize(-0.6, 0.165, -0.78)`, elevation **9.5°**, toward −x −z |
| Ground shadow direction (object → shadow tip) | `normalize(-SUN_DIR.xz)` = (0.609, 0.793) |
| Wind direction (blowing toward) | `WIND_DIR = (0.62, 0.78)` (XZ, unit). **The wind blows from the sun toward the default camera.** Grass leans toward a player who faces the sun, so its backlit tips face the lens. |
| Duel knoll (hero set) | centre (0, 0). Lone golden tree near (−20, −14). Stone stele near (4, 3). |
| Player spawn | (0, ground, 40), facing −z (into the sun, looking at the knoll) |
| Playable radius | 180 m soft boundary (wind pushback, fog thickening, grass gets taller and the ground rises) |
| Camera | `PerspectiveCamera(48°, aspect, near 0.3, far 7000)` |

### 0.2 Render layers (MUST)
| layer | name | contents | rendered by |
|---|---|---|---|
| 0 | `L_WORLD` | terrain, rocks, trees, props, mountains, sky | main opaque pass; far-shadow refresh |
| 1 | `L_TRANSPARENT` | all blended or additive VFX, mist cards, motes, trails, sparks, ink/blood mist, rain | transparent pass (after the `rtCopy` snapshot) |
| 2 | `L_MAIN_ONLY` | grass tiers, flowers, silver grass, small debris, settled leaves | main opaque pass; far-shadow refresh (they don't cast anyway) |
| 3 | `L_ACTORS` | swordsman, enemies, weapons, cloth, hair | main opaque pass; **near-shadow refresh only** |
| 4 | `L_MIRROR_ONLY` | reserved for the phase-2 stream mirror proxy | mirror pass |

* Main camera layers are {0,2,3} for the opaque pass and {1} for the transparent pass.
* **Every light MUST call `light.layers.enableAll()`.** three r186 collects lights only if they pass the viewing camera's
  layer test (`WebGLRenderer.projectObject`). A light missing from one render changes the light hash, which forces
  program re-acquisition every frame.
* Shadow casters are filtered by the **viewing camera's** layers (`WebGLShadowMap.renderObject`). The two-map shadow
  scheme in §2.5 depends on this.

### 0.3 Global uniform block `G` (MUST, `src/core/globals.js`)
There is one JS object whose `{value}` objects are shared by reference into every material. ShaderMaterials use
`uniforms: {...G, local}`. Built-in materials get `onBeforeCompile → Object.assign(shader.uniforms, G)`. Defaults are the
golden-hour key (u = 0.70), so shaders compile with the hero look.

| uniform | default | notes |
|---|---|---|
| `uTime` | 0 | **sim time**: frozen during hit-stop and scaled in slow-mo. Grass, wind and particles freeze with the world. |
| `uRealTime` | 0 | wall time. UI shimmer and loader only. |
| `uSunDir` | SUN_DIR | key-light direction (the moon at night) |
| `uSunCol` | (5.6, 3.55, 1.75) | HDR sun radiance for custom shaders (= keyframe `L` ⊙ (1.697, 1.455, 1.129)) |
| `uFogCool` / `uFogWarm` | (0.33,0.43,0.50) / (1.05,0.66,0.36) | directional fog colours |
| `uFogParams` | (0.0014, 0.035, 0, 2.4e-4) | height-fog density, falloff, base y, linear haze |
| `uWind` | (0.62, 0.78, 1.0, 0) | xy direction, z strength (0.6 calm … 1 default … 2.6 storm) |
| `tWindNoise` | 256² RG8 tileable fbm | gust puffs (§5.1) |
| `uMist` | 0.6 | ground-mist multiplier |
| `uCloudShadow` | (0.5, 800, 0.0022, 6) | x strength, y cloud height m, z frequency 1/m, w drift m/s |
| `uAmbK` | (1,1,1) | ambient multiplier for custom shaders |
| `uNight`, `uStorm`, `uRain`, `uWet`, `uFlash` | 0 | weather/day state |
| `uFlashDir`, `uMoonDir`, `uSunVis` | — | as in the reference |
| `uSkyZen`, `uSkyUp`, `uCloudLit`, `uCloudShade`, `uHorizonGlow` | §3 table | sky palette |
| `uLamps[8]` vec4, `uLampC[8]` vec3, `uLampN` int, `uLampOn` float | — | virtual point lights (sparks, torches) |
| `tHeight` | R32F 2048² | ground height over ±512 m (§4.3) |
| `tGround` | RGBA8 2048² | R grass density, G grass height factor, B moisture/green bias, A cavity AO |
| `tSplat` | RGBA8 2048² | terrain layer weights: R lush, G dry thatch, B rock, A dirt/road |
| `uWorldRect` | (−512, −512, 1024, 1/1024) | xz origin, size and inverse size of the three world textures |
| `tInteract` | RGBA16F 512² | R trample, G cut, B blood/ink, A scorch/dust. Covers ±32 m around the player (§5.6). |
| `uInteractRect` | (x0, z0, 64, 1/64) | texel-snapped |
| `uActors[8]` vec4 | w=0 means inactive | xyz = actor root (feet centre) world, w = radius (≈0.45) |
| `uShock[4]` vec4 | — | x, z, startTime (sim), strength. Expanding shockwave rings. |
| `uSlash[4]` vec4 + `uSlashB[4]` vec4 | — | slash chord (x0,z0,x1,z1), (startTime, strength, height, 0). Travelling radial gust along the arc. |
| `uCamGround` | — | camera xz and radius 0.8. Grass also bends away from the lens. |
| `uWetBias` | per material | standing wetness (sweat, blood, rain) |

`G` is written by exactly one module per group. `env.js` writes sun, fog, sky, weather and post keys. `interaction.js`
writes actors, shock, slash and trample. `main.js` writes time.

### 0.4 GLSL prelude (MUST, `src/core/prelude.glsl.js`, appended to `ShaderChunk.common`)
The prelude holds the uniform declarations above plus the helpers in §2.6 (`hash12`, `hash13`, `hash22`, `vnoise`, `fbm3`,
`windGust`, `windSway`, `skyFogColor`, `cloudShadow`, `applyAtmosphere`, `groundHeight`, `groundInfo`, `rainRipples`,
`ign`).

### 0.5 Shared JS APIs (MUST, signatures are frozen)
```js
// world/ground.js
heightAt(x, z)            // analytic, ≤4 mm from the rendered mesh inside ±160 m
normalAt(x, z, eps=0.6)   // central difference
groundInfo(x, z)          // {grass, dry, rock, dirt, moisture, grassH}
isBlocked(x, z, margin)   // rocks, tree trunks, stele, pavilion
rng(seed)                 // mulberry32. Every scatter has its own fixed seed.
// core/wind.js — exact CPU mirror of GLSL windGust (same noise bytes)
windGust(x, z, t)  ->  scalar      windVector(x, z, t) -> THREE.Vector2
// core/lamps.js
lamps.add({pos | get:()=>Vector3, color:[r,g,b], weight, flicker=0, ttl=Infinity}) -> handle
// fx/vfx.js
vfx.sparks(pos, normal, power)        vfx.trail(ownerId) -> {push(base, tip, t), end()}
vfx.blood(pos, dir, amount, ink=false) vfx.dust(pos, amount)   vfx.clippings(points[], dir)
vfx.shockwave(x, z, strength)          vfx.hitGlow(pos, size)   vfx.leafBurst(pos, n)
// render/post.js
post.params  // {exposure, bloom, vol, warm, ao, ca, vigFloor, sat, fade, fadeMist, letterbox, lowHealth}
post.kick({exposure:+0.25, ca:0.02, radial:{x,y,strength}, ms:90})
// core/time.js
time.hitStop(ms) ; time.slowMo(scale, ms, easeMs) ; time.sim, time.real, time.dtSim, time.dtReal
```

---

## 1. Visual direction

### 1.1 Mood
*"The wind arrives before the blade."* An endless golden steppe at the last half hour of sun. A lone 剑客 stands with a
straw 斗笠 hat and a pale robe, lit from behind so his outline burns gold. Grass rolls in bands of light toward the lens.
Distant ridges stack in blue-grey ink washes. Stillness breaks into short, precise violence: sparks, a crimson thread of
ink, then the grass closes again.

* **Film references:** Zhang Yimou's *Hero* (英雄), especially the golden-leaf duel, for colour-coded duels and leaves in
  the wind. *The Assassin* (刺客聂隐娘) for stillness, wind and long lenses. Ghost of Tsushima for pampas fields and wind as
  guidance. Sekiro for weight and parry sparks. Chinese *shan shui* for receding haze planes.
* **Rule of the look:** photographic light (HDR, physically plausible falloff) with painted air (directional
  warm/cool fog, stepped mountain haze, gouache clouds).

### 1.2 Time of day
* The default and hero mood is **u = 0.70**: sun at 9.5° elevation, azimuth toward −x −z, contre-jour for the default view.
* Moods are switchable per encounter with smooth transitions (§3.5): **Golden** (default), **Ember sunset** (u 0.742,
  for the boss), **Blue hour** (u 0.785, finale), plus an optional **Night** with fireflies and an optional **Storm**
  overlay.
* The world clock does **not** run a 510 s day. Time drifts at most +0.004 u per real minute inside a mood, so shadows
  move a little.

### 1.3 Composition rules (for camera, level and encounter design)
1. **Contre-jour first.** The default camera looks into the sun ±50°. Spawns, the road and the knoll are laid out so
   enemies approach **from the sun side** and read as dark silhouettes against amber haze.
2. **Horizon on the lower third.** The camera pivot sits low (1.45 m). Sky, clouds and sun glow take 55–65% of the frame.
3. **Five depth planes:** foreground blades, which may be bokeh-soft but are never blurred by DOF, fighters at 4–15 m,
   the lone tree and stele at 20–80 m, rolling swells at 100–800 m, and 4 mountain ribbons at 1.8–4.2 km.
4. **One warm accent per shot.** The hero's crimson sash and sword tassel, a higanbana patch, or sparks. Everything else
   stays gold, olive, slate and ivory.
5. **Wind is the guide.** Gust fronts roll toward the camera. Leaves and seeds stream from the tree through the fight area.

### 1.4 Palette (linear → sRGB)
**Light and air (golden hour, straight from the reference)**
| role | linear | sRGB |
|---|---|---|
| Sun light (three.js `DirectionalLight`) | (1, 0.74, 0.47) × 3.3 | #ffdfb6 |
| Shader sun radiance `uSunCol` | (5.6, 3.55, 1.75) | hot, HDR |
| Fog toward sun | (1.05, 0.66, 0.36) | #ffd4a2 |
| Fog away from sun | (0.33, 0.43, 0.50) | #9bafbc |
| Horizon glow | (1, 0.55, 0.30) | #ffc495 |
| Mid sky / zenith | (0.26,0.36,0.45) / (0.085,0.16,0.27) | #8ba2b3 / #526f8e |
| Cloud lit / shade | (1.3,0.94,0.60) / (0.34,0.33,0.42) | cream-gold / #9e9bad violet-grey |
| Hemisphere sky / ground | (0.42,0.55,0.68) / **(0.21,0.175,0.08)** (golden meadow bounce, changed from the ref) | #adc4d7 / #7e7458 |
| Anti-solar fill | (0.62,0.60,0.58) × 0.42 | — |
| Warm mist (fades) | (0.80,0.73,0.62) | #e7dece |

**Ground and vegetation**
| role | root | mid | tip | tip sRGB |
|---|---|---|---|---|
| Golden steppe grass (~62%) | (0.035,0.028,0.010) | (0.26,0.19,0.06) | (0.62,0.46,0.16) | #ceb56f |
| Sun-bleached seed tips (~15%) | same | (0.35,0.27,0.10) | (0.78,0.66,0.36) | #e5d4a2 |
| Late-green in hollows (~23%) | (0.03,0.045,0.012) | (0.12,0.16,0.04) | (0.30,0.34,0.09) | #959e55 |
| Far-field canopy average | (0.16,0.12,0.045) ± macro | | | #6f613c |
| Dry thatch ground / packed road | (0.14,0.10,0.05) / (0.16,0.12,0.08) | | | #6f6150 (road) |
| Rock / ochre lichen | (0.18,0.17,0.155) / (0.30,0.24,0.10) | | | #76736e |
| Silver-grass plume (芒) | (0.85,0.75,0.55) | | | #ede1c4 |
| Golden tree leaves (胡杨) | (0.62,0.40,0.06) … (0.90,0.66,0.16) | | | #cfaa46 … |
| Flowers: higanbana / white / yellow | (0.58,0.02,0.012) / (0.90,0.88,0.79) / (0.89,0.59,0.04) | | | #c8271d / #f3f1e6 / #f2ca38 |
| Distant mountain forest | (0.035,0.05,0.045) | | | #353f3c (haze carries the value) |

**Characters and VFX**
| role | linear | sRGB |
|---|---|---|
| Hero outer robe, 月白 pale ash-blue (cool complement to the gold) | (0.42,0.44,0.45) | #adb0b2 |
| Hero inner layer / trousers, ink indigo | (0.035,0.045,0.07) | #353c4b |
| Sash and sword tassel (the accent) | (0.30,0.03,0.025) / (0.45,0.02,0.02) | #95302c / #b32727 |
| Straw douli | (0.42,0.32,0.17) | #ad9973 |
| Skin | (0.33,0.20,0.14) | #9b7c69 |
| Bandit leather / cloth | (0.09,0.06,0.04) / (0.12,0.10,0.08) | #554538 / #615950 |
| Fresh blood / ink-blood | (0.25,0.012,0.01) / (0.10,0.005,0.006) | #891d19 / #591012 |
| Spark core (HDR) | (1.0,0.6,0.25) × 8–20 | #ffcb89 hue |
| Sword trail core (HDR) | (1.0,0.85,0.65) × 3–6, tinted toward `uSunCol` | — |

**Value discipline.** Albedos are low. No natural albedo exceeds 0.62 in red except plumes and snow. Brightness comes from
sun, backlight and atmosphere. Validate with a hidden 0.18-grey card: under the golden sun it must show sRGB ≈ 150–175
after the grade.

### 1.5 What we borrow from the reference, and what we must beat
**Borrow as is:** the `G` uniform block and ShaderChunk patching, the dummy `Fog` switching `applyAtmosphere` into
every material, directional warm/cool fog, the 3-lobe sun sky with painted clouds, stepped mountain ribbons, the HDR
pipeline (copy→transparent→shadow-raymarched shafts→SSAO→dual bloom→manual ACES+grade→FXAA+sharpen), `sunBack`/`sunWrap`
translucency, untextured dome-normal grass, the one shared wind field (GPU and CPU), shadow-tested motes, the camera-box
particle wrap, `(1−r²)²` glow windows, the virtual lamp array, the spring on garments, the precompile/ensō loader, and
adaptive resolution.

**Beat it on:**
1. grass that covers a whole plain: GPU-procedural tiers to the horizon (§5);
2. visible honami (light waves) and a travelling sway wave fixed to move downwind;
3. grass that reacts to combat: push, trample, cut, shockwave, slash gusts;
4. moving character shadows: a dual shadow map (§2.5);
5. moving cloud shadows sweeping the plain;
6. volumetric history with reprojection, since our camera never stops;
7. a golden-grass-aware grade;
8. combat VFX that belong to the same light (§6.2).

---

## 2. Rendering architecture

### 2.1 Renderer (`src/render/renderer.js`)
```js
const renderer = new THREE.WebGLRenderer({ canvas, antialias:false, powerPreference:'high-performance', stencil:false, depth:true });
renderer.outputColorSpace = THREE.SRGBColorSpace;   // the final pass writes already-encoded sRGB via a raw ShaderMaterial
renderer.toneMapping = THREE.NoToneMapping;          // ACES is done by hand in the composite
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;        // r186: hardware-compare DepthTexture (PCFSoft is removed)
renderer.shadowMap.autoUpdate = true;                // per-light gates (shadow.autoUpdate=false + needsUpdate) do the throttling
renderer.info.autoReset = true;
renderer.setPixelRatio(1);                           // we size the drawing buffer ourselves (§2.9)
scene.fog = new THREE.Fog(0xffffff, 1, 2);           // DUMMY. It only defines USE_FOG so fog_fragment → applyAtmosphere runs.
```
Textures: `createImageBitmap(blob,{imageOrientation:'none',premultiplyAlpha:'none',colorSpaceConversion:'none'})`,
`flipY=false`, anisotropy `min(16, max)`, trilinear mips. Colour maps use sRGB and data maps use `NoColorSpace`. Normal maps
are **packed RG = normal XY, B = roughness**, with Z reconstructed (chunk patch §2.6).

### 2.2 Render targets (`src/render/pipeline.js`)
Here `K = max(0.5, min(dpr, tier.dprCap) · scale)`. Full res is `W = round(cssW·K)`, `H = round(cssH·K)`. Half res is
`hw = round(cssW·min(K,1.3)·0.5)`, likewise `hh`. All RTs are `HalfFloatType RGBA`, Linear/Linear, no depth, no mips
unless noted.

| RT | size | contents |
|---|---|---|
| `rtScene` | W×H + `DepthTexture(FloatType, DepthFormat)` | linear HDR scene (opaque, then transparents on top) |
| `rtCopy` | hw×hh | rgb = opaque colour, **a = linear view depth (m)** |
| `rtVol`, `rtVol2` | hw×hh | shafts, then the bilateral ping-pong |
| `rtHistA`, `rtHistB` | hw×hh | shaft history (reprojected, §2.4.2) |
| `rtAO`, `rtAO2` | hw×hh (RG16F is enough) | SSAO, then the blur |
| `mips[0..5]`, `ups[0..4]` | hw×hh halved per level (min 2) | bloom |
| `rtLDR` | W×H **RGBA8** | graded sRGB, luma in alpha (FXAA input) |
| `rt1x1` | 1×1 RGBA8 | throwaway target for shadow-only refresh renders (§2.5) |

There is **no MSAA.** three r186 invalidates the multisampled colour after resolve, which breaks the
opaque→copy→transparent-into-the-same-RT pattern. Grass anti-aliasing comes from blade widening (§5.4), FXAA, and the
optional TAA (§2.4.8).

### 2.3 Frame order
```
0  env.update()          keyframes → G, lights, post params; env cube re-capture only when sky params changed
1  interaction.update()  stamps into tInteract (trample/cut/blood), uActors, uShock, uSlash
2  NEAR SHADOW           every frame: snap sunNear, render(scene, camActors[layers {3}]) → rt1x1   (§2.5)
3  FAR SHADOW            on demand:   render(scene, camWorld[layers {0,2}]) → rt1x1
4  OPAQUE                camera.layers = {0,2,3} → rtScene (colour + D32F)
5  COPY                  rtScene.rgb + linearised depth → rtCopy (half)
6  TRANSPARENT           camera.layers = {1}, autoClear=false → rtScene
7  VOLUMETRIC            26-step shadow raymarch (far × near maps) → blur H,V → reprojected temporal blend
8  SSAO                  8 samples → blur H,V
9  BLOOM                 bright pass (scene + shafts) → 5 downsamples → 5 upsamples
10 COMPOSITE             CA, AO, shafts, bloom, veil, exposure, WB, ACES, grade, vignette, radial-hit blur, letterbox, sRGB → rtLDR
11 FINAL                 FXAA + unsharp mask + film grain + dither + fade → canvas
```
* Every post pass shares one fullscreen triangle or quad and one ortho camera, with `depthTest:false, depthWrite:false`.
* **Opaque draw order (early-Z):** set `renderOrder` to actors −5, grass L0/L1/L2 −4/−3/−2, rocks/props/tree −1,
  terrain 0, mountains 5, sky 10.
  * The sky draws **last** among opaques with depth test on. Its vertex shader outputs `p.xyww`, which is depth 1 and
    passes `LessEqual` against the clear value. The cloud shader (about 10 noise taps) then runs only where no geometry
    covers the pixel.
  * Terrain drawn after grass skips most of its expensive fragments.

### 2.4 Post passes (exact)
#### 2.4.1 COPY
```glsl
float z = texture(tDepth, vUv).x*2.0-1.0;  float lin = 2.0*n*f/(f+n-z*(f-n));
gl_FragColor = vec4(texture(tColor, vUv).rgb, lin);
```

#### 2.4.2 VOLUMETRIC SHAFTS (half res)
Based on the reference `mVol`, with three changes: a near-map multiply, cloud shadow, and plains density.
```glsl
float lin = texture(tDepth, vUv).a;
vec4 vd = uInvProj*vec4(vUv*2.0-1.0, 1.0, 1.0); vec3 vdir = normalize(vd.xyz/vd.w);
vec3 rd = normalize(mat3(uCamWorld)*vdir);
float tMax = min(lin/max(-vdir.z,1e-3), 220.0);
const int N = 26;                       // tier: 32/26/18/12
float j = ign(gl_FragCoord.xy + uFrame*5.588238), dt = tMax/float(N), acc = 0.0, trans = 1.0;
for (int i=0;i<N;i++){
  vec3 p = cameraPosition + rd*((float(i)+j)*dt);
  vec4 s1 = uShadowMatFar*vec4(p,1.0);  float lit = 1.0;
  if (all(greaterThan(s1.xyz, vec3(0.0))) && all(lessThan(s1.xyz, vec3(1.0)))) lit = texture(tShadowFar, vec3(s1.xy, s1.z-0.0015));
  vec4 s2 = uShadowMatNear*vec4(p,1.0);
  if (all(greaterThan(s2.xyz, vec3(0.0))) && all(lessThan(s2.xyz, vec3(1.0)))) lit *= texture(tShadowNear, vec3(s2.xy, s2.z-0.0008));
  lit *= cloudShadow(p);
  float y = max(p.y - uGroundY, 0.0);    // uGroundY = ground height under the camera (plains are not at y=0)
  float dens = 0.32*exp(-y*0.05)
             + 0.75*smoothstep(0.38,0.82, vnoise(p.xz*0.03 + uTime*vec2(0.04,0.02)))*exp(-y*0.14)   // drifting pollen/mist banks
             + 0.25*uDustAmt*exp(-y*0.5);                                                          // combat dust (0..1, decays 1.5 s)
  acc += lit*dens*trans*dt;  trans *= exp(-dens*dt*0.004);
}
float mu = dot(rd,uSunDir), g = 0.8;
float hg = (1.0-g*g)/pow(1.0+g*g-2.0*g*mu,1.5)/12.566;
gl_FragColor = vec4(uSunCol*acc*(hg*0.8+0.035)*0.0054, 1.0);
```
* **Bilateral blur:** 9 taps, `w = exp(-i²·0.12)/(1+|d-d0|/max(d0,1)·8)`, spacing 1.5 texels.
* **Temporal (improves on the reference):** reproject rather than reset history on rotation.
  ```glsl
  vec3 wp = uCamPos + rd*(lin/max(-vdir.z,1e-3));        // lin from rtCopy.a; sky pixels use lin≈far (direction reprojection)
  vec4 pc = uPrevViewProj*vec4(wp,1.0); vec2 puv = pc.xy/pc.w*0.5+0.5;
  vec3 h = texture(tHist, puv).rgb;
  vec3 mn = min9(cur 3x3), mx = max9(cur 3x3);  h = clamp(h, mn, mx);        // neighbourhood clamp kills ghosts
  float k = (any(lessThan(puv,vec2(0))) || any(greaterThan(puv,vec2(1))) || !histValid) ? 1.0 : 0.22;
  out = mix(h, cur, k);
  ```
* The sun raymarch samples **both** shadow maps, so the swordsman and his raised blade carve shafts.

#### 2.4.3 SSAO (half res)
Keep the reference algorithm: 8 golden-spiral samples, depth-derived normals, IGN rotation. Grass tuning:
`R = clamp(0.5 + 0.02·dist, 0.5, 1.6)`, occlusion bias `0.03 + 0.002·dist`, composite strength `uAO = 0.55`, fade out
between 60 and 150 m. Blur is bilateral H+V at 1.2 texels. Contact AO for characters is also done analytically (§5.5), so
SSAO stays gentle on the noisy blade field.

#### 2.4.4 BLOOM
* **Bright pass:** 4 bilinear taps at ±1 texel. `c += tVol` before the threshold. `c = min(c, 60)`. Rec.709 luma soft
  knee: `k = max(l−0.9,0); k = k²/(k+1.2); out = c·k/l`.
* **Chain:** 5 Kawase downsamples `(4·centre + 4 diagonals)/8`, then 5 tent upsamples (axial ×2, diagonal ×1, /12),
  `ups[d] = mips[d] + tent(coarser)·0.85`. Intensity `uBloom = 0.055`.

Only real highlights bloom: the sun, blade glints, sparks and the trail core. Softness comes from the air, not from blur.

#### 2.4.5 COMPOSITE (order is law)
```glsl
// 1 chromatic aberration (radial², plus a hit kick)
vec2 cc = uv-0.5; float r2 = dot(cc,cc); vec2 ca = cc*r2*(0.0065 + uCAKick);
vec3 col = vec3(tex(uv-ca).r, tex(uv).g, tex(uv+ca).b);
// 1b radial hit-blur (only while uRadial.z > 0): 8 taps toward uRadial.xy, strength ≤ 0.035, decays in 120 ms
// 2 AO
col *= mix(1.0, pow(ao,1.4), uAO*(1.0-smoothstep(60.0,150.0,linD)));
// 3 shafts + bloom + sun veil
col += vol*uVolAmt;  col += bloom*uBloom;
if (uSunScreen.z > 0.0) col += uSunCol*0.012*exp(-length((uv-uSunScreen.xy)*vec2(aspect,1.0))*3.2)*uSunVis*(1.0-uStorm);
// 4 exposure (keyframe + hit flash kick)
col *= uExposure*(1.0 + uExpKick);
// 5 white balance in HDR
float lum = dot(col, vec3(.2126,.7152,.0722));
col = mix(col, col*vec3(1.06,1.0,0.90), smoothstep(0.05,0.8,lum)*uWarm);
col = mix(col, col*vec3(0.90,1.0,1.07), 1.0-smoothstep(0.0,0.12,lum));
col = mix(col, vec3(lum)*vec3(0.72,0.88,1.22), uNight*0.55*(1.0-smoothstep(0.02,0.35,lum)));
col = mix(col, vec3(lum)*vec3(0.95,1.0,1.06), uStorm*0.3);
// 6 ACES fitted (Hill), NO /0.6 pre-scale
vec3 m = aces(col);
// 7 painterly grade, tuned for golden grass
float l = dot(m, vec3(.299,.587,.114));
m += vec3(0.006,0.020,0.026)*(1.0-smoothstep(0.0,0.4,l));            // teal shadow lift
m  = mix(m, m*vec3(1.05,0.99,0.88), smoothstep(0.4,1.0,l));           // amber highlights
float lime = smoothstep(0.0,0.06, m.g - max(m.r*0.95, m.b)) * smoothstep(0.3,0.8,l);
m  = mix(m, m*vec3(1.07,0.97,0.80), lime*0.6);                        // lime → gold in bright greens
m  = mix(vec3(l), m, uSat);                                           // uSat 1.10 (ref 1.14 over-saturates fields)
m  = clamp(m,0.0,1.0);  m = mix(m, m*m*(3.0-2.0*m), 0.38);            // S-curve
// 8 vignette (floor 0.68, low health 0.50 plus 35% desaturation)
float vig = 1.0-smoothstep(0.35,1.05,length(cc*vec2(1.05,1.25)));
m *= mix(uVigFloor, 1.0, vig);
m = mix(m, vec3(dot(m,vec3(.299,.587,.114))), uLowHealth*0.35*(1.0-vig*0.5));
// 9 letterbox (cinematics): bars eased in over 0.6 s to 2.39:1
// 10 manual sRGB OETF; output alpha = luma (for FXAA)
```
`aces()`, `toSRGB()` and the matrices are verbatim from the reference (m1 = 0.59719,…; m2 = 1.60475,…).

#### 2.4.6 FINAL (rtLDR → canvas)
* **FXAA 3.11:** luma in alpha, early exit `range < max(0.0312, 0.125·lumaMax)`, 10 search steps
  (1,1,1,1.5,1.5,1.5,2,2,4,4), subpixel `sub²·0.75`.
* **Unsharp mask on non-edge pixels:** `rgb + (rgb − avg4)·0.35`.
* **Then** film grain `(hash12(fc + fract(frame·0.618)·311) − 0.5)·0.028·(1 − 0.6·l)` plus ±0.5/255 dither. This is
  moved after AA so FXAA doesn't smear it and the sharpen doesn't amplify it.
* **Then** the fade: `m = mix(m, vec3(0.80,0.73,0.62)·uFadeMist, uFade)`.

#### 2.4.7 Keyframed post params
`exposure, bloom, vol, warm` come from the env table (§3.4). Constants: `uAO 0.55`, `uSat 1.10`, `vigFloor 0.68`,
CA 0.0065, grain 0.028.

#### 2.4.8 Optional TAA (milestone M5, Ultra/High)
* Halton(2,3) 8-frame sub-pixel jitter applied to the opaque projection only.
* Camera reprojection from depth, as in §2.4.2. Actors write no velocity; the YCoCg 3×3 variance clamp (γ = 1.0)
  handles them.
* Blend 0.1, plus a 0.25 sharpen afterwards. FXAA is disabled when TAA is on.

This is the single biggest win for grass shimmer. Ship FXAA first.

### 2.5 Shadows: static world map plus per-frame actor map (MUST)
The reference's static 4096² map can't show moving fighters. We use **two DirectionalLights with one lighting
contribution**.

| light | role | settings |
|---|---|---|
| `sunFar` (added to the scene **first**) | the real key light, lit, static casters | `castShadow`, 4096² (Medium/Low 2048²), ortho ±150 m, near 10, far 700, `bias −4e−4`, `normalBias 0.04`, `radius 2`, `shadow.autoUpdate=false`. Distance `sunDir·300` from the centre. |
| `sunNear` (added **second**) | shadow-only helper for actors | `intensity = 0`, `castShadow`, 2048² (Low 1024²), ortho **±20 m** (≈2 cm texels), near 1, far 140, `bias −2e−4`, `normalBias 0.02`, `radius 1.5`, `shadow.autoUpdate=false`. Centre = `player + shadowDirXZ·7 m` (character shadows are about 10 m long at 9.5°). |
| `fill` | no shadow | (0.62,0.60,0.58) × 0.42 from anti-solar (0.55,0.35,0.76)·100 |
| `hemi` | — | §3.3 |

Both shadow lights **must** be added before `fill`. three sorts shadow casters first with a stable sort, so their
indices are 0 and 1.

**Per-frame refresh (casters separated by camera layers):**
```js
sunNear.shadow.needsUpdate = true; sunFar.shadow.needsUpdate = false;
renderer.setRenderTarget(rt1x1); renderer.render(scene, camActors);   // camActors.layers = {3}: only actors enter the near map
if (farDirty) {                                                        // focus moved > 40 m or sun turned > 0.25°
  sunNear.shadow.needsUpdate = false; sunFar.shadow.needsUpdate = true;
  renderer.render(scene, camWorld);                                    // camWorld.layers = {0,2}: static world only
}
// both needsUpdate are now false → the main passes render no shadows
```
* The far focus is `camPos + camFwdXZ·40`, with y from `heightAt`.
* Snap both centres **to texels in light space**. Use three's lookAt basis: `z = sunDir`, `x = normalize(cross(UP,z))`,
  `y = cross(z,x)`. Project the centre on x and y, round to `2·halfExtent/mapSize`, then rebuild. Anything else shimmers.

**Light-loop patch (replaces the directional block of `lights_fragment_begin`).** Light 1 is never lit. Its shadow
multiplies light 0. The shadowed sun is also captured for translucency terms:
```glsl
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
  DirectionalLight directionalLight;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  DirectionalLightShadow directionalLightShadow;
  #endif
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    #if UNROLLED_LOOP_INDEX != 1
    directionalLight = directionalLights[ i ];
    getDirectionalLightInfo( directionalLight, directLight );
    #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
    directionalLightShadow = directionalLightShadows[ i ];
    directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
    #endif
    #if UNROLLED_LOOP_INDEX == 0
      #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 1
      directLight.color *= receiveShadow ? getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, 1.0, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ) : 1.0;
      #endif
      #ifdef USE_FOG
      directLight.color *= cloudShadow( vFogWP );
      #endif
      gSunColor = directLight.color; gSunDir = directLight.direction;
    #endif
    RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
    #endif
  }
  #pragma unroll_loop_end
#endif
```
This is verified against r186: `unrollLoops` substitutes `UNROLLED_LOOP_INDEX` and `[ i ]` textually before
compilation, and `getShadow(sampler2DShadow, vec2, float, float, float, vec4)` is the PCF signature.

* Grass and flowers **receive** but never cast.
* The far map holds terrain (hills cast long shadows), rocks, the tree (dappled cutout via `alphaTest`), the stele and
  the pavilion.
* Actors cast only into the near map. Enemies beyond its ±20 m get a contact blob only (§5.5).

### 2.6 Shader chunk patches and helpers (`src/core/chunks.js`, run once before anything compiles)
1. `common += PRELUDE`.
2. `fog_pars_vertex/fog_vertex` → `varying vec3 vFogWP`, the world position. It is batching- and instancing-aware
   (verbatim from the reference). Our GPU-grass writes world positions into `transformed` with an identity
   `modelMatrix`, so it works unchanged.
3. `fog_pars_fragment/fog_fragment` → `gl_FragColor.rgb = applyAtmosphere(gl_FragColor.rgb, vFogWP);`.
4. `normal_fragment_maps`: `mapN.z = sqrt(saturate(1.0 - dot(mapN.xy, mapN.xy)));`
5. `roughnessmap_fragment`: `texelRoughness.g` → `.b`.
6. `lights_physical_fragment`: prepend the reference wetness/puddle block (rain variant), keyed by `uWet` and `uWetBias`.
7. `lights_lambert_fragment`: prepend `diffuseColor.rgb *= 1.0 - uWet*0.32;`
8. `lights_fragment_begin`: the loop replacement in §2.5, plus `lights_pars_begin += "vec3 gSunColor=vec3(0.); vec3 gSunDir=vec3(0.,1.,0.);"`.
9. `lights_fragment_end`: the 8-lamp loop through `RE_Direct` (reference verbatim, 30 m cut, `/(d²+0.35)`).

`patchMaterial(mat, key, fn)` implements `onBeforeCompile = sh => { Object.assign(sh.uniforms, G); sh.uniforms.uWetBias = {value: mat.userData.wetBias||0}; fn?.(sh) }` and `customProgramCacheKey = () => key`.
`patchAll(scene)` then retrofits every unpatched non-Shader material with key `"plain"`.

**Translucency snippet `SUNLIGHT_TERMS`**, inserted after `lights_fragment_begin` in any foliage, cloth or skin material:
```glsl
vec3 sunC = gSunColor; vec3 sunLv = gSunDir;                                 // shadowed + cloud-shadowed, view space
float sunBack = pow(saturate(dot(-normalize(vViewPosition), sunLv)), 4.0);  // looking into the sun through the surface
float sunWrap = saturate(dot(-normal, sunLv)*0.6 + 0.4);
```

**Prelude helpers.**
* `hash12`, `hash13`, `vnoise` and `fbm3` are verbatim from the reference.
* `hash22(p)`: Hoskins `fract(sin)`-free.
* `ign(p) = fract(52.9829189*fract(dot(p, vec2(0.06711056,0.00583715))))`.
* `skyFogColor(rd)` is verbatim from the reference.
* `windGust`/`windSway` are in §5.1.
* `cloudShadow`:
```glsl
float cloudShadow(vec3 wp){
  vec2 p = wp.xz + uSunDir.xz/max(uSunDir.y,0.08)*(uCloudShadow.y - wp.y);   // project along the sun ray to the cloud deck
  p = (p + uWind.xy*uTime*uCloudShadow.w)*uCloudShadow.z;
  float n = fbm3(p) * 0.8 + vnoise(p*3.7)*0.2;
  return 1.0 - uCloudShadow.x*smoothstep(0.52, 0.74, n);                      // ~30% of the plain is shadowed at a time
}
vec3 applyAtmosphere(vec3 col, vec3 wp){            // reference, with river mist → ground mist in hollows
  vec3 ro = cameraPosition; vec3 dv = wp-ro; float dist = length(dv); vec3 rd = dv/max(dist,1e-3);
  float fall = uFogParams.y, k = fall*dv.y;
  float fh = uFogParams.x*exp(-fall*(ro.y-uFogParams.z))*dist*(abs(k)>1e-3 ? (1.0-exp(-k))/k : 1.0);
  float hollow = 1.0 - groundInfo(wp.xz).a;                 // cavity from tGround.A (0 on ridges, ~0.5 in dips); 0 outside ±512 m
  float hAbove = wp.y - groundHeight(wp.xz);                // groundHeight: manual-bilinear tHeight, analytic far fallback = wp.y-1
  float my = clamp(1.0 - hAbove/(2.5 + 4.0*hollow), 0.0, 1.0);
  float mn = vnoise(wp.xz*0.035 + uWind.xy*uTime*0.12)*1.3 - 0.35 + hollow*0.6;
  float mist = uMist*my*my*max(mn + uStorm*0.25, 0.0)*min(dist,140.0)*0.0042;
  float haze = uFogParams.w*dist;
  float T = exp(-(fh+haze+mist));
  vec3 fc = skyFogColor(normalize(vec3(rd.x, max(rd.y,-0.05), rd.z)));
  fc += uSunCol*0.04*mist*pow(max(dot(rd,uSunDir),0.0),3.0);
  return col*T + fc*(1.0-T);
}
```
The mountain ribbons and the sky call `skyFogColor` directly with `fog:false`.

### 2.7 Environment map
There is one `WebGLCubeRenderTarget(128, HalfFloat)` plus a `CubeCamera(1, 12000)` over a private `envScene` that holds
only the sky dome. It is re-captured **only when a sky uniform changes by more than 0.5%**: during a mood transition that
is every 12 frames, otherwise never. `scene.environment = PMREM(cube)` with `environmentIntensity` from the keyframe
(0.55 at golden hour). The sword relies on this for its golden horizon reflection.

### 2.8 Precompile and fades
* **Precompile:** force every object visible, including pooled enemies, one of each VFX, the trail and the cinematic
  letterbox. Call `camera.layers.enableAll()` and `setRenderTarget(rtScene)`, then
  `await renderer.compileAsync(scene, camera)`. Restore afterwards. Post materials compile in one warm-up pipeline run
  behind the loader.
* **Loader:** a horizontal **sword-draw brush stroke** (SVG path, `pathLength=1`, dashoffset `1−p`, 0.6 s
  `cubic-bezier(.3,.7,.2,1)`), with the ensō turbulence filter `feTurbulence 0.85/2 oct → feDisplacementMap 1.8`. The
  ink is `#e9c89b` on `radial-gradient(#151c1d, #0b0f10)`, driven by `window.__load(p)`. Yield between build stages
  with a `MessageChannel` macrotask.
* After the first frame: wait 450 ms, fade the loader with a 1.1 s CSS transition, and fade the scene from black over
  2.2 s.
* Death, respawn and area jumps use the **warm-mist fade** (0.80,0.73,0.62): 1.2 s out, 1.6 s in.

### 2.9 Adaptive resolution
* The controller follows the reference. After 90 warm-up frames it averages the raw frame dt over 60 frames.
  * If avg > 23.5 ms: `scale *= avg > 45 ? 0.84 : 0.92`, with an 8 s cooldown.
  * If avg < 17.6 ms: `scale += 0.05`, with a 2.5 s cooldown.
* The scale range comes from the tier (§8.2).
* On DPR 1 displays the High and Ultra tiers may **supersample up to 1.25** when avg < 13 ms. That is the cheapest
  grass anti-aliasing there is.
* Resize with `renderer.setSize(round(w·K), round(h·K), false)`, then run the pipeline resize, which invalidates history.
  Point-size uniforms scale by `H/900`.
* A `ResizeObserver` on `documentElement` catches mobile URL-bar resizes.

---

## 3. Sky, clouds and lighting

### 3.1 Sky dome (`src/world/sky.js`)
The mesh is `SphereGeometry(5000, 64, 32)`, BackSide, `depthWrite:false`, `renderOrder 10` (last), re-centred on the
camera in `onBeforeRender`, with `gl_Position = p.xyww`. Take `skyColor()` from the reference verbatim (the `Z2` string
in `sky-lighting.md` §4), with these grassland tweaks:
1. **Gradient:** the horizon uses `skyFogColor`, blending to `uSkyUp` by h 0.22 and to `uSkyZen` by 0.18 → 0.75.
2. **Sun:** three glow lobes, `pow(s,5)·0.10·(0.4+band) + pow(s,28)·0.22 + pow(s,220)·0.8`. Add the horizon band
   `exp(-7h)` glow ×0.10. The disc is `uSunCol·9·smoothstep(0.99962, 0.99978, s)`.
3. **Clouds (painted):** keep the reference layer (fbm3 ×3 + anisotropic streak, soft threshold 0.46→0.78, band 5°–30°,
   thickness-based lit/shade mix, gold lining `pow(s,18)`). Add:
   * **Self-shadow tap:** `float nS = fbm3((uv + normalize(uSunDir.xz)*0.06)*1.2); float edge = clamp((n - nS)*3.0, -1.0, 1.0); lit *= 1.0 + 0.35*max(-edge,0.0); thick = clamp(thick + 0.25*max(edge,0.0),0.0,1.0);`
     This lights the sun-facing edges and deepens the cores.
   * **High cirrus layer:** `uv2 = rd.xz/(h+0.25)*0.35 + t*(0.002,0.0006)`, `ci = smoothstep(0.55,0.85, fbm3(vec2(uv2.x*0.5, uv2.y*3.0)))*0.35`,
     colour `mix(uCloudLit, uSunCol*0.35, pow(s,3.0))`. Added before the low deck.
   * Keep the cloud mass low. The zenith stays clean slate blue.
4. **Night** (optional): stars, Milky Way and moon verbatim from the reference.
5. **Sky dither:** handled by the final pass dither. Never add sky noise in the sky shader itself.

### 3.2 Distant mountains (`src/world/mountains.js`)
There are four **360° ring ribbons** (`fog:false`, drawn before the sky), each a grid of 481 × 11 vertices. Heights come
from `base + H·amp·(0.25 + 0.95·ridged6oct(θ·7·0.35, depthFrac·1.2)·(0.55+0.45·fbm))·notch·azimuthProfile`, with the
front edge ramp `sin(min(1, E·2.2+0.05)·π/2)`.

| layer | radius | H (max) | base | radial depth | haze | notes |
|---|---|---|---|---|---|---|
| 1 | 1800 m | 160 | −10 | 260 | 0.30 | low steppe ridges |
| 2 | 2400 m | 320 | −20 | 360 | 0.50 | |
| 3 | 3200 m | 520 | −40 | 500 | 0.66 | **snow range on the anti-solar side** (az of −SUN_DIR ±50°): snow where `relH > 0.62 + 0.1·fbm` and `N.y > 0.55`, albedo 0.8, lit by `uSunCol·ndl` → alpenglow when the camera turns away from the sun |
| 4 | 4200 m | 780 | −60 | 500 | 0.78 | tallest behind the sun |

* `notch = 1 − 0.55·exp(−((Δθ_sun)/0.2)²)` puts the setting sun in a gap.
* `azimuthProfile = 0.65 + 0.35·smoothstep(0.3, 1.2, |Δθ_sun|)` keeps the sides taller.
* Shading as in the reference:
  * albedo from forest (0.035,0.05,0.045) to rock (0.09,0.085,0.08) by `relH`;
  * ambient (0.30,0.38,0.46)·uAmbK·(0.55+0.45N.y);
  * `+ sun·ndl·0.55`, rim `pow(ndl,3)·0.02·relH`;
  * then `haze = uHaze + (1−uHaze)(1−smoothstep(0,0.55,relH))·0.65 + (1−relH)·0.08`, clamped ≤ 0.985, and
    `mix(col, skyFogColor(rd), haze)`.
* The terrain mesh stops at ±1.5 km, so the rings never intersect it.

### 3.3 Lighting rig (golden hour)
| light | value |
|---|---|
| `sunFar` | colour `L/max(L)` = (1, 0.74, 0.47), intensity `max(L)` = 3.3 |
| `sunNear` | intensity 0 (shadow helper) |
| `hemi` | sky (0.42,0.55,0.68), ground **(0.21,0.175,0.08)**, 0.85 |
| `fill` | (0.62,0.60,0.58) × `0.42·clamp(hi/0.85,0.15,1.3)·(1−0.4·night)` from anti-solar 20° elevation |
| IBL | env cube, `environmentIntensity` from the keyframe |
| lamps | 8 virtual slots: spark flashes, dusk torches |

### 3.4 Keyframes (`src/core/env.js`)
These are linear and interpolated with **smoothstep easing per segment**. They are derived from the reference table.
Changes are marked ✱.

| u | mood | L (sun rgb·I) | hemi sky | hemi gnd ✱ | hemiI | amb | env | fog cool | fog warm | fd | hz | mist ✱ | zen | up | cloud lit | cloud shade | hglow | exp | bloom | vol | warm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.600 | afternoon | 3.8,3.05,2.2 | .46,.58,.74 | .24,.21,.11 | 0.92 | 1.1,1.14,1.2 | 0.60 | .42,.50,.58 | 1.05,.78,.52 | 0.0013 | 2.3e-4 | 0.5 | .08,.17,.33 | .28,.40,.54 | 1.6,1.28,.92 | .40,.40,.50 | 1,.64,.40 | 0.95 | 0.050 | 0.70 | 0.60 |
| **0.700** | **golden** | **3.3,2.44,1.55** | **.42,.55,.68** | **.21,.175,.08** | **0.85** | **1,1,1** | **0.55** | **.33,.43,.50** | **1.05,.66,.36** | **0.0014** | **2.4e-4** | **0.6** | **.085,.16,.27** | **.26,.36,.45** | **1.3,.936,.598** | **.34,.33,.42** | **1,.55,.30** | **1.05** | **0.055** | **0.85** | **1.0** |
| 0.742 | ember sunset | 1.75,0.72,0.3 | .34,.38,.54 | .17,.12,.07 | 0.70 | .74,.70,.80 | 0.45 | .30,.32,.44 | .92,.42,.22 | 0.0016 | 2.6e-4 | 0.8 | .05,.08,.19 | .21,.23,.35 | 1.5,.62,.38 | .30,.21,.28 | 1.1,.42,.20 | 1.22 | 0.070 | 1.00 | 1.0 |
| 0.785 | blue hour | 0,0,0 | .16,.22,.40 | .045,.04,.04 | 0.55 | .34,.40,.58 | 0.40 | .11,.14,.25 | .34,.20,.20 | 0.0016 | 2.5e-4 | 1.1 | .018,.03,.085 | .06,.09,.19 | .38,.27,.32 | .09,.09,.15 | .5,.2,.12 | 1.90 | 0.080 | 0.15 | 0.30 |
| 0.850 | night | .3,.37,.55 (moon) | .075,.10,.19 | .018,.018,.025 | 0.50 | .12,.15,.26 | 0.30 | .038,.052,.088 | .065,.075,.11 | 0.0015 | 2.4e-4 | 1.1 | .004,.008,.02 | .012,.02,.044 | .10,.11,.15 | .03,.034,.05 | .02,.03,.05 | 3.00 | 0.100 | 0.40 | 0 |

* **Derived each frame:**
  * `uSunCol = L ⊙ mix((1.697,1.455,1.129), 1.35, night)`.
  * `sunFar.color = L/max(L)`, `sunFar.intensity = max(L)`.
  * `uSunVis = smoothstep(−0.03, 0.01, sunDir.y)`.
  * The key light switches to the moon when `sun.y < −0.07`, with the reference fades.
* **Sun path:** `elev = asin(sin 58°·sin(π·e))`, `e = (u+0.012)/0.759`, `az = az0 + 192°·e`, `az0 = atan2(−SUN_DIR.x, −SUN_DIR.z)`.
  At u = 0.70 this reproduces SUN_DIR exactly.
* **Cloud shadow strength** `uCloudShadow.x`: 0.5 at golden, 0.35 at sunset, 0 at blue hour and night, 0.7 at noon.
* **Storm overlay** (optional set piece) is verbatim from the reference: `L *= 1−0.9s`, fog → grey, `fd ×(1+2.4s)`,
  `hz ×(1+2.2s)`, `mist +1.1s`, `exp ×(1+0.3s)`, `vol ×(1−s)`, `warm ×(1−s)`, `bloom +0.02s`, wind `1+1.6s`. Lightning
  pulses `[0,.35,.05] [.07,1,.09] [.22,.7,.07] (+[.4,.55,.08])` re-aim `fill` to the bolt at `(0.72,0.8,1)·(base+2.2·flash)`.
  Script a bolt at 300–600 m on a finishing blow.

### 3.5 Mood API
`env.setMood(name, seconds)` animates `u` along the shortest path, plus overlays (`storm`, `wind`). Encounter scripts call
it:
* Golden, `wind.z` 1.0 for exploration.
* Before a duel: wind 1.0 → 1.5 over 3 s.
* Boss: `setMood('ember', 20)`.
* Finale: `setMood('blue', 30)`, with fireflies fading in (§6.1).

---

## 4. Terrain and ground

### 4.1 Height function (`src/world/ground.js`, pure, seeded, identical on every run)
Let `p = (x,z)`, `r = |p|`, with `Ln` = normalised simplex fBm and `Cf` = ridged multifractal (reference definitions).
```
swell   = 16·Ln(p·0.0035, 4)          // ~285 m swells
undul   = 3.0·Ln(p·0.014, 3)          // ~70 m undulation
hummock = 0.30·Ln(p·0.07, 2)          // ~14 m hummocks (feet and IK read these)
knoll   = 4.2·exp(−(r/40)²)           // the duel knoll; crest flattened below
rim     = Cf(p·0.004, 5)·70·smoothstep(320, 900, r)      // rising ridges beyond play; soft cap above 0.7·S (S = 110+40·Ln(p·0.002)) compressed ×0.35
H0      = swell + undul + hummock + knoll + rim
crest   : H = mix(H0, Hc + 0.03·Ln(p·0.5,1), smoothstep(16, 7, r))      // Hc = H0 at the origin; flat ~Ø14 m fighting pad
road    : H = mix(H, roadGrade(s), smoothstep(4.5, 1.6, dRoad)·0.85) − 0.07·smoothstep(1.3, 0.4, |dRoad∓0.65|)   // graded road plus two wheel ruts
bound   : H += 6·smoothstep(170, 240, r)·(0.6+0.4·Ln(p·0.01))      // soft playable boundary rises
```
* The road is a Catmull-Rom spline through (−420,130), (−220,75), (−70,38), (0,30), (80,12), (190,−55), (420,−150),
  baked to a 0.5 m LUT (s, x, z, grade).
* `roadGrade` is the height along the spline, smoothed with a 12 m box filter.
* It is also uploaded as a `DataTexture` for shaders (reference `uRiverTex` pattern).
* An optional phase-2 stream uses the reference river profile with half-width 2–3.5 m and depth 0.5 m.

### 4.2 Terrain mesh
* **Separable grid:** uniform **0.75 m** spacing for |x|,|z| ≤ 160 m (427 columns), then geometric growth ×1.045 per
  step out to ±1.5 km (about 100 more per side). That gives ≈627² ≈ **393k vertices and 786k triangles**, a
  `Uint32` index and one draw call.
* Checkerboard diagonals (`(col+row)&1`).
* Normals from the analytic `normalAt`, which is smoother than face averaging.
* `receiveShadow` on and `castShadow` on (far map only). `frustumCulled=false`. Layer 0.

### 4.3 Baked world textures (GPU bake at load, ±512 m, 2048², 0.5 m texels)
* **`tHeight` (R32F, NEAREST).** Render the terrain mesh top-down with an ortho camera and a material that writes world
  y. It is then **exactly** the rendered surface. Shaders read it with manual bilinear (4× `texelFetch`) in
  `groundHeight()`. Grass roots, mist and decals all use it.
* **`tSplat` (RGBA8, linear, mipmapped).** Weights computed on the CPU at 0.5 m, then uploaded. Order is priority.
  ```
  slope = 1-n.y ; O = simplex(p·0.06) ; L = Ln(p·0.017,3)
  rock  R = smoothstep(0.26+0.08·O, 0.45, slope) ; R = max(R, outcropMask)          // outcrop SDFs around boulder clusters
  dirt  D = max( smoothstep(3.4, 1.4, dRoad),  smoothstep(1.6, 0.6, dBoulder-rBoulder)·0.8,  knollPad·0.35·(0.5+0.5L) )
  dry   Y = clamp(0.55 + 0.9·Ln(p·0.012,3) + 0.25·dot(n.xz, -SUN_DIR.xz) − 0.6·cavity, 0, 1)   // sunny slopes and ridges dry
  lush  = remainder ;  D *= (1-R) ; Y *= (1-R)(1-D) ; lush = (1-R)(1-D)(1-Y) ; normalise
  ```
* **`tGround` (RGBA8, linear).**
  * **R** grass density = `(1−R)·(1−smoothstep(0.3,0.7,D))·(0.55+0.45·fbm(p·0.05))`. It is 0 on the road and rocks and
    thins at patch edges.
  * **G** height factor = `0.35 + 0.65·smoothstep(−0.2, 0.6, Ln(p·0.02,2) + moisture·0.4)·(1−0.7·knollPad)`, where
    `knollPad = smoothstep(18, 8, r)`. Grass on the knoll top is short and trampled.
  * **B** moisture/green = `clamp(cavity·1.6 + 0.3·Ln(p·0.01) − dry·0.5, 0, 1)`.
  * **A** cavity AO: `1 − clamp((avg(±3.5 m) − h)·0.2 + (avg(±11 m) − h)·0.035, 0, 0.55)`, with the tree canopy
    multiplier `(1 − 0.35·treeProx)`.
* `groundInfo(xz)` samples `tGround` bilinearly. Beyond ±512 m it returns (far defaults: density 0, cavity 1).

### 4.4 Ground textures (procedural at load; scans optional)
No scanned sets ship with the project, so the texture baker (`src/world/texbake.js`) generates 1024² tileable
**colour (sRGB RGBA8) + packed NRM (RG normal, B roughness)** pairs. Normals come from a Sobel pass on a height channel.

| set | tile | recipe |
|---|---|---|
| `thatch` (dry straw litter) | 2.6 m | soil (0.10,0.075,0.05) + canvas-drawn 5000 straw strokes, 4–14 cm long, 1–3 px wide, random angle biased ±25° to `WIND_DIR`, colours from the straw palette (0.30–0.60, 0.22–0.45, 0.08–0.20), with older darker strokes underneath; height = stroke stacking; rough 0.85–0.95 |
| `lush` (low green undergrowth) | 2.2 m | clover/leaf ellipses (0.05–0.09, 0.08–0.13, 0.02–0.04) over dark soil; rough 0.8 |
| `road` (packed earth) | 3.0 m | vnoise earth (0.16,0.12,0.08) ±15%, Worley pebbles 1–4 cm (0.25,0.22,0.18), ridged-noise cracks; rough 0.9. Ruts are analytic (§4.1 road term) plus a darker `×0.8` rut band. |
| `rock` (lichen rock) | 6.0 m triplanar | ridged fBm strata bands `floor(y·k)` jittered, grey (0.18,0.17,0.155), ochre lichen spots (0.30,0.24,0.10), grey-green (0.20,0.22,0.16); rough 0.75 |

* The textures are stored **dark-normalised** as in the reference. `material.color` is the albedo gain, so every layer
  lands in the target linear albedo range. Tune the gains against the grey card: grass-ground 0.08–0.15, straw
  0.20–0.30, soil 0.12–0.20, rock 0.15–0.25.
* If `/public/tex/*.webp` scans exist (for example Poly Haven CC0 `dry_ground_01`), the baker is skipped for that set.
  Same packing.

### 4.5 Terrain fragment shader (inject at `map_fragment`, `normal_fragment_maps`, `roughnessmap_fragment`)
1. **Distance tiers:** `far = smoothstep(18,70,camD)`; detail normals when `camD < 75`; the cheap path beyond 260 m (one
   sample per layer, rock picks its dominant axis); each layer is sampled only when its weight is above 0.004.
2. **Anti-tiling, all three reference levels:**
   * non-commensurate tiles (2.6/2.2/3.0/6.0);
   * a far self-resample `mix(a, tex(uv·0.21+0.37)·(1.04,1.02,1,1), far·0.55)`;
   * a macro tint `macro = vnoise(xz·0.04)·0.65 + vnoise(xz·0.12)·0.35`, then
     `alb *= mix(vec3(0.80,0.92,0.74), vec3(1.15,1.05,0.85), macro)`, times a third 150 m octave shifting whole hillsides
     toward straw `mix(1, (1.08,1.0,0.86), vnoise(xz·0.0065))`.
3. **Height blend:** `hw = w + lum(texel)·0.55 + (macro·0.25, (1−macro)·0.2, 0, 0)`, depth 0.22.
4. **Interaction (`tInteract`, inside its rect):**
   * trample R adds to the dirt weight **before** the height blend;
   * blood B mixes toward ink-blood `(0.10,0.005,0.006)` with a noise edge
     (`smoothstep(0.3,0.6,B + 0.3·vnoise(xz·9))`), roughness to 0.35;
   * scorch/dust A lightens `×1.12` (kicked dust).
5. **Grass-canopy far field (the hand-off, MUST match §5.3 colours).** In grass zones (`density > 0`) the terrain albedo
   becomes the **average visible blade colour**:
   ```glsl
   float tipFrac = mix(0.9, 0.5, saturate(viewDir.y*3.0));             // grazing views see tips
   vec3 canopy = mix(speciesMid(xz), speciesTip(xz), tipFrac) * grassMacro(xz);   // SAME species noise as the blades
   float c = smoothstep(25.0, 85.0, camD) * density;
   alb = mix(alb * mix(0.55, 1.0, 1.0-density), canopy, c);            // near: ground under blades is darker
   N = normalize(mix(N, normalize(N + vec3(uWind.x,1.6,uWind.y)*0.5), c));   // canopy normal ≈ up + lean
   alb *= 1.0 + 0.12*(windGust(wp) - 0.55)*c;                           // honami bands keep rolling to the horizon
   ```
   Add the grass translucency term on the far canopy in `lights_fragment_begin`:
   `direct += sunC·alb·(sunBack·1.6+0.2)·0.55·c`. The glowing field looking into the sun then continues past the
   blades.
6. **Cavity AO:** `alb *= tGround.a`. Analytic actor contact AO (§5.5) is also applied here.
7. **Leaf carpet** under the golden tree: `mask = smoothstep(0.6,0.8, vnoise(xz·5.3)·0.6+vnoise(xz·13)·0.4 + prox·0.3)`,
   colour (0.55,0.35,0.06), mixed at 0.8.
8. Roughness `clamp(blendedB·1.05, 0.2, 1.0)`.

### 4.6 Rocks and props
* **Procedural boulders** (`src/world/rocks.js`).
  * 6 prototypes. Each is an icosphere (hi detail 5 → ~10k tris, lo detail 3 → 640 tris) displaced by
    `ridged fBm(3D)·0.35 + stratification step noise`, with the bottom flattened. Normals are recomputed.
  * One `InstancedMesh` per prototype and LOD, chunked in 64 m cells. Lo past 60 m; cull small stones at 80 m and
    boulders at 350 m.
  * Placement (seed 777):
    * 5–12 hero boulders (1.5–4 m) around the knoll edge and at 40–150 m;
    * each hero boulder gets a debris cluster of 3–9 stones within ±2.2 m;
    * all rocks sink 25–50% and need `normal.y ≥ 0.72`;
    * 2–3 **standing stones** (y scale ×2.5) near the road;
    * outcrops on slopes steeper than `n.y < 0.8` at 300+ m, aligned to the terrain normal via the mean mesh normal.
* **Rock material:** `MeshStandard` with the triplanar rock texture, plus:
  * dry ochre lichen on top faces, `smoothstep(0.42,0.8, n.y + (noise−0.5)·0.7)` → (0.20,0.17,0.08);
  * grass-colour bleed at the base, `smoothstep(0.4, 0, heightAboveGround)` toward the canopy colour;
  * rock-proximity AO baked into `tGround.A`.
* **Props** (Wf-style part builder: world box-UVs, per-part tint 0.9–1.08, merged per material):
  * a weathered **stone stele** (石碑, 2.4 m) with carved calligraphy. Canvas-rendered system CJK font → height →
    normal. Text such as 「风起於青萍之末」.
  * an optional **ruined pavilion** (破亭) at (70, −90): 4 lacquer posts, roof `(1−max|u|,|v|)^1.42` with eave lift.
  * a few **wooden grave markers / broken spears** as fight-history props.

---

## 5. Grass, vegetation and wind (the centerpiece)

### 5.1 The wind field (one field for everything)
```glsl
float windGust(vec3 wp){                                       // gust fronts: λ≈126 m, 12 m/s downwind, 30 s breathing
  float along = dot(wp.xz, uWind.xy);
  float g = 0.55 + 0.45*sin(uTime*0.6 - along*0.05)*(0.6 + 0.4*sin(uTime*0.19 + wp.x*0.011 - wp.z*0.013));
  float n = texture(tWindNoise, (wp.xz - uWind.xy*uTime*9.0)/46.0).r;   // cat's-paw puffs 5–15 m, 9 m/s
  return max(g*(0.6 + 0.8*n), 0.08)*uWind.z;
}
vec3 windSway(vec3 wp, float flex, float phase){               // FIXED: sway wave travels DOWNWIND (−k·along)
  float g = windGust(wp), t = uTime, along = dot(wp.xz, uWind.xy);
  float s = sin(t*1.7 - along*0.7 + phase)*0.55 + sin(t*2.9 - along*1.3 + phase*1.9)*0.20;
  vec3 dir = vec3(uWind.x,0.0,uWind.y), side = vec3(-uWind.y,0.0,uWind.x);
  return (dir*(0.55+s)*g + side*sin(t*1.7 + phase*2.3)*0.18*g)*flex;
}
```
* `tWindNoise`: 256² tileable 4-octave value fBm, RG8 (G = a second decorrelated octave for flutter). The same bytes
  live in JS.
* **`core/wind.js` mirrors both functions exactly** and bilinearly samples the byte array. Cloth, hair, tassel, sash,
  leaves, seeds and audio all use it, so a gust hits the robe at the instant the grass around it ducks.
* **Gameplay drives `uWind.z`:** 0.6 calm, 1.0 default, 1.5 pre-duel, 2.2 boss phase, a 2.6 spike on ultimate moves
  (ease 0.4 s in, 2 s out).

### 5.2 Grass architecture: GPU-procedural tiers (`src/veg/grass.js`)
There are no per-blade CPU buffers. Each tier is **one draw call**: a `Mesh` with an `InstancedBufferGeometry` (the
shared blade strip), `frustumCulled=false`, and `instanceCount = visibleTiles × bladesPerTile`. The CPU only chooses
tiles.

| tier | radius (fade-in → fade-out) | tile | blades/tile (k²) | density /m² | segments / verts | width × | wind detail |
|---|---|---|---|---|---|---|---|
| L0 | 0 → 9–11 m | 5 m | 52² = 2704 | 108 | 7 / 15 | 1.0 | full sway + flick + all interaction + bend sheen |
| L1 | 9–11 → 30–34 m | 12 m | 64² = 4096 | 28.4 | 4 / 9 | 1.7 | sway, interaction, sheen |
| L2 | 30–34 → 80–90 m | 30 m | 72² = 5184 | 5.8 | 2 / 5 | 3.4 | gust lean only |
| far | 60 m → horizon | — | 0 | — | — | — | terrain canopy (§4.5.5) |

**CPU tile selection, per tier per frame:**
* Snap to the tile grid around the camera.
* Keep tiles that intersect the tier annulus **and** the frustum. The AABB uses a coarse 64 m min/max height grid plus
  1.3 m blade height.
* Sort near to far and cap at L0 16 / L1 32 / L2 40 tiles.
* Upload `uniform vec4 uTiles[64]` (xy origin, z size) and set `instanceCount`.

Tier quality multiplies `k` (blades per tile edge) by √densityMul, so density scales smoothly.

**Blade generation in the vertex shader (skeleton):**
```glsl
attribute float aT;      // 0 root … 1 tip (row)
attribute float aSide;   // −1 / +1, 0 on the single tip vertex
uniform vec4 uTiles[64]; uniform float uK;  uniform vec4 uRing;   // (fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd)
uniform float uWidthMul, uTier;
int per = int(uK*uK), ti = gl_InstanceID / per, bi = gl_InstanceID - ti*per;
vec4 tile = uTiles[ti];
vec2 cell = vec2(float(bi % int(uK)), float(bi / int(uK)));
vec2 tc   = floor(tile.xy/tile.z + 0.5);                          // integer world tile id → stable hashes
vec2 j    = hash22(tc*127.1 + cell*1.37);
vec2 root = tile.xy + (cell + j)*(tile.z/uK);                      // stratified jitter = even coverage
// clumps: nearest of 3x3 jittered points on a 0.7 m grid → shared lean dir, height, species, colour
vec2 cId; vec2 cPos = clumpNearest(root, 0.7, cId);  float hc = hash12(cId);
root = mix(root, cPos, 0.25);                                     // pull toward the clump centre
vec4 gi = groundInfo(root);                                       // density, heightF, moisture, cavity
float h = hash12(root*91.7);                                      // blade hash (also used for LOD thinning)
float dist = length(root - cameraPosition.xz);
float keep = smoothstep(uRing.x, uRing.y, dist + h*2.0) * (1.0 - smoothstep(uRing.z, uRing.w, dist + h*4.0));
keep *= step(h, gi.r * uDensityMul);
// species (§5.3) from 2-octave noise at 0.045/m + moisture
float H = mix(0.35, 1.05, gi.g) * mix(0.75, 1.25, hc) * (0.8 + 0.4*hash12(root+3.1)) * speciesHeight;
H *= 1.0 - 0.75*interactCut(root);                                // cut stubble (tInteract.G)
H *= keep * (1.0 - smoothstep(0.9, 0.45, length(root - uCamGround.xy)));   // clear blades inside the lens
vec3 base = vec3(root.x, groundHeight(root) - 0.02, root.y);
```
* **Shape: length-preserving quadratic Bézier** (a GoT-style improvement on the reference shear).
  ```glsl
  float yaw = hc*6.2832 + (hash12(root*7.3)-0.5)*1.2;            // clump facing ± spread
  vec2 face = vec2(cos(yaw), sin(yaw));
  vec2 bend = face*mix(0.12,0.45,hash12(root*3.7))               // natural lean
            + uWind.xy*windBendAmount(base, H)                   // §5.4
            + pushVec(base, H) + trampleVec(base);               // §5.6
  float ang = min(length(bend), 1.45);  vec2 bd = bend/max(length(bend),1e-4);
  vec3 P2 = vec3(bd.x*sin(ang), cos(ang), bd.y*sin(ang))*H;      // tip on the length sphere
  vec3 P1 = vec3(0.0, H*0.62, 0.0) + vec3(bd.x,0.0,bd.y)*H*0.22*curl;   // stiff base, arched tip; curl 0.4–1.0
  float L = (2.0*length(P2) + length(P1) + length(P2-P1))/3.0; P1 *= H/L; P2 *= H/L;   // Bézier length ≈ H
  vec3 p   = 2.0*(1.0-aT)*aT*P1 + aT*aT*P2;
  vec3 tan = normalize(2.0*(1.0-aT)*P1 + 2.0*aT*(P2-P1));
  vec3 sideV = normalize(vec3(-face.y, 0.0, face.x));
  float w = W*(1.0 - 0.88*pow(aT,1.3));                          // W = 0.012–0.022 m × uWidthMul
  vec3 Nf = normalize(cross(sideV, tan));  vec3 V = normalize(cameraPosition - (base+p));
  if (dot(Nf,V) < 0.0) Nf = -Nf;                                  // face the camera (double-sided, no flip in the FS)
  w *= 1.0 + (1.0-abs(dot(Nf,V)))*0.8;                            // view thickening: edge-on blades never become slivers
  w = max(w, uPixelWorld*dist*0.9);                               // ≥ ~0.9 px wide (uPixelWorld = 2·tan(fov/2)/H_px)
  transformed = base + p + sideV*aSide*w*0.5;
  ```
* **Normals** (reference dome trick plus a rounded cross-section):
  * `Nr = rotate(Nf, tan, aSide·0.35)`;
  * `Ndome = normalize(vec3(bd·0.5 + (root−cPos)·2.0, 0.8))` (in xz order);
  * `objectNormal = normalize(mix(Nr, Ndome, 0.45))`;
  * the fragment shader uses `normal = normalize(vNormal)` with no face flip.
* **Varyings:** `vT` (aT), `vH` (H), `vSpecies`, `vTint`, `vBendAmt`, `vTanW` (world tangent), `vAO`.

### 5.3 Species and colour (golden steppe ecology)
* **Species weight:** `s = fbm2(root·0.045) + 0.35·moisture − 0.25·dry`, giving patches of 15–35 m.
  * golden (default);
  * **late-green** where `s > 0.62` (hollows, under the tree);
  * **bleached seed-tip** blades as 15% of golden clumps (by `hc`), 20% taller with a pale tip.
* **Colours:** use the §1.4 table. `albedo = mix(root, mid, smoothstep(0,0.55,t))`, then toward tip by `smoothstep(0.45,1,t)`.
  Per-clump tint: brightness U(0.82,1.18), r ×U(0.95,1.08), b ×U(0.8,1.0).
* **AO:**
  * `ao = mix(0.40, 1.0, smoothstep(0.0, 0.55, t))`, times a density term `mix(0.6, 1.0, t)` for L0/L1;
  * times `tGround.a`;
  * times the actor contact term (§5.5).
* **Material:** a patched `MeshLambertMaterial({ side: DoubleSide })`, cache key `grass-L{n}`. Lambert gives shadows
  (both maps plus cloud), hemi, fill, lamps and fog from three with no extra work.

### 5.4 Grass wind, honami and lighting
* **Wind bend amount:** `windBendAmount = (0.30 + 0.55·s01)·g·flexH`, where
  * `g = windGust(base)`;
  * `s01 = 0.5 + 0.5·sin(uTime·1.7 − along·0.7 + phase)` is the downwind sway wave, λ ≈ 9 m, ~2.4 m/s;
  * `flexH = smoothstep(0.2, 1.0, H)·0.9 + 0.1`, so tall grass bends more;
  * `phase = root.x·0.7 + root.y·0.3` + clump hash.
* **L0 flick:** add a 3 cm, ~1.1 Hz flick, `(sin(t·7 + root.x·3 + h·20), cos(t·6.3 + root.y·3))·0.03·g·t²`, applied to
  the tip only.
* **Bend sheen (honami):** `vBendAmt = ang` (0 … ~1.2). In the fragment shader:
  `alb *= 1.0 + 0.35·vBendAmt·saturate(dot(uWind.xy, normalize(-V.xz))·0.5+0.5)`.
  A gust front then reads as a **bright band rolling toward a sun-facing camera**. The far canopy term in §4.5.5
  continues it.
* **Lighting** (after `lights_fragment_begin`, using `SUNLIGHT_TERMS`):
  ```glsl
  vec3 trans = alb*vec3(1.05,0.92,0.70);                              // transmitted light is more saturated
  reflectedLight.directDiffuse += sunC*trans*(sunBack*1.7 + 0.2)*vT;  // backlit glow along the blade (no 1/π, intended)
  vec3 T = normalize((viewMatrix*vec4(vTanW,0.0)).xyz), Hh = normalize(sunLv + geometryViewDir);
  float TH = dot(T,Hh);  reflectedLight.directSpecular += sunC*0.05*pow(sqrt(max(0.0,1.0-TH*TH)),64.0)*vT;   // Kajiya waxy sheen
  ```
  Dry golden blades use a translucency gain of 1.7. Late-green blades use 1.4 and a sheen of 0.03.
* **Fog:** automatic through the patched `fog_vertex` (world position).

### 5.5 Actor contact (analytic, all ground shaders)
For each active `uActors[i]` with `d = |xz − a.xz|`:
* `ao *= 1 − 0.45·exp(−(d/0.55)²)` on terrain;
* grass gets `mix(1, 0.6, (1−t))·exp(−(d/0.7)²)`.

This makes the fighters sit **in** the grass, even where no near shadow exists. It also serves as the blob shadow for
distant enemies: `ao *= 1 − 0.35·exp(−(d_shadow/0.8)²)`, sampled at `a.xz + shadowDirXZ·0.6`.

### 5.6 Interaction
1. **Push (per frame):** for actors, the camera and swept weapon tips,
   `f = s·(1 − smoothstep(0.3r, r, |d|))`, `push += normalize(d)·f·1.1` (radians). This goes into the same Bézier bend,
   so length is preserved and blades lie down and around.
2. **`tInteract` RT (512², ±32 m, texel 12.5 cm, re-centred with texel snapping as the player moves; old content
   shifted by a copy pass):**
   * Each frame, draw soft stamps with max blending:
     * **R trample:** foot contacts, r 0.35, strength 0.8; body rolls, r 0.9.
     * **G cut:** slash arcs rasterised from the trail ribbon projected to the ground, when the blade tip is lower than
       grass height.
     * **B blood:** from `vfx.blood` ground hits.
     * **A dust.**
   * Decay per frame: R ×0.9975 (recovers in about 12 s), G ×0.99995 (regrows over minutes), B ×0.9998, A ×0.99.
   * Grass: `trampleVec = normalize(gradient or wind)·R·1.2`; `H *= 1 − 0.75·G`.
3. **Shockwave:** `uShock[i]`, ring radius `R(t) = 9·(t−t0)`, width 1.2 m, life 0.9 s. Blades inside bend outward by
   `strength·(1−age)²·exp(−((d−R)/1.2)²)·1.2`. `uWind.z` spikes at the same time.
4. **Slash gust:** `uSlash`. Blades within 2.5 m of the chord bend perpendicular to it, with a
   `sin(π·age/0.35)·exp(−dist/1.2)` pulse. Every swing visibly moves the field.
5. **Cut clippings** are emitted at the cut arc (§6.2).

### 5.7 Companion vegetation
* **Silver grass (芒/荻 plumes).**
  * 3–5k tufts (static, CPU-scattered, seed 3031), in noise drifts along the road, the knoll flanks and hollow rims.
  * 12 blades at 1.2–1.9 m plus 1–3 **plume cards**. The plume texture is a 256×512 canvas of 400 fine curved strokes
    in (0.85,0.75,0.55), alpha-dilated 6 passes (reference `Jc`).
  * `alphaTest 0.5`, translucency `sunBack·2.4 + 0.3`. Wind flex 0.9 with a plume nod `sin(t·2.2 + h·6)·0.06·g`.
  * 64 m chunks, shrink-fade 110–140 m, layer 2.
* **Wildflowers.**
  * 6k crossed quads (0.3–0.45 m) from a canvas atlas: **higanbana** (red spider lily: 6 recurved thin petals plus long
    stamens) at patch cores, white daisy and yellow wild-chrysanthemum at the fringes. Species come from the same noise
    as the placement.
  * `alphaTest 0.5`, colour gain 1.2, wind `windSway(…,0.25)·y·3`, fade 35–55 m.
  * Higanbana clusters sit near the stele and graves (story).
* **The lone golden tree (胡杨-like old poplar)** on the knoll, from the reference recursive generator:
  * depth 4; `len [3.2, 3.8, 2.6, 1.5, 0.8]`, `rad 0.65`, `radRatio [.5,.56,.6,.62]`, `kids [4,4,4,3]`,
    `start [.45,.25,.2,.25]`, `angle [.6,.65,.7,.75]`, `gnarl [.14,.2,.24,.26,.28]`, `up [.03,.04,.03,.03,.04]`,
    `droop [0,.08,.14,.12,.08]`, `spread [0,.45,.3,.2,.1]`, `segLen [.35,.36,.3,.24,.18]`;
  * trunk lean 0.18 rad **downwind** (wind-sculpted), with root flare lobes;
  * leaf cards 0.35–0.6 m from a canvas atlas of small ovate leaves (sRGB 180–235, 120–175, 20–60);
  * leaf light `sunBack·2.6 + sunWrap·0.4`, ×1.3, plus crown volume normals (70% radial) and interior darkening
    0.35–1;
  * wind via the `flex` hierarchy (`Σ len/(40·r)`), cards inheriting their branch phase (+ small offset);
  * casts dappled shadow and shafts into the far map;
  * placed so its long shadow and shafts cross the default view at 20–60 m.
* **Secondary trees:** 2–4 wind-bent pines on distant swells (reference pine params, pads), plus a star-billboard band
  of shrubs and trees on the rim ridges (reference `xT`, 3k instances, steppe palette).

### 5.8 Budget and culling summary
* **Typical visible blades:** L0 ~27k, L1 ~70k, L2 ~80k → ~1.5M blade vertices, 3 draws. Worst case (looking down) is
  capped by the tile limits at ~2.3M.
* Opaque, no alpha test, no texture fetch except `tHeight`/`tGround`/`tInteract`/`tWindNoise` in the vertex shader. That
  is ~12 fetches per vertex, cacheable because neighbouring vertices of a blade share them. Consider computing per-blade
  data once per instance: `aT == 0` is not available per instance, so rely on the texture cache.
* Grass never casts shadows and is never in the reflection.

---

## 6. Particles and VFX

### 6.1 Ambient (all GPU-driven, camera-box wrapped, zero CPU per frame)
Common rules (reference):
* `p = seed·box + vel·t`, `w = mod(p − lo, box) + lo`, with an edge fade by **scale** for alpha-tested items or by alpha
  for glows.
* Colours always come from `uSunCol`/`uAmbK`/`skyFogColor`/`uFlash`/lamps. Nothing is hard-coded white.
* Additive blending only for emitters, with output `vec4(rgb, 1)`.
* `(1−r²)²` windows on every glow.

| system | count | recipe |
|---|---|---|
| **Pollen / dust motes** | 2,200 `Points` (tier ×) | box 46×18×46 m centred on the camera (y 0.3–6 m above ground). Wander ±2 m on sines, rise 0.05 m/s, drift `wind·0.35·g`. **Shadow-tested in the VS against both maps + `cloudShadow`**. `brightness = lit·edge·(0.25 + 1.6·pow(dot(viewDir,sun),3))`, colour `uSunCol·0.22`, size `clamp(uPR·(2.2+2s)·14/z, 1, 9)` px, profile `exp(−14d²)`, additive. They are the visible grain of the shafts. |
| **Seed fluff (蒲公英/芒 seeds)** | 3,000 instanced 6-vert cupped quads | box 70×26×70. Fall 0.10–0.30 m/s, rise in gusts (`vy += (g−0.6)·0.4`). Drift `wind·t·(1.1+0.9w)·(0.7+0.5g)`, tumble 1.2 rad/s. Canvas fluff sprite (radial filaments), alphaTest 0.4. Petal light `amb + uSunCol·(|N·L|·0.28 + pow(dot(−V,L),5)·0.9 + 0.05)`. Size ×`smoothstep(0.5,0.9,g)`, so they appear in gusts. |
| **Golden leaves** | 350 airborne + 1,200 settled | shed from the tree crown (reference petals-shed: `dur = fallH/(0.75+0.4w)`, drift `wind·life·(1.3+g)`, tumble 2.6 rad/s, 0.5 m wander). They stream downwind across the fight area. Settled leaves hop on gust peaks `max(0, sin(.9t + x·.2 + seed·6) − .9)·.4`. Leaf mesh = the petal mesh with a leaf atlas cell. |
| **Ground mist sheets** | 60 cylindrical billboards | in hollows (cavity < 0.75), 14–30 m wide × 0.32, y 0.4–2.5 m above ground, drifting with the wind. Colour `skyFogColor(viewDir)·0.95 + uSunCol·0.05·pow(sun·rd,4)`, alpha ≤ 0.12·uMist, soft depth fade 6 m (rtCopy.a), near/far fade 4–18 / 150–260 m. **Never within 4 m of the camera.** |
| **Fireflies** (blue hour/night) | 700 of the mote points (seed > 0.3) | below 1.5 m over grass, `blink = pow(max(sin(t(.6+.9s)+90s),0),6)`, colour (0.75,1.0,0.28)·0.9, `uNight`-gated, killed by rain. |
| **Birds** | 3 flocks (8–14) | reference 14-vert mesh, flap bouts, 40–80 m high, near-black `0.03 + sunCol·0.004`, fogged. **On combat start the nearest flock scatters:** centre jumps 60 m downwind over 3 s and flap rate ×1.6. |
| **Dust devil** (optional, far) | 1 | a 30 m tall twisted cylinder of soft sprites 200+ m away on the plain, sunlit and fogged, lasting ~20 s every few minutes. |

### 6.2 Combat VFX (CPU ring buffers → instanced GPU; layer 1)
1. **Sword trail (剑光).**
   * **Sampling:** because animation is procedural (§7.3), **evaluate the blade pose at sub-frame times**, 4 samples per
     frame, and store (base, tip, t). Resample uniformly over the last **0.14 s** (heavy 0.2 s) with Catmull-Rom into 24
     segments. Arcs stay smooth at any frame rate.
   * **Ribbon:** two edges (hilt+0.15 → tip), plus a thin camera-facing tip streak for thrusts.
   * **Shading:** `x` along the ribbon (0 = newest), `y` across (0 = hilt, 1 = edge).
     ```glsl
     float along = pow(1.0-x, 2.6), edge = smoothstep(0.55, 1.0, y), body = smoothstep(0.0, 0.9, y);
     vec3 c = mix(uSunCol*0.18, vec3(1.0,0.85,0.65)*5.0, edge) * along * (body*0.6 + edge);
     ```
     Additive, `depthWrite:false`, depth test on. The core at 3–6 blooms.
   * **Air-cut refraction:** the same ribbon also samples `rtCopy` at `uv + ribbonNormalScreen·0.012·along·(1−edge)`
     and outputs it with alpha `0.8·along·body` in a first, normal-blended draw. This bends the scene behind the swing.
   * **Colour moods:** golden by default, a cold steel-white `(0.8,0.9,1)·4` at blue hour, crimson-tinged on the
     finisher.
2. **Clash sparks (火花).**
   * 24–60 per clash, from a 256-entry ring buffer of instanced stretched quads (rain-streak code: `axis = vel·0.03`,
     width 0.012 m).
   * Direction: a cone of 35° around `reflect(bladeDir, contactNormal)`, speed 4–9 m/s, gravity 9.8, drag 1.5/s,
     life 0.25–0.6 s, bounce once on the ground at 0.3 restitution.
   * Colour `(1.0,0.6,0.25)·mix(20, 2, age)` cooling toward (1,0.3,0.08).
   * Also a **lamp** `lamps.add({pos, color:[1,.62,.3], weight:5, ttl:0.12})` so faces and grass flash orange, and a
     **hit glow** sprite r 0.5 m (core `exp(−(rr/.03)²)·5`, inner `exp(−(rr/.1)²)`, halo `exp(−(rr/.3)²)·.35`),
     `depthTest:false` with 5-tap manual occlusion from `rtCopy.a` (reference wisp glow).
   * **Perfect parry:** 2× count, a spark star (4 thin crossed quads, 0.6 m, 80 ms), and a white-hot flash.
3. **Blood as ink (墨血).** It is stylised and tasteful. It reads as calligraphy, not gore.
   * **Droplets:** 20–40 instanced stretched quads, dark crimson (0.25,0.012,0.01), lit
     (`amb + sunC·0.4·NdotL + back·0.5` for a red glow when backlit), alpha-tested. Speed 2–5 m/s along the slash
     tangent, gravity.
   * On ground contact, each droplet stamps `tInteract.B` (r 0.08–0.2 m).
   * **Ink bloom:** one or two soft sprites that expand 0.3 → 1.2 m over 0.7 s and dissolve through a noise threshold
     `smoothstep(age, age+0.15, fbm(uv·4 + age))`. Colour (0.10,0.005,0.006) at alpha 0.6 → 0. They look like ink
     blooming in water.
   * **Ink mode** option: pure black ink (0.01,0.01,0.012) for a no-red setting.
   * A dead enemy leaves a slowly spreading stain (B decays over ~2 min).
4. **Grass clippings.**
   * At cut arcs: 30–80 blade fragments. Instanced 6-vert strips 5–12 cm, coloured from the local species tip/mid.
   * Launched along the slash tangent at 2–4 m/s, then wind drift `wind·life·(1.3+g)`, tumble, fall 0.6–1.0 m/s,
     settle, and shrink after 1.5 s.
   * Petal lighting with back-scatter, so they glitter gold against the sun.
5. **Dust puffs (尘).**
   * From footfalls on the road or dirt (not dense grass), dodges and heavy landings: 4–10 soft quads, 0.3 → 1.6 m over
     1.2 s.
   * Colour `skyFogColor(viewDir)·0.6 + groundAlbedo·0.4`, alpha ≤ 0.25, soft depth fade 0.5 m, near-camera fade.
   * They also raise `uDustAmt` (feeds the shaft density) and write `tInteract.A`.
6. **Shockwave (heavy/ultimate).**
   * `uShock` ring in the grass (§5.6).
   * A flat ground ring decal of dust (additive-light alpha).
   * A screen-space refraction ring: a quad at the impact sampling `rtCopy` with radial offset `0.02·(1−age)`.
   * `post.kick({ca:0.02, radial:{…}, exposure:0.2, ms:120})`.
7. **Blade glint (telegraph).** An enemy attack wind-up shows an HDR star at the blade tip (4-point cross, 0.25 m,
   `uSunCol·3`, 0.18 s) aligned to the sun reflection. It is the parry cue, and diegetic.
8. **Hit response recipe** (per hit class, all additive):

| event | hit-stop | post kick | camera | VFX |
|---|---|---|---|---|
| light hit | 50 ms | exposure +0.10 / 60 ms | shake 0.25 | 20 droplets, clippings 30, lamp 3 |
| heavy hit | 90 ms | +0.2, CA 0.015, radial 0.02 | shake 0.5, FOV −2° punch | 35 droplets + ink bloom, shock 0.6 |
| clash / block | 60 ms | +0.15 | shake 0.3 | sparks 30, glow, lamp 5 |
| perfect parry | 110 ms | +0.25, CA 0.02 | micro-zoom 3% for 0.25 s | sparks 60 + star, slow-mo 0.35× for 0.4 s |
| kill (last enemy) | 140 ms | +0.3 | letterbox in, slow-mo 0.25× for 0.8 s, orbit to side | ink bloom ×2, leaf burst, wind spike 2.6, (storm mood: lightning) |

---

## 7. Character and camera

### 7.1 Art direction for believable procedural characters
The procedural character will be judged against photographic grass and sky. We win by **silhouette, backlight, cloth
motion and weight, not faces**:
* The **斗笠 (conical bamboo hat, r 0.30 m, h 0.13 m, a slightly concave cone with a 1 cm rim roll)** hides the face in
  shadow.
* Layered robes hide anatomy.
* Contre-jour turns everything into rim and silhouette.
* Every garment edge moves with the shared wind.

**Hero costume:**
* 月白 pale ash-blue **outer robe (长衫)** falling to mid-shin, with high side slits; the front and back panels fly free;
* dark indigo cross-collar inner layer and trousers;
* black cloth boots;
* wide crimson **sash (腰带)** with two 0.6 m tails;
* a **jian** worn on the left hip in a dark lacquer scabbard. The **crimson sword tassel (剑穗, 0.25 m)** is the moving
  red accent;
* hair tied with a long tail (0.45 m) escaping below the hat;
* an optional thin black gauze veil hanging from the hat brim: alpha-hashed strips, FXAA/TAA friendly.

**Bandits** use dark leather, brown and black cloth, headwraps, fur-trimmed vests and bracers. Weapons: **dao** (curved
saber), **spear** (qiang). **Boss:** a masked blade master with twin dao or a long 苗刀, in dark red and black.

### 7.2 Procedural build (`src/char/`)
* **Skeleton** (built in code, metres, Mixamo-like names for tooling):
  * root, pelvis, spine1, spine2, chest, neck, head;
  * clavicle/upperArm/foreArm/hand ×2;
  * fingers per hand: thumb1-2, index1-2, middle1-2, ringPinky1-2;
  * thigh/shin/foot/toe ×2;
  * `weapon_R` (grip frame), `scabbard_L`;
  * hat is a child of head.
  * Height 1.78 m (7.5 heads).
* **Body mesh:** lofted elliptical rings along bone segments (torso 14 rings, limbs 8, 16 radial sides), smooth-skinned
  by distance-to-segment weights (2–4 influences, normalised, smoothed by 2 Laplacian passes).
  * Hands are low-poly mittens with separate thumb and index/middle segments, enough for 剑指 (sword-finger: index and
    middle extended).
  * The head is an ellipsoid with brow, nose and jaw displacements.
  * Only neck, hands, lower legs and a sliver of face are ever visible.
* **Robe and cloth:**
  * The upper robe is a skinned lofted shell 1.5–3 cm outside the torso.
  * Sleeves are wide cones skinned to the arms, plus a 3-node spring chain at each cuff.
  * **Lower skirt panels (front, back, left, right)** are CPU verlet cloth, 6×10 particles each:
    * pinned to a skinned waist ring;
    * 60 Hz fixed step with 2 sub-steps during attacks;
    * 4 constraint iterations (structural + shear), damping 0.02;
    * collisions against thigh/shin capsules;
    * forces: gravity plus aero drag `k·(windVector(x,z,t)·windGust − v)` with k = 1.8.
  * Rebuild the geometry and normals every frame (~240 verts).
* **Chains** (verlet with capsule collision):
  * sash tails 2×10 nodes, ribbon 7 cm;
  * sword tassel 6 nodes + fringe card;
  * hair tail 8 nodes, 3 offset ribbons;
  * enemy headwrap tails.
* **Materials** (all patched, `SUNLIGHT_TERMS`):
  * **Outer robe:** `MeshPhysical`, sheen 0.6, sheenColor (0.9,0.85,0.8), roughness 0.85, **thin-cloth transmission**
    `directDiffuse += sunC·alb·(1,0.85,0.7)·(sunBack·0.30 + sunWrap·0.08)`. The pale robe glows at the edges when
    backlit.
  * **Indigo layers:** no transmission (the contrast makes the lit parts glow), roughness 0.9.
  * **Straw hat:** canvas weave texture (radial + spiral strands), `albedo·(0.95,0.8,0.58)`,
    `+ sunC·alb·(1,0.78,0.55)·(sunBack·0.35 + sunWrap·0.06)`.
  * **Skin:** `+ sunC·(0.9,0.35,0.22)·alb·(sunBack·0.55 + sunWrap·0.12)` (red ear/hand rim), roughness 0.6.
  * **Jian blade:** `MeshPhysical`, metalness 1, roughness 0.16 (edge bevel 0.10), **anisotropy 0.6 along the blade**, a
    diamond cross-section with a central ridge, IBL from the sky env.
    * A sun glint every time the flat catches the light (blooms at `uSunCol` ~5).
    * Bronze guard (0.32,0.36,0.26) metal 0.75. Cord-wrapped grip.
  * **Wetness/dirt:** `uWetBias` for sweat or rain. A per-material `dirt` scalar darkens the hem after rolls.
* **Contact grounding:** feet IK (below), actor contact AO (§5.5), and lower-leg grass darkening
  `ao *= mix(0.55, 1, smoothstep(0, grassH, yAboveGround))` in actor materials (legs sink into the field).

### 7.3 Animation system (procedural keyposes + IK + secondary)
* **Pose data:** each move is a list of keyposes (per-bone Euler offsets from rest, in degrees) with times,
  easing (`easeOutCubic` for strikes, `easeInOutSine` for recoveries), and root-motion curves. Blend with quaternion
  slerp.
* **Layers**, evaluated from rest every frame so nothing accumulates:
  1. locomotion lower body;
  2. action (upper or full body);
  3. additive breath (chest ±1.2% at 1.25 rad/s, shoulders ±4 mm) and idle sway `0.004·hN` pivoting at the ankles;
  4. spine aim to the lock target (`angle/3` per spine bone, neck −0.45×, head −0.35×);
  5. **two-bone IK:** feet to `heightAt` with the knee hint `foot + fwd·0.6 + up·0.55`, `h ≤ 0.999·(l1+l2)`, hips lowered
     by the larger correction, feet aligned to the ground normal. Also the off hand in 剑指 or on the scabbard;
  6. secondary chains and cloth.
* **Locomotion:** procedural gait.
  * Stride `0.6 + 0.35·speed`, cadence from speed.
  * Hip bob `0.03·|sin(2φ)|`, pelvis twist ±8°, counter-rotating chest, arm swing (off arm only while armed).
  * Run lean 8–12°. Stop and turn anticipation with 0.12 s weight shifts.
  * Walk 1.6 m/s, run 5.2 m/s, **light-foot sprint (轻功) 8.5 m/s** with long floating strides and robe streaming.
* **Evaluability:** `evaluatePose(t)` is pure, so trails sample sub-frames and hit detection sweeps the blade capsule
  between sub-samples (no tunnelling).
* **Move list** (seconds: startup / active / recovery; cancel window = last 40% of recovery):

| move | frames | notes |
|---|---|---|
| light 1 (horizontal R→L) | 0.12 / 0.08 / 0.25 | off hand snaps to 剑指 |
| light 2 (rising L→R) | 0.10 / 0.08 / 0.25 | |
| light 3 (thrust, lunge 1.8 m) | 0.16 / 0.07 / 0.35 | tip streak trail |
| heavy (leaping overhead cleave) | 0.35 / 0.12 / 0.45 | root motion 2.5 m + 0.6 m hop, shockwave |
| parry | active 0.18 (perfect ≤ 0.12) | blade across the body, spark on success |
| dodge (side-step / back-step) | 0.35, i-frames 0.08–0.28 | robe and grass whip |
| dash slash 瞬斩 (special) | 0.20 / 0.10 / 0.40 | 7 m dash through, slow-mo 0.35× on hit, cut line in the grass |
| draw/sheathe | 0.5 / 0.6 | sheathing after a kill is the signature beat |
* **Enemy AI (brief):**
  * circle at 4–6 m; an attack-token system (max 2 attacking);
  * telegraph glint 0.35 s before every strike (§6.2.7);
  * stagger on perfect parry;
  * saber and spear kits;
  * the boss has a 3-phase mood and wind escalation.

### 7.4 Katana variant (if a ronin skin is chosen)
The grip IK is the reference pole solver: left hand at `hilt + axis·0.11 m`, elbow hint `shoulder + (−0.45,−0.7,−0.2)`,
hand basis built from the sword axis, finger curls 0.75/0.85/1.15. Swap the douli for a kasa.

### 7.5 Combat camera (`src/game/camera.js`, derived from the reference `kf`)
| param | value |
|---|---|
| FOV | 48° (+4° kick while sprinting, eased at rate 6; −2° punch on heavy hits) |
| distance | 4.2 m default, wheel 2.8–7 m; 5.5 m when locked on |
| pitch | 0.18 rad, clamp [−0.35, 0.9] |
| pivot | chest 1.45 m, **shoulder offset 0.35 m** right, swapped when the target is on the right |
| smoothing | params 12 (mouse) / 4 (auto); position 9; target 14. All `1 − exp(−dt·rate)` on **real dt** (hit-stop never freezes the camera). |
| look lead | 0.8–1.5 m in the move direction. Lock-on aims at the player/enemy midpoint weighted 0.6/0.4. |
| auto-recenter | after 1.5 s without mouse input while moving: yaw → heading at rate 1.5 |
| **sun-seeking idle** | after 10 s without input or enemies, cinematographer orbit `0.55 sin(0.045t) + 0.25 sin(0.017t+1.3)`, biased so the view stays within ±50° of the sun azimuth |
| collision | analytic, 3 relaxation passes toward the head pivot: `y ≥ heightAt + 0.6`, tree trunk/crown spheres, boulder spheres, stele box, plus an r = 0.25 sphere-cast for props. Pull in at rate 20, release at rate 3. |
| shake | decaying sinusoids `sin(23t)`, `sin(17t)`, amplitude × bump, bump decays 2.5/s. Yaw/roll ≤ 0.6°, position ≤ 4 cm. |
| first frame | snap position and target, no fly-in |

**Cinematics:**
* **Encounter intro (3 s):** letterbox in; a low wide shot 40 cm above the grass tips looking toward the sun as the
  bandits crest a swell in silhouette; wind rises; push-in to the hero, who pulls the hat brim down; letterbox out.
* **Final kill:** 0.25× slow-mo, orbit 70° to a side profile against the sun, sheathe beat, grass settles.

**Input:**
* Desktop: pointer lock for mouse-look, WASD, LMB light, RMB/hold heavy, Space dodge, Q parry, Shift sprint,
  Tab lock-on.
* Touch: left stick, right-side drag to orbit, attack buttons.
* Gamepad: standard mapping.
* Clear keys on `blur`.

**Audio** (WebAudio, synthesised, no files):
* **wind bed:** pink noise → band 200–1200 Hz, gain from the camera `windGust`, plus a whistle layer in gusts;
* **grass rustle:** movement-gated noise bursts, 1–4 kHz;
* **whoosh:** noise band sweep 800→3000 Hz over 180 ms, gain from blade-tip speed;
* **clash:** inharmonic partials ×(1, 2.76, 5.4, 8.9) of 1.8 kHz, decays 0.4–1.2 s, plus a transient;
* **hit:** 80 Hz thump plus cloth noise;
* **footsteps:** grass/road variants;
* **thunder:** reference recipe.

---

## 8. Performance budget and tricks

### 8.1 Targets
* 60 fps at 1080p on an RTX 3060 / M1 Pro-class GPU (High).
* 60 fps at an adaptive 0.7–1.0 scale on an M1/Iris Xe-class GPU (Medium).
* 30+ fps on Low.
* CPU < 4 ms per frame.

| GPU pass (High, 1080p) | ms |
|---|---|
| near shadow (actors) + far shadow (amortised; ~4 ms on refresh frames) | 0.4 + 0.1 |
| opaque: grass 3.5, terrain 1.0 (early-Z helped), actors 0.6, props/tree/rocks 0.7, sky 0.4, mountains 0.1 | 6.3 |
| copy + transparent VFX/particles/mist | 1.0 |
| volumetric (half res, 26×2 shadow taps) + blur + temporal | 1.3 |
| SSAO + blur | 0.5 |
| bloom (12 passes) | 0.5 |
| composite + final | 0.6 |
| **total** | **≈ 10.7 ms** (headroom for spikes and TAA) |

| CPU | ms |
|---|---|
| animation + IK (player + 6 enemies) | 0.8 |
| cloth/chains (player full, near enemies reduced) | 0.4 |
| tile selection, culling, uniforms, lamps sort | 0.3 |
| VFX ring buffers + trails | 0.3 |
| three.js submission (~150–220 draws, 4 render calls) | 1.5 |

* Draw calls < 250. Triangles/vertices < 4M / 4M.
* VRAM < 400 MB: world textures 48 MB, ground sets ~50 MB with mips, shadow maps 64+16 MB, RTs ~90 MB at 1080p.

### 8.2 Quality tiers (`src/core/quality.js`)
| setting | Ultra | High | Medium | Low |
|---|---|---|---|---|
| DPR cap / scale range | 2 / 0.8–1.25* | 1.5 / 0.7–1.0 | 1.25 / 0.6–1.0 | 1 / 0.5–0.85 |
| grass densityMul / L2 outer radius | 1.3 / 110 m | 1.0 / 90 m | 0.6 / 70 m | 0.35 / 55 m |
| far / near shadow | 4096 / 2048 | 4096 / 2048 | 2048 / 1024 | 2048 / 1024 |
| vol steps (res) | 32 (half) | 26 (half) | 18 (half) | 12 (quarter) |
| SSAO | 12 samples | 8 | 6 | off |
| bloom levels | 6 | 6 | 5 | 4 |
| particles × | 1.0 | 1.0 | 0.6 | 0.35 |
| silver grass / flowers × | 1.0 | 1.0 | 0.6 | 0.4 |
| cloth sim | all actors < 30 m | player + 2 | player | player at 30 Hz |
| TAA (M5) | on | on | off | off |

\* Supersampling above 1.0 is only for DPR 1 displays.

Start on High. If the resolution scale sits at its floor for 10 s, drop a tier. Grass density and step counts are
uniforms. Shadow-size changes dispose `shadow.map`.

### 8.3 Tricks (all mandatory unless marked optional)
1. **One uniform object by reference.** One write per frame reaches every program.
2. **Dummy fog** switches analytic atmosphere into every material for free.
3. **GPU-procedural grass:** 3 draws, no per-blade memory, tile-level frustum culling via `uTiles[64]`, LOD by hashed
   thinning plus width compensation, no alpha, early-Z by `renderOrder`.
4. **Terrain after grass and actors; sky last.** Early-Z kills hidden terrain and sky fragments.
5. **Throttled static far shadow** (on-demand refresh, texel-snapped, focus 40 m ahead) plus a tiny per-frame actor
   shadow, with casters split by camera layers through the 1×1 throwaway render.
6. **Half-res effects** capped at `min(K,1.3)·0.5` of CSS pixels. The unsharp mask restores crispness.
7. **Shafts:** IGN jitter, 26 steps, bilateral blur, reprojected temporal history. Never full-res.
8. **Bloom threshold 0.9** with a soft knee. Only real highlights bloom, and the chain stays at half res.
9. **Env cube** re-captured only on sky change (not every 24 frames).
10. **Virtual lamps (8 slots, sorted by d²/weight):** sparks and torches light the world without `PointLight` recompiles.
11. **Camera-box particle wrapping and vertex-shader motion.** No CPU per particle except the ring-buffered combat VFX.
12. **Distance LOD inside shaders:** detail normals < 75 m, far resample 18–70 m, cheap terrain path > 260 m, canopy
    takeover 25–85 m, flower fade 35–55 m, plume fade 110–140 m, mist 150–260 m.
13. **Precompile everything** behind the loader (`compileAsync` + KHR_parallel_shader_compile), with pooled enemies and
    VFX forced visible. No first-fight hitch.
14. **Seeded determinism** (mulberry32 per system), so every run and replay is identical.
15. **Real dt vs sim dt:** hit-stop and slow-mo change only sim time. Camera, UI and audio run on real dt.
16. **Half-rate far actors:** enemies beyond 25 m update animation at 30 Hz and skip cloth (static skirt). Beyond 60 m
    they freeze their pose between AI ticks.
17. **Adaptive resolution** is the main lever for grass fill-rate. Keep the 90-frame warm-up and the 23.5/17.6 ms
    hysteresis.
18. **Profiling hook:** `window.__perf = {gpu: EXT_disjoint_timer_query per pass, cpu, draws, tris, tier, scale}`, plus a
    `?debug` overlay. Implementers must report per-pass ms for the acceptance run.

---

## Appendix A. Module map and ownership
```
index.html                 loader (sword-stroke), canvas, __load
src/main.js                boot, build stages with MessageChannel yields, loop, time
src/core/globals.js        G uniforms            src/core/prelude.glsl.js   GLSL helpers (§2.6, §5.1)
src/core/chunks.js         ShaderChunk patches   src/core/patch.js          patchMaterial / patchAll
src/core/env.js            keyframes, moods, lights, env cube   src/core/wind.js   CPU wind mirror + tWindNoise
src/core/lamps.js          virtual lamps         src/core/rng.js, noise.js  mulberry32, simplex, Ln, Cf
src/core/quality.js        tiers + adaptive res  src/core/time.js           sim/real time, hit-stop, slow-mo
src/render/pipeline.js     RTs + passes (§2.3–2.4)   src/render/shadows.js  sunFar/sunNear, snapping, refresh
src/world/ground.js        height fn, road, bakes (tHeight/tSplat/tGround)   src/world/terrain.js  mesh + material
src/world/texbake.js       procedural ground sets   src/world/sky.js   src/world/mountains.js   src/world/rocks.js
src/world/props.js         stele, pavilion       src/veg/grass.js   src/veg/plumes.js   src/veg/flowers.js
src/veg/tree.js            recursive trees       src/fx/ambient.js (motes, seeds, leaves, fireflies, mist, birds)
src/fx/vfx.js              combat VFX (§6.2)     src/fx/interaction.js  tInteract, uActors/uShock/uSlash
src/char/skeleton.js, body.js, cloth.js, materials.js, anim.js, moves.js, ik.js
src/game/player.js, enemy.js, ai.js, combat.js, camera.js, input.js, encounter.js, audio.js, hud.js
```

## Appendix B. Build order (milestones)
* **M1 Look foundation:** globals, chunks, env (golden), sky, mountains, terrain + bakes + texbake, pipeline (all
  passes), far shadow, loader. *The exit test is a still golden-hour plain matching the §1.4 palette.*
* **M2 The field:** wind (GPU + CPU), grass L0–L2 + canopy hand-off, honami, plumes, flowers, tree, rocks, ambient
  particles, cloud shadows.
* **M3 The swordsman:** skeleton, body, cloth, materials, locomotion, IK, camera, near shadow, actor contact, grass push
  and trample.
* **M4 Combat:** moves, enemies and AI, hit detection, VFX §6.2, hit-stop, post kicks, audio, HUD (ink-brush health
  stroke), encounters and moods.
* **M5 Polish:** TAA, storm set piece, blue hour/night with fireflies, the phase-2 stream (reference water recipe, mirror
  on layers {0,4}), cinematics, tier auto-detect.

## Appendix C. Acceptance checklist (visual tests)
1. Looking into the sun, grass tips glow orange with **no** glow inside the tree's shadow. The robe edge and hat rim glow.
   Shafts come from the tree and from the swordsman.
2. Turning 180°: the scene goes cool blue-grey, the alpenglow snow range is visible, and the fill keeps faces readable.
3. Honami bands visibly roll toward a sun-facing camera every ~10 s and continue past 90 m on the terrain canopy.
4. No visible seam between the L2 blades and the terrain canopy at 60–90 m, in both directions relative to the sun.
5. The grey card reads sRGB 150–175. Grass is gold, not lime. The sky zenith is slate, not cyan.
6. The hero's shadow is crisp (≈2 cm texels), 10 m long, and lies across lit grass. Enemies beyond 20 m keep contact AO.
7. A heavy slash leaves cut stubble, clippings and a shockwave. Footsteps leave trample trails that recover in about
   12 s.
8. Sparks light the faces through the lamp array. The trail blooms and refracts. Ink-blood stains the ground and fades.
9. Hit-stop freezes grass and particles while the camera keeps moving.
10. No shader hitch on the first fight. High tier holds ≥ 60 fps at 1080p on the reference GPU with per-pass timings
    reported.
