# Plan

| Rank | Item |
| ---: | --- |
| 85 | Confirm the opening-book cancellation actually runs. It cannot be checked from the machine it was written on — `explorer.lichess.ovh` answers 401 there — so the Storage panel now reports it: lookups, answers, failures with the error, and candidates dropped as book. **The check:** analyse some games, open Storage, and read the Openings line. Lookups climbing with answers means it works. Lookups climbing with failures means it is failing open — every opening candidate is being treated as book, which is the old skip-the-opening behaviour wearing a costume, and the whole path should be deleted rather than left looking live. Zero lookups means `division.middle` is excluding everything and the code never runs at all. |
| 75 | A game skipped because the engine could not start is recorded in `meta.fetched` — "looked at, found nothing" — and so is never analysed again, even once there is an engine. A session with no engine therefore walks backwards through someone's whole history stamping it, silently, and the deck never fills. Seen for real on a phone: 70 games. The isolation fix makes the engine-less load rarer but not impossible — a dropped 15 MB net download does it too, and `App.engine()` caches that failure for the session. Fix: a separate `meta.needsEngine` list, re-queued from IndexedDB when an engine appears, and stop paging further back while that backlog grows. |
| 70 | The loading screen rewrites its whole DOM on every progress event, which is once per swept position. Fine until it isn't; measure before caring. |
| 30 | Stretch: spaced repetition — resurface solved positions on an SM-2-lite schedule instead of one-shot. |
| 25 | Stretch: pad the deck with positions the player got *right*, so the deck stops signalling "there is a mistake here" and trains detection. |
| 20 | Stretch: mirror/recolour repeat showings to defeat memorisation. |
| 15 | Stretch: motif classification from (played move, best move) — hung piece, missed fork, back rank — for themed sessions. |
