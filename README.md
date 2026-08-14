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

1. Fetch the last N games from the public lichess API. No account, no token.
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
analysis. Measured against a twelve-second reference search, it names the same
best move essentially always, agrees on the same top *two* about 70–90% of the
time, and reproduces the exact order of all five rarely. Spending longer barely
helps — the tail of that list is genuinely uncertain, not underfunded. So Hard
will occasionally refuse a move a stronger engine would rank second. Settings
has a "thinking time per position" dial if you want to spend more or, on a
phone, less.

**This uses your processor, and it is meant to.** Blindspot is a chess engine
running in a tab: every position is searched before you see it, so a long
history means minutes of sustained load the first time through. On a phone that
is a warm device and a real dent in the battery — it says so, and it is worth
plugging in for. Settings can lower the positions taken from each game, the
thinking time, the number of cores, and how many games to keep at all.

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
