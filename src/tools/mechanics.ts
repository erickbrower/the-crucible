// Checks every keyword action (rule 701) and keyword ability (rule 702) of the Comprehensive Rules against
// the engine: is it modeled, and which decks (Erick's and the gauntlets) use it?
//   npm run fetch-rules            (once; downloads the rules into vendor/rules)
//   npm run sim -- mechanics [--md docs/mechanics.md] [--all]
import fs from 'node:fs';
import path from 'node:path';
import { loadDeck, deckCoverage } from '../sim/deck.js';
import { SUPPORTED_APIS, SUPPORTED_KEYWORDS, SUPPORTED_TRIGGERS } from '../cards/compile.js';
import type { CardDef, Effect } from '../cards/model.js';

export const RULES_FILE = path.resolve('vendor/rules/CompRules.txt');

export interface Mechanic {
  rule: string;                    // "702.74"
  name: string;                    // "Evoke"
  kind: 'action' | 'ability';
  definition: string;              // first sentence of the rule (local only: the rules are Wizards' text)
}

export type Status = 'supported' | 'partial' | 'missing' | 'unflagged' | 'not modeled';

export interface MechanicRow extends Mechanic {
  status: Status;
  mine: string[];                  // Erick's decks that use it
  gauntlet: string[];              // gauntlet decks that use it
  cards: string[];                 // cards in those decks that use it
  gapCards: string[];              // of those, cards whose coverage notes name this mechanic
  scripted: boolean;               // some card's Forge script names it (not just its rules text)
}

/** Keyword actions the engine handles as part of its basic game flow rather than as a named effect. */
const CORE_ACTIONS = new Set(['activate', 'cast', 'play', 'shuffle', 'reveal', 'search', 'exile', 'create', 'destroy', 'sacrifice',
  'discard', 'counter', 'attach', 'tapanduntap', 'fight', 'mill', 'scry', 'surveil', 'double', 'transform']);

/** Rule names whose Forge API or keyword is spelled differently. */
const FORGE_ALIASES: Record<string, string[]> = {
  create: ['token'], exile: ['changezone'], search: ['changezone'], double: ['multiplycounter'], transform: ['setstate'],
  tapanduntap: ['tap', 'untap', 'tapall', 'untapall'], ventureintothedungeon: ['venture'], reveal: ['revealhand'],
  maxspeed: ['startyourengines'], startyourengines: ['startyourengines'], firststrike: ['firststrike'], doublestrike: ['doublestrike'], landwalk: ['landwalk'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

export function parseRules(text: string): Mechanic[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: Mechanic[] = [];
  // only the numbered rules part (the table of contents and the glossary repeat the names)
  const start = lines.findIndex((l, i) => i > 200 && /^701\.1\. /.test(l));
  for (let i = Math.max(0, start); i < lines.length; i++) {
    const m = lines[i].match(/^(70[12])\.(\d+)\. (.+)$/);
    if (!m || m[2] === '1') continue;                       // 701.1 / 702.1 are general rules
    const name = m[3].trim();
    if (name.length > 45 || /[.:]$/.test(name)) continue;
    const def = lines.slice(i + 1, i + 6).find(l => new RegExp(`^${m[1]}\\.${m[2]}a `).test(l)) ?? '';
    out.push({ rule: `${m[1]}.${m[2]}`, name, kind: m[1] === '701' ? 'action' : 'ability', definition: def.replace(/^\S+ /, '').split(/(?<=\.) /)[0] });
    if (/^Glossary/.test(lines[i])) break;
  }
  const seen = new Set<string>();
  return out.filter(x => !seen.has(x.rule) && seen.add(x.rule));
}

/** Everything a card "says" in Forge terms: keyword names, effect APIs and trigger modes (normalized). */
function cardTokens(d: CardDef): Set<string> {
  const t = new Set<string>();
  const walk = (e: Effect | undefined, depth = 0) => {
    if (!e || depth > 10) return;
    t.add(norm(e.api));
    for (const k of Object.keys(e.params)) if (/^(Populate|Monstrosity|Adapt|Bolster|Support)$/.test(k)) t.add(norm(k));
    walk(e.sub, depth + 1); (e.choices ?? []).forEach(c => walk(c, depth + 1));
  };
  for (const def of [d, d.back, d.modalBack].filter(Boolean) as CardDef[]) {
    def.keywords.forEach(k => t.add(norm(k.split(':')[0])));
    walk(def.spell?.effect); def.abilities.forEach(a => walk(a.effect)); def.triggers.forEach(tr => { t.add(norm(tr.mode ?? '')); walk(tr.effect); });
    (def.chapters ?? []).forEach(e => walk(e));
  }
  return t;
}

/** 'forge': the card's script names it; 'text': only its rules text mentions it; undefined: not used. */
function usesMechanic(m: Mechanic, tokens: Set<string>, oracle: string): 'forge' | 'text' | undefined {
  const n = norm(m.name);
  if (tokens.has(n) || (FORGE_ALIASES[n] ?? []).some(a => tokens.has(a))) return 'forge';
  if (m.kind === 'action' && CORE_ACTIONS.has(n)) return undefined;    // too common to count from rules text
  // rules-text fallback ("creatures you control have flying"); strip reminder text first
  const text = oracle.replace(/\([^)]*\)/g, '');
  const name = m.name.replace(/[!—].*$/, '').trim();
  const words = name.split(' ').map(w => w.replace(/[^A-Za-z'-]/g, '')).filter(Boolean);
  if (!words.length || (words.length === 1 && words[0].length < 3)) return undefined;
  const pattern = words.length === 1 ? `\\b${words[0]}(s|es|ed|ing|d)?\\b` : `\\b${words.join('\\s+')}\\b`;
  return new RegExp(pattern, 'i').test(text) ? 'text' : undefined;
}

function noteNames(notes: string[]): Set<string> {
  const s = new Set<string>();
  for (const n of notes) for (const q of n.matchAll(/"([^"]+)"/g)) s.add(norm(q[1].split(' ')[0]));
  return s;
}

export function mechanicsReport(rulesText: string, deckDirs: { dir: string; mine: boolean }[]): MechanicRow[] {
  const mechanics = parseRules(rulesText);
  const known = new Set([...SUPPORTED_KEYWORDS, ...SUPPORTED_APIS, ...SUPPORTED_TRIGGERS].map(norm));
  const rows: MechanicRow[] = mechanics.map(m => ({ ...m, status: 'not modeled', mine: [], gauntlet: [], cards: [], gapCards: [], scripted: false }));
  for (const { dir, mine } of deckDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.txt')).sort()) {
      const deck = loadDeck(path.join(dir, f));
      const cov = deckCoverage(deck.list);
      const label = mine ? f.replace(/\.txt$/, '') : `${path.basename(dir)}/${f.replace(/\.txt$/, '')}`;
      for (const def of new Map([deck.list.commander, ...deck.list.main].filter(Boolean).map(d => [d!.name, d!])).values()) {
        const tokens = cardTokens(def);
        const gaps = noteNames(cov.get(def.name) ?? []);
        const oracle = [def.oracle, def.back?.oracle, def.modalBack?.oracle].filter(Boolean).join('\n');
        for (const r of rows) {
          const how = usesMechanic(r, tokens, oracle);
          if (!how) continue;
          if (how === 'forge') r.scripted = true;
          const list = mine ? r.mine : r.gauntlet;
          if (!list.includes(label)) list.push(label);
          if (!r.cards.includes(def.name)) r.cards.push(def.name);
          const n = norm(r.name);
          if ((gaps.has(n) || (FORGE_ALIASES[n] ?? []).some(a => gaps.has(a))) && !r.gapCards.includes(def.name)) r.gapCards.push(def.name);
        }
      }
    }
  }
  for (const r of rows) {
    const n = norm(r.name);
    const isKnown = known.has(n) || (FORGE_ALIASES[n] ?? []).some(a => known.has(a)) || (r.kind === 'action' && CORE_ACTIONS.has(n));
    r.status = r.gapCards.length ? (isKnown ? 'partial' : 'missing') : isKnown ? 'supported'
      : !r.cards.length ? 'not modeled' : r.scripted ? 'missing' : 'unflagged';
  }
  return rows;
}

export function rulesDate(text: string): string | undefined {
  return text.match(/effective as of ([A-Z][a-z]+ \d+, \d{4})/)?.[1];
}

/** Markdown report (names, rule numbers, status and usage only: no rules text, which is Wizards'). */
export function mechanicsMarkdown(rows: MechanicRow[], date?: string, all = false): string {
  const used = (r: MechanicRow) => r.mine.length + r.gauntlet.length > 0;
  const count = (s: Status, f = (_: MechanicRow) => true) => rows.filter(r => r.status === s && f(r)).length;
  const icon: Record<Status, string> = { supported: '✅', partial: '🟡', missing: '❌', unflagged: '❔', 'not modeled': '·' };
  const out: string[] = [];
  out.push('# Mechanics coverage', '');
  out.push(`Every keyword action (rule 701) and keyword ability (rule 702) in the Comprehensive Rules${date ? ` (effective ${date})` : ''},`);
  out.push('checked against the engine and against the decks in `decks/mine` and the gauntlets. Generated by');
  out.push('`npm run sim -- mechanics --md docs/mechanics.md` after `npm run fetch-rules`.', '');
  out.push('- ✅ **supported**: the engine models it and no card in these decks reports a gap for it');
  out.push('- 🟡 **partial**: the engine models it, but some cards here use it in a way that is still ignored');
  out.push('- ❌ **missing**: cards in these decks use it and the engine ignores it');
  out.push('- ❔ **unflagged**: only the rules text of cards here mentions it and nothing reports a gap; often a silent gap, sometimes just a mention (\"creatures with flying\")');
  out.push('- · **not modeled**: no deck here uses it yet', '');
  out.push(`| | Used by these decks | All ${rows.length} mechanics |`, '|---|---|---|');
  for (const s of ['supported', 'partial', 'missing', 'unflagged', 'not modeled'] as Status[]) out.push(`| ${icon[s]} ${s} | ${count(s, used)} | ${count(s)} |`);
  out.push('');
  const table = (title: string, list: MechanicRow[]) => {
    if (!list.length) return;
    out.push(`## ${title}`, '', '| Mechanic | Rule | Status | Erick\'s decks | Gauntlet decks | Cards with gaps (or examples) |', '|---|---|---|---|---|---|');
    for (const r of list) {
      const ex = (r.gapCards.length ? r.gapCards : r.cards).slice(0, 4).join(', ') + ((r.gapCards.length || r.cards.length) > 4 ? ', …' : '');
      out.push(`| ${r.name} | ${r.rule} | ${icon[r.status]} ${r.status} | ${r.mine.length || ''} | ${r.gauntlet.length || ''} | ${ex} |`);
    }
    out.push('');
  };
  const order: Record<Status, number> = { missing: 0, partial: 1, unflagged: 2, supported: 3, 'not modeled': 4 };
  const sort = (l: MechanicRow[]) => [...l].sort((a, b) => order[a.status] - order[b.status] || (b.mine.length + b.gauntlet.length) - (a.mine.length + a.gauntlet.length) || a.name.localeCompare(b.name));
  table('Keyword abilities (702)', sort(rows.filter(r => r.kind === 'ability' && (all || used(r) || r.status === 'supported'))));
  table('Keyword actions (701)', sort(rows.filter(r => r.kind === 'action' && (all || used(r) || r.status === 'supported'))));
  if (!all) {
    const rest = rows.filter(r => !used(r) && r.status === 'not modeled').map(r => r.name).sort();
    out.push(`## Not used by any deck here (${rest.length})`, '', rest.join(', '), '');
  }
  return out.join('\n');
}
