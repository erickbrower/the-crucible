// Ninjutsu and Sneak: swap an unblocked attacker for a card from hand during declare blockers.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { d, setup, perm, onBf, inYard, log } from './helpers.js';

d('ninjutsu', () => {
  it('returns an unblocked attacker and the ninja hits in its place', () => {
    const g = setup({ hand: ['Biting-Palm Ninja'], bf: ['Grizzly Bears', 'Swamp', 'Swamp', 'Swamp'] });
    g.combat();
    expect(log(g)).toMatch(/ninjutsu: returns Grizzly Bears to hand, Biting-Palm Ninja enters attacking/);
    expect(g.players[0].hand.map(c => c.def.name)).toContain('Grizzly Bears');
    const ninja = perm(g, 0, 'Biting-Palm Ninja');
    expect(ninja.tapped).toBe(true);
    expect(g.players[1].life).toBe(17);
  });

  it('needs an unblocked attacker', () => {
    const g = setup({ hand: ['Biting-Palm Ninja'], bf: ['Grizzly Bears', 'Swamp', 'Swamp', 'Swamp'] }, { bf: ['Ordinary Bear'] });
    const bears = perm(g, 0, 'Grizzly Bears');
    bears.attacking = true;
    const out = AI.ninjaStep(g, g.players[0], [bears], new Map([[bears, [perm(g, 1, 'Ordinary Bear')]]]));
    expect(out).toEqual([bears]);
    expect(onBf(g, 0, 'Biting-Palm Ninja')).toBe(false);
  });

  it("can't be paid for without the mana", () => {
    const g = setup({ hand: ['Biting-Palm Ninja'], bf: ['Grizzly Bears', 'Swamp'] });
    const bears = perm(g, 0, 'Grizzly Bears');
    bears.attacking = true;
    expect(AI.ninjaStep(g, g.players[0], [bears], new Map())).toEqual([bears]);
  });
});

d('sneak', () => {
  it('a sneak creature is cast for its sneak cost and enters tapped and attacking', () => {
    const g = setup({ hand: ['Michelangelo, Improviser'], bf: ['Grizzly Bears', 'Forest', 'Forest', 'Forest', 'Forest'] });
    g.combat();
    expect(log(g)).toMatch(/sneak: returns Grizzly Bears to hand/);
    expect(log(g)).toMatch(/casts Michelangelo, Improviser \(sneak\)/);
    expect(perm(g, 0, 'Michelangelo, Improviser').tapped).toBe(true);
    expect(g.players[1].life).toBe(16);
  });

  it('a sneak sorcery is cast during combat for the cheap cost when it is worth it', () => {
    const g = setup({ hand: ["Jennika's Technique"], bf: ['Grizzly Bears', 'Mountain'] },
      { bf: ['Grizzly Bears', 'Grizzly Bears', 'Grizzly Bears'] });
    const bears = perm(g, 0, 'Grizzly Bears');
    g.phase = 'combat';
    bears.attacking = true;
    AI.ninjaStep(g, g.players[0], [bears], new Map());
    expect(log(g)).toMatch(/casts Jennika's Technique \(sneak\)/);
    expect(g.bf.filter(x => x.controller === 1).length).toBe(0);
    expect(inYard(g, 0, "Jennika's Technique")).toBe(true);
    expect(g.players[0].hand.map(c => c.def.name)).toContain('Grizzly Bears');   // returned, so it survived
  });
});
