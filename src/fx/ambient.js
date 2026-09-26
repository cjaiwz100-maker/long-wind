// Ambient particles (bible §6.1): GPU-driven, camera-box wrapped, zero CPU work per frame. Owner: X.
//   createAmbient(app) → { update(dt), setDensity(k) }
// Layers: pollen motes (glitter when they face the sun), drifting seed fluff, golden leaves streaming downwind from
// the old tree, and fireflies that fade in with G.uNight. Every particle's position is a pure function of
// (seed, time, camera), so nothing is simulated on the CPU.
import * as THREE from 'three';
import { G, LAYERS } from '../core/globals.js';
import { ATMOS_GLSL } from '../core/atmosphere.js';
import { WIND_GLSL, windUniforms } from '../core/wind.js';
import { FX_COMMON, FX_FRAG, fxMaterial, fxMesh } from './common.js';
import { LAYOUT } from '../world/layout.js';

const VS = /* glsl */`
${ATMOS_GLSL}
${WIND_GLSL}
${FX_COMMON}
attribute vec4 iSeed;             // xyz random 0..1, w random 0..1
uniform float uBox, uKind, uSize, uGround;
uniform vec3 uCamBox;             // camera position
uniform vec3 uTree;               // leaf source (tree crown)
varying vec2 vQ; varying float vAlpha, vGlint, vViewZ; varying vec3 vWp, vTint;
float hsh(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float t = uTime;
  vec3 s = iSeed.xyz;
  vec3 wdir = vec3(uWind.x, 0.0, uWind.y);
  vec3 p;
  float size = uSize * (0.6 + 0.8 * iSeed.w);
  vAlpha = 1.0; vTint = vec3(1.0);
  if (uKind < 0.5) {                          // pollen motes: slow drift + brownian wobble in a camera box
    p = s * uBox;
    p += wdir * t * 0.35 * uWind.z + vec3(sin(t * 0.7 + s.x * 40.0), sin(t * 0.5 + s.y * 31.0) * 0.6, cos(t * 0.6 + s.z * 27.0)) * 0.6;
    p = uCamBox + mod(p - uCamBox + uBox * 0.5, uBox) - uBox * 0.5;
    p.y = uGround + 0.2 + s.y * 6.0 + sin(t * 0.4 + s.x * 9.0) * 0.4;
  } else if (uKind < 1.5) {                   // seed fluff: rides the gusts, higher and faster
    p = s * uBox;
    p += wdir * t * (1.6 + 1.2 * s.x) * uWind.z;
    p = uCamBox + mod(p - uCamBox + uBox * 0.5, uBox) - uBox * 0.5;
    p.y = uGround + 0.4 + s.y * 9.0 + sin(t * 1.3 + s.z * 17.0) * 0.5;
    p += windSway(p, 0.6, s.x * 6.0);
  } else if (uKind < 2.5) {                   // leaves from the tree: a looping stream along the wind
    float period = 9.0 + 5.0 * s.x;
    float u = fract(t / period + s.y);
    float dist = u * 70.0;
    vec3 side = vec3(-uWind.y, 0.0, uWind.x);
    p = uTree + vec3((s.z - 0.5) * 8.0, 2.0 + s.x * 5.0, (iSeed.w - 0.5) * 8.0);
    p += wdir * dist + side * sin(u * 9.0 + s.z * 20.0) * (1.0 + dist * 0.08);
    p.y += -dist * 0.09 + sin(u * 23.0 + s.x * 50.0) * 0.4;
    p.y = max(p.y, uGround + 0.05);
    vAlpha = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.85, 1.0, u));
    vTint = mix(vec3(0.62, 0.40, 0.06), vec3(0.90, 0.66, 0.16), s.z);
  } else {                                    // fireflies: low, meandering, pulsing
    p = s * uBox;
    p += vec3(sin(t * 0.3 + s.x * 30.0), 0.0, cos(t * 0.27 + s.z * 30.0)) * 2.0;
    p = uCamBox + mod(p - uCamBox + uBox * 0.5, uBox) - uBox * 0.5;
    p.y = uGround + 0.3 + s.y * 1.8 + sin(t * 0.9 + s.x * 13.0) * 0.25;
    vAlpha = uNight * pow(0.5 + 0.5 * sin(t * (1.5 + iSeed.w * 2.0) + s.x * 60.0), 3.0);
  }
  // fade near the box faces and very close to the lens
  vec3 rel = p - uCamBox;
  float edge = (uKind > 1.5 && uKind < 2.5) ? 1.0 : 1.0 - smoothstep(0.35, 0.5, max(abs(rel.x), abs(rel.z)) / uBox);
  vAlpha *= edge * smoothstep(0.4, 1.4, length(rel));
  // camera-facing quad (leaves tumble: quad rotated in screen plane)
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float ang = uKind > 1.5 && uKind < 2.5 ? t * (2.0 + 3.0 * s.x) + s.y * 6.28 : 0.0;
  vec2 q = position.xy;
  vec2 qr = vec2(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
  vec2 stretch = uKind > 1.5 && uKind < 2.5 ? vec2(1.0, 0.55 + 0.45 * abs(sin(t * 3.0 + s.z * 9.0))) : vec2(1.0);
  // keep motes at least ~1.2 px so they never shimmer out
  float px = 2.0 * max(-mv.z, 0.1) / (projectionMatrix[1][1] * uResolution.y);
  float sz = max(size, px * 1.2);
  vAlpha *= size / sz;
  mv.xy += qr * stretch * sz;
  vQ = q; vWp = p; vViewZ = -mv.z;
  // glint: pollen and fluff sparkle when they sit between the camera and the sun
  vec3 V = normalize(p - cameraPosition);
  vGlint = pow(max(dot(V, uSunDir), 0.0), 6.0);
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */`
${ATMOS_GLSL}
${FX_COMMON}
${FX_FRAG}
uniform float uKind;
varying vec2 vQ; varying float vAlpha, vGlint, vViewZ; varying vec3 vWp, vTint;
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  float soft = fx_soft(vViewZ, 0.6);
  vec3 col; float a;
  if (uKind < 1.5) {
    float disc = uKind < 0.5 ? exp(-r * r * 4.0) : smoothstep(1.0, 0.2, r);
    col = uSunCol * (0.05 + 1.6 * vGlint) * vec3(1.0, 0.92, 0.78) + fx_amb() * 0.35;
    a = disc * vAlpha * (uKind < 0.5 ? 0.55 : 0.35) * uSunVis;
  } else if (uKind < 2.5) {
    float leaf = 1.0 - smoothstep(0.75, 1.0, length(vQ * vec2(1.0, 1.8)));
    col = vTint * (uSunCol * (0.25 + 0.9 * vGlint) + fx_amb());
    a = leaf * vAlpha;
  } else {
    col = vec3(0.75, 1.0, 0.35) * 6.0 * exp(-r * r * 5.0);
    a = vAlpha * exp(-r * r * 3.0);
  }
  col = wx_applyAtmosphere(col, vWp);
  gl_FragColor = vec4(col, a * soft);
}`;

function layer(app, { kind, count, box, size, additive, order }) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 4);
  let s = 0x2545f491 ^ (kind * 977);
  const r = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; };
  for (let i = 0; i < seeds.length; i++) seeds[i] = r();
  g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const uniforms = {
    ...windUniforms(),
    uBox: { value: box }, uKind: { value: kind }, uSize: { value: size }, uGround: { value: 0 },
    uCamBox: { value: new THREE.Vector3() }, uTree: { value: new THREE.Vector3() },
  };
  const mat = fxMaterial({ vs: VS, fs: FS, uniforms, additive });
  const mesh = fxMesh(g, mat, { layer: LAYERS.TRANSPARENT, order, name: `fx.ambient.${kind}` });
  app.scene.add(mesh);
  return { mesh, uniforms, count };
}

export function createAmbient(app) {
  const layers = [
    layer(app, { kind: 0, count: 2200, box: 60, size: 0.012, additive: true, order: 5 }),    // pollen
    layer(app, { kind: 1, count: 500, box: 90, size: 0.03, additive: false, order: 6 }),     // seed fluff
    layer(app, { kind: 2, count: 160, box: 1, size: 0.05, additive: false, order: 7 }),      // leaves
    layer(app, { kind: 3, count: 260, box: 50, size: 0.035, additive: true, order: 8 }),     // fireflies
  ];
  const tree = LAYOUT.oldTree;
  const treeY = () => app.world.heightAt(tree.x, tree.z);
  const amb = {
    setDensity(k) { for (const l of layers) l.mesh.geometry.instanceCount = Math.round(l.count * Math.max(0, k)); },
    update() {
      const c = app.camera.position;
      const gy = app.world.heightAt(c.x, c.z);
      for (const l of layers) {
        l.uniforms.uCamBox.value.copy(c);
        l.uniforms.uGround.value = gy;
      }
      layers[2].uniforms.uTree.value.set(tree.x, treeY() + 3, tree.z);
      layers[2].uniforms.uGround.value = treeY();
      layers[3].mesh.visible = G.uNight.value > 0.02;
    },
  };
  app.add(amb);
  return amb;
}
