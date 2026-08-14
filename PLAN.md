# Plan

| Rank | Item |
| ---: | --- |
| 95 | Verify the whole thing in a browser. Nothing below the type checker has run: no page has been loaded, no engine has started, no puzzle has been solved. In particular — does `sf_18_smallnet.js` boot from `public/engine/` with `locateFile` pointing at the same directory, does the 15 MB net land and cache, is `crossOriginIsolated` true on the second load under the service worker, and does the depth-12 sweep take a bearable amount of time on a real game? |
| 90 | Deploy to GitHub Pages and check the deployed thing, not the dev server. `.github/workflows/pages.yml` builds with `BASE=/<repo>/`; confirm the service worker registers at that scope, that the one-reload dance happens once and not on every visit, and that cross-origin `fetch` to lichess and to `lichess1.org` still works under `require-corp`. |
| 80 | Tune the analysis budget against a real machine: `SWEEP_DEPTH` 12 and `DEEP_MOVETIME` 1000 ms are guesses. A 60-ply game is 60 sweeps plus two deep searches per swing, and the load gate makes someone wait for five games of that. If it is too slow, the sweep depth is the dial. |
| 72 | Rate-limit handling in the UI. `fetchGames` distinguishes 404 and 429, but the one-concurrent-export 429 (`{"error":"Please only run 1 request(s) at a time"}`) means "you have two tabs open", which is a different sentence to say to someone than "you are going too fast". |
| 68 | Profile switching in the app: the recent-username list is remembered but there is no way back to the landing screen without reloading. |
| 60 | Storage panel: `navigator.storage.estimate()` usage/quota, purge controls, "bring back solved". `Profile.purgeGames`, `clearSolves` and `wipe` exist and have no UI. |
| 55 | Auto-purge policy: evict raw game payloads oldest-first past a usage threshold; never evict derived puzzles or solve history. |
| 50 | Underpromotion. The board auto-queens, so a puzzle whose answer is a knight promotion cannot be solved. Rare enough to ship without, common enough to be a real bug when it bites. |
| 40 | Opening-book cancellation: drop candidates whose played move appears in the masters explorer (`https://explorer.lichess.ovh/masters`), as retro does, gated on `division.middle`. `Solve` already accepts an `openingUcis` list and nothing fills it. |
| 30 | Stretch: spaced repetition — resurface solved positions on an SM-2-lite schedule instead of one-shot. |
| 25 | Stretch: pad the deck with positions the player got *right*, so the deck stops signalling "there is a mistake here" and trains detection. |
| 20 | Stretch: mirror/recolour repeat showings to defeat memorisation. |
| 15 | Stretch: motif classification from (played move, best move) — hung piece, missed fork, back rank — for themed sessions. |
