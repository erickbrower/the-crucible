import { describe, it, expect } from 'vitest';
import { parseDeckText } from '../src/sim/deck.js';
import { parseManaCost, parseCost } from '../src/cards/compile.js';
import { matches } from '../src/engine/filters.js';
import type { CardDef } from '../src/cards/model.js';

describe('deck parser', () => {
  it('reads commander, deck, set codes and comments', () => {
    const d = parseDeckText(`# comment\nCommander\n1 Eddie Brock\n\nDeck\n4 Shock (FDN) 82\n2 Swiftwater Cliffs\nSideboard\n1 Negate\n`);
    expect(d.commander).toBe('Eddie Brock');
    expect(d.main).toEqual([{ count: 4, name: 'Shock' }, { count: 2, name: 'Swiftwater Cliffs' }]);
  });
});

describe('mana costs', () => {
  it('parses generic, colored, hybrid and X', () => {
    const c = parseManaCost('X 2 R U/R');
    expect(c.generic).toBe(2); expect(c.x).toBe(1);
    expect(c.pips.map(p => p.options)).toEqual([['R'], ['U', 'R']]);
  });
  it('parses activation costs', () => {
    const c = parseCost('2 B T Sac<1/Creature.Other/another creature>');
    expect(c.tap).toBe(true); expect(c.sac).toEqual({ n: 1, filter: 'Creature.Other' });
    expect(c.mana.generic).toBe(2);
  });
});

describe('filters', () => {
  const bear = { name: 'Bear', types: ['Creature'], subtypes: ['Bear'], supertypes: [], colors: ['G'], mv: 2, power: 2, toughness: 2, keywords: [] } as unknown as CardDef;
  const subj = (controller: number) => ({ kind: 'card' as const, def: bear, controller, id: 7, power: 2, toughness: 2, keywords: [] });
  it('handles controller, stats and negation', () => {
    expect(matches('Creature.OppCtrl+powerLE2', subj(1), { you: 0 })).toBe(true);
    expect(matches('Creature.YouCtrl', subj(1), { you: 0 })).toBe(false);
    expect(matches('Creature.nonGreen', subj(1), { you: 0 })).toBe(false);
    expect(matches('Creature.Other', subj(0), { you: 0, sourceId: 7 })).toBe(false);
    expect(matches('Player', { kind: 'player', controller: 1 }, { you: 0 })).toBe(true);
    // subtype words as properties, including type groups like "outlaw"
    expect(matches('Creature.!Outlaw', subj(1), { you: 0 })).toBe(true);
    expect(matches('Creature.Bear', subj(1), { you: 0 })).toBe(true);
    const rogue = { ...bear, subtypes: ['Human', 'Rogue'] } as CardDef;
    expect(matches('Creature.!Outlaw', { ...subj(1), def: rogue }, { you: 0 })).toBe(false);
  });
});
