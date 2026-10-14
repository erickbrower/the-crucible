// Additional combat phases (Forge AddPhase): Aurelia, the Warleader and Bumi, Unleashed.
import { it, expect } from 'vitest';
import { loadCard } from '../src/cards/compile.js';
import { d, setup, perm, log } from './helpers.js';

d('additional combat phases', () => {
  it('Aurelia untaps the team and attacks again in a second combat (her trigger only fires the first time)', () => {
    const g = setup({ bf: ['Aurelia, the Warleader', 'Raging Goblin'] });
    g.combatPhases();
    // 3 (Aurelia) + 1 (Goblin) twice
    expect(g.players[1].life).toBe(20 - 8);
    expect(log(g).match(/an additional combat phase follows/g)?.length).toBe(1);
    expect(perm(g, 0, 'Aurelia, the Warleader').attacksThisTurn).toBe(2);
    expect(perm(g, 0, 'Raging Goblin').attacking).toBe(false);   // combat is over
  });

  it('leaves no extra combats queued for a later turn', () => {
    const g = setup({ bf: ['Aurelia, the Warleader'] });
    g.combatPhases();
    expect(g.extraCombats).toEqual([]);
  });

  it('Bumi\'s extra combat only lets land creatures attack', () => {
    // Bumi connects, untaps lands; in the extra combat only the earthbent land may attack
    const g = setup({ bf: ['Bumi, Unleashed', 'Forest', 'Mountain', 'Serra Angel'] });
    const forest = perm(g, 0, 'Forest');
    forest.def = { ...forest.def, types: [...forest.def.types, 'Creature'], power: 2, toughness: 2 };
    g.combatPhases();
    // first combat: Bumi 5 + Angel 4 + Forest 2; second: only the Forest (the vigilant Angel is untapped but can't attack)
    expect(g.players[1].life).toBe(20 - 11 - 2);
    expect(perm(g, 0, 'Serra Angel').attacksThisTurn).toBe(1);
    expect(log(g)).toMatch(/additional combat phase/);
  });

  it('reports AddPhase as modeled', () => {
    expect(loadCard('Aurelia, the Warleader').notes).toEqual([]);
    expect(loadCard('Bumi, Unleashed').notes).toEqual([]);
  });
});
