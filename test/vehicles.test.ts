// Vehicles and Crew.
import { it, expect } from 'vitest';
import { d, setup, perm, inYard, log } from './helpers.js';

d('crew', () => {
  it('tapping enough power makes the vehicle a creature until end of turn', () => {
    const g = setup({ bf: ['Detention Chariot', 'Grizzly Bears', 'Grizzly Bears'] });
    const v = perm(g, 0, 'Detention Chariot');
    const bears = g.bf.filter(x => x.def.name === 'Grizzly Bears');
    expect(g.crew(v, [bears[0]])).toBe(false);          // crew 3 needs 3 power
    expect(g.crew(v, bears)).toBe(true);
    expect(v.def.types).toContain('Creature');
    expect(bears.every(b => b.tapped)).toBe(true);
    g.cleanup();
    expect(v.def.types).not.toContain('Creature');
  });

  it('the AI crews with a summoning-sick creature and attacks with the vehicle', () => {
    const g = setup({ bf: ['Air Response Unit', 'Grizzly Bears'] });
    perm(g, 0, 'Grizzly Bears').sick = true;            // just cast: can't attack, but can crew
    g.combat();
    expect(log(g)).toMatch(/crews Air Response Unit with Grizzly Bears/);
    expect(log(g)).toMatch(/attacks with Air Response Unit/);
    expect(g.players[1].life).toBe(17);
  });

  it("doesn't crew when the crew would hit harder than the vehicle", () => {
    const g = setup({ bf: ['Air Response Unit', 'Ordinary Bear'] });
    g.combat();
    expect(log(g)).not.toMatch(/crews/);
    expect(g.players[1].life).toBe(16);
  });

  it('a crewed vehicle that dies goes to the graveyard as the card', () => {
    const g = setup({ bf: ['Air Response Unit', 'Grizzly Bears'] });
    const v = perm(g, 0, 'Air Response Unit');
    g.crew(v, [perm(g, 0, 'Grizzly Bears')]);
    g.dealDamage(undefined, 1, { kind: 'perm', perm: v }, 3, false);
    g.checkSBA();
    expect(inYard(g, 0, 'Air Response Unit')).toBe(true);
    expect(g.players[0].graveyard.find(c => c.def.name === 'Air Response Unit')!.def.types).not.toContain('Creature');
  });
});
