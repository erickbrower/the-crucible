// */* creatures whose power and toughness come from a characteristic-defining ability.
import { it, expect } from 'vitest';
import { loadCard } from '../src/cards/compile.js';
import { d, setup, perm, make } from './helpers.js';

d('characteristic-defining power/toughness', () => {
  it('Crusader of Odric counts creatures you control', () => {
    const g = setup({ bf: ['Crusader of Odric', 'Raging Goblin', 'Raging Goblin'] }, { bf: ['Raging Goblin'] });
    expect(g.statsOf(perm(g, 0, 'Crusader of Odric'))).toMatchObject({ power: 3, toughness: 3 });
    expect(loadCard('Crusader of Odric').notes).toEqual([]);
  });

  it('Tarmogoyf counts card types in all graveyards, toughness one more', () => {
    const g = setup({ bf: ['Tarmogoyf'], graveyard: ['Shock', 'Raging Goblin'] }, { graveyard: ['Mountain', 'Opt'] });
    // Instant, Creature, Land (Shock and Opt are both instants)
    expect(g.statsOf(perm(g, 0, 'Tarmogoyf'))).toMatchObject({ power: 3, toughness: 4 });
    g.players[1].graveyard.push(make(g, 1, 'Ajani Resolute'));     // + Planeswalker
    expect(g.statsOf(perm(g, 0, 'Tarmogoyf'))).toMatchObject({ power: 4, toughness: 5 });
  });

  it('Enigma Drake only sets power', () => {
    const g = setup({ bf: ['Enigma Drake'], graveyard: ['Shock', 'Opt', 'Mountain'] });
    expect(g.statsOf(perm(g, 0, 'Enigma Drake'))).toMatchObject({ power: 2, toughness: 4 });
  });
});
