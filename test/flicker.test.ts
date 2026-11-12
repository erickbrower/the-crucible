// Flicker: exile your own creature and bring it back, re-running its enters-the-battlefield trigger.
import { it, expect } from 'vitest';
import { d, setup, card, perm, onBf, log } from './helpers.js';

const handSize = (g: ReturnType<typeof setup>) => g.players[0].hand.length;

d('flicker', () => {
  it('Daydream returns the creature right away with a +1/+1 counter and re-triggers its ETB', () => {
    const g = setup({ hand: ['Daydream'], bf: ['Helpful Hunter', 'Plains'], library: ['Plains', 'Plains'] });
    const before = handSize(g);
    g.castSpell(0, card(g, 0, 'Daydream'));
    expect(onBf(g, 0, 'Helpful Hunter')).toBe(true);
    expect(perm(g, 0, 'Helpful Hunter').counters.P1P1).toBe(1);
    expect(handSize(g)).toBe(before);   // -Daydream, +1 card from the Hunter
  });

  it('Kykar flickers a creature with a valuable ETB instead of making a Spirit, and it comes back at end step', () => {
    const g = setup({ hand: ['Opt'], bf: ['Kykar, Zephyr Awakener', 'Cloudblazer', 'Island'], library: Array(10).fill('Plains') });
    const before = handSize(g);
    g.castSpell(0, card(g, 0, 'Opt'));
    expect(onBf(g, 0, 'Cloudblazer')).toBe(false);                    // exiled until the end step
    expect(g.bf.filter(x => x.token).length).toBe(0);                  // no Spirit
    g.emit({ type: 'phase', phase: 'End of Turn', player: 0 });
    expect(onBf(g, 0, 'Cloudblazer')).toBe(true);
    expect(handSize(g)).toBe(before - 1 + 1 + 2);                        // -Opt, +Opt's draw, +2 from Cloudblazer
    expect(log(g)).toMatch(/Cloudblazer/);
  });

  it('Kykar makes a Spirit when no creature has an ETB worth repeating', () => {
    const g = setup({ hand: ['Opt'], bf: ['Kykar, Zephyr Awakener', 'Grizzly Bears', 'Island'], library: ['Plains', 'Plains'] });
    g.castSpell(0, card(g, 0, 'Opt'));
    expect(onBf(g, 0, 'Grizzly Bears')).toBe(true);
    expect(g.bf.filter(x => x.token && x.controller === 0).length).toBe(1);
  });

  it('never flickers a token (it would vanish)', () => {
    const g = setup({ hand: ['Opt', 'Opt'], bf: ['Kykar, Zephyr Awakener', 'Island', 'Island'], library: ['Plains', 'Plains', 'Plains'] });
    g.castSpell(0, card(g, 0, 'Opt'));
    g.castSpell(0, card(g, 0, 'Opt'));
    expect(g.bf.filter(x => x.token && x.controller === 0).length).toBe(2);
  });

  it("Ennis's ETB flickers another creature and it returns at end step", () => {
    const g = setup({ hand: ['Ennis, Debate Moderator'], bf: ['Helpful Hunter', 'Plains', 'Plains'], library: ['Plains', 'Plains', 'Plains'] });
    const before = handSize(g);
    g.castSpell(0, card(g, 0, 'Ennis, Debate Moderator'));
    expect(onBf(g, 0, 'Helpful Hunter')).toBe(false);
    g.emit({ type: 'phase', phase: 'End of Turn', player: 0 });
    expect(onBf(g, 0, 'Helpful Hunter')).toBe(true);
    expect(handSize(g)).toBe(before - 1 + 1);
  });
});

d('enters-the-battlefield trigger doubling', () => {
  it('Starfield Vocalist makes an entering creature\'s ETB trigger twice', () => {
    const g = setup({ hand: ['Helpful Hunter'], bf: ['Starfield Vocalist', 'Plains', 'Plains'], library: Array(10).fill('Plains') });
    const before = handSize(g);
    g.castSpell(0, card(g, 0, 'Helpful Hunter'));
    expect(handSize(g)).toBe(before - 1 + 2);
  });

  it('only your own triggers are doubled', () => {
    const g = setup({ hand: ['Helpful Hunter'], bf: ['Plains', 'Plains'], library: Array(10).fill('Plains') }, { bf: ['Starfield Vocalist'] });
    const before = handSize(g);
    g.castSpell(0, card(g, 0, 'Helpful Hunter'));
    expect(handSize(g)).toBe(before);
  });

  it('Elspeth, Storm Slayer doubles the Spirit Kykar makes', () => {
    const g = setup({ hand: ['Opt'], bf: ['Kykar, Zephyr Awakener', 'Elspeth, Storm Slayer', 'Island'], library: Array(10).fill('Plains') });
    g.castSpell(0, card(g, 0, 'Opt'));
    expect(g.bf.filter(x => x.token && x.controller === 0).length).toBe(2);
  });
});
