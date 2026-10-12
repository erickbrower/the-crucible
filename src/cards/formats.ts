// Format legality from Forge's own data: formats/Sanctioned/<Format>.txt lists the legal sets and banned cards,
// and editions/*.txt lists which cards each set contains. Used to check gauntlet decks and upgrade candidates.
import fs from 'node:fs';
import path from 'node:path';
import { forgeRes } from './forge.js';

export interface FormatDef { name: string; sets: Set<string>; banned: Set<string> }

const formats = new Map<string, FormatDef>();

/** Reads a sanctioned format definition, e.g. "Standard". */
export function loadFormat(name: string): FormatDef {
  const hit = formats.get(name);
  if (hit) return hit;
  const file = path.join(forgeRes(), 'formats/Sanctioned', `${name}.txt`);
  const text = fs.readFileSync(file, 'utf8');
  const field = (k: string) => text.match(new RegExp(`^${k}:(.*)$`, 'm'))?.[1] ?? '';
  const def: FormatDef = {
    name,
    sets: new Set(field('Sets').split(',').map(s => s.trim()).filter(Boolean)),
    banned: new Set(field('Banned').split(';').map(s => s.trim().toLowerCase()).filter(Boolean)),
  };
  formats.set(name, def);
  return def;
}

let editionIndex: Map<string, string> | undefined;     // set code -> edition file
const setCards = new Map<string, Set<string>>();        // set code -> lower-cased card names

function editionFile(code: string): string | undefined {
  if (!editionIndex) {
    editionIndex = new Map();
    const dir = path.join(forgeRes(), 'editions');
    for (const f of fs.readdirSync(dir)) {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 400);
      const c = head.match(/^Code=(\S+)/m)?.[1];
      if (c) editionIndex.set(c, path.join(dir, f));
    }
  }
  return editionIndex.get(code);
}

/** Card names printed in a set, from every section of its edition file except booster definitions. */
export function cardsInSet(code: string): Set<string> {
  const hit = setCards.get(code);
  if (hit) return hit;
  const names = new Set<string>();
  const file = editionFile(code);
  if (file) {
    let inCards = false;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const sec = line.match(/^\[(.+)\]$/);
      if (sec) { inCards = !/^(metadata|common|common-guest|uncommon|raremythic|anyland|wildcard|tokens)$/i.test(sec[1]); continue; }
      if (!inCards) continue;
      const m = line.match(/^\S+\s+[A-Z]\s+(.+?)(?:\s+@.*)?$/);
      if (m) {
        const full = m[1].trim().toLowerCase();
        names.add(full);
        names.add(full.split(' // ')[0]);
      }
    }
  }
  setCards.set(code, names);
  return names;
}

/** True when the card is printed in one of the format's sets and is not banned. Basic lands are always legal. */
export function isLegal(card: string, format = 'Standard'): boolean {
  const name = card.toLowerCase();
  if (/^(snow-covered )?(plains|island|swamp|mountain|forest|wastes)$/.test(name)) return !name.startsWith('snow') || format !== 'Standard';
  const f = loadFormat(format);
  if (f.banned.has(name) || f.banned.has(name.split(' // ')[0])) return false;
  for (const code of f.sets) {
    const cards = cardsInSet(code);
    if (cards.has(name) || cards.has(name.split(' // ')[0])) return true;
  }
  return false;
}
