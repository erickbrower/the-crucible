// Vehicles and Crew.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
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

d('station', () => {
  it('charges with creature power and becomes a flying creature at its threshold', () => {
    const g = setup({ bf: ['Rescue Skiff', 'Ordinary Bear', 'Ordinary Bear', 'Ordinary Bear'] });
    const skiff = perm(g, 0, 'Rescue Skiff');
    const bears = g.bf.filter(x => x.def.name === 'Ordinary Bear');
    g.station(skiff, bears[0]); g.station(skiff, bears[1]);
    expect(skiff.counters.CHARGE).toBe(8);
    expect(skiff.def.types).not.toContain('Creature');
    expect(g.has(skiff, 'Flying')).toBe(false);
    g.station(skiff, bears[2]);
    expect(skiff.def.types).toContain('Creature');
    expect(g.has(skiff, 'Flying')).toBe(true);
    expect(g.statsOf(skiff)).toMatchObject({ power: 5, toughness: 6 });
  });

  it('the AI stations after combat when it is safe', () => {
    const g = setup({ bf: ['Rescue Skiff', 'Ordinary Bear'] });
    AI.mainPhase(g, g.players[0], 2);
    expect(perm(g, 0, 'Rescue Skiff').counters.CHARGE).toBe(4);
  });

  it('an aura that only pumps creatures does not recurse or apply to a non-creature', () => {
    const g = setup({ bf: ['Rescue Skiff', 'Lightwheel Enhancements'] });
    const aura = perm(g, 0, 'Lightwheel Enhancements');
    aura.attachedTo = perm(g, 0, 'Rescue Skiff').id;
    expect(g.statsOf(perm(g, 0, 'Rescue Skiff')).power).toBe(5);
  });
});
