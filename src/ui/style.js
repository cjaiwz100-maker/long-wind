// HUD stylesheet (injected once). Ink #e8d3ad on the living scene, vermilion #b8322a for the one warm accent,
// Ma Shan Zheng for calligraphy, Noto Serif SC for small Chinese text, Cormorant Garamond for Latin.
// Brush textures arrive as CSS custom properties (--t-*) set by ui/textures.js; until then they are transparent,
// so nothing flashes as a hard rectangle. Only transform/opacity animate in play; masks stay static.
// Owner: UI (U).
export const HUD_CSS = /* css */`
.wx { position: absolute; inset: 0; overflow: hidden; pointer-events: none; user-select: none; -webkit-user-select: none;
  --ink: #e8d3ad; --ink-hi: #f3e4c4; --ink-dim: rgba(232,211,173,.58); --verm: #b8322a; --verm-hi: #d9493c; --sumi: #0c0b09; --gold: #f4cf86;
  --f-brush: 'Ma Shan Zheng', 'Noto Serif SC', serif; --f-serif: 'Noto Serif SC', serif; --f-latin: 'Cormorant Garamond', 'Noto Serif SC', serif;
  --none: linear-gradient(transparent, transparent);
  --t-stroke: var(--none); --t-stroke2: var(--none); --t-stroke3: var(--none); --t-thin: var(--none); --t-enso: var(--none); --t-enso2: var(--none);
  --t-splat: var(--none); --t-splat2: var(--none); --t-wash: var(--none); --t-edge: var(--none); --t-tick: var(--none);
  font-family: var(--f-serif); color: var(--ink); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  --ease-brush: cubic-bezier(.3,.7,.2,1); --ease-ink: cubic-bezier(.22,.61,.36,1); }
.wx *, .wx *::before, .wx *::after { box-sizing: border-box; }
.wx .lyr { position: absolute; inset: 0; pointer-events: none; }
.wx .m { -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-position: center; mask-position: center; }
.wx .seal { display: block; image-rendering: auto; filter: drop-shadow(0 1px 1px rgba(0,0,0,.25)); }
.wx svg.defs { position: absolute; width: 0; height: 0; }

/* ---------- in-game layer visibility ---------- */
.wx .play { opacity: 0; transition: opacity 1.1s var(--ease-ink); }
.wx[data-state=playing] .play { opacity: 1; }
.wx[data-state=paused] .play { opacity: .35; }

/* ---------- vitals: focus ensō + health stroke (bottom-left) ---------- */
.wx .vitals { position: absolute; left: clamp(18px, 3.6vw, 70px); bottom: clamp(16px, 5.2vh, 64px); display: flex; align-items: center;
  gap: clamp(8px, 1vw, 16px); --s: clamp(.72, calc(100vmin / 900px), 1.25); }
.wx .vitals::before { content: ''; position: absolute; left: -12%; right: -18%; top: -70%; bottom: -80%; background: rgba(6,5,4,.42);
  -webkit-mask-image: var(--t-wash); mask-image: var(--t-wash); -webkit-mask-size: 100% 100%; mask-size: 100% 100%; z-index: -1; }
.wx .focus { position: relative; width: calc(84px * var(--s)); height: calc(84px * var(--s)); flex: none; --f: 0; }
.wx .focus > * { position: absolute; inset: 0; }
.wx .focus .wash { inset: 20%; border-radius: 50%; background: radial-gradient(circle at 50% 55%, rgba(232,211,173,.34), rgba(232,211,173,.12) 45%, rgba(232,211,173,0) 70%);
  transform: scale(calc(.35 + .75 * var(--f))); opacity: calc(var(--f) * .95); transition: transform .5s var(--ease-ink), opacity .5s; }
.wx .focus .rt { background: var(--ink); opacity: .17; -webkit-mask-image: var(--t-enso); mask-image: var(--t-enso); }
.wx .focus .r { background: var(--ink);
  -webkit-mask-image: var(--t-enso), conic-gradient(from -36deg, #000 calc(var(--f) * 90%), transparent calc(var(--f) * 90% + 1.5%));
  mask-image: var(--t-enso), conic-gradient(from -36deg, #000 calc(var(--f) * 90%), transparent calc(var(--f) * 90% + 1.5%));
  -webkit-mask-composite: source-in; mask-composite: intersect; }
.wx .focus .g { display: grid; place-items: center; font-family: var(--f-brush); font-size: calc(34px * var(--s)); line-height: 1;
  color: var(--ink); opacity: calc(.28 + .5 * var(--f)); padding-bottom: 6%; transition: color .4s, text-shadow .4s; }
.wx .focus.full .r { background: var(--gold); filter: drop-shadow(0 0 6px rgba(255,190,100,.55)); }
.wx .focus.full .g { color: var(--gold); opacity: 1; text-shadow: 0 0 14px rgba(255,186,90,.75), 0 0 2px rgba(255,220,160,.9); animation: wx-breathe 2.4s ease-in-out infinite; }
.wx .focus.full .wash { background: radial-gradient(circle at 50% 55%, rgba(244,207,134,.42), rgba(244,207,134,.12) 50%, transparent 70%); }
.wx .focus .pulse { opacity: 0; background: var(--gold); -webkit-mask-image: var(--t-enso2); mask-image: var(--t-enso2); transform: scale(.9); }
.wx .focus.fill .pulse { animation: wx-enso-pulse 1.1s var(--ease-ink) both; }

.wx .health { position: relative; width: calc(400px * var(--s)); height: calc(46px * var(--s)); --v: 1; --gh: 1; }
.wx .health > * { position: absolute; inset: 0; }
.wx .health .tr { background: var(--ink); opacity: .13; -webkit-mask-image: var(--t-stroke); mask-image: var(--t-stroke); }
.wx .health .fl {
  -webkit-mask-image: var(--t-stroke), linear-gradient(90deg, #000 calc(var(--x) * 100% - 4%), rgba(0,0,0,.55) calc(var(--x) * 100%), transparent calc(var(--x) * 100% + 4%));
  mask-image: var(--t-stroke), linear-gradient(90deg, #000 calc(var(--x) * 100% - 4%), rgba(0,0,0,.55) calc(var(--x) * 100%), transparent calc(var(--x) * 100% + 4%));
  -webkit-mask-composite: source-in; mask-composite: intersect; }
.wx .health .gh { --x0: calc(var(--v) * .94 + .03); background: var(--verm-hi); opacity: .8;
  -webkit-mask-image: var(--t-stroke), linear-gradient(90deg, transparent calc(var(--x0) * 100% - 1%), #000 calc(var(--x0) * 100% + 2%), #000 calc(var(--x) * 100% - 2%), transparent calc(var(--x) * 100% + 2%));
  mask-image: var(--t-stroke), linear-gradient(90deg, transparent calc(var(--x0) * 100% - 1%), #000 calc(var(--x0) * 100% + 2%), #000 calc(var(--x) * 100% - 2%), transparent calc(var(--x) * 100% + 2%));
  -webkit-mask-composite: source-in; mask-composite: intersect; }
.wx .health .fl { --x: calc(var(--v) * .94 + .03); background: linear-gradient(180deg, var(--ink-hi), var(--ink) 55%, #cdb58c); }
.wx .health { filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
.wx .health .gh { --x: calc(var(--gh) * .94 + .03); }
.wx .health.low .fl { background: linear-gradient(90deg, #e4b6a0, var(--ink) 60%); animation: wx-low 1.4s ease-in-out infinite; }
.wx .health.hit { animation: wx-shake .32s linear; }
.wx .vitals .name { position: absolute; left: calc(100px * var(--s)); bottom: calc(-16px * var(--s)); font: italic 500 calc(12px * var(--s))/1 var(--f-latin);
  letter-spacing: .34em; text-transform: uppercase; color: var(--ink-dim); white-space: nowrap; }

/* ---------- boss: calligraphy name, health stroke, posture from the centre ---------- */
.wx .boss { position: absolute; top: clamp(14px, 4.6vh, 56px); left: 50%; width: clamp(320px, 46vw, 760px); transform: translateX(-50%);
  text-align: center; opacity: 0; transition: opacity 1.2s var(--ease-ink), transform 1.2s var(--ease-ink); --v: 1; --gh: 1; --p: 0; }
.wx .boss.on { opacity: 1; }
.wx[data-state] .boss:not(.on) { opacity: 0; }  /* the boss bar stays hidden during play until a boss is tracked */
.wx .boss::before { content: ''; position: absolute; left: -6%; right: -6%; top: -45%; bottom: -55%; z-index: -1;
  background: radial-gradient(closest-side, rgba(12,9,6,.34), rgba(12,9,6,.16) 55%, transparent); }
.wx .boss .nm { font-family: var(--f-brush); font-size: clamp(30px, 3.3vw, 52px); line-height: 1; letter-spacing: .24em; padding-left: .24em;
  color: var(--ink-hi); text-shadow: 0 1px 3px rgba(0,0,0,.35), 0 2px 18px rgba(0,0,0,.4); filter: url(#wx-ink); }
.wx .boss .sb { margin-top: 8px; font: italic 600 clamp(11px, .9vw, 14px)/1 var(--f-latin); letter-spacing: .42em; padding-left: .42em; text-transform: uppercase; color: var(--ink); opacity: .8; text-shadow: 0 1px 4px rgba(0,0,0,.5); }
.wx .boss .bar, .wx .boss .po { filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
.wx .boss .bar { position: relative; height: clamp(18px, 1.9vw, 28px); margin-top: 8px; }
.wx .boss .bar > * { position: absolute; inset: 0; }
.wx .boss .bar .tr { background: var(--sumi); opacity: .25; -webkit-mask-image: var(--t-stroke2); mask-image: var(--t-stroke2); }
.wx .boss .bar .fl {
  -webkit-mask-image: var(--t-stroke2), linear-gradient(90deg, #000 calc(var(--x) * 100% - 3%), rgba(0,0,0,.5) calc(var(--x) * 100%), transparent calc(var(--x) * 100% + 3%));
  mask-image: var(--t-stroke2), linear-gradient(90deg, #000 calc(var(--x) * 100% - 3%), rgba(0,0,0,.5) calc(var(--x) * 100%), transparent calc(var(--x) * 100% + 3%));
  -webkit-mask-composite: source-in; mask-composite: intersect; }
.wx .boss .bar .gh { --x: calc(var(--gh) * .95 + .025); --x0: calc(var(--v) * .95 + .025); background: var(--verm-hi); opacity: .8;
  -webkit-mask-image: var(--t-stroke2), linear-gradient(90deg, transparent calc(var(--x0) * 100% - 1%), #000 calc(var(--x0) * 100% + 1.5%), #000 calc(var(--x) * 100% - 1.5%), transparent calc(var(--x) * 100% + 1.5%));
  mask-image: var(--t-stroke2), linear-gradient(90deg, transparent calc(var(--x0) * 100% - 1%), #000 calc(var(--x0) * 100% + 1.5%), #000 calc(var(--x) * 100% - 1.5%), transparent calc(var(--x) * 100% + 1.5%));
  -webkit-mask-composite: source-in; mask-composite: intersect; }
.wx .boss .bar .fl { --x: calc(var(--v) * .95 + .025); background: var(--ink); }
.wx .boss .po { position: relative; height: clamp(9px, .9vw, 14px); margin: 4px auto 0; width: 70%; }
.wx .boss .po > * { position: absolute; top: 0; bottom: 0; width: calc(50% * var(--p)); background: var(--verm-hi); -webkit-mask-image: var(--t-thin); mask-image: var(--t-thin); }
.wx .boss .po .a { right: 50%; transform: scaleX(-1); }
.wx .boss .po .b { left: 50%; }
.wx .boss .po .a, .wx .boss .po .b { opacity: calc(.35 + .65 * var(--p)); }
.wx .boss.danger .po > * { background: #ff6a4a; filter: drop-shadow(0 0 5px rgba(255,90,50,.7)); }
.wx .boss.broken .po { animation: wx-break .6s ease-out; }
.wx .boss.phase .nm { animation: wx-phase 2.4s var(--ease-ink); }
.wx .boss.phase::after { content: ''; position: absolute; left: 50%; top: -10%; width: clamp(160px, 16vw, 260px); aspect-ratio: 1; transform: translate(-50%, -30%);
  background: var(--verm); -webkit-mask-image: var(--t-enso); mask-image: var(--t-enso); -webkit-mask-size: 100% 100%; mask-size: 100% 100%;
  opacity: 0; animation: wx-ensofx 1.6s var(--ease-ink); --tf: rotate(-20deg); z-index: -1; }

/* ---------- tracked enemy marks, reticle, flourishes ---------- */
.wx .mk { position: absolute; left: 0; top: 0; width: 96px; height: 24px; margin: -12px 0 0 -48px; opacity: 0; will-change: transform, opacity;
  transition: opacity .35s ease; --v: 1; --p: 0; }

.wx .mk.on { opacity: .75; }
.wx .mk { transform-origin: 50% 50%; scale: .8; }  /* smaller, quieter enemy marks */
.wx .mk > * { position: absolute; left: 0; right: 0; }
.wx .mk .tr { top: 0; height: 13px; background: var(--sumi); opacity: .22; -webkit-mask-image: var(--t-thin); mask-image: var(--t-thin); }
.wx .mk .fl { top: 0; height: 13px; background: #16120e;
  -webkit-mask-image: var(--t-thin), linear-gradient(90deg, #000 calc(var(--v) * 100% - 4%), transparent calc(var(--v) * 100% + 4%));
  mask-image: var(--t-thin), linear-gradient(90deg, #000 calc(var(--v) * 100% - 4%), transparent calc(var(--v) * 100% + 4%));
  -webkit-mask-composite: source-in; mask-composite: intersect; filter: drop-shadow(0 0 1.5px rgba(255,236,205,.55)); }
.wx .mk .po { top: 14px; height: 8px; left: 18%; right: 18%; background: var(--verm-hi); -webkit-mask-image: var(--t-thin); mask-image: var(--t-thin);
  transform: scaleX(var(--p)); opacity: calc(.2 + .8 * min(1, var(--p) * 3)); filter: drop-shadow(0 0 2px rgba(0,0,0,.4)); }
.wx .mk .x { top: -18px; bottom: -14px; background: var(--verm-hi); opacity: 0; -webkit-mask-image: var(--t-tick); mask-image: var(--t-tick); transform: rotate(-24deg) scaleX(0); }
.wx .mk.dead .x { animation: wx-slash .5s var(--ease-brush) forwards; }
.wx .mk.dead { transition: opacity .9s ease .5s; }
.wx .mk .wr { position: absolute; left: 50%; bottom: 20px; width: 44px; height: 44px; margin-left: -22px; display: grid; place-items: center;
  font: 36px/1 var(--f-brush); color: var(--verm-hi); text-shadow: 0 0 10px rgba(255,80,40,.6), 0 1px 2px rgba(0,0,0,.6); opacity: 0; }
.wx .mk .wr.go { animation: wx-danger .9s var(--ease-ink) forwards; }
.wx .mk .bk { position: absolute; left: 50%; bottom: 18px; width: 40px; height: 40px; margin-left: -20px; display: grid; place-items: center;
  font: 34px/1 var(--f-brush); color: var(--ink-hi); text-shadow: 0 0 12px rgba(255,120,60,.85), 0 0 3px rgba(255,200,150,.9), 0 1px 2px rgba(0,0,0,.6); opacity: 0; }
.wx .mk .bk.go { animation: wx-danger 1.1s var(--ease-ink) forwards; }
.wx .mk .gl { position: absolute; left: 50%; top: 50%; width: 30px; height: 30px; margin: -15px; opacity: 0;
  background: radial-gradient(circle, rgba(255,236,190,.95), rgba(255,200,120,.35) 30%, transparent 65%); }
.wx .mk .gl.go { animation: wx-glint .45s ease-out forwards; }

.wx .ret { position: absolute; left: 0; top: 0; width: 66px; height: 66px; margin: -33px 0 0 -33px; opacity: 0; transition: opacity .25s; will-change: transform; }
.wx .ret.on { opacity: 1; }
.wx .ret .e { position: absolute; inset: 0; background: var(--ink); opacity: .85; -webkit-mask-image: var(--t-enso2); mask-image: var(--t-enso2);
  animation: wx-spin 10s linear infinite; filter: drop-shadow(0 0 2px rgba(0,0,0,.55)); }
.wx .ret.on .e { animation: wx-spin 10s linear infinite, wx-lock .35s var(--ease-brush); }
.wx .ret .d { position: absolute; left: 50%; top: 50%; width: 5px; height: 5px; margin: -2.5px; border-radius: 50%; background: var(--verm-hi);
  box-shadow: 0 0 6px rgba(255,90,60,.8); }

.wx .fx { position: absolute; left: 0; top: 0; width: 120px; height: 120px; margin: -60px 0 0 -60px; opacity: 0; will-change: transform, opacity; }
.wx .fx.splat { background: var(--verm); -webkit-mask-image: var(--t-splat); mask-image: var(--t-splat); }
.wx .fx.splat.b { -webkit-mask-image: var(--t-splat2); mask-image: var(--t-splat2); }
.wx .fx.tick { width: 150px; height: 40px; margin: -20px 0 0 -75px; background: var(--ink-hi); -webkit-mask-image: var(--t-tick); mask-image: var(--t-tick); }
.wx .fx.tick.evade { width: 260px; height: 46px; margin: -23px 0 0 -130px; background: var(--ink); opacity: 0; filter: blur(.4px); }
.wx .fx.enso { width: 190px; height: 190px; margin: -95px 0 0 -95px; background: var(--gold); -webkit-mask-image: var(--t-enso); mask-image: var(--t-enso);
  filter: drop-shadow(0 0 10px rgba(255,190,100,.6)); }
.wx .fx.sealfx { width: 34px; height: 52px; margin: 0; }
.wx .fx.go { animation: var(--anim) forwards; }

/* ---------- hurt: ink bleeding in from the edges ---------- */
.wx .edge { position: absolute; inset: -2%; background: radial-gradient(ellipse at 50% 50%, transparent 38%, rgba(48,6,4,.72) 78%, rgba(18,3,2,.95) 100%);
  -webkit-mask-image: var(--t-edge); mask-image: var(--t-edge); -webkit-mask-size: 100% 100%; mask-size: 100% 100%; opacity: 0; --low: 0; }
.wx .edge.hurt { animation: wx-hurt 1.1s var(--ease-ink); }
.wx .edge.low { opacity: calc(.28 * var(--low)); animation: wx-lowedge 1.4s ease-in-out infinite; }
.wx .edge.low.hurt { animation: wx-hurt 1.1s var(--ease-ink); }

/* ---------- special: a sword-qi brush stroke sweeps the screen ---------- */
.wx .qi { position: absolute; left: 6%; right: 6%; top: 44%; height: 16vh; background: var(--ink-hi); opacity: 0;
  -webkit-mask-image: var(--t-stroke3), linear-gradient(90deg, #000 40%, transparent 60%); mask-image: var(--t-stroke3), linear-gradient(90deg, #000 40%, transparent 60%);
  -webkit-mask-size: 100% 100%, 250% 100%; mask-size: 100% 100%, 250% 100%; -webkit-mask-composite: source-in; mask-composite: intersect; transform: rotate(-7deg); }
.wx .qi.go { animation: wx-qi 1s var(--ease-brush) forwards; }

/* ---------- wave banner ---------- */
.wx .banner { position: absolute; left: 50%; top: 31%; transform: translate(-50%, -50%); text-align: center; opacity: 0; white-space: nowrap; }
.wx .banner.on { opacity: 1; }
.wx .banner.off { animation: wx-dissolve 1.4s var(--ease-ink) forwards; }
.wx .banner .wash { position: absolute; left: -38%; right: -38%; top: -52%; bottom: -58%; background: rgba(7,6,4,.28); -webkit-mask-image: var(--t-wash); mask-image: var(--t-wash);
  -webkit-mask-size: 100% 100%; mask-size: 100% 100%; opacity: 0; transform: scale(.92); }
.wx .banner.on .wash { animation: wx-wash 1.2s var(--ease-ink) forwards; }
.wx .banner .no { position: relative; font: 600 clamp(14px, 1.25vw, 20px)/1 var(--f-serif); letter-spacing: .9em; padding-left: .9em; color: var(--ink); opacity: 0; }
.wx .banner.on .no { animation: wx-rise .9s var(--ease-ink) .1s forwards; }
.wx .banner.boss .no { color: var(--verm-hi); text-shadow: 0 0 12px rgba(0,0,0,.45); }
.wx .banner .tt { position: relative; margin-top: .18em; font-family: var(--f-brush); font-size: clamp(72px, 9.5vw, 168px); line-height: 1.02; letter-spacing: .18em; padding-left: .18em;
  color: var(--ink-hi); text-shadow: 0 4px 30px rgba(0,0,0,.35); filter: url(#wx-ink);
  -webkit-mask-image: linear-gradient(90deg, #000 42%, transparent 58%); mask-image: linear-gradient(90deg, #000 42%, transparent 58%);
  -webkit-mask-size: 260% 100%; mask-size: 260% 100%; -webkit-mask-position: 100% 0; mask-position: 100% 0; }
.wx .banner.on .tt { animation: wx-wipe 1.5s var(--ease-brush) .25s forwards; }
.wx .banner .ru { position: relative; width: clamp(260px, 30vw, 520px); height: clamp(18px, 2vw, 30px); margin: .1em auto 0; background: var(--ink); opacity: .9;
  -webkit-mask-image: var(--t-stroke3), linear-gradient(90deg, #000 42%, transparent 58%); mask-image: var(--t-stroke3), linear-gradient(90deg, #000 42%, transparent 58%);
  -webkit-mask-size: 100% 100%, 260% 100%; mask-size: 100% 100%, 260% 100%; -webkit-mask-position: 0 0, 100% 0; mask-position: 0 0, 100% 0;
  -webkit-mask-composite: source-in; mask-composite: intersect; }
.wx .banner.on .ru { animation: wx-wipe2 1.1s var(--ease-brush) .9s forwards; }
.wx .banner .en { position: relative; margin-top: 14px; font: italic 500 clamp(13px, 1.1vw, 18px)/1 var(--f-latin); letter-spacing: .5em; padding-left: .5em;
  text-transform: uppercase; color: var(--ink); opacity: 0; }
.wx .banner.on .en { animation: wx-rise 1s var(--ease-ink) 1.3s forwards; }
.wx .banner .seal { position: absolute; right: -6%; top: 22%; width: clamp(26px, 2.4vw, 40px); opacity: 0; transform: scale(1.6) rotate(-8deg); }
.wx .banner.on .seal { animation: wx-stamp .45s cubic-bezier(.5,0,.7,1.4) 1.55s forwards; }

/* ---------- controls hint ---------- */
.wx .hint { position: absolute; right: clamp(16px, 3.6vw, 70px); bottom: clamp(16px, 5.2vh, 64px); display: grid; grid-template-columns: auto auto; gap: 5px 14px;
  align-items: baseline; opacity: 0; transition: opacity 2.2s var(--ease-ink); font-size: 13px; text-shadow: 0 1px 6px rgba(0,0,0,.55); }
.wx .hint.on { opacity: .9; }
.wx .hint::before { content: ''; position: absolute; left: -30%; right: -22%; top: -30%; bottom: -30%; background: rgba(6,5,4,.34); z-index: -1;
  -webkit-mask-image: var(--t-wash); mask-image: var(--t-wash); -webkit-mask-size: 100% 100%; mask-size: 100% 100%; }
.wx kbd { font: 600 13px/1 var(--f-latin); letter-spacing: .14em; color: var(--ink); text-align: right; opacity: .75; text-transform: uppercase; }
.wx .hint span, .wx .ctl span { font: 400 14px/1.2 var(--f-serif); color: var(--ink); letter-spacing: .12em; }
.wx .hint span i, .wx .ctl span i { font: italic 500 14px/1 var(--f-latin); color: var(--ink-dim); letter-spacing: .1em; margin-left: .5em; }

/* ---------- full-screen screens (title, pause, endings) ---------- */
.wx .scr { position: absolute; inset: 0; opacity: 0; visibility: hidden; transition: opacity 1.4s var(--ease-ink), visibility 0s linear 1.4s; }
.wx .scr.on { opacity: 1; visibility: visible; transition: opacity 1.4s var(--ease-ink), visibility 0s; }
.wx .scr .shade { position: absolute; inset: 0; }

/* title */
.wx .title .shade { background:
  radial-gradient(ellipse 60% 85% at 76% 46%, rgba(8,7,5,.58), rgba(8,7,5,.2) 55%, transparent 80%),
  linear-gradient(180deg, rgba(8,7,5,.28), transparent 26%, transparent 64%, rgba(8,7,5,.55)); }
.wx .title .col { position: absolute; right: 16%; top: 50%; transform: translateY(-52%); display: flex; flex-direction: row-reverse; align-items: flex-start; gap: clamp(10px, 1.6vw, 26px); }
.wx .title .tt { writing-mode: vertical-rl; font-family: var(--f-brush); font-size: clamp(110px, 17vh, 230px); line-height: 1; letter-spacing: .02em; color: var(--ink-hi);
  text-shadow: 0 6px 40px rgba(0,0,0,.35); filter: url(#wx-ink-live);
  -webkit-mask-image: linear-gradient(180deg, #000 42%, transparent 58%); mask-image: linear-gradient(180deg, #000 42%, transparent 58%);
  -webkit-mask-size: 100% 260%; mask-size: 100% 260%; -webkit-mask-position: 0 100%; mask-position: 0 100%; }
.wx .title.on .tt { animation: wx-wipev 2.4s var(--ease-brush) .4s forwards; }
.wx .title .tg { writing-mode: vertical-rl; margin-top: clamp(26px, 5vh, 70px); font: 400 clamp(15px, 1.9vh, 22px)/1.9 var(--f-serif); letter-spacing: .55em; color: var(--ink); opacity: 0; }
.wx .title.on .tg { animation: wx-rise 1.6s var(--ease-ink) 1.8s forwards; }
.wx .title .seal { width: clamp(30px, 3.6vh, 46px); margin-top: clamp(150px, 26vh, 320px); opacity: 0; transform: scale(1.6) rotate(-8deg); }
.wx .title.on .seal { animation: wx-stamp .5s cubic-bezier(.5,0,.7,1.4) 2.6s forwards; }
.wx .title .en { position: absolute; right: 16%; bottom: calc(50% - clamp(170px, 26vh, 330px)); transform: translateX(8%); text-align: right; opacity: 0; }
.wx .title.on .en { animation: wx-rise 1.6s var(--ease-ink) 2.2s forwards; }
.wx .title .en b { display: block; font: 600 clamp(15px, 1.3vw, 22px)/1 var(--f-latin); letter-spacing: .62em; color: var(--ink); }
.wx .title .en i { display: block; margin-top: 10px; font: italic 400 clamp(12px, 1vw, 16px)/1 var(--f-latin); letter-spacing: .24em; color: var(--ink-dim); }
.wx .title .go { position: absolute; left: 50%; bottom: 9vh; transform: translateX(-50%); display: flex; align-items: center; gap: 18px; opacity: 0; white-space: nowrap; }
.wx .title.on .go { animation: wx-rise 1.4s var(--ease-ink) 3.1s forwards; }
.wx .title .go .ln { width: clamp(50px, 7vw, 120px); height: 10px; background: var(--ink); opacity: .6; -webkit-mask-image: var(--t-thin); mask-image: var(--t-thin); }
.wx .title .go .ln.r { transform: scaleX(-1); }
.wx .title .go div.t { text-align: center; animation: wx-breathe 3.6s ease-in-out infinite; }
.wx .title .go div.t b { display: block; font: 400 clamp(15px, 1.3vw, 20px)/1 var(--f-serif); letter-spacing: .7em; padding-left: .7em; color: var(--ink); }
.wx .title .go div.t i { display: block; margin-top: 8px; font: italic 400 13px/1 var(--f-latin); letter-spacing: .38em; padding-left: .38em; color: var(--ink-dim); }

/* pause */
.wx .pause { pointer-events: none; transition-duration: .5s; }
.wx .pause.on { pointer-events: auto; transition-duration: .5s; }
.wx .pause .shade { background: linear-gradient(90deg, rgba(8,7,5,.86), rgba(8,7,5,.6) 38%, rgba(8,7,5,.28) 70%, rgba(8,7,5,.2));
  -webkit-backdrop-filter: blur(3px) saturate(.75); backdrop-filter: blur(3px) saturate(.75); }
.wx .pause .pn { position: absolute; left: clamp(28px, 11vw, 220px); top: 50%; transform: translateY(-50%); display: flex; gap: clamp(26px, 4vw, 70px); align-items: flex-start; }
.wx .pause .hd { writing-mode: vertical-rl; font: clamp(80px, 13vh, 150px)/1 var(--f-brush); color: var(--ink-hi); filter: url(#wx-ink); opacity: .95; }
.wx .pause .hd small { display: block; font: italic 500 13px/1 var(--f-latin); letter-spacing: .5em; color: var(--ink-dim); margin-right: 14px; }
.wx .pause .mn { display: flex; flex-direction: column; gap: clamp(8px, 1.6vh, 16px); padding-top: 8px; }
.wx .pause button { all: unset; position: relative; cursor: pointer; display: flex; align-items: baseline; gap: 16px; padding: 6px 2px 10px; color: var(--ink); }
.wx .pause button b { font: 400 clamp(26px, 3.6vh, 38px)/1 var(--f-brush); letter-spacing: .2em; }
.wx .pause button i { font: italic 500 clamp(13px, 1.6vh, 16px)/1 var(--f-latin); letter-spacing: .3em; color: var(--ink-dim); text-transform: uppercase; }
.wx .pause button::after { content: ''; position: absolute; left: -6px; right: -20px; bottom: -2px; height: 12px; background: var(--verm-hi);
  -webkit-mask-image: var(--t-thin), linear-gradient(90deg, #000 42%, transparent 58%); mask-image: var(--t-thin), linear-gradient(90deg, #000 42%, transparent 58%);
  -webkit-mask-size: 100% 100%, 260% 100%; mask-size: 100% 100%, 260% 100%; -webkit-mask-position: 0 0, 100% 0; mask-position: 0 0, 100% 0;
  -webkit-mask-composite: source-in; mask-composite: intersect; transition: -webkit-mask-position .45s var(--ease-brush), mask-position .45s var(--ease-brush); opacity: .9; }
.wx .pause button:hover::after, .wx .pause button:focus-visible::after, .wx .pause button.sel::after { -webkit-mask-position: 0 0, 0 0; mask-position: 0 0, 0 0; }
.wx .pause button:hover b, .wx .pause button.sel b { color: var(--ink-hi); text-shadow: 0 0 18px rgba(255,220,170,.25); }
.wx .pause .qual { display: flex; align-items: center; gap: 14px; margin-top: 2px; padding-left: 2px; pointer-events: auto; }
.wx .pause .qual b { font: 400 clamp(20px, 2.6vh, 28px)/1 var(--f-brush); letter-spacing: .2em; color: var(--ink); margin-right: 4px; }
.wx .pause .qual i { font: italic 500 13px/1 var(--f-latin); letter-spacing: .3em; color: var(--ink-dim); text-transform: uppercase; margin-left: 6px; }
.wx .pause .qual .qo { font: 400 clamp(16px, 2.1vh, 22px)/1 var(--f-brush); color: var(--ink-dim); cursor: pointer; padding: 4px 2px; border-bottom: 2px solid transparent; transition: color .2s, border-color .2s; }
.wx .pause .qual .qo:hover { color: var(--ink-hi); }
.wx .pause .qual .qo.on { color: var(--ink-hi); border-bottom-color: var(--verm); }
.wx .pause .vol { display: flex; align-items: center; gap: 16px; margin-top: 4px; padding-left: 2px; }
.wx .pause .vol b { font: 400 clamp(20px, 2.6vh, 28px)/1 var(--f-brush); letter-spacing: .2em; color: var(--ink); }
.wx .pause .vol i { font: italic 500 13px/1 var(--f-latin); letter-spacing: .3em; color: var(--ink-dim); text-transform: uppercase; }
.wx .pause .sl { position: relative; width: clamp(160px, 16vw, 260px); height: 26px; cursor: pointer; --v: .8; touch-action: none; }
.wx .pause .sl > * { position: absolute; inset: 0; }
.wx .pause .sl .tr { background: var(--ink); opacity: .16; -webkit-mask-image: var(--t-stroke2); mask-image: var(--t-stroke2); }
.wx .pause .sl .fl { background: var(--ink);
  -webkit-mask-image: var(--t-stroke2), linear-gradient(90deg, #000 calc(var(--v) * 100% - 2%), transparent calc(var(--v) * 100% + 2%));
  mask-image: var(--t-stroke2), linear-gradient(90deg, #000 calc(var(--v) * 100% - 2%), transparent calc(var(--v) * 100% + 2%));
  -webkit-mask-composite: source-in; mask-composite: intersect; }
.wx .pause .ctl { display: none; grid-template-columns: auto auto; gap: 9px 18px; align-items: baseline; margin-top: 10px; padding: 14px 4px 0; }
.wx .pause.show-ctl .ctl { display: grid; }
.wx .pause .ft { position: absolute; left: clamp(28px, 11vw, 220px); bottom: 7vh; font: italic 400 13px/1.6 var(--f-latin); letter-spacing: .24em; color: var(--ink-dim); }

/* endings */
.wx .end .shade { background: radial-gradient(ellipse 70% 90% at 50% 45%, rgba(8,7,5,.35), rgba(8,7,5,.7) 70%, rgba(8,7,5,.9)); }
.wx .end.defeat .shade { background: radial-gradient(ellipse 70% 90% at 50% 45%, rgba(10,6,5,.55), rgba(10,5,4,.82) 70%, rgba(6,3,2,.95)); -webkit-backdrop-filter: saturate(.3); backdrop-filter: saturate(.3); }
.wx .end .body { position: absolute; left: 50%; top: 47%; transform: translate(-50%, -50%); display: flex; flex-direction: row-reverse; align-items: flex-start; gap: clamp(18px, 3.4vw, 56px); }
.wx .end .ln { writing-mode: vertical-rl; font: clamp(44px, 7.4vh, 90px)/1.08 var(--f-brush); letter-spacing: .1em; color: var(--ink-hi); filter: url(#wx-ink);
  text-shadow: 0 4px 30px rgba(0,0,0,.4);
  -webkit-mask-image: linear-gradient(180deg, #000 42%, transparent 58%); mask-image: linear-gradient(180deg, #000 42%, transparent 58%);
  -webkit-mask-size: 100% 260%; mask-size: 100% 260%; -webkit-mask-position: 0 100%; mask-position: 0 100%; }
.wx .end .ln.sm { font-size: clamp(30px, 4.8vh, 58px); color: var(--ink); margin-top: clamp(40px, 8vh, 100px); }
.wx .end.on .ln { animation: wx-wipev 1.9s var(--ease-brush) forwards; animation-delay: calc(.5s + var(--i) * .9s); }
.wx .end .seal { width: clamp(30px, 3.6vh, 44px); align-self: flex-end; opacity: 0; transform: scale(1.6) rotate(-8deg); }
.wx .end.on .seal { animation: wx-stamp .5s cubic-bezier(.5,0,.7,1.4) 4.4s forwards; }
.wx .end .tr { position: absolute; left: 50%; bottom: 17vh; transform: translateX(-50%); width: min(720px, 86vw); text-align: center;
  font: italic 400 clamp(15px, 1.35vw, 20px)/1.7 var(--f-latin); letter-spacing: .06em; color: var(--ink); opacity: 0; }
.wx .end.on .tr { animation: wx-rise 1.6s var(--ease-ink) 4.2s forwards; }
.wx .end .tr small { display: block; margin-top: 6px; font-size: .72em; letter-spacing: .3em; color: var(--ink-dim); font-style: normal; text-transform: uppercase; }
.wx .end .st { position: absolute; left: 50%; top: 7vh; transform: translateX(-50%); display: flex; gap: clamp(22px, 4vw, 60px); opacity: 0; }
.wx .end.on .st { animation: wx-rise 1.4s var(--ease-ink) 5s forwards; }
.wx .end .st div { text-align: center; }
.wx .end .st b { display: block; font: 400 clamp(22px, 2vw, 30px)/1 var(--f-brush); color: var(--ink-hi); }
.wx .end .st i { display: block; margin-top: 6px; font: 400 12px/1 var(--f-serif); letter-spacing: .4em; padding-left: .4em; color: var(--ink-dim); font-style: normal; }
.wx .end .go { position: absolute; left: 50%; bottom: 7vh; transform: translateX(-50%); text-align: center; opacity: 0; pointer-events: none; }
.wx .end.on .go { animation: wx-rise 1.4s var(--ease-ink) 5.6s forwards; }
.wx .end .go b { display: block; font: 400 clamp(18px, 1.6vw, 24px)/1 var(--f-brush); letter-spacing: .6em; padding-left: .6em; color: var(--ink); animation: wx-breathe 3.6s ease-in-out infinite; }
.wx .end .go i { display: block; margin-top: 8px; font: italic 400 13px/1 var(--f-latin); letter-spacing: .38em; padding-left: .38em; color: var(--ink-dim); }

/* ---------- keyframes ---------- */
@keyframes wx-breathe { 0%, 100% { opacity: .62; } 50% { opacity: 1; } }
@keyframes wx-low { 0%, 100% { opacity: .78; } 50% { opacity: 1; } }
@keyframes wx-lowedge { 0%, 100% { opacity: calc(.2 * var(--low)); } 50% { opacity: calc(.42 * var(--low)); } }
@keyframes wx-shake { 0% { transform: translate(0,0); } 20% { transform: translate(-3px,1px); } 40% { transform: translate(3px,-1px); } 60% { transform: translate(-2px,0); } 80% { transform: translate(1px,1px); } 100% { transform: none; } }
@keyframes wx-hurt { 0% { opacity: 0; } 12% { opacity: .95; } 100% { opacity: calc(.28 * var(--low)); } }
@keyframes wx-spin { to { rotate: 360deg; } }
@keyframes wx-lock { from { transform: scale(1.8); opacity: 0; } to { transform: scale(1); opacity: .85; } }
@keyframes wx-slash { 0% { opacity: 0; transform: rotate(-24deg) scaleX(0); } 20% { opacity: 1; } 100% { opacity: 1; transform: rotate(-24deg) scaleX(1.25); } }
@keyframes wx-danger { 0% { opacity: 0; transform: scale(1.7); filter: blur(4px); } 18% { opacity: 1; transform: scale(1); filter: blur(0); } 70% { opacity: 1; } 100% { opacity: 0; transform: scale(1.05) translateY(-6px); filter: blur(2px); } }
@keyframes wx-glint { 0% { opacity: 0; transform: scale(.3) rotate(0deg); } 25% { opacity: 1; transform: scale(1.4) rotate(20deg); } 100% { opacity: 0; transform: scale(.6) rotate(45deg); } }
@keyframes wx-enso-pulse { 0% { opacity: 0; transform: scale(.8) rotate(-30deg); } 30% { opacity: 1; } 100% { opacity: 0; transform: scale(1.5) rotate(10deg); } }
@keyframes wx-splat { 0% { opacity: 0; transform: var(--tf) scale(.35); } 12% { opacity: .95; transform: var(--tf) scale(1); } 100% { opacity: 0; transform: var(--tf) scale(1.12); } }
@keyframes wx-tick { 0% { opacity: 0; transform: var(--tf) scaleX(.2); } 15% { opacity: 1; transform: var(--tf) scaleX(1); } 100% { opacity: 0; transform: var(--tf) scaleX(1.15); } }
@keyframes wx-ensofx { 0% { opacity: 0; transform: var(--tf) scale(.55) rotate(-40deg); } 18% { opacity: 1; } 100% { opacity: 0; transform: var(--tf) scale(1.25) rotate(8deg); } }
@keyframes wx-sealfx { 0% { opacity: 0; transform: var(--tf) scale(1.8) rotate(-10deg); } 20% { opacity: 1; transform: var(--tf) scale(1) rotate(-6deg); } 75% { opacity: 1; } 100% { opacity: 0; transform: var(--tf) scale(1) rotate(-6deg); } }
@keyframes wx-qi { 0% { opacity: 0; -webkit-mask-position: 0 0, 100% 0; mask-position: 0 0, 100% 0; } 15% { opacity: .5; } 60% { opacity: .35; -webkit-mask-position: 0 0, 0 0; mask-position: 0 0, 0 0; } 100% { opacity: 0; -webkit-mask-position: 0 0, 0 0; mask-position: 0 0, 0 0; } }
@keyframes wx-wash { to { opacity: 1; transform: scale(1); } }
@keyframes wx-wipe { to { -webkit-mask-position: 0 0; mask-position: 0 0; } }
@keyframes wx-wipe2 { to { -webkit-mask-position: 0 0, 0 0; mask-position: 0 0, 0 0; } }
@keyframes wx-wipev { to { -webkit-mask-position: 0 0; mask-position: 0 0; } }
@keyframes wx-rise { from { opacity: 0; transform: translateY(8px); filter: blur(3px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes wx-stamp { 0% { opacity: 0; transform: scale(1.6) rotate(-8deg); } 70% { opacity: 1; transform: scale(.94) rotate(-3deg); } 100% { opacity: .92; transform: scale(1) rotate(-3deg); } }
@keyframes wx-dissolve { from { opacity: 1; filter: blur(0); transform: translate(-50%, -50%); } to { opacity: 0; filter: blur(10px); transform: translate(-50%, calc(-50% - 14px)) scale(1.03); } }
@keyframes wx-phase { 0% { color: var(--ink-hi); } 12% { color: #ffd2b8; text-shadow: 0 0 22px rgba(217,73,60,.95), 0 0 4px rgba(255,160,120,.9); transform: scale(1.06); }
  100% { color: var(--ink-hi); text-shadow: 0 1px 3px rgba(0,0,0,.35), 0 2px 18px rgba(0,0,0,.4); transform: none; } }
@keyframes wx-break { 0% { transform: scaleX(1); filter: brightness(2.2); } 100% { transform: scaleX(1.2); opacity: 0; } }
.wx .title .en { transition: none; }
/* combo counter: a brush numeral and 连斩, stamped in on every hit, warming to vermilion as the chain grows */
.wx .combo { position: absolute; right: 5.5%; top: 34%; display: flex; align-items: baseline; gap: .18em; opacity: 0; pointer-events: none;
  transition: opacity .5s; transform-origin: 100% 60%; }
.wx .combo.on { opacity: 1; transition: opacity .08s; }
.wx .combo .n { font: calc(64px + var(--c, 0) * 1.6px)/1 var(--f-brush); color: var(--ink-hi);
  text-shadow: 0 1px 3px rgba(0,0,0,.5), 0 0 18px rgba(0,0,0,.35); filter: url(#wx-ink); }
.wx .combo .l { font: 22px/1 var(--f-brush); letter-spacing: .2em; color: var(--ink); text-shadow: 0 1px 3px rgba(0,0,0,.55); }
.wx .combo.hot .n { color: var(--verm-hi); text-shadow: 0 0 14px rgba(217,73,60,.55), 0 1px 3px rgba(0,0,0,.6); }
.wx .combo.pop { animation: wx-combo .22s cubic-bezier(.2,1.6,.4,1); }
@keyframes wx-combo { 0% { transform: scale(1.45) rotate(-4deg); filter: brightness(1.8); } 100% { transform: none; filter: none; } }
@media (prefers-reduced-motion: reduce) { .wx *, .wx *::before, .wx *::after { animation-duration: .01s !important; animation-delay: 0s !important; } }
`;
