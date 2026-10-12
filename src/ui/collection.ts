// Reads the Arena collection export (CSV) that lives in data/arena_collection.csv.
// Columns: Name,Color,Rarity,Count,StandardLegal,Rotates2027,StandardSets,OwnedPrintings
import fs from 'node:fs';
import path from 'node:path';

export interface OwnedCard {
  name: string;
  rarity: string;          // Common | Uncommon | Rare | Mythic | Basic
  count: number;
  standardLegal: boolean;
  rotates: boolean;        // rotates out of Standard in 2027
}

export const COLLECTION_FILE = path.resolve('data/arena_collection.csv');

/** Splits one CSV line, honoring double-quoted fields ("Gollum, Riddle Master"). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCollection(text: string): OwnedCard[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  const iName = col('name'), iRarity = col('rarity'), iCount = col('count'), iLegal = col('standardlegal'), iRot = col('rotates2027');
  if (iName < 0) throw new Error('Collection CSV needs a "Name" column');
  const out: OwnedCard[] = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const name = f[iName]?.trim();
    if (!name) continue;
    out.push({
      name,
      rarity: iRarity >= 0 ? f[iRarity]?.trim() || '?' : '?',
      count: iCount >= 0 ? +f[iCount] || 1 : 1,
      standardLegal: iLegal >= 0 ? /^y/i.test(f[iLegal] ?? '') : true,
      rotates: iRot >= 0 ? /^y/i.test(f[iRot] ?? '') : false,
    });
  }
  return out;
}

let cached: { mtime: number; cards: OwnedCard[] } | undefined;

export function loadCollection(): { cards: OwnedCard[]; updated?: string } {
  if (!fs.existsSync(COLLECTION_FILE)) return { cards: [] };
  const st = fs.statSync(COLLECTION_FILE);
  if (!cached || cached.mtime !== st.mtimeMs) cached = { mtime: st.mtimeMs, cards: parseCollection(fs.readFileSync(COLLECTION_FILE, 'utf8')) };
  return { cards: cached.cards, updated: st.mtime.toISOString() };
}

export function saveCollection(text: string): number {
  const cards = parseCollection(text);   // throws on a bad file, before overwriting the good one
  if (!cards.length) throw new Error('No cards found in that CSV');
  fs.mkdirSync(path.dirname(COLLECTION_FILE), { recursive: true });
  fs.writeFileSync(COLLECTION_FILE, text);
  cached = undefined;
  return cards.length;
}
