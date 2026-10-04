// Core card model. Cards are compiled from Forge card scripts (see forge.ts / compile.ts).

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];

/** One mana symbol in a cost. `options` lists colors that can pay it; `generic2` marks {2/W}-style pips. */
export interface Pip {
  options: Color[];      // e.g. ['R'] or ['U','R'] for hybrid
  phyrexian?: boolean;   // may pay 2 life instead
  generic2?: boolean;    // may pay {2} instead
}

export interface ManaCost {
  generic: number;
  pips: Pip[];
  x: number;             // number of X symbols
}

export interface Effect {
  api: string;                         // Forge API name: DealDamage, Destroy, Draw, Token, ...
  params: Record<string, string>;
  sub?: Effect;                        // SubAbility chain
  choices?: Effect[];                  // Charm modes
}

export interface Cost {
  mana: ManaCost;
  tap: boolean;
  sacSelf: boolean;
  sac?: { n: number; filter: string };
  discard?: number;
  payLife?: number;
  loyalty?: number;                    // +N / -N for planeswalker abilities
  supported: boolean;
}

export interface Ability {
  kind: 'spell' | 'activated' | 'mana';
  effect: Effect;
  cost: Cost;
  planeswalker?: boolean;
  ultimate?: boolean;
  sorcerySpeed?: boolean;
  description?: string;
}

export interface Trigger {
  mode: string;                        // ChangesZone, SpellCast, Attacks, DamageDone, Phase, LifeGained ...
  params: Record<string, string>;
  effect?: Effect;
}

export interface StaticAbility {
  mode: string;                        // Continuous, CantAttack, CantBlock, ...
  params: Record<string, string>;
}

export interface CardDef {
  name: string;
  cost: ManaCost;
  mv: number;
  types: string[];        // card types: Creature, Instant, Land ...
  subtypes: string[];
  supertypes: string[];   // Legendary, Basic, Snow
  colors: Color[];
  power?: number;
  toughness?: number;
  ptStar?: boolean;
  loyalty?: number;
  keywords: string[];     // Flying, Haste, Prowess, Kicker:4, Ward:2, Enchant:Creature ...
  spell?: Ability;        // what happens when the card resolves as an instant/sorcery
  abilities: Ability[];   // activated + mana abilities
  triggers: Trigger[];
  statics: StaticAbility[];
  replacements: Record<string, string>[];
  svars: Record<string, string>;
  oracle: string;
  land?: LandInfo;
  notes: string[];        // coverage notes: things the engine ignores or approximates
  back?: CardDef;         // transformed face (SetState Transform)
  kicker?: ManaCost;
  altAdditional?: { sac: string; orMana: ManaCost };  // e.g. Eaten Alive
  affinity?: string;      // cost reduction per permanent of this type
}

export interface LandInfo {
  produces: Color[];      // colors it can tap for (empty = colorless only)
  entersTapped: 'never' | 'always' | 'unlessTwoOthers' | 'unlessPayLife' | 'unlessLowLife';
  fetchBasic?: boolean;   // Evolving Wilds style
  colorless?: boolean;
}

export const isType = (c: CardDef, t: string) => c.types.includes(t);
export const isPermanentCard = (c: CardDef) =>
  ['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].some(t => c.types.includes(t));

export const cantBeCountered = (c: CardDef) => /This spell can't be countered/i.test(c.oracle);
