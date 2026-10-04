import { CardDef, Color } from '../cards/model.js';

/** A card in a hidden or public non-battlefield zone. */
export interface CardInst {
  id: number;
  def: CardDef;
  owner: number;
  isCommander?: boolean;
  token?: boolean;
}

/** A permanent on the battlefield. Shares `id` with the CardInst it came from. */
export interface Perm extends CardInst {
  controller: number;
  tapped: boolean;
  sick: boolean;            // summoning sick
  token: boolean;
  counters: Record<string, number>;
  damage: number;
  deathtouched: boolean;
  tempP: number;
  tempT: number;
  tempKw: string[];
  attachedTo?: number;      // aura/equipment host
  exiledUntilLeaves: CardInst[];
  transformed: boolean;
  enteredTurn: number;
  attacking?: boolean;
  blocking?: boolean;
  loyaltyUsedTurn?: number;
  chosenType?: string;
  noUntap?: boolean;
}

export interface DeckList {
  name: string;
  main: CardDef[];
  commander?: CardDef;
}

export interface Player {
  id: number;
  name: string;
  life: number;
  library: CardInst[];
  hand: CardInst[];
  graveyard: CardInst[];
  exile: CardInst[];
  command: CardInst[];
  landsPlayed: number;
  commanderTax: number;
  lost: boolean;
  identity: Color[];
  spellsThisTurn: number;
  noncreatureSpellsThisTurn: number;
  drawnThisTurn: number;
  lifeGainedThisTurn: number;
  attackedThisTurn: boolean;
  creaturesDiedThisTurn: number;
  mulligans: number;
  style: 'aggro' | 'midrange' | 'control';
}

export interface Stats {
  cardsDrawn: number[];
  spellsCast: number[];
  countered: number[];
  removalUsed: number[];
  damageDealt: number[];
  commanderCasts: number[];
}

export interface Rng { next(): number; int(n: number): number; shuffle<T>(a: T[]): T[] }

export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  const next = () => {
    // mulberry32
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    shuffle<T>(a: T[]): T[] {
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    },
  };
}
