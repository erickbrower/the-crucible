// Spree (pay for each mode) and Gift (promise the opponent something for a bonus).
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { d, setup, card, perm, log } from './helpers.js';

d('spree', () => {
  it('each mode costs extra: Final Showdown only destroys everything when {3}{W}{W} more is paid', () => {
    const g = setup({ hand: ['Final Showdown'], bf: ['Plains', 'Plains'] }, { bf: ['Grizzly Bears', 'Grizzly Bears', 'Ordinary Bear'] });
    g.castSpell(0, card(g, 0, 'Final Showdown'));
    expect(g.bf.filter(x => x.controller === 1)).toHaveLength(3);
  });

  it('with enough mana the AI pays for the board wipe (at instant speed, end of their turn)', () => {
    const g = setup({ hand: ['Final Showdown'], bf: ['Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains'] },
      { bf: ['Grizzly Bears', 'Grizzly Bears', 'Ordinary Bear'] });
    g.active = 1;
    AI.endOfTurnWindow(g, g.players[0]);
    expect(log(g)).toMatch(/casts Final Showdown.*spree/);
    expect(g.bf.filter(x => x.controller === 1)).toHaveLength(0);
    expect(g.bf.filter(x => x.def.name === 'Plains' && !x.tapped)).toHaveLength(0);
  });
});

d('gift', () => {
  it('promising the gift gives the opponent a Food and turns on the bonus', () => {
    const g = setup({ hand: ['Crumb and Get It'], bf: ['Plains', 'Grizzly Bears'] });
    g.castSpell(0, card(g, 0, 'Crumb and Get It'));
    expect(log(g)).toMatch(/gift promised/);
    expect(g.bf.some(x => x.controller === 1 && x.def.name.startsWith('Food'))).toBe(true);
    const bears = perm(g, 0, 'Grizzly Bears');
    expect(g.statsOf(bears).power).toBe(4);
    expect(g.has(bears, 'Indestructible')).toBe(true);
  });
});
