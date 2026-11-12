// Poison counters (Fynn, the Fangbearer).
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { d, setup, perm, fight } from './helpers.js';

d('poison', () => {
  it('Fynn gives two poison counters when a deathtouch creature connects, none for other creatures', () => {
    const g = setup({ bf: ['Fynn, the Fangbearer', 'Grizzly Bears'] });
    fight(g, [perm(g, 0, 'Fynn, the Fangbearer'), perm(g, 0, 'Grizzly Bears')]);
    expect(g.players[1].poison).toBe(2);
    expect(g.players[1].life).toBe(17);
  });

  it('a player with ten poison counters loses', () => {
    const g = setup({ bf: ['Fynn, the Fangbearer'] });
    g.players[1].poison = 8;
    fight(g, [perm(g, 0, 'Fynn, the Fangbearer')]);
    expect(g.over).toBe(true);
    expect(g.winner).toBe(0);
  });

  it('the defender chump-blocks a poisonous attacker that would deliver the tenth counter', () => {
    const g = setup({ bf: ['Fynn, the Fangbearer'] }, { bf: ['Grizzly Bears'] });
    g.players[1].poison = 8;
    const blocks = AI.chooseBlocks(g, g.players[1], [perm(g, 0, 'Fynn, the Fangbearer')]);
    expect([...blocks.values()].flat().map(b => b.def.name)).toEqual(['Grizzly Bears']);
  });
});

d('toxic', () => {
  it('Ichorspit Basilisk gives one poison counter from Toxic 1, and two more with Fynn', () => {
    const g = setup({ bf: ['Ichorspit Basilisk'] });
    fight(g, [perm(g, 0, 'Ichorspit Basilisk')]);
    expect(g.players[1].poison).toBe(1);
    const g2 = setup({ bf: ['Ichorspit Basilisk', 'Fynn, the Fangbearer'] });
    fight(g2, [perm(g2, 0, 'Ichorspit Basilisk')]);
    expect(g2.players[1].poison).toBe(3);
  });
});
