#!/usr/bin/env tsx
// Local web UI for the Crucible:  npm run ui  (then open http://localhost:4777)
// Serves src/ui/public and a small JSON API. Matchups run in a worker pool; progress streams over SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from './pool.js';
import { inspectDeck, cardImpacts, pickSwaps, applySwap, DeckInfo, CardImpact, UpgradeOptions } from './analysis.js';
import { loadCollection, saveCollection } from './collection.js';
import { wilson } from '../sim/match.js';
import type { CardStat } from '../sim/match.js';
import { FORMATS, FORMAT_LABEL, Format, engineRules, gauntletDir, needsStandardLegal } from '../sim/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(ROOT);                                   // card cache and deck paths are relative to the repo
const PUBLIC = path.join(ROOT, 'src/ui/public');
const DECKS = path.join(ROOT, 'decks');
const pool = new Pool();

// ------------------------------------------------------------------ jobs
interface MatchupView {
  file: string; name: string; games: number; done: number;
  result?: { wins: number; draws: number; wr: number; ci: [number, number]; onPlayWR: number; onDrawWR: number; avgTurns: number };
}
interface GauntletJob {
  id: string; kind: 'gauntlet'; status: 'running' | 'done' | 'error' | 'cancelled'; error?: string;
  deck: DeckInfo; settings: Settings; started: number; finished?: number;
  matchups: MatchupView[];
  overall?: { wins: number; games: number; wr: number; ci: [number, number] };
  cards?: CardImpact[];
  // internal (not sent to the browser)
  _text: string; _opps: { file: string; name: string; text: string }[]; _cards: Record<string, CardStat>;
}
interface SwapView {
  cut: string; add: string; copies: number; rarity: string; owned: number; addModeled: boolean;
  stage: 'queued' | 'screening' | 'screened' | 'confirming' | 'confirmed' | 'skipped';
  done: number; total: number; screenDelta?: number; wr?: number; delta?: number; se?: number;
}
interface UpgradeJob {
  id: string; kind: 'upgrades'; status: 'running' | 'done' | 'error' | 'cancelled'; error?: string; message?: string;
  baselineId: string; baselineWR: number; phase: 'screening' | 'confirming' | 'done';
  screenGames: number; fullGames: number; started: number; finished?: number;
  cuts: CardImpact[]; swaps: SwapView[];
}
type Job = GauntletJob | UpgradeJob;
interface Settings { games: number; maxTurns: number; seed: number }

const jobs = new Map<string, Job>();
const listeners = new Map<string, Set<http.ServerResponse>>();
const dirty = new Set<string>();
let jobSeq = 0;

function publicView(j: Job) {
  return Object.fromEntries(Object.entries(j).filter(([k]) => !k.startsWith('_')));
}
function touch(id: string) { dirty.add(id); }
setInterval(() => {
  for (const id of dirty) {
    const j = jobs.get(id), subs = listeners.get(id);
    if (!j || !subs) continue;
    const data = `data: ${JSON.stringify(publicView(j))}\n\n`;
    for (const res of subs) res.write(data);
  }
  dirty.clear();
}, 150);

// ------------------------------------------------------------------ helpers
/** Every deck under decks/, including nested gauntlet folders such as decks/gauntlet/standard-brawl. */
function deckFiles() {
  const out: { file: string; folder: string; name: string; format: Format; size: number }[] = [];
  const walk = (rel: string) => {
    const dir = path.join(DECKS, rel);
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(child); continue; }
      if (!rel || !e.name.endsWith('.txt')) continue;
      const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
      const name = text.match(/^\s*Name\s+(.+)$/mi)?.[1].trim() ?? e.name.replace(/\.txt$/, '');
      let size = 0, section = 'deck';
      for (const raw of text.split(/\r?\n/)) {
        const l = raw.trim().toLowerCase();
        if (['sideboard', 'companion', 'about'].includes(l)) section = 'skip';
        else if (['deck', 'main', 'maindeck', 'commander'].includes(l)) section = 'deck';
        else if (section === 'deck') size += +(l.match(/^(\d+)x?\s/)?.[1] ?? 0);
      }
      const commander = /^\s*commander\s*$/mi.test(text);
      const format: Format = !commander ? 'standard' : size >= 80 ? 'brawl' : 'standard-brawl';
      out.push({ file: child, folder: rel, name, format, size });
    }
  };
  if (fs.existsSync(DECKS)) walk('');
  return out;
}

/** Resolves a "folder/file.txt" path inside decks/, refusing anything outside it. */
function deckPath(rel: string): string {
  const p = path.resolve(DECKS, rel);
  if (!p.startsWith(DECKS + path.sep) || !p.endsWith('.txt')) throw new Error('bad deck path');
  return p;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const clamp = (v: unknown, lo: number, hi: number, def: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

// ------------------------------------------------------------------ gauntlet
function startGauntlet(text: string, name: string, oppFiles: string[], s: Settings): GauntletJob {
  const { info } = inspectDeck(text, name);
  if (info.size === 0) throw new Error('No cards found. Paste an Arena export (Deck / 4 Card Name lines).');
  if (!oppFiles.length) throw new Error('Pick at least one opponent.');
  const opps = oppFiles.map(file => {
    const t = fs.readFileSync(deckPath(file), 'utf8');
    return { file, text: t, name: t.match(/^\s*Name\s+(.+)$/mi)?.[1].trim() ?? path.basename(file, '.txt') };
  });
  const job: GauntletJob = {
    id: `g${++jobSeq}`, kind: 'gauntlet', status: 'running', deck: info, settings: s, started: Date.now(),
    matchups: opps.map(o => ({ file: o.file, name: o.name, games: s.games, done: 0 })),
    _text: text, _opps: opps, _cards: {},
  };
  jobs.set(job.id, job);
  let tw = 0, tg = 0;
  Promise.all(opps.map((o, i) => pool.run(job.id, {
    deckText: text, oppText: o.text, oppName: o.name, games: s.games, seed: s.seed, maxTurns: s.maxTurns, format: engineRules(info.format),
  }, done => { job.matchups[i].done = done; touch(job.id); }).then(r => {
    const m = job.matchups[i];
    m.done = r.games;
    const [lo, hi] = wilson(r.wins[0], r.games);
    m.result = {
      wins: r.wins[0], draws: r.draws, wr: 100 * r.wins[0] / r.games, ci: [lo, hi],
      onPlayWR: 100 * r.onPlay[0] / Math.max(1, r.onPlayGames[0]),
      onDrawWR: 100 * (r.wins[0] - r.onPlay[0]) / Math.max(1, r.games - r.onPlayGames[0]),
      avgTurns: r.avgTurns,
    };
    tw += r.wins[0]; tg += r.games;
    for (const [name, c] of Object.entries(r.cards)) {
      const a = (job._cards[name] ??= { seen: 0, seenWins: 0, cast: 0, castWins: 0 });
      a.seen += c.seen; a.seenWins += c.seenWins; a.cast += c.cast; a.castWins += c.castWins;
    }
    touch(job.id);
  }))).then(() => {
    const [lo, hi] = wilson(tw, tg);
    job.overall = { wins: tw, games: tg, wr: 100 * tw / tg, ci: [lo, hi] };
    job.cards = cardImpacts(inspectDeck(text, name).deck, job._cards, tg, tw);
    job.status = 'done'; job.finished = Date.now();
    touch(job.id);
  }).catch(e => {
    if (job.status === 'running') { job.status = (e as Error).message === 'cancelled' ? 'cancelled' : 'error'; job.error = (e as Error).message; }
    job.finished = Date.now();
    touch(job.id);
  });
  return job;
}

/** Runs one deck text against every opponent of a baseline and returns its overall win rate (0..100). */
async function gauntletWR(group: string, text: string, base: GauntletJob, games: number, onDone: (n: number) => void): Promise<number> {
  const doneBy = new Array(base._opps.length).fill(0);
  const rs = await Promise.all(base._opps.map((o, i) => pool.run(group, {
    deckText: text, oppText: o.text, oppName: o.name, games, seed: base.settings.seed, maxTurns: base.settings.maxTurns, format: engineRules(base.deck.format),
  }, d => { doneBy[i] = d; onDone(doneBy.reduce((a, b) => a + b, 0)); })));
  const wins = rs.reduce((a, r) => a + r.wins[0], 0), n = rs.reduce((a, r) => a + r.games, 0);
  return 100 * wins / n;
}

// ------------------------------------------------------------------ upgrades
function startUpgrades(base: GauntletJob, o: UpgradeOptions & { confirm: number }): UpgradeJob {
  if (base.status !== 'done' || !base.cards || !base.overall) throw new Error('Run the gauntlet first.');
  const owned = loadCollection().cards;
  if (!owned.length) throw new Error('No Arena collection loaded yet. Use "Load collection CSV" first.');
  const { deck } = inspectDeck(base._text);
  const { cuts, swaps } = pickSwaps(deck, base.cards, owned, o);
  const opps = base._opps.length;
  const screenGames = Math.max(40, Math.round(base.settings.games / 5));
  const job: UpgradeJob = {
    id: `u${++jobSeq}`, kind: 'upgrades', status: 'running', baselineId: base.id, baselineWR: base.overall.wr,
    phase: 'screening', screenGames, fullGames: base.settings.games, started: Date.now(), cuts,
    swaps: swaps.map(s => ({ ...s, stage: 'queued', done: 0, total: screenGames * opps })),
  };
  jobs.set(job.id, job);
  if (!swaps.length) {
    job.status = 'done'; job.phase = 'done';
    job.message = cuts.length ? 'No owned cards in these colors fit the weak slots with the current filters.' : 'Not enough games to judge any card yet. Run more games per matchup.';
    return job;
  }
  (async () => {
    // Stage 1: quick screen of every candidate against a baseline played with the same seeds.
    const screenBase = gauntletWR(job.id, base._text, base, screenGames, () => {});
    screenBase.catch(() => {});                       // awaited below; avoid an unhandled rejection on cancel
    const screened = job.swaps.map(async s => {
      const text = applySwap(base._text, s.cut, s.add, s.copies);
      const wr = await gauntletWR(job.id, text, base, screenGames, n => { s.stage = 'screening'; s.done = n; touch(job.id); });
      s.screenDelta = wr - await screenBase;
      s.stage = 'screened'; s.done = s.total; touch(job.id);
    });
    await Promise.all(screened);
    // Stage 2: re-run the most promising swaps at the full game count and compare with the real baseline.
    job.phase = 'confirming';
    const best = [...job.swaps].sort((a, b) => b.screenDelta! - a.screenDelta!).slice(0, o.confirm);
    for (const s of job.swaps) if (!best.includes(s)) s.stage = 'skipped';
    const p = base.overall!.wr / 100, n = base.overall!.games;
    await Promise.all(best.map(async s => {
      s.stage = 'confirming'; s.done = 0; s.total = job.fullGames * opps; touch(job.id);
      const text = applySwap(base._text, s.cut, s.add, s.copies);
      s.wr = await gauntletWR(job.id, text, base, job.fullGames, d => { s.done = d; touch(job.id); });
      s.delta = s.wr - base.overall!.wr;
      const q = s.wr / 100;
      s.se = 100 * Math.sqrt(p * (1 - p) / n + q * (1 - q) / n);
      s.stage = 'confirmed'; s.done = s.total; touch(job.id);
    }));
    job.phase = 'done'; job.status = 'done'; job.finished = Date.now();
    touch(job.id);
  })().catch(e => {
    if (job.status === 'running') { job.status = (e as Error).message === 'cancelled' ? 'cancelled' : 'error'; job.error = (e as Error).message; }
    job.finished = Date.now();
    touch(job.id);
  });
  return job;
}

// ------------------------------------------------------------------ http
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/state') {
      const col = loadCollection();
      const formats = FORMATS.map(f => ({ id: f, label: FORMAT_LABEL[f], gauntlet: gauntletDir(f).replace(/^decks\//, ''), standardLegal: needsStandardLegal(f) }));
      return json(res, 200, { decks: deckFiles(), formats, collection: { count: col.cards.length, updated: col.updated }, workers: pool.size });
    }
    if (route === 'GET /api/deck') return json(res, 200, { text: fs.readFileSync(deckPath(url.searchParams.get('file') ?? ''), 'utf8') });
    if (route === 'POST /api/inspect') { const b = await readBody(req); return json(res, 200, inspectDeck(String(b.text ?? ''), String(b.name || 'My deck')).info); }
    if (route === 'POST /api/save') {
      const b = await readBody(req);
      const slug = String(b.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) throw new Error('Give the deck a name');
      const file = `mine/${slug}.txt`;
      fs.mkdirSync(path.join(DECKS, 'mine'), { recursive: true });
      fs.writeFileSync(deckPath(file), String(b.text ?? ''));
      return json(res, 200, { file });
    }
    if (route === 'POST /api/collection') { const b = await readBody(req); return json(res, 200, { count: saveCollection(String(b.text ?? '')) }); }
    if (route === 'POST /api/gauntlet') {
      const b = await readBody(req);
      const job = startGauntlet(String(b.text ?? ''), String(b.name || 'My deck'), Array.isArray(b.opponents) ? b.opponents.map(String) : [], {
        games: clamp(b.games, 20, 5000, 300), maxTurns: clamp(b.maxTurns, 5, 60, 25), seed: clamp(b.seed, 1, 1e9, 1),
      });
      return json(res, 200, { id: job.id });
    }
    if (route === 'POST /api/upgrades') {
      const b = await readBody(req);
      const base = jobs.get(String(b.baselineId));
      if (!base || base.kind !== 'gauntlet') throw new Error('Run the gauntlet first.');
      const job = startUpgrades(base, {
        cuts: clamp(b.cuts, 1, 10, 3), perCut: clamp(b.perCut, 1, 30, 8), confirm: clamp(b.confirm, 1, 20, 6),
        standardOnly: b.standardOnly !== false, modeledOnly: b.modeledOnly !== false, minSeen: clamp(b.minSeen, 0, 1e6, 30),
      });
      return json(res, 200, { id: job.id });
    }
    if (route === 'POST /api/apply-swap') {
      const b = await readBody(req);
      return json(res, 200, { text: applySwap(String(b.text), String(b.cut), String(b.add), clamp(b.copies, 1, 60, 1)) });
    }
    const ev = url.pathname.match(/^\/api\/jobs\/(\w+)\/(events|cancel)$/);
    if (ev) {
      const job = jobs.get(ev[1]);
      if (!job) return json(res, 404, { error: 'no such job' });
      if (ev[2] === 'cancel' && req.method === 'POST') {
        pool.cancel(job.id);
        if (job.status === 'running') { job.status = 'cancelled'; job.finished = Date.now(); }
        touch(job.id);
        return json(res, 200, { ok: true });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(publicView(job))}\n\n`);
      const subs = listeners.get(job.id) ?? new Set();
      subs.add(res); listeners.set(job.id, subs);
      req.on('close', () => subs.delete(res));
      return;
    }
    json(res, 404, { error: 'unknown route' });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const;
  try { spawn(cmd[0], [...cmd[1]], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* no browser */ }
}

// HOST=0.0.0.0 inside Docker so the published port reaches it; on the desktop it stays local-only.
const HOST = process.env.HOST ?? '127.0.0.1';

function listen(port: number, tries = 10) {
  server.once('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1); else throw e;
  });
  server.listen(port, HOST, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  The Crucible is running at ${url}  (${pool.size} worker threads)\n  Press Ctrl+C to stop.\n`);
    if (!process.argv.includes('--no-open')) openBrowser(url);
  });
}
listen(Number(process.env.PORT ?? 4777));
