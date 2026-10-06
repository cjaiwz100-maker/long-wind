// HUD markup and words: title, wave names, controls, pause, and the poems for victory and defeat.
// Poems are classical and public domain: 敕勒歌 (tagline), 李白《侠客行》 (victory), 《易水歌》 (defeat).
// Owner: UI (U).

export const NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export const numeral = (n) => (n <= 10 ? NUMERALS[n] : n < 20 ? '十' + NUMERALS[n - 10] : String(n));

// Default names per wave (used when the director's title is missing or not Chinese).
export const WAVES = [
  { tt: '风起', en: 'The wind rises' },
  { tt: '草动', en: 'The grass stirs' },
  { tt: '剑鸣', en: 'The sword sings' },
  { tt: '云散', en: 'The clouds part' },
  { tt: '雁回', en: 'The geese return' },
];
export const BOSS_WAVE = { no: '终回', tt: '长风', en: 'The long wind' };
export const WAVE_EN = { 风起: 'The wind rises', 草动: 'The grass stirs', 剑鸣: 'The sword sings', 云散: 'The clouds part', 长风: 'The long wind', 雁回: 'The geese return', 风定: 'The field falls still' };

// Default boss names by enemy kind (director may send its own via enemy:spawn {name, sub}).
export const BOSS_NAMES = {
  swordmaster: { name: '寒山客', sub: 'Swordmaster of Cold Mountain' },
  boss: { name: '寒山客', sub: 'Swordmaster of Cold Mountain' },
  bandit_heavy: { name: '断岳', sub: 'The Mountain-Breaker' },
  assassin: { name: '夜枭', sub: 'The Night Owl' },
};

export const CONTROLS = [
  ['W A S D', '行', 'move'],
  ['Mouse', '顾', 'look'],
  ['LMB', '斩', 'strike'],
  ['Hold LMB', '劈', 'heavy'],
  ['RMB', '格', 'block · parry on impact'],
  ['Space', '闪', 'dodge'],
  ['Shift', '疾', 'sprint'],
  ['Q · Tab', '锁', 'lock on'],
  ['E', '气', 'sword qi'],
  ['F', '剑', 'draw · sheathe'],
  ['Esc', '歇', 'pause'],
];
// The in-game hint shows only the essentials.
export const HINT = [0, 2, 4, 5, 7, 8];

export const VICTORY = {
  lines: ['十步杀一人', '千里不留行', '事了拂衣去', '深藏身与名'],
  en: 'Ten paces, and a man falls; a thousand li, and no trace remains.<br>The deed done, he shakes out his robe and goes, keeping his name and self unknown.',
  src: 'Li Bai · The Wandering Swordsman',
  go: ['再战', 'ride on'],
};
export const DEFEAT = {
  lines: ['风萧萧兮易水寒', '壮士一去兮不复还'],
  en: 'The wind sighs, and the waters of the Yi run cold;<br>the warrior sets out, and does not return.',
  src: 'Song of the Yi River',
  go: ['再起', 'rise again'],
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const FILTERS = `
<svg class="defs" aria-hidden="true" focusable="false"><defs>
  <filter id="wx-ink" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="4" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <filter id="wx-ink-live" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves="3" seed="7" result="n">
      <animate attributeName="baseFrequency" dur="18s" values="0.026;0.034;0.026" repeatCount="indefinite"/>
    </feTurbulence>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G" result="d"/>
    <feGaussianBlur in="d" stdDeviation="0.35"/>
  </filter>
</defs></svg>`;

export const HUD_HTML = `
${FILTERS}
<div class="lyr marks"></div>
<div class="lyr fxl"></div>
<div class="edge"></div>
<div class="qi"></div>
<div class="play vitals">
  <div class="focus"><div class="wash"></div><div class="rt m"></div><div class="r m"></div><div class="pulse m"></div><div class="g">气</div></div>
  <div class="health"><div class="tr m"></div><div class="gh m"></div><div class="fl m"></div></div>
</div>
<div class="play boss"><div class="nm"></div><div class="sb"></div>
  <div class="bar"><div class="tr m"></div><div class="gh m"></div><div class="fl m"></div></div>
  <div class="po"><div class="a m"></div><div class="b m"></div></div>
</div>
<div class="ret"><div class="e m"></div><div class="d"></div></div>
<div class="banner"><div class="wash"></div><div class="no"></div><div class="tt"></div><div class="ru m"></div><div class="en"></div><img class="seal" alt=""></div>
<div class="hint">${HINT.map((i) => `<kbd>${CONTROLS[i][0]}</kbd><span>${CONTROLS[i][1]}<i>${CONTROLS[i][2]}</i></span>`).join('')}</div>
<div class="scr title">
<a class="xlink" href="https://x.com/changpengxing" target="_blank" rel="noopener" aria-label="X">
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M18.2 2H21l-6.5 7.4L22 22h-6.8l-4.7-6.2L5.4 22H2.6l7-8L2 2h7l4.3 5.7L18.2 2zm-1.2 18h1.8L7.1 3.9H5.2L17 20z"/></svg>
  </a>
  <div class="shade"></div>
  <div class="col"><div class="tt">长鹏行</div><div class="tg">天苍苍 · 野茫茫</div><img class="seal" alt=""></div>
  <div class="en"><b>Chang Peng Xing</b><i>the wind arrives before the blade</i></div>
  <div class="go"><div class="ln m"></div><div class="t"><b>点击 · 启程</b><i>click to begin</i></div><div class="ln r m"></div></div>
</div>

<div class="scr pause">
  <div class="shade"></div>
  <div class="pn">
    <div class="hd">歇<small>PAUSED</small></div>
    <div class="mn">
      <button data-act="resume"><b>继续</b><i>resume</i></button>
      <button data-act="restart"><b>重来</b><i>restart</i></button>
      <button data-act="controls"><b>招式</b><i>controls</i></button>
      <div class="vol"><b>声</b><div class="sl"><div class="tr m"></div><div class="fl m"></div></div><i>volume</i></div>
      <div class="qual"><b>画</b><span class="qo" data-q="low">流畅</span><span class="qo" data-q="med">均衡</span><span class="qo" data-q="high">极致</span><i>quality</i></div>
      <div class="ctl">${CONTROLS.map(([k, zh, en]) => `<kbd>${k}</kbd><span>${zh}<i>${en}</i></span>`).join('')}</div>
    </div>
  </div>
  <div class="ft">the grass waits · the wind does not</div>
</div>

<div class="scr end victory">
  <div class="shade"></div>
  <div class="st"></div>
  <div class="body"></div>
  <div class="tr"></div>
  <div class="go" data-act="restart"></div>
</div>
<div class="scr end defeat">
  <div class="shade"></div>
  <div class="body"></div>
  <div class="tr"></div>
  <div class="go" data-act="restart"></div>
</div>`;

/** Fill an ending screen with its poem. Lines are vertical columns read right-to-left. */
export function fillEnding(root, poem, sealUrl) {
  const body = root.querySelector('.body');
  body.innerHTML = poem.lines.map((l, i) => `<div class="ln${i >= 2 ? ' sm' : ''}" style="--i:${i}">${esc(l)}</div>`).join('') +
    (sealUrl ? `<img class="seal" src="${sealUrl}" alt="">` : '');
  root.querySelector('.tr').innerHTML = `${poem.en}<small>${esc(poem.src)}</small>`;
  root.querySelector('.go').innerHTML = `<b>${esc(poem.go[0])}</b><i>${esc(poem.go[1])}</i>`;
}

export { esc };
