// Evergreen keywords the engine claims to support, one rule per test.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { d, setup, card, perm, onBf, fight, log } from './helpers.js';

d('evasion and blocking', () => {
  it('ground creatures cannot block a flyer, reach creatures can', () => {
    const g = setup({ bf: ['Serra Angel'] }, { bf: ['Ordinary Bear'] });
    expect(AI.chooseBlocks(g, g.players[1], [perm(g, 0, 'Serra Angel')]).size).toBe(0);
    const g2 = setup({ bf: ['Serra Angel'] }, { bf: ['Colossadactyl'] });
    const blocks = AI.chooseBlocks(g2, g2.players[1], [perm(g2, 0, 'Serra Angel')]);
    expect([...blocks.values()].flat().map(b => b.def.name)).toEqual(['Colossadactyl']);
  });

  it('menace cannot be blocked by just one creature', () => {
    const g = setup({ bf: ['Boggart Brute'] }, { bf: ['Ordinary Bear'] });
    const blocks = AI.chooseBlocks(g, g.players[1], [perm(g, 0, 'Boggart Brute')]);
    expect([...blocks.values()].flat()).toHaveLength(0);
  });

  it("'can't be blocked except by three or more creatures' needs three blockers", () => {
    const g = setup({ bf: ['Rampaging Ceratops'] }, { bf: ['Ordinary Bear', 'Grizzly Bears'] });
    const blocks = AI.chooseBlocks(g, g.players[1], [perm(g, 0, 'Rampaging Ceratops')]);
    expect([...blocks.values()].flat()).toHaveLength(0);
  });

  it('defender cannot attack', () => {
    const g = setup({ bf: ['Wall of Stone', 'Grizzly Bears'] });
    expect(g.cantAttack(perm(g, 0, 'Wall of Stone'))).toBe(true);
    expect(AI.chooseAttackers(g, g.players[0]).map(a => a.def.name)).not.toContain('Wall of Stone');
  });
});

d('combat damage', () => {
  it('trample assigns lethal to the blocker and the rest to the player', () => {
    const g = setup({ bf: ['Earthshaker Dreadmaw'] }, { bf: ['Grizzly Bears'] });
    fight(g, [perm(g, 0, 'Earthshaker Dreadmaw')], [[perm(g, 0, 'Earthshaker Dreadmaw'), [perm(g, 1, 'Grizzly Bears')]]]);
    expect(g.players[1].life).toBe(16);
    expect(onBf(g, 1, 'Grizzly Bears')).toBe(false);
  });

  it('deathtouch + trample only needs to assign 1 damage to each blocker', () => {
    const g = setup({ bf: ['Earthshaker Dreadmaw'] }, { bf: ['Ordinary Bear'] });
    const a = perm(g, 0, 'Earthshaker Dreadmaw'); a.tempKw.push('Deathtouch');
    fight(g, [a], [[a, [perm(g, 1, 'Ordinary Bear')]]]);
    expect(g.players[1].life).toBe(15);
    expect(onBf(g, 1, 'Ordinary Bear')).toBe(false);
  });

  it('a blocked creature without trample deals no damage to the player even if the blocker is gone', () => {
    const g = setup({ bf: ['Ordinary Bear'] }, { bf: ['Grizzly Bears'] });
    const a = perm(g, 0, 'Ordinary Bear'); a.tempKw.push('Double Strike');
    fight(g, [a], [[a, [perm(g, 1, 'Grizzly Bears')]]]);
    expect(onBf(g, 1, 'Grizzly Bears')).toBe(false);
    expect(g.players[1].life).toBe(20);
  });

  it('double strike hits twice when unblocked', () => {
    const g = setup({ bf: ['Grizzly Bears'] });
    const a = perm(g, 0, 'Grizzly Bears'); a.tempKw.push('Double Strike');
    fight(g, [a]);
    expect(g.players[1].life).toBe(16);
  });

  it('first strike kills the blocker before it deals damage back', () => {
    const g = setup({ bf: ['Grizzly Bears'] }, { bf: ['Grizzly Bears'] });
    const a = perm(g, 0, 'Grizzly Bears'); a.tempKw.push('First Strike');
    fight(g, [a], [[a, [perm(g, 1, 'Grizzly Bears')]]]);
    expect(onBf(g, 0, 'Grizzly Bears')).toBe(true);
    expect(onBf(g, 1, 'Grizzly Bears')).toBe(false);
  });

  it('lifelink and deathtouch: Vampire Nighthawk kills a big blocker and gains 2', () => {
    const g = setup({ bf: ['Vampire Nighthawk'] }, { bf: ['Colossadactyl'] });
    const a = perm(g, 0, 'Vampire Nighthawk');
    fight(g, [a], [[a, [perm(g, 1, 'Colossadactyl')]]]);
    expect(onBf(g, 1, 'Colossadactyl')).toBe(false);
    expect(g.players[0].life).toBe(22);
  });

  it('vigilance attackers stay untapped', () => {
    const g = setup({ bf: ['Serra Angel', 'Grizzly Bears'] });
    fight(g, [perm(g, 0, 'Serra Angel'), perm(g, 0, 'Grizzly Bears')]);
    expect(perm(g, 0, 'Serra Angel').tapped).toBe(false);
    expect(perm(g, 0, 'Grizzly Bears').tapped).toBe(true);
  });

  it('indestructible survives lethal damage and destroy effects', () => {
    const g = setup({ hand: ['Murder'], bf: ['Swamp', 'Swamp', 'Swamp'] }, { bf: ['Darksteel Myr'] });
    const myr = perm(g, 1, 'Darksteel Myr');
    g.dealDamage(undefined, 0, { kind: 'perm', perm: myr }, 5, false);
    g.checkSBA();
    expect(g.destroy(myr)).toBe(false);
    expect(onBf(g, 1, 'Darksteel Myr')).toBe(true);
  });
});

d('prowess and hexproof', () => {
  it('prowess pumps on noncreature spells only', () => {
    const g = setup({ hand: ['Shock', 'Grizzly Bears'], bf: ['Monastery Swiftspear', 'Mountain', 'Forest', 'Forest'] }, { bf: ['Ordinary Bear'] });
    const sw = perm(g, 0, 'Monastery Swiftspear');
    expect(g.castSpell(0, card(g, 0, 'Shock'))).toBe(true);
    expect(g.statsOf(sw)).toMatchObject({ power: 2, toughness: 3 });
    expect(g.castSpell(0, card(g, 0, 'Grizzly Bears'))).toBe(true);
    expect(g.statsOf(sw).power).toBe(2);
  });

  it('two instances of prowess trigger separately (Thor Odinson)', () => {
    const g = setup({ hand: ['Shock'], bf: ['Thor Odinson', 'Mountain'] }, { bf: ['Ordinary Bear'] });
    g.castSpell(0, card(g, 0, 'Shock'));
    expect(g.statsOf(perm(g, 0, 'Thor Odinson')).power).toBe(6);
  });

  it("the AI can't target an opponent's hexproof creature", () => {
    const g = setup({ hand: ['Murder'], bf: ['Swamp', 'Swamp', 'Swamp'] }, { bf: ['Ordinary Bear'] });
    perm(g, 1, 'Ordinary Bear').tempKw.push('Hexproof');
    g.castSpell(0, card(g, 0, 'Murder'));
    expect(onBf(g, 1, 'Ordinary Bear')).toBe(true);
    expect(log(g)).not.toMatch(/Murder \(Destroy\) -> Ordinary Bear/);
  });
});
