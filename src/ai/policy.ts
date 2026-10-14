// Heuristic player AI. One policy drives both seats; deck "style" (aggro / midrange / control,
// inferred from the list) nudges a few decisions such as trading, racing and holding counter mana.
import type { Ability, CardDef, Color, Effect, Pip } from '../cards/model.js';
import { COLORS, cantBeCountered } from '../cards/model.js';
import type { Ctx, Game, StackItem, Target } from '../engine/game.js';
import { matches, FilterCtx } from '../engine/filters.js';
import { parseManaCost } from '../cards/compile.js';
import type { CardInst, Perm, Player } from '../engine/state.js';

// ------------------------------------------------------------------ steering hints
// Set just before a cast/activation so that target selection inside the engine aims where we planned.
const hint: { perm?: Perm; spell?: StackItem; charm?: string } = {};
function withHint<T>(h: typeof hint, fn: () => T): T {
  const old = { ...hint };
  Object.assign(hint, h);
  try { return fn(); } finally { hint.perm = old.perm; hint.spell = old.spell; hint.charm = old.charm; }
}

// ------------------------------------------------------------------ small helpers
const isCreature = (x: { def: CardDef }) => x.def.types.includes('Creature');
const isLandCard = (c: { def: CardDef }) => c.def.types.includes('Land');
const myCreatures = (g: Game, pid: number) => g.bf.filter(x => x.controller === pid && isCreature(x));
const landsOnBf = (g: Game, pid: number) => g.bf.filter(x => x.controller === pid && isLandCard(x)).length;
const isInstantSpeed = (d: CardDef) => d.types.includes('Instant') || d.keywords.includes('Flash');
const negative = (v: string | undefined) => !!v && v.trim().startsWith('-');

const KW_VALUE: Record<string, number> = {
  Flying: 1.5, Deathtouch: 1.5, Lifelink: 1, 'First Strike': 1, 'Double Strike': 2.5, Trample: 0.5, Hexproof: 1,
  Indestructible: 2, Vigilance: 0.3, Menace: 0.7, Haste: 0.2, Ward: 0.8, Reach: 0.3, Prowess: 0.5,
};

/** How much a permanent on the battlefield is worth to its controller. */
export function permValue(g: Game, perm: Perm): number {
  const d = perm.def;
  let v: number;
  if (isCreature(perm)) {
    const st = g.statsOf(perm);
    v = Math.max(0, st.power) * 1.5 + Math.max(0, st.toughness) * 0.8;
    for (const k of st.keywords) v += KW_VALUE[k] ?? 0;
    v += (d.triggers.length + d.statics.length + d.abilities.filter(a => a.kind !== 'mana').length) * 0.7;
    if (perm.token) v -= 0.5;
  } else if (d.types.includes('Planeswalker')) {
    v = (perm.counters.LOYALTY ?? 0) + d.mv + 2;
  } else if (isLandCard(perm)) {
    v = 1;
  } else {
    v = d.mv + 1 + (d.statics.length + d.triggers.length) * 0.5;
    if (perm.token) v = Math.min(v, 1.5);
  }
  if (perm.isCommander) v += 3;
  if (perm.counters.SACATEND) return 0.2;          // leaves at end of turn anyway
  for (const a of g.bf) if (a.attachedTo === perm.id) v += Math.max(1, a.def.mv) * 0.7;
  return Math.max(0.3, v);
}

/** How much a card in hand (or in a search) is worth to `p` right now. */
export function cardValue(g: Game, p: Player, card: CardInst): number {
  const d = card.def;
  const lands = landsOnBf(g, p.id);
  if (isLandCard(card)) {
    const total = lands + p.hand.filter(isLandCard).length;
    return total < 4 ? 6 : total < 6 ? 3 : 0.5;
  }
  let v: number;
  if (d.types.includes('Creature')) {
    v = (d.power ?? 0) * 1.5 + (d.toughness ?? 0) * 0.8 + 1;
    for (const k of d.keywords) v += KW_VALUE[k.split(':')[0]] ?? 0;
    v += (d.triggers.length + d.abilities.filter(a => a.kind !== 'mana').length) * 0.7;
  } else if (d.spell) {
    const e = d.spell.effect;
    if (e.api === 'Counter') v = 4;
    else if (isHarmful(e) || e.api === 'DestroyAll' || e.api === 'DamageAll') v = 4.5;
    else if (['Draw', 'Dig'].includes(e.api)) v = 3;
    else v = d.mv + 1;
  } else v = d.mv + 1.5;
  if (card.isCommander) v += 3;
  if (d.mv > lands + 2) v -= 1.2 * (d.mv - lands - 2);
  return v;
}

export function isHarmful(eff: Effect): boolean {
  const P = eff.params;
  if (P.IsCurse === 'True' || P.AILogic === 'Curse') return true;
  switch (eff.api) {
    case 'DealDamage': case 'Destroy': case 'Tap': case 'Counter': case 'Discard': case 'LoseLife': case 'Mill': case 'Fight':
      return true;
    case 'Sacrifice': return P.Defined !== 'Self' && P.Defined !== undefined && P.Defined !== 'You';
    case 'ChangeZone': {
      const o = P.Origin ?? 'Battlefield';
      if (o.includes('Battlefield')) return P.Destination !== 'Battlefield';
      return o.includes('Graveyard') && P.Destination === 'Exile';
    }
    case 'Pump': return negative(P.NumAtt) || negative(P.NumDef);
    case 'PutCounter': return P.CounterType === 'M1M1';
  }
  return false;
}

function fctxOf(ctx: Ctx): FilterCtx {
  return { you: ctx.p, sourceId: ctx.source?.id, sourceAttachedTo: ctx.source?.attachedTo, chosenType: ctx.source?.chosenType };
}

// ------------------------------------------------------------------ combat math
interface Duel { blockerKills: boolean; blockerDies: boolean }
/** Outcome of attacker `a` being blocked by `b` alone. Extra stats let us test combat tricks. */
function duel(g: Game, a: Perm, b: Perm, extraA = { p: 0, t: 0, kw: [] as string[] }, extraB = { p: 0, t: 0, kw: [] as string[] }): Duel {
  const sa = g.statsOf(a), sb = g.statsOf(b);
  const ka = [...sa.keywords, ...extraA.kw], kb = [...sb.keywords, ...extraB.kw];
  const ap = sa.power + extraA.p, at = sa.toughness + extraA.t - a.damage;
  const bp = sb.power + extraB.p, bt = sb.toughness + extraB.t - b.damage;
  const aFS = ka.includes('First Strike') || ka.includes('Double Strike');
  const bFS = kb.includes('First Strike') || kb.includes('Double Strike');
  let aKills = ap > 0 && (ap >= bt || ka.includes('Deathtouch')) && !kb.includes('Indestructible');
  let bKills = bp > 0 && (bp >= at || kb.includes('Deathtouch')) && !ka.includes('Indestructible');
  if (ka.includes('Double Strike') && !aKills && ap * 2 >= bt && !kb.includes('Indestructible')) aKills = true;
  if (aFS && !bFS && aKills) bKills = false;
  if (bFS && !aFS && bKills) aKills = false;
  return { blockerKills: bKills, blockerDies: aKills };
}

function canBlock(g: Game, b: Perm, a: Perm): boolean {
  if (!isCreature(b) || b.tapped || g.cantBlock(b) || g.unblockable(a)) return false;
  const ka = g.statsOf(a).keywords, kb = g.statsOf(b).keywords;
  if (ka.includes('Flying') && !kb.includes('Flying') && !kb.includes('Reach')) return false;
  return true;
}

// ------------------------------------------------------------------ mulligans
export function keepHand(g: Game, p: Player, handSize: number): boolean {
  const lands = p.hand.filter(c => isLandCard(c) || c.def.modalBack?.land).length;   // MDFC land backs count
  if (handSize >= 7) return lands >= 2 && lands <= 5;
  if (handSize === 6) return lands >= 1 && lands <= 5;
  void g;
  return true;
}

export function chooseBottom(g: Game, p: Player): CardInst {
  const lands = p.hand.filter(isLandCard);
  if (lands.length > 3) return lands.find(l => l.def.land?.entersTapped === 'always') ?? lands[0];
  const spells = p.hand.filter(c => !isLandCard(c));
  if (!spells.length) return p.hand[0];
  return spells.reduce((a, b) => (cardValue(g, p, a) <= cardValue(g, p, b) ? a : b));
}

// ------------------------------------------------------------------ colors & lands
export function neededColor(g: Game, p: Player): Color {
  const have = new Set<Color>();
  for (const x of g.bf) if (x.controller === p.id && x.def.land) {
    if (x.chosenType) continue;
    if (x.def.land.produces.length < 5) x.def.land.produces.forEach(c => have.add(c));
  }
  const want: Record<string, number> = {};
  const tally = (cards: CardInst[], w: number) => {
    for (const c of cards) if (!isLandCard(c)) for (const pip of c.def.cost.pips) for (const o of pip.options) want[o] = (want[o] ?? 0) + w / pip.options.length;
  };
  tally(p.hand, 3); tally(p.command, 3); tally(p.library, 0.2);
  const ranked = COLORS.filter(c => want[c]).sort((a, b) => (want[b] - (have.has(b) ? want[b] * 0.8 : 0)) - (want[a] - (have.has(a) ? want[a] * 0.8 : 0)));
  return ranked[0] ?? p.identity[0] ?? 'W';
}

function landProduces(g: Game, p: Player, c: CardInst): Color[] {
  if (/choose a basic land type/i.test(c.def.oracle)) return [neededColor(g, p)];
  return c.def.land?.produces ?? [];
}

function wouldEnterTapped(g: Game, p: Player, c: CardInst): boolean {
  switch (c.def.land?.entersTapped) {
    case 'always': return true;
    case 'unlessTwoOthers': return landsOnBf(g, p.id) < 2;
    case 'unlessLowLife': return !g.players.some(pl => pl.life <= 13);
    case 'unlessPayLife': return p.life <= 4;
  }
  return false;
}

function playBestLand(g: Game, p: Player) {
  if (p.landsPlayed > 0) return;
  // lands we may play from exile (impulse draw) run out, so they are worth playing first
  const fromExile = (p.mayPlay ?? []).map(m => m.card).filter(c => c.def.land && g.inExile(c));
  const n = landsOnBf(g, p.id);
  // Each option is a card plus the face it would enter as. Modal double-faced cards offer their land back:
  // pathways always (pick the color), spell-front cards only when we have no real land and need the drop.
  type Option = { card: CardInst; face: CardDef; spell: boolean };
  const options: Option[] = [...p.hand.filter(c => c.def.land), ...fromExile].map(c => ({ card: c, face: c.def, spell: false }));
  const realLands = options.length;
  for (const c of p.hand) {
    const back = c.def.modalBack;
    if (!back?.land) continue;
    if (c.def.land) options.push({ card: c, face: back, spell: false });                        // pathway: other color
    else if (!realLands && (n < 4 || c.def.mv > n + 1)) options.push({ card: c, face: back, spell: true });
  }
  if (!options.length) return;
  const need = neededColor(g, p);
  // do we have something that needs every mana next turn's worth? i.e. a spell costing exactly n+1
  const curveNow = [...p.hand, ...p.command].some(c => !isLandCard(c) && !isInstantSpeed(c.def) && c.def.mv + (c.isCommander ? p.commanderTax : 0) === n + 1);
  let best = options[0], bestS = -Infinity;
  for (const o of options) {
    const l = o.face === o.card.def ? o.card : { ...o.card, def: o.face };
    const cols = landProduces(g, p, l);
    let s = cols.includes(need) ? 3 : 0;
    s += cols.length * 0.4;
    if (l.def.land?.fetchBasic) s += 1;
    const tapped = wouldEnterTapped(g, p, l);
    if (tapped) s += curveNow ? -4 : 1;
    if (l.def.land?.entersTapped === 'unlessPayLife' && !curveNow) s += 0.5;   // will enter tapped for free
    if (fromExile.includes(o.card)) s += 2;
    if (o.spell) s -= 1.5;                              // giving up the spell side costs something
    if (s > bestS) { bestS = s; best = o; }
  }
  g.playLand(p, best.card, curveNow, best.face === best.card.def ? undefined : best.face);
}

// ------------------------------------------------------------------ targeting
interface Scored { t: Target; s: number }

/** Scores every legal target for an effect, best first. */
export function scoreTargets(g: Game, eff: Effect, ctx: Ctx): Scored[] {
  const P = eff.params;
  const def = ctx.source?.def ?? ctx.card?.def;
  const fctx = fctxOf(ctx);
  const filter = P.ValidTgts ?? 'Card';
  const tt = P.TargetType ?? '';
  const out: Scored[] = [];
  const me = ctx.p, them = g.opp(ctx.p);

  // spells on the stack
  if (tt.includes('Spell') || eff.api === 'Counter') {
    for (const it of [...g.stack].reverse()) {
      if (it.controller === me || it === ctx.spell) continue;
      if (!matches(filter, g.subjectOf(it.card, it.controller), fctx)) continue;
      out.push({ t: { kind: 'spell', item: it }, s: it === hint.spell ? 100 : 5 });
    }
    return out.sort((a, b) => b.s - a.s);
  }

  // graveyard cards
  const origin = P.Origin ?? '';
  if (P.TgtZone === 'Graveyard' || (eff.api === 'ChangeZone' && origin.includes('Graveyard'))) {
    const toMe = P.Destination === 'Battlefield' || P.Destination === 'Hand';
    for (const pl of g.players) for (const c of pl.graveyard) {
      if (!matches(filter, g.subjectOf(c, c.owner), fctx)) continue;
      const v = cardValue(g, g.players[me], c);
      out.push({ t: { kind: 'card', card: c, zone: 'graveyard' }, s: toMe ? (c.owner === me ? v : -1) : (c.owner === them ? v * 0.3 : -1) });
    }
    return out.sort((a, b) => b.s - a.s);
  }

  const harmful = isHarmful(eff);
  const n = eff.api === 'DealDamage' ? g.amount(P.NumDmg, ctx, def) : 0;
  const srcDT = !!ctx.source && g.bf.includes(ctx.source) && g.has(ctx.source, 'Deathtouch');
  const style = g.players[me].style;

  for (const perm of g.bf) {
    if (!matches(filter, g.subjectOf(perm), fctx)) continue;
    const kws = g.statsOf(perm).keywords;
    if (kws.includes('Shroud')) continue;
    if (perm.controller !== me && kws.includes('Hexproof')) continue;
    const v = permValue(g, perm);
    let s: number;
    if (harmful) {
      if (perm.controller === me) s = -v - 2;
      else {
        s = v;
        const st = g.statsOf(perm);
        switch (eff.api) {
          case 'DealDamage':
            if (perm.def.types.includes('Planeswalker') && !isCreature(perm)) s = (perm.counters.LOYALTY ?? 0) <= n ? v : v * 0.4;
            else if (isCreature(perm)) s = (st.toughness - perm.damage <= n || srcDT) && !(/prevent that damage/i.test(perm.def.oracle)) ? v + 1 : 0.1;
            else s = 0;
            break;
          case 'Destroy': if (kws.includes('Indestructible')) s = 0; break;
          case 'Pump': {
            const d = g.amount(P.NumDef, ctx, def);
            s = st.toughness - perm.damage + d <= 0 ? v + 1 : v * 0.25;
            break;
          }
          case 'PutCounter': s = st.toughness - (g.amount(P.CounterNum ?? '1', ctx, def)) <= 0 ? v + 1 : v * 0.3; break;
          case 'Tap': s = perm.tapped || !isCreature(perm) ? 0 : v * 0.3; break;
          case 'Fight': {
            const mine = fighter(g, ctx);
            if (!mine) { s = 0; break; }
            const r = duel(g, mine, perm);   // fight ~ mutual damage, ignoring first strike
            const mp = g.statsOf(mine).power;
            const kills = mp >= st.toughness - perm.damage || g.has(mine, 'Deathtouch');
            s = kills ? v + 1 - (r.blockerKills ? permValue(g, mine) * 0.7 : 0) : 0;
            break;
          }
          case 'ChangeZone':
            if (P.Destination === 'Hand') s = perm.token ? v + 1 : v * 0.5;
            if (isLandCard(perm)) s = 0.2;
            break;
        }
        if (hint.perm === perm && s > 0) s += 50;
      }
    } else {
      // beneficial
      if (perm.controller !== me) s = -v;
      else {
        s = v;
        if (eff.api === 'Attach') {
          if (!isCreature(perm) || perm.id === ctx.source?.id) s = -1;
          else if (g.bf.some(a => a.attachedTo === perm.id && a.def.subtypes.includes('Equipment'))) s -= 2;
          if (perm.def.keywords.includes('Defender')) s -= 3;
        }
        if (eff.api === 'Untap' && !perm.tapped) s = 0.1;
        // "put a trample counter on it; it becomes a Bear": better on a creature that doesn't have those already
        if (eff.api === 'PutCounter' && P.CounterType && g.has(perm, P.CounterType)) s *= 0.5;
        const anim = eff.sub?.api === 'Animate' && /Targeted/.test(eff.sub.params.Defined ?? '') ? eff.sub.params.Types : undefined;
        if (anim && anim.split(',').every(t => perm.def.subtypes.includes(t.trim()) || perm.def.types.includes(t.trim()))) s *= 0.4;
        if (hint.perm === perm) s += 50;
      }
    }
    out.push({ t: { kind: 'perm', perm }, s });
  }

  for (const pl of g.players) {
    if (!matches(filter, g.playerSubject(pl.id), fctx)) continue;
    let s: number;
    if (harmful) {
      if (pl.id === me) s = -100;
      else if (eff.api === 'DealDamage' || eff.api === 'LoseLife') {
        const amt = eff.api === 'DealDamage' ? n : g.amount(P.LifeAmount, ctx, def);
        s = amt >= pl.life ? 1000 : amt * (style === 'aggro' ? 1.2 : 0.5);
      } else if (eff.api === 'Discard') s = pl.hand.length ? 2.5 : 0.2;
      else s = 1;
    } else s = pl.id === me ? 3 : -3;
    out.push({ t: { kind: 'player', pid: pl.id }, s });
  }
  return out.sort((a, b) => b.s - a.s);
}

function fighter(g: Game, ctx: Ctx): Perm | undefined {
  const parent = ctx.targets.find(t => t.kind === 'perm' && t.perm.controller === ctx.p) as { perm: Perm } | undefined;
  if (parent) return parent.perm;
  if (ctx.source && g.bf.includes(ctx.source) && isCreature(ctx.source)) return ctx.source;
  const mine = myCreatures(g, ctx.p);
  return mine.sort((a, b) => g.statsOf(b).power - g.statsOf(a).power)[0];
}

export function chooseTargets(g: Game, eff: Effect, ctx: Ctx): Target[] {
  const P = eff.params;
  const def = ctx.source?.def ?? ctx.card?.def;
  const max = P.TargetMax ? Math.max(1, g.amount(P.TargetMax, ctx, def)) : 1;
  const min = P.TargetMin !== undefined ? g.amount(P.TargetMin, ctx, def) : 1;
  const sc = scoreTargets(g, eff, ctx);
  const picks = sc.filter(x => x.s > 0.05).slice(0, max);
  // mandatory targets: take the least-bad remaining options
  for (const x of sc) { if (picks.length >= min) break; if (!picks.includes(x)) picks.push(x); }
  return picks.map(x => x.t);
}

export function chooseCharm(g: Game, eff: Effect, ctx: Ctx): Effect[] {
  const choices = [...(eff.choices ?? [])];
  const scored = choices.map(c => ({ c, s: (hint.charm && c.api === hint.charm ? 100 : 0) + effectScore(g, c, ctx) }));
  return scored.sort((a, b) => b.s - a.s).map(x => x.c);
}

/** Spree: pick the best modes whose extra costs we can pay on top of the base cost. */
export function chooseSpreeModes(g: Game, pid: number, card: CardInst, generic: number, pips: Pip[]): Effect[] {
  const ctx: Ctx = { p: pid, card, x: 0, kicked: false, targets: [] };
  const eff = card.def.spell!.effect;
  const scored = (eff.choices ?? []).map(c => ({ c, s: effectScore(g, c, ctx) })).filter(x => x.s > 0.5).sort((a, b) => b.s - a.s);
  const chosen: Effect[] = [];
  let gen = generic, ps = [...pips];
  for (const { c } of scored) {
    const mc = parseManaCost(c.params.ModeCost);
    if (!g.payMana(pid, gen + mc.generic, [...ps, ...mc.pips], false)) continue;
    chosen.push(c); gen += mc.generic; ps = [...ps, ...mc.pips];
  }
  return chosen;
}

/** Promise the gift unless it's something big (an extra turn, a Rhystic Study). */
export function promiseGift(g: Game, pid: number, card: CardInst): boolean {
  void g; void pid;
  const desc = card.def.svars.GiftAbility?.match(/GiftDescription\$ ([^|]+)/)?.[1]?.trim() ?? '';
  return !/extra turn|Rhystic/i.test(desc);
}

export function optionalYes(g: Game, eff: Effect, ctx: Ctx): boolean {
  const P = eff.params;
  if (eff.api === 'Sacrifice' && (!P.Defined || P.Defined === 'You' || P.Defined === 'Self')) return false;
  if (eff.api === 'Discard' && !P.ValidTgts && (!P.Defined || P.Defined === 'You')) return g.players[ctx.p].hand.length > 3;
  if (eff.api === 'LoseLife' && (!P.Defined || P.Defined === 'You')) return g.players[ctx.p].life > 10;
  if (P.ValidTgts) return (scoreTargets(g, eff, ctx)[0]?.s ?? 0) > 0.05;
  return true;
}

// ------------------------------------------------------------------ evaluating effects
/** Rough value of resolving an effect now; <= 0 means "don't bother". */
export function effectScore(g: Game, eff: Effect, ctx: Ctx, depth = 0): number {
  if (depth > 6) return 0;
  const P = eff.params;
  const def = ctx.source?.def ?? ctx.card?.def;
  const me = ctx.p, them = g.opp(me);
  const fctx = fctxOf(ctx);
  const needs = P.ValidTgts !== undefined || P.TargetType !== undefined;
  let s = 0;
  if (eff.api === 'Counter') return 0;
  if (eff.api === 'Charm') return Math.max(0, ...(eff.choices ?? []).map(c => effectScore(g, c, ctx, depth + 1)));
  if (needs) {
    const sc = scoreTargets(g, eff, ctx);
    const best = sc[0]?.s ?? 0;
    if (best <= 0.5) s = isHarmful(eff) || ['Pump', 'PutCounter', 'Attach', 'Fight'].includes(eff.api) ? -1 : 0;
    else s = Math.min(best, 60);
    if (eff.api === 'Pump' && !isHarmful(eff) && g.phase !== 'combat' && !P.KW?.includes('Hexproof')) s = -1;   // hold tricks for combat
  } else {
    switch (eff.api) {
      case 'Draw': s = 3 * Math.max(1, g.amount(P.NumCards ?? '1', ctx, def)); if (P.Defined === 'Opponent') s = -s; break;
      case 'Dig': s = 2.5; break;
      case 'Scry': case 'Surveil': s = 0.8; break;
      case 'Explore': case 'Investigate': case 'Connive': s = 2; break;
      case 'Token': s = 2.5 * Math.max(1, g.amount(P.TokenAmount ?? '1', ctx, def)); break;
      case 'Amass': case 'Earthbend': s = 1 + g.amount(P.Num ?? '1', ctx, def); break;
      case 'GainLife': s = g.players[me].life < 10 ? 2 : 0.6; break;
      case 'PumpAll': s = g.phase === 'combat' ? 3 : 0.3; break;
      case 'PutCounterAll': s = 1.5 * g.bf.filter(x => matches(P.ValidCards ?? 'Creature.YouCtrl', g.subjectOf(x), fctx)).length; break;
      case 'DestroyAll': case 'DamageAll': {
        const n = eff.api === 'DamageAll' ? g.amount(P.NumDmg, ctx, def) : 99;
        for (const x of g.bf) {
          if (!P.ValidCards || !matches(P.ValidCards, g.subjectOf(x), fctx)) continue;
          if (eff.api === 'DamageAll' && isCreature(x) && g.statsOf(x).toughness - x.damage > n) continue;
          if (g.has(x, 'Indestructible')) continue;
          s += (x.controller === me ? -1.2 : 1) * permValue(g, x);
        }
        if (eff.api === 'DamageAll' && P.ValidPlayers) s += n * 0.3;
        s -= 3;   // only worth it for a real swing
        break;
      }
      case 'ChangeZone': s = (P.Origin ?? '').includes('Library') ? 2.5 : 1; break;
      case 'LoseLife': case 'DealDamage': {
        const who = g.defined(P.Defined, ctx);
        const amt = g.amount(eff.api === 'LoseLife' ? P.LifeAmount : P.NumDmg, ctx, def);
        s = who.some(t => t.kind === 'player' && t.pid === them) ? amt * 0.6 : who.some(t => t.kind === 'player' && t.pid === me) ? -amt * 0.3 : 0.5;
        break;
      }
      case 'Discard': s = P.Defined === 'Opponent' ? 2 : -1; break;
      case 'Sacrifice': s = P.Defined === 'Opponent' || P.Defined === 'Player.Opponent' ? 3 : -1; break;
      case 'SetState': s = 6; break;
      case 'Mill': s = 0.2; break;
      default: s = 0.5;
    }
  }
  if (eff.sub) s += Math.max(0, effectScore(g, eff.sub, ctx, depth + 1)) * 0.8;
  return s;
}

// ------------------------------------------------------------------ actions
interface Action { score: number; run: () => boolean; label: string }

function counterCards(p: Player) {
  return p.hand.filter(c => c.def.spell && (c.def.spell.effect.api === 'Counter' || (c.def.spell.effect.choices ?? []).some(e => e.api === 'Counter')));
}

/** Mana to keep open for a counterspell during our main phase. */
function reserveFor(g: Game, p: Player): number {
  const cs = counterCards(p);
  if (!cs.length || !g.players[g.opp(p.id)].hand.length) return 0;
  return Math.min(...cs.map(c => c.def.mv));
}

function boardPower(g: Game, pid: number) { return myCreatures(g, pid).reduce((a, x) => a + Math.max(0, g.statsOf(x).power), 0); }

function auraHostFor(g: Game, def: CardDef, pid: number, exclude?: number): Perm | undefined {
  const spellEff = def.spell?.effect;
  const ench = def.keywords.find(k => k.startsWith('Enchant'));
  let filter = spellEff?.params.ValidTgts ?? (ench ? ench.replace(/^Enchant:?\s*/, '') : 'Creature');
  filter = filter.charAt(0).toUpperCase() + filter.slice(1);
  const curse = !!spellEff && (spellEff.params.AILogic === 'Curse' || spellEff.params.AILogic === 'Pacifism' || spellEff.params.AILogic === 'KeepTapped' || spellEff.params.IsCurse === 'True')
    || def.statics.some(s => (s.params.Affected === 'Creature.EnchantedBy' || s.params.ValidCard === 'Creature.EnchantedBy' || s.params.AffectedDefined === 'Enchanted') && (/CantAttack|CantBlock/.test(s.mode) || negative(s.params.AddPower)));
  const cands = g.bf.filter(x => x.id !== exclude && matches(filter, g.subjectOf(x), { you: pid })
    && !g.has(x, 'Shroud') && (x.controller === pid || !g.has(x, 'Hexproof')));
  const pool = cands.filter(x => (curse ? x.controller !== pid : x.controller === pid));
  if (!pool.length) return undefined;
  return pool.reduce((a, b) => (permValue(g, a) >= permValue(g, b) ? a : b));
}

export function chooseAuraHost(g: Game, perm: Perm): Perm | undefined {
  return auraHostFor(g, perm.def, perm.controller, perm.id);
}

interface Plan { score: number; x: number; kicked: boolean; sacForAlt?: Perm; flashback?: boolean; warp?: boolean; fromExile?: boolean }

function planSpell(g: Game, p: Player, card: CardInst, fromCommand: boolean, window: 'main1' | 'main2' | 'instant', flashback = false): Plan | undefined {
  const d = card.def;
  if (isLandCard(card)) return undefined;
  if (window === 'instant' && !isInstantSpeed(d)) return undefined;
  if (flashback) {
    const altCost = g.keywordCost(card, 'Flashback');
    if (altCost === undefined || d.cost.x || !d.spell || !g.canCast(p.id, card, { altCost })) return undefined;
    if (d.types.includes('Instant') && window !== 'instant' && p.style === 'control') return undefined;
    const score = effectScore(g, d.spell.effect, { p: p.id, card, x: 0, kicked: false, targets: [] });
    const harmfulTarget = isHarmful(d.spell.effect) && d.spell.effect.params.ValidTgts !== undefined;
    if (score <= (harmfulTarget ? 1.5 : 0.5)) return undefined;
    return { score: score + 0.5, x: 0, kicked: false, flashback: true };   // free card: slightly preferred
  }
  let x = 0;
  if (d.cost.x) {
    const base = g.spellCost(p.id, card, { fromCommand });
    x = g.availableMana(p.id) - (base.generic + base.pips.length);
    if (x < 1) return undefined;
  }
  const kicked = !!d.kicker && g.canCast(p.id, card, { kicked: true, x, fromCommand });
  let sacForAlt: Perm | undefined;
  if (d.altAdditional) {
    const fodder = g.bf.filter(f => f.controller === p.id && matches(d.altAdditional!.sac, g.subjectOf(f), { you: p.id }) && permValue(g, f) < 3);
    if (fodder.length) sacForAlt = worstPermanent(g, fodder);
    const c = g.spellCost(p.id, card, { fromCommand, x, kicked });
    const ok = sacForAlt ? g.payMana(p.id, c.generic, c.pips, false)
      : g.payMana(p.id, c.generic + d.altAdditional.orMana.generic, [...c.pips, ...d.altAdditional.orMana.pips], false);
    if (!ok) return undefined;
  } else if (!g.canCast(p.id, card, { kicked, x, fromCommand })) return undefined;

  const permanent = !d.types.includes('Instant') && !d.types.includes('Sorcery');
  let score: number;
  if (permanent) {
    if (d.supertypes.includes('Legendary') && g.bf.some(x => x.controller === p.id && x.def.name === d.name)) return undefined;
    if (d.keywords.some(k => k.startsWith('Enchant')) && !auraHostFor(g, d, p.id)) return undefined;
    if (d.spell?.effect.api === 'Attach' && !d.subtypes.includes('Equipment') && !auraHostFor(g, d, p.id)) return undefined;
    score = 5 + cardValue(g, p, card);
    if (!d.types.includes('Creature') && /lose \d+ life|you lose 1 life/i.test(d.oracle) && p.life <= 8) score -= 6;
    if (d.keywords.includes('Flash') && window !== 'instant' && p.style === 'control'
      && boardPower(g, p.id) >= boardPower(g, g.opp(p.id))) return undefined;
    if (d.subtypes.includes('Equipment') && !myCreatures(g, p.id).length) score -= 3;
  } else {
    if (!d.spell) return undefined;
    const ctx: Ctx = { p: p.id, card, x, kicked, targets: [] };
    score = effectScore(g, d.spell.effect, ctx);
    const harmfulTarget = isHarmful(d.spell.effect) && d.spell.effect.params.ValidTgts !== undefined;
    if (d.types.includes('Instant') && window !== 'instant') {
      // hold instants for the opponent's turn unless they clear a real threat now (or we're the beatdown)
      if (!harmfulTarget || (score < 4 && p.style !== 'aggro') || p.style === 'control') return undefined;
    }
    if (score <= (harmfulTarget ? 1.5 : 0.5)) return undefined;
    // killing a creature that is pressuring us beats developing our own board
    if (harmfulTarget && score >= 3 && score < 100) score = score * 1.3 + 3 + (g.players[p.id].life < 10 ? 3 : 0);
  }
  return { score, x, kicked, sacForAlt };
}

function castAction(g: Game, p: Player, card: CardInst, fromCommand: boolean, plan: Plan): Action {
  return {
    score: plan.score, label: `cast ${card.def.name}`,
    run: () => g.castSpell(p.id, card, { fromCommand, x: plan.x, kicked: plan.kicked, sacForAlt: plan.sacForAlt, flashback: plan.flashback, warp: plan.warp, fromExile: plan.fromExile }),
  };
}

const activatedThisWindow = new Set<string>();

function costPayable(g: Game, p: Player, perm: Perm, ab: Ability): boolean {
  const c = ab.cost;
  if (!c.supported) return false;
  if (ab.condition === 'MaxSpeed' && (p.speed ?? 0) < 4) return false;
  if (c.mana.x) return false;
  if (c.tap && (perm.tapped || (isCreature(perm) && perm.sick && !g.has(perm, 'Haste')))) return false;
  if (c.payLife && p.life <= c.payLife + 2) return false;
  if (c.discard && p.hand.length < c.discard) return false;
  if (c.sac && sacFodder(g, p, perm, c.sac).length < c.sac.n) return false;
  if (c.loyalty !== undefined) {
    if (perm.loyaltyUsedTurn === g.turn || c.loyalty === -1 && ab.effect.params.Planeswalker === undefined && false) return false;
    if ((perm.counters.LOYALTY ?? 0) + c.loyalty < 0) return false;
  }
  // if the ability taps this permanent and it is also a mana source, paying mana must not need it
  if (c.mana.generic || c.mana.pips.length) {
    if (c.tap && !perm.tapped) {
      perm.tapped = true;
      const ok = g.payMana(p.id, c.mana.generic, c.mana.pips, false);
      perm.tapped = false;
      return ok;
    }
    return g.payMana(p.id, c.mana.generic, c.mana.pips, false);
  }
  return true;
}

function sacFodder(g: Game, p: Player, perm: Perm, sac: { n: number; filter: string }) {
  return g.bf.filter(x => x.controller === p.id && matches(sac.filter, g.subjectOf(x), { you: p.id, sourceId: perm.id }));
}

function payCost(g: Game, p: Player, perm: Perm, ab: Ability): number {
  const c = ab.cost;
  let sacPower = 0;
  if (c.tap) perm.tapped = true;
  if (c.mana.generic || c.mana.pips.length) g.payMana(p.id, c.mana.generic, c.mana.pips, true);
  if (c.payLife) g.loseLife(p.id, c.payLife);
  if (c.discard) for (let i = 0; i < c.discard; i++) { const d = chooseDiscard(g, p); if (d) g.discard(p, d); }
  if (c.sac) for (let i = 0; i < c.sac.n; i++) {
    const opts = sacFodder(g, p, perm, c.sac).filter(x => x !== perm);
    if (!opts.length) break;
    const w = worstPermanent(g, opts);
    sacPower += g.statsOf(w).power;
    g.leave(w, 'graveyard', { sacrificed: true });
  }
  if (c.loyalty !== undefined) { perm.counters.LOYALTY = (perm.counters.LOYALTY ?? 0) + c.loyalty; perm.loyaltyUsedTurn = g.turn; }
  if (c.sacSelf) g.leave(perm, 'graveyard', { sacrificed: true });
  return sacPower;
}

function costPenalty(g: Game, p: Player, perm: Perm, ab: Ability): number {
  const c = ab.cost;
  let pen = (c.mana.generic + c.mana.pips.length) * 0.25;
  if (c.sacSelf) pen += perm.token ? 0.3 : permValue(g, perm);
  if (c.sac) {
    const opts = sacFodder(g, p, perm, c.sac).filter(x => x !== perm);
    if (opts.length) pen += permValue(g, worstPermanent(g, opts)) * c.sac.n;
  }
  if (c.payLife) pen += c.payLife * (p.life < 10 ? 0.8 : 0.25);
  if (c.discard) pen += 1.5 * c.discard;
  if (c.tap && isCreature(perm) && g.phase !== 'end' && g.active === p.id && g.phase === 'main1') pen += 2;
  return pen;
}

function abilityActions(g: Game, p: Player, window: 'main1' | 'main2' | 'instant'): Action[] {
  const acts: Action[] = [];
  const granting = g.bf.some(x => x.def.statics.some(st => st.params.AddAbility));
  for (const perm of g.bf.filter(x => x.controller === p.id)) {
    [...perm.def.abilities, ...(granting ? g.grantedAbilities(perm).filter(a => a.kind === 'activated') : [])].forEach((ab, idx) => {
      if (ab.kind !== 'activated') return;
      if (window === 'instant' && (ab.sorcerySpeed || ab.planeswalker)) return;
      const key = `${g.turn}:${g.active}:${g.phase}:${perm.id}:${idx}`;
      if (activatedThisWindow.has(key)) return;
      if (ab.planeswalker && perm.loyaltyUsedTurn === g.turn) return;
      if (!costPayable(g, p, perm, ab)) return;
      const ctx: Ctx = { p: p.id, source: perm, x: 0, kicked: false, targets: [] };
      let score: number;
      if (ab.effect.api === 'SetState' || ab.effect.sub?.params.Transformed === 'True') {
        if (!perm.def.back || perm.transformed) return;
        score = 6;
      } else if (ab.effect.api === 'Attach') {
        // equip: only when unattached (or host is gone)
        if (perm.attachedTo !== undefined && g.bf.some(x => x.id === perm.attachedTo)) return;
        if (!myCreatures(g, p.id).length) return;
        score = 3;
      } else {
        score = effectScore(g, ab.effect, ctx);
        if (ab.planeswalker) {
          const loyaltyAfter = (perm.counters.LOYALTY ?? 0) + (ab.cost.loyalty ?? 0);
          if (ab.ultimate && score > 0) score += 10;   // only when it actually does something
          if ((ab.cost.loyalty ?? 0) > 0) score += 1.5;
          if (loyaltyAfter <= 1 && (ab.cost.loyalty ?? 0) < 0) score -= 2;
        }
      }
      score -= ab.planeswalker ? 0 : costPenalty(g, p, perm, ab);
      if (score <= 0.3) return;
      acts.push({
        score, label: `activate ${perm.def.name}`,
        run: () => {
          activatedThisWindow.add(key);
          if (!costPayable(g, p, perm, ab)) return false;
          const sp = payCost(g, p, perm, ab);
          g.trace(`activates ${perm.def.name}: ${ab.description ?? ab.effect.api}`, p.id);
          g.resolveEffect(ab.effect, { ...ctx, sacrificedPower: sp });
          g.checkSBA();
          return true;
        },
      });
    });
  }
  return acts;
}

/**
 * Cycling: landcycle when we're short on lands; cycle a card we can't cast any time soon,
 * or extra lands once we have plenty. Cards with a "when you cycle" trigger are cycled more readily.
 */
function cycleActions(g: Game, p: Player): Action[] {
  const lands = g.bf.filter(x => x.controller === p.id && x.def.types.includes('Land')).length;
  const landsInHand = p.hand.filter(isLandCard).length;
  const acts: Action[] = [];
  for (const c of p.hand) {
    const landcycle = c.def.keywords.some(k => k.startsWith('TypeCycling:'));
    const cost = g.keywordCost(c, landcycle ? 'TypeCycling' : 'Cycling');
    if (cost === undefined) continue;
    let score = 0;
    if (landcycle) {
      if (landsInHand === 0 && lands < 7) score = 4.5;
      else if (c.def.mv > lands + 2 && lands < 6) score = 3;
    } else {
      if (isLandCard(c)) score = lands >= 6 && landsInHand > 1 ? 3 : 0;
      else if (c.def.mv > lands + 2) score = 2.5;
    }
    if (c.def.triggers.some(t => t.mode === 'Cycled')) score += 1.5;
    if (score <= 0) continue;
    const mc = g.spellCost(p.id, c, { altCost: cost });
    if (!g.payMana(p.id, mc.generic, mc.pips, false)) continue;
    acts.push({ score, label: `cycle ${c.def.name}`, run: () => g.cycle(p.id, c) });
  }
  return acts;
}

/**
 * Warp: cast a creature for its (cheaper) warp cost when we can't afford it normally this turn.
 * It's exiled at end of turn and comes back later, so it's worth it for an enters trigger or a hasty hit.
 */
function warpActions(g: Game, p: Player, window: 'main1' | 'main2' | 'instant'): Action[] {
  if (window === 'instant') return [];
  const acts: Action[] = [];
  for (const c of p.hand) {
    const cost = g.keywordCost(c, 'Warp');
    if (cost === undefined || /X/.test(cost) || g.canCast(p.id, c)) continue;
    if (!g.canCast(p.id, c, { altCost: cost })) continue;
    const etb = c.def.triggers.some(t => (t.mode === 'ChangesZone' && t.params.Destination === 'Battlefield' && /Self/.test(t.params.ValidCard ?? '')));
    const hasty = c.def.keywords.includes('Haste') && window === 'main1';
    let score = (etb ? 3 : 0) + (hasty ? (c.def.power ?? 0) * 0.7 : 0);
    if (!c.def.types.includes('Creature')) score = etb ? 3 : 0;
    if (score < 1.5) continue;
    acts.push({ score, label: `warp ${c.def.name}`, run: () => g.castSpell(p.id, c, { warp: true }) });
  }
  return acts;
}

/** Does this effect (or a later step) put a creature card from a graveyard onto the battlefield? */
export function reanimates(eff: Effect | undefined, depth = 0): boolean {
  if (!eff || depth > 8) return false;
  const P = eff.params;
  if (/^ChangeZone(All)?$/.test(eff.api) && /Graveyard/.test(P.Origin ?? '') && P.Destination === 'Battlefield') return true;
  return reanimates(eff.sub, depth + 1) || (eff.choices ?? []).some(c => reanimates(c, depth + 1));
}
const cardReanimates = (d: CardDef) => reanimates(d.spell?.effect) || d.abilities.some(a => reanimates(a.effect))
  || d.triggers.some(t => reanimates(t.effect)) || (d.chapters ?? []).some(e => reanimates(e));

/**
 * Evoke: cast a creature for its evoke cost when its enters trigger is worth a card (it's sacrificed right away),
 * especially when we can bring it back from the graveyard.
 */
function evokeActions(g: Game, p: Player, window: 'main1' | 'main2' | 'instant'): Action[] {
  if (window === 'instant') return [];
  const acts: Action[] = [];
  for (const c of p.hand) {
    if (!c.def.keywords.some(k => k.startsWith('Evoke:')) || g.canCast(p.id, c)) continue;
    const cost = g.evokeCost(p.id, c);
    if (!cost) continue;
    const ctx: Ctx = { p: p.id, card: c, x: 0, kicked: false, targets: [] };
    const etbs = c.def.triggers.filter(t => t.mode === 'ChangesZone' && t.params.Destination === 'Battlefield' && /Self/.test(t.params.ValidCard ?? '') && t.effect);
    let etb = etbs.reduce((a, t) => a + effectScore(g, t.effect!, ctx), 0);
    // removal is weighed the same way as a removal spell (see planSpell)
    if (etb >= 3 && etbs.some(t => isHarmful(t.effect!) && t.effect!.params.ValidTgts !== undefined)) etb = etb * 1.3 + 3;
    const pitched = cost.parts.filter(x => x.kind === 'ExileFromHand').length;
    const reanimator = [...p.hand, ...g.bf.filter(x => x.controller === p.id), ...p.command].some(x => x !== c && cardReanimates(x.def));
    const score = etb + (reanimator ? 3 : 0) - pitched * 2.5 - cardValue(g, p, c) * 0.3;
    if (score < 1.5) continue;
    acts.push({ score, label: `evoke ${c.def.name}`, run: () => g.castSpell(p.id, c, { evoke: true }) });
  }
  return acts;
}

/**
 * Impending (the Overlords): when the full cost is out of reach, cast it for the impending cost for the
 * enters trigger now; it becomes a creature a few turns later.
 */
function impendingActions(g: Game, p: Player, window: 'main1' | 'main2' | 'instant'): Action[] {
  if (window === 'instant') return [];
  const acts: Action[] = [];
  for (const c of p.hand) {
    const ic = g.impendingCost(c.def);
    if (!ic || g.canCast(p.id, c) || !g.canCast(p.id, c, { altCost: ic.cost })) continue;
    const etb = c.def.triggers.some(t => t.mode === 'ChangesZone' && t.params.Destination === 'Battlefield' && /Self/.test(t.params.ValidCard ?? ''));
    const score = 3 + (etb ? 2 : 0) + (c.def.power ?? 0) * 0.2;
    acts.push({ score, label: `impending ${c.def.name}`, run: () => g.castSpell(p.id, c, { impending: true }) });
  }
  return acts;
}

/**
 * Station (sorcery speed, so after combat): tap creatures that didn't attack to charge a Spacecraft
 * or Planet, when we're not under pressure or it finishes the job this turn.
 */
function stationActions(g: Game, p: Player, window: 'main1' | 'main2' | 'instant'): Action[] {
  if (window !== 'main2') return [];
  const acts: Action[] = [];
  const theirPower = myCreatures(g, g.opp(p.id)).reduce((a, x) => a + Math.max(0, g.statsOf(x).power), 0);
  for (const st of g.bf.filter(x => x.controller === p.id && x.def.keywords.some(k => k.startsWith('Station')))) {
    const goal = parseInt(st.def.keywords.find(k => k.startsWith('Station'))!.split(':')[1] ?? '0', 10) || 0;
    const have = st.counters.CHARGE ?? 0;
    if (have >= goal) continue;
    const crew = myCreatures(g, p.id).filter(c => c !== st && !c.tapped && g.statsOf(c).power > 0)
      .sort((a, b) => g.statsOf(b).power - g.statsOf(a).power)[0];
    if (!crew) continue;
    const finishes = have + g.statsOf(crew).power >= goal;
    if (!finishes && p.life <= theirPower * 2) continue;
    acts.push({ score: finishes ? 3 : 1.5, label: `station ${st.def.name}`, run: () => g.station(st, crew) });
  }
  return acts;
}

function runActions(g: Game, p: Player, gather: () => Action[]) {
  for (let guard = 0; guard < 30 && !g.over; guard++) {
    const acts = gather().sort((a, b) => b.score - a.score);
    let did = false;
    for (const a of acts) { if (a.run()) { did = true; break; } }
    if (!did) break;
  }
}

export function mainPhase(g: Game, p: Player, phase: 1 | 2) {
  playBestLand(g, p);
  const window = phase === 1 ? 'main1' : 'main2';
  runActions(g, p, () => {
    playBestLand(g, p);
    const reserve = reserveFor(g, p);
    const behind = boardPower(g, p.id) < boardPower(g, g.opp(p.id));
    const acts: Action[] = [];
    const avail = g.availableMana(p.id);
    const sources: [CardInst, boolean][] = [...p.hand.map(c => [c, false] as [CardInst, boolean]), ...p.command.map(c => [c, true] as [CardInst, boolean])];
    for (const [card, fromCommand] of sources) {
      const plan = planSpell(g, p, card, fromCommand, window);
      if (!plan) continue;
      const cost = card.def.mv + plan.x + (fromCommand ? p.commanderTax : 0);
      if (reserve && avail - cost < reserve && !(behind && isCreature(card))) continue;
      acts.push(castAction(g, p, card, fromCommand, plan));
    }
    for (const card of p.graveyard) {
      const plan = planSpell(g, p, card, false, window, true);
      if (plan) acts.push(castAction(g, p, card, false, plan));
    }
    // warped cards in exile can be cast normally on a later turn
    for (const w of p.warpExile ?? []) {
      if (w.turn >= g.turn) continue;
      const plan = planSpell(g, p, w.card, false, window);
      if (plan) acts.push(castAction(g, p, w.card, false, { ...plan, fromExile: true }));
    }
    // impulse draw: exiled cards we may play this turn (or longer)
    for (const m of p.mayPlay ?? []) {
      if (!g.inExile(m.card) || m.card.def.land) continue;
      const plan = planSpell(g, p, m.card, false, window);
      if (plan) acts.push(castAction(g, p, m.card, false, { ...plan, fromExile: true }));
    }
    acts.push(...warpActions(g, p, window));
    acts.push(...impendingActions(g, p, window));
    acts.push(...evokeActions(g, p, window));
    acts.push(...stationActions(g, p, window));
    acts.push(...abilityActions(g, p, window));
    acts.push(...cycleActions(g, p));
    return acts;
  });
}

/** Use mana that only lasts until end of combat (firebending): instants, flash and instant-speed abilities. */
export function spendFloatingMana(g: Game, p: Player) {
  runActions(g, p, () => {
    if (!p.pool?.length) return [];
    const acts: Action[] = [];
    for (const card of p.hand) {
      const plan = planSpell(g, p, card, false, 'instant');
      if (plan) acts.push(castAction(g, p, card, false, plan));
    }
    acts.push(...abilityActions(g, p, 'instant'));
    return acts;
  });
}

/**
 * Ninjutsu / Sneak: swap the least valuable unblocked attacker for something better from hand.
 * Ninjas and sneak creatures enter attacking; a sneak noncreature spell is cast if it's worth casting now.
 */
export function ninjaStep(g: Game, p: Player, attackers: Perm[], blocks: Map<Perm, Perm[]>): Perm[] {
  let cur = attackers;
  for (let guard = 0; guard < 3; guard++) {
    const unblocked = cur.filter(a => g.bf.includes(a) && !(blocks.get(a)?.length));
    if (!unblocked.length) break;
    const back = [...unblocked].sort((a, b) => permValue(g, a) - permValue(g, b))[0];
    let best: { c: CardInst; v: number } | undefined;
    for (const c of p.hand) {
      const kw = c.def.keywords.find(k => k.startsWith('Ninjutsu') || k.startsWith('Sneak'));
      if (!kw) continue;
      const cost = kw.split(':').slice(1).join(':');
      const mc = g.spellCost(p.id, c, { altCost: cost });
      if (!g.payMana(p.id, mc.generic, mc.pips, false)) continue;
      let v: number;
      if (isCreature(c)) {
        // the ninja deals its damage now and stays; the returned creature can be recast later
        v = cardValue(g, p, c) + Math.max(0, (c.def.power ?? 0) - g.statsOf(back).power) * 0.5 - permValue(g, back) * 0.6;
      } else {
        if (!c.def.spell) continue;
        v = effectScore(g, c.def.spell.effect, { p: p.id, card: c, x: 0, kicked: false, targets: [] }) - permValue(g, back) * 0.6;
        if (v < 2) continue;
      }
      if (v > 0.5 && (!best || v > best.v)) best = { c, v };
    }
    if (!best) break;
    const next = g.ninjutsu(p.id, best.c, back, cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * Crew vehicles before attacking: tap the least useful creatures (summoning sick ones cost nothing)
 * when the vehicle hits harder than the crew would.
 */
export function crewVehicles(g: Game, p: Player) {
  for (const v of g.bf.filter(x => x.controller === p.id && !x.tapped && !x.baseDef && x.def.keywords.some(k => k.startsWith('Crew:')))) {
    if (v.sick && !g.has(v, 'Haste')) continue;
    const n = parseInt(v.def.keywords.find(k => k.startsWith('Crew:'))!.split(':')[1], 10);
    const canAttack = (c: Perm) => !c.sick || g.has(c, 'Haste');
    const pool = myCreatures(g, p.id).filter(c => !c.tapped && c !== v && g.statsOf(c).power > 0)
      .sort((a, b) => (canAttack(a) ? g.statsOf(a).power : 0) - (canAttack(b) ? g.statsOf(b).power : 0) || g.statsOf(a).power - g.statsOf(b).power);
    const crew: Perm[] = [];
    let total = 0;
    for (const c of pool) { if (total >= n) break; crew.push(c); total += g.statsOf(c).power; }
    if (total < n) continue;
    const lost = crew.filter(canAttack).reduce((a, c) => a + g.statsOf(c).power, 0);
    if ((v.def.power ?? 0) > lost) g.crew(v, crew);
  }
}

/**
 * Manlands and other "becomes a creature until end of turn" permanents: animate before attacking when the
 * mana can be paid without tapping the permanent itself and no untapped opposing creature can block it and kill it.
 */
export function animateForAttack(g: Game, p: Player) {
  for (const perm of g.bf.filter(x => x.controller === p.id && !x.tapped && !x.sick && !isCreature(x))) {
    const ab = perm.def.abilities.find(a => a.effect.api === 'Animate' && a.effect.params.Defined === 'Self' && !a.effect.params.Duration
      && a.cost.supported && !a.cost.tap && !a.cost.sac && !a.cost.loyalty && !a.cost.discard && !a.cost.mana.x);
    if (!ab) continue;
    const P = ab.effect.params;
    if (!/Creature/.test(P.Types ?? '')) continue;
    const power = +(P.Power ?? 0), tough = +(P.Toughness ?? 0);
    const kws = (P.Keywords ?? '').split(' & ');
    if (power < 1) continue;
    const blockers = myCreatures(g, g.opp(p.id)).filter(b => !b.tapped
      && (!kws.includes('Flying') || g.has(b, 'Flying') || g.has(b, 'Reach')));
    if (blockers.some(b => g.statsOf(b).power >= tough)) continue;
    // pay with other sources: mark it tapped while paying so the solver leaves it alone
    perm.tapped = true;
    const ok = g.payMana(p.id, ab.cost.mana.generic, ab.cost.mana.pips, false);
    if (ok) g.payMana(p.id, ab.cost.mana.generic, ab.cost.mana.pips, true);
    perm.tapped = false;
    if (!ok) continue;
    g.trace(`activates ${perm.def.name}: ${ab.description ?? 'Animate'}`, p.id);
    g.resolveEffect(ab.effect, { p: p.id, source: perm, x: 0, kicked: false, targets: [] });
  }
}

/** Earthbend target: stack onto a land that's already a creature, else an untapped basic (it has haste and can attack). */
export function chooseEarthbendLand(g: Game, pid: number): Perm | undefined {
  const lands = g.bf.filter(x => x.controller === pid && x.def.types.includes('Land'));
  return lands.find(x => x.earthbent)
    ?? lands.filter(x => !x.tapped).sort((a, b) => Number(b.def.supertypes.includes('Basic')) - Number(a.def.supertypes.includes('Basic')))[0]
    ?? lands[0];
}

/** The non-active player's chance to use instants, flash and abilities at the end of the opponent's turn. */
export function endOfTurnWindow(g: Game, p: Player) {
  runActions(g, p, () => {
    const acts: Action[] = [];
    for (const card of p.hand) {
      const plan = planSpell(g, p, card, false, 'instant');
      if (plan) acts.push(castAction(g, p, card, false, plan));
    }
    for (const card of p.graveyard) {
      const plan = planSpell(g, p, card, false, 'instant', true);
      if (plan) acts.push(castAction(g, p, card, false, plan));
    }
    acts.push(...abilityActions(g, p, 'instant'));
    acts.push(...cycleActions(g, p));
    return acts;
  });
}

// ------------------------------------------------------------------ responses
// ------------------------------------------------------------------ stack responses
// One rule drives every response: act only if it saves (or kills) something worth more than
// the card we spend doing it. Three obvious cases are covered:
//   1. counter it      - their spell is worth more than our counterspell (includes counter wars)
//   2. protect         - their removal targets our creature and a trick in hand saves it
//   3. punish a trick  - they pump/enchant their creature; we kill it in response, fizzling the trick

export function resetHints() { hint.perm = undefined; hint.spell = undefined; hint.charm = undefined; }

const ctxOfItem = (item: StackItem): Ctx => ({ p: item.controller, card: item.card, x: item.x, kicked: item.kicked, targets: [] });
const myTargets = (item: StackItem, me: number, harmfulOnly: boolean) =>
  (item.plan ?? []).filter(st => !harmfulOnly || isHarmful(st.effect))
    .flatMap(st => (st.targets ?? []).map(t => ({ t, effect: st.effect })))
    .filter(x => x.t.kind === 'perm' && x.t.perm.controller === me) as { t: { kind: 'perm'; perm: Perm }; effect: Effect }[];

/** What letting this opponent's spell resolve would cost the responder. */
function spellThreat(g: Game, item: StackItem, responder: number): number {
  const d = item.card.def;
  if (cantBeCountered(d)) return -99;
  // a counterspell aimed at our spell is exactly as bad as losing that spell
  const counterStep = item.plan?.find(st => st.effect.api === 'Counter');
  if (counterStep) {
    const mine = counterStep.targets?.find(t => t.kind === 'spell' && t.item.controller === responder) as { item: StackItem } | undefined;
    if (mine) return cardValue(g, g.players[responder], mine.item.card) + (mine.item.card.isCommander ? 3 : 0) + 1;
  }
  let t: number;
  if (d.types.includes('Creature')) t = cardValue(g, g.players[item.controller], item.card);
  else t = d.mv + 1;
  if (d.types.includes('Planeswalker')) t += 2;
  if (item.card.isCommander) t += 3;
  const hit = myTargets(item, responder, true);
  if (hit.length) t = Math.max(t, hit.reduce((a, x) => a + permValue(g, x.t.perm), 0) + 1);
  if (d.spell) {
    const e = d.spell.effect;
    if (e.api === 'DestroyAll' || e.api === 'DamageAll') t += 4;
    if (['Draw', 'Scry', 'Surveil', 'Dig'].includes(e.api) && d.mv <= 2) t -= 2;
  }
  return t + item.x;
}

function tryCounter(g: Game, me: Player, item: StackItem): boolean {
  const threat = spellThreat(g, item, me.id);
  for (const card of counterCards(me)) {
    if (threat < cardValue(g, me, card) - (me.style === 'control' ? 1 : 0)) continue;   // not worth the card
    const eff = card.def.spell!.effect;
    const ce = eff.api === 'Counter' ? eff : eff.choices!.find(e => e.api === 'Counter')!;
    if (!matches(ce.params.ValidTgts ?? 'Card', g.subjectOf(item.card, item.controller), { you: me.id })) continue;
    const unless = ce.params.UnlessCost ? parseInt(ce.params.UnlessCost, 10) : 0;
    if (unless && g.availableMana(item.controller) >= unless) continue;
    if (!g.canCast(me.id, card)) continue;
    withHint({ spell: item, charm: eff.api === 'Charm' ? 'Counter' : undefined }, () => g.castSpell(me.id, card));
    return true;
  }
  return false;
}

interface Protection { hexproof: boolean; indestructible: boolean; toughness: number }
/** Instant tricks that can save one of our creatures: hexproof, indestructible or extra toughness. */
function protectionOf(g: Game, card: CardInst, pid: number): Protection | undefined {
  const d = card.def;
  if (!isInstantSpeed(d) || !d.spell || d.types.includes('Creature')) return undefined;
  const pr: Protection = { hexproof: false, indestructible: false, toughness: 0 };
  const ctx: Ctx = { p: pid, card, x: 0, kicked: false, targets: [] };
  let e: Effect | undefined = d.spell.effect, ok = false;
  for (let i = 0; e && i < 6; e = e.sub, i++) {
    if (isHarmful(e)) return undefined;
    const kws = (e.params.KW ?? '').split(' & ');
    if (e.api === 'Pump') {
      ok = true;
      if (kws.includes('Hexproof') || kws.includes('Shroud')) pr.hexproof = true;
      if (kws.includes('Indestructible')) pr.indestructible = true;
      pr.toughness += Math.max(0, g.amount(e.params.NumDef, ctx));
    } else if (e.api === 'PutCounter' && (e.params.CounterType ?? 'P1P1') === 'P1P1') {
      ok = true; pr.toughness += g.amount(e.params.CounterNum ?? '1', ctx);
    }
  }
  if (!ok || !d.spell.effect.params.ValidTgts) return undefined;
  return pr;
}

/** Would `victim` survive `eff` if we gave it `pr`? */
function survives(g: Game, victim: Perm, eff: Effect, item: StackItem, pr: Protection): boolean {
  if (pr.hexproof) return true;                       // the spell loses its target
  const ctx = ctxOfItem(item);
  const st = g.statsOf(victim);
  const left = st.toughness - victim.damage + pr.toughness;
  switch (eff.api) {
    case 'Destroy': return pr.indestructible;
    case 'DealDamage': return pr.indestructible || left > g.amount(eff.params.NumDmg, ctx, item.card.def);
    case 'Pump': return left + g.amount(eff.params.NumDef, ctx, item.card.def) > 0;
    case 'PutCounter': return left - g.amount(eff.params.CounterNum ?? '1', ctx, item.card.def) > 0;
  }
  return false;                                        // exile, bounce, etc.
}

function tryProtect(g: Game, me: Player, item: StackItem): boolean {
  for (const { t, effect } of myTargets(item, me.id, true)) {
    const victim = t.perm;
    if (!g.bf.includes(victim) || !isCreature(victim)) continue;
    for (const card of me.hand) {
      const pr = protectionOf(g, card, me.id);
      if (!pr || !g.canCast(me.id, card)) continue;
      if (permValue(g, victim) <= cardValue(g, me, card)) continue;          // not worth the card
      if (!survives(g, victim, effect, item, pr)) continue;
      if (!matches(card.def.spell!.effect.params.ValidTgts!, g.subjectOf(victim), { you: me.id })) continue;
      withHint({ perm: victim }, () => g.castSpell(me.id, card));
      return true;
    }
  }
  return false;
}

function tryPunish(g: Game, me: Player, item: StackItem): boolean {
  const boosted = (item.plan ?? []).filter(st => !isHarmful(st.effect) && ['Pump', 'PutCounter', 'Attach'].includes(st.effect.api))
    .flatMap(st => st.targets ?? [])
    .filter(t => t.kind === 'perm' && t.perm.controller === item.controller && isCreature(t.perm)) as { perm: Perm }[];
  for (const { perm: target } of boosted) {
    if (!g.bf.includes(target)) continue;
    for (const card of me.hand) {
      const d = card.def;
      if (!isInstantSpeed(d) || !d.spell || d.types.includes('Creature') || !isHarmful(d.spell.effect) || d.spell.effect.api === 'Counter') continue;
      if (!g.canCast(me.id, card)) continue;
      const ctx: Ctx = { p: me.id, card, x: 0, kicked: false, targets: [] };
      const s = scoreTargets(g, d.spell.effect, ctx).find(x => x.t.kind === 'perm' && x.t.perm === target)?.s ?? 0;
      if (s < 1) continue;                                                     // can't deal with it
      if (permValue(g, target) + cardValue(g, g.players[item.controller], item.card) < cardValue(g, me, card)) continue;
      withHint({ perm: target }, () => g.castSpell(me.id, card));
      return true;
    }
  }
  return false;
}

/** Called whenever `me` gets priority with something on the stack. Returns true if we responded. */
export function respond(g: Game, me: Player, top: StackItem): boolean {
  if (top.countered || top.controller === me.id) return false;
  return tryCounter(g, me, top) || tryProtect(g, me, top) || tryPunish(g, me, top);
}

/** Defender may use instant-speed removal on an attacker. */
export function duringAttack(g: Game, defender: Player, attackers: Perm[]) {
  const incoming = attackers.reduce((a, x) => a + Math.max(0, g.statsOf(x).power), 0);
  const sorted = [...attackers].sort((a, b) => permValue(g, b) - permValue(g, a));
  for (const a of sorted) {
    const pw = g.statsOf(a).power;
    if (pw < 3 && incoming < defender.life && permValue(g, a) < 5) continue;
    for (const card of defender.hand) {
      const d = card.def;
      if (!d.types.includes('Instant') || !d.spell || !isHarmful(d.spell.effect) || d.spell.effect.api === 'Counter') continue;
      if (!g.canCast(defender.id, card)) continue;
      const ctx: Ctx = { p: defender.id, card, x: 0, kicked: false, targets: [] };
      const ok = withHint({ perm: a }, () => (scoreTargets(g, d.spell!.effect, ctx).find(s => s.t.kind === 'perm' && s.t.perm === a)?.s ?? 0) > 2);
      if (!ok) continue;
      withHint({ perm: a }, () => g.castSpell(defender.id, card));
      return;
    }
  }
}

// ------------------------------------------------------------------ combat decisions
export function chooseAttackers(g: Game, p: Player): Perm[] {
  const opp = g.players[g.opp(p.id)];
  const mine = myCreatures(g, p.id).filter(x => !x.tapped && (!x.sick || g.has(x, 'Haste')) && !g.cantAttack(x) && g.statsOf(x).power > 0);
  if (!mine.length) return [];
  const blockers = myCreatures(g, opp.id).filter(b => !b.tapped && !g.cantBlock(b));
  const chosen: Perm[] = [];
  for (const a of mine) {
    const possible = blockers.filter(b => canBlock(g, b, a));
    if (possible.length < g.minBlockers(a)) { chosen.push(a); continue; }
    let ok = true;
    for (const b of possible) {
      const r = duel(g, a, b);
      if (r.blockerKills && !r.blockerDies) { ok = false; break; }
      if (r.blockerKills && r.blockerDies && permValue(g, a) > permValue(g, b) + (p.style === 'aggro' ? 1.5 : 0)) { ok = false; break; }
    }
    if (ok) chosen.push(a);
  }
  // alpha strike if it is lethal even after their best blocks soak the biggest hitters
  const powers = mine.map(x => g.statsOf(x).power).sort((a, b) => b - a);
  const soak = Math.min(blockers.length, powers.length);
  const through = powers.slice(soak).reduce((a, b) => a + b, 0);
  if (through >= opp.life) return mine;
  // keep enough defenders home if their crack-back would be lethal
  const theirPower = myCreatures(g, opp.id).map(x => Math.max(0, g.statsOf(x).power)).sort((a, b) => b - a);
  let threat = theirPower.reduce((a, b) => a + b, 0);
  if (threat >= p.life) {
    const home = mine.filter(x => !chosen.includes(x) || !g.has(x, 'Vigilance'));
    let stay = home.filter(x => !chosen.includes(x)).length;
    const keep = new Set<Perm>();
    const byToughness = chosen.filter(x => !g.has(x, 'Vigilance')).sort((a, b) => g.statsOf(b).toughness - g.statsOf(a).toughness);
    threat -= theirPower.slice(0, stay).reduce((a, b) => a + b, 0);
    for (const x of byToughness) {
      if (threat < p.life) break;
      keep.add(x); threat -= theirPower[stay] ?? 0; stay++;
    }
    return chosen.filter(x => !keep.has(x));
  }
  return chosen;
}

export function chooseBlocks(g: Game, defender: Player, attackers: Perm[]): Map<Perm, Perm[]> {
  const blocks = new Map<Perm, Perm[]>();
  const avail = myCreatures(g, defender.id).filter(b => !b.tapped && !g.cantBlock(b));
  const used = new Set<Perm>();
  const pw = (x: Perm) => Math.max(0, g.statsOf(x).power) * (g.has(x, 'Double Strike') ? 2 : 1);
  let incoming = attackers.reduce((a, x) => a + pw(x), 0);
  const sorted = [...attackers].sort((a, b) => pw(b) - pw(a));
  for (const a of sorted) {
    if (g.minBlockers(a) > 1) continue;
    const opts = avail.filter(b => !used.has(b) && canBlock(g, b, a)).map(b => ({ b, r: duel(g, a, b), v: permValue(g, b) }));
    if (!opts.length) continue;
    const good = opts.filter(o => o.r.blockerKills && !o.r.blockerDies).sort((x, y) => x.v - y.v)[0];
    const trade = opts.filter(o => o.r.blockerKills && o.r.blockerDies && permValue(g, a) >= o.v - (defender.style === 'control' ? 1 : 0.3)).sort((x, y) => x.v - y.v)[0];
    const safe = opts.filter(o => !o.r.blockerDies).sort((x, y) => x.v - y.v)[0];
    const pick = good ?? trade ?? safe;
    if (pick) {
      blocks.set(a, [pick.b]); used.add(pick.b);
      const trampleOver = g.has(a, 'Trample') ? Math.max(0, pw(a) - g.statsOf(pick.b).toughness) : 0;
      incoming -= pw(a) - trampleOver;
    }
  }
  // chump if we would otherwise die
  for (const a of sorted) {
    if (incoming < defender.life) break;
    if (blocks.has(a)) continue;
    const need = g.minBlockers(a);
    if (need > g.maxBlockers(a)) continue;
    const opts = avail.filter(b => !used.has(b) && canBlock(g, b, a)).sort((x, y) => permValue(g, x) - permValue(g, y));
    if (opts.length < need) continue;
    const bs = opts.slice(0, need);
    blocks.set(a, bs); bs.forEach(b => used.add(b));
    const trampleOver = g.has(a, 'Trample') ? Math.max(0, pw(a) - bs.reduce((s, b) => s + g.statsOf(b).toughness, 0)) : 0;
    incoming -= pw(a) - trampleOver;
  }
  return blocks;
}

function pumpOf(g: Game, card: CardInst, pid: number) {
  const e = card.def.spell?.effect;
  if (!e || !card.def.types.includes('Instant') && !card.def.keywords.includes('Flash')) return undefined;
  const ctx: Ctx = { p: pid, card, x: 0, kicked: false, targets: [] };
  if (e.api === 'Pump' && !isHarmful(e) && e.params.ValidTgts) return { p: g.amount(e.params.NumAtt, ctx), t: g.amount(e.params.NumDef, ctx), kw: (e.params.KW ?? '').split(' & ').filter(Boolean) };
  if (e.api === 'PutCounter' && (e.params.CounterType ?? 'P1P1') === 'P1P1' && e.params.ValidTgts) { const n = g.amount(e.params.CounterNum ?? '1', ctx); return { p: n, t: n, kw: [] as string[] }; }
  return undefined;
}

export function combatTricks(g: Game, ap: Player, dp: Player, attackers: Perm[], blocks: Map<Perm, Perm[]>) {
  const none = { p: 0, t: 0, kw: [] as string[] };
  // attacker: save or win a blocked fight, or push lethal through
  const tryTrick = (pl: Player, want: (pump: { p: number; t: number; kw: string[] }) => Perm | undefined) => {
    for (const card of pl.hand) {
      const pump = pumpOf(g, card, pl.id);
      if (!pump || !g.canCast(pl.id, card)) continue;
      const target = want(pump);
      if (!target) continue;
      withHint({ perm: target }, () => g.castSpell(pl.id, card));
      return true;
    }
    return false;
  };
  tryTrick(ap, pump => {
    const unblocked = attackers.filter(a => g.bf.includes(a) && !(blocks.get(a)?.length));
    const through = unblocked.reduce((s, a) => s + g.statsOf(a).power, 0);
    if (unblocked.length && through < dp.life && through + pump.p >= dp.life) return unblocked[0];
    for (const a of attackers) {
      const bs = blocks.get(a);
      if (!bs || bs.length !== 1 || !g.bf.includes(a)) continue;
      const before = duel(g, a, bs[0]); const after = duel(g, a, bs[0], pump);
      if ((before.blockerKills && !after.blockerKills) || (!before.blockerDies && after.blockerDies && !after.blockerKills)) return a;
    }
    return undefined;
  });
  tryTrick(dp, pump => {
    for (const [a, bs] of blocks) {
      if (bs.length !== 1 || !g.bf.includes(a) || !g.bf.includes(bs[0])) continue;
      const before = duel(g, a, bs[0]); const after = duel(g, a, bs[0], none, pump);
      if ((before.blockerDies && !after.blockerDies) || (!before.blockerKills && after.blockerKills && !after.blockerDies)) return bs[0];
    }
    return undefined;
  });
}

// ------------------------------------------------------------------ choices
export function chooseDiscard(g: Game, p: Player): CardInst {
  const lands = p.hand.filter(isLandCard);
  if (lands.length && landsOnBf(g, p.id) + lands.length > 6) return lands[0];
  return p.hand.reduce((a, b) => (cardValue(g, p, a) <= cardValue(g, p, b) ? a : b), p.hand[0]);
}

export function bestCardInHand(g: Game, pl: Player): CardInst {
  const spells = pl.hand.filter(c => !isLandCard(c));
  const pool = spells.length ? spells : pl.hand;
  return pool.reduce((a, b) => (cardValue(g, pl, a) >= cardValue(g, pl, b) ? a : b), pool[0]);
}

export function worstPermanent(g: Game, opts: Perm[]): Perm {
  return opts.reduce((a, b) => (permValue(g, a) <= permValue(g, b) ? a : b));
}

export function scry(g: Game, p: Player, n: number, surveil: boolean) {
  const top = p.library.splice(Math.max(0, p.library.length - n), n);
  const lands = landsOnBf(g, p.id), landsTotal = lands + p.hand.filter(isLandCard).length;
  const keep: CardInst[] = [], away: CardInst[] = [];
  for (const c of top) {
    const want = isLandCard(c) ? landsTotal < 5 : c.def.mv <= Math.max(lands, landsTotal) + 1;
    (want ? keep : away).push(c);
  }
  if (surveil) p.graveyard.push(...away); else p.library.unshift(...away);
  p.library.push(...keep);
}

/** "Choose a creature type": the most common one among our creatures (board, hand, library, command zone). */
export function chooseCreatureType(g: Game, pid: number): string | undefined {
  const p = g.players[pid];
  const counts = new Map<string, number>();
  for (const x of [...g.bf.filter(b => b.controller === pid), ...p.hand, ...p.library, ...p.graveyard, ...p.command])
    if (x.def.types.includes('Creature')) for (const t of x.def.subtypes) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** "Choose a card name" (Disruptor Flute): the opponent's commander, otherwise their best nonland card. */
export function chooseCardName(g: Game, pid: number): string | undefined {
  const o = g.players[g.opp(pid)];
  const cmd = o.command[0] ?? g.bf.find(x => x.isCommander && x.owner === o.id);
  if (cmd) return cmd.def.name;
  const pool = [...o.hand, ...o.library].filter(c => !c.def.types.includes('Land'));
  return pool.length ? pool.reduce((a, b) => (cardValue(g, o, a) >= cardValue(g, o, b) ? a : b)).def.name : undefined;
}

export function chooseSearch(g: Game, p: Player, opts: CardInst[], dest: string): CardInst {
  void dest;
  if (opts.every(isLandCard)) {
    const need = neededColor(g, p);
    return opts.find(c => c.def.land?.produces.includes(need) && c.def.supertypes.includes('Basic')) ?? opts.find(c => c.def.land?.produces.includes(need)) ?? opts[0];
  }
  return opts.reduce((a, b) => (cardValue(g, p, a) >= cardValue(g, p, b) ? a : b));
}
