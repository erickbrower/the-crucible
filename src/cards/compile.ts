// Compiles Forge script faces into CardDefs the engine can execute, recording coverage notes
// for anything the engine ignores or approximates.
import { RawFace, parseParams, readCardScript, readTokenScript } from './forge.js';
import { Ability, CardDef, Color, COLORS, Cost, Effect, LandInfo, ManaCost, Pip, StaticAbility, Trigger } from './model.js';

const CARD_TYPES = ['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Instant', 'Sorcery', 'Battle', 'Kindred', 'Tribal'];
const SUPERTYPES = ['Legendary', 'Basic', 'Snow', 'World'];

/** Effect APIs the engine implements (fully or approximately). */
export const SUPPORTED_APIS = new Set([
  'DealDamage', 'DamageAll', 'Destroy', 'DestroyAll', 'ChangeZone', 'ChangeZoneAll', 'Draw', 'Discard', 'Token',
  'Pump', 'PumpAll', 'PutCounter', 'PutCounterAll', 'Counter', 'GainLife', 'LoseLife', 'Mana', 'Scry', 'Surveil',
  'Mill', 'Sacrifice', 'Fight', 'Tap', 'TapAll', 'Untap', 'Attach', 'Charm', 'Dig', 'SetState', 'Explore',
  'Investigate', 'Amass', 'Endure', 'Earthbend', 'Connive', 'Animate', 'Effect', 'ChooseType', 'StoreSVar',
  'Cleanup', 'ImmediateTrigger', 'GenericChoice', 'ChooseCard', 'Pump', 'Regenerate', 'UntapAll', 'RemoveCounter',
]);
const IGNORED_APIS = new Set(['StoreSVar', 'Effect', 'Animate', 'GenericChoice', 'ChooseCard', 'Regenerate']);
const SILENT_APIS = new Set(['ChooseType', 'Cleanup']);
export const SUPPORTED_TRIGGERS = new Set([
  'ChangesZone', 'SpellCast', 'Attacks', 'DamageDone', 'DamageDoneOnce', 'Phase', 'LifeGained', 'AttackersDeclared',
  'ChangesZoneAll', 'Drawn', 'Sacrificed', 'Blocks', 'CounterAddedOnce', 'Exploited',
]);
const SUPPORTED_KEYWORDS = new Set([
  'Flying', 'Reach', 'Trample', 'Haste', 'Vigilance', 'Deathtouch', 'Lifelink', 'First Strike', 'Double Strike',
  'Menace', 'Defender', 'Flash', 'Prowess', 'Hexproof', 'Indestructible', 'Kicker', 'Enchant', 'Ward', 'Equip',
  'Affinity', 'AlternateAdditionalCost', 'Chapter', 'ETBReplacement', 'Shroud', 'Can\'t be blocked', 'Offspring', 'Mobilize',
]);

export function parseManaCost(s: string | undefined): ManaCost {
  const mc: ManaCost = { generic: 0, pips: [], x: 0 };
  if (!s || s === 'no cost') return mc;
  for (const tok of s.trim().split(/\s+/)) {
    if (/^\d+$/.test(tok)) { mc.generic += parseInt(tok, 10); continue; }
    if (tok === 'X') { mc.x++; continue; }
    if (tok === 'C') { mc.generic += 1; continue; }
    if (tok === 'S') { mc.generic += 1; continue; }
    const pip: Pip = { options: [] };
    let t = tok.replace('/', '');
    if (/^2[WUBRG]$/.test(t)) { pip.generic2 = true; t = t.slice(1); }
    if (t.endsWith('P') && t.length >= 2) { pip.phyrexian = true; t = t.slice(0, -1); }
    for (const ch of t) if ((COLORS as string[]).includes(ch)) pip.options.push(ch as Color);
    if (pip.options.length) mc.pips.push(pip); else mc.generic += 1;
  }
  return mc;
}

export const manaValue = (mc: ManaCost) => mc.generic + mc.pips.reduce((a, p) => a + (p.generic2 ? 2 : 1), 0);

export function parseCost(s: string | undefined): Cost {
  const cost: Cost = { mana: { generic: 0, pips: [], x: 0 }, tap: false, sacSelf: false, supported: true };
  if (!s) return cost;
  const manaToks: string[] = [];
  for (const tok of s.trim().split(/\s+(?![^<]*>)/)) {
    if (tok === 'T') cost.tap = true;
    else if (/^Sac<1\/(CARDNAME|NICKNAME)/.test(tok)) cost.sacSelf = true;
    else if (/^Sac<(\d+)\/([^/>]+)/.test(tok)) { const m = tok.match(/^Sac<(\d+)\/([^/>]+)/)!; cost.sac = { n: +m[1], filter: m[2] }; }
    else if (/^Discard<(\d+)/.test(tok)) cost.discard = +tok.match(/^Discard<(\d+)/)![1];
    else if (/^PayLife<(\d+)>/.test(tok)) cost.payLife = +tok.match(/^PayLife<(\d+)>/)![1];
    else if (/^AddCounter<(\d+)\/LOYALTY>/.test(tok)) cost.loyalty = +tok.match(/^AddCounter<(\d+)/)![1];
    else if (/^SubCounter<(\d+|X)\/LOYALTY>/.test(tok)) { const v = tok.match(/^SubCounter<(\d+|X)/)![1]; cost.loyalty = v === 'X' ? -1 : -(+v); }
    else if (/^[0-9WUBRGCXSP\/]+$/.test(tok)) manaToks.push(tok);
    else cost.supported = false;
  }
  cost.mana = parseManaCost(manaToks.join(' '));
  return cost;
}

function splitTypes(line: string | undefined) {
  const types: string[] = [], subtypes: string[] = [], supertypes: string[] = [];
  for (const w of (line ?? '').split(/\s+/).filter(Boolean)) {
    if (CARD_TYPES.includes(w)) types.push(w === 'Tribal' ? 'Kindred' : w);
    else if (SUPERTYPES.includes(w)) supertypes.push(w);
    else subtypes.push(w);
  }
  return { types, subtypes, supertypes };
}

function colorsOf(face: RawFace, cost: ManaCost): Color[] {
  const set = new Set<Color>();
  for (const p of cost.pips) p.options.forEach(c => set.add(c));
  const cl = face.get('Colors');
  if (cl) {
    const map: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    for (const w of cl.split(',')) if (map[w.trim()]) set.add(map[w.trim()]);
  }
  return COLORS.filter(c => set.has(c));
}

export function compileEffect(face: RawFace, text: string, notes: string[], depth = 0): Effect {
  const params = parseParams(text);
  const head = Object.keys(params)[0] ?? '';
  const api = params[head] ?? '?';
  if (api === 'ImmediateTrigger' && params.Execute && face.svars[params.Execute] && depth < 8) {
    // a reflexive trigger: just run its effect, then continue the chain
    const inner = compileEffect(face, face.svars[params.Execute], notes, depth + 1);
    if (params.SubAbility && face.svars[params.SubAbility]) {
      let tail = inner; while (tail.sub) tail = tail.sub;
      tail.sub = compileEffect(face, face.svars[params.SubAbility], notes, depth + 1);
    }
    return inner;
  }
  const eff: Effect = { api, params };
  if (!SUPPORTED_APIS.has(api)) notes.push(`unsupported effect "${api}"`);
  else if (IGNORED_APIS.has(api)) notes.push(`ignored effect "${api}"`);
  void SILENT_APIS;
  if (api === 'Charm' && params.Choices && depth < 6) {
    eff.choices = params.Choices.split(',').map(n => face.svars[n.trim()]).filter(Boolean)
      .map(t => compileEffect(face, t, notes, depth + 1));
  }
  if (params.SubAbility && depth < 8) {
    const sv = face.svars[params.SubAbility];
    if (sv) eff.sub = compileEffect(face, sv, notes, depth + 1);
  }
  // ConditionCheckSVar is evaluated by the engine; the others are not
  if (params.Conditions || params.ConditionPresent || params.ConditionDefined) {
    if (!params.ETB) notes.push(`condition on ${api} ignored`);
  }
  return eff;
}

function compileLand(face: RawFace, abilities: Ability[], subtypes: string[]): LandInfo {
  const oracle = (face.get('Oracle') ?? '').replace(/\\n/g, '\n');
  const produces = new Set<Color>();
  const basicMap: Record<string, Color> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
  for (const st of subtypes) if (basicMap[st]) produces.add(basicMap[st]);
  let colorless = false;
  for (const a of abilities) {
    if (a.kind !== 'mana') continue;
    const prod = a.effect.params.Produced ?? '';
    if (prod === 'Any' || prod.includes('ColorIdentity') || prod.includes('Chosen')) COLORS.forEach(c => produces.add(c));
    for (const ch of prod.replace('Combo', '').split(/\s+/)) if ((COLORS as string[]).includes(ch)) produces.add(ch as Color);
    if (prod === 'C') colorless = true;
  }
  let entersTapped: LandInfo['entersTapped'] = 'never';
  if (/you may pay 2 life\. If you don't, it enters tapped/i.test(oracle)) entersTapped = 'unlessPayLife';
  else if (/enters tapped unless you control two or more other lands/i.test(oracle)) entersTapped = 'unlessTwoOthers';
  else if (/enters tapped unless a player has 13 or less life/i.test(oracle)) entersTapped = 'unlessLowLife';
  else if (/enters tapped/i.test(oracle)) entersTapped = 'always';
  const fetchBasic = abilities.some(a => a.effect.api === 'ChangeZone' && a.effect.params.Origin === 'Library'
    && (a.effect.params.ChangeType ?? '').includes('Land') && a.cost.sacSelf);
  if (/choose a basic land type/i.test(oracle)) COLORS.forEach(c => produces.add(c)); // Multiversal Passage
  return { produces: COLORS.filter(c => produces.has(c)), entersTapped, fetchBasic, colorless };
}

function compileFace(face: RawFace, opts: { token?: boolean } = {}): CardDef {
  const notes: string[] = [];
  const cost = parseManaCost(face.get('ManaCost'));
  const { types, subtypes, supertypes } = splitTypes(face.get('Types'));
  const pt = face.get('PT');
  let power: number | undefined, toughness: number | undefined, ptStar = false;
  if (pt) {
    const [p, t] = pt.split('/');
    power = /^-?\d+$/.test(p) ? +p : 0; toughness = /^-?\d+$/.test(t) ? +t : 0;
    if (!/^-?\d+$/.test(p) || !/^-?\d+$/.test(t)) { ptStar = true; notes.push('variable power/toughness approximated'); }
  }
  const keywords: string[] = [];
  let kicker: ManaCost | undefined, affinity: string | undefined, altAdditional: CardDef['altAdditional'];
  let chapters: Effect[] | undefined;
  for (const k of face.all('K')) {
    const base = k.split(':')[0];
    keywords.push(k);
    if (base === 'Kicker') kicker = parseManaCost(k.split(':')[1]);
    if (base === 'Affinity') affinity = k.split(':')[1];
    if (base === 'Chapter') {
      // K:Chapter:4:DBA,DBB,DBC,DBD - one SVar per chapter
      chapters = k.split(':')[2].split(',').map(n => compileEffect(face, face.svars[n.trim()] ?? '', notes));
    }
    if (base === 'AlternateAdditionalCost') {
      const parts = k.split(':');
      const sac = parts[1].match(/Sac<\d+\/([^/>]+)/)?.[1] ?? 'Creature';
      altAdditional = { sac, orMana: parseManaCost(parts[2]) };
    }
    if (!SUPPORTED_KEYWORDS.has(base) && !/^etbCounter/.test(base) && !/^CARDNAME/.test(base)) notes.push(`keyword "${base}" ignored`);
  }
  const abilities: Ability[] = [];
  let spell: Ability | undefined;
  for (const a of face.all('A')) {
    const params = parseParams(a);
    const head = Object.keys(params)[0];
    const eff = compileEffect(face, a, notes);
    const c = parseCost(params.Cost);
    if (head === 'SP') {
      spell = { kind: 'spell', effect: eff, cost: c };
    } else if (head === 'AB') {
      if (!c.supported) notes.push(`activated ability with unsupported cost "${params.Cost}" ignored`);
      abilities.push({
        kind: eff.api === 'Mana' ? 'mana' : 'activated', effect: eff, cost: c,
        planeswalker: params.Planeswalker === 'True', ultimate: params.Ultimate === 'True',
        sorcerySpeed: params.SorcerySpeed === 'True' || params.Planeswalker === 'True',
        description: params.SpellDescription,
      });
    }
  }
  const triggers: Trigger[] = [];
  for (const t of face.all('T')) {
    const params = parseParams(t);
    const mode = params.Mode;
    const exec = params.Execute ? face.svars[params.Execute] : undefined;
    const trig: Trigger = { mode, params, effect: exec ? compileEffect(face, exec, notes) : undefined };
    if (!SUPPORTED_TRIGGERS.has(mode)) notes.push(`trigger "${mode}" ignored`);
    triggers.push(trig);
  }
  const statics: StaticAbility[] = [];
  for (const s of face.all('S')) {
    const params = parseParams(s);
    statics.push({ mode: params.Mode, params });
    const m = params.Mode;
    if (m === 'Continuous') {
      if (params.IsPresent && params.PresentZone && params.PresentZone !== 'Battlefield') notes.push('conditional static treated as always on');
      if (params.SetPower || params.SetToughness || params.AddType || params.RemoveAllAbilities || params.AddAbility || params.AddTrigger)
        notes.push('static: some layer effects ignored');
    } else if (!['CantAttack', 'CantBlock', 'CantAttack,CantBlock', 'CantBlockBy', 'ReduceCost', 'CantBeCast', 'MustAttack'].includes(m)) {
      notes.push(`static "${m}" ignored`);
    }
  }
  const replacements = face.all('R').map(parseParams);
  for (const r of replacements) {
    if (types.includes('Land') && (r.Event === 'Moved')) continue;
    if (/DamageAmount/.test(face.svars[r.ReplaceWith ?? ''] ?? '') || r.Event === 'DamageDone') continue;
    if (r.Event === 'Moved' && (r.ReplaceWith ?? '').toLowerCase().includes('tap')) continue;
    notes.push(`replacement "${r.Event}" ignored`);
  }
  const def: CardDef = {
    name: face.name, cost, mv: manaValue(cost) + 0, types, subtypes, supertypes,
    colors: colorsOf(face, cost), power, toughness, ptStar,
    loyalty: face.get('Loyalty') ? parseInt(face.get('Loyalty')!, 10) || 0 : undefined,
    keywords, spell, abilities, triggers, statics, replacements, svars: face.svars,
    oracle: (face.get('Oracle') ?? '').replace(/\\n/g, '\n'), notes, kicker, affinity, altAdditional, chapters,
  };
  if (types.includes('Land')) def.land = compileLand(face, abilities, subtypes);
  if (opts.token) def.notes = notes;
  return def;
}

const cache = new Map<string, CardDef>();

export function loadCard(name: string): CardDef {
  const hit = cache.get(name.toLowerCase());
  if (hit) return hit;
  const faces = readCardScript(name);
  const front = compileFace(faces[0]);
  const alt = faces[0].get('AlternateMode');
  if (faces.length > 1) {
    const back = compileFace(faces[1]);
    if (alt === 'DoubleFaced' || alt === 'Modal' || alt === 'Transform' || front.abilities.some(a => a.effect.api === 'SetState')) {
      if (alt === 'Modal' && !front.abilities.some(a => a.effect.api === 'SetState')) front.notes.push('modal back face not playable');
      else front.back = back;
    } else if (alt === 'Adventure' || alt === 'Omen') {
      front.notes.push(`${alt.toLowerCase()} half "${back.name}" not modeled`);
    } else if (alt === 'Split') {
      front.notes.push('split card: only first half modeled');
    } else if (alt) front.notes.push(`alternate face "${alt}" not modeled`);
  }
  cache.set(name.toLowerCase(), front);
  return front;
}

const tokenCache = new Map<string, CardDef>();
export function loadToken(script: string): CardDef {
  const hit = tokenCache.get(script);
  if (hit) return hit;
  const faces = readTokenScript(script);
  let def: CardDef;
  if (faces) def = compileFace(faces[0], { token: true });
  else {
    // derive from script name like w_1_1_cat or c_a_treasure_sac
    const m = script.match(/^([wubrgc]+)_(\d+)_(\d+)(?:_a)?_(\w+)/);
    def = compileFace({
      name: script, lines: [], svars: {}, get: () => undefined, all: () => [],
    } as unknown as RawFace, { token: true });
    def.types = ['Creature']; def.power = m ? +m[2] : 1; def.toughness = m ? +m[3] : 1;
    def.notes.push(`token script ${script} not found; guessed`);
  }
  tokenCache.set(script, def);
  return def;
}

/** Human-readable coverage summary for a card. */
export function coverage(def: CardDef): { ok: boolean; notes: string[] } {
  const notes = [...new Set(def.notes)];
  return { ok: notes.length === 0, notes };
}
