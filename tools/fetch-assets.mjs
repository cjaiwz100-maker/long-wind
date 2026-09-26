// Downloads CC0 assets from Poly Haven (https://polyhaven.com) into public/assets/ph/.
// Usage: node tools/fetch-assets.mjs   (idempotent; skips files that already exist)
import fs from 'node:fs';
import path from 'node:path';

const UA = { 'User-Agent': 'wuxia-grassland-dev' };
const OUT = path.resolve('public/assets/ph');

const TEXTURES = {
  // ground set
  sparse_grass: '2k', grass_path_3: '2k', rocky_terrain_02: '2k', leafy_grass: '1k',
  dry_ground_rocks: '1k', forest_leaves_02: '1k',
  // rock / cliff
  rock_boulder_dry: '1k',
  // character
  rough_linen: '1k', brown_leather: '1k', 
  // trees & architecture
  pine_bark: '1k', chinese_cedar_bark: '1k', weathered_planks: '1k', japanese_stone_wall: '1k', ceramic_roof_01: '1k',
};
const TEX_MAPS = ['Diffuse', 'nor_gl', 'arm'];

const MODELS = {
  rock_moss_set_01: '1k', rock_moss_set_02: '1k', boulder_01: '1k', namaqualand_boulder_02: '1k',
  namaqualand_boulder_05: '1k', rock_face_01: '1k', stone_01: '1k', rock_07: '1k', rock_09: '1k',
};
const HDRIS = {};

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dest, buf);
      return buf.length;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
    }
  }
}

const prev = fs.existsSync(path.join(OUT, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'))) : {};
const manifest = { textures: {}, models: {}, hdris: {} };
let total = 0;
const tasks = [];

for (const [id, res] of Object.entries(TEXTURES)) {
  tasks.push(async () => {
    const files = await getJSON(`https://api.polyhaven.com/files/${id}`);
    manifest.textures[id] = { res };
    for (const map of TEX_MAPS) {
      const e = files[map]?.[res]?.jpg ?? files[map]?.[res]?.png;
      if (!e) { console.warn(`  missing ${id}.${map}@${res}`); continue; }
      const ext = e.url.split('.').pop();
      const rel = `textures/${id}/${map.toLowerCase()}_${res}.${ext}`;
      total += await download(e.url, path.join(OUT, rel));
      manifest.textures[id][map === 'nor_gl' ? 'normal' : map === 'arm' ? 'arm' : 'diffuse'] = `assets/ph/${rel}`;
    }
  });
}
for (const [id, res] of Object.entries(MODELS)) {
  tasks.push(async () => {
    const files = await getJSON(`https://api.polyhaven.com/files/${id}`);
    const g = files.gltf?.[res]?.gltf;
    if (!g) { console.warn(`  missing model ${id}@${res}`); return; }
    const dir = `models/${id}`;
    total += await download(g.url, path.join(OUT, dir, path.basename(g.url)));
    for (const [relPath, inc] of Object.entries(g.include ?? {})) {
      total += await download(inc.url, path.join(OUT, dir, relPath));
    }
    manifest.models[id] = { res, gltf: `assets/ph/${dir}/${path.basename(g.url)}` };
  });
}
for (const [id, res] of Object.entries(HDRIS)) {
  tasks.push(async () => {
    const files = await getJSON(`https://api.polyhaven.com/files/${id}`);
    const e = files.hdri?.[res]?.hdr;
    const rel = `hdris/${id}_${res}.hdr`;
    total += await download(e.url, path.join(OUT, rel));
    manifest.hdris[id] = `assets/ph/${rel}`;
  });
}

const results = [];
const queue = [...tasks];
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const t = queue.shift();
    try { await t(); results.push({ status: 'fulfilled' }); }
    catch (reason) { results.push({ status: 'rejected', reason }); }
  }
}));
results.filter(r => r.status === 'rejected').forEach(r => console.error('FAILED', r.reason?.message));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`downloaded ${(total / 1e6).toFixed(1)} MB; manifest written`);
