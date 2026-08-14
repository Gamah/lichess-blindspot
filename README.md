# Blindspot

**<https://gamah.github.io/lichess-blindspot/>**

Puzzles from your own games, for board vision.

Lichess' *Learn from your mistakes* walks you through the blunders of one game,
in order, with the game around it — it reads as review. Blindspot takes the same
positions, strips the context off them, shuffles them across your last N games
and serves them as puzzles: no opponent, no date, no move number, no eval bar,
no "you played Qh5". Just the position, from your side of the board.

Type a lichess username. Any username — practising someone else's blindspots
works fine.

## How it works

1. Fetch the last N games from the public lichess API. No account, no token.
2. Analyse them in the browser with Stockfish (WASM). Games that lichess has
   already analysed ship their evals in the export and skip the engine.
3. Find the eval swings on that player's moves — the same rule lila uses
   (`ui/analyse/src/nodeFinder.ts`).
4. Shuffle, strip, serve. A move is correct if it doesn't throw away winning
   chances, not if it matches one blessed solution — so quiet positional
   mistakes are solvable rather than a guessing game.

Everything is stored locally in your browser — the games with their evaluations,
and what you have solved. There is no server.

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
