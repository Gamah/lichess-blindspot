# Plan

| Rank | Item |
| ---: | --- |
| 95 | Verify the app in a browser. The engine and the analysis pass have been run for real on node (`npm run engine-smoke`, `npm run verify-analysis`), but no page has been loaded: the service worker, chessground, the board's promotion chooser, IndexedDB and the load gate have all only been type-checked. |
| 90 | Deploy to GitHub Pages and check the deployed thing, not the dev server. `.github/workflows/pages.yml` builds with `BASE=/<repo>/`; confirm the service worker registers at that scope, that the one-reload dance happens once and not on every visit, and that cross-origin `fetch` to lichess and to `lichess1.org` still works under `require-corp`. |
| 85 | The masters explorer 401s from this host, so opening-book cancellation has never run against the real service. From a browser, check that a book move really is cancelled and that `OpeningBook` isn't making a request per middlegame puzzle. If the 401 turns out to be real rather than an IP block, the whole path degrades to "skip the opening" and should be deleted rather than left looking live. |
| 80 | Tune the analysis budget against a real machine. Measured here at 4 threads: ~10 s for a 45-move game, 15–20 s for a 144-move one, and the load gate makes someone wait for five games of that. The sweep is cheap (~0.1 s a position); the 1 s deep re-checks are the cost. |
| 75 | A game skipped because the engine could not start is recorded in `meta.fetched` — "looked at, found nothing" — and so is never analysed again, even once there is an engine. A session with no engine therefore walks backwards through someone's whole history stamping it, silently, and the deck never fills. Seen for real on a phone: 70 games. The isolation fix makes the engine-less load rarer but not impossible — a dropped 15 MB net download does it too, and `App.engine()` caches that failure for the session. Fix: a separate `meta.needsEngine` list, re-queued from IndexedDB when an engine appears, and stop paging further back while that backlog grows. |
| 70 | The loading screen rewrites its whole DOM on every progress event, which is once per swept position. Fine until it isn't; measure before caring. |
| 55 | Deck exhaustion is a dead end: "that is the deck" appears, a batch is fetched, and nothing re-renders when it arrives. It should pick the next position up by itself. |
| 30 | Stretch: spaced repetition — resurface solved positions on an SM-2-lite schedule instead of one-shot. |
| 25 | Stretch: pad the deck with positions the player got *right*, so the deck stops signalling "there is a mistake here" and trains detection. |
| 20 | Stretch: mirror/recolour repeat showings to defeat memorisation. |
| 15 | Stretch: motif classification from (played move, best move) — hung piece, missed fork, back rank — for themed sessions. |
