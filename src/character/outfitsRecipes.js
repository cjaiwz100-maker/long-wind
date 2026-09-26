// Outfit recipes per character kind (owner: character C). Palettes follow bible §1.4 (linear albedo).
//   hero         月白 outer robe (wide sleeves, cross collar with ink-indigo trims, split skirt), indigo inner layer
//                and trousers, crimson sash with two tails, dark leg wraps, black cloth shoes with pale soles, douli
//                with chin cord, long black hair tail, jian with crimson tassel in a dark lacquer scabbard
//   bandit       rough hemp/leather: short tunics, vests, bracers, wraps or torn hats; dao or spear; seed variety
//   bandit_heavy big frame, open fur-trimmed leather vest over bare chest, headband, beard, nine-ring broad dao
//   swordmaster  black long coat split in four panels with crimson lining, crimson sash, tall boots, topknot with a
//                lacquer crown, long hair, lacquer mask, long miao dao
import { robe, innerLayer, sash, skirt, trousers, legWraps, shoes, vest, bracers, ribbon } from './outfits.js';
import { V } from './outfitsKit.js';
import { COL } from './cloth.js';
import { hairCap, hairTail, douli, headwrap, headband, topknot, mask, beard } from './outfitsHead.js';

const PI = Math.PI;

export const PALETTE = {
  robe: [0.3, 0.325, 0.35], indigo: [0.035, 0.045, 0.07], crimson: [0.30, 0.03, 0.025], tassel: [0.45, 0.02, 0.02],
  straw: [0.42, 0.32, 0.17], hair: [0.018, 0.015, 0.013], black: [0.022, 0.021, 0.024],
  leather: [0.09, 0.06, 0.04], cloth: [0.12, 0.10, 0.08],
};

const BANDIT_CLOTH = [[0.12, 0.10, 0.08], [0.085, 0.075, 0.065], [0.15, 0.13, 0.095], [0.05, 0.055, 0.068], [0.13, 0.075, 0.045], [0.1, 0.1, 0.085]];
const BANDIT_DARK = [[0.05, 0.045, 0.04], [0.035, 0.035, 0.04], [0.07, 0.05, 0.035], [0.06, 0.06, 0.055]];
const WRAP_LIGHT = [[0.26, 0.24, 0.2], [0.2, 0.18, 0.15], [0.3, 0.27, 0.22]];
const LEATHER = [[0.09, 0.06, 0.04], [0.06, 0.045, 0.035], [0.11, 0.07, 0.045]];
const HEADCLOTH = [[0.2, 0.05, 0.035], [0.05, 0.05, 0.06], [0.14, 0.12, 0.09], [0.08, 0.1, 0.12], [0.16, 0.1, 0.05]];

/** Recipe = { skin: body skin mode, hands, weapon: {type, opts}, dress(ctx) }. */
export function recipe(kind, rng) {
  const pick = (a) => a[Math.floor(rng() * a.length) % a.length];
  const P = PALETTE;
  if (kind.startsWith('citizen_')) return citizenRecipe(kind, rng);
  if (kind === 'hero') {
    return {
      skin: 'neck', hands: { L: 'swordfinger', R: 'grip' },   // jian: one-handed, the free hand in 剑指
      weapon: { type: 'jian', opts: { tasselColor: P.tassel } },
      dress(ctx) {
        // fitted sleeves bound at the forearm (reference: 黑神话·钟馗 field robe) — wide bags read as wings once the arms hang
        robe(ctx, { name: 'robe', sleeve: 'narrow', sleeveR: 0.074, collar: 'cross', color: P.robe, trim: P.indigo, trimW: 0.046, cuffTrimW: 0.04, lining: [0.24, 0.26, 0.28], waistY: 1.03, blouseY: 1.105, cuff: -0.075, t: 0.019, drape: 0.05, blouse: 0.014 });
        bracers(ctx, { color: [0.07, 0.072, 0.085], t: 0.014 });
        innerLayer(ctx, { color: P.indigo, trim: [0.48, 0.46, 0.41] });
        const tr = trousers(ctx, { color: P.indigo, y1: 0.41, dirt: 0.3 });
        skirt(ctx, { under: tr.sdf,
          name: 'skirt', y0: 1.045, hemY: 0.29, n: 20, rows: [1.045, 0.93, 0.79, 0.63, 0.46, 0.29], pins: [1, 0.55, 0.08, 0.025, 0.015, 0.01],
          slits: [{ angle: PI / 2, top: 0.86 }, { angle: -PI / 2, top: 0.86 }], color: P.robe, trim: P.indigo, trimW: 0.05, lining: [0.3, 0.32, 0.34],
          folds: { n: 14, amp: 0.016 }, dirt: 0.6, clear: [0.02, 0.032, 0.05], flare: 0.12,
        });
        sash(ctx, { name: 'sash', y0: 1.0, y1: 1.105, color: P.crimson, pattern: 'silk', knot: [0.085, 0], tails: [0.6, 0.5], tailW: 0.07, cord: [0.02, 0.018, 0.02] });
        legWraps(ctx, { color: [0.07, 0.072, 0.085], y0: 0.1, y1: 0.46, ties: [0.02, 0.02, 0.022], dirt: 0.6 });
        shoes(ctx, { color: [0.025, 0.024, 0.026], sole: [0.45, 0.42, 0.36], top: 0.14, dirt: 0.8 });
        hairCap(ctx, { color: P.hair });
        hairTail(ctx, { name: 'hair', color: P.hair, root: [0, 0.035, -0.108], length: 0.46, strands: 3 });
        douli(ctx, { cord: [0.06, 0.04, 0.025] });
      },
    };
  }
  if (kind === 'swordmaster') {
    const coat = [0.022, 0.021, 0.024];
    return {
      skin: 'neck', hands: { L: 'fist', R: 'grip' },
      weapon: { type: 'miaodao', opts: { gripColor: [0.3, 0.03, 0.025], scabbardColor: [0.02, 0.016, 0.016] } },
      dress(ctx) {
        robe(ctx, { name: 'coat', sleeve: 'narrow', sleeveR: 0.065, collar: 'cross', color: coat, trim: P.crimson, trimW: 0.03, cuffTrimW: 0.03, lining: P.crimson, waistY: 1.03, cuff: -0.01, t: 0.026, blouse: 0.008 });
        innerLayer(ctx, { color: P.crimson, trim: [0.02, 0.02, 0.022] });
        const tr = trousers(ctx, { color: [0.03, 0.028, 0.03], y1: 0.36, bag: 0.6 });
        skirt(ctx, { under: tr.sdf,
          name: 'coatSkirt', y0: 1.045, hemY: 0.2, n: 24, rows: [1.045, 0.92, 0.76, 0.58, 0.39, 0.2], pins: [1, 0.55, 0.06, 0.02, 0.012, 0.01],
          slits: [{ angle: 0.001, top: 0.8 }, { angle: PI / 2, top: 0.9 }, { angle: PI, top: 0.84 }, { angle: -PI / 2, top: 0.9 }],
          color: coat, trim: P.crimson, trimW: 0.03, lining: [0.22, 0.02, 0.018], folds: { n: 16, amp: 0.014 }, dirt: 0.3, flare: 0.14,
        });
        sash(ctx, { name: 'sash', y0: 0.995, y1: 1.1, color: P.crimson, pattern: 'silk', knot: [-0.07, 0], tails: [0.75, 0.62], tailW: 0.075, cord: [0.3, 0.25, 0.12] });
        shoes(ctx, { color: [0.03, 0.025, 0.022], sole: [0.05, 0.04, 0.03], top: 0.42, boot: true, t: 0.013, mat: 'leather' });
        bracers(ctx, { color: [0.05, 0.04, 0.035] });
        hairCap(ctx, { color: P.hair, hairline: 'high', bun: [0.17, -0.02, 0.03] });
        topknot(ctx, { color: P.hair, cap: [0.03, 0.02, 0.02], pin: [0.36, 0.3, 0.17] });
        hairTail(ctx, { name: 'hair', color: P.hair, root: [0, 0.16, -0.075], dir: [0, -1, -0.35], length: 0.55, strands: 4, width: 0.014, bow: 0.05 });
        mask(ctx, { color: [0.03, 0.02, 0.02], pattern: [0.36, 0.02, 0.015] });
      },
    };
  }
  if (kind === 'bandit_heavy') {
    const trou = pick(BANDIT_DARK);
    return {
      skin: 'torso', hands: { L: 'fist', R: 'grip' },
      weapon: { type: 'dao_heavy', opts: { gripColor: [0.08, 0.05, 0.03] } },
      dress(ctx) {
        vest(ctx, { color: pick(LEATHER), fur: [0.1, 0.085, 0.065], furW: 0.04, t: 0.03, open: 0.11, y0: 1.0, mat: 'leather', dirt: 0.5 });
        sash(ctx, { name: 'belt', y0: 0.97, y1: 1.07, t: 0.045, color: [0.06, 0.045, 0.035], pattern: 'leather', knot: [0.0, 0], tails: [0.32, 0.28], tailW: 0.06, mat: 'leather', fringe: false });
        trousers(ctx, { color: trou, y1: 0.4, bag: 1.4, t: 0.03, dirt: 0.8, knee: true });
        legWraps(ctx, { color: pick(WRAP_LIGHT), y0: 0.1, y1: 0.45, ties: [0.06, 0.04, 0.03], dirt: 1 });
        shoes(ctx, { color: [0.08, 0.06, 0.04], sole: [0.05, 0.04, 0.03], top: 0.13, dirt: 1, mat: 'leather' });
        bracers(ctx, { color: pick(LEATHER) });
        headband(ctx, { color: [0.2, 0.04, 0.03], width: 0.035, tails: [0.22, 0.18] });
        beard(ctx, { color: [0.02, 0.016, 0.013] });
      },
    };
  }
  // new ranks reuse the bandit wardrobe (their authored model skins cover it) with their own arms
  // the night assassin (bamboo grove boss): lean, a straight jian; his Tripo skin covers the wardrobe
  if (kind === 'assassin') {
    const r = recipe('bandit', rng);
    r.weapon = { type: 'jian', opts: { tasselColor: [0.3, 0.02, 0.02] } };
    return r;
  }
  if (kind === 'spearman' || kind === 'archer' || kind === 'shieldman') {
    const r = recipe('bandit', rng);
    if (kind === 'spearman') r.weapon = { type: 'spear', opts: { gripColor: [0.2, 0.06, 0.03] } };
    if (kind === 'archer') { r.weapon = { type: 'dao', opts: { gripColor: [0.06, 0.04, 0.03], scabbard: true } }; r.offhand = 'bow'; r.hands = { L: 'fist', R: 'grip' }; }
    if (kind === 'shieldman') { r.weapon = { type: 'dao', opts: { gripColor: [0.08, 0.05, 0.03] } }; r.offhand = 'shield'; }
    return r;
  }
  // bandit variants
  const tunic = pick(BANDIT_CLOTH), dark = pick(BANDIT_DARK), wrapC = pick(WRAP_LIGHT), leather = pick(LEATHER);
  const sleeve = rng() < 0.45 ? 'rolled' : 'narrow';
  const head = rng();
  const hasVest = rng() < 0.45;
  rng();                                  // (was: 30% spears — spears now belong to the spearman, whose clips suit them)
  const spear = false;
  const hemY = 0.56 + rng() * 0.12;
  return {
    skin: sleeve === 'rolled' ? 'arms' : 'neck', hands: { L: 'fist', R: 'grip' },
    weapon: { type: spear ? 'spear' : 'dao', opts: { gripColor: pick([[0.2, 0.06, 0.03], [0.06, 0.04, 0.03], [0.12, 0.1, 0.07]]) } },
    dress(ctx) {
      robe(ctx, { name: 'tunic', sleeve, sleeveR: 0.058 + rng() * 0.01, collar: 'cross', color: tunic, trim: rng() < 0.5 ? dark : null, trimW: 0.03, lining: tunic.map(c => c * 0.8), waistY: 1.03, cuff: -0.04, t: 0.022, blouse: 0.01, dirt: 0.5, mottle: 0.09 });
      if (rng() < 0.5) innerLayer(ctx, { color: dark, trim: wrapC });
      const tr = trousers(ctx, { color: rng() < 0.5 ? dark : pick(BANDIT_CLOTH), y1: 0.4, bag: 1.1 + rng() * 0.4, dirt: 0.8, knee: rng() < 0.5 });
      skirt(ctx, { under: tr.sdf,
        name: 'tunicSkirt', y0: 1.045, hemY, n: 16, rows: [1.045, 0.92, 0.8, hemY + 0.08, hemY], pins: [1, 0.5, 0.1, 0.04, 0.03],
        slits: [{ angle: PI / 2 + 0.2, top: 0.92 }, { angle: -PI / 2 - 0.2, top: 0.92 }], color: tunic, trim: null, lining: tunic.map(c => c * 0.8),
        folds: { n: 11, amp: 0.012 }, dirt: 0.8, clear: [0.02, 0.03, 0.04], flare: 0.08, mottle: 0.09,
      });
      if (hasVest) vest(ctx, { color: leather, fur: rng() < 0.6 ? [0.12, 0.1, 0.075] : null, t: 0.036, open: 0.05 + rng() * 0.04, y0: 1.0, mat: 'leather' });
      sash(ctx, { name: 'belt', y0: 1.0, y1: 1.07, t: 0.04, color: rng() < 0.5 ? leather : dark, pattern: 'rope', knot: [rng() < 0.5 ? 0.08 : -0.08, 0], tails: rng() < 0.6 ? [0.3, 0.24] : [], tailW: 0.05, fringe: false });
      legWraps(ctx, { color: wrapC, y0: 0.1, y1: 0.45, ties: [0.06, 0.04, 0.03], dirt: 1 });
      shoes(ctx, { color: pick([[0.08, 0.06, 0.04], [0.05, 0.045, 0.04], [0.17, 0.14, 0.08]]), sole: [0.06, 0.05, 0.04], top: 0.13, dirt: 1 });
      if (sleeve === 'rolled' || rng() < 0.5) bracers(ctx, { color: leather });
      if (head < 0.45) headwrap(ctx, { color: pick(HEADCLOTH), tails: rng() < 0.7 ? [0.18 + rng() * 0.1, 0.15 + rng() * 0.1] : null });
      else if (head < 0.75) {
        hairCap(ctx, { color: P.hair, bun: [0.17, -0.03, 0.028] });
        topknot(ctx, { color: P.hair });
        headband(ctx, { color: pick(HEADCLOTH), width: 0.028, tails: [0.28, 0.24] });
      } else {
        hairCap(ctx, { color: P.hair });
        douli(ctx, { R: 0.23, h: 0.11, yRim: -0.05, torn: 0.9, color: [0.95, 0.88, 0.75], rim: [0.1, 0.07, 0.04], tilt: [0.08 * (rng() - 0.5), 0.12 * (rng() - 0.5)] });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// townsfolk (world/citizens.js): unarmed, muted dyes of a Jiangnan market town — indigo, ochre, grey, faded red,
// undyed hemp. Kinds: citizen_m (labourer / vendor / porter), citizen_s (书生 scholar: shares citizen_m's body build,
// so the worker's body cache serves both), citizen_f (襦裙 women), citizen_old (grey robe, beard), citizen_child
// (small). Variety within a kind comes from the seed; recipe.info names the variant (tools, review).
// weapon 'none': buildWeapon returns no parts (the weapon frame bone still exists, nothing rides it).
// ---------------------------------------------------------------------------------------------------------------
const CIT = {
  indigo: [0.028, 0.038, 0.075], indigoFade: [0.058, 0.074, 0.11], ochre: [0.16, 0.095, 0.035], grey: [0.075, 0.075, 0.072],
  red: [0.15, 0.036, 0.026], hemp: [0.17, 0.148, 0.105], brown: [0.068, 0.046, 0.032], teal: [0.034, 0.064, 0.06],
  moon: [0.2, 0.21, 0.22], dark: [0.024, 0.023, 0.027], plum: [0.08, 0.036, 0.046], rust: [0.12, 0.055, 0.03],
  sand: [0.18, 0.14, 0.085], ash: [0.125, 0.125, 0.118],
};
const sc3 = (c, k) => c.map((x) => x * k);
const HAIR_GREY = [0.2, 0.19, 0.18];

function citizenRecipe(kind, rng) {
  const pick = (a) => a[Math.floor(rng() * a.length) % a.length];
  const unarmed = { weapon: { type: 'none', opts: {} }, hands: { L: 'relaxed', R: 'relaxed' } };
  const PI2 = Math.PI / 2;
  // a short hemp apron tied at the waist (one wide cloth strip on a chain)
  const apron = (ctx, knot, color) => ribbon(ctx, {
    name: 'apron', parent: 'hips', start: knot.clone().add(V(-0.085 * ctx.s, 0.01 * ctx.s, 0.02 * ctx.s)).setX(0), dir: V(0, -1, 0.14).normalize(),
    length: 0.5 * ctx.s, n: 5, width: 0.36 * ctx.s, side: V(1, 0, 0), color, color2: sc3(color, 0.75), mask: COL.LEGS | COL.PELVIS,
    radius: 0.03, drag: 2.4, flutter: 0.5, fringe: false, taper: -0.1, stiff: 0.35,
  });
  const shortJacket = (ctx, o) => {
    robe(ctx, { name: 'jacket', sleeve: o.sleeve, sleeveR: 0.058 + rng() * 0.008, collar: 'cross', color: o.color, trim: o.trim, trimW: 0.03,
      cuffTrimW: 0.024, lining: sc3(o.color, 0.8), waistY: 1.03, cuff: -0.04, t: 0.02, blouse: 0.008, dirt: o.dirt ?? 0.3, mottle: 0.08 });
    const tr = trousers(ctx, { color: o.trou, y1: o.trouY1 ?? 0.13, bag: 1.1 + rng() * 0.3, dirt: 0.5, knee: rng() < 0.4 });
    const hemY = o.hemY ?? 0.7;
    skirt(ctx, { under: tr.sdf,
      name: 'jacketSkirt', y0: 1.045, hemY, n: 12, rows: [1.045, 0.93, hemY + 0.09, hemY], pins: [1, 0.55, 0.1, 0.05], drag: 0.6, flutter: 0.3,
      slits: [{ angle: PI2 + 0.25, top: 0.95 }, { angle: -PI2 - 0.25, top: 0.95 }], color: o.color, trim: o.trim, trimW: 0.026, lining: sc3(o.color, 0.8),
      folds: { n: 10, amp: 0.01 }, dirt: 0.5, clear: [0.02, 0.03, 0.04], flare: 0.07, mottle: 0.08,
    });
    return tr;
  };

  if (kind === 'citizen_m') {
    // labourer / vendor / porter: 短褐 jacket, trousers (rolled up over leg wraps or straw sandals), rope belt
    const role = pick(['labourer', 'vendor', 'porter']);
    const jacket = pick([CIT.hemp, CIT.indigoFade, CIT.brown, CIT.ochre, CIT.grey, CIT.teal]);
    const trou = pick([CIT.dark, CIT.indigo, CIT.brown, CIT.grey]);
    const sleeve = role === 'porter' || rng() < 0.3 ? 'rolled' : 'narrow';
    const head = role === 'porter' ? 'straw' : role === 'vendor' ? pick(['wrap', 'cap']) : pick(['straw', 'wrap', 'knot']);
    const wraps = role === 'porter' || rng() < 0.4;
    const wrapC = pick([CIT.indigo, CIT.hemp, CIT.ash, CIT.dark]);
    return {
      ...unarmed, skin: sleeve === 'rolled' ? 'arms' : 'neck', info: `${role} ${sleeve} ${head}`,
      dress(ctx) {
        shortJacket(ctx, { sleeve, color: jacket, trim: rng() < 0.5 ? sc3(jacket, 0.55) : null, trou, trouY1: wraps ? 0.4 : 0.13, hemY: 0.66 + rng() * 0.08 });
        const belt = sash(ctx, { name: 'belt', y0: 1.0, y1: 1.07, t: 0.036, color: pick([CIT.dark, CIT.brown, CIT.indigo]), pattern: 'rope', knot: [rng() < 0.5 ? 0.07 : -0.07, 0], tails: rng() < 0.5 ? [0.22, 0.18] : [], tailW: 0.045, fringe: false });
        if (role === 'vendor') apron(ctx, belt.knot, pick([CIT.hemp, CIT.ash, CIT.sand]));
        if (wraps) legWraps(ctx, { color: pick([CIT.hemp, CIT.ash]), y0: 0.1, y1: 0.44, dirt: 0.8 });
        shoes(ctx, { color: role === 'porter' ? CIT.sand : pick([CIT.dark, CIT.brown]), sole: [0.06, 0.05, 0.04], top: 0.11, dirt: 0.8 });
        if (head === 'straw') {
          hairCap(ctx, { color: P0.hair, bun: [0.17, -0.03, 0.026] });
          douli(ctx, { R: 0.25 + rng() * 0.04, h: 0.11, yRim: -0.05, color: [0.95, 0.86, 0.66], rim: [0.14, 0.1, 0.05], cord: [0.1, 0.08, 0.05], tilt: [0.1 * (rng() - 0.5), 0.1 * (rng() - 0.5)] });
        } else if (head === 'wrap') headwrap(ctx, { color: wrapC, tails: rng() < 0.4 ? [0.14, 0.12] : null });
        else if (head === 'cap') { hairCap(ctx, { color: P0.hair, bun: [0.17, -0.03, 0.028] }); topknot(ctx, { color: P0.hair, cap: wrapC, capMat: 'cloth' }); }
        else { hairCap(ctx, { color: P0.hair, bun: [0.17, -0.03, 0.028] }); topknot(ctx, { color: P0.hair }); headband(ctx, { color: wrapC, width: 0.026 }); }
      },
    };
  }
  if (kind === 'citizen_child') {
    const jacket = pick([CIT.red, CIT.ochre, CIT.indigoFade, CIT.teal]);
    return {
      ...unarmed, skin: 'neck',
      dress(ctx) {
        shortJacket(ctx, { sleeve: 'narrow', color: jacket, trim: sc3(jacket, 0.5), trou: pick([CIT.indigo, CIT.dark, CIT.brown]), trouY1: 0.13, hemY: 0.72, dirt: 0.2 });
        sash(ctx, { name: 'belt', y0: 1.0, y1: 1.07, t: 0.034, color: pick([CIT.red, CIT.indigo, CIT.dark]), pattern: 'rope', knot: [0.06, 0], tails: [0.2, 0.16], tailW: 0.04, fringe: false });
        shoes(ctx, { color: CIT.dark, sole: [0.3, 0.28, 0.24], top: 0.1, dirt: 0.5 });
        // 总角: two little buns (one on the crown, a tuft behind)
        hairCap(ctx, { color: P0.hair, bun: [0.16, 0.0, 0.034] });
        topknot(ctx, { color: P0.hair, cap: pick([CIT.red, CIT.indigo]), capMat: 'cloth' });
      },
    };
  }
  if (kind === 'citizen_f') {
    // 襦裙: a short cross-collar top, a long high-waisted skirt, a silk sash with tails, hair in a low bun
    const top = pick([CIT.indigoFade, CIT.ochre, CIT.red, CIT.moon, CIT.teal, CIT.plum, CIT.sand]);
    let skirtC = pick([CIT.indigo, CIT.grey, CIT.rust, CIT.dark, CIT.indigoFade, CIT.ash]);
    if (skirtC === top) skirtC = CIT.indigo;
    const sashC = pick([CIT.red, CIT.indigo, CIT.ochre, CIT.plum, CIT.moon]);
    const scarf = rng() < 0.3;
    return {
      ...unarmed, skin: 'neck', info: `f ${scarf ? 'scarf' : 'bun'}`,
      dress(ctx) {
        robe(ctx, { name: 'top', sleeve: 'narrow', sleeveR: 0.06, collar: 'cross', color: top, trim: sc3(sashC, 0.9), trimW: 0.03, cuffTrimW: 0.03,
          lining: sc3(top, 0.8), waistY: 1.06, blouseY: 1.13, cuff: -0.02, t: 0.018, blouse: 0.008, mottle: 0.05 });
        innerLayer(ctx, { color: pick([CIT.moon, CIT.sand, CIT.ash]), trim: sc3(top, 0.7) });
        const tr = trousers(ctx, { color: CIT.dark, y1: 0.3, bag: 0.9, t: 0.02 });
        skirt(ctx, { under: tr.sdf,
          name: 'skirt', y0: 1.07, hemY: 0.09, n: 16, rows: [1.07, 0.86, 0.6, 0.34, 0.09], pins: [1, 0.75, 0.35, 0.18, 0.1],
          drag: 0.3, flutter: 0.15, stiff: 0.55,         // a long skirt is heavy: the wind sways it, never lifts it
          slits: [{ angle: Math.PI, top: 0.3 }], color: skirtC, trim: null, lining: sc3(skirtC, 0.8),
          folds: { n: 18, amp: 0.013 }, dirt: 0.25, clear: [0.02, 0.035, 0.07], flare: 0.12, mottle: 0.05,
        });
        sash(ctx, { name: 'sash', y0: 1.02, y1: 1.1, t: 0.032, color: sashC, pattern: 'silk', knot: [0.0, 0], tails: [0.5, 0.44], tailW: 0.045, fringe: false });
        shoes(ctx, { color: pick([CIT.red, CIT.dark, CIT.indigo]), sole: [0.3, 0.28, 0.24], top: 0.09, dirt: 0.3 });
        if (scarf) headwrap(ctx, { color: pick([CIT.indigo, CIT.moon, CIT.sand]), tails: [0.2, 0.18] });
        else {
          hairCap(ctx, { color: P0.hair, bun: [0.12, -0.11, 0.05] });
          topknot(ctx, { color: P0.hair, pin: rng() < 0.6 ? [0.42, 0.34, 0.16] : [0.3, 0.29, 0.27] });
        }
      },
    };
  }
  if (kind === 'citizen_s' || kind === 'citizen_old') {
    const old = kind === 'citizen_old';
    const robeC = old ? pick([CIT.grey, CIT.brown, CIT.ash, CIT.indigoFade]) : pick([CIT.moon, CIT.indigoFade, CIT.ash, CIT.teal]);
    const hair = old ? HAIR_GREY : P0.hair;
    return {
      ...unarmed, skin: 'neck',
      dress(ctx) {
        robe(ctx, { name: 'robe', sleeve: old ? 'narrow' : 'wide', sleeveR: 0.068, collar: 'cross', color: robeC, trim: old ? sc3(robeC, 0.6) : CIT.dark, trimW: 0.04, cuffTrimW: 0.035,
          lining: sc3(robeC, 0.85), waistY: 1.03, cuff: old ? -0.03 : 0.02, t: 0.02, drape: 0.05, blouse: 0.012, mottle: 0.05 });
        innerLayer(ctx, { color: old ? CIT.hemp : CIT.moon, trim: CIT.dark });
        const tr = trousers(ctx, { color: CIT.dark, y1: 0.36, bag: 1 });
        skirt(ctx, { under: tr.sdf,
          name: 'robeSkirt', y0: 1.045, hemY: 0.15, n: 14, rows: [1.045, 0.86, 0.6, 0.36, 0.15], pins: [1, 0.7, 0.3, 0.15, 0.08],
          drag: 0.35, flutter: 0.2, stiff: 0.5,
          slits: [{ angle: PI2, top: 0.62 }, { angle: -PI2, top: 0.62 }], color: robeC, trim: old ? null : CIT.dark, trimW: 0.04, lining: sc3(robeC, 0.85),
          folds: { n: 14, amp: 0.014 }, dirt: 0.3, clear: [0.02, 0.032, 0.05], flare: 0.1, mottle: 0.05,
        });
        sash(ctx, { name: 'sash', y0: 1.0, y1: 1.08, t: 0.03, color: old ? CIT.dark : pick([CIT.dark, CIT.indigo]), pattern: 'silk', knot: [0.07, 0], tails: [0.42, 0.36], tailW: 0.035, fringe: false });
        shoes(ctx, { color: CIT.dark, sole: [0.34, 0.32, 0.28], top: 0.13, dirt: 0.3 });
        hairCap(ctx, { color: hair, hairline: old ? 'high' : 'natural', bun: [0.17, -0.02, 0.03] });
        topknot(ctx, { color: hair, cap: old ? null : CIT.dark, capMat: 'cloth', pin: old ? [0.3, 0.25, 0.18] : null });
        if (old) beard(ctx, { color: [0.24, 0.23, 0.21] });
      },
    };
  }
  return citizenRecipe('citizen_m', rng);
}
const P0 = PALETTE;
