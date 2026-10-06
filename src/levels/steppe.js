// 第一章 · 长风 — the golden steppe at the hour before sunset (the original game). Everything here is the default
// layout/terrain/biome (world/layout.js); only the waves and the environment are spelled out.
export default {
  id: 'steppe', no: '第一章', title: '何一', en: 'The Long Wind',
  env: { mood: 'golden', drift: true, wind: 1.0 },
  waves: [
    { title: '鹏起', sub: 'Peng Qi', enemies: ['bandit', 'bandit', 'bandit'], wind: 1.0, mood: 'golden', maxAttackers: 1 },
    { title: '币安', sub: 'Binance', enemies: ['bandit', 'spearman', 'bandit', 'archer', 'bandit'], wind: 1.2, maxAttackers: 2 },
    { title: '剑来', sub: 'Jian Lai', enemies: ['shieldman', 'spearman', 'archer', 'shieldman', 'bandit_heavy', 'archer'], wind: 1.35, maxAttackers: 2 },
    { title: '无为', sub: 'Wu Wei', enemies: ['swordmaster'], wind: 1.5, windPhase2: 2.2, mood: 'ember', moodSeconds: 20, boss: true, maxAttackers: 1 },
  ],
  next: 'bamboo',
};
