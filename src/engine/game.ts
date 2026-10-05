// Two-player game engine. Rules are simplified but cover the parts of Magic that decide most
// Arena games: mana, casting, a one-deep response window for counterspells, triggers, static
// buffs, combat (all common keywords), removal, tokens, planeswalkers and the command zone.
import { Ability, CardDef, Color, COLORS, Effect, Pip, Trigger, cantBeCountered } from '../cards/model.js';
import { loadToken, parseCost } from '../cards/compile.js';
import { matches, Subject, FilterCtx } from './filters.js';
import { CardInst, DeckList, Perm, Player, Rng, makeRng } from './state.js';
import * as AI from '../ai/policy.js';

export interface GameOptions {
  format: 'standard' | 'brawl';
  maxTurns: number;
  seed: number;
  trace?: boolean;
  firstPlayer?: number;
}

export type Target =
  | { kind: 'perm'; perm: Perm }
  | { kind: 'player'; pid: number }
  | { kind: 'card'; card: CardInst; zone: 'graveyard' | 'library' | 'hand' }
  | { kind: 'spell'; item: StackItem };

/** One step of a spell: an effect (or a chosen Charm mode) and the targets locked in when it was cast. */
export interface SpellStep { effect: Effect; targets?: Target[] }

export interface StackItem {
  card: CardInst; controller: number; x: number; kicked: boolean; fromCommand?: boolean;
  countered?: boolean;
  plan?: SpellStep[];              // instants/sorceries: modes + targets chosen on cast
}

export interface Ctx {
  p: number;                       // controller
  source?: Perm;                   // permanent source (if any)
  card?: CardInst;                 // card source (spells)
  x: number;
  kicked: boolean;
  triggered?: { perm?: Perm | CardInst; player?: number; amount?: number; target?: Perm };
  targets: Target[];               // targets chosen for this effect (parent targets for subs)
  preset?: Target[];               // targets locked in on cast; re-checked for legality on resolution
  sacrificedPower?: number;
  spell?: StackItem;
}

interface ManaUnit { group: number; perm?: Perm; colors: Color[]; land: boolean; treasure: boolean; any: boolean }

export class Game {
  players: [Player, Player];
  bf: Perm[] = [];
  turn = 0;
  active = 0;
  rng: Rng;
  nextId = 1;
  winner: number | undefined;
  over = false;
  log: string[] = [];
  stack: StackItem[] = [];
  opts: GameOptions;
  phase = 'setup';
  pendingTriggers: { trig: Trigger; perm: Perm | CardInst; controller: number; event: GEvent }[] = [];
  resolvingDepth = 0;
  inPriority = false;              // true while the priority loop is running (responses just push)
  stats = { damage: [0, 0], cast: [0, 0], countered: [0, 0], fizzled: [0, 0], commanderCasts: [0, 0], drawn: [0, 0], turnsWithVenom: [0, 0] };

  constructor(decks: [DeckList, DeckList], opts: GameOptions) {
    this.opts = opts;
    this.rng = makeRng(opts.seed);
    const life = opts.format === 'brawl' ? 25 : 20;
    this.players = decks.map((d, i) => this.makePlayer(i, d, life)) as [Player, Player];
  }

  private makePlayer(id: number, deck: DeckList, life: number): Player {
    const lib: CardInst[] = deck.main.map(def => ({ id: this.nextId++, def, owner: id }));
    this.rng.shuffle(lib);
    const command: CardInst[] = deck.commander ? [{ id: this.nextId++, def: deck.commander, owner: id, isCommander: true }] : [];
    const identity = new Set<Color>();
    for (const c of [deck.commander, ...deck.main]) c?.colors.forEach(x => identity.add(x));
    const counters = deck.main.filter(c => c.spell?.effect.api === 'Counter').length;
    const avg = deck.main.filter(c => !c.types.includes('Land')).reduce((a, c) => a + c.mv, 0) / Math.max(1, deck.main.filter(c => !c.types.includes('Land')).length);
    const style = counters >= 6 ? 'control' : avg <= 2.4 ? 'aggro' : 'midrange';
    return {
      id, name: deck.name, life, library: lib, hand: [], graveyard: [], exile: [], command, landsPlayed: 0, commanderTax: 0,
      lost: false, identity: deck.commander ? deck.commander.colors.length ? [...identity] : [...identity] : COLORS, spellsThisTurn: 0,
      noncreatureSpellsThisTurn: 0, drawnThisTurn: 0, lifeGainedThisTurn: 0, attackedThisTurn: false, creaturesDiedThisTurn: 0,
      mulligans: 0, style,
    };
  }

  trace(msg: string, pid = this.active) { if (this.opts.trace) this.log.push(`T${this.turn} P${pid}${pid !== this.active ? ' (opp turn)' : ''}: ${msg}`); }
  opp(p: number) { return 1 - p; }
  describe(t: Target): string {
    switch (t.kind) {
      case 'perm': return `${t.perm.def.name}(P${t.perm.controller})`;
      case 'player': return `P${t.pid}`;
      case 'card': return `${t.card.def.name} from ${t.zone}`;
      case 'spell': return `spell ${t.item.card.def.name}`;
    }
  }

  // ------------------------------------------------------------------ game flow
  play(): { winner: number | undefined; turns: number } {
    const first = this.opts.firstPlayer ?? this.rng.int(2);
    for (const p of this.players) this.mulligan(p);
    this.active = first;
    let t = 0;
    while (!this.over && t < this.opts.maxTurns * 2) {
      this.turn = Math.floor(t / 2) + 1;
      this.takeTurn(t === 0);
      this.active = this.opp(this.active);
      t++;
    }
    return { winner: this.winner, turns: this.turn };
  }

  mulligan(p: Player) {
    for (let n = 0; n < 3; n++) {
      p.library.push(...p.hand); p.hand = [];
      this.rng.shuffle(p.library);
      this.draw(p.id, 7, true);
      const keep = AI.keepHand(this, p, 7 - n);
      if (keep || n === 2) {
        for (let i = 0; i < n; i++) {
          const c = AI.chooseBottom(this, p);
          p.hand.splice(p.hand.indexOf(c), 1); p.library.unshift(c);
        }
        p.mulligans = n;
        return;
      }
    }
  }

  takeTurn(firstTurn: boolean) {
    const a = this.players[this.active];
    a.landsPlayed = 0; a.spellsThisTurn = 0; a.noncreatureSpellsThisTurn = 0; a.drawnThisTurn = 0; a.lifeGainedThisTurn = 0;
    a.attackedThisTurn = false;
    for (const pl of this.players) pl.creaturesDiedThisTurn = 0;
    for (const perm of this.bf) {
      if (perm.controller === this.active) {
        if (!perm.noUntap) perm.tapped = false;
        perm.sick = false;
      }
    }
    this.phase = 'upkeep';
    this.emit({ type: 'phase', phase: 'Upkeep', player: this.active });
    if (this.over) return;
    if (!firstTurn) this.draw(this.active, 1);
    if (this.over) return;
    this.phase = 'main1';
    this.emit({ type: 'phase', phase: 'Main1', player: this.active });
    AI.mainPhase(this, a, 1);
    if (this.over) return;
    this.phase = 'combat';
    this.emit({ type: 'phase', phase: 'BeginCombat', player: this.active });
    this.combat();
    if (this.over) return;
    this.phase = 'main2';
    AI.mainPhase(this, a, 2);
    if (this.over) return;
    this.phase = 'end';
    this.emit({ type: 'phase', phase: 'End of Turn', player: this.active });
    // opponent's end-of-turn window (flash creatures, instant removal, draw)
    AI.endOfTurnWindow(this, this.players[this.opp(this.active)]);
    this.cleanup();
    if (this.opts.trace) {
      const board = (pid: number) => this.bf.filter(x => x.controller === pid && !x.def.types.includes('Land'))
        .map(x => x.def.types.includes('Creature') ? `${x.def.name} ${this.statsOf(x).power}/${this.statsOf(x).toughness}` : x.def.name).join(', ');
      this.trace(`  == life ${this.players[0].life}-${this.players[1].life} | hands ${this.players[0].hand.length}/${this.players[1].hand.length} | P0: ${board(0) || '-'} | P1: ${board(1) || '-'}`);
      if (process.env.SHOW_HANDS) for (const pl of this.players) this.trace(`     P${pl.id} hand: ${pl.hand.map(c => c.def.name).join(', ')}`);
    }
  }

  cleanup() {
    for (const perm of this.bf) {
      perm.damage = 0; perm.deathtouched = false; perm.tempP = 0; perm.tempT = 0; perm.tempKw = [];
      perm.attacking = false; perm.blocking = false;
    }
    // mobilize-style tokens that must be sacrificed
    for (const perm of [...this.bf]) if (perm.counters['SACATEND']) this.leave(perm, 'graveyard');
    const a = this.players[this.active];
    while (a.hand.length > 7) {
      const c = AI.chooseDiscard(this, a);
      this.discard(a, c);
    }
    this.checkSBA();
  }

  // ------------------------------------------------------------------ zones
  draw(pid: number, n: number, opening = false) {
    const p = this.players[pid];
    for (let i = 0; i < n; i++) {
      const c = p.library.pop();
      if (!c) { if (!opening) this.lose(pid, 'decked'); return; }
      p.hand.push(c);
      if (!opening) {
        p.drawnThisTurn++; this.stats.drawn[pid]++;
        this.emit({ type: 'drawn', player: pid, nth: p.drawnThisTurn, card: c });
      }
    }
  }

  discard(p: Player, c: CardInst) {
    const i = p.hand.indexOf(c);
    if (i < 0) return;
    p.hand.splice(i, 1); p.graveyard.push(c);
    this.emit({ type: 'discard', player: p.id, card: c });
  }

  lose(pid: number, why: string) {
    if (this.over) return;
    this.players[pid].lost = true;
    this.over = true;
    this.winner = this.opp(pid);
    this.trace(`P${pid} loses (${why})`);
  }

  // ------------------------------------------------------------------ characteristics
  ctxFor(perm: Perm): FilterCtx {
    return { you: perm.controller, sourceId: perm.id, sourceAttachedTo: perm.attachedTo, chosenType: perm.chosenType };
  }

  subjectOf(x: Perm | CardInst, controller?: number): Subject {
    const isPerm = (x as Perm).controller !== undefined && this.bf.includes(x as Perm);
    if (isPerm) {
      const perm = x as Perm;
      const st = this.statsOf(perm);
      return {
        kind: 'card', def: perm.def, controller: perm.controller, owner: perm.owner, token: perm.token, id: perm.id,
        tapped: perm.tapped, attacking: perm.attacking, blocking: perm.blocking, power: st.power, toughness: st.toughness,
        keywords: st.keywords, attachedTo: perm.attachedTo, zone: 'battlefield',
      };
    }
    return { kind: 'card', def: x.def, controller: controller ?? (x as Perm).controller ?? x.owner, owner: x.owner, token: x.token, id: x.id,
      power: x.def.power, toughness: x.def.toughness, keywords: x.def.keywords };
  }

  playerSubject(pid: number): Subject { return { kind: 'player', controller: pid }; }

  /** Effective power/toughness/keywords including counters, temporary effects and static abilities. */
  statsOf(perm: Perm): { power: number; toughness: number; keywords: string[] } {
    const d = perm.def;
    let power = (d.power ?? 0) + (perm.counters.P1P1 ?? 0) - (perm.counters.M1M1 ?? 0) + perm.tempP;
    let toughness = (d.toughness ?? 0) + (perm.counters.P1P1 ?? 0) - (perm.counters.M1M1 ?? 0) + perm.tempT;
    if (d.ptStar) { const v = this.starValue(perm); power += v.p; toughness += v.t; }
    const kws = new Set<string>(d.keywords.map(k => k.split(':')[0]));
    perm.tempKw.forEach(k => kws.add(k));
    for (const src of this.bf) {
      for (const st of src.def.statics) {
        if (st.mode !== 'Continuous') continue;
        if (!this.staticApplies(src, st.params, perm)) continue;
        if (st.params.AddPower) power += this.amount(st.params.AddPower, { p: src.controller, source: src, x: 0, kicked: false, targets: [] }, src.def);
        if (st.params.AddToughness) toughness += this.amount(st.params.AddToughness, { p: src.controller, source: src, x: 0, kicked: false, targets: [] }, src.def);
        if (st.params.AddKeyword) st.params.AddKeyword.split(' & ').forEach(k => kws.add(k.split(':')[0]));
      }
    }
    return { power, toughness, keywords: [...kws] };
  }

  private starValue(perm: Perm) {
    // Approximations for */* creatures: count creatures you control (Crusader of Odric style) or cards in graveyard.
    const o = perm.def.oracle;
    let v = 0;
    if (/number of creatures you control/i.test(o)) v = this.bf.filter(x => x.controller === perm.controller && x.def.types.includes('Creature')).length;
    else if (/number of lands you control/i.test(o)) v = this.bf.filter(x => x.controller === perm.controller && x.def.types.includes('Land')).length;
    else if (/instant and sorcery cards in your graveyard/i.test(o)) v = this.players[perm.controller].graveyard.filter(c => c.def.types.includes('Instant') || c.def.types.includes('Sorcery')).length;
    else if (/cards? in (your|all) graveyards?/i.test(o)) v = Math.min(6, this.players[perm.controller].graveyard.length);
    else if (/greatest mana value/i.test(o)) v = Math.max(0, ...this.bf.filter(x => x.controller === perm.controller).map(x => x.def.mv));
    else v = 2;
    const pOnly = /power is equal/i.test(o) && !/power and toughness/i.test(o);
    return { p: v, t: pOnly ? 0 : v };
  }

  staticApplies(src: Perm, params: Record<string, string>, target: Perm): boolean {
    if (params.AffectedDefined) {
      const d = params.AffectedDefined;
      if (d === 'Self') return target.id === src.id;
      if (d === 'Enchanted' || d === 'Equipped' || d === 'Attached') return target.id === src.attachedTo;
      return false;
    }
    if (!params.Affected) return false;
    if (params.EffectZone && params.EffectZone !== 'Battlefield') return false;
    const subj: Subject = {
      kind: 'card', def: target.def, controller: target.controller, owner: target.owner, token: target.token, id: target.id,
      tapped: target.tapped, attacking: target.attacking, attachedTo: target.attachedTo,
      power: target.def.power, toughness: target.def.toughness, keywords: target.def.keywords,
    };
    return matches(params.Affected, subj, this.ctxFor(src));
  }

  has(perm: Perm, kw: string) { return this.statsOf(perm).keywords.includes(kw); }

  cantAttack(perm: Perm) {
    if (this.has(perm, 'Defender')) return true;
    return this.bf.some(src => src.def.statics.some(s => /CantAttack/.test(s.mode) && this.staticHits(src, s.params, perm)));
  }
  cantBlock(perm: Perm) {
    return this.bf.some(src => src.def.statics.some(s => /CantBlock(?!By)/.test(s.mode) && this.staticHits(src, s.params, perm)));
  }
  unblockable(perm: Perm) {
    if (this.has(perm, 'Unblockable') || this.has(perm, "Can't be blocked")) return true;
    return perm.def.statics.some(s => s.mode === 'CantBlockBy' && (s.params.ValidAttacker ?? '').includes('Self') && !s.params.ValidBlocker);
  }
  private staticHits(src: Perm, params: Record<string, string>, perm: Perm) {
    const f = params.ValidCard ?? params.Affected;
    if (!f) return false;
    return matches(f, this.subjectOf(perm), this.ctxFor(src));
  }

  // ------------------------------------------------------------------ amounts
  amount(v: string | undefined, ctx: Ctx, def?: CardDef, depth = 0): number {
    if (v === undefined || v === '') return 0;
    v = v.trim();
    if (/^[+-]?\d+$/.test(v)) return parseInt(v, 10);
    let neg = 1;
    if (v.startsWith('-')) { neg = -1; v = v.slice(1); }
    if (v.startsWith('+')) v = v.slice(1);
    const svars = def?.svars ?? ctx.source?.def.svars ?? ctx.card?.def.svars ?? {};
    if (v === 'X' && !svars.X) return neg * ctx.x;
    const sv = svars[v];
    if (sv && depth < 4) return neg * this.countExpr(sv, ctx, def, depth);
    if (v.startsWith('Count$') || v.includes('$')) return neg * this.countExpr(v, ctx, def, depth);
    return neg * 1;
  }

  private countExpr(expr: string, ctx: Ctx, def?: CardDef, depth = 0): number {
    const me = this.players[ctx.p];
    let m: RegExpMatchArray | null;
    let base: number | undefined;
    let rest = '';
    if ((m = expr.match(/^Count\$Kicked\.(\d+)\.(\d+)/))) return ctx.kicked ? +m[1] : +m[2];
    if ((m = expr.match(/^Count\$Compare .*\.(\d+)\.(\d+)$/))) return +m[2];
    if (/^Count\$xPaid/.test(expr)) return ctx.x;
    if (/^Count\$YourLifeTotal/.test(expr)) return me.life;
    if (/^Count\$CardsInYourHand/.test(expr)) return me.hand.length;
    if ((m = expr.match(/^Count\$(?:Valid|TypeYouCtrl) ([^/]+)(\/.*)?$/))) {
      base = this.bf.filter(x => matches(m![1], this.subjectOf(x), { you: ctx.p, sourceId: ctx.source?.id })).length; rest = m[2] ?? '';
    } else if ((m = expr.match(/^Count\$ValidGraveyard ([^/]+)(\/.*)?$/))) {
      base = me.graveyard.filter(c => matches(m![1], this.subjectOf(c, ctx.p), { you: ctx.p })).length; rest = m[2] ?? '';
    } else if ((m = expr.match(/^Count\$ValidHand ([^/]+)(\/.*)?$/))) {
      base = me.hand.filter(c => matches(m![1], this.subjectOf(c, ctx.p), { you: ctx.p })).length; rest = m[2] ?? '';
    } else if (/^(Sacrificed|Targeted|TriggeredCard|Remembered|Defined)\$CardPower/.test(expr)) {
      if (/^Sacrificed/.test(expr)) return ctx.sacrificedPower ?? 0;
      const t = ctx.targets.find(t => t.kind === 'perm') as { perm: Perm } | undefined;
      if (/^Targeted/.test(expr) && t) return this.statsOf(t.perm).power;
      const tp = ctx.triggered?.perm as Perm | undefined;
      if (tp && this.bf.includes(tp)) return this.statsOf(tp).power;
      return tp?.def.power ?? (ctx.source ? this.statsOf(ctx.source).power : 0);
    } else if (/CardPower/.test(expr)) {
      return ctx.source && this.bf.includes(ctx.source) ? this.statsOf(ctx.source).power : 1;
    } else if (/TriggerCount\$DamageAmount|TriggeredDamageAmount|TriggerCount\$Amount|TriggerCount\$LifeAmount/.test(expr)) {
      return ctx.triggered?.amount ?? 1;
    } else if (/CardManaCost|CardManaValue|CardCMC/.test(expr)) {
      const tp = ctx.triggered?.perm ?? (ctx.targets[0]?.kind === 'perm' ? (ctx.targets[0] as { perm: Perm }).perm : undefined);
      return tp?.def.mv ?? 0;
    } else if ((m = expr.match(/^Count\$InYourYard/))) {
      return me.graveyard.length;
    } else if ((m = expr.match(/^Count\$YourCountersP1P1/))) {
      return ctx.source?.counters.P1P1 ?? 0;
    } else if (/^Count\$CardCounters\.(\w+)/.test(expr)) {
      return ctx.source?.counters[expr.match(/^Count\$CardCounters\.(\w+)/)![1]] ?? 0;
    } else if (/^Number\$(\d+)/.test(expr)) {
      return +expr.match(/^Number\$(\d+)/)![1];
    }
    if (base === undefined) return 1;
    // modifiers like /Plus.1 /Times.2 /HalfDown
    for (const mod of rest.split('/').filter(Boolean)) {
      const mm = mod.match(/^(Plus|Minus|Times|Twice|HalfDown|HalfUp|LimitMax)\.?(\d*)$/);
      if (!mm) continue;
      const k = +(mm[2] || 2);
      if (mm[1] === 'Plus') base += k; else if (mm[1] === 'Minus') base -= k; else if (mm[1] === 'Times') base *= k;
      else if (mm[1] === 'Twice') base *= 2; else if (mm[1] === 'HalfDown') base = Math.floor(base / 2);
      else if (mm[1] === 'HalfUp') base = Math.ceil(base / 2); else if (mm[1] === 'LimitMax') base = Math.min(base, k);
    }
    void depth; void def;
    return base;
  }

  // ------------------------------------------------------------------ mana
  manaUnits(pid: number): ManaUnit[] {
    const units: ManaUnit[] = [];
    let g = 0;
    const p = this.players[pid];
    for (const perm of this.bf) {
      if (perm.controller !== pid || perm.tapped) continue;
      const d = perm.def;
      if (d.types.includes('Creature') && perm.sick && !this.has(perm, 'Haste')) continue;
      if (d.land) {
        let colors = d.land.produces;
        if (perm.chosenType) colors = [({ Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' } as Record<string, Color>)[perm.chosenType]];
        else if (d.abilities.some(a => a.kind === 'mana' && a.effect.params.IsPresent)) {
          colors = [];
          for (const a of d.abilities.filter(a => a.kind === 'mana')) {
            const ip = a.effect.params.IsPresent;
            if (ip && !this.bf.some(x => x.controller === pid && matches(ip, this.subjectOf(x), { you: pid }))) continue;
            for (const ch of (a.effect.params.Produced ?? '').replace('Combo', '').split(/\s+/)) if ((COLORS as string[]).includes(ch)) colors.push(ch as Color);
          }
        }
        if (d.abilities.some(a => (a.effect.params.Produced ?? '').includes('ColorIdentity'))) colors = p.identity;
        units.push({ group: g++, perm, colors, land: true, treasure: false, any: false });
        continue;
      }
      const ma = d.abilities.find(a => a.kind === 'mana' && a.cost.supported && (a.cost.tap || a.cost.sacSelf) && a.cost.mana.generic === 0 && a.cost.mana.pips.length === 0);
      if (!ma) continue;
      const prod = ma.effect.params.Produced ?? 'C';
      let colors: Color[] = [];
      let any = false;
      if (prod === 'Any' || prod.includes('Chosen')) { colors = COLORS; any = true; }
      else if (prod.includes('ColorIdentity')) colors = p.identity;
      else for (const ch of prod.replace('Combo', '').split(/\s+/)) if ((COLORS as string[]).includes(ch)) colors.push(ch as Color);
      let amt = 1;
      const am = ma.effect.params.Amount;
      if (am) amt = Math.max(1, Math.min(6, this.amount(am, { p: pid, source: perm, x: 0, kicked: false, targets: [] })));
      if (/For each color among permanents you control/i.test(d.oracle)) {
        const cs = new Set<Color>();
        this.bf.filter(x => x.controller === pid).forEach(x => x.def.colors.forEach(c => cs.add(c)));
        colors = [...cs]; amt = Math.max(1, cs.size); any = false;
      }
      const grp = g++;
      for (let i = 0; i < amt; i++) units.push({ group: grp, perm, colors, land: false, treasure: ma.cost.sacSelf, any });
    }
    return units;
  }

  /** Try to pay a mana cost; returns true if possible. If commit, taps/sacrifices the sources. */
  payMana(pid: number, generic: number, pips: Pip[], commit: boolean): boolean {
    const units = this.manaUnits(pid);
    // order: lands with fewest colors first, then dorks, treasures last
    const order = units.map((u, i) => i).sort((a, b) => {
      const ua = units[a], ub = units[b];
      const sa = (ua.treasure ? 100 : 0) + (ua.land ? 0 : 10) + ua.colors.length;
      const sb = (ub.treasure ? 100 : 0) + (ub.land ? 0 : 10) + ub.colors.length;
      return sa - sb;
    });
    const used = new Set<number>();
    const p = this.players[pid];
    let lifeToPay = 0;
    const sortedPips = [...pips].sort((a, b) => a.options.length - b.options.length);
    let extraGeneric = 0;
    const assign = (k: number): boolean => {
      if (k === sortedPips.length) return true;
      const pip = sortedPips[k];
      for (const i of order) {
        if (used.has(i)) continue;
        if (pip.options.some(c => units[i].colors.includes(c))) {
          used.add(i);
          if (assign(k + 1)) return true;
          used.delete(i);
        }
      }
      if (pip.phyrexian && p.life - lifeToPay > 6) { lifeToPay += 2; if (assign(k + 1)) return true; lifeToPay -= 2; }
      if (pip.generic2) { extraGeneric += 2; if (assign(k + 1)) return true; extraGeneric -= 2; }
      return false;
    };
    if (!assign(0)) return false;
    const rest = order.filter(i => !used.has(i));
    const need = generic + extraGeneric;
    if (rest.length < need) return false;
    if (commit) {
      const chosen = [...used, ...rest.slice(0, need)];
      const groups = new Set(chosen.map(i => units[i].group));
      const done = new Set<Perm>();
      for (const i of chosen) {
        const u = units[i];
        if (!u.perm || done.has(u.perm) || !groups.has(u.group)) continue;
        done.add(u.perm);
        if (u.treasure) this.leave(u.perm, 'graveyard', { sacrificed: true });
        else u.perm.tapped = true;
      }
      if (lifeToPay) this.loseLife(pid, lifeToPay);
    }
    return true;
  }

  availableMana(pid: number) { return this.manaUnits(pid).length; }

  spellCost(pid: number, c: CardInst, opts: { kicked?: boolean; x?: number; fromCommand?: boolean } = {}) {
    let generic = c.def.cost.generic + (opts.x ?? 0) * Math.max(1, c.def.cost.x);
    const pips = [...c.def.cost.pips];
    if (opts.kicked && c.def.kicker) { generic += c.def.kicker.generic; pips.push(...c.def.kicker.pips); }
    if (opts.fromCommand) generic += this.players[pid].commanderTax;
    if (c.def.affinity) {
      const n = this.bf.filter(x => x.controller === pid && matches(c.def.affinity, this.subjectOf(x), { you: pid })).length;
      generic = Math.max(0, generic - n);
    }
    // cost reducers ("Red spells you cast cost {1} less", "costs {3} less if it targets a tapped creature" is ignored)
    for (const src of this.bf) {
      if (src.controller !== pid) continue;
      for (const st of src.def.statics) {
        if (st.mode !== 'ReduceCost' || st.params.Activator === 'Opponent') continue;
        if (st.params.ValidCard && !matches(st.params.ValidCard, this.subjectOf(c, pid), this.ctxFor(src))) continue;
        if (st.params.Type && !/Spell/.test(st.params.Type)) continue;
        const amt = parseInt(st.params.Amount ?? '1', 10) || 1;
        generic = Math.max(0, generic - amt);
      }
    }
    if (c.def.altAdditional && opts.kicked === undefined) { /* handled by caster */ }
    return { generic, pips };
  }

  canCast(pid: number, c: CardInst, opts: { kicked?: boolean; x?: number; fromCommand?: boolean } = {}) {
    const { generic, pips } = this.spellCost(pid, c, opts);
    return this.payMana(pid, generic, pips, false);
  }

  // ------------------------------------------------------------------ lands
  playLand(p: Player, c: CardInst, wantUntapped: boolean) {
    p.hand.splice(p.hand.indexOf(c), 1);
    p.landsPlayed++;
    const land = c.def.land!;
    let tapped = false;
    switch (land.entersTapped) {
      case 'always': tapped = true; break;
      case 'unlessTwoOthers': tapped = this.bf.filter(x => x.controller === p.id && x.def.types.includes('Land')).length < 2; break;
      case 'unlessLowLife': tapped = !this.players.some(pl => pl.life <= 13); break;
      case 'unlessPayLife': tapped = !(wantUntapped && p.life > 4); if (!tapped) this.loseLife(p.id, 2); break;
    }
    const perm = this.enter(c, p.id, { tapped });
    if (/choose a basic land type/i.test(c.def.oracle)) {
      const need = AI.neededColor(this, p);
      perm.chosenType = ({ W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' } as Record<Color, string>)[need];
    }
    this.trace(`plays ${c.def.name}${tapped ? ' (tapped)' : ''}`);
    // fetch lands crack immediately
    if (land.fetchBasic) {
      const ab = c.def.abilities.find(a => a.effect.api === 'ChangeZone' && a.cost.sacSelf)!;
      if (!ab.cost.mana.generic && (!ab.cost.payLife || p.life > ab.cost.payLife + 3)) {
        if (ab.cost.payLife) this.loseLife(p.id, ab.cost.payLife);
        this.leave(perm, 'graveyard', { sacrificed: true });
        this.resolveEffect(ab.effect, { p: p.id, x: 0, kicked: false, targets: [], card: c });
      }
    }
  }

  // ------------------------------------------------------------------ casting
  castSpell(pid: number, c: CardInst, opts: { kicked?: boolean; x?: number; fromCommand?: boolean; sacForAlt?: Perm } = {}): boolean {
    const p = this.players[pid];
    let { generic, pips } = this.spellCost(pid, c, opts);
    if (c.def.altAdditional && !opts.sacForAlt) { generic += c.def.altAdditional.orMana.generic; pips = [...pips, ...c.def.altAdditional.orMana.pips]; }
    if (!this.payMana(pid, generic, pips, true)) return false;
    if (opts.sacForAlt) this.leave(opts.sacForAlt, 'graveyard', { sacrificed: true });
    if (opts.fromCommand) { p.command.splice(p.command.indexOf(c), 1); p.commanderTax += 2; this.stats.commanderCasts[pid]++; }
    else p.hand.splice(p.hand.indexOf(c), 1);
    p.spellsThisTurn++; this.stats.cast[pid]++;
    const item: StackItem = { card: c, controller: pid, x: opts.x ?? 0, kicked: !!opts.kicked, fromCommand: opts.fromCommand };
    const isCreature = c.def.types.includes('Creature');
    if (!isCreature) p.noncreatureSpellsThisTurn++;
    const under = this.stack[this.stack.length - 1];
    this.trace(`casts ${c.def.name}${item.x ? ` X=${item.x}` : ''}${item.kicked ? ' (kicked)' : ''}${under ? ` in response to ${under.card.def.name}` : ''}`, pid);
    // modes and targets are chosen now and stay locked in until the spell resolves
    if (c.def.spell && !this.isPermanentSpell(c.def)) item.plan = this.lockTargets(c.def.spell.effect, { p: pid, card: c, x: item.x, kicked: item.kicked, targets: [], spell: item });
    AI.resetHints();
    this.stack.push(item);
    this.emit({ type: 'cast', player: pid, card: c, item });
    // prowess
    if (!isCreature) for (const perm of this.bf) if (perm.controller === pid && this.has(perm, 'Prowess')) { perm.tempP++; perm.tempT++; }
    this.resolveTriggers();
    if (!this.inPriority) this.settle(pid);
    return true;
  }

  isPermanentSpell(d: CardDef) {
    return d.types.some(t => ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'].includes(t)) && !d.types.includes('Instant') && !d.types.includes('Sorcery');
  }

  private lockTargets(eff: Effect, ctx: Ctx): SpellStep[] {
    let steps: Effect[] = [eff];
    if (eff.api === 'Charm') {
      const n = eff.params.CharmNum ? Math.max(1, this.amount(eff.params.CharmNum, ctx)) : 1;
      steps = AI.chooseCharm(this, eff, ctx).slice(0, n);
      if (eff.sub) steps.push(eff.sub);
    }
    return steps.map(e => {
      if (e.params.ValidTgts === undefined && e.params.TargetType === undefined) return { effect: e };
      const t = AI.chooseTargets(this, e, ctx);
      if (this.opts.trace && t.length) this.trace(`  ${ctx.card?.def.name} (${e.api}) -> ${t.map(x => this.describe(x)).join(', ')}`, ctx.p);
      return { effect: e, targets: t };
    });
  }

  /** Pay a ward cost ("2", "Discard<1/Card>", "PayLife<3>"). Returns false if it can't be paid. */
  private payWard(pid: number, cost: string): boolean {
    const p = this.players[pid];
    const n = parseInt(cost, 10);
    if (!isNaN(n)) return this.payMana(pid, n, [], true);
    let m = cost.match(/^Discard<(\d+)/);
    if (m) {
      const k = +m[1];
      if (p.hand.length < k) return false;
      for (let i = 0; i < k; i++) this.discard(p, AI.chooseDiscard(this, p));
      this.trace(`  discards ${k} to pay ward`, pid);
      return true;
    }
    m = cost.match(/^PayLife<(\d+)>/);
    if (m) { if (p.life <= +m[1]) return false; this.loseLife(pid, +m[1]); return true; }
    return true;   // unknown ward cost: treat as paid
  }

  /** Is a locked-in target still legal? (still there, still matches, no new hexproof/shroud) */
  isLegalTarget(t: Target, eff: Effect, ctx: Ctx): boolean {
    switch (t.kind) {
      case 'perm': {
        if (!this.bf.includes(t.perm)) return false;
        const kw = this.statsOf(t.perm).keywords;
        if (kw.includes('Shroud') || (t.perm.controller !== ctx.p && kw.includes('Hexproof'))) return false;
        return matches(eff.params.ValidTgts ?? 'Card', this.subjectOf(t.perm), { you: ctx.p, sourceId: ctx.source?.id });
      }
      case 'player': return !this.players[t.pid].lost;
      case 'card': { const o = this.players[t.card.owner]; return o.graveyard.includes(t.card) || o.hand.includes(t.card); }
      case 'spell': return this.stack.includes(t.item) && !t.item.countered;
    }
  }

  /**
   * The priority loop. After a spell is cast, players alternate getting priority; each may respond
   * (which pushes onto the stack) or pass. Two passes in a row resolve the top of the stack, and the
   * active player gets priority again. Runs until the stack is empty.
   */
  settle(actor: number) {
    if (this.inPriority) return;
    this.inPriority = true;
    let holder = this.opp(actor), passes = 1, guard = 0;   // the caster passes first
    try {
      while (this.stack.length && !this.over && guard++ < 300) {
        const top = this.stack[this.stack.length - 1];
        if (AI.respond(this, this.players[holder], top)) { passes = 1; holder = this.opp(holder); continue; }
        if (++passes >= 2) { this.resolveTop(); passes = 0; holder = this.active; }
        else holder = this.opp(holder);
      }
    } finally { this.inPriority = false; }
  }

  private resolveTop() {
    const item = this.stack.pop()!;
    const c = item.card, p = this.players[item.controller];
    const toYard = () => { if (c.isCommander) p.command.push(c); else p.graveyard.push(c); };
    if (item.countered) {
      this.trace(`${c.def.name} is countered`, item.controller);
      this.stats.countered[item.controller]++;
      toYard(); return;
    }
    // a spell whose targets have all become illegal does nothing ("fizzles")
    const targeted = (item.plan ?? []).filter(st => st.targets && st.targets.length);
    const ctx: Ctx = { p: item.controller, card: c, x: item.x, kicked: item.kicked, targets: [] };
    if (targeted.length && targeted.every(st => st.targets!.every(t => !this.isLegalTarget(t, st.effect, ctx)))) {
      this.trace(`${c.def.name} fizzles (no legal targets)`, item.controller);
      this.stats.fizzled[item.controller]++;
      toYard(); return;
    }
    this.resolveSpell(item);
  }

  resolveSpell(item: StackItem) {
    const c = item.card; const pid = item.controller; const p = this.players[pid];
    if (c.def.types.some(t => ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'].includes(t)) && !c.def.types.includes('Instant')) {
      const perm = this.enter(c, pid, {});
      if (c.def.keywords.some(k => k.startsWith('Enchant'))) {
        const host = AI.chooseAuraHost(this, perm);
        if (host) perm.attachedTo = host.id; else this.leave(perm, 'graveyard');
      } else if (c.def.spell && c.def.spell.effect.api === 'Attach' && !perm.attachedTo) {
        const host = AI.chooseAuraHost(this, perm);
        if (host) perm.attachedTo = host.id;
      }
    } else {
      for (const st of item.plan ?? []) this.resolveEffect(st.effect, { p: pid, card: c, x: item.x, kicked: item.kicked, targets: [], spell: item, preset: st.targets });
      if (c.isCommander) p.command.push(c);
      else if (!p.exile.includes(c)) p.graveyard.push(c);
    }
    this.resolveTriggers();
    this.checkSBA();
  }

  // ------------------------------------------------------------------ battlefield movement
  enter(c: CardInst, controller: number, opts: { tapped?: boolean; token?: boolean; attacking?: boolean } = {}): Perm {
    const perm: Perm = {
      ...c, controller, tapped: !!opts.tapped, sick: true, token: !!opts.token || !!c.token, counters: {}, damage: 0,
      deathtouched: false, tempP: 0, tempT: 0, tempKw: [], exiledUntilLeaves: [], transformed: false, enteredTurn: this.turn,
      attacking: opts.attacking,
    };
    if (c.def.loyalty !== undefined) perm.counters.LOYALTY = c.def.loyalty;
    for (const k of c.def.keywords) {
      const m = k.match(/^etbCounter:(\w+):(\d+)/);
      if (m) perm.counters[m[1]] = (perm.counters[m[1]] ?? 0) + +m[2];
    }
    // "enters with N -1/-1 counters" style text
    const om = c.def.oracle.match(/enters with (\w+) ([+-]1\/[+-]1) counters?/i);
    if (om && !c.def.keywords.some(k => k.startsWith('etbCounter'))) {
      const n = ({ a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 } as Record<string, number>)[om[1].toLowerCase()] ?? (parseInt(om[1], 10) || 0);
      perm.counters[om[2].startsWith('+') ? 'P1P1' : 'M1M1'] = n;
    }
    this.bf.push(perm);
    // legend rule
    if (c.def.supertypes.includes('Legendary')) {
      const dup = this.bf.filter(x => x !== perm && x.controller === controller && x.def.name === perm.def.name);
      for (const d of dup) this.leave(d, 'graveyard');
    }
    this.emit({ type: 'zone', perm, from: 'Any', to: 'Battlefield' });
    return perm;
  }

  leave(perm: Perm, to: 'graveyard' | 'exile' | 'hand' | 'library' | 'librarybottom', opts: { sacrificed?: boolean } = {}) {
    const i = this.bf.indexOf(perm);
    if (i < 0) return;
    this.bf.splice(i, 1);
    const owner = this.players[perm.owner];
    const wasCreature = perm.def.types.includes('Creature');
    const snapshot: Perm = { ...perm };
    let dest = to;
    if (perm.isCommander && (to === 'graveyard' || to === 'exile' || to.startsWith('library'))) dest = 'command' as never;
    // attachments fall off
    for (const a of this.bf.filter(x => x.attachedTo === perm.id)) {
      if (a.def.subtypes.includes('Equipment')) a.attachedTo = undefined;
      else this.leave(a, 'graveyard');
    }
    // "until this leaves the battlefield" exiles come back
    for (const ex of perm.exiledUntilLeaves) {
      const pl = this.players[ex.owner];
      const k = pl.exile.indexOf(ex);
      if (k >= 0) { pl.exile.splice(k, 1); this.enter(ex, ex.owner, {}); }
    }
    if (!perm.token) {
      const card: CardInst = { id: perm.id, def: perm.transformed && perm.def.name !== perm.def.name ? perm.def : this.originalDef(perm), owner: perm.owner, isCommander: perm.isCommander };
      if ((dest as string) === 'command') owner.command.push(card);
      else if (dest === 'graveyard') owner.graveyard.push(card);
      else if (dest === 'exile') owner.exile.push(card);
      else if (dest === 'hand') owner.hand.push(card);
      else if (dest === 'library') owner.library.push(card);
      else owner.library.unshift(card);
    }
    if (wasCreature && to === 'graveyard') this.players[perm.controller].creaturesDiedThisTurn++;
    if (opts.sacrificed) this.emit({ type: 'sacrificed', perm: snapshot });
    this.emit({ type: 'zone', perm: snapshot, from: 'Battlefield', to: to === 'graveyard' ? 'Graveyard' : to === 'exile' ? 'Exile' : to === 'hand' ? 'Hand' : 'Library' });
  }

  private originalDef(perm: Perm): CardDef {
    // transformed permanents return to their front face
    const front = (perm as Perm & { frontDef?: CardDef }).frontDef;
    return front ?? perm.def;
  }

  destroy(perm: Perm) {
    if (this.has(perm, 'Indestructible')) return false;
    this.leave(perm, 'graveyard');
    return true;
  }

  // ------------------------------------------------------------------ life & damage
  gainLife(pid: number, n: number) {
    if (n <= 0) return;
    if (this.bf.some(x => /Players can't gain life/i.test(x.def.oracle))) return;
    let amt = n;
    for (const x of this.bf) if (x.controller === pid && /If you would gain life, you gain that much life plus 1 instead/i.test(x.def.oracle)) amt++;
    this.players[pid].life += amt;
    this.players[pid].lifeGainedThisTurn += amt;
    this.emit({ type: 'lifeGained', player: pid, amount: amt });
  }

  loseLife(pid: number, n: number) {
    if (n <= 0) return;
    this.players[pid].life -= n;
    if (this.players[pid].life <= 0) this.lose(pid, 'life');
  }

  dealDamage(source: Perm | CardInst | undefined, controller: number, target: Target, amount: number, combat: boolean) {
    if (amount <= 0) return 0;
    // noncombat damage modifiers (Tomik, Twinflame Tyrant style)
    if (!combat) {
      const hitsOpp = (target.kind === 'player' && target.pid !== controller) || (target.kind === 'perm' && target.perm.controller !== controller);
      if (hitsOpp) for (const x of this.bf) {
        if (x.controller !== controller) continue;
        if (/would deal noncombat damage to an opponent or a permanent an opponent controls, it deals that much damage plus 1/i.test(x.def.oracle)) amount += 1;
      }
    }
    {
      const hitsOpp = (target.kind === 'player' && target.pid !== controller) || (target.kind === 'perm' && target.perm.controller !== controller);
      if (hitsOpp) for (const x of this.bf) if (x.controller === controller && /deal damage to an opponent or a permanent an opponent controls, it deals double that damage/i.test(x.def.oracle)) amount *= 2;
    }
    const srcPerm = source && this.bf.includes(source as Perm) ? (source as Perm) : undefined;
    const kws = srcPerm ? this.statsOf(srcPerm).keywords : source?.def.keywords.map(k => k.split(':')[0]) ?? [];
    if (target.kind === 'player') {
      this.players[target.pid].life -= amount;
      this.stats.damage[controller] += amount;
      if (this.players[target.pid].life <= 0) this.lose(target.pid, 'damage');
    } else if (target.kind === 'perm') {
      const t = target.perm;
      if (!this.bf.includes(t)) return 0;
      if (t.def.types.includes('Planeswalker') && !t.def.types.includes('Creature')) {
        t.counters.LOYALTY = (t.counters.LOYALTY ?? 0) - amount;
      } else if (/If damage would be dealt to [^,]+, prevent that damage and put that many \+1\/\+1 counters/i.test(t.def.oracle)) {
        t.counters.P1P1 = (t.counters.P1P1 ?? 0) + amount;
      } else {
        t.damage += amount;
        if (kws.includes('Deathtouch')) t.deathtouched = true;
      }
    }
    if (kws.includes('Lifelink')) this.gainLife(controller, amount);
    this.emit({ type: 'damage', source: srcPerm ?? (source as Perm | undefined), controller, target, amount, combat });
    return amount;
  }

  // ------------------------------------------------------------------ state-based actions
  checkSBA() {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 20 && !this.over) {
      changed = false;
      for (const perm of [...this.bf]) {
        if (perm.def.types.includes('Creature')) {
          const st = this.statsOf(perm);
          if (st.toughness <= 0) { this.leave(perm, 'graveyard'); changed = true; continue; }
          if ((perm.damage >= st.toughness || (perm.deathtouched && perm.damage > 0)) && !st.keywords.includes('Indestructible')) {
            this.leave(perm, 'graveyard'); changed = true; continue;
          }
        }
        if (perm.def.types.includes('Planeswalker') && (perm.counters.LOYALTY ?? 0) <= 0) { this.leave(perm, 'graveyard'); changed = true; }
        if (perm.attachedTo !== undefined && !perm.def.subtypes.includes('Equipment') && !this.bf.some(x => x.id === perm.attachedTo)) {
          this.leave(perm, 'graveyard'); changed = true;
        }
      }
      for (const pl of this.players) if (pl.life <= 0) this.lose(pl.id, 'life');
      if (changed) this.resolveTriggers();
    }
  }

  // ------------------------------------------------------------------ triggers
  emit(ev: GEvent) {
    if (this.over) return;
    const candidates: (Perm | CardInst)[] = [...this.bf];
    if (ev.type === 'zone' && ev.from === 'Battlefield') candidates.push(ev.perm);   // leaves-the-battlefield self triggers
    for (const src of candidates) {
      const def = src.def;
      if (!def.triggers.length && !def.keywords.some(k => k.startsWith('Mobilize'))) continue;
      const controller = (src as Perm).controller ?? src.owner;
      for (const trig of def.triggers) {
        if (this.triggerMatches(trig, src, controller, ev)) this.pendingTriggers.push({ trig, perm: src, controller, event: ev });
      }
    }
    // Mobilize keyword
    if (ev.type === 'attacks') {
      const mk = ev.perm.def.keywords.find(k => k.startsWith('Mobilize'));
      if (mk) {
        const n = parseInt(mk.split(':')[1] ?? '1', 10) || 1;
        for (let i = 0; i < n; i++) {
          const t = this.makeToken('r_1_1_warrior', ev.perm.controller, { tapped: true, attacking: true });
          t.counters.SACATEND = 1;
        }
      }
    }
    if (!this.resolvingDepth) this.resolveTriggers();
  }

  private triggerMatches(trig: Trigger, src: Perm | CardInst, controller: number, ev: GEvent): boolean {
    const P = trig.params;
    const onBf = this.bf.includes(src as Perm);
    const tz = P.TriggerZones;
    if (tz && tz !== 'Battlefield') return false;
    const ctx: FilterCtx = { you: controller, sourceId: src.id, sourceAttachedTo: (src as Perm).attachedTo, chosenType: (src as Perm).chosenType };
    switch (trig.mode) {
      case 'ChangesZone': case 'ChangesZoneAll': {
        if (ev.type !== 'zone') return false;
        if (P.Origin && P.Origin !== 'Any' && !P.Origin.split(',').includes(ev.from)) return false;
        if (P.Destination && P.Destination !== 'Any' && !P.Destination.split(',').includes(ev.to)) return false;
        const vc = P.ValidCard ?? P.ValidCards;
        const subj = this.subjectOfSnapshot(ev.perm);
        if (vc && !matches(vc, subj, ctx)) return false;
        // non-self triggers require the source to be on the battlefield
        const isSelf = ev.perm.id === src.id;
        if (!isSelf && !onBf) return false;
        if (isSelf && ev.from === 'Battlefield' && onBf) return false;
        return true;
      }
      case 'SpellCast': {
        if (ev.type !== 'cast' || !onBf) return false;
        if (P.ValidCard && !matches(P.ValidCard, this.subjectOf(ev.card, ev.player), ctx)) return false;
        const vap = P.ValidActivatingPlayer;
        if (vap === 'You' && ev.player !== controller) return false;
        if (vap === 'Opponent' && ev.player === controller) return false;
        return true;
      }
      case 'Attacks': {
        if (ev.type !== 'attacks' || !onBf) return false;
        return !P.ValidCard || matches(P.ValidCard, this.subjectOf(ev.perm), ctx);
      }
      case 'AttackersDeclared': {
        if (ev.type !== 'attackersDeclared' || !onBf) return false;
        const ap = P.AttackingPlayer;
        if (ap === 'You' && ev.player !== controller) return false;
        if (ap === 'Opponent' && ev.player === controller) return false;
        return true;
      }
      case 'Blocks': {
        if (ev.type !== 'blocks' || !onBf) return false;
        return !P.ValidCard || matches(P.ValidCard, this.subjectOf(ev.perm), ctx);
      }
      case 'DamageDone': case 'DamageDoneOnce': {
        if (ev.type !== 'damage' || !onBf) return false;
        if (P.CombatDamage === 'True' && !ev.combat) return false;
        if (P.CombatDamage === 'False' && ev.combat) return false;
        if (P.ValidSource) {
          if (!ev.source) return false;
          if (!matches(P.ValidSource, this.subjectOfSnapshot(ev.source as Perm), ctx)) return false;
        }
        if (P.ValidTarget) {
          const t = ev.target.kind === 'player' ? this.playerSubject(ev.target.pid) : ev.target.kind === 'perm' ? this.subjectOf(ev.target.perm) : null;
          if (!t || !matches(P.ValidTarget, t, ctx)) return false;
        }
        return true;
      }
      case 'Phase': {
        if (ev.type !== 'phase' || !onBf) return false;
        const ph = (P.Phase ?? '').split(',');
        const map: Record<string, string> = { 'End of Turn': 'End of Turn', Upkeep: 'Upkeep', BeginCombat: 'BeginCombat', Main1: 'Main1', 'Main2': 'Main2', Draw: 'Upkeep' };
        if (!ph.some(x => map[x] === ev.phase)) return false;
        const vp = P.ValidPlayer;
        if (vp === 'You' && ev.player !== controller) return false;
        if (vp === 'Opponent' && ev.player === controller) return false;
        if (P.PlayerTurn === 'True' && ev.player !== controller) return false;
        return true;
      }
      case 'LifeGained': {
        if (ev.type !== 'lifeGained' || !onBf) return false;
        if (P.ValidPlayer === 'You' && ev.player !== controller) return false;
        if (P.ValidPlayer === 'Opponent' && ev.player === controller) return false;
        return true;
      }
      case 'Drawn': {
        if (ev.type !== 'drawn' || !onBf) return false;
        if (P.ValidCard && /YouOwn|YouCtrl/.test(P.ValidCard) && ev.player !== controller) return false;
        if (P.Number && +P.Number !== ev.nth) return false;
        return true;
      }
      case 'Sacrificed': {
        if (ev.type !== 'sacrificed' || !onBf) return false;
        return !P.ValidCard || matches(P.ValidCard, this.subjectOfSnapshot(ev.perm), ctx);
      }
    }
    return false;
  }

  private subjectOfSnapshot(perm: Perm): Subject {
    if (this.bf.includes(perm)) return this.subjectOf(perm);
    return { kind: 'card', def: perm.def, controller: perm.controller ?? perm.owner, owner: perm.owner, token: perm.token, id: perm.id,
      power: perm.def.power, toughness: perm.def.toughness, keywords: perm.def.keywords };
  }

  resolveTriggers() {
    if (this.resolvingDepth > 6) { this.pendingTriggers = []; return; }
    this.resolvingDepth++;
    let guard = 0;
    while (this.pendingTriggers.length && !this.over && guard++ < 200) {
      const t = this.pendingTriggers.shift()!;
      if (!t.trig.effect) continue;
      const ev = t.event;
      const triggered: Ctx['triggered'] = {};
      if (ev.type === 'zone') triggered.perm = ev.perm;
      if (ev.type === 'attacks' || ev.type === 'blocks' || ev.type === 'sacrificed') triggered.perm = ev.perm;
      if (ev.type === 'cast') { triggered.perm = ev.card; triggered.player = ev.player; }
      if (ev.type === 'damage') { triggered.perm = ev.source; triggered.amount = ev.amount; triggered.player = ev.target.kind === 'player' ? ev.target.pid : undefined; if (ev.target.kind === 'perm') triggered.target = ev.target.perm; }
      if (ev.type === 'lifeGained') { triggered.player = ev.player; triggered.amount = ev.amount; }
      if (ev.type === 'drawn' || ev.type === 'phase' || ev.type === 'discard') triggered.player = ev.player;
      const src = this.bf.includes(t.perm as Perm) ? (t.perm as Perm) : undefined;
      const tc = t.trig.effect.params.Cost;
      if (tc) {
        // "you may pay {2}. If you do, ..." - pay when affordable, otherwise skip the effect
        const c = parseCost(tc);
        if (!c.supported || c.tap || c.sacSelf || !this.payMana(t.controller, c.mana.generic, c.mana.pips, true)) continue;
        if (c.payLife) this.loseLife(t.controller, c.payLife);
      }
      this.resolveEffect(t.trig.effect, { p: t.controller, source: src ?? (t.perm as Perm), x: 0, kicked: false, targets: [], triggered });
      this.checkSBA();
    }
    this.resolvingDepth--;
    if (this.resolvingDepth === 0) this.pendingTriggers = this.pendingTriggers.filter(() => false);
  }

  // ------------------------------------------------------------------ tokens
  makeToken(script: string, controller: number, opts: { tapped?: boolean; attacking?: boolean } = {}): Perm {
    const def = loadToken(script);
    const inst: CardInst = { id: this.nextId++, def, owner: controller, token: true };
    const perm = this.enter(inst, controller, { tapped: opts.tapped, token: true, attacking: opts.attacking });
    if (this.phase === 'combat' && opts.attacking) perm.attacking = true;
    return perm;
  }

  // ------------------------------------------------------------------ effects
  resolveEffect(eff: Effect, ctx: Ctx, depth = 0): void {
    if (this.over || depth > 10) return;
    const P = eff.params;
    const def = ctx.source?.def ?? ctx.card?.def;
    // conditions we can evaluate cheaply
    if (P.ConditionCheckSVar && def) {
      const v = this.amount(P.ConditionCheckSVar, ctx, def);
      const cmpS = P.ConditionSVarCompare ?? 'GE1';
      const m = cmpS.match(/^(LE|GE|LT|GT|EQ|NE)(-?\d+|\w+)$/);
      if (m) {
        const rhs = /^-?\d+$/.test(m[2]) ? +m[2] : this.amount(m[2], ctx, def);
        const ok = { LE: v <= rhs, GE: v >= rhs, LT: v < rhs, GT: v > rhs, EQ: v === rhs, NE: v !== rhs }[m[1] as 'LE'];
        if (!ok) { if (eff.sub) this.resolveEffect(eff.sub, ctx, depth + 1); return; }
      }
    }
    if (P.OptionalDecider && !AI.optionalYes(this, eff, ctx)) { if (eff.sub) this.resolveEffect(eff.sub, ctx, depth + 1); return; }
    let targets: Target[] = [];
    const needsTargets = P.ValidTgts !== undefined || P.TargetType !== undefined;
    if (needsTargets) {
      if (ctx.preset) targets = ctx.preset.filter(t => this.isLegalTarget(t, eff, ctx));
      else {
        targets = AI.chooseTargets(this, eff, ctx);
        if (this.opts.trace && targets.length) this.trace(`  ${def?.name ?? eff.api} (${eff.api}) -> ${targets.map(t => this.describe(t)).join(', ')}`, ctx.p);
      }
      const min = P.TargetMin !== undefined ? this.amount(P.TargetMin, ctx, def) : 1;
      if (targets.length < min && eff.api !== 'Charm') { if (eff.sub && !P.SubAbility?.startsWith('DB')) this.resolveEffect(eff.sub, { ...ctx, preset: undefined }, depth + 1); return; }
      // ward
      for (const t of targets) {
        if (t.kind === 'perm' && t.perm.controller !== ctx.p) {
          const wk = t.perm.def.keywords.find(k => k.startsWith('Ward:'));
          if (wk) {
            if (!this.payWard(ctx.p, wk.slice(5))) { this.trace(`ward counters ${def?.name}`, ctx.p); return; }
          }
        }
      }
    }
    const sub: Ctx = { ...ctx, preset: undefined, targets: needsTargets ? targets : ctx.targets };
    const defined = (key = 'Defined') => this.defined(P[key], sub);
    switch (eff.api) {
      case 'DealDamage': {
        const n = this.amount(P.NumDmg, sub, def);
        const tg = needsTargets ? targets : defined().length ? defined() : [];
        const src = ctx.source && P.DamageSource === undefined ? ctx.source : ctx.card;
        for (const t of tg) this.dealDamage(src, ctx.p, t, n, false);
        break;
      }
      case 'DamageAll': {
        const n = this.amount(P.NumDmg, sub, def);
        if (P.ValidCards) for (const x of this.bf.filter(x => matches(P.ValidCards, this.subjectOf(x), { you: ctx.p, sourceId: ctx.source?.id }))) this.dealDamage(ctx.source ?? ctx.card, ctx.p, { kind: 'perm', perm: x }, n, false);
        if (P.ValidPlayers) for (const pl of this.players) if (matches(P.ValidPlayers, this.playerSubject(pl.id), { you: ctx.p })) this.dealDamage(ctx.source ?? ctx.card, ctx.p, { kind: 'player', pid: pl.id }, n, false);
        break;
      }
      case 'Destroy': {
        for (const t of needsTargets ? targets : defined()) if (t.kind === 'perm') this.destroy(t.perm);
        break;
      }
      case 'DestroyAll': {
        const f = P.ValidCards ?? 'Creature';
        for (const x of this.bf.filter(x => matches(f, this.subjectOf(x), { you: ctx.p, sourceId: ctx.source?.id }))) this.destroy(x);
        break;
      }
      case 'ChangeZone': this.changeZone(eff, sub, needsTargets ? targets : defined()); break;
      case 'ChangeZoneAll': {
        if (P.Origin === 'Battlefield' && P.ChangeType) {
          for (const x of this.bf.filter(x => matches(P.ChangeType, this.subjectOf(x), { you: ctx.p, sourceId: ctx.source?.id })))
            this.leave(x, P.Destination === 'Exile' ? 'exile' : P.Destination === 'Hand' ? 'hand' : 'graveyard');
        }
        break;
      }
      case 'Draw': {
        const n = this.amount(P.NumCards ?? '1', sub, def);
        for (const t of needsTargets ? targets : (P.Defined ? defined() : [{ kind: 'player', pid: ctx.p } as Target]))
          if (t.kind === 'player') this.draw(t.pid, n);
        break;
      }
      case 'Discard': {
        const n = this.amount(P.NumCards ?? '1', sub, def);
        const who = needsTargets ? targets : (P.Defined ? defined() : [{ kind: 'player', pid: ctx.p } as Target]);
        for (const t of who) {
          if (t.kind !== 'player') continue;
          const pl = this.players[t.pid];
          for (let i = 0; i < n && pl.hand.length; i++) {
            let c: CardInst;
            if (P.Mode === 'Hand') { [...pl.hand].forEach(h => this.discard(pl, h)); break; }
            if (P.Mode === 'Random') c = pl.hand[this.rng.int(pl.hand.length)];
            else if (t.pid !== ctx.p && (P.Mode === 'RevealYouChoose' || P.Mode === 'TgtChoose')) c = AI.bestCardInHand(this, pl);
            else c = AI.chooseDiscard(this, pl);
            this.discard(pl, c);
          }
        }
        break;
      }
      case 'Token': {
        const n = this.amount(P.TokenAmount ?? '1', sub, def);
        const owner = P.TokenOwner && P.TokenOwner !== 'You' ? (defined('TokenOwner')[0] as { pid: number } | undefined)?.pid ?? ctx.p : ctx.p;
        for (const script of (P.TokenScript ?? '').split(',')) {
          for (let i = 0; i < Math.min(n, 30); i++) {
            const doubled = this.bf.some(x => x.controller === owner && /it creates twice that many of those tokens instead|twice that many of those tokens are created instead/i.test(x.def.oracle)) ? 2 : 1;
            for (let k = 0; k < doubled; k++) {
              const t = this.makeToken(script.trim(), owner, { tapped: P.TokenTapped === 'True', attacking: P.TokenAttacking !== undefined && this.phase === 'combat' });
              if (P.PumpKeywords) t.tempKw.push(...P.PumpKeywords.split(' & '));
              if (P.AtEOT) t.counters.SACATEND = 1;   // sacrifice/exile it at end of turn (or combat)
            }
          }
        }
        break;
      }
      case 'Pump': {
        const a = this.amount(P.NumAtt, sub, def), d = this.amount(P.NumDef, sub, def);
        const tg = needsTargets ? targets : defined();
        for (const t of tg) if (t.kind === 'perm' && this.bf.includes(t.perm)) {
          t.perm.tempP += a; t.perm.tempT += d;
          if (P.KW) t.perm.tempKw.push(...P.KW.split(' & '));
        }
        break;
      }
      case 'PumpAll': {
        const a = this.amount(P.NumAtt, sub, def), d = this.amount(P.NumDef, sub, def);
        for (const x of this.bf.filter(x => matches(P.ValidCards ?? 'Creature.YouCtrl', this.subjectOf(x), { you: ctx.p, sourceId: ctx.source?.id }))) {
          x.tempP += a; x.tempT += d; if (P.KW) x.tempKw.push(...P.KW.split(' & '));
        }
        break;
      }
      case 'PutCounter': {
        const n = this.amount(P.CounterNum ?? '1', sub, def);
        const type = P.CounterType ?? 'P1P1';
        const tg = needsTargets ? targets : defined();
        for (const t of tg) if (t.kind === 'perm' && this.bf.includes(t.perm)) this.addCounters(t.perm, type, n);
        break;
      }
      case 'PutCounterAll': {
        const n = this.amount(P.CounterNum ?? '1', sub, def);
        for (const x of this.bf.filter(x => matches(P.ValidCards ?? 'Creature.YouCtrl', this.subjectOf(x), { you: ctx.p, sourceId: ctx.source?.id }))) this.addCounters(x, P.CounterType ?? 'P1P1', n);
        break;
      }
      case 'Endure': {
        const n = this.amount(P.Num ?? P.Amount ?? '1', sub, def);
        const tg = defined().length ? defined() : ctx.source ? [{ kind: 'perm', perm: ctx.source } as Target] : [];
        for (const t of tg) if (t.kind === 'perm' && this.bf.includes(t.perm)) this.addCounters(t.perm, 'P1P1', n);
        break;
      }
      case 'Counter': {
        for (const t of targets) if (t.kind === 'spell' && !t.item.countered) {
          if (cantBeCountered(t.item.card.def)) { this.trace(`${t.item.card.def.name} can't be countered`, ctx.p); continue; }
          const unless = P.UnlessCost ? parseInt(P.UnlessCost, 10) : 0;
          if (unless && this.payMana(t.item.controller, unless, [], true)) { this.trace(`pays ${unless} to avoid counter`); continue; }
          t.item.countered = true;
        }
        break;
      }
      case 'GainLife': {
        const n = this.amount(P.LifeAmount, sub, def);
        const who = P.Defined ? defined() : [{ kind: 'player', pid: ctx.p } as Target];
        for (const t of who) if (t.kind === 'player') this.gainLife(t.pid, n);
        break;
      }
      case 'LoseLife': {
        const n = this.amount(P.LifeAmount, sub, def);
        const who = needsTargets ? targets : defined();
        for (const t of who) if (t.kind === 'player') { this.loseLife(t.pid, n); if (t.pid !== ctx.p) this.stats.damage[ctx.p] += n; }
        break;
      }
      case 'Scry': case 'Surveil': {
        const n = this.amount(P.ScryNum ?? P.Amount ?? '1', sub, def);
        AI.scry(this, this.players[ctx.p], n, eff.api === 'Surveil');
        break;
      }
      case 'Mill': {
        const n = this.amount(P.NumCards ?? '1', sub, def);
        const who = needsTargets ? targets : (P.Defined ? defined() : [{ kind: 'player', pid: ctx.p } as Target]);
        for (const t of who) if (t.kind === 'player') { const pl = this.players[t.pid]; for (let i = 0; i < n && pl.library.length; i++) pl.graveyard.push(pl.library.pop()!); }
        break;
      }
      case 'Sacrifice': {
        const n = this.amount(P.Amount ?? '1', sub, def);
        const filter = P.SacValid ?? 'Creature';
        const who = P.Defined ? defined() : [{ kind: 'player', pid: ctx.p } as Target];
        if (P.Defined === 'Self' && ctx.source) { this.leave(ctx.source, 'graveyard', { sacrificed: true }); break; }
        for (const t of who) if (t.kind === 'player') for (let i = 0; i < n; i++) {
          const opts = this.bf.filter(x => x.controller === t.pid && matches(filter, this.subjectOf(x), { you: t.pid }));
          if (!opts.length) break;
          const worst = AI.worstPermanent(this, opts);
          this.leave(worst, 'graveyard', { sacrificed: true });
        }
        break;
      }
      case 'Fight': {
        const mine = defined().find(t => t.kind === 'perm') ?? ctx.targets.find(t => t.kind === 'perm' && t.perm.controller === ctx.p);
        const theirs = targets.find(t => t.kind === 'perm' && t.perm.controller !== ctx.p) ?? targets[1];
        if (mine?.kind === 'perm' && theirs?.kind === 'perm' && this.bf.includes(mine.perm) && this.bf.includes(theirs.perm)) {
          const a = this.statsOf(mine.perm).power, b = this.statsOf(theirs.perm).power;
          this.dealDamage(mine.perm, ctx.p, { kind: 'perm', perm: theirs.perm }, a, false);
          this.dealDamage(theirs.perm, theirs.perm.controller, { kind: 'perm', perm: mine.perm }, b, false);
        }
        break;
      }
      case 'Tap': for (const t of needsTargets ? targets : defined()) if (t.kind === 'perm') t.perm.tapped = true; break;
      case 'TapAll': for (const x of this.bf.filter(x => matches(P.ValidCards ?? 'Creature.OppCtrl', this.subjectOf(x), { you: ctx.p }))) x.tapped = true; break;
      case 'Untap': for (const t of needsTargets ? targets : defined()) if (t.kind === 'perm') t.perm.tapped = false; break;
      case 'UntapAll': for (const x of this.bf.filter(x => matches(P.ValidCards ?? 'Land.YouCtrl', this.subjectOf(x), { you: ctx.p }))) x.tapped = false; break;
      case 'Attach': {
        const host = (needsTargets ? targets : defined()).find(t => t.kind === 'perm');
        if (host?.kind === 'perm' && ctx.source && this.bf.includes(ctx.source)) ctx.source.attachedTo = host.perm.id;
        break;
      }
      case 'Charm': {
        const choice = AI.chooseCharm(this, eff, ctx);
        const n = P.CharmNum ? this.amount(P.CharmNum, ctx, def) : 1;
        const picks = choice.slice(0, Math.max(1, n));
        for (const c of picks) this.resolveEffect(c, { ...ctx, preset: undefined, targets: [] }, depth + 1);
        break;
      }
      case 'Dig': {
        const n = this.amount(P.DigNum ?? '1', sub, def);
        const take = P.ChangeNum === 'All' ? n : this.amount(P.ChangeNum ?? '1', sub, def);
        const pl = this.players[ctx.p];
        const top = pl.library.splice(Math.max(0, pl.library.length - n), n);
        const filter = P.ChangeValid;
        const ok = top.filter(c => !filter || matches(filter, this.subjectOf(c, ctx.p), { you: ctx.p }));
        ok.sort((a, b) => AI.cardValue(this, pl, b) - AI.cardValue(this, pl, a));
        const chosen = ok.slice(0, take);
        for (const c of top) {
          if (chosen.includes(c)) {
            if (P.DestinationZone === 'Battlefield') this.enter(c, ctx.p, {});
            else if (P.DestinationZone === 'Exile') pl.hand.push(c);    // "may play" exile effects ~ drawing
            else pl.hand.push(c);
          } else if (P.DestinationZone2 === 'Graveyard') pl.graveyard.push(c);
          else pl.library.unshift(c);
        }
        break;
      }
      case 'SetState': {
        const perm = ctx.source;
        if (perm && this.bf.includes(perm) && perm.def.back && P.Mode === 'Transform') {
          (perm as Perm & { frontDef?: CardDef }).frontDef = perm.def;
          perm.def = perm.def.back; perm.transformed = true;
          this.trace(`transforms into ${perm.def.name}`);
        }
        break;
      }
      case 'Explore': {
        const perm = ctx.source;
        const pl = this.players[ctx.p];
        const top = pl.library.pop();
        if (top) {
          if (top.def.types.includes('Land')) pl.hand.push(top);
          else { if (perm) this.addCounters(perm, 'P1P1', 1); pl.library.push(top); }
        }
        break;
      }
      case 'Investigate': {
        const n = this.amount(P.Num ?? '1', sub, def);
        for (let i = 0; i < n; i++) this.makeToken('c_a_clue_draw', ctx.p);
        break;
      }
      case 'Amass': {
        const n = this.amount(P.Num ?? '1', sub, def);
        let army = this.bf.find(x => x.controller === ctx.p && x.def.subtypes.includes('Army'));
        if (!army) army = this.makeToken('b_0_0_zombie_army', ctx.p);
        this.addCounters(army, 'P1P1', n);
        break;
      }
      case 'Connive': {
        const pl = this.players[ctx.p];
        this.draw(ctx.p, 1);
        const c = AI.chooseDiscard(this, pl);
        if (c) { this.discard(pl, c); if (!c.def.types.includes('Land') && ctx.source && this.bf.includes(ctx.source)) this.addCounters(ctx.source, 'P1P1', 1); }
        break;
      }
      case 'Earthbend': {
        const n = this.amount(P.Num ?? '1', sub, def);
        const t = this.makeToken('c_0_0_a_elemental', ctx.p);
        this.addCounters(t, 'P1P1', n); t.sick = false;
        break;
      }
      default: break; // unsupported / ignored effects are reported by the coverage tool
    }
    if (eff.sub && !this.over) this.resolveEffect(eff.sub, sub, depth + 1);
  }

  addCounters(perm: Perm, type: string, n: number) {
    if (n <= 0) return;
    let amt = n;
    if (this.bf.some(x => x.controller === perm.controller && /it puts twice that many of those counters on that permanent instead/i.test(x.def.oracle))) amt *= 2;
    // +1/+1 and -1/-1 counters annihilate
    if (type === 'P1P1' && perm.counters.M1M1) { const k = Math.min(amt, perm.counters.M1M1); perm.counters.M1M1 -= k; amt -= k; }
    if (type === 'M1M1' && perm.counters.P1P1) { const k = Math.min(amt, perm.counters.P1P1); perm.counters.P1P1 -= k; amt -= k; }
    perm.counters[type] = (perm.counters[type] ?? 0) + amt;
  }

  defined(d: string | undefined, ctx: Ctx): Target[] {
    if (!d) return [];
    const out: Target[] = [];
    for (const part of d.split(' & ')) {
      switch (part) {
        case 'Self': case 'Card.Self': if (ctx.source && this.bf.includes(ctx.source)) out.push({ kind: 'perm', perm: ctx.source }); break;
        case 'You': out.push({ kind: 'player', pid: ctx.p }); break;
        case 'Opponent': case 'Player.Opponent': out.push({ kind: 'player', pid: this.opp(ctx.p) }); break;
        case 'Player': out.push({ kind: 'player', pid: 0 }, { kind: 'player', pid: 1 }); break;
        case 'Targeted': case 'ParentTarget': case 'TargetedCard': out.push(...ctx.targets); break;
        case 'TargetedPlayer': out.push(...ctx.targets.filter(t => t.kind === 'player')); break;
        case 'TargetedController': case 'TargetedOwner': for (const t of ctx.targets) if (t.kind === 'perm') out.push({ kind: 'player', pid: t.perm.controller }); break;
        case 'TriggeredCard': case 'TriggeredCardLKICopy': case 'TriggeredAttacker': {
          const tp = ctx.triggered?.perm as Perm | undefined;
          if (tp && this.bf.includes(tp)) out.push({ kind: 'perm', perm: tp });
          break;
        }
        case 'TriggeredTarget': if (ctx.triggered?.target) out.push({ kind: 'perm', perm: ctx.triggered.target }); else if (ctx.triggered?.player !== undefined) out.push({ kind: 'player', pid: ctx.triggered.player }); break;
        case 'TriggeredCardController': case 'TriggeredSourceController': {
          const tp = ctx.triggered?.perm as Perm | undefined;
          if (tp) out.push({ kind: 'player', pid: (tp as Perm).controller ?? tp.owner });
          break;
        }
        case 'TriggeredPlayer': if (ctx.triggered?.player !== undefined) out.push({ kind: 'player', pid: ctx.triggered.player }); break;
        case 'Enchanted': case 'Equipped': case 'Attached': {
          const host = this.bf.find(x => x.id === ctx.source?.attachedTo);
          if (host) out.push({ kind: 'perm', perm: host });
          break;
        }
        default:
          if (part.startsWith('Valid ')) {
            const f = part.slice(6);
            for (const x of this.bf) if (matches(f, this.subjectOf(x), { you: ctx.p, sourceId: ctx.source?.id })) out.push({ kind: 'perm', perm: x });
          }
      }
    }
    return out;
  }

  private changeZone(eff: Effect, ctx: Ctx, tg: Target[]) {
    const P = eff.params;
    const origin = P.Origin ?? 'Battlefield';
    const dest = P.Destination ?? 'Hand';
    const pl = this.players[ctx.p];
    const destKey = dest === 'Exile' ? 'exile' : dest === 'Hand' ? 'hand' : dest === 'Graveyard' ? 'graveyard' : dest === 'Library' ? (P.LibraryPosition === '-1' ? 'librarybottom' : 'library') : 'battlefield';
    if (origin.includes('Battlefield') && tg.length) {
      for (const t of tg) {
        if (t.kind !== 'perm' || !this.bf.includes(t.perm)) continue;
        if (destKey === 'battlefield') { // blink
          const perm = t.perm; this.leave(perm, 'exile');
          const owner = this.players[perm.owner]; const card = owner.exile.find(c => c.id === perm.id);
          if (card) { owner.exile.splice(owner.exile.indexOf(card), 1); this.enter(card, perm.owner, {}); }
          continue;
        }
        const perm = t.perm;
        this.leave(perm, destKey as 'exile');
        if (destKey === 'exile' && P.Duration === 'UntilHostLeavesPlay' && ctx.source && this.bf.includes(ctx.source) && !perm.token) {
          const owner = this.players[perm.owner];
          const card = owner.exile.find(c => c.id === perm.id);
          if (card) ctx.source.exiledUntilLeaves.push(card);
        }
      }
      return;
    }
    if (origin.includes('Library') && !tg.length) {
      const n = P.ChangeNum ? Math.max(1, this.amount(P.ChangeNum, ctx)) : 1;
      const type = (P.ChangeType ?? 'Card').replace('.IsRemembered', '');
      for (let i = 0; i < n; i++) {
        const opts = pl.library.filter(c => matches(type, this.subjectOf(c, ctx.p), { you: ctx.p }));
        if (!opts.length) break;
        const c = AI.chooseSearch(this, pl, opts, dest);
        pl.library.splice(pl.library.indexOf(c), 1);
        if (destKey === 'battlefield') this.enter(c, ctx.p, { tapped: P.Tapped === 'True' });
        else if (destKey === 'hand') pl.hand.push(c);
        else if (destKey === 'library') pl.library.push(c);
        else pl.graveyard.push(c);
      }
      this.rng.shuffle(pl.library);
      return;
    }
    if (origin.includes('Graveyard') || origin.includes('Hand') || origin.includes('Exile')) {
      for (const t of tg) {
        if (t.kind !== 'card') continue;
        const owner = this.players[t.card.owner];
        const zone = t.zone === 'graveyard' ? owner.graveyard : owner.hand;
        const i = zone.indexOf(t.card);
        if (i < 0) continue;
        zone.splice(i, 1);
        if (destKey === 'battlefield') this.enter(t.card, ctx.p, { tapped: P.Tapped === 'True' });
        else if (destKey === 'hand') owner.hand.push(t.card);
        else if (destKey === 'exile') owner.exile.push(t.card);
        else owner.library.unshift(t.card);
      }
      if (!tg.length && origin.includes('Hand') && destKey === 'battlefield') {
        const type = P.ChangeType ?? 'Permanent';
        const opts = pl.hand.filter(c => matches(type, this.subjectOf(c, ctx.p), { you: ctx.p }));
        if (opts.length) { const c = AI.chooseSearch(this, pl, opts, 'Battlefield'); pl.hand.splice(pl.hand.indexOf(c), 1); this.enter(c, ctx.p, {}); }
      }
    }
  }

  // ------------------------------------------------------------------ combat
  combat() {
    const ap = this.active, dp = this.opp(ap);
    const attackers = AI.chooseAttackers(this, this.players[ap]);
    if (!attackers.length) return;
    this.players[ap].attackedThisTurn = true;
    for (const a of attackers) {
      a.attacking = true;
      if (!this.has(a, 'Vigilance')) a.tapped = true;
    }
    this.trace(`attacks with ${attackers.map(a => a.def.name).join(', ')}`);
    this.emit({ type: 'attackersDeclared', player: ap, attackers });
    for (const a of attackers) { if (this.bf.includes(a)) this.emit({ type: 'attacks', perm: a }); }
    if (this.over) return;
    // tokens created attacking join the attack
    const allAttackers = this.bf.filter(x => x.attacking && x.controller === ap);
    // defender may use instant-speed removal on attackers
    AI.duringAttack(this, this.players[dp], allAttackers);
    const live = allAttackers.filter(a => this.bf.includes(a));
    const blocks = AI.chooseBlocks(this, this.players[dp], live);   // Map attacker -> blockers
    for (const [, bs] of blocks) for (const b of bs) { b.blocking = true; this.emit({ type: 'blocks', perm: b }); }
    if (this.opts.trace && blocks.size) this.trace(`  blocks: ${[...blocks].map(([a, bs]) => `${bs.map(b => b.def.name).join('+')} on ${a.def.name}`).join('; ')}`);
    AI.combatTricks(this, this.players[ap], this.players[dp], live, blocks);
    this.combatDamage(live, blocks, true);
    if (!this.over) this.combatDamage(live, blocks, false);
    this.checkSBA();
  }

  private combatDamage(attackers: Perm[], blocks: Map<Perm, Perm[]>, firstStrikeStep: boolean) {
    const ap = this.active, dp = this.opp(ap);
    const strikesNow = (p: Perm) => {
      const k = this.statsOf(p).keywords;
      const fs = k.includes('First Strike') || k.includes('Double Strike');
      return firstStrikeStep ? fs : (!k.includes('First Strike') || k.includes('Double Strike'));
    };
    const anyFirst = [...attackers, ...[...blocks.values()].flat()].some(p => { const k = this.statsOf(p).keywords; return k.includes('First Strike') || k.includes('Double Strike'); });
    if (firstStrikeStep && !anyFirst) return;
    const dmgEvents: [Perm, Target, number][] = [];
    for (const a of attackers) {
      if (!this.bf.includes(a)) continue;
      const bs = (blocks.get(a) ?? []).filter(b => this.bf.includes(b));
      if (strikesNow(a)) {
        let power = this.statsOf(a).power;
        if (power > 0) {
          if (!blocks.has(a) || (blocks.get(a)!.length === 0)) dmgEvents.push([a, { kind: 'player', pid: dp }, power]);
          else if (bs.length) {
            const dt = this.has(a, 'Deathtouch');
            for (const b of bs) {
              const st = this.statsOf(b);
              const lethal = dt ? 1 : Math.max(0, st.toughness - b.damage);
              const give = Math.min(power, lethal);
              if (give > 0) dmgEvents.push([a, { kind: 'perm', perm: b }, give]);
              power -= give;
              if (power <= 0) break;
            }
            if (power > 0) {
              if (this.has(a, 'Trample')) dmgEvents.push([a, { kind: 'player', pid: dp }, power]);
              else if (bs.length) dmgEvents.push([a, { kind: 'perm', perm: bs[0] }, power]);
            }
          } else if (this.has(a, 'Trample')) dmgEvents.push([a, { kind: 'player', pid: dp }, power]);
        }
      }
      for (const b of bs) if (strikesNow(b)) {
        const p = this.statsOf(b).power;
        if (p > 0) dmgEvents.push([b, { kind: 'perm', perm: a }, p]);
      }
    }
    for (const [src, t, n] of dmgEvents) {
      if (this.over) return;
      if (t.kind === 'perm' && !this.bf.includes(t.perm)) continue;
      this.dealDamage(src, src.controller, t, n, true);
    }
    this.checkSBA();
  }
}

export type GEvent =
  | { type: 'zone'; perm: Perm; from: string; to: string }
  | { type: 'cast'; player: number; card: CardInst; item: StackItem }
  | { type: 'attacks'; perm: Perm }
  | { type: 'attackersDeclared'; player: number; attackers: Perm[] }
  | { type: 'blocks'; perm: Perm }
  | { type: 'damage'; source?: Perm; controller: number; target: Target; amount: number; combat: boolean }
  | { type: 'phase'; phase: string; player: number }
  | { type: 'lifeGained'; player: number; amount: number }
  | { type: 'drawn'; player: number; nth: number; card: CardInst }
  | { type: 'discard'; player: number; card: CardInst }
  | { type: 'sacrificed'; perm: Perm };

export type { Ability };
