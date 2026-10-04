// Reading Forge card scripts (https://github.com/Card-Forge/forge, GPL-3.0).
// A script is a list of `Key:Value` lines; abilities use `Key$ Value | Key$ Value` parameter lists.
import fs from 'node:fs';
import path from 'node:path';

export interface RawFace {
  name: string;
  lines: [string, string][];   // ordered (key, value) pairs, e.g. ['A', 'SP$ DealDamage | ...']
  svars: Record<string, string>;
  get(key: string): string | undefined;
  all(key: string): string[];
}

export function forgeRes(): string {
  const env = process.env.FORGE_RES;
  if (env) return env;
  return path.resolve('vendor/forge/forge-gui/res');
}

/** Parse "SP$ DealDamage | ValidTgts$ Any | NumDmg$ 2" into an ordered param map. */
export function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(' | ')) {
    const i = part.indexOf('$');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function makeFace(lines: [string, string][]): RawFace {
  const svars: Record<string, string> = {};
  for (const [k, v] of lines) {
    if (k === 'SVar') {
      const i = v.indexOf(':');
      if (i > 0) svars[v.slice(0, i)] = v.slice(i + 1);
    }
  }
  const name = lines.find(l => l[0] === 'Name')?.[1] ?? '?';
  return {
    name, lines, svars,
    get: (key: string) => lines.find(l => l[0] === key)?.[1],
    all: (key: string) => lines.filter(l => l[0] === key).map(l => l[1]),
  };
}

/** Returns the faces of a card script (front first). */
export function parseScript(text: string): RawFace[] {
  const faces: [string, string][][] = [[]];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('ALTERNATE')) { faces.push([]); continue; }
    const i = line.indexOf(':');
    if (i < 0) continue;
    faces[faces.length - 1].push([line.slice(0, i), line.slice(i + 1)]);
  }
  return faces.filter(f => f.length).map(makeFace);
}

let index: Record<string, string> | null = null;

/** Map of lower-cased card name -> script path. Cached in .cache/card-index.json. */
export function cardIndex(): Record<string, string> {
  if (index) return index;
  const cacheFile = path.resolve('.cache/card-index.json');
  const root = path.join(forgeRes(), 'cardsfolder');
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.root === root) { index = cached.index as Record<string, string>; return index; }
  }
  if (!fs.existsSync(root)) {
    throw new Error(`Forge card data not found at ${root}. Run "npm run fetch-cards" (or set FORGE_RES).`);
  }
  const idx: Record<string, string> = {};
  for (const dir of fs.readdirSync(root)) {
    const d = path.join(root, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.txt')) continue;
      const p = path.join(d, f);
      const head = fs.readFileSync(p, 'utf8').split(/\r?\n/, 3);
      const nameLine = head.find(l => l.startsWith('Name:'));
      if (nameLine) idx[nameLine.slice(5).trim().toLowerCase()] = p;
    }
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ root, index: idx }));
  index = idx;
  return idx;
}

export function readCardScript(name: string): RawFace[] {
  const idx = cardIndex();
  let p = idx[name.toLowerCase()];
  if (!p) {
    // split / double-faced names like "A // B" are indexed by the front face
    const front = name.split(' // ')[0].toLowerCase();
    p = idx[front];
  }
  if (!p) throw new Error(`Unknown card: ${name}`);
  return parseScript(fs.readFileSync(p, 'utf8'));
}

export function readTokenScript(script: string): RawFace[] | null {
  const p = path.join(forgeRes(), 'tokenscripts', `${script}.txt`);
  if (!fs.existsSync(p)) return null;
  return parseScript(fs.readFileSync(p, 'utf8'));
}
