// Star Trek (TRK) cards.
import { it, expect } from 'vitest';
import { d, setup, perm } from './helpers.js';

d('Gul Dukat, Colonial Prefect', () => {
  it('at each end step the opponent loses the life they lost this turn again, and you gain it', () => {
    const g = setup({ bf: ['Gul Dukat, Colonial Prefect'] });
    g.dealDamage(perm(g, 0, 'Gul Dukat, Colonial Prefect'), 0, { kind: 'player', pid: 1 }, 6, true);
    expect(g.players[1].life).toBe(14);
    g.emit({ type: 'phase', phase: 'End of Turn', player: 0 });
    expect(g.players[1].life).toBe(8);
    expect(g.players[0].life).toBe(26);
  });

  it('does nothing when the opponent lost no life', () => {
    const g = setup({ bf: ['Gul Dukat, Colonial Prefect'] });
    g.emit({ type: 'phase', phase: 'End of Turn', player: 0 });
    expect(g.players[1].life).toBe(20);
    expect(g.players[0].life).toBe(20);
  });
});

d('Dr. Beverly Crusher', () => {
  it('life-gain triggers happen twice, but enters-the-battlefield triggers do not', () => {
    const g = setup({ hand: ['Helpful Hunter'], bf: ['Dr. Beverly Crusher', "Ajani's Pridemate", 'Plains', 'Plains'], library: Array(10).fill('Plains') });
    g.gainLife(0, 1);
    expect(perm(g, 0, "Ajani's Pridemate").counters.P1P1).toBe(2);
    expect(perm(g, 0, 'Dr. Beverly Crusher').counters.P1P1).toBe(2);
    const before = g.players[0].hand.length;
    g.castSpell(0, g.players[0].hand.find(c => c.def.name === 'Helpful Hunter')!);
    expect(g.players[0].hand.length).toBe(before);   // -Hunter, +1 card (not +2)
  });
});

d('Georgiou, Terran Emperor', () => {
  it("you don't lose at 0 life while she's out, and lose as soon as she leaves", () => {
    const g = setup({ bf: ['Georgiou, Terran Emperor'] });
    g.players[0].life = 2;
    g.loseLife(0, 5);
    g.checkSBA();
    expect(g.over).toBe(false);
    g.destroy(g.bf.find(x => x.def.name === 'Georgiou, Terran Emperor')!);
    g.checkSBA();
    expect(g.over).toBe(true);
    expect(g.winner).toBe(1);
  });

  it('at 0 or less life her end step trigger makes ten Officers', () => {
    const g = setup({ bf: ['Georgiou, Terran Emperor'], library: Array(5).fill('Swamp') });
    g.players[0].life = 2;
    g.emit({ type: 'phase', phase: 'End of Turn', player: 0 });
    expect(g.players[0].life).toBe(-1);
    expect(g.bf.filter(x => x.token && x.controller === 0).length).toBe(10);
  });
});
