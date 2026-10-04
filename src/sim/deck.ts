// Parses Arena-style deck text:
//   Commander            (optional section)
//   1 Eddie Brock
//
//   Deck
//   4 Shock
//   2 Swiftwater Cliffs (DMU) 260     <- set code / collector number are ignored
// Lines starting with # or // are comments. "Sideboard" and "Companion" sections are ignored.
import fs from 'node:fs';
import path from 'node:path';
import { loadCard, coverage } from '../cards/compile.js';
import type { CardDef } from '../cards/model.js';
import type { DeckList } from '../engine/state.js';

export interface ParsedDeck { name: string; commander?: string; main: { count: number; name: string }[] }

export function parseDeckText(text: string, name = 'deck'): ParsedDeck {
  const out: ParsedDeck = { name, main: [] };
  let section: 'deck' | 'commander' | 'skip' = 'deck';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const head = line.toLowerCase();
    if (head === 'commander') { section = 'commander'; continue; }
    if (head === 'deck' || head === 'main' || head === 'maindeck') { section = 'deck'; continue; }
    if (head === 'sideboard' || head === 'companion' || head === 'about') { section = 'skip'; continue; }
    if (head.startsWith('name ')) { out.name = line.slice(5).trim(); continue; }
    if (section === 'skip') continue;
    const m = line.match(/^(\d+)x?\s+(.+?)(?:\s+\([A-Z0-9]+\)(?:\s+\S+)?)?$/);
    if (!m) continue;
    const count = +m[1];
    const card = m[2].trim();
    if (section === 'commander') out.commander = card;
    else out.main.push({ count, name: card });
  }
  return out;
}

export interface LoadedDeck { list: DeckList; missing: string[]; size: number }

export function loadDeck(file: string): LoadedDeck {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseDeckText(text, path.basename(file).replace(/\.txt$/, ''));
  return buildDeck(parsed);
}

export function buildDeck(parsed: ParsedDeck): LoadedDeck {
  const missing: string[] = [];
  const main: CardDef[] = [];
  const get = (n: string) => { try { return loadCard(n); } catch { missing.push(n); return undefined; } };
  for (const { count, name } of parsed.main) {
    const d = get(name);
    if (d) for (let i = 0; i < count; i++) main.push(d);
  }
  const commander = parsed.commander ? get(parsed.commander) : undefined;
  return { list: { name: parsed.name, main, commander }, missing, size: main.length + (commander ? 1 : 0) };
}

/** Per-card coverage notes for a deck (cards the engine ignores or approximates). */
export function deckCoverage(list: DeckList) {
  const seen = new Map<string, string[]>();
  for (const d of [list.commander, ...list.main]) {
    if (!d || seen.has(d.name)) continue;
    const c = coverage(d);
    const back = d.back ? coverage(d.back).notes.map(n => `[back] ${n}`) : [];
    seen.set(d.name, [...c.notes, ...back]);
  }
  return seen;
}
