# The Crucible

A Monte Carlo matchup simulator for MTG Arena decks. Give it two decklists (Arena export format)
and it plays hundreds of games between them with a heuristic AI on both sides, then reports
win rates, on-the-play splits and average game length.

Card rules come from the [Forge](https://github.com/Card-Forge/forge) card scripts, so there is no
hand-written card database. The scripts are downloaded at setup and are **not** stored in this repo.

```
$ npm run sim -- gauntlet decks/mine/riddles-in-the-dark.txt --games 500   # (output from before the meta gauntlets)

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
npm run sim -- match    <deckA.txt> <deckB.txt> [--games 500] [--format standard|standard-brawl|brawl] [--turns 25] [--seed 1]
npm run sim -- gauntlet <deck.txt> [dir] [--games 300]      # dir defaults to the deck's format's gauntlet
npm run sim -- coverage <deck.txt>        # which cards the engine ignores or approximates
npm run sim -- trace    <deckA.txt> <deckB.txt> [--seed 1]   # play-by-play of one game
npm run sim -- mechanics [--md docs/mechanics.md] [--defs]  # every rules keyword vs the engine and the decks
```

### Mechanics coverage

`npm run fetch-rules` downloads Wizards' Comprehensive Rules (TXT) into `vendor/rules/` (not committed;
pass the newest link from https://magic.wizards.com/en/rules when Wizards updates them). `npm run sim --
mechanics` then lists every keyword action (rule 701) and keyword ability (rule 702) as supported, partial,
missing or unflagged, with how many of Erick's decks and gauntlet decks use it and which cards report a gap.
`--defs` prints each rule's first sentence. [docs/mechanics.md](docs/mechanics.md) is the latest report.

The format comes from the first deck: Standard without a commander, Standard Brawl with a commander and
60 cards, Brawl with a commander and 100 cards.
Run `SHOW_HANDS=1 npm run sim -- trace ...` to also print both hands each turn.

Games alternate who goes first. Traces show stack fights as `casts X in response to Y` and `Y fizzles`. The CI column is a 95% Wilson interval, so differences
inside about ±5% at 300 games are noise.

## Desktop UI

```bash
npm run ui        # starts a local server and opens http://localhost:4777 in your browser
```

On Windows you can double-click `Crucible.cmd` instead; the first time it installs packages and
downloads the Forge card data. Close the console window (or press Ctrl+C) to stop it.

### Always-on with Docker

```bash
docker compose up -d --build     # build and start in the background; restarts whenever Docker starts
docker compose down              # stop
```

Then open http://localhost:4777. The image downloads the Forge card data while it builds, so the
first build takes a few minutes; run the same `up -d --build` after a `git pull` to update.
Decks saved in the UI go to this clone's `decks/mine/` and your collection to `data/`, so they
survive rebuilds. The port is bound to `127.0.0.1`, so only this computer can reach it.

- **Your deck**: pick one of `decks/mine` or paste an Arena export. The panel shows the format,
  card count, colors, any cards the engine only partly models, and any cards that break the format
  (not Standard-legal, or extra copies in a singleton format). "Save to my decks" writes it to `decks/mine/`.
- **Opponents**: the gauntlet for your deck's format is ticked automatically. Your own decks of that
  format are listed next, and other formats sit under "Other formats".
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

- `decks/mine/` holds Erick's own decks.
- `decks/gauntlet/<format>/` holds the opponents for each format (see below).

## Formats and gauntlets

Each format has its own gauntlet, so a deck is tested like against like. The format is read from the deck:

| Format | How it's recognised | Rules in the engine | Gauntlet |
|---|---|---|---|
| Standard | no `Commander` section | 20 life | `decks/gauntlet/standard` (18 decks) |
| Standard Brawl | commander, 60 cards | 25 life, commander tax | `decks/gauntlet/standard-brawl` (7 decks) |
| Brawl | commander, 100 cards | 25 life, commander tax | `decks/gauntlet/brawl` (8 decks) |

`gauntlet` uses the deck's own gauntlet unless you pass a folder; `--format standard|standard-brawl|brawl`
overrides detection. The UI ticks the matching gauntlet automatically and remembers your ticks per format.

Where the decks come from (captured October 12, 2026; each file's header has its source and stats):

- **Standard**: the 13 most-played archetypes on [Untapped.gg](https://mtga.untapped.gg/constructed/standard/tier-list)
  (Bo1, Sep 29 - Oct 12), using each archetype's most-played list (`meta-*.txt`), plus the five original
  starter decks built from Erick's collection (`1-red-aggro.txt` ... `5-black-control.txt`).
- **Brawl**: the top eight commanders on Untapped's
  [Competitive Brawl](https://mtga.untapped.gg/constructed/competitive-brawl/tier-list) tier list, using each
  one's most-played 100-card list. Untapped keeps Brawl win rates behind Premium, so none are recorded.
- **Standard Brawl**: no site tracks it, so these are 60-card singleton prototypes of current Standard
  archetypes, each led by a legend that archetype plays (plus Spider-Man 2099, the tier-A Brawl commander).
  Each starts from the archetype's Untapped list, then adds the most-played Standard cards on Untapped in
  the commander's colors that the engine fully models.

`npm test` checks every gauntlet deck: all cards found, right size, singleton where required, Standard-legal
for both Standard formats (from Forge's own Standard set list and bans), cards within the commander's colors,
and that the engine can play a few games with it.

**Caveat:** the Competitive Brawl decks are near-Vintage power (Force of Will, Library of Alexandria) and
a third to half of their nonland cards are still only partly modeled (as of October 14, 2026: 43-75% fully
modeled per deck). Standard and Standard Brawl meta decks are 64-97% fully modeled; Azorius Control, Jeskai
Artifacts and Mono-Red Burn are the least complete. Opponents with gaps play below their real strength,
so results against them read high.

To refresh a gauntlet, replace its `meta-*.txt` files with new lists in the same format (keep the header
comment with the source and date) and run `npm test`.

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

Also supported, each with its own test file:
- **Impulse draw** (`impulse.test.ts`): "exile the top card, you may play it this turn" really exiles the card,
  and the permission runs out at the stated time ("this turn", "until the end of your next turn"). Includes
  "exile two, choose one" (Fireglass Mentor). Exiled lands can be played as the land drop.
- **Temporary effects** (`effects.test.ts`): "can't be blocked this turn", "creatures without flying can't
  block this turn", granted keywords and pumps until end of turn, and emblems ("creatures you control get +2/+2").
- **Modal double-faced lands** (`mdfc.test.ts`): pathways enter as whichever color is needed; spell-front
  cards (Agadeem's Awakening) are played as their land when there's no other land drop. Their land backs
  count as lands when deciding to mulligan.
- **Animate** (`animate.test.ts`): "becomes a creature" effects. Manlands animate before combat when other
  lands can pay for it and no untapped blocker would kill them.
- **Alternative costs** (`altcost.test.ts`): free spells ("if you control a commander") and pitch spells
  that cost life, cards exiled from hand, a returned land or a sacrifice (Force of Will, Daze, Snuff Out).
  They're used when the mana cost can't be paid.
- **Characteristic-defining power/toughness** (`cda.test.ts`): Crusader of Odric, Tarmogoyf-style goyfs and
  Enigma Drake compute their size from the board and graveyards.
- **Additional combat phases** (`extra-combat.test.ts`): Aurelia, the Warleader untaps the team and attacks
  again; Bumi, Unleashed's extra combat lets only land creatures attack. "Attacks for the first time each
  turn" triggers fire once.
- **Counters** (`counters.test.ts`): "whenever you scry or surveil" (Denzilore, Saheeli, Prudent Fateseer),
  doubling counters (Ultimate Spider-Man, Bristly Bill, Mossborn Hydra, Scythecat Cub's second landfall),
  and keyword counters (a trample counter gives trample).
- **Meta mechanics** (`meta.test.ts`): Leylines and Gemstone Caverns start in play from the opening hand;
  Evoke (mana or pitch costs; the AI evokes when the enters trigger is worth a card); token copies
  (Three Steps Ahead, Ardyn); cost increases (Thalia, Disruptor Flute) and a card's own reductions (Ghalta);
  "as this enters, choose a creature type / card name"; "other creatures enter with an extra counter"
  (Gev, Giada); delayed triggers (Mana Drain's mana, Mistrise Village's uncounterable spell); abilities and
  triggers granted by statics (Adagia at 12 charge); land-played triggers; "can't be activated" locks.
- **Graveyard decks** (`meta.test.ts`): Delve, mass reanimation (Raise the Past, Bringer of the Last Gift),
  Superior Spider-Man entering as a copy of a graveyard creature, rituals cast only when they enable a
  spell, trigger costs that discard (Formidable Speaker), and a reanimator AI that discards its fatties.
- **Hand disruption, conditions, Impending, granted mana** (`chunk1.test.ts`): Deep-Cavern Bat exiles the
  opponent's best nonland card until it leaves, then the card goes back to their hand. "If ..." conditions
  on effects are checked (Prophesied End, Beorn the Fierce, Shadow of the Goblin). Overlords can be cast for
  their impending cost and become creatures after their time counters run out. Statics that give mana
  abilities work, including the one Huatli's saga back face (Roar of the Fifth People) gains.

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
  (only the creature half), Disguise, Plot, Saddle, graveyard-cast abilities other
  than flashback, "can't be countered", most replacement effects, non-mana abilities granted by
  statics, Animate or temporary effects, and spell-side backs of modal double-faced cards. Across
  Erick's decks and all gauntlets, 233 of 971 distinct cards still have at least one such note
  (346 before October 12, 2026; 298 before October 14).
- Vehicles are only crewed to attack, never to block. Stations are charged after combat.
- No hidden-information modeling: the AI sees both hands, so "look at their hand" adds nothing beyond
  the choice it enables (Deep-Cavern Bat takes the best card).
- Both Brawl formats are modeled as 1v1 with 25 life and +2 commander tax.

## License

The simulator code is original and released under the [MIT License](LICENSE).

Card data is read at runtime from [Forge](https://github.com/Card-Forge/forge), which is GPL-3.0.
It is downloaded by `npm run fetch-cards` and is not redistributed here (the same goes for Wizards'
Comprehensive Rules, downloaded by `npm run fetch-rules`), so the MIT license covers
only this repository's own code. Magic: The Gathering and its card names are © Wizards of the Coast;
this is an unofficial fan project, not affiliated with or endorsed by Wizards.
