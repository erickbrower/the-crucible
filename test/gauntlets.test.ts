import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadDeck, parseDeckText } from '../src/sim/deck.js';
import { runMatch } from '../src/sim/match.js';
import { FORMATS, FORMAT_SIZE, deckFormat, gauntletDir, parseFormat, engineRules } from '../src/sim/format.js';
import { isLegal } from '../src/cards/formats.js';

const BASIC = /^(snow-covered )?(plains|island|swamp|mountain|forest|wastes)$/i;

describe('format detection', () => {
  const fake = (n: number, commander: boolean) => ({ main: new Array(n).fill({}), commander: commander ? ({} as any) : undefined });
  it('tells the three formats apart by commander and size', () => {
    expect(deckFormat(fake(60, false))).toBe('standard');
    expect(deckFormat(fake(59, true))).toBe('standard-brawl');
    expect(deckFormat(fake(99, true))).toBe('brawl');
  });
  it('maps both brawl formats to brawl game rules', () => {
    expect(engineRules('standard')).toBe('standard');
    expect(engineRules('standard-brawl')).toBe('brawl');
    expect(engineRules('brawl')).toBe('brawl');
  });
  it('accepts common names for formats', () => {
    expect(parseFormat('Standard Brawl')).toBe('standard-brawl');
    expect(parseFormat('historic-brawl')).toBe('brawl');
    expect(() => parseFormat('modern')).toThrow();
  });
});

describe('Standard legality', () => {
  it('knows current Standard cards, bans and rotated cards', () => {
    expect(isLegal('Llanowar Elves')).toBe(true);           // Foundations
    expect(isLegal('Plains')).toBe(true);
    expect(isLegal('Cori-Steel Cutter')).toBe(false);       // banned
    expect(isLegal('Lightning Bolt')).toBe(false);          // not in a Standard set
  });
});

// Like against like: every gauntlet deck must be a legal, playable deck of its folder's format.
for (const fmt of FORMATS) {
  const dir = gauntletDir(fmt);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort() : [];
  describe(`${fmt} gauntlet`, () => {
    it('has opponents', () => expect(files.length).toBeGreaterThanOrEqual(5));
    for (const f of files) {
      it(f, () => {
        const file = path.join(dir, f);
        const deck = loadDeck(file);
        expect(deck.missing).toEqual([]);
        expect(deckFormat(deck.list)).toBe(fmt);
        if (fmt === 'standard') expect(deck.size).toBeGreaterThanOrEqual(60);
        else expect(deck.size).toBe(FORMAT_SIZE[fmt]);

        const parsed = parseDeckText(fs.readFileSync(file, 'utf8'));
        const counts = new Map<string, number>();
        for (const c of parsed.main) counts.set(c.name, (counts.get(c.name) ?? 0) + c.count);
        const limit = fmt === 'standard' ? 4 : 1;
        const over = [...counts].filter(([n, k]) => k > limit && !BASIC.test(n)).map(([n]) => n);
        expect(over).toEqual([]);

        if (fmt !== 'brawl') {
          const names = [parsed.commander, ...counts.keys()].filter(Boolean) as string[];
          expect(names.filter(n => !isLegal(n))).toEqual([]);
        }
        if (deck.list.commander) {
          const ident = new Set(deck.list.commander.colors);
          const outside = deck.list.main.filter(c => !c.colors.every(x => ident.has(x))).map(c => c.name);
          expect(outside).toEqual([]);
        }

        // Smoke test: the engine can play this deck against every opponent in its gauntlet.
        for (const f2 of files) {
          const other = loadDeck(path.join(dir, f2));
          const r = runMatch(deck.list, other.list, { games: 2, format: engineRules(fmt), maxTurns: 25, seed: 7 });
          expect(r.games).toBe(2);
        }
      });
    }
  });
}
