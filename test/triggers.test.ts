// Trigger conditions: counters filters and "one or more" (once per damage batch) triggers.
import { it, expect } from 'vitest';
import { d, setup, perm, fight } from './helpers.js';

d('one or more creatures with counters (Haliya, Ascendant Cadet)', () => {
  it('does not draw when the damage comes from creatures without +1/+1 counters', () => {
    const g = setup({ bf: ['Haliya, Ascendant Cadet', 'Grizzly Bears'], library: ['Plains', 'Plains'] });
    fight(g, [perm(g, 0, 'Grizzly Bears')]);
    expect(g.players[0].hand).toHaveLength(0);
  });

  it('draws exactly once when several creatures with counters connect', () => {
    const g = setup({ bf: ['Haliya, Ascendant Cadet', 'Grizzly Bears', 'Ordinary Bear'], library: ['Plains', 'Plains', 'Plains'] });
    const a = perm(g, 0, 'Grizzly Bears'), b = perm(g, 0, 'Ordinary Bear');
    a.counters.P1P1 = 1; b.counters.P1P1 = 1;
    // attack with the bears only so Haliya's own attack trigger doesn't add counters
    fight(g, [a, b]);
    expect(g.players[0].hand).toHaveLength(1);
  });
});
