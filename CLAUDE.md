# Blindspot

Static site. No backend, ever — if something seems to need one, it doesn't.
Vite + TypeScript, deployed to Cloudflare Pages.

## The contract with lichess

The lichess API is the canonical contract; this file loses to it. Re-derive from
https://lichess.org/api rather than from memory, and from lila source when the
apidoc is silent.

Facts established 2026-08-14 by reading lila at `lichess-org/lila@master`:

- `GET /api/games/user/{u}` is `OpenOrScoped` — **no token required**, games are
  public. Anon rate limit 25 games/sec, 60 for your own games with a token.
  One concurrent export per IP (`GlobalConcurrencyLimitPerIpAndUserOption`).
- `evals=true` adds an `analysis` array, one entry per ply, from
  `modules/analyse/src/main/JsonView.scala`:
  `{eval|mate, best (uci), variation (SAN, <=12 plies), judgment}`.
  Defaults to **false** on the by-user export — pass it explicitly.
- Semantics, from `modules/fishnet/src/main/AnalysisBuilder.scala`:
  - `eval` is the score **after** that ply, normalised to **White's POV**
    (odd plies are inverted). So lila's `winningChances.povDiff` drops in
    unmodified.
  - `variation` is the engine PV **from the position before that ply**, and is
    **empty when the played move was the engine's first choice**. So
    `variation.length > 0` is exactly lila's `hasCompChild(prev)` test.
  - `best` is `variation[0]`.
- `POST /:id/request-analysis` is `AuthOrScoped(_.Web.Mobile)` — the official app
  only. **We can never queue server analysis.** That is why the engine runs here.
- `division=true` gives `{middle, end}` plies, used to skip opening-book moves.
- Masters explorer is `https://explorer.lichess.ovh/masters?fen=...`, CORS-open.
  **It answers `401` to every request from this host** (checked 2026-08-14, with
  and without `source=analysis`, no `WWW-Authenticate` in the reply) — an nginx
  401 that looks like IP-level blocking of a datacenter address rather than a
  new auth requirement, since lila's own analysis board calls the same URL from
  browsers. So the explorer path **cannot be verified here**, and
  `OpeningBook.contains` treats "no answer" as "book", which degrades to the
  blanket skip-the-opening behaviour rather than to blunder-shaped noise.
- A request with **no User-Agent gets 404**, not 403 — lila's `NoCrawlers`
  guard. Browsers always send one, so this only ever bites dev scripts and
  curl, but the status code makes it look like the user doesn't exist.
- **A persistent `429` on the by-user export is a leaked stream, not a block.**
  Traced through lila 2026-08-14: `Game.handleExport` wraps the source in
  `apiC.GlobalConcurrencyLimitPerIpAndUserOption`, which for an anonymous
  request is `GlobalConcurrencyLimitPerIP.download` — `ConcurrencyLimit(key =
  "api.ip.download", ttl = 1.hour, maxConcurrency = 2)`, keyed by IP.
  `compose` increments on start and decrements from `watchTermination`, i.e.
  **only when the stream ends**. So a client that stops reading without closing
  the body holds a slot; two of those and the address is locked out. The count
  lives in a Caffeine cache with `expireAfterWrite(1.hour)` and a *rejected*
  request does not write, so it must clear within an hour of the last
  successful start.
  - The reply is always `{"error":"Please only run 1 request(s) at a time"}`
    whatever the real limit is — `.getOrElse(ConcurrencyLimit.limitedDefault(1))`
    hardcodes the 1. Do not read a maximum out of that sentence.
  - `exportOne` (`/game/export/{id}`) has **no** concurrency limiter at all,
    which is why single-game export keeps working from an address the by-user
    export is refusing. That asymmetry is the diagnostic, not a coincidence.
  - Two ways we leaked slots ourselves: `fetchGames` abandoned mid-iteration
    without cancelling the reader (fixed — it cancels in a `finally`), and
    `curl ... | head`, where the truncated pipe kills curl mid-stream. **Write
    probe output to a file.**
- Exceeding the one-concurrent-export limit returns
  `429 {"error":"Please only run 1 request(s) at a time"}`. Distinct from the
  per-second rate limit and worth reporting to the user differently.

- `analysis` can be **shorter than `moves`** — a checkmate position gets no
  entry (`AnalysisBuilder` filters them), so a game ending in mate has one
  fewer. It aligns from index 0 and is never longer, so index defensively and
  never derive the move count from it.

**Verified against the live API 2026-08-14** with `scripts/verify-export.ts`,
over two real analysed games (40 entries carrying a variation, between them):

- `variation[0]` was legal in the position **before** its move 40/40, and in the
  position after it only 3/40 (moves that happen to be legal in both). The
  before-position reading is right.
- `best === uci(variation[0])` from the before-position, 40/40.
- `variation[0]` differed from the move actually played, 40/40 — a variation is
  present only when the engine disagreed.
- White POV confirmed: a game white won by mate ends `{"mate":1}`, and white's
  blunders drop the eval while black's raise it.

The games-export endpoint could not be reached from this host (permanently
`429`), but the single-game export works, so use that to sample:
`curl -s https://lichess.org/api/puzzle/daily` for an id of an analysed game,
then `GET /game/export/{id}?evals=true&division=true`.

## The engine

`@lichess-org/stockfish-web`, the **`sf_18_smallnet`** build, booted the way
lila boots it (`ui/lib/src/ceval/engines/stockfishWebEngine.ts`, read
2026-08-14): `wasmMemory: sharedWasmMemory(1536)`, `locateFile`, and
`mainScriptUrlOrBlob` all have to be passed, and the net arrives via
`setNnueBuffer`, not over the wire by the engine itself.

- Net sizes, measured 2026-08-14: smallnet `nn-4ca89e4b3abf` **15 MB**, the
  `sf_18` big net **109 MB**, its small companion 3.5 MB. The big one is not a
  trade a first visit can make, which is what picks the build.
- `https://lichess1.org/assets/lifat/nnue/<name>` serves them with
  `access-control-allow-origin: *` and `cross-origin-resource-policy:
  cross-origin`, so it is fetchable under our own `require-corp`. [SOURCE] —
  headers, not a documented contract; if it ever breaks, host the net
  ourselves. `tests.stockfishchess.org` has neither header and is not usable
  from the browser.
- Ask `getRecommendedNnue(i)` for the filenames rather than hardcoding one; it
  is what survives an engine bump.
- **The engine .js cannot be bundled.** It spawns its pthreads by re-importing
  its own URL and finds its `.wasm` next to it, so `scripts/prepare-engine.mjs`
  copies both into `public/engine/` (gitignored) and we dynamic-import the URL
  with `/* @vite-ignore */`.
- UCI scores are from the side to move; `parseInfo` normalises to White's POV
  at the boundary so nothing downstream has to think about it.

**The engine also runs on node here, and that is the only way any of this gets
verified off a browser.** `UciSession` is transport-agnostic on purpose, so
`npm run engine-smoke` and `npm run verify-analysis` drive the real browser code
against the real engine. Keep it that way: put engine logic in `UciSession`, not
in the `Engine` wrapper, or it becomes unverifiable on this host.

Verified 2026-08-14 with `npm run verify-analysis`, against games lichess had
analysed, sweep depth 12 / deep 1000 ms / 4 threads:

- 45-move game: **~10 s per side**, and our candidate set was identical to the
  one lichess' own analysis produces, 3 of 3 on both sides.
- 144-move game: 15–20 s per side; 5 of lichess' 8 white candidates and 3 of its
  4 black ones, plus two it didn't flag. Disagreement at the edges is expected —
  lichess searches deeper — but the middle of the distribution matches.
- The sweep is not the expensive half: ~0.1 s a position. The deep re-checks
  are, at 2 s a candidate.

## Node's type stripping

Tests run under `node --test --experimental-strip-types`, which is **strip-only**:
no TypeScript that needs emit. In practice that means **no constructor parameter
properties** (`constructor(private readonly x: T) {}`) anywhere `src/` can be
reached from a test, and no enums or namespaces. Assign in the body instead. The
type checker will not warn you; the test run fails with
`ERR_INVALID_TYPESCRIPT_SYNTAX`.

## Ported code

The candidate finder and solve state machine are ports of lila's
`ui/analyse/src/nodeFinder.ts`, `ui/lib/src/ceval/winningChances.ts` and
`ui/analyse/src/retrospect/retroCtrl.ts`. Keep them recognisable — same function
names, same thresholds, same comments where they explain a magic number. When
lila changes a threshold we want the diff to be obvious.

Thresholds that are load-bearing and must not drift silently:
- candidate: `|povDiff('white', prev, curr)| > 0.1`, or prev was mate <= 3 and
  curr is not mate
- accept an alternative move: `povDiff(pov, yourEval, prevEval) > -0.04`

## Storage

- IndexedDB via `idb-keyval` for games, deck and solve history. One store per
  username.
- localStorage only for tiny prefs (last username, board theme). It is a
  separate, fixed ~5 MiB box, not a slice of the IndexedDB quota.
- Call `navigator.storage.persist()` once, or the browser LRU-evicts solve
  history under disk pressure.
- Raw game payloads are re-fetchable and may be purged. Derived puzzles and
  solve history are not and must not be.

## Cross-origin isolation

Multithreaded Stockfish needs `SharedArrayBuffer`, which needs COOP/COEP. If
`crossOriginIsolated` is false the engine silently falls back to the
single-threaded build and the analysis pass becomes unusably slow, so surface it
rather than letting it degrade quietly.

The deploy target is **GitHub Pages**, which cannot set response headers at all
— `public/_headers` is inert there. Isolation has to come from a service worker
that re-serves the page with the headers itself, which means
`crossOriginIsolated` is **false on a visitor's first load** and only true after
the worker registers and the page reloads once. So the engine bootstrap must
tolerate one reload; do not assert isolation at startup.

`public/_headers` and the vite dev-server headers stay regardless: they make
dev match the isolated case, and they make a move to Cloudflare Pages a one-line
switch if the worker proves flaky.

**Register, active, and controlling are three different things.**
`navigator.serviceWorker.register()` resolves at the first; only the third
gets the page the headers. Reloading before the worker controls anything
produces a second uncontrolled load, and then the one-reload guard gives up and
the visit has no engine at all. `ensureIsolation` waits for
`serviceWorker.ready` and then for a `controllerchange`, with a timeout, before
it reloads. This is the bug that made the deployed build say "no engine" on a
phone.

`public/coi-serviceworker.js` deliberately touches **same-origin responses
only**. Cross-origin ones — the lichess API, the neural net — already carry the
CORS and CORP headers `require-corp` wants, and re-wrapping an opaque response
in the worker breaks them.

The Pages build needs `BASE=/<repo>/` (the workflow passes it): the engine and
the service worker are loaded by URL rather than by import, so a wrong base
404s them at runtime instead of failing the build.

## Licence

AGPL-3.0-or-later, because we port lila (AGPL) and use chessground (GPL-3). The
network clause means the running site must offer its source — the footer link to
the repo is not decoration, don't remove it.
