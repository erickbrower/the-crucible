// The three Arena formats the Crucible supports, how to recognise a deck's format, and which gauntlet it faces.
//   standard        60+ cards, up to 4 copies, 20 life
//   standard-brawl  commander + 59, singleton, Standard-legal cards, 25 life
//   brawl           commander + 99, singleton, any Arena card, 25 life (Arena's "Brawl" / Untapped's Historic
//                   and Competitive Brawl)
import type { DeckList } from '../engine/state.js';

export type Format = 'standard' | 'standard-brawl' | 'brawl';
export const FORMATS: Format[] = ['standard', 'standard-brawl', 'brawl'];

export const FORMAT_LABEL: Record<Format, string> = {
  'standard': 'Standard',
  'standard-brawl': 'Standard Brawl',
  'brawl': 'Brawl',
};

/** Expected deck size including the commander. */
export const FORMAT_SIZE: Record<Format, number> = { 'standard': 60, 'standard-brawl': 60, 'brawl': 100 };

/** Brawl decks split at 80 cards: Arena's Standard Brawl is 60, Brawl is 100. */
export function deckFormat(deck: Pick<DeckList, 'commander' | 'main'>): Format {
  if (!deck.commander) return 'standard';
  return deck.main.length + 1 >= 80 ? 'brawl' : 'standard-brawl';
}

/** Game rules the engine applies: both Brawl formats play 1v1 at 25 life with commander tax. */
export function engineRules(f: Format): 'standard' | 'brawl' {
  return f === 'standard' ? 'standard' : 'brawl';
}

/** Accepts the format names people actually type: "standard-brawl", "sbrawl", "historic-brawl", "100" ... */
export function parseFormat(s: string): Format {
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k === 'standard' || k === 'std') return 'standard';
  if (['standardbrawl', 'sbrawl', 'stdbrawl', '60'].includes(k)) return 'standard-brawl';
  if (['brawl', 'historicbrawl', 'competitivebrawl', 'hbrawl', '100'].includes(k)) return 'brawl';
  throw new Error(`Unknown format "${s}". Use standard, standard-brawl or brawl.`);
}

/** Every format has its own opponents: like against like. */
export const gauntletDir = (f: Format) => `decks/gauntlet/${f}`;

/** Standard and Standard Brawl only allow cards from Standard sets. */
export const needsStandardLegal = (f: Format) => f !== 'brawl';
