// Asset loading with caching. Poly Haven CC0 assets live in public/assets/ph (see tools/fetch-assets.mjs,
// public/assets/ph/manifest.json). STABLE API:
//   await loadManifest()
//   await loadTexture(url, { srgb=false, repeat=true, anisotropy=8 })    -> THREE.Texture
//   await loadPBR(id, { repeat=true })   -> { map, normalMap, armMap }   (arm = AO/Roughness/Metalness packed R/G/B)
//   await loadModel(id)                  -> THREE.Group (a fresh clone each call; geometry/materials shared)
//   setRendererForAssets(renderer)       -> enables max anisotropy detection
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BASE = import.meta.env?.BASE_URL ?? '/';
let manifest = null;
let maxAniso = 8;
const texCache = new Map();
const modelCache = new Map();
const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

export function setRendererForAssets(renderer) {
  maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
}

export async function loadManifest() {
  if (!manifest) manifest = await (await fetch(`${BASE}assets/ph/manifest.json`)).json();
  return manifest;
}

export function loadTexture(url, { srgb = false, repeat = true, anisotropy = 8, flipY = true } = {}) {
  const key = `${url}|${srgb}|${repeat}|${flipY}`;
  if (!texCache.has(key)) {
    texCache.set(key, texLoader.loadAsync(url.startsWith('http') || url.startsWith('/') ? url : BASE + url).then(t => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(anisotropy, maxAniso);
      t.flipY = flipY;
      t.needsUpdate = true;
      return t;
    }));
  }
  return texCache.get(key);
}

export async function loadPBR(id, { repeat = true } = {}) {
  const m = (await loadManifest()).textures[id];
  if (!m) throw new Error(`unknown texture set ${id}`);
  const [map, normalMap, armMap] = await Promise.all([
    m.diffuse ? loadTexture(m.diffuse, { srgb: true, repeat }) : null,
    m.normal ? loadTexture(m.normal, { repeat }) : null,
    m.arm ? loadTexture(m.arm, { repeat }) : null,
  ]);
  return { map, normalMap, armMap };
}

export async function loadModel(id) {
  if (!modelCache.has(id)) {
    modelCache.set(id, (async () => {
      const m = (await loadManifest()).models[id];
      if (!m) throw new Error(`unknown model ${id}`);
      const gltf = await gltfLoader.loadAsync(BASE + m.gltf);
      return gltf.scene;
    })());
  }
  const src = await modelCache.get(id);
  return src.clone(true);
}

