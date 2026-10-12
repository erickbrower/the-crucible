// Deck inspection, per-card impact and upgrade candidates for the UI.
import { parseDeckText, buildDeck, deckCoverage, LoadedDeck } from '../sim/deck.js';
import { loadCard, coverage } from '../cards/compile.js';
import type { CardDef, Color } from '../cards/model.js';
import type { CardStat } from '../sim/match.js';
import type { OwnedCard } from './collection.js';
import { Format, FORMAT_LABEL, FORMAT_SIZE, deckFormat, needsStandardLegal } from '../sim/format.js';
import { isLegal } from '../cards/formats.js';

export type { Format };

export interface DeckInfo {
  name: string;
  format: Format;
  formatLabel: string;
  commander?: string;
  size: number;
  expectedSize: number;
  colors: Color[];
  missing: string[];                         // not found in Forge data
  illegal: string[];                         // not legal in the deck's format (Standard sets and bans)
  duplicates: string[];                      // more than one copy in a singleton format
  unmodeled: { name: string; notes: string[] }[];
  distinct: number;
}

const BASIC = /^(snow-covered )?(plains|island|swamp|mountain|forest|wastes)$/i;

export function inspectDeck(text: string, fallbackName = 'My deck'): { info: DeckInfo; deck: LoadedDeck } {
  const parsed = parseDeckText(text, fallbackName);
  const deck = buildDeck(parsed);
  const cov = deckCoverage(deck.list);
  const format = deckFormat(deck.list);
  const names = [...new Set([parsed.commander, ...parsed.main.map(c => c.name)].filter(Boolean) as string[])];
  const copies = new Map<string, number>();
  for (const c of parsed.main) copies.set(c.name, (copies.get(c.name) ?? 0) + c.count);
  return {
    deck,
    info: {
      name: deck.list.name,
      format,
      formatLabel: FORMAT_LABEL[format],
      commander: deck.list.commander?.name,
      size: deck.size,
      expectedSize: FORMAT_SIZE[format],
      colors: deckColors(deck),
      missing: deck.missing,
      illegal: needsStandardLegal(format) ? names.filter(n => !deck.missing.includes(n) && !isLegal(n)) : [],
      duplicates: format === 'standard' ? [] : [...copies].filter(([n, k]) => k > 1 && !BASIC.test(n)).map(([n]) => n),
      unmodeled: [...cov].filter(([, n]) => n.length).map(([name, notes]) => ({ name, notes })),
      distinct: cov.size,
    },
  };
}

/** Brawl: the commander's colors. Standard: every color among the nonland cards. */
export function deckColors(d: LoadedDeck): Color[] {
  if (d.list.commander) return [...d.list.commander.colors];
  const s = new Set<Color>();
  for (const c of d.list.main) if (!c.types.includes('Land')) c.colors.forEach(x => s.add(x));
  return [...s];
}

export interface CardImpact {
  name: string;
  copies: number;
  isLand: boolean;
  isCommander: boolean;
  seen: number;        // games it was in hand
  seenWR: number;      // win rate in those games (0..1)
  notSeenWR: number;   // win rate in the other games
  impact: number;      // seenWR - notSeenWR, in points (-100..100)
  castRate: number;    // share of "seen" games where it was actually cast/played
  modeled: boolean;    // false = the engine ignores or approximates part of it
}

/**
 * Win rate when a card is drawn vs when it is not (the same idea as 17lands' "improvement when drawn").
 * Longer games show more cards, so treat it as a pointer to test, not a verdict.
 */
export function cardImpacts(deck: LoadedDeck, cards: Record<string, CardStat>, games: number, wins: number): CardImpact[] {
  const copies = new Map<string, { def: CardDef; n: number }>();
  for (const d of deck.list.main) {
    const e = copies.get(d.name);
    if (e) e.n++; else copies.set(d.name, { def: d, n: 1 });
  }
  const out: CardImpact[] = [];
  const cmd = deck.list.commander;
  if (cmd) {
    const s = cards[cmd.name] ?? { seen: 0, seenWins: 0, cast: 0, castWins: 0 };
    const other = games - s.cast;
    out.push({
      name: cmd.name, copies: 1, isLand: false, isCommander: true, seen: s.cast,
      seenWR: s.cast ? s.castWins / s.cast : 0, notSeenWR: other ? (wins - s.castWins) / other : 0,
      impact: 0, castRate: 1, modeled: coverage(cmd).ok,
    });
    // No impact for the commander: games where it never got cast are mostly fast losses, which says little about the card.
  }
  for (const [name, { def, n }] of copies) {
    const s = cards[name] ?? { seen: 0, seenWins: 0, cast: 0, castWins: 0 };
    const other = games - s.seen;
    const seenWR = s.seen ? s.seenWins / s.seen : 0;
    const notSeenWR = other ? (wins - s.seenWins) / other : 0;
    out.push({
      name, copies: n, isLand: def.types.includes('Land'), isCommander: false, seen: s.seen,
      seenWR, notSeenWR, impact: 100 * (seenWR - notSeenWR), castRate: s.seen ? Math.min(1, s.cast / s.seen) : 0,
      modeled: coverage(def).ok && (!def.back || coverage(def.back).ok),
    });
  }
  // Every card looks good when drawn because drawing more cards means a longer game. Center impact on the
  // deck's typical nonland card (weighted by games drawn) so the numbers read as better or worse than average.
  const pool = out.filter(c => !c.isLand && !c.isCommander && c.seen);
  const weight = pool.reduce((a, c) => a + c.seen, 0);
  const typical = weight ? pool.reduce((a, c) => a + c.impact * c.seen, 0) / weight : 0;
  for (const c of out) if (!c.isCommander) c.impact -= typical;
  return out.sort((a, b) => a.impact - b.impact);
}

export interface UpgradeOptions {
  cuts: number;              // how many weak cards to try replacing
  perCut: number;            // candidates screened per cut card
  standardOnly: boolean;
  modeledOnly: boolean;
  minSeen: number;           // ignore cards drawn in fewer games than this (too noisy)
}

export interface Swap { cut: string; add: string; copies: number; rarity: string; owned: number; addModeled: boolean }

const RARITY_RANK: Record<string, number> = { Mythic: 4, Rare: 3, Uncommon: 2, Common: 1 };

/** Picks the weakest nonland cards and, for each, owned cards in the deck's colors that fill a similar slot. */
export function pickSwaps(deck: LoadedDeck, impacts: CardImpact[], owned: OwnedCard[], o: UpgradeOptions): { cuts: CardImpact[]; swaps: Swap[] } {
  const inDeck = new Set([deck.list.commander?.name, ...deck.list.main.map(c => c.name)].filter(Boolean).map(n => n!.toLowerCase()));
  const colors = new Set(deckColors(deck));
  const brawl = !!deck.list.commander;
  // Cards the engine can't fully play look weaker than they are, so they are not cut candidates by default.
  const cuts = impacts.filter(c => !c.isLand && !c.isCommander && c.seen >= o.minSeen && (c.modeled || !o.modeledOnly)).slice(0, o.cuts);

  // Owned cards that could go in this deck at all.
  const pool: { def: CardDef; card: OwnedCard }[] = [];
  for (const card of owned) {
    if (card.count < 1 || inDeck.has(card.name.toLowerCase())) continue;
    if (o.standardOnly && !card.standardLegal) continue;
    let def: CardDef;
    try { def = loadCard(card.name); } catch { continue; }
    if (def.types.includes('Land')) continue;
    if (!def.colors.every(c => colors.has(c))) continue;
    const modeled = coverage(def).ok && (!def.back || coverage(def.back).ok);
    if (o.modeledOnly && !modeled) continue;
    pool.push({ def, card });
  }

  const swaps: Swap[] = [];
  for (const cut of cuts) {
    const cutDef = loadCard(cut.name);
    const creature = cutDef.types.includes('Creature');
    const scored = pool
      .map(p => {
        const sameRole = p.def.types.includes('Creature') === creature;
        const mvGap = Math.abs(p.def.mv - cutDef.mv);
        return { p, score: (sameRole ? 0 : 3) + mvGap * 1.5 - (RARITY_RANK[p.card.rarity] ?? 0) * 0.25 };
      })
      .filter(x => Math.abs(x.p.def.mv - cutDef.mv) <= 2)
      .sort((a, b) => a.score - b.score || a.p.def.name.localeCompare(b.p.def.name))
      .slice(0, o.perCut);
    for (const { p } of scored) {
      const copies = brawl ? 1 : Math.min(cut.copies, p.card.count, 4);
      swaps.push({ cut: cut.name, add: p.def.name, copies, rarity: p.card.rarity, owned: p.card.count,
        addModeled: coverage(p.def).ok && (!p.def.back || coverage(p.def.back).ok) });
    }
  }
  return { cuts, swaps };
}

/**
 * Rewrites deck text with `copies` of `cut` replaced by `add`, keeping every other line as it was.
 * A 4-of cut for 2 copies becomes "2 Cut" + "2 Add".
 */
export function applySwap(text: string, cut: string, add: string, copies: number): string {
  const lines = text.split(/\r?\n/);
  let section = 'deck';
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim().toLowerCase();
    if (head === 'commander') { section = 'commander'; continue; }
    if (head === 'deck' || head === 'main' || head === 'maindeck') { section = 'deck'; continue; }
    if (head === 'sideboard' || head === 'companion' || head === 'about') { section = 'skip'; continue; }
    if (section !== 'deck') continue;
    const m = lines[i].trim().match(/^(\d+)x?\s+(.+?)(?:\s+\([A-Z0-9]+\)(?:\s+\S+)?)?$/);
    if (!m || m[2].trim().toLowerCase() !== cut.toLowerCase()) continue;
    const left = +m[1] - copies;
    const addLine = `${copies} ${add}`;
    lines.splice(i, 1, ...(left > 0 ? [`${left} ${m[2].trim()}`, addLine] : [addLine]));
    return lines.join('\n');
  }
  throw new Error(`"${cut}" is not in the main deck`);
}
