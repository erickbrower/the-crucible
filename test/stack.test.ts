// Textbook stack interactions, set up by hand so each test exercises exactly one rule.
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { forgeRes } from '../src/cards/forge.js';
import { loadCard } from '../src/cards/compile.js';
import { buildDeck } from '../src/sim/deck.js';
import { Game } from '../src/engine/game.js';
import type { CardInst } from '../src/engine/state.js';

const haveForge = fs.existsSync(forgeRes() + '/cardsfolder');
const d = haveForge ? describe : describe.skip;

interface Side { hand: string[]; bf: string[] }

/** A game frozen in P0's main phase with exactly these hands and battlefields. */
function setup(p0: Side, p1: Side) {
  const filler = buildDeck({ name: 'filler', main: [{ count: 40, name: 'Plains' }] }).list;
  const g = new Game([filler, filler], { format: 'standard', maxTurns: 10, seed: 1, firstPlayer: 0, trace: true });
  g.turn = 3; g.active = 0; g.phase = 'main1';
  const make = (pid: number, name: string): CardInst => ({ id: g.nextId++, def: loadCard(name), owner: pid });
  [p0, p1].forEach((side, pid) => {
    g.players[pid].hand = side.hand.map(n => make(pid, n));
    for (const n of side.bf) g.enter(make(pid, n), pid).sick = false;
  });
  return g;
}
const card = (g: Game, pid: number, name: string) => g.players[pid].hand.find(c => c.def.name === name)!;
const onBf = (g: Game, pid: number, name: string) => g.bf.some(x => x.controller === pid && x.def.name === name);
const inYard = (g: Game, pid: number, name: string) => g.players[pid].graveyard.some(c => c.def.name === name);

d('the stack', () => {
  it('counter war: Negate the Essence Scatter aimed at my creature', () => {
    const g = setup(
      { hand: ['Ordinary Bear', 'Negate'], bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Island', 'Island'] },
      { hand: ['Essence Scatter'], bf: ['Island', 'Island'] },
    );
    g.castSpell(0, card(g, 0, 'Ordinary Bear'));
    expect(g.log.join('\n')).toMatch(/casts Essence Scatter in response to Ordinary Bear/);
    expect(g.log.join('\n')).toMatch(/casts Negate in response to Essence Scatter/);
    expect(onBf(g, 0, 'Ordinary Bear')).toBe(true);
    expect(inYard(g, 1, 'Essence Scatter')).toBe(true);
    expect(g.stats.countered[1]).toBe(1);
    expect(g.stack).toHaveLength(0);
  });

  it('protect: Dive Down gives hexproof and the Shock fizzles', () => {
    const g = setup(
      { hand: ['Shock'], bf: ['Mountain'] },
      { hand: ['Dive Down'], bf: ["Kraven's Cats", 'Island'] },
    );
    g.castSpell(0, card(g, 0, 'Shock'));
    expect(g.log.join('\n')).toMatch(/casts Dive Down in response to Shock/);
    expect(g.log.join('\n')).toMatch(/Shock fizzles/);
    expect(onBf(g, 1, "Kraven's Cats")).toBe(true);
    expect(g.stats.fizzled[0]).toBe(1);
  });

  it('punish: Shock the creature in response to Giant Growth', () => {
    const g = setup(
      { hand: ['Shock'], bf: ['Mountain'] },
      { hand: ['Giant Growth'], bf: ["Kraven's Cats", 'Forest'] },
    );
    g.castSpell(1, card(g, 1, 'Giant Growth'));
    expect(g.log.join('\n')).toMatch(/casts Shock in response to Giant Growth/);
    expect(inYard(g, 1, "Kraven's Cats")).toBe(true);
    expect(g.stats.fizzled[1]).toBe(1);
  });

  it("does not try to counter a spell that can't be countered", () => {
    const g = setup(
      { hand: ['Long Goodbye'], bf: ['Swamp', 'Swamp'] },
      { hand: ['Negate'], bf: ["Kraven's Cats", 'Island', 'Island'] },
    );
    g.castSpell(0, card(g, 0, 'Long Goodbye'));
    expect(g.log.join('\n')).not.toMatch(/casts Negate/);
    expect(inYard(g, 1, "Kraven's Cats")).toBe(true);
  });

  it('does not spend a counter on a cheap cantrip', () => {
    const g = setup(
      { hand: ['Opt'], bf: ['Island'] },
      { hand: ['Negate'], bf: ['Island', 'Island'] },
    );
    g.castSpell(0, card(g, 0, 'Opt'));
    expect(g.players[1].hand.map(c => c.def.name)).toContain('Negate');
  });
});

d('conditional statics', () => {
  it('Twinblade Paladin has double strike only at 25+ life', () => {
    const g = setup({ hand: [], bf: ['Twinblade Paladin'] }, { hand: [], bf: [] });
    const pal = g.bf.find(x => x.def.name === 'Twinblade Paladin')!;
    g.players[0].life = 20;
    expect(g.statsOf(pal).keywords).not.toContain('Double Strike');
    g.players[0].life = 25;
    expect(g.statsOf(pal).keywords).toContain('Double Strike');
  });
});

d('intervening-if triggers', () => {
  it('Resplendent Angel makes an Angel only after 5+ life gained this turn', () => {
    const g = setup({ hand: [], bf: ['Resplendent Angel'] }, { hand: [], bf: [] });
    const angels = () => g.bf.filter(x => x.token && x.controller === 0).length;
    g.emit({ type: 'phase', phase: 'End of Turn', player: 0 });
    expect(angels()).toBe(0);
    g.gainLife(0, 5);
    g.emit({ type: 'phase', phase: 'End of Turn', player: 0 });
    expect(angels()).toBe(1);
  });
});
