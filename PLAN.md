# Plan

| Rank | Item |
| ---: | --- |
| 95 | Fetch pipeline: `GET /api/games/user/{u}?max=20&moves=true&evals=true&division=true&clocks=false` as NDJSON, streamed, into IndexedDB `games`. Handle 404 (no such user) and 429. |
| 92 | Candidate finder: port `evalSwings` from lila `ui/analyse/src/nodeFinder.ts` + `winningChances.ts`. Pure function over (moves, evals, pov) → candidate plies. Node-testable, no DOM. |
| 90 | Stockfish worker: `@lichess-org/stockfish-web`, two-pass — shallow sweep (~depth 12) over all plies to find swings, deep re-check (~1s) on candidates only. Emits the same eval shape as the lichess export so both paths feed one finder. |
| 88 | COOP/COEP: `public/_headers` + Cloudflare Pages, verified with `crossOriginIsolated === true`. Nothing multithreaded works without it. |
| 85 | Deck build: candidate → puzzle record {id, gameId, ply, fen, pov, played, best, pv, prevEval, eval}. Shuffle across games, never two from the same game consecutively. |
| 84 | Load gate: block on a progress bar until ~5 games are analysed, then unlock the board and keep analysing in the background. |
| 82 | Solve loop: chessground board, player POV, retro state machine ported from `retroCtrl.ts` — accept the engine line, accept a mate, reject the move actually played, otherwise judge with local ceval at `povDiff > -0.04`. |
| 80 | Strip context: no game link, opponent, date, ply, eval bar or move list until after the position is solved. Then reveal the game. |
| 75 | Persistence: `idb-keyval` store per username, `navigator.storage.persist()` on first solve. Solved puzzles leave the shuffle, stay in the store. |
| 72 | Deck pressure: when unsolved count drops below a threshold, fetch the next batch of 20 and analyse in the background. |
| 68 | Profile switching: username input remembers recent names, each with its own store. |
| 60 | Storage panel: `navigator.storage.estimate()` usage/quota, purge controls, "bring back solved" control. |
| 55 | Auto-purge policy: evict raw game payloads oldest-first past a usage threshold; never evict derived puzzles or solve history. |
| 40 | Opening-book cancellation: drop candidates whose played move appears in the masters explorer (`https://explorer.lichess.ovh/masters`), as retro does, gated on `division.middle`. |
| 30 | Stretch: spaced repetition — resurface solved positions on an SM-2-lite schedule instead of one-shot. |
| 25 | Stretch: pad the deck with positions the player got *right*, so the deck stops signalling "there is a mistake here" and trains detection. |
| 20 | Stretch: mirror/recolour repeat showings to defeat memorisation. |
| 15 | Stretch: motif classification from (played move, best move) — hung piece, missed fork, back rank — for themed sessions. |
