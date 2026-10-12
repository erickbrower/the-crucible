// Worker thread: plays one matchup and streams progress back to the server.
import { parentPort } from 'node:worker_threads';
import { parseDeckText, buildDeck } from '../sim/deck.js';
import { runMatch } from '../sim/match.js';
import type { DeckList } from '../engine/state.js';

export interface MatchTask {
  id: number;
  deckText: string;
  oppText: string;
  oppName: string;
  games: number;
  seed: number;
  maxTurns: number;
  format: 'standard' | 'brawl';
}

export type WorkerMsg =
  | { type: 'progress'; id: number; done: number }
  | { type: 'done'; id: number; result: Omit<ReturnType<typeof runMatch>, 'traces'> }
  | { type: 'error'; id: number; error: string };

const decks = new Map<string, DeckList>();
function deck(text: string, name: string): DeckList {
  const key = name + '\n' + text;
  let d = decks.get(key);
  if (!d) {
    if (decks.size > 200) decks.clear();
    d = buildDeck(parseDeckText(text, name)).list;
    decks.set(key, d);
  }
  return d;
}

parentPort!.on('message', (t: MatchTask) => {
  try {
    const step = Math.max(1, Math.floor(t.games / 50));
    const { traces: _t, ...result } = runMatch(deck(t.deckText, 'deck'), deck(t.oppText, t.oppName), {
      games: t.games, seed: t.seed, maxTurns: t.maxTurns, format: t.format,
      onProgress: (done) => { if (done % step === 0 || done === t.games) parentPort!.postMessage({ type: 'progress', id: t.id, done } satisfies WorkerMsg); },
    });
    parentPort!.postMessage({ type: 'done', id: t.id, result } satisfies WorkerMsg);
  } catch (e) {
    parentPort!.postMessage({ type: 'error', id: t.id, error: (e as Error).message } satisfies WorkerMsg);
  }
});
