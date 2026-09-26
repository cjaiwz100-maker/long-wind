// Minimal sanity scene: baseline environment + terrain + stub character/animator. Used to validate the core.
import { createEnvironment } from '../world/environment.js';
import { createTerrain } from '../world/terrain.js';
import { createCharacter } from '../character/character.js';
import { Animator } from '../character/animator.js';

export default async function (app) {
  app.progress(0.2, 'terrain');
  const env = createEnvironment(app);
  await createTerrain(app);
  const ch = await createCharacter({ kind: 'hero' });
  ch.group.position.y = app.world.heightAt(0, 0);
  app.scene.add(ch.group);
  const anim = new Animator(ch.rig, { heightAt: app.world.heightAt });
  const clip = app.params.get('clip');
  let t = 0;
  app.add({ update(dt) { t += dt; if (clip && !anim.isActing) anim.play(clip); else if (!clip) anim.setLocomotion({ speed: 1.4 + Math.sin(t * 0.3) * 1.4 }); anim.update(dt); ch.update(dt); } });
  env.setShadowFocus(ch.group.position);
  app.debugControls();
  app.setView({ pos: [2.5, 2.2 + ch.group.position.y, 4.5], target: [0, 1.1 + ch.group.position.y, 0] });
  app.progress(1, '');
  await app.ready();
}
