// Animate: manlands and other "becomes a creature" effects.
import { it, expect } from 'vitest';
import { loadCard } from '../src/cards/compile.js';
import { d, setup, perm, log } from './helpers.js';

d('animate', () => {
  it('a manland animates with other lands\' mana, attacks, and is a land again after cleanup', () => {
    // Restless Anchorage: {1}{W}{U}: becomes a 2/3 white and blue Bird creature with flying until end of turn
    const g = setup({ bf: ['Restless Anchorage', 'Plains', 'Island', 'Island'] });
    const land = perm(g, 0, 'Restless Anchorage');
    g.combat();
    expect(log(g)).toMatch(/Restless Anchorage becomes 2\/3 Bird .*Creature until end of turn/);
    expect(g.players[1].life).toBe(18);
    expect(land.tapped).toBe(true);                       // tapped by attacking, not to pay for itself
    g.cleanup();
    expect(land.def.types).toEqual(['Land']);
    expect(land.def.power).toBeUndefined();
  });

  it('stays a land when an untapped blocker would kill it', () => {
    const g = setup({ bf: ['Restless Anchorage', 'Plains', 'Island', 'Island'] }, { bf: ['Serra Angel'] });
    g.combat();
    expect(perm(g, 0, 'Restless Anchorage').def.types).toEqual(['Land']);
    expect(g.players[1].life).toBe(20);
  });

  it('counts plain Animate abilities as modeled', () => {
    expect(loadCard('Restless Anchorage').notes).toEqual([]);
  });
});
