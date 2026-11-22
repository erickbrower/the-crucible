// The three Arena formats the Crucible supports, how to recognise a deck's format, and which gauntlet it faces.
//   standard        60+ cards, up to 4 copies, 20 life
//   standard-brawl  commander + 59, singleton, Standard-legal cards, 25 life
//   brawl           commander + 99, singleton, any Arena card, 25 life (Arena's "Brawl" / Untapped's Historic
//                   and Competitive Brawl)
//   commander       paper Commander (EDH): commander + 99, singleton, any card not on the Commander banned list,
//                   40 life, 21 combat damage from one commander loses. The engine is two-player, so this is
//                   1v1 Commander at 40 life (no multiplayer politics, no table of three opponents).
import type { DeckList } from '../engine/state.js';

export type Format = 'standard' | 'standard-brawl' | 'brawl' | 'commander';
export const FORMATS: Format[] = ['standard', 'standard-brawl', 'brawl', 'commander'];

export const FORMAT_LABEL: Record<Format, string> = {
  'standard': 'Standard',
  'standard-brawl': 'Standard Brawl',
  'brawl': 'Brawl',
  'commander': 'Commander (paper, 1v1 at 40 life)',
};

/** Expected deck size including the commander. */
export const FORMAT_SIZE: Record<Format, number> = { 'standard': 60, 'standard-brawl': 60, 'brawl': 100, 'commander': 100 };

/** Brawl decks split at 80 cards: Arena's Standard Brawl is 60, Brawl is 100. A "# format: commander" comment marks paper Commander. */
export function deckFormat(deck: Pick<DeckList, 'commander' | 'main'> & { format?: Format }): Format {
  if (deck.format) return deck.format;
  if (!deck.commander) return 'standard';
  return deck.main.length + 1 >= 80 ? 'brawl' : 'standard-brawl';
}

/** Game rules the engine applies: both Brawl formats play 1v1 at 25 life with commander tax; Commander at 40 with commander damage. */
export function engineRules(f: Format): 'standard' | 'brawl' | 'commander' {
  return f === 'standard' ? 'standard' : f === 'commander' ? 'commander' : 'brawl';
}

/** Accepts the format names people actually type: "standard-brawl", "sbrawl", "historic-brawl", "100" ... */
export function parseFormat(s: string): Format {
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k === 'standard' || k === 'std') return 'standard';
  if (['standardbrawl', 'sbrawl', 'stdbrawl', '60'].includes(k)) return 'standard-brawl';
  if (['brawl', 'historicbrawl', 'competitivebrawl', 'hbrawl', '100'].includes(k)) return 'brawl';
  if (['commander', 'edh', 'edh1v1', 'paper', 'papercommander', 'duelcommander'].includes(k)) return 'commander';
  throw new Error(`Unknown format "${s}". Use standard, standard-brawl, brawl or commander.`);
}

/** Every format has its own opponents: like against like. */
export const gauntletDir = (f: Format) => `decks/gauntlet/${f}`;

/** Standard and Standard Brawl only allow cards from Standard sets. */
export const needsStandardLegal = (f: Format) => f === 'standard' || f === 'standard-brawl';

/** Starting life the engine uses for each format. */
export const startingLife = (f: 'standard' | 'brawl' | 'commander') => f === 'commander' ? 40 : f === 'brawl' ? 25 : 20;
