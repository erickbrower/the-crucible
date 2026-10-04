import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { forgeRes } from '../src/cards/forge.js';
import { loadCard } from '../src/cards/compile.js';
import { buildDeck } from '../src/sim/deck.js';
import { Game } from '../src/engine/game.js';
import { runMatch } from '../src/sim/match.js';

const haveForge = fs.existsSync(forgeRes() + '/cardsfolder');
const d = haveForge ? describe : describe.skip;   // needs `npm run fetch-cards`

const mono = (name: string, spells: [number, string][], land: string, n: number) =>
  buildDeck({ name, main: [...spells.map(([count, name]) => ({ count, name })), { count: n, name: land }] }).list;

d('cards from Forge scripts', () => {
  it('compiles a burn spell and a creature', () => {
    const shock = loadCard('Shock');
    expect(shock.spell?.effect.api).toBe('DealDamage');
    const hawk = loadCard("Healer's Hawk");
    expect(hawk.keywords).toEqual(expect.arrayContaining(['Flying', 'Lifelink']));
  });
});

d('engine', () => {
  it('plays deterministic games with the same seed', () => {
    const a = mono('Red', [[20, 'Shock'], [20, 'Savannah Lions']], 'Mountain', 20);
    const b = mono('White', [[40, "Healer's Hawk"]], 'Plains', 20);
    const r1 = runMatch(a, b, { games: 20, format: 'standard', maxTurns: 20, seed: 9 });
    const r2 = runMatch(a, b, { games: 20, format: 'standard', maxTurns: 20, seed: 9 });
    expect(r1.wins).toEqual(r2.wins);
    expect(r1.wins[0] + r1.wins[1] + r1.draws).toBe(20);
  });

  it('flying lifelinkers gain life, and burn kills', () => {
    const a = mono('Hawks', [[40, "Healer's Hawk"]], 'Plains', 20);
    const b = mono('Lands', [], 'Mountain', 60);
    const g = new Game([a, b], { format: 'standard', maxTurns: 25, seed: 1, firstPlayer: 0 });
    const res = g.play();
    expect(res.winner).toBe(0);
    expect(g.players[0].life).toBeGreaterThan(20);
  });

  it('casts the commander from the command zone with tax', () => {
    const list = { ...mono('Cmdr', [], 'Plains', 99), commander: loadCard('Liliana the Faultless') };
    const opp = mono('Lands', [], 'Swamp', 100);
    const g = new Game([list, opp], { format: 'brawl', maxTurns: 10, seed: 3, firstPlayer: 0 });
    g.play();
    expect(g.stats.commanderCasts[0]).toBeGreaterThan(0);
    expect(g.players[1].life).toBeLessThan(25);
  });

  it('counterspells counter', () => {
    const blue = mono('Counters', [[40, 'Essence Scatter']], 'Island', 20);
    const green = mono('Bears', [[40, 'Ordinary Bear']], 'Forest', 20);
    const r = runMatch(blue, green, { games: 10, format: 'standard', maxTurns: 10, seed: 5 });
    expect(r.avgCountered[1]).toBeGreaterThan(0);
  });
});
