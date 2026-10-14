// Blight, proliferate, suspect, saddle, mayhem, bargain, protection and escape.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { loadCard } from '../src/cards/compile.js';
import { d, setup, perm, make, log } from './helpers.js';

d('blight', () => {
  it('Requiting Hex: blights a creature that survives it, and the paid cost adds 2 life', () => {
    const g = setup({ hand: ['Requiting Hex'], bf: ['Swamp', 'Serra Angel'] }, { bf: ['Raging Goblin'] });
    expect(g.castSpell(0, g.players[0].hand[0])).toBe(true);
    expect(perm(g, 0, 'Serra Angel').counters.M1M1).toBe(1);
    expect(g.bf.some(x => x.def.name === 'Raging Goblin')).toBe(false);
    expect(g.players[0].life).toBe(22);
  });

  it('without a creature to blight, it is just the removal spell', () => {
    const g = setup({ hand: ['Requiting Hex'], bf: ['Swamp'] }, { bf: ['Raging Goblin'] });
    g.castSpell(0, g.players[0].hand[0]);
    expect(g.players[0].life).toBe(20);
  });

  it('Pyrrhic Strike with blight paid destroys both an artifact/enchantment and a big creature', () => {
    const g = setup({ hand: ['Pyrrhic Strike'], bf: ['Plains', 'Plains', 'Plains', 'Serra Angel'] }, { bf: ['Leyline Axe', 'Sheoldred, the Apocalypse'] });
    g.castSpell(0, g.players[0].hand[0]);
    expect(g.bf.filter(x => x.controller === 1).map(x => x.def.name)).toEqual([]);
  });

  it('High Perfect Morcant makes each opponent blight 1', () => {
    const g = setup({}, { bf: ['Serra Angel', 'Raging Goblin'] });
    g.enter(make(g, 0, 'High Perfect Morcant'), 0);
    expect(perm(g, 1, 'Serra Angel').counters.M1M1).toBe(1);     // the Goblin would die, so the Angel takes it
  });
});

d('proliferate', () => {
  it('adds a counter of each kind to our permanents and -1/-1 counters to theirs', () => {
    const g = setup({ bf: ['Serra Angel'] }, { bf: ['Sheoldred, the Apocalypse'] });
    perm(g, 0, 'Serra Angel').counters.P1P1 = 2;
    perm(g, 1, 'Sheoldred, the Apocalypse').counters.M1M1 = 1;
    g.resolveEffect({ api: 'Proliferate', params: {} }, { p: 0, x: 0, kicked: false, targets: [] });
    expect(perm(g, 0, 'Serra Angel').counters.P1P1).toBe(3);
    expect(perm(g, 1, 'Sheoldred, the Apocalypse').counters.M1M1).toBe(2);
  });
});

d('suspect and saddle', () => {
  it('a suspected creature has menace and cannot block', () => {
    const g = setup({ bf: ['Raging Goblin'] });
    const gob = perm(g, 0, 'Raging Goblin');
    gob.attrs = ['Suspected'];
    expect(g.has(gob, 'Menace')).toBe(true);
    expect(g.cantBlock(gob)).toBe(true);
  });

  it('Brightfield Glider is saddled by a summoning-sick creature and gets +1/+2 and flying when it attacks', () => {
    const g = setup({ bf: ['Brightfield Glider'] });
    const glider = perm(g, 0, 'Brightfield Glider');
    g.enter(make(g, 0, 'Serra Angel'), 0);                          // summoning sick: can't attack, can saddle
    g.combatPhases();
    expect(glider.attrs ?? []).toContain('Saddled');
    expect(log(g)).toMatch(/saddles Brightfield Glider with Serra Angel/);
    g.cleanup();
    expect(glider.attrs ?? []).not.toContain('Saddled');
  });
});

d('mayhem, bargain and escape', () => {
  it('a discarded mayhem card can be cast from the graveyard this turn', () => {
    const g = setup({ hand: ['Swarm, Being of Bees'], bf: ['Swamp', 'Swamp', 'Swamp'] });
    const p = g.players[0];
    g.discard(p, p.hand[0]);
    expect(g.mayhemCastable(0, p.graveyard[0])).toBe(true);
    AI.mainPhase(g, p, 1);
    expect(log(g)).toMatch(/casts Swarm, Being of Bees \(mayhem\)/);
  });

  it('Torch the Tower bargains a token for 3 damage and a scry', () => {
    const g = setup({ hand: ['Torch the Tower'], bf: ['Mountain'] }, { bf: ['Serra Angel'] });
    g.makeToken('c_a_treasure_sac', 0);
    g.castSpell(0, g.players[0].hand[0]);
    expect(log(g)).toMatch(/bargains Treasure/);
  });

  it('Uro escapes from the graveyard by exiling five other cards, and stays', () => {
    const g = setup({ graveyard: ['Uro, Titan of Nature\'s Wrath', 'Opt', 'Opt', 'Forest', 'Plains', 'Raging Goblin', 'Island'], bf: ['Forest', 'Forest', 'Island', 'Island'] });
    const p = g.players[0];
    AI.mainPhase(g, p, 1);
    expect(log(g)).toMatch(/casts Uro, Titan of Nature's Wrath \(escape\)/);
    expect(g.bf.some(x => x.def.name === "Uro, Titan of Nature's Wrath")).toBe(true);
    expect(p.exile.length).toBe(5);
  });

  it('cast normally, Uro is sacrificed when it enters', () => {
    const g = setup({ hand: ["Uro, Titan of Nature's Wrath"], bf: ['Forest', 'Island', 'Island'] });
    g.castSpell(0, g.players[0].hand[0]);
    expect(g.bf.some(x => x.def.name === "Uro, Titan of Nature's Wrath")).toBe(false);
  });
});

d('protection', () => {
  it('protection from a color: no damage, no targeting, no blocking by that color', () => {
    const g = setup({ bf: ['Raging Goblin'] }, { bf: ['Serra Angel'] });
    const gob = perm(g, 0, 'Raging Goblin');
    gob.tempKw.push('Protection from white');
    const angel = perm(g, 1, 'Serra Angel');
    expect(g.dealDamage(angel, 1, { kind: 'perm', perm: gob }, 4, true)).toBe(0);
    expect(g.protectedFrom(gob, angel, 1)).toBe(true);
    const swords = make(g, 1, 'Swords to Plowshares');
    expect(g.isLegalTarget({ kind: 'perm', perm: gob }, loadCard('Swords to Plowshares').spell!.effect, { p: 1, card: swords, x: 0, kicked: false, targets: [] })).toBe(false);
  });

  it('The One Ring gives its controller protection from everything until their next turn', () => {
    const g = setup({ hand: ['The One Ring'], bf: ['Plains', 'Plains', 'Plains', 'Plains'] }, { bf: ['Raging Goblin'] });
    g.castSpell(0, g.players[0].hand[0]);
    expect(g.dealDamage(perm(g, 1, 'Raging Goblin'), 1, { kind: 'player', pid: 0 }, 3, true)).toBe(0);
    expect(g.players[0].life).toBe(20);
  });

  it('reports these cards as modeled', () => {
    for (const n of ['Requiting Hex', 'Pyrrhic Strike', 'Blighted Blackthorn', 'High Perfect Morcant', 'Convenient Target', 'Scarlet Spider, Kaine',
      'Brightfield Glider', 'Torch the Tower', 'Cankerbloom', 'Mother of Runes', 'The One Ring', "Uro, Titan of Nature's Wrath", 'Cling to Dust'])
      expect([n, loadCard(n).notes]).toEqual([n, []]);
  });
});

d('tiered, plot, bestow and craft', () => {
  it('Fire Magic (tiered) picks one mode and pays its cost', () => {
    const g = setup({ hand: ['Fire Magic'], bf: ['Mountain', 'Mountain', 'Mountain'] }, { bf: ['Raging Goblin', 'Healer\'s Hawk', 'Llanowar Elves', 'Savannah Lions'] });
    g.castSpell(0, g.players[0].hand[0]);
    expect(log(g)).toMatch(/casts Fire Magic \(spree: 1 mode\)/);
    expect(g.bf.filter(x => x.controller === 1).length).toBe(0);
    expect(loadCard('Fire Magic').notes).toEqual([]);
  });

  it('a plotted card is cast for free on a later turn', () => {
    const g = setup({ hand: ['Slickshot Show-Off'], bf: ['Mountain', 'Mountain'] });
    const c = g.players[0].hand[0];
    expect(g.plot(0, c)).toBe(true);
    expect(g.castSpell(0, c, { fromExile: true })).toBe(false);          // not this turn
    g.turnSeq += 2;
    for (const x of g.bf) x.tapped = true;                                 // no mana needed
    expect(g.castSpell(0, c, { fromExile: true })).toBe(true);
    expect(g.bf.some(x => x.def.name === 'Slickshot Show-Off')).toBe(true);
  });

  it('a bestowed Aura pumps its host, then becomes a creature when the host dies', () => {
    const g = setup({ hand: ['Springheart Nantuko'], bf: ['Forest', 'Forest', 'Raging Goblin'] });
    expect(g.castSpell(0, g.players[0].hand[0], { bestow: true })).toBe(true);
    const nant = perm(g, 0, 'Springheart Nantuko');
    const gob = perm(g, 0, 'Raging Goblin');
    expect(nant.def.types).not.toContain('Creature');
    expect(g.statsOf(gob).power).toBe(2);
    g.destroy(gob);
    expect(nant.def.types).toContain('Creature');
    expect(nant.attachedTo).toBeUndefined();
  });

  it('Braided Net crafts with an artifact from the graveyard', () => {
    const g = setup({ bf: ['Braided Net, Braided Quipu'.split(',')[0], 'Island', 'Island'], graveyard: ['Leyline Axe'] });
    const net = perm(g, 0, 'Braided Net');
    expect(g.craft(0, net)).toBe(true);
    expect(g.bf.some(x => x.def.name === 'Braided Quipu')).toBe(true);
    expect(g.players[0].exile.map(c => c.def.name)).toContain('Leyline Axe');
  });
});
