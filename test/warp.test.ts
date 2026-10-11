// Warp (Edge of Eternities).
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { d, setup, onBf, log } from './helpers.js';

d('warp', () => {
  it('casts for the warp cost, is exiled at end of turn, and can be recast from exile later', () => {
    const g = setup({ hand: ['Nova Hellkite'], bf: ['Mountain', 'Mountain', 'Mountain'] }, { bf: ['Raging Goblin'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/casts Nova Hellkite \(warp\)/);
    expect(onBf(g, 1, 'Raging Goblin')).toBe(false);          // enters trigger: 1 damage
    g.exileWarped();
    expect(onBf(g, 0, 'Nova Hellkite')).toBe(false);
    expect(g.players[0].warpExile?.map(w => w.card.def.name)).toEqual(['Nova Hellkite']);
    // same turn: can't recast from exile
    for (const p of g.bf) p.tapped = false;
    expect(g.castSpell(0, g.players[0].warpExile![0].card, { fromExile: true })).toBe(false);
    // a later turn with five lands: cast it for real from exile
    g.turn++;
    for (const n of ['Mountain', 'Mountain']) g.enter({ id: g.nextId++, def: g.bf.find(x => x.def.name === n)!.def, owner: 0 }, 0);
    for (const p of g.bf) p.tapped = false;
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/casts Nova Hellkite from exile/);
    expect(onBf(g, 0, 'Nova Hellkite')).toBe(true);
    g.exileWarped();
    expect(onBf(g, 0, 'Nova Hellkite')).toBe(true);            // not warped this time: it stays
  });
});
