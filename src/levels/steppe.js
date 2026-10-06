// 第一章 · 早年岁月 — the golden steppe at the hour before sunset (the original game). Everything here is the default
// layout/terrain/biome (world/layout.js); only the waves and the environment are spelled out.
export default {
  id: 'steppe', no: '第一章', title: '早年岁月', en: 'Early Years',
  env: { mood: 'golden', drift: true, wind: 1.0 },
  waves: [
    { title: '币安', sub: 'Binance', enemies: ['bandit', 'bandit', 'bandit'], wind: 1.0, mood: 'golden', maxAttackers: 1 },
    { title: '温哥华', sub: 'Vancouver', enemies: ['bandit', 'spearman', 'bandit', 'archer', 'bandit'], wind: 1.2, maxAttackers: 2 },
    { title: '麦基尔', sub: 'McGill', enemies: ['shieldman', 'spearman', 'archer', 'shieldman', 'bandit_heavy', 'archer'], wind: 1.35, maxAttackers: 2 },
    { title: '东京', sub: 'Tokyo', enemies: ['swordmaster'], wind: 1.5, windPhase2: 2.2, mood: 'ember', moodSeconds: 20, boss: true, maxAttackers: 1 },
  ],
  next: 'bamboo',
};
