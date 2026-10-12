// Runs many games between two decks and aggregates results.
import { Game, GameOptions } from '../engine/game.js';
import type { DeckList } from '../engine/state.js';

export interface MatchOptions {
  games: number;
  format: 'standard' | 'brawl';
  maxTurns: number;
  seed: number;
  trace?: boolean;
  /** Called after each game with the number of games finished so far. */
  onProgress?: (done: number, total: number) => void;
}

/** Per-card results for deck A (player 0), keyed by card name. */
export interface CardStat {
  seen: number;      // games where the card was in hand at some point (kept opener or drawn)
  seenWins: number;
  cast: number;      // games where it was cast (spells) or played (lands)
  castWins: number;
}

export interface MatchResult {
  decks: [string, string];
  games: number;
  wins: [number, number];
  draws: number;
  onPlay: [number, number];           // wins when going first
  onPlayGames: [number, number];
  avgTurns: number;
  avgWinTurn: [number, number];
  avgDamage: [number, number];
  avgCountered: [number, number];
  avgMulligans: [number, number];
  traces: string[][];
  cards: Record<string, CardStat>;
}

export function runMatch(a: DeckList, b: DeckList, opts: MatchOptions): MatchResult {
  const r: MatchResult = {
    decks: [a.name, b.name], games: opts.games, wins: [0, 0], draws: 0, onPlay: [0, 0], onPlayGames: [0, 0],
    avgTurns: 0, avgWinTurn: [0, 0], avgDamage: [0, 0], avgCountered: [0, 0], avgMulligans: [0, 0], traces: [], cards: {},
  };
  const winTurns: [number[], number[]] = [[], []];
  for (let i = 0; i < opts.games; i++) {
    const first = i % 2;                          // alternate who is on the play
    const go: GameOptions = { format: opts.format, maxTurns: opts.maxTurns, seed: opts.seed + i * 7919, trace: opts.trace, firstPlayer: first };
    const g = new Game([a, b], go);
    const res = g.play();
    r.onPlayGames[first]++;
    if (res.winner === undefined) r.draws++;
    else {
      r.wins[res.winner]++;
      winTurns[res.winner].push(res.turns);
      if (res.winner === first) r.onPlay[first]++;
    }
    r.avgTurns += res.turns;
    for (const p of [0, 1] as const) {
      r.avgDamage[p] += g.stats.damage[p];
      r.avgCountered[p] += g.stats.countered[p];
      r.avgMulligans[p] += g.players[p].mulligans;
    }
    if (opts.trace) r.traces.push(g.log);
    const won = res.winner === 0 ? 1 : 0;
    for (const name of g.cardsSeen[0]) {
      const c = (r.cards[name] ??= { seen: 0, seenWins: 0, cast: 0, castWins: 0 });
      c.seen++; c.seenWins += won;
    }
    for (const name of g.cardsCast[0]) {
      const c = (r.cards[name] ??= { seen: 0, seenWins: 0, cast: 0, castWins: 0 });
      c.cast++; c.castWins += won;
    }
    opts.onProgress?.(i + 1, opts.games);
  }
  const n = opts.games;
  r.avgTurns /= n;
  for (const p of [0, 1] as const) {
    r.avgDamage[p] /= n; r.avgCountered[p] /= n; r.avgMulligans[p] /= n;
    r.avgWinTurn[p] = winTurns[p].length ? winTurns[p].reduce((x, y) => x + y, 0) / winTurns[p].length : 0;
  }
  return r;
}

export const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(1)}%` : '-');

/** 95% Wilson interval for a win rate, as percentages. */
export function wilson(wins: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, ph = wins / n;
  const den = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / den;
  return [100 * (c - h), 100 * (c + h)];
}
