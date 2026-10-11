// Cycling, landcycling, flashback, convoke and changeling.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { d, setup, card, perm, onBf, inYard, log } from './helpers.js';

const hand = (g: ReturnType<typeof setup>, pid = 0) => g.players[pid].hand.map(c => c.def.name);

d('cycling', () => {
  it('pays, discards and draws', () => {
    const g = setup({ hand: ['Migrating Ketradon'], bf: ['Forest', 'Forest'], library: ['Grizzly Bears'] });
    expect(g.cycle(0, card(g, 0, 'Migrating Ketradon'))).toBe(true);
    expect(inYard(g, 0, 'Migrating Ketradon')).toBe(true);
    expect(hand(g)).toEqual(['Grizzly Bears']);
    expect(g.bf.filter(x => x.tapped)).toHaveLength(2);
  });

  it('landcycling finds the right land type', () => {
    const g = setup({ hand: ['Seismic Monstrosaur'], bf: ['Forest', 'Forest'], library: ['Forest', 'Grizzly Bears', 'Mountain'] });
    g.cycle(0, card(g, 0, 'Seismic Monstrosaur'));
    expect(hand(g)).toEqual(['Mountain']);
    expect(log(g)).toMatch(/mountaincycles Seismic Monstrosaur for Mountain/);
  });

  it("'when you cycle this card' triggers from the graveyard (Agonasaur Rex)", () => {
    const g = setup({ hand: ['Agonasaur Rex'], bf: ['Forest', 'Forest', 'Forest', 'Grizzly Bears'], library: ['Forest'] });
    g.cycle(0, card(g, 0, 'Agonasaur Rex'));
    const bears = perm(g, 0, 'Grizzly Bears');
    expect(bears.counters.P1P1).toBe(2);
    expect(g.has(bears, 'Indestructible')).toBe(true);
  });

  it('the AI landcycles when it has no land to play', () => {
    const g = setup({ hand: ['Seismic Monstrosaur'], bf: ['Forest', 'Forest'], library: ['Mountain', 'Mountain'] });
    g.players[0].landsPlayed = 1;
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/mountaincycles/);
  });

  it('the AI cycles an uncastable card at the end of the opponent turn', () => {
    const g = setup({}, { hand: ['Migrating Ketradon'], bf: ['Forest', 'Forest'], library: ['Grizzly Bears'] });
    AI.endOfTurnWindow(g, g.players[1]);
    expect(log(g)).toMatch(/cycles Migrating Ketradon/);
  });
});

d('flashback', () => {
  it('casts from the graveyard for the flashback cost, then exiles it', () => {
    const g = setup({ graveyard: ['Firebolt'], bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, { bf: ['Grizzly Bears'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/casts Firebolt \(flashback\)/);
    expect(onBf(g, 1, 'Grizzly Bears')).toBe(false);
    expect(inYard(g, 0, 'Firebolt')).toBe(false);
    expect(g.players[0].exile.map(c => c.def.name)).toContain('Firebolt');
  });

  it('cannot flash back without the full flashback cost', () => {
    const g = setup({ graveyard: ['Firebolt'], bf: ['Mountain'] }, { bf: ['Grizzly Bears'] });
    expect(g.castSpell(0, g.players[0].graveyard[0], { flashback: true })).toBe(false);
    expect(inYard(g, 0, 'Firebolt')).toBe(true);
  });
});

d('convoke', () => {
  it('creatures tap to help pay', () => {
    const g = setup({ hand: ['Stoke the Flames'], bf: ['Mountain', 'Mountain', 'Raging Goblin', 'Raging Goblin'] }, { bf: ['Grizzly Bears'] });
    expect(g.canCast(0, card(g, 0, 'Stoke the Flames'))).toBe(true);
    expect(g.castSpell(0, card(g, 0, 'Stoke the Flames'))).toBe(true);
    expect(g.bf.filter(x => x.controller === 0 && x.def.name === 'Raging Goblin').every(x => x.tapped)).toBe(true);
    expect(inYard(g, 0, 'Stoke the Flames')).toBe(true);
  });

  it('only convoke spells can tap creatures for mana', () => {
    const g = setup({ hand: ['Ordinary Bear'], bf: ['Forest', 'Forest', 'Raging Goblin', 'Raging Goblin'] });
    expect(g.canCast(0, card(g, 0, 'Ordinary Bear'))).toBe(false);
  });
});

d('changeling', () => {
  it('a changeling is every creature type (gets the Dinosaur lord bonus)', () => {
    const g = setup({ bf: ['Gangly Stompling', 'Regal Imperiosaur'] });
    expect(g.statsOf(perm(g, 0, 'Gangly Stompling'))).toMatchObject({ power: 5, toughness: 3 });
  });
});
