import { describe, it, expect } from 'vitest';
import { applySwap } from '../src/ui/analysis.js';
import { parseCollection, splitCsvLine } from '../src/ui/collection.js';

describe('applySwap', () => {
  const deck = 'Name Test\nCommander\n1 Eddie Brock\n\nDeck\n4 Shock (FDN) 82\n1 Murder\n20 Mountain\n\nSideboard\n2 Murder\n';

  it('replaces every copy when the whole count is swapped', () => {
    expect(applySwap(deck, 'Murder', 'Stab', 1)).toContain('\n1 Stab\n20 Mountain');
    expect(applySwap(deck, 'Murder', 'Stab', 1)).toContain('Sideboard\n2 Murder');   // sideboard untouched
  });

  it('splits a playset when only some copies are swapped', () => {
    const out = applySwap(deck, 'Shock', 'Burst Lightning', 2);
    expect(out).toContain('\n2 Shock\n2 Burst Lightning\n');
  });

  it('never touches the commander and rejects cards not in the main deck', () => {
    expect(() => applySwap(deck, 'Eddie Brock', 'Stab', 1)).toThrow();
  });
});

describe('collection CSV', () => {
  it('handles quoted names with commas', () => {
    expect(splitCsvLine('"Gollum, Riddle Master",Black,Mythic,4')).toEqual(['Gollum, Riddle Master', 'Black', 'Mythic', '4']);
  });

  it('reads counts, rarity and Standard legality', () => {
    const cards = parseCollection('Name,Color,Rarity,Count,StandardLegal,Rotates2027\nMurder,Black,Common,4,Yes,Yes\n"Gix, Yawgmoth Praetor",Black,Mythic,1,No,\n');
    expect(cards).toEqual([
      { name: 'Murder', rarity: 'Common', count: 4, standardLegal: true, rotates: true },
      { name: 'Gix, Yawgmoth Praetor', rarity: 'Mythic', count: 1, standardLegal: false, rotates: false },
    ]);
  });
});
