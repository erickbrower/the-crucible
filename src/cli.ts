#!/usr/bin/env tsx
// Usage:
//   npm run sim -- match <deckA.txt> <deckB.txt> [--games 500] [--format standard|standard-brawl|brawl] [--turns 20] [--seed 1]
//   npm run sim -- gauntlet <deck.txt> [<gauntlet dir>] [--games 300]     (default dir: the deck's own format's gauntlet)
//   npm run sim -- coverage <deck.txt>
//   npm run sim -- trace <deckA.txt> <deckB.txt> [--seed 1]
//   npm run sim -- mechanics [--md docs/mechanics.md] [--all]          (needs `npm run fetch-rules`)
import fs from 'node:fs';
import path from 'node:path';
import { loadDeck, deckCoverage, LoadedDeck } from './sim/deck.js';
import { runMatch, pct, wilson, MatchOptions } from './sim/match.js';
import { mechanicsReport, mechanicsMarkdown, rulesDate, RULES_FILE } from './tools/mechanics.js';
import { Format, FORMAT_LABEL, deckFormat, engineRules, gauntletDir, parseFormat } from './sim/format.js';

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; } else flags[k] = 'true';
    } else pos.push(a);
  }
  return { pos, flags };
}

function load(file: string): LoadedDeck {
  const d = loadDeck(file);
  if (d.missing.length) console.warn(`! ${path.basename(file)}: cards not found in Forge data: ${d.missing.join(', ')}`);
  return d;
}

function formatOf(d: LoadedDeck, flags: Record<string, string>): Format {
  return flags.format ? parseFormat(flags.format) : deckFormat(d.list);
}

function matchOpts(flags: Record<string, string>, fmt: Format): MatchOptions {
  return {
    games: +(flags.games ?? 500),
    format: engineRules(fmt),
    maxTurns: +(flags.turns ?? 25),
    seed: +(flags.seed ?? 1),
  };
}

function printMatch(r: ReturnType<typeof runMatch>) {
  const [a, b] = r.decks;
  const [lo, hi] = wilson(r.wins[0], r.games);
  console.log(`\n${a}  vs  ${b}   (${r.games} games)`);
  console.log(`  ${a}: ${r.wins[0]} wins (${pct(r.wins[0], r.games)}, 95% CI ${lo.toFixed(0)}-${hi.toFixed(0)}%), on the play ${pct(r.onPlay[0], r.onPlayGames[0])}`);
  console.log(`  ${b}: ${r.wins[1]} wins (${pct(r.wins[1], r.games)}), on the play ${pct(r.onPlay[1], r.onPlayGames[1])}`);
  if (r.draws) console.log(`  unfinished (turn limit): ${r.draws}`);
  console.log(`  avg game length ${r.avgTurns.toFixed(1)} turns; avg winning turn ${r.avgWinTurn[0].toFixed(1)} / ${r.avgWinTurn[1].toFixed(1)}`);
  console.log(`  avg damage dealt ${r.avgDamage[0].toFixed(1)} / ${r.avgDamage[1].toFixed(1)}; spells countered ${r.avgCountered[0].toFixed(2)} / ${r.avgCountered[1].toFixed(2)}`);
}

function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (cmd === 'mechanics') {
    if (!fs.existsSync(RULES_FILE)) { console.error('Comprehensive Rules not found: run `npm run fetch-rules` first.'); process.exit(1); }
    const text = fs.readFileSync(RULES_FILE, 'utf8');
    const rows = mechanicsReport(text, [{ dir: 'decks/mine', mine: true }, ...['standard', 'standard-brawl', 'brawl'].map(f => ({ dir: `decks/gauntlet/${f}`, mine: false }))]);
    if (flags.md) {
      fs.mkdirSync(path.dirname(flags.md), { recursive: true });
      fs.writeFileSync(flags.md, mechanicsMarkdown(rows, rulesDate(text), flags.all === 'true'));
      console.log(`wrote ${flags.md}`);
    }
    const used = rows.filter(r => r.mine.length + r.gauntlet.length);
    console.log(`\nComprehensive Rules ${rulesDate(text) ?? ''}: ${rows.length} keyword actions and abilities, ${used.length} used by these decks`);
    for (const s of ['missing', 'partial', 'unflagged'] as const) {
      const l = used.filter(r => r.status === s).sort((a, b) => (b.mine.length + b.gauntlet.length) - (a.mine.length + a.gauntlet.length));
      console.log(`\n${s.toUpperCase()} (${l.length})`);
      for (const r of l) console.log(`  ${r.name.padEnd(26)} ${r.rule.padEnd(8)} mine ${String(r.mine.length).padStart(2)}  gauntlet ${String(r.gauntlet.length).padStart(2)}  ${r.gapCards.slice(0, 3).join(', ')}${flags.defs ? `\n      ${r.definition}` : ''}`);
    }
    console.log(`\nSUPPORTED and used: ${used.filter(r => r.status === 'supported').map(r => r.name).join(', ')}`);
    return;
  }
  if (cmd === 'match' || cmd === 'trace') {
    const A = load(pos[1]), B = load(pos[2]);
    const o = matchOpts(flags, formatOf(A, flags));
    if (cmd === 'trace') { o.games = 1; o.trace = true; }
    const r = runMatch(A.list, B.list, o);
    if (cmd === 'trace') console.log(r.traces[0].join('\n'));
    printMatch(r);
    return;
  }
  if (cmd === 'gauntlet') {
    const A = load(pos[1]);
    const fmt = formatOf(A, flags);
    const dir = pos[2] ?? gauntletDir(fmt);
    const o = matchOpts({ games: '300', ...flags }, fmt);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();
    const rows: string[] = [];
    let tw = 0, tg = 0;
    for (const f of files) {
      const B = load(path.join(dir, f));
      const r = runMatch(A.list, B.list, o);
      tw += r.wins[0]; tg += r.games;
      const [lo, hi] = wilson(r.wins[0], r.games);
      rows.push(`${B.list.name.slice(0, 40).padEnd(40)} ${pct(r.wins[0], r.games).padStart(6)}  (CI ${lo.toFixed(0)}-${hi.toFixed(0)}%)  avg turns ${r.avgTurns.toFixed(1)}`);
    }
    console.log(`\n${A.list.name} vs ${dir} (${o.games} games each, ${FORMAT_LABEL[fmt]})`);
    rows.forEach(r => console.log('  ' + r));
    console.log(`  ${'OVERALL'.padEnd(40)} ${pct(tw, tg).padStart(6)}`);
    return;
  }
  if (cmd === 'coverage') {
    const A = load(pos[1]);
    const cov = deckCoverage(A.list);
    let clean = 0;
    for (const [name, notes] of cov) {
      if (!notes.length) { clean++; continue; }
      console.log(`${name}\n  - ${notes.join('\n  - ')}`);
    }
    console.log(`\n${clean}/${cov.size} distinct cards fully modeled; ${A.size} cards total.`);
    return;
  }
  console.log('commands: match <A> <B> | gauntlet <deck> [dir] | coverage <deck> | trace <A> <B>   (flags: --games --format --turns --seed)');
}

main();
