// Global ShaderChunk patches (bible §2.6), run once by app.js BEFORE any material compiles. Owner: sky/lighting (S).
// STABLE API:
//   installChunks(app)   patches THREE.ShaderChunk + Material.prototype, sets the dummy scene.fog (idempotent)
//   SUNLIGHT_TERMS       re-export of the translucency snippet (see core/atmosphere.js)
//
// What every built-in material gets (Basic/Lambert/Phong/Standard/Physical/Toon/Points/Sprite/Line/Shadow):
//   common                 += PRELUDE (G uniform declarations + wx_* helpers + wind), see core/prelude.js
//   fog_*                  world position varying vFogWP (from mvPosition, so skinning/instancing/batching/morphs and
//                          GPU-generated grass all work) + per-vertex vWxAtm = (cloud-shadow factor, ground-mist depth);
//                          fragment: gl_FragColor.rgb = wx_applyAtmosphereT(...). Gated by WX_FOG (USE_FOG from the
//                          dummy scene.fog, or WX_ATMOS_ON from patchMaterial).
//   lights_pars_begin      += vec3 gSunColor, gSunDir (view space) — the shadowed, cloud-shadowed key light, for
//                          SUNLIGHT_TERMS translucency.
//   lights_fragment_begin  dual shadow maps (bible §2.5): directional light 0 = sunFar (lit, static-world map),
//                          light 1 = sunNear (never lit; its actor-only shadow map multiplies light 0), cloud shadow.
//                          Light 1 is skipped only when two shadow-casting directional lights exist.
//   lights_fragment_end    8 virtual lamps (G.uLamps, core/lamps.js) through the material's own RE_Direct.
//   lights_physical_fragment / lights_lambert_fragment   rain wetness (G.uWet + per-material uWetBias).
// Material.prototype.onBeforeCompile / customProgramCacheKey are replaced so built-in materials that never call
// patchMaterial still receive the shared G uniforms (materials with their own hooks: use addShaderHook, or assign G).
// Normal-map / roughness channel semantics are NOT changed (Poly Haven: nor_gl RGB, ARM = AO/Rough/Metal).
import * as THREE from 'three';
import { PRELUDE_GLSL } from './prelude.js';
import { globalHook, SUNLIGHT_TERMS } from './atmosphere.js';

export { SUNLIGHT_TERMS };

const C = THREE.ShaderChunk;
const TAG = '// wx-chunks';

const FOG_PARS_VERTEX = /* glsl */`
#ifdef WX_FOG
varying vec3 vFogWP;
varying vec2 vWxAtm;   // x: cloud-shadow sun visibility, y: ground-mist optical depth
#endif
`;

const FOG_VERTEX = /* glsl */`
#ifdef WX_FOG
vFogWP = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );   // inverse rigid view transform
vWxAtm = vec2( wx_cloudShadow( vFogWP ), wx_mistTau( vFogWP, cameraPosition ) );
#endif
`;

const FOG_PARS_FRAGMENT = FOG_PARS_VERTEX;

const FOG_FRAGMENT = /* glsl */`
#ifdef WX_FOG
gl_FragColor.rgb = wx_applyAtmosphereT( gl_FragColor.rgb, vFogWP, vWxAtm.y );
#endif
`;

// Replaces the directional-light block of lights_fragment_begin (verified against r186's chunk text).
const DIR_BLOCK = /* glsl */`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		#if ( UNROLLED_LOOP_INDEX != 1 ) || ( NUM_DIR_LIGHT_SHADOWS < 2 )
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		#if ( UNROLLED_LOOP_INDEX == 0 )
			#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 1 )
			directLight.color *= receiveShadow ? getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ) : 1.0;
			#endif
			#ifdef WX_FOG
			directLight.color *= vWxAtm.x;
			#endif
			gSunColor = directLight.color; gSunDir = directLight.direction;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif
	}
	#pragma unroll_loop_end

#endif
`;

// Virtual lamps (reference verbatim: /(d²+0.35), fade 20–30 m) through the material's RE_Direct.
const LAMP_LOOP = /* glsl */`
#if defined( RE_Direct )
if ( uLampOn > 0.0 ) {
	IncidentLight wxLamp;
	wxLamp.visible = true;
	for ( int li = 0; li < ${8}; li ++ ) {
		if ( li >= uLampN ) break;
		vec4 lp = uLamps[ li ];
		vec3 lv = ( viewMatrix * vec4( lp.xyz, 1.0 ) ).xyz - geometryPosition;
		float d2 = dot( lv, lv );
		if ( d2 > 900.0 || lp.w <= 0.0 ) continue;
		wxLamp.direction = lv * inversesqrt( max( d2, 1e-6 ) );
		wxLamp.color = uLampC[ li ] * ( lp.w * uLampOn / ( d2 + 0.35 ) * ( 1.0 - smoothstep( 400.0, 900.0, d2 ) ) );
		RE_Direct( wxLamp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
}
#endif
`;

// Rain wetness (reference): darker albedo, glossy, puddles on flat ground. No-op while uWet + uWetBias == 0.
const WET_PHYSICAL = /* glsl */`
#ifdef WX_FOG
{
	float wxWet = clamp( uWet + uWetBias, 0.0, 1.0 );
	if ( wxWet > 0.001 ) {
		vec3 wxN = inverseTransformDirection( normal, viewMatrix );
		float wxPn = wx_vnoise( vFogWP.xz * 0.35 ) * 0.65 + wx_vnoise( vFogWP.xz * 1.3 + 7.0 ) * 0.35;
		float wxPool = smoothstep( 0.75, 0.97, wxN.y ) * smoothstep( 0.5, 0.66, wxPn ) * wxWet;
		diffuseColor.rgb *= 1.0 - wxWet * 0.5 * roughnessFactor - wxPool * 0.22;
		roughnessFactor = mix( roughnessFactor, mix( 0.16, 0.03, wxPool ), wxWet * 0.85 );
	}
}
#endif
`;
const WET_LAMBERT = /* glsl */`
diffuseColor.rgb *= 1.0 - clamp( uWet + uWetBias, 0.0, 1.0 ) * 0.32;
`;

function replaceDirBlock(src) {
  const start = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const next = src.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )', start);
  if (start < 0 || next < 0) { console.warn('[chunks] lights_fragment_begin layout changed; dual-shadow patch skipped'); return src; }
  return src.slice(0, start) + DIR_BLOCK + '\n' + src.slice(next);
}

let installed = false;

export function installChunks(app) {
  if (app?.scene && !app.scene.fog) app.scene.fog = new THREE.Fog(0xffffff, 1, 2); // DUMMY: only defines USE_FOG
  if (installed) return;
  installed = true;

  C.common = C.common + '\n' + TAG + '\n' + PRELUDE_GLSL;
  C.fog_pars_vertex = FOG_PARS_VERTEX;
  C.fog_vertex = FOG_VERTEX;
  C.fog_pars_fragment = FOG_PARS_FRAGMENT;
  C.fog_fragment = FOG_FRAGMENT;
  C.lights_pars_begin = C.lights_pars_begin + '\nvec3 gSunColor = vec3( 0.0 );\nvec3 gSunDir = vec3( 0.0, 1.0, 0.0 );\n';
  C.lights_fragment_begin = replaceDirBlock(C.lights_fragment_begin);
  C.lights_fragment_end = LAMP_LOOP + '\n' + C.lights_fragment_end;
  C.lights_physical_fragment = WET_PHYSICAL + '\n' + C.lights_physical_fragment;
  C.lights_lambert_fragment = WET_LAMBERT + '\n' + C.lights_lambert_fragment;

  // Built-in materials without their own hook still get G by reference (+ WX_FOG_ADD when additive).
  const proto = THREE.Material.prototype;
  proto.onBeforeCompile = globalHook;
  proto.customProgramCacheKey = function () {
    return this.onBeforeCompile.toString() + (this.blending === THREE.AdditiveBlending ? '|add' : '');
  };
}
