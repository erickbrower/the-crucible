// Impulse draw: "exile the top card of your library. You may play it this turn."
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { loadCard } from '../src/cards/compile.js';
import { d, setup, card, log } from './helpers.js';

d('impulse draw', () => {
  it('exiles the card and lets you play it only until the end of the turn', () => {
    // Expressive Iteration: one card to hand, one to the bottom, one exiled that you may play this turn
    const g = setup({ hand: ['Expressive Iteration'], bf: ['Island', 'Mountain'], library: ['Shock', 'Opt', 'Plains'] });
    const p = g.players[0];
    expect(g.castSpell(0, card(g, 0, 'Expressive Iteration'))).toBe(true);
    expect(p.exile.length).toBe(1);
    const exiled = p.exile[0];
    expect(p.mayPlay?.map(m => m.card)).toEqual([exiled]);
    expect(g.playableFromExile(0, exiled)).toBeTruthy();
    expect(log(g)).toMatch(/may play .* from exile this turn/);

    g.cleanup();
    expect(p.exile).toContain(exiled);                  // still exiled ...
    expect(g.playableFromExile(0, exiled)).toBeUndefined();   // ... but no longer playable
  });

  it('plays an exiled land as the land drop and casts exiled spells', () => {
    const g = setup({ bf: ['Mountain'] });
    const p = g.players[0];
    const land = { id: g.nextId++, def: loadCard('Mountain'), owner: 0 };
    const spell = { id: g.nextId++, def: loadCard('Shock'), owner: 0 };
    p.exile.push(land, spell);
    p.mayPlay = [{ card: land, untilSeq: g.turnSeq }, { card: spell, untilSeq: g.turnSeq }];
    AI.mainPhase(g, p, 1);
    expect(p.landsPlayed).toBe(1);
    expect(p.exile).not.toContain(land);
    expect(log(g)).toMatch(/casts Shock from exile/);
  });

  it('exiles two, chooses the better one, and may play only that one (Fireglass Mentor)', () => {
    const g = setup({ bf: ['Fireglass Mentor', 'Mountain', 'Mountain', 'Swamp', 'Swamp', 'Mountain'], library: ['Plains', 'Lightning Strike'] });
    const p = g.players[0];
    const mentor = g.bf.find(x => x.def.name === 'Fireglass Mentor')!;
    g.resolveEffect(mentor.def.triggers[0].effect!, { p: 0, source: mentor, x: 0, kicked: false, targets: [] });
    expect(p.exile.map(c => c.def.name).sort()).toEqual(['Lightning Strike', 'Plains']);
    expect(p.mayPlay?.map(m => m.card.def.name)).toEqual(['Lightning Strike']);
    expect(log(g)).toMatch(/chooses Lightning Strike/);
  });

  it('turns durations into the turn the permission ends', () => {
    const g = setup({});
    g.turnSeq = 4; g.active = 0;
    expect(g.durationEnd(undefined, 0)).toBe(4);                        // this turn
    expect(g.durationEnd('UntilTheEndOfYourNextTurn', 0)).toBe(6);      // my next turn
    expect(g.durationEnd('UntilTheEndOfYourNextTurn', 1)).toBe(5);      // granted on the opponent's turn
    expect(g.durationEnd('Permanent', 0)).toBe(Infinity);
  });

  it('reports impulse draw cards as fully modeled', () => {
    const notes = loadCard('Expressive Iteration').notes;
    expect(notes.filter(n => /effect/i.test(n))).toEqual([]);
  });
});
