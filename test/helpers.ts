// Shared helpers for hand-built game states.
import fs from 'node:fs';
import { describe } from 'vitest';
import { forgeRes } from '../src/cards/forge.js';
import { loadCard } from '../src/cards/compile.js';
import { buildDeck } from '../src/sim/deck.js';
import { Game } from '../src/engine/game.js';
import type { CardInst, Perm } from '../src/engine/state.js';

export const haveForge = fs.existsSync(forgeRes() + '/cardsfolder');
export const d = haveForge ? describe : describe.skip;   // needs `npm run fetch-cards`

export interface Side { hand?: string[]; bf?: string[]; library?: string[]; graveyard?: string[] }

/** A game frozen in P0's main phase with exactly these zones. Battlefield permanents are untapped and not summoning sick. */
export function setup(p0: Side, p1: Side = {}, opts: { life?: number } = {}) {
  const filler = buildDeck({ name: 'filler', main: [{ count: 40, name: 'Plains' }] }).list;
  const g = new Game([filler, filler], { format: 'standard', maxTurns: 10, seed: 1, firstPlayer: 0, trace: true });
  g.turn = 3; g.active = 0; g.phase = 'main1';
  [p0, p1].forEach((side, pid) => {
    const pl = g.players[pid];
    pl.hand = (side.hand ?? []).map(n => make(g, pid, n));
    pl.graveyard = (side.graveyard ?? []).map(n => make(g, pid, n));
    if (side.library) pl.library = side.library.map(n => make(g, pid, n)).reverse();   // first listed = top
    for (const n of side.bf ?? []) g.enter(make(g, pid, n), pid).sick = false;
    if (opts.life) pl.life = opts.life;
  });
  return g;
}
export const make = (g: Game, pid: number, name: string): CardInst => ({ id: g.nextId++, def: loadCard(name), owner: pid });
export const card = (g: Game, pid: number, name: string) => g.players[pid].hand.find(c => c.def.name === name)!;
export const perm = (g: Game, pid: number, name: string) => g.bf.find(x => x.controller === pid && x.def.name === name)!;
export const onBf = (g: Game, pid: number, name: string) => g.bf.some(x => x.controller === pid && x.def.name === name);
export const inYard = (g: Game, pid: number, name: string) => g.players[pid].graveyard.some(c => c.def.name === name);
export const log = (g: Game) => g.log.join('\n');

/** Declare attackers (tapping non-vigilant ones), fire attack triggers, then deal combat damage with the given blocks. */
export function fight(g: Game, attackers: Perm[], blocks: [Perm, Perm[]][] = []) {
  g.phase = 'combat';
  for (const a of attackers) { a.attacking = true; if (!g.has(a, 'Vigilance')) a.tapped = true; }
  g.emit({ type: 'attackersDeclared', player: g.active, attackers });
  for (const a of attackers) if (g.bf.includes(a)) g.emit({ type: 'attacks', perm: a });
  const m = new Map(blocks);
  for (const [, bs] of m) for (const b of bs) b.blocking = true;
  // tokens created tapped and attacking (mobilize) join in
  g.resolveCombatDamage(g.bf.filter(x => x.attacking && x.controller === g.active), m);
}
