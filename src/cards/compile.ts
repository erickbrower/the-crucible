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
  'AddPhase', 'MultiplyCounter', 'RevealHand', 'NameCard', 'CopyPermanent', 'DelayedTrigger', 'SacrificeAll',
]);
const IGNORED_APIS = new Set(['StoreSVar', 'GenericChoice', 'Regenerate']);
const SILENT_APIS = new Set(['ChooseType', 'Cleanup']);
// ChooseType and NameCard run when they're part of an ETBReplacement; RaiseCost statics with a numeric amount are applied
export const SUPPORTED_TRIGGERS = new Set([
  'ChangesZone', 'SpellCast', 'Attacks', 'DamageDone', 'DamageDoneOnce', 'Phase', 'LifeGained', 'AttackersDeclared',
  'ChangesZoneAll', 'Drawn', 'Sacrificed', 'Blocks', 'CounterAddedOnce', 'Exploited', 'Cycled', 'Scry', 'Surveil',
]);
const SUPPORTED_KEYWORDS = new Set([
  'Flying', 'Reach', 'Trample', 'Haste', 'Vigilance', 'Deathtouch', 'Lifelink', 'First Strike', 'Double Strike',
  'Menace', 'Defender', 'Flash', 'Prowess', 'Hexproof', 'Indestructible', 'Kicker', 'Enchant', 'Ward', 'Equip',
  'Affinity', 'AlternateAdditionalCost', 'Chapter', 'Firebending', 'Ninjutsu', 'Sneak', 'Changeling', 'Cycling', 'TypeCycling', 'Flashback', 'Convoke', 'Crew', 'Start your engines', 'Warp', 'Station', 'Spree', 'Gift', 'ETBReplacement', 'Shroud', 'Can\'t be blocked', 'Offspring', 'Mobilize', 'Impending', 'MayEffectFromOpeningHand', 'Evoke', 'Delve',
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
  else if (api === 'Effect') { notes.push(...effectGaps(face, params)); eff.svars = face.svars; }
  else if (api === 'ChooseCard' && !/IsRemembered/.test(params.Choices ?? '')) notes.push('ignored effect "ChooseCard"');
  else if (api === 'Animate' && (params.Triggers || params.Abilities || params.HiddenKeywords
    || (params.staticAbilities && !params.staticAbilities.split(',').every(n => continuousSupported(face.svars, parseParams(face.svars[n.trim()] ?? '')))))) notes.push('animate: granted abilities ignored');
  else if (api === 'DelayedTrigger') {
    if (!['Phase', 'SpellCast'].includes(params.Mode)) notes.push(`delayed trigger "${params.Mode}" ignored`);
    else if (params.Execute && face.svars[params.Execute] && depth < 8) compileEffect(face, face.svars[params.Execute], notes, depth + 1);   // notes only
  }
  else if (api === 'AddPhase' && !/Combat/.test(params.ExtraPhase ?? '')) notes.push(`extra phase "${params.ExtraPhase}" ignored`);
  void SILENT_APIS;
  if (api === 'Charm' && params.Choices && depth < 6) {
    eff.choices = params.Choices.split(',').map(n => face.svars[n.trim()]).filter(Boolean)
      .map(t => compileEffect(face, t, notes, depth + 1));
  }
  if (params.SubAbility && depth < 8) {
    const sv = face.svars[params.SubAbility];
    if (sv) eff.sub = compileEffect(face, sv, notes, depth + 1);
  }
  // ConditionCheckSVar and ConditionPresent/NotPresent (over a zone or defined objects) are evaluated by the engine
  const DEFINED_OK = /^(Targeted|ParentTarget|TargetedCard|Remembered|Self|TriggeredCard|TriggeredCardLKICopy|TriggeredTarget|Enchanted|Equipped|Valid .+)$/;
  if ((params.Conditions || (params.ConditionDefined && !DEFINED_OK.test(params.ConditionDefined))) && !params.ETB) notes.push(`condition on ${api} ignored`);
  return eff;
}

/** A continuous static whose every change the engine applies: pumps, keywords, and granted mana abilities. */
export function continuousSupported(svars: Record<string, string>, st: Record<string, string>): boolean {
  if (st.Mode !== 'Continuous') return false;
  const changes = Object.keys(st).filter(k => /^(Add|Set|Remove)/.test(k) && k !== 'AddSVar');
  return changes.length > 0 && changes.every(k => ['AddPower', 'AddToughness', 'AddKeyword'].includes(k)
    || (k === 'AddAbility' && st.AddAbility.split(' & ').every(n => /^AB\$/.test(svars[n] ?? '')))
    || (k === 'AddTrigger' && st.AddTrigger.split(' & ').every(n => SUPPORTED_TRIGGERS.has(parseParams(svars[n] ?? '').Mode))));
}

/** Temporary statics the engine applies: pumps, keywords, "can't block/attack", "can't be blocked". */
function tempStaticSupported(st: Record<string, string>): boolean {
  if (st.Mode === 'Continuous') {
    const changes = Object.keys(st).filter(k => /^(Add|Set|Remove)/.test(k));
    return changes.length > 0 && changes.every(k => ['AddPower', 'AddToughness', 'AddKeyword'].includes(k)
      || (k === 'AddHiddenKeyword' && /can't (block|attack)/i.test(st.AddHiddenKeyword)));
  }
  if (st.Mode === 'CantBlockBy') return !st.ValidBlocker;
  return /^CantBlock$|^CantAttack$|^CantAttack,CantBlock$/.test(st.Mode);
}

/** Parts of a Forge "Effect" (temporary statics/triggers/replacements) the engine does not run yet. */
export function effectGaps(face: { svars: Record<string, string> }, params: Record<string, string>): string[] {
  const out: string[] = [];
  const list = (k: string) => (params[k] ?? '').split(',').map(s => s.trim()).filter(Boolean).map(n => parseParams(face.svars[n] ?? ''));
  for (const st of list('StaticAbilities')) {
    if (st.Mode === 'Continuous' && st.MayPlay) {
      if (!/IsRemembered/.test(st.Affected ?? '') || (st.AffectedZone && st.AffectedZone !== 'Exile')) out.push(`effect: may play "${st.Affected}" ignored`);
      if (!/Remembered|Targeted|ChosenCard|TriggeredCard/.test(params.RememberObjects ?? '')) out.push('effect: may play without remembered cards ignored');
    } else if (!tempStaticSupported(st)) out.push(`effect static "${st.Mode}${st.Mode === 'Continuous' ? ' ' + Object.keys(st).filter(k => /^(Add|Set|Remove)/.test(k)).join('+') : ''}" ignored`);
  }
  for (const t of list('Triggers')) out.push(`effect trigger "${t.Mode}" ignored`);
  for (const r of list('ReplacementEffects')) if (!(r.Event === 'Counter' && /IsRemembered/.test(r.ValidCard ?? ''))) out.push(`effect replacement "${r.Event}" ignored`);
  if (!params.StaticAbilities && !params.Triggers && !params.ReplacementEffects) out.push('ignored effect "Effect"');
  return out;
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
    if (!/^-?\d+$/.test(p) || !/^-?\d+$/.test(t)) {
      ptStar = true;
      const cda = face.all('S').some(s => /CharacteristicDefining\$ True/.test(s) && /SetPower|SetToughness/.test(s));
      if (!cda) notes.push('variable power/toughness approximated');   // with a CDA the engine computes it
    }
  }
  const keywords: string[] = [];
  let kicker: ManaCost | undefined, affinity: string | undefined, altAdditional: CardDef['altAdditional'];
  let chapters: Effect[] | undefined;
  let offspring: boolean | undefined;
  for (const k of face.all('K')) {
    const base = k.split(':')[0];
    keywords.push(k);
    if (base === 'Kicker') kicker = parseManaCost(k.split(':')[1]);
    if (base === 'Offspring') { kicker = parseManaCost(k.split(':')[1]); offspring = true; }
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
  // Equip N (keyword form): a sorcery-speed "attach to target creature you control" ability
  for (const k of face.all('K').filter(k => k.startsWith('Equip:'))) {
    const [, cost, valid] = k.split(':');
    const c = parseCost(cost);
    if (!c.supported) { notes.push(`equip cost "${cost}" ignored`); continue; }
    abilities.push({ kind: 'activated', effect: { api: 'Attach', params: { ValidTgts: valid ?? 'Creature.YouCtrl' } }, cost: c, sorcerySpeed: true, description: `Equip ${cost}` });
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
    // "Max speed — ..." grants an ability, trigger or static to itself while your speed is 4
    if (params.Condition === 'MaxSpeed' && params.AffectedDefined === 'Self' && !params.EffectZone) {
      if (params.AddStaticAbility) statics.push({ mode: 'Continuous', params: { ...parseParams(face.svars[params.AddStaticAbility] ?? ''), Condition: 'MaxSpeed' } });
      if (params.AddTrigger) {
        const tp: Record<string, string> = { ...parseParams(face.svars[params.AddTrigger] ?? ''), Condition: 'MaxSpeed' };
        const exec = tp.Execute ? face.svars[tp.Execute] : undefined;
        if (!SUPPORTED_TRIGGERS.has(tp.Mode)) notes.push(`trigger "${tp.Mode}" ignored`);
        triggers.push({ mode: tp.Mode, params: tp, effect: exec ? compileEffect(face, exec, notes) : undefined });
      }
      if (params.AddAbility) {
        const ap = parseParams(face.svars[params.AddAbility] ?? '');
        const eff = compileEffect(face, face.svars[params.AddAbility], notes);
        abilities.push({ kind: eff.api === 'Mana' ? 'mana' : 'activated', effect: eff, cost: parseCost(ap.Cost), condition: 'MaxSpeed',
          sorcerySpeed: ap.SorcerySpeed === 'True', description: ap.SpellDescription });
      }
      if (params.AddReplacementEffect) notes.push('max speed replacement ignored');
      continue;
    }
    statics.push({ mode: params.Mode, params });
    const m = params.Mode;
    if (m === 'Continuous') {
      if (params.CharacteristicDefining && !params.AddType && !params.AddAbility && !params.AddTrigger && !params.RemoveAllAbilities) { /* computed by the engine */ }
      else if (continuousSupported(face.svars, params)) {
        // pumps, keywords, granted abilities and triggers: the granted effects' own gaps still count
        for (const n of (params.AddAbility ?? '').split(' & ').filter(Boolean)) compileEffect(face, face.svars[n], notes);
        for (const n of (params.AddTrigger ?? '').split(' & ').filter(Boolean)) { const tp = parseParams(face.svars[n] ?? ''); if (tp.Execute && face.svars[tp.Execute]) compileEffect(face, face.svars[tp.Execute], notes); }
      }
      else if (params.AffectedDefined === 'Self' && params.AddType === 'ChosenType') { /* Multiversal Passage: the chosen basic type */ }
      else if (/Creature/.test(params.AddType ?? '') && face.all('K').some(k => k.startsWith('Station')) && !params.RemoveAllAbilities) { /* station: becomes a creature */ }
      else if (params.SetPower || params.SetToughness || params.AddType || params.RemoveAllAbilities || params.AddAbility || params.AddTrigger)
        notes.push('static: some layer effects ignored');
    } else if (m === 'AlternativeCost' && /^Spell/.test(params.ValidSA ?? '') && (params.ValidCard ?? 'Card.Self') === 'Card.Self'
      && ((params.Cost ?? '').match(/\w+<[^>]*>|\S+/g) ?? []).every(t => !/</.test(t) || /^(PayLife|ExileFromHand|Return|Sac)</.test(t))) {
      // free spells ("if you control a commander") and pitch costs (life, exile from hand, return a land, sacrifice)
    } else if (m === 'RaiseCost' && !params.ValidTarget && !params.Cost && /Spell/.test(params.Type ?? 'Spell')) {
      // "spells cost {N} more" (Thalia, Disruptor Flute)
    } else if (!['CantAttack', 'CantBlock', 'CantAttack,CantBlock', 'CantBlockBy', 'ReduceCost', 'CantBeCast', 'MustAttack', 'MinMaxBlocker'].includes(m)) {
      notes.push(`static "${m}" ignored`);
    }
  }
  const replacements = face.all('R').map(parseParams);
  for (const r of replacements) {
    if (types.includes('Land') && (r.Event === 'Moved')) continue;
    if (/DamageAmount/.test(face.svars[r.ReplaceWith ?? ''] ?? '') || r.Event === 'DamageDone') continue;
    if (r.Event === 'Moved' && (r.ReplaceWith ?? '').toLowerCase().includes('tap')) continue;
    // "if you would gain life, you gain that much life plus 1 instead" is applied by the engine
    if (r.Event === 'GainLife' && /you gain that much life plus 1 instead/i.test(face.get('Oracle') ?? '')) continue;
    notes.push(`replacement "${r.Event}" ignored`);
  }
  const def: CardDef = {
    name: face.name, cost, mv: manaValue(cost) + 0, types, subtypes, supertypes,
    colors: colorsOf(face, cost), power, toughness, ptStar,
    loyalty: face.get('Loyalty') ? parseInt(face.get('Loyalty')!, 10) || 0 : undefined,
    keywords, spell, abilities, triggers, statics, replacements, svars: face.svars,
    oracle: (face.get('Oracle') ?? '').replace(/\\n/g, '\n'), notes, kicker, offspring, affinity, altAdditional, chapters,
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
      if (alt === 'Modal' && !front.abilities.some(a => a.effect.api === 'SetState')) {
        front.modalBack = back;
        if (!back.land) front.notes.push('modal back face not playable');   // spell/creature backs are not chosen yet
      } else front.back = back;
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

/** The effect an opponent gets when a gift is promised (SVar GiftAbility). */
export function compileGift(def: CardDef): Effect {
  const src = def.svars.GiftAbility ?? '';
  const face = { name: def.name, svars: def.svars, get: () => undefined, all: () => [] } as unknown as RawFace;
  return compileEffect(face, src, []);
}
