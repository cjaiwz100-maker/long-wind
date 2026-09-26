// Mixamo FBX → public/assets/anims/mixamo.glb (see convert.html). Needs the dev server on 127.0.0.1:5173.
//   node tools/mixamo/convert.mjs [--all]    (reads tools/mixamo/clips.json: { key: { num, desc } })
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const root = new URL('../../', import.meta.url).pathname;
const all = JSON.parse(fs.readFileSync(root + 'tools/mixamo/clips.json', 'utf8'));
// ship only the takes the game's tables use ('mx:<key>' in character.js); --all packs every downloaded take (auditioning)
const used = new Set([...fs.readFileSync(root + 'src/character/character.js', 'utf8').matchAll(/'mx:(\w+)'/g)].map((m) => m[1]));
for (const k of used) if (!all[k]) console.warn('not in clips.json:', k);
// a composite loads the takes it is built from (they ship only if the game uses them directly)
const ship = [...used];
for (const k of ship) for (const [part] of all[k]?.compose ?? []) used.add(part);
const manifest = process.argv.includes('--all') ? all : Object.fromEntries(Object.entries(all).filter(([k]) => used.has(k)));
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGE', e.message));
await p.goto('http://127.0.0.1:5173/tools/mixamo/convert.html');
await p.waitForFunction(() => window.__ok);
const r = await p.evaluate(([m, sh]) => window.convertAll(m, sh), [manifest, process.argv.includes('--all') ? null : ship]);
fs.mkdirSync(root + 'public/assets/anims', { recursive: true });
const buf = Buffer.from(r.b64, 'base64');
fs.writeFileSync(root + 'public/assets/anims/mixamo.glb', buf);
console.log(r.log.join('\n'));
console.log(`mixamo.glb ${(buf.length / 1024).toFixed(0)} KB, ${Object.keys(manifest).length} clips`);
await b.close();
