// Deep-Cavern Bat, "if ..." conditions on effects, Impending, and Huatli's saga back face.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { loadCard } from '../src/cards/compile.js';
import { d, setup, perm, make, log } from './helpers.js';

const etb = (name: string) => loadCard(name).triggers.find(t => t.mode === 'ChangesZone')!.effect!;

d('Deep-Cavern Bat', () => {
  it('exiles the opponent\'s best nonland card until the Bat leaves, then it goes back to their hand', () => {
    const g = setup({ bf: ['Deep-Cavern Bat'] }, { hand: ['Forest', 'Llanowar Elves', 'Serra Angel'] });
    const bat = perm(g, 0, 'Deep-Cavern Bat');
    g.resolveEffect(etb('Deep-Cavern Bat'), { p: 0, source: bat, x: 0, kicked: false, targets: [] });
    const opp = g.players[1];
    expect(opp.hand.map(c => c.def.name).sort()).toEqual(['Forest', 'Llanowar Elves']);
    expect(opp.exile.map(c => c.def.name)).toEqual(['Serra Angel']);
    g.destroy(bat);
    expect(opp.hand.map(c => c.def.name)).toContain('Serra Angel');
    expect(opp.exile).toEqual([]);
    expect(g.bf.some(x => x.def.name === 'Serra Angel')).toBe(false);
    expect(log(g)).toMatch(/Serra Angel returns to P1's hand/);
  });

  it('takes nothing from a hand of lands', () => {
    const g = setup({ bf: ['Deep-Cavern Bat'] }, { hand: ['Forest', 'Plains'] });
    g.resolveEffect(etb('Deep-Cavern Bat'), { p: 0, source: perm(g, 0, 'Deep-Cavern Bat'), x: 0, kicked: false, targets: [] });
    expect(g.players[1].hand.length).toBe(2);
    expect(loadCard('Deep-Cavern Bat').notes).toEqual([]);
  });
});

d('conditions on effects', () => {
  it('Prophesied End: the controller draws only if the creature wasn\'t attacking', () => {
    const spell = loadCard('Prophesied End').spell!.effect;
    const g = setup({}, { bf: ['Serra Angel', 'Raging Goblin'] });
    const before = g.players[1].hand.length;
    g.resolveEffect(spell, { p: 0, x: 0, kicked: false, targets: [], preset: [{ kind: 'perm', perm: perm(g, 1, 'Serra Angel') }] });
    expect(g.players[1].hand.length).toBe(before + 1);
    const gob = perm(g, 1, 'Raging Goblin');
    gob.attacking = true;
    g.resolveEffect(spell, { p: 0, x: 0, kicked: false, targets: [], preset: [{ kind: 'perm', perm: gob }] });
    expect(g.players[1].hand.length).toBe(before + 1);
  });

  it('Beorn draws two only with three or more Bears', () => {
    const trig = loadCard('Beorn the Fierce').triggers.find(t => t.mode === 'Phase')!.effect!;
    const g = setup({ bf: ['Beorn the Fierce', 'Raging Goblin'] });
    const hand = () => g.players[0].hand.length;
    const h0 = hand();
    const on = (name: string) => [{ kind: 'perm' as const, perm: perm(g, 0, name) }];
    g.resolveEffect(trig, { p: 0, source: perm(g, 0, 'Beorn the Fierce'), x: 0, kicked: false, targets: [], preset: on('Raging Goblin') });
    expect(hand()).toBe(h0);                                         // Beorn + the new Bear = 2
    expect(perm(g, 0, 'Raging Goblin').def.subtypes).toContain('Bear');
    expect(g.has(perm(g, 0, 'Raging Goblin'), 'Trample')).toBe(true);   // trample counter
    g.enter(make(g, 0, 'Llanowar Elves'), 0).sick = false;
    g.resolveEffect(trig, { p: 0, source: perm(g, 0, 'Beorn the Fierce'), x: 0, kicked: false, targets: [], preset: on('Llanowar Elves') });
    expect(hand()).toBe(h0 + 2);
  });

  it('Shadow of the Goblin draws only if a card was discarded', () => {
    const trig = loadCard('Shadow of the Goblin').triggers.find(t => t.mode === 'Phase')!.effect!;
    const g = setup({ bf: ['Shadow of the Goblin'] });
    g.players[0].hand = [];
    g.resolveEffect(trig, { p: 0, source: perm(g, 0, 'Shadow of the Goblin'), x: 0, kicked: false, targets: [] });
    expect(g.players[0].hand.length).toBe(0);
  });

  it('reports these conditions as modeled', () => {
    for (const n of ['Prophesied End', 'Beorn the Fierce', 'Budding Insurgent']) expect(loadCard(n).notes).toEqual([]);
  });
});

d('impending', () => {
  it('Overlord of the Hauntwoods cast for its impending cost: enters trigger now, a creature after four end steps', () => {
    const g = setup({ hand: ['Overlord of the Hauntwoods'], bf: ['Forest', 'Forest', 'Forest'] });
    const p = g.players[0];
    expect(g.castSpell(0, p.hand[0], { impending: true })).toBe(true);
    const ov = perm(g, 0, 'Overlord of the Hauntwoods');
    expect(ov.counters.TIME).toBe(4);
    expect(ov.def.types).not.toContain('Creature');
    expect(g.bf.some(x => x.def.name === 'Everywhere')).toBe(true);   // enters trigger
    for (let i = 0; i < 3; i++) g.tickImpending();
    expect(ov.def.types).not.toContain('Creature');
    g.tickImpending();
    expect(ov.def.types).toContain('Creature');
    expect(g.statsOf(ov).power).toBe(6);
  });

  it('the AI casts it for the impending cost when the full cost is out of reach', () => {
    const g = setup({ hand: ['Overlord of the Hauntwoods'], bf: ['Forest', 'Forest', 'Forest'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(log(g)).toMatch(/casts Overlord of the Hauntwoods \(impending\)/);
    expect(loadCard('Overlord of the Hauntwoods').notes).toEqual([]);
  });
});

d("Huatli's saga back face", () => {
  it('chapter II makes your creatures tap for R, G or W', () => {
    const g = setup({ bf: ['Raging Goblin'] });
    const roar = loadCard('Huatli, Poet of Unity').back!;
    const saga = g.enter({ id: g.nextId++, def: roar, owner: 0 }, 0);   // chapter I: two Dinosaurs
    expect(g.bf.filter(x => x.def.subtypes.includes('Dinosaur')).length).toBe(2);
    const before = g.availableMana(0);
    g.addLore(saga);                                                      // chapter II
    expect(g.availableMana(0)).toBe(before + 1);                          // the Goblin (the Dinosaurs are summoning sick)
    expect(g.payMana(0, 0, [{ options: ['W'] }], false)).toBe(true);
    expect(roar.notes).toEqual([]);
  });
});
