// GLSL prelude appended to ShaderChunk.common by core/chunks.js (bible §0.4 / §2.6). Owner: sky/lighting (S).
// Every built-in material (both stages) therefore sees the shared uniform block G and these helpers:
//   ATMOS_GLSL  wx_applyAtmosphere(T), wx_skyFogColor, wx_fogBase, wx_sunGlow, wx_cloudShadow, wx_groundHeight,
//               wx_groundInfo, wx_mistTau, wx_ign, wx_fbm3v  (core/atmosphere.js)
//   GLSL_NOISE  wx_hash12/22/13, wx_vnoise, wx_vnoise3, wx_fbm, wx_fbm3, wx_snoise  (core/noise.js)
//   WIND_GLSL   windGust, windSway, windFlutter  (core/wind.js)
// Everything is guarded (U() per uniform, #ifndef per block), so a hook may also paste ATMOS_GLSL / WIND_GLSL /
// GLSL_NOISE into a built-in shader. Only wx_-prefixed names are added (plus the wind functions), to stay clear of
// helpers that other modules define locally. Also defines WX_FOG when the material wants the atmosphere
// (USE_FOG from the dummy scene.fog, or WX_ATMOS_ON from patchMaterial).
import { U } from './glsl.js';
import { MAX_ACTORS, MAX_LAMPS } from './globals.js';
import { GLSL_NOISE } from './noise.js';
import { WIND_GLSL } from './wind.js';
import { ATMOS_GLSL } from './atmosphere.js';

// Types follow bible §0.3. Colours are vec3.
const DECLS = [
  ['float', 'uTime'], ['float', 'uRealTime'], ['float', 'uFrame'],
  ['vec3', 'uSunDir'], ['vec3', 'uSunDirTrue'], ['vec3', 'uSunCol'], ['float', 'uSunVis'], ['vec3', 'uMoonDir'],
  ['vec3', 'uSkyZen'], ['vec3', 'uSkyUp'], ['vec3', 'uCloudLit'], ['vec3', 'uCloudShade'], ['vec3', 'uHorizonGlow'],
  ['vec4', 'uCloudShadow'], ['vec3', 'uAmbK'],
  ['vec3', 'uFogCool'], ['vec3', 'uFogWarm'], ['vec4', 'uFogParams'], ['float', 'uMist'], ['float', 'uGroundY'],
  ['float', 'uNight'], ['float', 'uStorm'], ['float', 'uRain'], ['float', 'uWet'], ['float', 'uFlash'], ['vec3', 'uFlashDir'],
  ['vec4', 'uWind'], ['sampler2D', 'tWindNoise'],
  ['sampler2D', 'tHeight'], ['sampler2D', 'tGround'], ['sampler2D', 'tSplat'], ['vec4', 'uWorldRect'],
  ['sampler2D', 'tInteract'], ['vec4', 'uInteractRect'],
  ['vec4', 'uActors', `[${MAX_ACTORS}]`], ['vec4', 'uShock', '[4]'], ['vec4', 'uSlash', '[4]'], ['vec4', 'uSlashB', '[4]'],
  ['vec3', 'uCamGround'],
  ['vec4', 'uLamps', `[${MAX_LAMPS}]`], ['vec3', 'uLampC', `[${MAX_LAMPS}]`], ['int', 'uLampN'], ['float', 'uLampOn'],
  ['float', 'uWetBias'], ['vec3', 'uCamPos'], ['vec2', 'uResolution'],
];

export const PRELUDE_GLSL = /* glsl */`
// ---- wx prelude (core/prelude.js) ----
#if defined( USE_FOG ) || defined( WX_ATMOS_ON )
#define WX_FOG
#endif
${DECLS.map(([t, n, a]) => U(t, n, a)).join('')}
${GLSL_NOISE}
${WIND_GLSL}
${ATMOS_GLSL}
// ---- end wx prelude ----
`;
