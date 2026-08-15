# Blindspot

**<https://gamah.github.io/lichess-blindspot/>**

Puzzles from your own games, for board vision.

Lichess' *Learn from your mistakes* walks you through the blunders of one game,
in order, with the game around it — it reads as review. Blindspot takes the same
positions, strips the context off them, shuffles them across your last N games
and serves them as puzzles: no opponent, no date, no move number, no eval bar.
Just the position, from your side of the board, and a red arrow on the move
that lost it — that one is never the answer, and you are not expected to
remember your own game.

Type a lichess username. Any username — practising someone else's blindspots
works fine.

## How it works

1. Fetch your games from the public lichess API. No account, no token. Each
   session picks up whatever you have played since it last looked, then works
   backwards through your history; Settings decides how far back it reaches and
   how many games arrive per request.
2. Analyse them in the browser with Stockfish (WASM). Games that lichess has
   already analysed ship their evals in the export and skip the engine.
3. Find the eval swings on that player's moves — the same rule lila uses
   (`ui/analyse/src/nodeFinder.ts`).
4. Rank each of those positions: before you are ever shown one, the engine
   works out its best five moves and they are stored with the game.
5. Shuffle, strip, serve. A move is correct if it doesn't throw away winning
   chances, not if it matches one blessed solution — so quiet positional
   mistakes are solvable rather than a guessing game.

Everything is stored locally in your browser — the games with their evaluations,
and what you have solved. There is no server.

## Difficulty, and the arrows

**Easy** accepts any move that doesn't throw the position away. Several moves
usually qualify, which is the honest answer to "was that alright". **Medium**
and **Hard** additionally require your move to be one the engine itself would
name — inside its top five, or its top two. The engine's own move and a move
that mates are accepted at every setting; the move played in the game is
refused at every setting.

When a position is solved the board shows that ranking: five arrows, numbered
best first, fading as they go down the list, with the move you found in green
and the move the game played in red.

**What that ranking is worth.** It is a search of a couple of seconds per
position, run on your device before the position is shown, and stored so the
same move gets the same verdict every time it comes round. It is not a deep
analysis. Measured against a twelve-second reference search, over thirty
positions from thirty real games: it names the same best move 93% of the time,
its top five always contained the longer search's second choice, and it
reproduces the exact order of all five about a third of the time. Its *top two*
missed that second choice about a quarter to a third of the time.

So the two strict settings are not one claim at two strengths. **Medium** asks
for something the search is fairly sure of. **Hard** asks for more certainty
than a search this long can give, on purpose — it will sometimes refuse a move
a stronger engine ranks second, and that is the setting working as intended
rather than a bug. Spending longer does not fix it: eight times the time
measured no better, because the tail of that list is genuinely uncertain rather
than underfunded. Settings has a "thinking time per position" dial anyway, if
you want to spend more or, on a phone, less.

**The deck can be looked through.** The *Deck* button opens every position you
have, over the board rather than under it. Positions still waiting are
listed with everything except the engine's answer — the move you played, what
it cost, which game it was — because a list you are choosing from has to be one
you can tell apart. The solving screen still hands positions over cold. Solved ones come with
everything: the move you played, what it cost, how the solve went, a link into
the game, and a button that puts the position back on the board as a replay,
which changes nothing that was recorded.

**Hint** rings the pieces worth moving — up to five, because unlike a lichess
puzzle there is usually more than one move that saves the position. It never
rings nothing, and it does not narrow on the harder settings: it is a fact about
the position, not about your difficulty. Taking one is recorded, so the stats
can separate "found it" from "found it unaided".

**Hide** takes a position out of the shuffle without deleting anything; Restore
brings it back. There is no per-position delete, on purpose — the only thing
that could be deleted is the whole game, and that throws away the engine time
that analysed it for no space worth having. Settings still has a purge for when
space really is the problem, and it now deletes the solve records of the games
it drops.

The dialog also totals your solves: how often you find the move without looking,
and how that varies by side and by how bad the mistake was, using lichess' own
inaccuracy/mistake/blunder thresholds.

**This uses your processor, and it is meant to.** Blindspot is a chess engine
running in a tab: every position is searched before you see it, so a long
history means minutes of sustained load the first time through. On a phone that
is a warm device and a real dent in the battery — it says so, and it is worth
plugging in for. Settings can lower the positions taken from each game, the
thinking time, the number of cores, how far back it fetches, and how many games
to keep at all.

**New games arrive by themselves.** Blindspot keeps two cursors: how far back it
has reached, and the newest game it has ever taken in. A session starts by
asking lichess for everything since the second of those, so playing a few games
and coming back gets you those games — the deck used to page backwards only, so
anything played after your first visit was unreachable.

## Development

Requires node 22+.

```
npm install
npm run dev      # copies the engine into public/, then serves with COOP/COEP
npm test         # the pure logic: finder, deck, derive, pipeline, solve machine
```

Two scripts run the real engine outside a browser, which is where most of this
gets verified:

```
npm run engine-smoke              # handshake, score normalisation, mate scores
npm run verify-analysis [gameId]  # our candidates vs lichess' own, on a real game
```

Deploys to GitHub Pages on a push to `master`. Pages cannot set response
headers, so cross-origin isolation comes from a service worker that re-serves
the page with them — which means the first load of a visit is not isolated and
the page reloads itself once.

## License

AGPL-3.0-or-later. Blindspot ports logic from
[lila](https://github.com/lichess-org/lila) (AGPL-3.0) and uses
[chessground](https://github.com/lichess-org/chessground) (GPL-3.0).
Source: https://github.com/Gamah/lichess-blindspot
