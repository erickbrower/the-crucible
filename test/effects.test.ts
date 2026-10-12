// Temporary statics created by Forge "Effect" abilities.
import { it, expect } from 'vitest';
import { loadCard, compileEffect } from '../src/cards/compile.js';
import type { RawFace } from '../src/cards/forge.js';
import type { Effect } from '../src/cards/model.js';
import { d, setup, perm } from './helpers.js';

/** Compiles one SVar of a card's script into an effect (the same way the card itself would run it). */
function svarEffect(card: string, svar: string): Effect {
  const def = loadCard(card);
  const face = { name: def.name, svars: def.svars, get: () => undefined, all: () => [] } as unknown as RawFace;
  return compileEffect(face, def.svars[svar], []);
}

d('temporary effects', () => {
  it('"can\'t be blocked this turn" applies to the remembered creature only, until cleanup', () => {
    const g = setup({ bf: ['Vampire Gourmand', 'Raging Goblin'] });
    const gourmand = perm(g, 0, 'Vampire Gourmand');
    g.resolveEffect(svarEffect('Vampire Gourmand', 'DBUnblockable'), { p: 0, source: gourmand, x: 0, kicked: false, targets: [] });
    expect(g.unblockable(gourmand)).toBe(true);
    expect(g.unblockable(perm(g, 0, 'Raging Goblin'))).toBe(false);
    g.cleanup();
    expect(g.unblockable(gourmand)).toBe(false);
  });

  it('"creatures without flying can\'t block this turn" (Sundering Eruption)', () => {
    const g = setup({}, { bf: ['Raging Goblin', 'Healer\'s Hawk'] });
    g.resolveEffect(svarEffect('Sundering Eruption', 'CantBlockEffect'), { p: 0, x: 0, kicked: false, targets: [] });
    expect(g.cantBlock(perm(g, 1, 'Raging Goblin'))).toBe(true);
    expect(g.cantBlock(perm(g, 1, "Healer's Hawk"))).toBe(false);
  });

  it('emblems last for the rest of the game (Ajani Resolute: creatures you control get +2/+2)', () => {
    const g = setup({ bf: ['Raging Goblin'] }, { bf: ['Healer\'s Hawk'] });
    const ult = loadCard('Ajani Resolute').abilities.find(a => a.ultimate)!.effect;
    g.resolveEffect(ult, { p: 0, x: 0, kicked: false, targets: [] });
    g.cleanup();
    expect(g.statsOf(perm(g, 0, 'Raging Goblin'))).toMatchObject({ power: 3, toughness: 3 });
    expect(g.statsOf(perm(g, 1, "Healer's Hawk"))).toMatchObject({ power: 1, toughness: 1 });
  });

  it('reports these cards as modeled', () => {
    for (const n of ['Vampire Gourmand', 'Sundering Eruption']) expect(loadCard(n).notes.filter(x => /effect/.test(x))).toEqual([]);
  });
});
