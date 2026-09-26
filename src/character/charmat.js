// Character materials (owner: character C).
// Built-in PBR materials patched for the golden-hour contre-jour look (bible §7.2 "Materials", SUNLIGHT_TERMS):
//   • thin-cloth / straw / skin transmission: sunC·albedo·tint·(sunBack·k1 + sunWrap·k2), scaled per vertex (aCloth.x)
//   • fuzz rim: fabric fibres and peach fuzz light up at the silhouette when the sun is behind the figure
//   • grass contact AO: legs sink into the field (bible §7.2 "Contact grounding")
//   • cloth: back faces (linings, sleeve and skirt insides) darker, tiny wind flutter on free edges (aCloth.y)
//   • hit flash through the emissive term
// The shadowed sun colour/direction come from the global chunk variables gSunColor/gSunDir when the lighting owner
// installed them (bible §2.5); otherwise this file evaluates light 0 and its shadow maps itself.
//
// Every character gets its own material instances (flash/contact/wind uniforms are per character) but programs are
// shared through stable customProgramCacheKeys.
import * as THREE from 'three';
import { addShaderHook, patchMaterial } from '../core/atmosphere.js';
import { loadPBR } from '../core/assets.js';
import { G } from '../core/globals.js';

// ---------------------------------------------------------------------------------------------------------------
// shader hook
// ---------------------------------------------------------------------------------------------------------------

const hasGlobalSun = () => (THREE.ShaderChunk.lights_pars_begin || '').includes('gSunColor');

/** GLSL: shadowed sun radiance + view-space direction (wxcSunC / wxcSunL). */
function sunTermsGLSL() {
  if (hasGlobalSun()) return 'vec3 wxcSunC = gSunColor; vec3 wxcSunL = gSunDir;\n';
  return /* glsl */`
  vec3 wxcSunC = vec3(0.0); vec3 wxcSunL = vec3(0.0, 1.0, 0.0);
  #if NUM_DIR_LIGHTS > 0
    wxcSunC = directionalLights[ 0 ].color; wxcSunL = directionalLights[ 0 ].direction;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      wxcSunC *= receiveShadow ? getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
    #endif
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 1 && NUM_DIR_LIGHTS > 1
      wxcSunC *= receiveShadow ? getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, 1.0, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ) : 1.0;
    #endif
  #endif
`;
}

/**
 * Install the character hook on a built-in material.
 * opts: { kind: 'cloth'|'skin'|'straw'|'hair'|'plain', trans: [r,g,b], transK: [back, wrap], rim: [r,g,b], rimK,
 *         flutter: bool, backShade: 0..1, contact: bool }
 */
function charHook(mat, U, opts) {
  const o = { kind: 'plain', trans: [0, 0, 0], transK: [0, 0], rim: [1, 1, 1], rimK: 0, flutter: false, backShade: 1, contact: true, ...opts };
  const key = `wxChar4:${o.kind}:${o.flutter ? 1 : 0}:${o.contact ? 1 : 0}:${hasGlobalSun() ? 'g' : 'l'}`;
  const local = {
    uTransCol: { value: new THREE.Color(...o.trans) },
    uTransK: { value: new THREE.Vector2(...o.transK) },
    uRimCol: { value: new THREE.Color(...o.rim) },
    uRimK: { value: o.rimK },
    uBackShade: { value: o.backShade },
  };
  mat.userData.wxc = local;
  addShaderHook(mat, key, (shader) => {
    Object.assign(shader.uniforms, local, {
      uContact: U.uContact, uWindLocal: U.uWindLocal, uWindAmp: U.uWindAmp, uTime: G.uTime,
    });
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    vs = vs.replace('void main() {', /* glsl */`
attribute vec4 aCloth;
attribute vec3 color2;
varying vec4 vCloth;
varying vec3 vColor2;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
varying vec4 vWxcT0;
#if NUM_DIR_LIGHT_SHADOWS > 1
varying vec4 vWxcT1;
#endif
#endif
uniform vec3 uWindLocal;
uniform float uWindAmp;
#ifndef WXU_uTime
#define WXU_uTime
uniform float uTime;
#endif
void main() {
  vCloth = aCloth;
  vColor2 = color2;`);
    // transmission shadow: look up the shadow maps a few cm toward the sun. Inside the body/robe that point is
    // occluded (no light passes through a torso); at silhouettes and single cloth layers it is lit → edge glow.
    vs = vs.replace('#include <shadowmap_vertex>', /* glsl */`#include <shadowmap_vertex>
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  {
    vec4 wxcWp = worldPosition + vec4( normalize( uSunDir ) * ${(o.transDepth ?? 0.05).toFixed(3)}, 0.0 );
    vWxcT0 = directionalShadowMatrix[ 0 ] * wxcWp;
    #if NUM_DIR_LIGHT_SHADOWS > 1
    vWxcT1 = directionalShadowMatrix[ 1 ] * wxcWp;
    #endif
  }
  #endif`);
    if (o.flutter) {
      vs = vs.replace('#include <skinning_vertex>', /* glsl */`#include <skinning_vertex>
  {
    // high-frequency flutter on free cloth edges, phased by rest position so neighbouring panels disagree
    float ph = uTime * 4.7 + position.y * 11.0 + position.x * 7.0 + position.z * 5.0;
    vec3 fl = vec3(sin(ph), 0.45 * sin(ph * 1.7 + 1.0), cos(ph * 1.3));
    float k = aCloth.y * uWindAmp;
    transformed += (fl * 0.006 + uWindLocal * (0.55 + 0.45 * sin(ph * 0.61 + 0.5)) * 0.012) * k;
  }`);
    }
    fs = fs.replace('void main() {', /* glsl */`
varying vec4 vCloth;
varying vec3 vColor2;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
varying vec4 vWxcT0;
#if NUM_DIR_LIGHT_SHADOWS > 1
varying vec4 vWxcT1;
#endif
#endif
uniform vec3 uTransCol;
uniform vec2 uTransK;
uniform vec3 uRimCol;
uniform float uRimK;
uniform float uBackShade;
uniform vec4 uContact;
void main() {`);
    // front faces take the garment colour, back faces (linings, sleeve and skirt insides) the lining colour
    fs = fs.replace('#include <color_fragment>', `
  #if defined( USE_COLOR )
    diffuseColor.rgb *= gl_FrontFacing ? vColor.rgb : vColor2 * uBackShade;
  #endif`);
    let sun = /* glsl */`
  {
    ${sunTermsGLSL()}
    // sun that can reach this point THROUGH the surface (offset shadow lookup, see vertex hook)
    vec3 wxcSunT = vec3( 0.0 );
    #if NUM_DIR_LIGHTS > 0
      wxcSunT = directionalLights[ 0 ].color;
      #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
        wxcSunT *= getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, 1.0, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vWxcT0 );
        #if NUM_DIR_LIGHT_SHADOWS > 1
          wxcSunT *= getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, 1.0, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vWxcT1 );
        #endif
      #endif
      #ifdef WX_FOG
        wxcSunT *= vWxAtm.x;
      #endif
    #endif
    vec3 wxcV = geometryViewDir;                                   // surface → camera (view space)
    float wxcBack = pow( saturate( dot( - wxcV, wxcSunL ) ), 4.0 ); // looking into the sun through the surface
    float wxcWrap = saturate( dot( - normal, wxcSunL ) * 0.6 + 0.4 );
    vec3 alb = diffuseColor.rgb;`;
    if (o.kind === 'skin') sun += /* glsl */`
    // sub-surface: red back-scatter + a soft terminator
    float ndl = dot( normal, wxcSunL );
    float wrapT = saturate( ( ndl + 0.45 ) / 1.45 ) - saturate( ndl );
    // back-scatter only where light can actually pass (ears, fingers, silhouettes: offset shadow lookup)
    reflectedLight.directDiffuse += wxcSunT * alb * uTransCol * ( wxcBack * uTransK.x + wxcWrap * uTransK.y ) * vCloth.x;
    // soft terminator: a narrow warm band where the light wraps; desaturated so lit skin never turns to clay
    reflectedLight.directDiffuse += wxcSunC * alb * vec3( 1.0, 0.62, 0.5 ) * wrapT * 0.22;`;
    else sun += /* glsl */`
    reflectedLight.directDiffuse += wxcSunT * alb * uTransCol * ( wxcBack * uTransK.x + wxcWrap * uTransK.y ) * vCloth.x;`;
    sun += /* glsl */`
    // fibre / fuzz rim: grazing view with the sun behind the figure
    float fres = pow( 1.0 - saturate( abs( dot( normal, wxcV ) ) ), 3.0 );
    float behind = pow( saturate( dot( - wxcV, wxcSunL ) * 0.5 + 0.5 ), 3.0 );
    reflectedLight.directSpecular += wxcSunT * uRimCol * fres * behind * uRimK * ( 0.4 + 0.6 * vCloth.z );
  }`;
    fs = fs.replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>' + sun);
    if (o.kind === 'skin') {
      // shadow side: skin in shade is lit by the blue sky and the gold meadow bounce → pull it toward a neutral,
      // slightly cool tone so shaded skin doesn't read as orange clay
      fs = fs.replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
  {
    float wxcLum = dot( reflectedLight.indirectDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) );
    reflectedLight.indirectDiffuse = mix( reflectedLight.indirectDiffuse, vec3( wxcLum ) * vec3( 0.96, 0.99, 1.06 ), 0.35 );
  }`);
    }
    if (o.contact) {
      fs = fs.replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
  {
    // legs sink into the field: darken below grass height (uContact = groundY, grassH, strength)
    float yA = vWxWorldPos.y - uContact.x;
    float cao = mix( 1.0, mix( 0.5, 1.0, smoothstep( 0.02, uContact.y, yA ) ), uContact.z );
    reflectedLight.indirectDiffuse *= cao * vCloth.w;
    reflectedLight.directDiffuse *= mix( 1.0, cao, 0.55 );
    reflectedLight.indirectSpecular *= cao * vCloth.w;
  }`);
    } else {
      fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  reflectedLight.indirectDiffuse *= vCloth.w; reflectedLight.indirectSpecular *= vCloth.w;`);
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  });
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------
// procedural textures (cached, built once)
// ---------------------------------------------------------------------------------------------------------------

const texCache = {};
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

/** Height field → tangent-space normal map canvas (RGB). */
function heightToNormal(hf, w, h, strength = 2, wrapX = true, wrapY = true) {
  const c = canvas(w, h), ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const at = (x, y) => {
    if (wrapX) x = (x + w) % w; else x = Math.min(Math.max(x, 0), w - 1);
    if (wrapY) y = (y + h) % h; else y = Math.min(Math.max(y, 0), h - 1);
    return hf[y * w + x];
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    let nx = -dx, ny = dy, nz = 1; // canvas y goes down; UV v goes up (flipY=true)
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = (y * w + x) * 4;
    img.data[o] = (nx * 0.5 + 0.5) * 255; img.data[o + 1] = (ny * 0.5 + 0.5) * 255; img.data[o + 2] = (nz * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function texFrom(c, srgb, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/**
 * Woven bamboo/straw for the douli: u = around the cone (radial strips), v = from the apex to the rim.
 * Radial splints cross concentric weft strips in a twill; every strip has its own tone and fibre streaks.
 */
function strawTextures() {
  if (texCache.straw) return texCache.straw;
  const W = 1024, H = 512;
  const hf = new Float32Array(W * H);
  const alb = canvas(W, H), ctx = alb.getContext('2d');
  const img = ctx.createImageData(W, H);
  const nWarp = 96, nWeft = 40;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W * nWarp, v = y / H * nWeft;
    const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
    const over = ((iu + iv) >> 1) % 2 === 0; // 2/2 twill
    // strip cross profiles (rounded)
    const pu = Math.sin(fu * Math.PI), pv = Math.sin(fv * Math.PI);
    const hWarp = pu * (over ? 1 : 0.35), hWeft = pv * (over ? 0.35 : 1);
    const top = hWarp > hWeft;
    const fib = top ? hash(iu * 13.1 + Math.floor(fv * 22) * 0.07 + Math.floor(fu * 7) * 3.3) : hash(iv * 7.7 + Math.floor(fu * 22) * 0.09 + Math.floor(fv * 7) * 5.1);
    const tone = top ? hash(iu * 3.17 + 0.5) : hash(iv * 9.31 + 0.2);
    let h = Math.max(hWarp, hWeft) + (fib - 0.5) * 0.08;
    const gap = Math.min(pu, pv);
    hf[y * W + x] = h;
    // colour: sun-bleached straw with darker grooves and per-strip tone
    const base = 0.72 + 0.28 * tone;
    const groove = 0.55 + 0.45 * Math.min(1, gap * 3.0 + Math.max(hWarp, hWeft) * 0.6);
    const s = base * groove * (0.9 + 0.1 * fib);
    const o = (y * W + x) * 4;
    img.data[o] = 205 * s; img.data[o + 1] = 172 * s; img.data[o + 2] = 118 * s; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  texCache.straw = { map: texFrom(alb, true), normalMap: texFrom(heightToNormal(hf, W, H, 1.6), false) };
  return texCache.straw;
}

/** Hair: fine strands along v, clumped. Albedo variation + normal. */
function hairTextures() {
  if (texCache.hair) return texCache.hair;
  const W = 256, H = 256;
  const hf = new Float32Array(W * H);
  const alb = canvas(W, H), ctx = alb.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const clump = Math.sin((x / W) * Math.PI * 2 * 9 + Math.sin(y / H * Math.PI * 2) * 1.5) * 0.5 + 0.5;
    const strand = hash(x * 1.7) * 0.6 + hash(Math.floor(x / 3) * 7.3) * 0.4;
    const h = clump * 0.6 + strand * 0.4;
    hf[y * W + x] = h;
    const o = (y * W + x) * 4, s = 0.75 + 0.25 * h;
    img.data[o] = 255 * s; img.data[o + 1] = 255 * s; img.data[o + 2] = 255 * s; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  texCache.hair = { map: texFrom(alb, true), normalMap: texFrom(heightToNormal(hf, W, H, 1.2), false) };
  return texCache.hair;
}

/** Skin micro-relief: pores + fine creases (a weathered, not waxy, surface). */
function poreTextures() {
  if (texCache.pores) return texCache.pores;
  const W = 256, H = 256, hf = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = hash(x * 0.37 + y * 1.13 + hash(Math.floor(x / 3) + Math.floor(y / 3) * 97));
    const crease = Math.sin((x * 0.9 + y * 0.35) * 0.35 + hash(Math.floor(y / 16)) * 6) * 0.5 + 0.5;
    hf[y * W + x] = (p > 0.93 ? -1 : 0) * 0.6 + crease * 0.15 + p * 0.15;
  }
  texCache.pores = { normalMap: texFrom(heightToNormal(hf, W, H, 1.0), false) };
  return texCache.pores;
}

/** Brushed/polished steel streaks along v (the blade length) + a lighter edge band near u = 0 and u = 1. */
function steelTextures() {
  if (texCache.steel) return texCache.steel;
  const W = 64, H = 512;
  const alb = canvas(W, H), ctx = alb.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const streak = hash(x * 3.1 + Math.floor(y / 64) * 0.13) * 0.5 + hash(x * 17.3) * 0.5;
    const cloud = 0.5 + 0.5 * Math.sin(y * 0.05 + hash(x) * 2.0) * Math.sin(y * 0.013 + 1.3);
    const s = 0.86 + 0.08 * streak + 0.06 * cloud;
    const o = (y * W + x) * 4;
    img.data[o] = 255 * s; img.data[o + 1] = 255 * s; img.data[o + 2] = 255 * s; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  texCache.steel = { map: texFrom(alb, true) };
  return texCache.steel;
}

/** Greyscale detail from the Poly Haven linen colour map (the source is dyed blue; we only want its weave). */
async function linenDetail() {
  if (texCache.linen) return texCache.linen;
  texCache.linen = (async () => {
    let pbr = null;
    try { pbr = await loadPBR('rough_linen'); } catch (e) { console.warn('[charmat] rough_linen unavailable', e); }
    let map = null;
    const img = pbr?.map?.image;
    if (img && img.width) {
      const W = 512, H = 512, c = canvas(W, H), ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H);
      let sum = 0;
      for (let i = 0; i < d.data.length; i += 4) sum += d.data[i] * 0.3 + d.data[i + 1] * 0.59 + d.data[i + 2] * 0.11;
      const mean = sum / (W * H);
      for (let i = 0; i < d.data.length; i += 4) {
        const l = (d.data[i] * 0.3 + d.data[i + 1] * 0.59 + d.data[i + 2] * 0.11) / mean;
        const v = Math.min(255, 200 * (1 + (l - 1) * 1.6)); // sRGB 200 ≈ linear 0.58 → compensated by colour
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      }
      ctx.putImageData(d, 0, 0);
      map = texFrom(c, true);
    }
    return { map, normalMap: pbr?.normalMap ?? null };
  })();
  return texCache.linen;
}

async function leatherMaps() {
  if (!texCache.leather) texCache.leather = loadPBR('brown_leather').catch((e) => { console.warn('[charmat] brown_leather unavailable', e); return {}; });
  return texCache.leather;
}

// ---------------------------------------------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------------------------------------------

/** Per-character uniform block shared by that character's materials. */
export function createCharUniforms() {
  return {
    uContact: { value: new THREE.Vector4(0, 0.5, 1, 0) },   // groundY, grassH, strength, –
    uWindLocal: { value: new THREE.Vector3(0.6, 0, 0.8) },   // wind direction in character space × gust
    uWindAmp: { value: 1 },
  };
}

const LINEN_COMP = 1 / 0.58; // compensates the 200/255 sRGB mean of the linen detail map

/**
 * Create the material set for one character. All are patched for atmosphere, flagged for the ACTORS layer by the
 * caller. Returns { skin, cloth, hair, straw, leather, steel, bronze, lacquer, gauze, list }.
 */
export async function createCharMaterials(U) {
  const [linen, leather] = await Promise.all([linenDetail(), leatherMaps()]);
  const straw = strawTextures(), hair = hairTextures(), steel = steelTextures(), pores = poreTextures();
  const M = {};

  M.cloth = new THREE.MeshPhysicalMaterial({
    vertexColors: true, color: new THREE.Color(1, 1, 1).multiplyScalar(linen.map ? LINEN_COMP : 1),
    map: linen.map, normalMap: linen.normalMap, normalScale: new THREE.Vector2(0.45, 0.45),
    roughness: 0.88, metalness: 0, sheen: 0.6, sheenRoughness: 0.55, sheenColor: new THREE.Color(0.9, 0.85, 0.8),
    side: THREE.DoubleSide,
  });
  charHook(M.cloth, U, { kind: 'cloth', trans: [1, 0.85, 0.7], transK: [0.30, 0.08], rim: [1, 0.9, 0.75], rimK: 0.22, flutter: true, backShade: 1 });

  M.skin = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.56, metalness: 0, specularIntensity: 0.55, sheen: 0.12, sheenRoughness: 0.7, sheenColor: new THREE.Color(0.75, 0.66, 0.6),
    normalMap: pores.normalMap, normalScale: new THREE.Vector2(0.18, 0.18),
  });
  charHook(M.skin, U, { kind: 'skin', trans: [0.85, 0.42, 0.3], transK: [0.42, 0.06], rim: [1, 0.8, 0.68], rimK: 0.1 });

  M.hair = new THREE.MeshPhysicalMaterial({
    vertexColors: true, map: hair.map, normalMap: hair.normalMap, normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.42, metalness: 0, anisotropy: 0.75, anisotropyRotation: Math.PI / 2, side: THREE.DoubleSide,
    sheen: 0.4, sheenRoughness: 0.4, sheenColor: new THREE.Color(0.35, 0.3, 0.25),
  });
  charHook(M.hair, U, { kind: 'hair', trans: [1, 0.7, 0.45], transK: [0.25, 0.03], rim: [1, 0.85, 0.65], rimK: 0.3, flutter: true, backShade: 1 });

  M.straw = new THREE.MeshStandardMaterial({ vertexColors: true, map: straw.map, normalMap: straw.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.78, side: THREE.DoubleSide });
  charHook(M.straw, U, { kind: 'straw', trans: [1, 0.78, 0.55], transK: [0.35, 0.06], rim: [1, 0.85, 0.6], rimK: 0.35, backShade: 1, contact: false });

  M.leather = new THREE.MeshStandardMaterial({ vertexColors: true, map: leather.map ?? null, normalMap: leather.normalMap ?? null, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.62, side: THREE.DoubleSide, color: new THREE.Color(1, 1, 1) });
  charHook(M.leather, U, { kind: 'plain', rim: [1, 0.85, 0.7], rimK: 0.08, backShade: 1 });

  M.steel = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0.62, 0.63, 0.64), map: steel.map, metalness: 1, roughness: 0.17, anisotropy: 0.6, anisotropyRotation: 0, vertexColors: true });
  charHook(M.steel, U, { kind: 'plain', contact: false });

  M.bronze = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.32, 0.36, 0.26), metalness: 0.78, roughness: 0.42, vertexColors: true });
  charHook(M.bronze, U, { kind: 'plain', contact: false });

  M.lacquer = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.34, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.14 });
  charHook(M.lacquer, U, { kind: 'plain', contact: false });

  M.gauze = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, transparent: false, alphaHash: true, opacity: 0.55 });
  charHook(M.gauze, U, { kind: 'cloth', trans: [1, 0.8, 0.6], transK: [0.4, 0.1], flutter: true, contact: false });

  // shadow maps store the sun-facing surface (three's default for single-sided materials is the back face), so the
  // offset transmission lookup correctly finds the body between the sun and a front-lit face or robe
  for (const k in M) { patchMaterial(M[k]); M[k].shadowSide = THREE.FrontSide; if (M[k].side === THREE.DoubleSide) M[k].shadowSide = THREE.DoubleSide; }
  M.list = Object.values(M);
  return M;
}
