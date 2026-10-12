// "If you control a commander, you may cast this spell without paying its mana cost."
import { it, expect } from 'vitest';
import { loadCard } from '../src/cards/compile.js';
import { matches } from '../src/engine/filters.js';
import { d, setup, card, perm } from './helpers.js';

d('free alternative costs', () => {
  it('is free only while you control your commander', () => {
    const g = setup({ hand: ['Deadly Rollick'], bf: ['Raging Goblin'] });
    expect(g.canCast(0, card(g, 0, 'Deadly Rollick'))).toBe(false);      // no lands, no commander
    perm(g, 0, 'Raging Goblin').isCommander = true;
    expect(g.canCast(0, card(g, 0, 'Deadly Rollick'))).toBe(true);
    expect(loadCard('Deadly Rollick').notes).toEqual([]);
  });

  it('IsCommander only matches the commander (it used to match everything)', () => {
    const g = setup({ bf: ['Raging Goblin'] });
    const s = g.subjectOf(perm(g, 0, 'Raging Goblin'));
    expect(matches('Card.IsCommander+YouCtrl', s, { you: 0 })).toBe(false);
    perm(g, 0, 'Raging Goblin').isCommander = true;
    expect(matches('Card.IsCommander+YouCtrl', g.subjectOf(perm(g, 0, 'Raging Goblin')), { you: 0 })).toBe(true);
  });
});

d('pitch spells', () => {
  it('Snuff Out: pays 4 life instead of mana when you control a Swamp', () => {
    const g = setup({ hand: ['Snuff Out'], bf: ['Swamp'] }, { bf: ['Raging Goblin'] });
    g.bf.find(x => x.def.name === 'Swamp')!.tapped = true;              // no mana available
    expect(g.canCast(0, card(g, 0, 'Snuff Out'))).toBe(true);
    expect(g.castSpell(0, card(g, 0, 'Snuff Out'))).toBe(true);
    expect(g.players[0].life).toBe(16);
    expect(g.bf.some(x => x.def.name === 'Raging Goblin')).toBe(false);
  });

  it('Force of Will: exiles the least valuable other blue card and pays 1 life', () => {
    const g = setup({ hand: ['Force of Will', 'Opt', 'Shock'] });
    const fow = card(g, 0, 'Force of Will');
    expect(g.pitchCost(0, fow)).toMatchObject({ payLife: 1, parts: [{ kind: 'ExileFromHand', n: 1 }] });
    g.players[0].hand = [fow, g.players[0].hand.find(c => c.def.name === 'Shock')!];   // no blue card to pitch
    expect(g.pitchCost(0, fow)).toBeUndefined();
  });

  it('reports pitch spells as modeled', () => {
    for (const n of ['Force of Will', 'Daze', 'Snuff Out']) expect(loadCard(n).notes.filter(x => /AlternativeCost/.test(x))).toEqual([]);
  });
});

d('sacrifice pitch costs', () => {
  it('Flare of Denial sacrifices a nontoken blue creature instead of paying mana', () => {
    const g = setup({ hand: ['Flare of Denial'], bf: ['Spectral Sailor'] });
    expect(g.pitchCost(0, card(g, 0, 'Flare of Denial'))).toMatchObject({ parts: [{ kind: 'Sac', n: 1 }] });
  });

  it('with nothing to sacrifice it is simply not castable (no crash)', () => {
    for (const n of ['Flare of Denial', 'Mine Collapse']) {
      const g = setup({ hand: [n] });
      expect(g.canCast(0, card(g, 0, n))).toBe(false);
    }
  });
});
