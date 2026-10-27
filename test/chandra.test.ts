// Chandra, Torch of Defiance: "cast the exiled card" (Play), loyalty mana as a ritual, and emblem triggers.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { loadCard } from '../src/cards/compile.js';
import { d, setup, perm, onBf, log } from './helpers.js';

const CHANDRA = 'Chandra, Torch of Defiance';
const ability = (g: ReturnType<typeof setup>, i: number) => {
  const c = perm(g, 0, CHANDRA);
  return { c, ab: c.def.abilities.filter(a => a.planeswalker)[i] };
};

d('Chandra, Torch of Defiance', () => {
  it('+1: exiles the top card and casts it when we can pay; no damage then', () => {
    const g = setup({ bf: [CHANDRA, 'Mountain'], library: ['Raging Goblin', 'Mountain'] });
    const { c, ab } = ability(g, 0);
    g.resolveEffect(ab.effect, { p: 0, source: c, x: 0, kicked: false, targets: [] });
    expect(log(g)).toMatch(/casts Raging Goblin from exile/);
    expect(g.players[1].life).toBe(20);
  });

  it('+1: if we can\'t cast the exiled card, Chandra deals 2 damage to each opponent', () => {
    const g = setup({ bf: [CHANDRA], library: ['Serra Angel', 'Mountain'] });
    const { c, ab } = ability(g, 0);
    g.resolveEffect(ab.effect, { p: 0, source: c, x: 0, kicked: false, targets: [] });
    expect(g.players[0].exile.map(x => x.def.name)).toContain('Serra Angel');
    expect(g.players[1].life).toBe(18);
  });

  it('+1 {R}{R}: the AI uses it as a ritual to cast a spell it otherwise couldn\'t', () => {
    const g = setup({ hand: ['Shivan Dragon'], bf: [CHANDRA, 'Mountain', 'Mountain', 'Mountain', 'Mountain'] });
    perm(g, 0, CHANDRA).counters.LOYALTY = 4;
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/activates Chandra, Torch of Defiance: Add \{R\}\{R\}/);
    expect(onBf(g, 0, 'Shivan Dragon')).toBe(true);
    expect(perm(g, 0, CHANDRA).counters.LOYALTY).toBe(5);
  });

  it('−7 emblem: whenever we cast a spell, it deals 5 damage', () => {
    const g = setup({ hand: ['Raging Goblin'], bf: [CHANDRA, 'Mountain'] }, { bf: ['Serra Angel'] });
    const { c, ab } = ability(g, 3);
    g.resolveEffect(ab.effect, { p: 0, source: c, x: 0, kicked: false, targets: [] });
    g.castSpell(0, g.players[0].hand[0]);
    const angelGone = !g.bf.some(x => x.def.name === 'Serra Angel');
    expect(angelGone || g.players[1].life === 15).toBe(true);
    expect(loadCard(CHANDRA).notes).toEqual([]);
  });
});
