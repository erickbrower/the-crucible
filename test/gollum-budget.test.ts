// Mechanics for the budget Gollum Commander deck: discard triggers, Dauthi Voidwalker, Shadow, Gix,
// Gix's Command, Archfiend of the Dross, Blitz, Spectacle, Adventure, Sorin, Liliana's piles, Hive and Kai Winn.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { coverage } from '../src/cards/compile.js';
import { d, setup, card, perm, onBf, inYard, fight, log, make } from './helpers.js';

const SW = (n: number) => Array(n).fill('Swamp');

d('gollum budget: discard', () => {
  it('Tourach grows when an opponent discards; Tinybones pings once per discarding player', () => {
    const g = setup({ bf: ['Tourach, Dread Cantor', 'Tinybones, Pocket Nuisance', ...SW(3)], hand: ['Mind Rot'] },
      { hand: ['Plains', 'Island', 'Forest'] });
    const life = g.players[1].life;
    g.castSpell(0, card(g, 0, 'Mind Rot')); g.settle(0);
    expect(perm(g, 0, 'Tourach, Dread Cantor').counters.P1P1).toBe(2);
    expect(g.players[1].life).toBe(life - 1);              // one ping for the whole batch, not two
  });

  it('the discarding player chooses what to discard when the spell says so', () => {
    const g = setup({ bf: [...SW(2)], hand: ['Mind Rot'] }, { hand: ['Plains', 'Island', 'Sheoldred, the Apocalypse'] });
    g.castSpell(0, card(g, 0, 'Mind Rot')); g.settle(0);
    expect(g.players[1].hand.map(c => c.def.name)).toContain('Sheoldred, the Apocalypse');
  });
});

d('gollum budget: Dauthi Voidwalker', () => {
  it('exiles opponent cards with void counters, has shadow, and can cast one free', () => {
    const g = setup({ bf: ['Dauthi Voidwalker'] }, { bf: ['Grizzly Bears'], hand: ['Shock'] });
    g.leave(perm(g, 1, 'Grizzly Bears'), 'graveyard');
    expect(inYard(g, 1, 'Grizzly Bears')).toBe(false);
    expect(g.players[1].exile.map(c => c.def.name)).toContain('Grizzly Bears');
    expect(coverage(make(g, 0, 'Dauthi Voidwalker').def).ok).toBe(true);
    // shadow: a normal creature can't block it
    const g2 = setup({ bf: ['Dauthi Voidwalker'] }, { bf: ['Grizzly Bears'] });
    g2.active = 0;
    const atk = perm(g2, 0, 'Dauthi Voidwalker');
    atk.attacking = true;
    const blocks = AI.chooseBlocks(g2, g2.players[1], [atk]);
    expect([...blocks.values()].flat().length).toBe(0);
    // sacrifice it to cast the void card free
    for (const x of g.bf) x.tapped = false;
    const vw = perm(g, 0, 'Dauthi Voidwalker');
    const ab = vw.def.abilities.find(a => a.effect.api === 'ChooseCard')!;
    vw.tapped = true; g.leave(vw, 'graveyard', { sacrificed: true });
    g.resolveEffect(ab.effect, { p: 0, source: vw, x: 0, kicked: false, targets: [] });
    expect(g.players[0].mayPlay?.some(m => m.card.def.name === 'Grizzly Bears' && m.free)).toBe(true);
    expect(g.castSpell(0, g.players[0].mayPlay![0].card, { fromExile: true })).toBe(true);
    g.settle(0);
    expect(onBf(g, 0, 'Grizzly Bears')).toBe(true);
  });
});

d('gollum budget: Gix and friends', () => {
  it("Gix's Command: counters on our creature and the opponent sacrifices their biggest", () => {
    const g = setup({ bf: ['Grizzly Bears', ...SW(5)] }, { bf: ['Colossal Dreadmaw', 'Llanowar Elves'] });
    const cmd = make(g, 0, "Gix's Command");
    const modes = cmd.def.spell!.effect.choices!;
    g.resolveEffect(modes[0], { p: 0, card: cmd, x: 0, kicked: false, targets: [] });
    g.resolveEffect(modes[3], { p: 0, card: cmd, x: 0, kicked: false, targets: [] });
    expect(perm(g, 0, 'Grizzly Bears').counters.P1P1).toBe(2);
    expect(onBf(g, 1, 'Colossal Dreadmaw')).toBe(false);
    expect(onBf(g, 1, 'Llanowar Elves')).toBe(true);
  });

  it('Archfiend of the Dross: you lose when the last oil counter comes off', () => {
    const g = setup({ bf: ['Archfiend of the Dross'] });
    const a = perm(g, 0, 'Archfiend of the Dross');
    a.counters.OIL = 1;
    const up = a.def.triggers.find(t => t.mode === 'Phase')!;
    g.resolveEffect(up.effect!, { p: 0, source: a, x: 0, kicked: false, targets: [] });
    expect(g.over).toBe(true);
    expect(g.winner).toBe(1);
  });

  it('Graveyard Marshal exiles a creature card from our graveyard to make a Zombie', () => {
    const g = setup({ bf: ['Graveyard Marshal', ...SW(3)], graveyard: ['Grizzly Bears'] });
    g.phase = 'main2';
    AI.mainPhase(g, g.players[0], 2);
    expect(log(g)).toMatch(/exiles Grizzly Bears from the graveyard/);
    expect(g.bf.filter(x => x.token && x.def.subtypes.includes('Zombie')).length).toBe(1);
  });

  it('Gix discards X to cast the top X cards of the opponent library free', () => {
    const g = setup({ bf: ['Gix, Yawgmoth Praetor', ...SW(7)], hand: ['Colossal Dreadmaw', 'Colossal Dreadmaw', 'Swamp'] },
      { library: ['Grizzly Bears', 'Llanowar Elves', 'Shock', 'Plains'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/activates Gix/);
    expect(onBf(g, 0, 'Grizzly Bears')).toBe(true);
  });
});

d('gollum budget: alternate casting', () => {
  it('Blitz: haste, draw on death, sacrificed at end step; Tenacious Underdog from the graveyard', () => {
    const g = setup({ bf: SW(4), graveyard: ['Tenacious Underdog'], library: ['Swamp', 'Swamp'] }, {}, { life: 30 });
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/casts Tenacious Underdog \(blitz\)/);
    const u = perm(g, 0, 'Tenacious Underdog');
    expect(g.has(u, 'Haste')).toBe(true);
    expect(g.players[0].life).toBe(28);
    const hand = g.players[0].hand.length;
    g.sacrificeBlitzed();
    expect(g.players[0].hand.length).toBe(hand + 1);
    expect(inYard(g, 0, 'Tenacious Underdog')).toBe(true);
  });

  it('Spectacle: Spawn of Mayhem for 1BB once the opponent lost life', () => {
    const g = setup({ bf: SW(3), hand: ['Spawn of Mayhem'] });
    expect(g.castSpell(0, card(g, 0, 'Spawn of Mayhem'), { spectacle: true })).toBe(false);
    g.loseLife(1, 1);
    expect(g.castSpell(0, card(g, 0, 'Spawn of Mayhem'), { spectacle: true })).toBe(true);
    g.settle(0);
    expect(onBf(g, 0, 'Spawn of Mayhem')).toBe(true);
  });

  it('Adventure: Swift End kills, then Murderous Rider is cast from exile', () => {
    const g = setup({ bf: SW(6), hand: ['Murderous Rider'] }, { bf: ['Colossal Dreadmaw'] }, { life: 25 });
    expect(g.castSpell(0, card(g, 0, 'Murderous Rider'), { adventure: true })).toBe(true);
    g.settle(0);
    expect(onBf(g, 1, 'Colossal Dreadmaw')).toBe(false);
    expect(g.players[0].life).toBe(23);
    const rider = g.players[0].exile.find(c => c.def.name === 'Murderous Rider')!;
    expect(rider).toBeTruthy();
    expect(g.castSpell(0, rider, { fromExile: true })).toBe(true);
    g.settle(0);
    expect(onBf(g, 0, 'Murderous Rider')).toBe(true);
  });
});

d('gollum budget: planeswalkers, lands, Kai Winn', () => {
  it('Sorin +1 puts the top card into hand and costs life equal to its mana value', () => {
    const g = setup({ bf: ['Sorin the Mirthless'], library: ['Grizzly Bears', 'Swamp'] }, {}, { life: 30 });
    const s = perm(g, 0, 'Sorin the Mirthless');
    const plus = s.def.abilities.find(a => a.effect.api === 'PeekAndReveal')!;
    g.resolveEffect(plus.effect, { p: 0, source: s, x: 0, kicked: false, targets: [] });
    expect(card(g, 0, 'Grizzly Bears')).toBeTruthy();
    expect(g.players[0].life).toBe(28);
  });

  it('Liliana −6: the opponent sacrifices one of two piles', () => {
    const g = setup({ bf: ['Liliana of the Veil'] }, { bf: ['Colossal Dreadmaw', 'Grizzly Bears', 'Llanowar Elves', 'Plains'] });
    const l = perm(g, 0, 'Liliana of the Veil');
    const ult = l.def.abilities.find(a => a.effect.api === 'TwoPiles')!;
    g.resolveEffect(ult.effect, { p: 0, source: l, x: 0, kicked: false, targets: [{ kind: 'player', pid: 1 }], preset: [{ kind: 'player', pid: 1 }] });
    const left = g.bf.filter(x => x.controller === 1).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(4);
  });

  it('Hive of the Eye Tyrant: the animated land gains its attack trigger', () => {
    const g = setup({ bf: ['Hive of the Eye Tyrant', ...SW(4)] }, { graveyard: ['Grizzly Bears'] });
    const h = perm(g, 0, 'Hive of the Eye Tyrant');
    const ab = h.def.abilities.find(a => a.effect.api === 'Animate')!;
    g.resolveEffect(ab.effect, { p: 0, source: h, x: 0, kicked: false, targets: [] });
    expect(h.def.triggers.some(t => t.mode === 'Attacks')).toBe(true);
    fight(g, [h]);
    expect(g.players[1].graveyard.length).toBe(0);
  });

  it('Kai Winn punishes the opponent for casting the named card', () => {
    const g = setup({ bf: ['Kai Winn, Faithless Leader'] }, { bf: ['Mountain'], hand: ['Shock'] });
    perm(g, 0, 'Kai Winn, Faithless Leader').namedCard = 'Shock';
    g.active = 1;
    const life = g.players[1].life;
    g.castSpell(1, card(g, 1, 'Shock')); g.settle(1);
    expect(g.players[1].life).toBe(life - 3);
  });
});

import { Game } from '../src/engine/game.js';
import { buildDeck, parseDeckText } from '../src/sim/deck.js';
import { deckFormat, engineRules, parseFormat } from '../src/sim/format.js';
import { commanderIllegal } from '../src/ui/analysis.js';

d('paper Commander format', () => {
  const deckText = (extra: string) => `# format: commander\nCommander\n1 Gollum, Riddle Master\n\nDeck\n${extra}\n94 Swamp\n`;
  it('is read from a "# format:" line and parsed from common names', () => {
    expect(parseFormat('edh')).toBe('commander');
    const deck = buildDeck(parseDeckText(deckText('1 Sol Ring')));
    expect(deckFormat(deck.list)).toBe('commander');
    expect(engineRules('commander')).toBe('commander');
  });

  it('flags banned cards and cards outside the color identity', () => {
    const deck = buildDeck(parseDeckText(deckText('1 Mana Crypt\n1 Cruel Celebrant\n1 Sol Ring\n1 Blood Artist')));
    const bad = commanderIllegal(deck);
    expect(bad).toContain('Mana Crypt (banned)');
    expect(bad).toContain('Cruel Celebrant (outside color identity)');
    expect(bad.join()).not.toMatch(/Sol Ring|Blood Artist/);
  });

  it('starts at 40 life and 21 combat damage from one commander loses', () => {
    const list = buildDeck(parseDeckText(deckText('5 Swamp'))).list;
    const g = new Game([list, list], { format: 'commander', maxTurns: 10, seed: 1, firstPlayer: 0, trace: true });
    expect(g.players[0].life).toBe(40);
    const cmd = g.players[0].command[0];
    g.players[0].command = [];
    const p = g.enter(cmd, 0);
    g.dealDamage(p, 0, { kind: 'player', pid: 1 }, 15, true);
    expect(g.over).toBe(false);
    g.dealDamage(p, 0, { kind: 'player', pid: 1 }, 6, true);
    expect(g.over).toBe(true);
    expect(g.players[1].life).toBe(19);
    expect(log(g)).toMatch(/commander damage/);
  });
});
