// Move Mixamo downloads (~/Downloads/<product name>[ (n)].fbx) into tools/mixamo/src/<motion number>.fbx.
//   node tools/mixamo/ingest.mjs "<num>|<product name>|<dur>" ...   (lines in download order; move each batch in before
//   starting the next, so Chrome's ' (n)' numbering restarts)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DL = path.join(os.homedir(), 'Downloads');
const OUT = new URL('./src/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const lines = process.argv.slice(2).join('\n').split('\n').map((l) => l.trim()).filter((l) => l && !l.includes(' ERR '));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const used = new Set();
for (const l of lines) {
  const [num, name] = l.split('|');
  const re = new RegExp(`^${esc(name)}( \\(\\d+\\))?\\.fbx$`);
  const cands = fs.readdirSync(DL).filter((f) => re.test(f) && !used.has(f))
    // Chrome numbers same-named downloads in the order they start (' (1)', ' (2)'…); completion times can interleave
    .map((f) => ({ f, t: +(f.match(/ \((\d+)\)\.fbx$/)?.[1] ?? 0) })).sort((a, b) => a.t - b.t);
  if (!cands.length) { console.log('MISSING', num, name); continue; }
  const f = cands[0].f; used.add(f);
  fs.renameSync(path.join(DL, f), path.join(OUT, `${num}.fbx`));
  console.log(num, '←', f);
}
