// Headless GPU screenshot harness (system Chrome + ANGLE/Metal).
// Usage:
//   node tools/shot.mjs --scene full --out shots/a.png [--w 1600 --h 900] [--wait 4000]
//        [--q "t=0.3&seed=2"] [--eval "__app.setView({pos:[0,2,8],target:[0,1,0]})"] [--frames 1]
//        [--port 5173] [--clip x,y,w,h]
// Waits for window.__ready (set by the app after the first rendered frame), optionally runs --eval,
// waits --wait ms more, then saves a screenshot. Prints console errors/warnings and page errors.
// Exit code 2 if the page threw uncaught errors or never became ready.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const port = args.port ?? process.env.PORT ?? 5173;
const scene = args.scene ?? 'full';
const W = +(args.w ?? 1600), H = +(args.h ?? 900);
const out = args.out ?? `shots/${scene}.png`;
const q = args.q ? `&${args.q}` : '';
const url = args.url ?? `http://localhost:${port}/?scene=${scene}&harness=1${q}`;
const waitMs = +(args.wait ?? 2500);
const readyTimeout = +(args.timeout ?? 60000);

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
let pageErrors = 0;
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[console.${m.type()}] ${m.text()}`); else if (args.verbose) logs.push(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', e => { pageErrors++; logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`); });
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
let ready = false;
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: readyTimeout, polling: 100 });
  ready = true;
} catch { logs.push(`[harness] window.__ready never became true within ${readyTimeout}ms`); }
const tReady = Date.now() - t0;
if (ready && args.eval) {
  try { const r = await page.evaluate(args.eval); if (r !== undefined) logs.push(`[eval] ${JSON.stringify(r)}`); }
  catch (e) { logs.push(`[eval error] ${e.message}`); }
}
await page.waitForTimeout(waitMs);
if (args.eval2) {
  try { const r = await page.evaluate(args.eval2); if (r !== undefined) logs.push(`[eval2] ${JSON.stringify(r)}`); }
  catch (e) { logs.push(`[eval2 error] ${e.message}`); }
  await page.waitForTimeout(+(args.wait2 ?? 1000));
}
fs.mkdirSync(path.dirname(out), { recursive: true });
const clip = args.clip ? (([x, y, width, height]) => ({ x, y, width, height }))(args.clip.split(',').map(Number)) : undefined;
await page.screenshot({ path: out, clip });
const stats = ready ? await page.evaluate(() => window.__app?.stats?.() ?? null).catch(() => null) : null;
console.log(`[harness] ${url} ready=${ready} in ${tReady}ms -> ${out}`);
if (stats) console.log(`[harness] stats ${JSON.stringify(stats)}`);
for (const l of logs) console.log(l);
await browser.close();
process.exit(!ready || pageErrors ? 2 : 0);
