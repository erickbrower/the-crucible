// Avatar: The Last Airbender mechanics.
import { it, expect } from 'vitest';
import { d, setup, card, perm, log } from './helpers.js';

d('firebending', () => {
  it('attacking adds {R} per firebending, usable for spells, gone after combat', () => {
    const g = setup({ hand: ['Shock'], bf: ['Zuko, Exiled Prince'] }, { bf: ['Grizzly Bears'] });
    const zuko = perm(g, 0, 'Zuko, Exiled Prince');
    g.phase = 'combat';
    zuko.attacking = true;
    g.emit({ type: 'attacks', perm: zuko });
    expect(g.players[0].pool).toEqual(['R', 'R', 'R']);
    expect(log(g)).toMatch(/firebends: adds \{R\}\{R\}\{R\}/);
    expect(g.castSpell(0, card(g, 0, 'Shock'))).toBe(true);     // no lands: paid from the pool
    expect(g.players[0].pool).toHaveLength(2);
  });

  it('the AI spends firebending mana during combat and the rest empties', () => {
    const g = setup({ bf: ['Zuko, Exiled Prince'], library: ['Grizzly Bears', 'Forest', 'Forest'] });
    g.combat();
    expect(log(g)).toMatch(/attacks with Zuko/);
    expect(log(g)).toMatch(/activates Zuko, Exiled Prince/);      // {3}: exile the top card, paid with {R}{R}{R}
    expect(g.players[0].pool).toEqual([]);
  });
});

d('conditional firebending', () => {
  it('Fire Nation Cadets firebend only with a Lesson in the graveyard', () => {
    const g = setup({ bf: ['Fire Nation Cadets'] });
    const cadets = perm(g, 0, 'Fire Nation Cadets');
    expect(g.firebending(cadets)).toBe(0);
    const g2 = setup({ bf: ['Fire Nation Cadets'], graveyard: ["Aang's Journey"] });
    expect(g2.firebending(perm(g2, 0, 'Fire Nation Cadets'))).toBe(2);
  });
});

d('earthbend', () => {
  it('turns a land into a hasty 0/0 creature with counters; it comes back tapped when it dies', () => {
    const g = setup({ hand: ['Bumi, Unleashed'], bf: ['Mountain', 'Forest', 'Forest', 'Forest', 'Forest'] });
    expect(g.castSpell(0, card(g, 0, 'Bumi, Unleashed'))).toBe(true);
    const land = g.bf.find(x => x.earthbent)!;
    expect(land).toBeDefined();
    expect(land.def.types).toEqual(expect.arrayContaining(['Land', 'Creature']));
    expect(g.statsOf(land)).toMatchObject({ power: 4, toughness: 4 });
    expect(g.has(land, 'Haste')).toBe(true);
    const name = land.def.name;
    g.destroy(land);
    g.checkSBA();
    const back = g.bf.find(x => x.def.name === name && x.id === land.id)!;
    expect(back.tapped).toBe(true);
    expect(back.def.types).not.toContain('Creature');
    expect(g.players[0].graveyard.some(c => c.def.name === name)).toBe(false);
  });

  it('a second earthbend stacks counters on the same land', () => {
    const g = setup({ bf: ['Forest', 'Forest'] });
    const eff = { api: 'Earthbend', params: { Num: '2' } };
    g.resolveEffect(eff, { p: 0, x: 0, kicked: false, targets: [] });
    g.resolveEffect(eff, { p: 0, x: 0, kicked: false, targets: [] });
    const bent = g.bf.filter(x => x.earthbent);
    expect(bent).toHaveLength(1);
    expect(g.statsOf(bent[0]).power).toBe(4);
  });
});
