// Shared uniforms + constants (schema from docs/BIBLE.md §0.3). Every material that needs time, wind, sun, fog,
// terrain textures or interaction references THESE {value} objects (not copies), so writers drive the whole
// world by mutating G.*.value. Owner: integrator (file). Writers per group:
//   time → app.js · sun/fog/sky/weather/post keys → environment (S) · wind strength → environment/gameplay
//   tHeight/tGround/tSplat/uWorldRect → terrain (W) · tInteract/uActors/uShock/uSlash/uCamGround → interaction (V)
//   uLamps* → core/lamps.js
// Modules MAY attach extra shared uniforms at runtime in their own files (G.tFoo = { value }) — document them.
import * as THREE from 'three';

export const MAX_ACTORS = 8;
export const MAX_LAMPS = 8;

// Golden-hour key (bible u = 0.70): sun 9.5° elevation toward −x −z.
export const SUN_DIR = new THREE.Vector3(-0.6, 0.165, -0.78).normalize();
export const WIND_DIR = new THREE.Vector2(0.62, 0.78); // blowing toward (xz). From the sun toward the default camera.

const v3 = (x, y, z) => ({ value: new THREE.Vector3(x, y, z) });
const c3 = (r, g, b) => ({ value: new THREE.Color(r, g, b) });
const v4arr = (n, init = [0, -999, 0, 0]) => ({ value: Array.from({ length: n }, () => new THREE.Vector4(...init)) });

const fogCool = c3(0.33, 0.43, 0.50);
const fogWarm = c3(1.05, 0.66, 0.36);
const actors = v4arr(MAX_ACTORS);

export const G = {
  // time
  uTime: { value: 0 },            // sim time: scaled by slow-mo, ~frozen in hit-stop
  uRealTime: { value: 0 },        // wall time (UI shimmer only)
  uFrame: { value: 0 },
  // sun & sky
  uSunDir: { value: SUN_DIR.clone() },          // world dir TOWARD the key light (moon at night)
  uSunCol: c3(5.6, 3.55, 1.75),                 // HDR sun radiance for custom shaders
  uSunVis: { value: 1 },
  uMoonDir: v3(0.5, 0.4, 0.77),
  uSkyZen: c3(0.085, 0.16, 0.27),
  uSkyUp: c3(0.26, 0.36, 0.45),
  uCloudLit: c3(1.3, 0.936, 0.598),
  uCloudShade: c3(0.34, 0.33, 0.42),
  uHorizonGlow: c3(1.0, 0.55, 0.30),
  uCloudShadow: { value: new THREE.Vector4(0.5, 800, 0.0022, 6) }, // strength, deck height m, freq 1/m, drift m/s
  uAmbK: c3(1, 1, 1),
  // fog / atmosphere
  uFogCool: fogCool,                            // fog colour looking away from the sun
  uFogWarm: fogWarm,                            // fog colour looking toward the sun
  uFogParams: { value: new THREE.Vector4(0.0014, 0.035, 0.0, 2.4e-4) }, // height-fog density, falloff, base y, linear haze /m
  uMist: { value: 0.6 },                        // ground-mist multiplier
  // weather
  uNight: { value: 0 }, uStorm: { value: 0 }, uRain: { value: 0 }, uWet: { value: 0 },
  uFlash: { value: 0 }, uFlashDir: v3(0, 1, 0),
  // wind: xy direction (unit, xz), z strength (0.6 calm … 1 default … 2.6 storm), w unused
  uWind: { value: new THREE.Vector4(WIND_DIR.x, WIND_DIR.y, 1.0, 0) },
  tWindNoise: { value: null },                  // set by core/wind.js
  // terrain bakes (set by terrain, W)
  tHeight: { value: null }, tGround: { value: null }, tSplat: { value: null },
  uWorldRect: { value: new THREE.Vector4(-512, -512, 1024, 1 / 1024) },
  // interaction (set by interaction, V)
  tInteract: { value: null },
  uInteractRect: { value: new THREE.Vector4(-32, -32, 64, 1 / 64) },
  uActors: actors,                              // xyz = actor feet (world), w = radius (~0.45); w<=0 inactive
  uShock: v4arr(4, [0, 0, -999, 0]),            // x, z, startTime (sim), strength
  uSlash: v4arr(4, [0, 0, 0, 0]),               // chord x0, z0, x1, z1
  uSlashB: v4arr(4, [-999, 0, 0, 0]),           // startTime, strength, height, 0
  uCamGround: { value: new THREE.Vector3(0, 0, 0.8) }, // camera xz + radius
  // virtual lamps (core/lamps.js)
  uLamps: v4arr(MAX_LAMPS, [0, -999, 0, 0]),    // xyz pos, w weight
  uLampC: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Color(0, 0, 0)) },
  uLampN: { value: 0 },
  uLampOn: { value: 1 },
  // misc
  uCamPos: { value: new THREE.Vector3() },
  uResolution: { value: new THREE.Vector2(1, 1) },

  // ---- legacy aliases (same objects) used by early stubs; prefer the bible names above ----
  uFogColor: fogCool,
  uFogSunColor: fogWarm,
  uBenders: actors,
  uSunColor: c3(1.0, 0.74, 0.47),               // DirectionalLight colour (normalised); intensity below
  uSunIntensity: { value: 3.3 },
  uSkyZenith: c3(0.085, 0.16, 0.27),
  uSkyHorizon: c3(1.0, 0.55, 0.30),
  uGroundBounce: c3(0.21, 0.175, 0.08),
};

// Render layers (bible §0.2). Main camera: {0,2,3} opaque, {1} transparent.
export const LAYERS = {
  WORLD: 0,          // terrain, rocks, trees, props, mountains, sky
  TRANSPARENT: 1,    // blended/additive VFX, motes, trails, sparks, mist cards
  MAIN_ONLY: 2,      // grass tiers, flowers, plumes, debris (never cast shadows)
  ACTORS: 3,         // characters, weapons, cloth, hair (near shadow map only)
  MIRROR_ONLY: 4,
  DEBUG: 7,
  DEFAULT: 0,
};

// World scale conventions: 1 unit = 1 m, +Y up. Characters face +Z locally.
export const WORLD = {
  arenaRadius: 180,      // soft boundary (bible §0.1)
  bakeHalf: 512,         // terrain bakes cover ±512 m
  terrainHalf: 1500,     // terrain mesh stops at ±1.5 km; mountain rings beyond
  seed: 1337,
};
