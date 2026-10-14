// "Whenever you scry or surveil" triggers, doubling counters, and keyword counters.
import { it, expect } from 'vitest';
import { loadCard } from '../src/cards/compile.js';
import type { Effect } from '../src/cards/model.js';
import { d, setup, perm } from './helpers.js';

const scry = (n: number, surveil = false): Effect => ({ api: surveil ? 'Surveil' : 'Scry', params: surveil ? { Amount: String(n) } : { ScryNum: String(n) } });
const ctx = () => ({ p: 0, x: 0, kicked: false, targets: [] });

d('scry and surveil triggers', () => {
  it('Denzilore puts a +1/+1 counter on each creature you control whenever you scry or surveil', () => {
    const g = setup({ bf: ['Denzilore Fatehold', 'Raging Goblin'] }, { bf: ['Serra Angel'] });
    g.resolveEffect(scry(1), ctx());
    g.resolveEffect(scry(2, true), ctx());
    expect(perm(g, 0, 'Raging Goblin').counters.P1P1).toBe(2);
    expect(perm(g, 0, 'Denzilore Fatehold').counters.P1P1).toBe(2);
    expect(perm(g, 1, 'Serra Angel').counters.P1P1 ?? 0).toBe(0);
  });

  it('the opponent scrying does not trigger it, and neither does scry 0', () => {
    const g = setup({ bf: ['Denzilore Fatehold'] });
    g.resolveEffect(scry(1), { ...ctx(), p: 1 });
    g.resolveEffect(scry(0), ctx());
    expect(perm(g, 0, 'Denzilore Fatehold').counters.P1P1 ?? 0).toBe(0);
  });

  it('Saheeli makes one Thopter per turn however often you scry', () => {
    const g = setup({ bf: ['Saheeli, Consul of Oversight'] });
    g.resolveEffect(scry(1), ctx());
    g.resolveEffect(scry(1, true), ctx());
    expect(g.bf.filter(x => x.token && x.controller === 0).length).toBe(1);
  });

  it('reports the triggers as modeled', () => {
    for (const n of ['Denzilore Fatehold', 'Saheeli, Consul of Oversight']) expect(loadCard(n).notes).toEqual([]);
  });
});

d('doubling counters', () => {
  it('Mossborn Hydra doubles its +1/+1 counters on landfall', () => {
    const g = setup({ hand: ['Forest'], bf: ['Mossborn Hydra'] });
    const hydra = perm(g, 0, 'Mossborn Hydra');
    expect(hydra.counters.P1P1).toBe(1);
    g.playLand(g.players[0], g.players[0].hand[0], true);
    expect(hydra.counters.P1P1).toBe(2);
    expect(g.statsOf(hydra).power).toBe(2);
  });

  it('Bristly Bill doubles the +1/+1 counters on each creature you control', () => {
    const g = setup({ bf: ['Bristly Bill, Spine Sower', 'Raging Goblin'] }, { bf: ['Serra Angel'] });
    perm(g, 0, 'Raging Goblin').counters.P1P1 = 3;
    perm(g, 1, 'Serra Angel').counters.P1P1 = 2;
    const ab = loadCard('Bristly Bill, Spine Sower').abilities.find(a => a.effect.api === 'MultiplyCounter')!;
    g.resolveEffect(ab.effect, { ...ctx(), source: perm(g, 0, 'Bristly Bill, Spine Sower') });
    expect(perm(g, 0, 'Raging Goblin').counters.P1P1).toBe(6);
    expect(perm(g, 1, 'Serra Angel').counters.P1P1).toBe(2);
  });

  it('Ultimate Spider-Man doubles every kind of counter on Spiders and legends when you attack', () => {
    const g = setup({ bf: ['Miles Morales', 'Raging Goblin'] });
    const miles = perm(g, 0, 'Miles Morales');
    miles.def = miles.def.back!; miles.transformed = true;
    miles.counters.P1P1 = 2; miles.counters.Flying = 1;
    perm(g, 0, 'Raging Goblin').counters.P1P1 = 1;          // not a Spider, not legendary
    g.emit({ type: 'attackersDeclared', player: 0, attackers: [miles] });
    expect(miles.counters.P1P1).toBe(4);
    expect(miles.counters.Flying).toBe(2);
    expect(perm(g, 0, 'Raging Goblin').counters.P1P1).toBe(1);
  });

  it('Scythecat Cub puts a counter the first time and doubles the second time each turn', () => {
    const g = setup({ hand: ['Forest', 'Plains'], bf: ['Scythecat Cub'] });
    const cub = perm(g, 0, 'Scythecat Cub');
    g.playLand(g.players[0], g.players[0].hand[0], true);
    expect(cub.counters.P1P1).toBe(1);
    g.players[0].landsPlayed = 0;
    g.playLand(g.players[0], g.players[0].hand[0], true);
    expect(cub.counters.P1P1).toBe(2);
  });

  it('reports MultiplyCounter as modeled', () => {
    for (const n of ['Mossborn Hydra', 'Bristly Bill, Spine Sower', 'Scythecat Cub']) expect(loadCard(n).notes).toEqual([]);
    expect(loadCard('Miles Morales').back!.notes).toEqual([]);
  });
});

d('keyword counters', () => {
  it('a trample counter gives trample', () => {
    const g = setup({ bf: ['Raging Goblin'] });
    const gob = perm(g, 0, 'Raging Goblin');
    expect(g.has(gob, 'Trample')).toBe(false);
    g.addCounters(gob, 'Trample', 1);
    expect(g.has(gob, 'Trample')).toBe(true);
  });
});
