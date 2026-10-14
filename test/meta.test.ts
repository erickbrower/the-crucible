// Mechanics the Untapped.gg meta decks rely on: Leylines, Evoke, token copies, cost increases,
// "as this enters, choose ...", delayed triggers, and abilities granted by statics.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { loadCard } from '../src/cards/compile.js';
import { buildDeck } from '../src/sim/deck.js';
import { Game } from '../src/engine/game.js';
import { d, setup, perm, make, log } from './helpers.js';

d('opening-hand effects', () => {
  it('a Leyline in the opening hand starts the game on the battlefield', () => {
    const deck = buildDeck({ name: 'ley', main: [{ count: 4, name: 'Leyline of Hope' }, { count: 36, name: 'Plains' }] }).list;
    const g = new Game([deck, deck], { format: 'standard', maxTurns: 1, seed: 5, firstPlayer: 0, trace: true });
    const p = g.players[0];
    p.hand = [make(g, 0, 'Leyline of Hope'), make(g, 0, 'Plains')];
    g.openingHandEffects(p, 0);
    expect(g.bf.some(x => x.def.name === 'Leyline of Hope')).toBe(true);
    expect(p.hand.map(c => c.def.name)).toEqual(['Plains']);
  });

  it('Gemstone Caverns only when not on the play, with a luck counter, exiling a card', () => {
    const g = setup({ hand: ['Gemstone Caverns', 'Raging Goblin', 'Serra Angel'] });
    const p = g.players[0];
    g.openingHandEffects(p, 0);                                     // on the play: stays in hand
    expect(p.hand.length).toBe(3);
    g.openingHandEffects(p, 1);
    const gc = perm(g, 0, 'Gemstone Caverns');
    expect(gc.counters.LUCK).toBe(1);
    expect(p.hand.length).toBe(1);
    expect(p.exile.length).toBe(1);
    expect(g.payMana(0, 0, [{ options: ['G'] }], false)).toBe(true);   // luck counter: any color
  });

  it("Leyline of Hope's +2/+2 needs 7 life over the starting total", () => {
    const g = setup({ bf: ['Leyline of Hope', 'Raging Goblin'] });
    const gob = perm(g, 0, 'Raging Goblin');
    expect(g.statsOf(gob).power).toBe(1);
    g.players[0].life = 27;
    expect(g.statsOf(gob).power).toBe(3);
  });
});

d('evoke', () => {
  it('Solitude evoked by exiling a white card: exiles their creature, then is sacrificed', () => {
    const g = setup({ hand: ['Solitude', "Healer's Hawk"] }, { bf: ['Serra Angel'] });
    expect(g.castSpell(0, g.players[0].hand[0], { evoke: true })).toBe(true);
    expect(g.bf.some(x => x.def.name === 'Serra Angel')).toBe(false);
    expect(g.bf.some(x => x.def.name === 'Solitude')).toBe(false);
    expect(g.players[0].graveyard.map(c => c.def.name)).toContain('Solitude');
    expect(g.players[0].exile.map(c => c.def.name)).toContain("Healer's Hawk");
    expect(log(g)).toMatch(/casts Solitude \(evoked\)/);
  });

  it('the AI evokes a creature whose enters trigger is worth it', () => {
    const g = setup({ hand: ['Solitude', "Healer's Hawk"], bf: ['Plains'] }, { bf: ['Serra Angel'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/Solitude \(evoked\)/);
    expect(loadCard('Wistfulness').notes).toEqual([]);
  });
});

d('token copies', () => {
  it('Three Steps Ahead copies a creature', () => {
    const g = setup({ bf: ['Serra Angel'] });
    const copy = loadCard('Three Steps Ahead').spell!.effect.choices!.find(c => c.api === 'CopyPermanent')!;
    g.resolveEffect(copy, { p: 0, x: 0, kicked: false, targets: [], preset: [{ kind: 'perm', perm: perm(g, 0, 'Serra Angel') }] });
    const angels = g.bf.filter(x => x.def.name === 'Serra Angel');
    expect(angels.length).toBe(2);
    expect(angels.some(x => x.token)).toBe(true);
  });
});

d('cost increases and naming a card', () => {
  it("Thalia makes noncreature spells cost {1} more for both players", () => {
    const g = setup({ hand: ['Opt'], bf: ['Island'] }, { bf: ['Thalia, Guardian of Thraben'] });
    expect(g.spellCost(0, g.players[0].hand[0]).generic).toBe(1);
    expect(g.canCast(0, g.players[0].hand[0])).toBe(false);
  });

  it('Disruptor Flute names the opposing commander and taxes it', () => {
    const g = setup({}, {});
    g.players[1].command = [{ ...make(g, 1, 'Aurelia, the Warleader'), isCommander: true }];
    g.enter(make(g, 0, 'Disruptor Flute'), 0);
    expect(perm(g, 0, 'Disruptor Flute').namedCard).toBe('Aurelia, the Warleader');
    expect(g.spellCost(1, g.players[1].command[0]).generic).toBe(2 + 3);
  });

  it('"Choose a creature type" picks our most common type', () => {
    const g = setup({ hand: ['Llanowar Elves', 'Llanowar Elves'] });
    g.enter(make(g, 0, 'Adaptive Automaton'), 0);
    expect(perm(g, 0, 'Adaptive Automaton').chosenType).toBe('Elf');
  });
});

d('delayed triggers', () => {
  it('Mana Drain: the countered spell\'s mana value as {C} at our next main phase', () => {
    const g = setup({ hand: ['Serra Angel'], bf: ['Plains', 'Plains', 'Plains', 'Plains', 'Plains'] }, { hand: ['Mana Drain'], bf: ['Island', 'Island'] });
    g.castSpell(0, g.players[0].hand[0]);
    expect(g.players[0].graveyard.map(c => c.def.name)).toContain('Serra Angel');
    expect(g.delayed.length).toBe(1);
    g.emit({ type: 'phase', phase: 'Main1', player: 0 });            // not P1's main phase
    expect(g.players[1].pool ?? []).toEqual([]);
    g.active = 1;
    g.emit({ type: 'phase', phase: 'Main1', player: 1 });
    expect(g.players[1].pool).toEqual(['C', 'C', 'C', 'C', 'C']);
    expect(g.delayed.length).toBe(0);
    expect(loadCard('Mana Drain').notes).toEqual([]);
  });

  it('Mistrise Village: the next spell can\'t be countered', () => {
    const g = setup({ hand: ['Serra Angel'], bf: ['Mistrise Village', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Island'] }, { hand: ['Mana Drain'], bf: ['Island', 'Island'] });
    const village = perm(g, 0, 'Mistrise Village');
    const ab = village.def.abilities.find(a => a.effect.api === 'DelayedTrigger')!;
    g.resolveEffect(ab.effect, { p: 0, source: village, x: 0, kicked: false, targets: [] });
    g.castSpell(0, g.players[0].hand[0]);
    expect(g.bf.some(x => x.def.name === 'Serra Angel')).toBe(true);
  });
});

d('abilities granted by statics', () => {
  it('Adagia at 12 charge counters can copy an artifact (granted activated ability)', () => {
    const g = setup({ bf: ['Adagia, Windswept Bastion', 'Leyline Axe'] });
    const adagia = perm(g, 0, 'Adagia, Windswept Bastion');
    expect(g.grantedAbilities(adagia).filter(a => a.kind === 'activated')).toEqual([]);
    adagia.counters.CHARGE = 12;
    expect(g.grantedAbilities(adagia).some(a => a.effect.api === 'CopyPermanent')).toBe(true);
  });

  it('notes for these meta cards are gone', () => {
    for (const n of ['Adagia, Windswept Bastion', 'Extinguisher Battleship', 'Multiversal Passage', 'Leyline of Hope', 'Thalia, Guardian of Thraben', 'Three Steps Ahead'])
      expect([n, loadCard(n).notes]).toEqual([n, []]);
  });
});

d('reanimator and graveyard mechanics', () => {
  it('Delve exiles graveyard cards to pay generic mana (lands and spells before creatures)', () => {
    const g = setup({ hand: ['Treasure Cruise'], bf: ['Island'], graveyard: ['Opt', 'Forest', 'Serra Angel', 'Opt', 'Plains', 'Opt', 'Raging Goblin'] });
    const p = g.players[0];
    expect(g.canCast(0, p.hand[0])).toBe(true);           // {7}{U}: 7 cards delved, Island pays {U}
    expect(g.castSpell(0, p.hand[0])).toBe(true);
    expect(p.exile.length).toBe(7);
    expect(loadCard('Treasure Cruise').notes).toEqual([]);
  });

  it('Raise the Past returns creature cards with mana value 2 or less', () => {
    const g = setup({ graveyard: ['Raging Goblin', 'Llanowar Elves', 'Serra Angel'] });
    g.resolveEffect(loadCard('Raise the Past').spell!.effect, { p: 0, x: 0, kicked: false, targets: [] });
    expect(g.bf.filter(x => x.controller === 0).map(x => x.def.name).sort()).toEqual(['Llanowar Elves', 'Raging Goblin']);
    expect(g.players[0].graveyard.map(c => c.def.name)).toEqual(['Serra Angel']);
  });

  it('Bringer of the Last Gift: everyone sacrifices, then returns what was already in the graveyard', () => {
    const g = setup({ bf: ['Raging Goblin'], graveyard: ['Serra Angel'] }, { bf: ['Llanowar Elves'], graveyard: ['Healer\'s Hawk'] });
    g.enter(make(g, 0, 'Bringer of the Last Gift'), 0);
    const names = (pid: number) => g.bf.filter(x => x.controller === pid).map(x => x.def.name).sort();
    expect(names(0)).toEqual(['Bringer of the Last Gift', 'Serra Angel']);
    expect(names(1)).toEqual(["Healer's Hawk"]);
    expect(g.players[0].graveyard.map(c => c.def.name)).toEqual(['Raging Goblin']);
  });

  it('Superior Spider-Man enters as a 4/4 copy of the best creature card in a graveyard and exiles it', () => {
    const g = setup({ graveyard: ['Raging Goblin'] }, { graveyard: ['Serra Angel'] });
    const sm = g.enter(make(g, 0, 'Superior Spider-Man'), 0);
    expect(sm.def.name).toBe('Superior Spider-Man');
    expect(sm.def.keywords).toContain('Flying');
    expect(g.statsOf(sm)).toMatchObject({ power: 4, toughness: 4 });
    expect(g.players[1].exile.map(c => c.def.name)).toEqual(['Serra Angel']);
    g.destroy(sm);
    expect(g.players[0].graveyard.map(c => c.def.name)).toContain('Superior Spider-Man');
  });

  it('Dark Ritual is cast only when it enables a spell', () => {
    const g = setup({ hand: ['Dark Ritual', 'Serra Angel'], bf: ['Swamp', 'Plains'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).not.toMatch(/Dark Ritual/);
    const g2 = setup({ hand: ['Dark Ritual', 'Sheoldred, the Apocalypse'], bf: ['Swamp', 'Swamp'] });
    AI.mainPhase(g2, g2.players[0], 1);
    expect(log(g2)).toMatch(/casts Dark Ritual[\s\S]*casts Sheoldred/);
  });
});

d('self cost reduction', () => {
  it('Ghalta, Primal Hunger costs {X} less where X is the total power of your creatures', () => {
    const g = setup({ hand: ['Ghalta, Primal Hunger'], bf: ['Serra Angel', 'Raging Goblin'] });
    expect(g.spellCost(0, g.players[0].hand[0]).generic).toBe(10 - 5);
  });
});

d('land-played triggers and activation locks', () => {
  it('Shadow of the Goblin does not ping for a land played from our own hand', () => {
    const g = setup({ hand: ['Forest'], bf: ['Shadow of the Goblin'] });
    g.playLand(g.players[0], g.players[0].hand[0], true);
    expect(g.players[1].life).toBe(20);
    expect(loadCard('Shadow of the Goblin').notes).toEqual([]);
  });

  it('Burgeoning: whenever an opponent plays a land, put a land from hand onto the battlefield', () => {
    const g = setup({ hand: ['Forest'] }, { hand: ['Plains'], bf: ['Burgeoning'] });
    g.players[1].hand.push(make(g, 1, 'Forest'));
    g.playLand(g.players[0], g.players[0].hand[0], true);
    expect(g.bf.filter(x => x.controller === 1 && x.def.types.includes('Land')).length).toBe(1);
  });

  it("Disruptor Flute stops the named card's non-mana activated abilities", () => {
    const g = setup({ bf: ['Restless Anchorage', 'Plains', 'Island', 'Island'] }, {});
    const flute = g.enter(make(g, 1, 'Disruptor Flute'), 1);
    flute.namedCard = 'Restless Anchorage';
    expect(g.cantActivate(perm(g, 0, 'Restless Anchorage'), false)).toBe(true);
    expect(g.cantActivate(perm(g, 0, 'Restless Anchorage'), true)).toBe(false);
  });
});
