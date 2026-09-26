// Entry: ?scene=<name> loads src/scenes/<name>.js (default: full game). Each scene module default-exports
// `async function (app)` that builds its content, registers systems with app.add(), then calls app.ready().
import { createApp } from './core/app.js';
import { setRendererForAssets } from './core/assets.js';

const params = new URLSearchParams(location.search);
const sceneName = (params.get('scene') || 'full').replace(/[^a-z0-9_-]/gi, '');

async function boot() {
  const canvas = document.getElementById('c');
  const app = await createApp({ canvas });
  setRendererForAssets(app.renderer);
  app.progress(0.02, '');
  const mod = await import(`./scenes/${sceneName}.js`);
  await mod.default(app);
}

boot().catch((err) => {
  console.error(err);
  const l = document.getElementById('loadLabel');
  if (l) l.textContent = 'ERROR: ' + (err?.message ?? err);
});
