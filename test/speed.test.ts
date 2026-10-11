// Start your engines! / speed / max speed (Aetherdrift).
import { it, expect } from 'vitest';
import { d, setup, perm, make } from './helpers.js';

d('speed', () => {
  it('starts at 1 and goes up once per own turn when an opponent loses life', () => {
    const g = setup({ bf: ['Grizzly Bears'] });
    expect(g.players[0].speed ?? 0).toBe(0);
    g.enter(make(g, 0, 'Nesting Bot'), 0);
    expect(g.players[0].speed).toBe(1);
    g.dealDamage(perm(g, 0, 'Grizzly Bears'), 0, { kind: 'player', pid: 1 }, 2, true);
    g.loseLife(1, 1);
    expect(g.players[0].speed).toBe(2);                 // only once per turn
    g.active = 1; g.turn++;
    g.loseLife(1, 1);
    expect(g.players[0].speed).toBe(2);                 // not on the opponent's turn
    g.active = 0; g.turn++;
    g.loseLife(1, 1);
    expect(g.players[0].speed).toBe(3);
  });

  it('max speed turns on Nesting Bot\'s +1/+0', () => {
    const g = setup({ bf: ['Nesting Bot'] });
    const bot = perm(g, 0, 'Nesting Bot');
    expect(g.statsOf(bot).power).toBe(1);
    g.players[0].speed = 4;
    expect(g.statsOf(bot).power).toBe(2);
  });

  it('Samut gives other creatures +X/+0 where X is your speed', () => {
    const g = setup({ bf: ['Samut, the Driving Force', 'Grizzly Bears'] });
    g.players[0].speed = 3;
    expect(g.statsOf(perm(g, 0, 'Grizzly Bears')).power).toBe(5);
  });

  it("Samut's noncreature cost reduction scales with speed", () => {
    const g = setup({ hand: ['Lightning Strike'], bf: ['Samut, the Driving Force'] });
    g.players[0].speed = 2;
    expect(g.spellCost(0, g.players[0].hand[0]).generic).toBe(0);   // {1}{R} minus 2
  });
});
