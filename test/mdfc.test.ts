// Modal double-faced cards whose other face is a land.
import { it, expect } from 'vitest';
import * as AI from '../src/ai/policy.js';
import { loadCard } from '../src/cards/compile.js';
import { d, setup, log } from './helpers.js';

d('modal double-faced lands', () => {
  it('plays a spell-front MDFC as its land when there is no other land', () => {
    const g = setup({ hand: ["Agadeem's Awakening"], bf: ['Swamp'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(g.players[0].landsPlayed).toBe(1);
    expect(g.bf.some(x => x.def.name === 'Agadeem, the Undercrypt')).toBe(true);
    expect(log(g)).toMatch(/plays Agadeem, the Undercrypt \(back face\)/);
  });

  it('keeps the spell when a real land is available', () => {
    const g = setup({ hand: ["Agadeem's Awakening", 'Swamp'], bf: ['Swamp'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(g.bf.filter(x => x.def.name === 'Swamp').length).toBe(2);
    expect(g.players[0].hand.some(c => c.def.name === "Agadeem's Awakening")).toBe(true);
  });

  it('plays a pathway as the color it needs', () => {
    // Clearwater Pathway: Island (U) front, Murkwater Pathway (B) back; the hand needs black
    const g = setup({ hand: ['Clearwater Pathway', 'Duress'], bf: ['Island'] });
    AI.mainPhase(g, g.players[0], 1);
    expect(g.bf.some(x => x.def.name === 'Murkwater Pathway')).toBe(true);
  });

  it('counts land backs when deciding to keep a hand', () => {
    const g = setup({ hand: ["Agadeem's Awakening", 'Swamp', 'Duress', 'Duress', 'Duress', 'Duress', 'Duress'] });
    expect(AI.keepHand(g, g.players[0], 7)).toBe(true);
    expect(loadCard("Agadeem's Awakening").notes).not.toContain('modal back face not playable');
  });
});
