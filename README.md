# The Crucible

A Monte Carlo matchup simulator for MTG Arena decks. Give it two decklists (Arena export format)
and it plays hundreds of games between them with a heuristic AI on both sides, then reports
win rates, on-the-play splits and average game length.

Card rules come from the [Forge](https://github.com/Card-Forge/forge) card scripts, so there is no
hand-written card database. The scripts are downloaded at setup and are **not** stored in this repo.

```
$ npm run sim -- gauntlet decks/mine/riddles-in-the-dark.txt --games 500

riddles-in-the-dark vs gauntlet (500 games each, standard)
  Red Aggro                     70.0%  (CI 66-74%)  avg turns 8.1
  Blue Tempo                    87.6%  (CI 84-90%)  avg turns 8.3
  Green Stompy                  80.8%  (CI 77-84%)  avg turns 7.6
  White Weenie                  66.2%  (CI 62-70%)  avg turns 8.3
  Black Control                 69.6%  (CI 65-73%)  avg turns 9.7
  OVERALL                       74.8%
```

## Setup

Requires Node 20+ and git.

```bash
npm install
npm run fetch-cards        # sparse-clones Forge card data into vendor/forge (~100 MB, a few minutes)
npm test
```

Set `FORGE_RES=/path/to/forge/forge-gui/res` to use a Forge checkout somewhere else.

## Commands

```bash
npm run sim -- match    <deckA.txt> <deckB.txt> [--games 500] [--format standard|brawl] [--turns 25] [--seed 1]
npm run sim -- gauntlet <deck.txt> [dir=decks/gauntlet] [--games 300]
npm run sim -- coverage <deck.txt>        # which cards the engine ignores or approximates
npm run sim -- trace    <deckA.txt> <deckB.txt> [--seed 1]   # play-by-play of one game
```

The format defaults to Brawl if the first deck has a `Commander` section, otherwise Standard.
Run `SHOW_HANDS=1 npm run sim -- trace ...` to also print both hands each turn.

Games alternate who goes first. Traces show stack fights as `casts X in response to Y` and `Y fizzles`. The CI column is a 95% Wilson interval, so differences
inside about ±5% at 300 games are noise.

## Desktop UI

```bash
npm run ui        # starts a local server and opens http://localhost:4777 in your browser
```

On Windows you can double-click `Crucible.cmd` instead; the first time it installs packages and
downloads the Forge card data. Close the console window (or press Ctrl+C) to stop it.

- **Your deck**: pick one of `decks/mine` or paste an Arena export. The panel shows the format,
  card count, colors, and any cards the engine only partly models. "Save to my decks" writes it to `decks/mine/`.
- **Opponents**: tick any decks. The gauntlet is checked by default; your own decks work too, which is
  handy for Brawl since the gauntlet is Standard.
- **Run gauntlet**: every matchup runs in parallel on a worker thread with its own progress bar, then
  shows the win rate with its 95% range, on-the-play / on-the-draw split and game length.
- **How each card performed**: win rate in games where the card reached your hand compared with games
  where it didn't, centered so the deck's typical card is 0. Sortable; card names link to Scryfall.
- **Suggested improvements**: needs your collection (`Load collection CSV`, the `arena_collection.csv`
  export; stored in `data/`, which is git-ignored). It takes the weakest cards, tries owned cards in your
  colors at a similar mana value, screens every swap quickly, then replays the best few at the full
  game count and labels each result *likely better*, *likely worse* or *within noise*. "Apply to deck"
  edits the list in place; run the gauntlet again to make it the new baseline.

## Deck files

Paste Arena's export directly. Set codes and collector numbers are ignored.

```
Name Red Aggro          # optional display name
Commander               # optional (Brawl)
1 Eddie Brock

Deck
4 Shock (FDN) 82
20 Mountain
```

- `decks/gauntlet/` holds five simple Standard opponents, built only from cards in Erick's
  Arena collection: Red Aggro, Blue Tempo (flash fliers + counters), Green Stompy,
  White Weenie and Black Control.
- `decks/mine/` holds Erick's own decks.

## How it works

| Piece | File | Notes |
|---|---|---|
| Script reader | `src/cards/forge.ts` | Parses Forge `Key:Value` scripts, faces, SVars |
| Compiler | `src/cards/compile.ts` | Turns a script into a `CardDef`: costs, abilities, triggers, statics, land info, plus coverage notes |
| Filters | `src/engine/filters.ts` | Evaluates Forge "Valid" expressions like `Creature.OppCtrl+powerLE2` |
| Engine | `src/engine/game.ts` | Turns, mana payment (backtracking solver), a real stack with a priority loop (targets locked on cast, fizzles, counter wars), triggers, static buffs, combat, state-based actions, command zone |
| AI | `src/ai/policy.ts` | Heuristic play shared by both seats; deck style (aggro/midrange/control) is inferred from the list |
| Runner / CLI | `src/sim/*.ts`, `src/cli.ts` | Deck parsing, match statistics, per-card win rates |
| Desktop UI | `src/ui/` | Local HTTP server, worker pool, SSE progress, upgrade search; page in `src/ui/public/` |

Supported effects include damage, destroy, exile (including "until this leaves"), bounce,
draw, discard, tokens, pumps, ±1/±1 counters, fight, counterspells (with "unless pays"),
scry/surveil, mill, sacrifice, tap/untap, auras and equipment, modal spells, transform, explore,
investigate, amass, connive, ward, prowess, mobilize and sagas.

Keyword mechanics with their own tests (`test/`): equip, kicker, offspring, affinity, convoke,
cycling and landcycling, flashback, spree, gift, warp, crew, station, ninjutsu, sneak,
firebending, earthbend, changeling, and speed ("Start your engines!" / max speed). Combat handles flying, reach,
first and double strike, deathtouch, trample, lifelink, menace, vigilance, defender and
indestructible.

## Limitations (read before trusting a number)

- **The AI is heuristic, not optimal.** It plays reasonably but makes mistakes a good player
  would not, especially with tempo, bluffing and complex sequencing. Treat results as
  *relative* (A/B testing deck changes against the same opponents), not as true ladder win rates.
- **Spells use a real stack, but the AI only answers in three obvious ways.** Players pass
  priority back and forth until both pass, so responses can stack to any depth. The AI responds
  only when it saves (or kills) something worth more than the card it spends:
  1. *Counter it*, including countering a counterspell aimed at its own spell.
  2. *Protect*: their removal targets our creature and a trick in hand (hexproof, indestructible
     or enough toughness) saves it. Hexproof makes the removal fizzle.
  3. *Punish a trick*: they pump their creature; we kill it in response and the pump fizzles.

  It never holds priority, bluffs or baits. Starting a fight outside those cases (instant-speed
  removal and tricks) still happens only in fixed windows: end of turn, when attacked, and after blocks.
- Triggered and activated abilities resolve immediately instead of using the stack, so they
  can't be responded to.
- Anything listed by `coverage` is ignored or approximated. Examples: adventures and omens
  (only the creature half), Impending, Disguise, Plot, Saddle, graveyard-cast abilities other
  than flashback, "can't be countered", and most replacement effects.
- Vehicles are only crewed to attack, never to block. Stations are charged after combat.
- No hidden-information modeling. Hand-peek effects (Deep-Cavern Bat) do nothing.
- Brawl is modeled as 1v1 with 25 life and +2 commander tax.

## License

The simulator code is original and released under the [MIT License](LICENSE).

Card data is read at runtime from [Forge](https://github.com/Card-Forge/forge), which is GPL-3.0.
It is downloaded by `npm run fetch-cards` and is not redistributed here, so the MIT license covers
only this repository's own code. Magic: The Gathering and its card names are © Wizards of the Coast;
this is an unofficial fan project, not affiliated with or endorsed by Wizards.
