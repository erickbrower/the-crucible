// The mechanics report: parsing rules 701/702 and matching them to cards and engine support.
import { it, expect } from 'vitest';
import { parseRules, mechanicsReport } from '../src/tools/mechanics.js';
import { d } from './helpers.js';

// a made-up miniature of the rules file's layout (the real file is downloaded by `npm run fetch-rules`)
const FIXTURE = [
  ...Array(210).fill('filler'),
  '701.1. General', '', '701.1a Example general rule.', '',
  '701.22. Scry', '', '701.22a To scry N means to look at the top N cards. More text.', '',
  '702.1. General', '',
  '702.19. Trample', '', '702.19a Trample is a static ability.', '',
  '702.74. Evoke', '', '702.74a Evoke is a static ability.', '',
  '702.86. Annihilator', '', '702.86a Annihilator is a triggered ability.', '',
  '702.999. Imaginary Thing', '', '702.999a Nobody has this.', '',
].join('\r\n');

it('parses keyword actions and abilities, skipping the general rules', () => {
  const m = parseRules(FIXTURE);
  expect(m.map(x => `${x.rule} ${x.name} ${x.kind}`)).toEqual([
    '701.22 Scry action', '702.19 Trample ability', '702.74 Evoke ability', '702.86 Annihilator ability', '702.999 Imaginary Thing ability',
  ]);
  expect(m[0].definition).toBe('To scry N means to look at the top N cards.');
});

d('mechanics report', () => {
  it('marks supported, missing and unused mechanics from the decks', () => {
    const rows = mechanicsReport(FIXTURE, [{ dir: 'decks/gauntlet/standard', mine: false }, { dir: 'decks/gauntlet/brawl', mine: false }]);
    const by = (n: string) => rows.find(r => r.name === n)!;
    expect(by('Trample').status).toBe('supported');
    expect(by('Trample').gauntlet.length).toBeGreaterThan(0);
    expect(by('Evoke').status).toBe('supported');
    expect(by('Annihilator').status).toBe('missing');       // Emrakul and Ulamog in the Brawl gauntlet
    expect(by('Annihilator').gapCards.length).toBeGreaterThan(0);
    expect(by('Imaginary Thing').status).toBe('not modeled');
  });
});
