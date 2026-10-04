// Evaluates Forge "Valid" expressions such as "Creature.OppCtrl+powerLE2" or "Permanent.nonLand,Player".
import { CardDef } from '../cards/model.js';

export interface Subject {
  kind: 'card' | 'player';
  def?: CardDef;
  controller: number;      // for players: the player id
  owner?: number;
  token?: boolean;
  id?: number;
  tapped?: boolean;
  attacking?: boolean;
  blocking?: boolean;
  power?: number;
  toughness?: number;
  attachedTo?: number;
  keywords?: string[];
  zone?: string;
}

export interface FilterCtx {
  you: number;             // controller of the source
  sourceId?: number;
  sourceAttachedTo?: number;
  chosenType?: string;
}

const TYPE_WORDS = new Set(['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Instant', 'Sorcery', 'Battle', 'Kindred']);
const COLOR_WORDS: Record<string, string> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };

function cmp(op: string, a: number, b: number) {
  switch (op) {
    case 'LE': return a <= b; case 'GE': return a >= b; case 'LT': return a < b; case 'GT': return a > b;
    case 'EQ': return a === b; case 'NE': return a !== b; default: return true;
  }
}

function matchType(word: string, s: Subject, ctx: FilterCtx): boolean {
  if (s.kind === 'player') {
    if (word === 'Player') return true;
    if (word === 'Opponent') return s.controller !== ctx.you;
    if (word === 'You') return s.controller === ctx.you;
    if (word === 'Any') return true;
    return false;
  }
  const d = s.def!;
  switch (word) {
    case 'Card': case 'Spell': return true;
    case 'Permanent': return d.types.some(t => ['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].includes(t));
    case 'Any': return d.types.includes('Creature') || d.types.includes('Planeswalker') || d.types.includes('Battle');
    case 'Player': case 'Opponent': case 'You': return false;
    case 'ChosenType': return !!ctx.chosenType && (d.subtypes.includes(ctx.chosenType) || hasChangeling(d));
  }
  if (TYPE_WORDS.has(word)) return d.types.includes(word);
  if (word === 'Historic') return d.types.includes('Artifact') || d.supertypes.includes('Legendary') || d.subtypes.includes('Saga');
  return d.subtypes.includes(word) || (d.types.includes('Creature') && hasChangeling(d)) || d.supertypes.includes(word);
}

const hasChangeling = (d: CardDef) => d.keywords.some(k => k === 'Changeling');

function matchProp(prop: string, s: Subject, ctx: FilterCtx): boolean {
  let neg = false;
  if (prop.startsWith('!')) { neg = true; prop = prop.slice(1); }
  const r = matchPropInner(prop, s, ctx);
  return neg ? !r : r;
}

function matchPropInner(prop: string, s: Subject, ctx: FilterCtx): boolean {
  const d = s.def;
  switch (prop) {
    case 'YouCtrl': return s.controller === ctx.you;
    case 'OppCtrl': return s.controller !== ctx.you;
    case 'YouOwn': return (s.owner ?? s.controller) === ctx.you;
    case 'OppOwn': return (s.owner ?? s.controller) !== ctx.you;
    case 'Self': return s.id !== undefined && s.id === ctx.sourceId;
    case 'Other': return s.id === undefined || s.id !== ctx.sourceId;
    case 'token': return !!s.token;
    case 'nonToken': return !s.token;
    case 'tapped': return !!s.tapped;
    case 'untapped': return !s.tapped;
    case 'attacking': return !!s.attacking;
    case 'blocking': return !!s.blocking;
    case 'EnchantedBy': case 'EquippedBy': case 'AttachedBy': return s.id !== undefined && s.id === ctx.sourceAttachedTo;
    case 'Legendary': return !!d?.supertypes.includes('Legendary');
    case 'Basic': return !!d?.supertypes.includes('Basic');
    case 'Colorless': return !!d && d.colors.length === 0;
    case 'MultiColor': return !!d && d.colors.length > 1;
    case 'withFlying': return !!s.keywords?.includes('Flying');
    case 'withoutFlying': return !s.keywords?.includes('Flying');
    case 'Creature': case 'Artifact': case 'Enchantment': case 'Land': case 'Planeswalker': return !!d?.types.includes(prop);
  }
  if (prop.startsWith('non')) {
    const w = prop.slice(3);
    if (w === 'Token') return !s.token;
    if (COLOR_WORDS[w]) return !d?.colors.includes(COLOR_WORDS[w] as never);
    if (s.kind === 'player') return true;
    return !matchType(w, s, ctx);
  }
  if (COLOR_WORDS[prop]) return !!d?.colors.includes(COLOR_WORDS[prop] as never);
  let m = prop.match(/^(power|toughness|cmc)(LE|GE|LT|GT|EQ|NE)(-?\d+)$/);
  if (m) {
    const v = m[1] === 'power' ? (s.power ?? d?.power ?? 0) : m[1] === 'toughness' ? (s.toughness ?? d?.toughness ?? 0) : (d?.mv ?? 0);
    return cmp(m[2], v, +m[3]);
  }
  m = prop.match(/^with(.+)$/);
  if (m) return !!s.keywords?.includes(m[1]);
  // unknown property: be lenient
  return true;
}

export function matches(filter: string | undefined, s: Subject, ctx: FilterCtx): boolean {
  if (!filter) return true;
  for (const clause of filter.split(',')) {
    const c = clause.trim();
    if (!c) continue;
    const dot = c.indexOf('.');
    const typeWord = dot < 0 ? c : c.slice(0, dot);
    const props = dot < 0 ? [] : c.slice(dot + 1).split('+');
    if (!typeWord.split(';').some(w => matchType(w, s, ctx))) continue;
    if (props.every(p => matchProp(p, s, ctx))) return true;
  }
  return false;
}
