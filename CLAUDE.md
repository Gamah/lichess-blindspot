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
- **The masters explorer is not available to us.**
  `https://explorer.lichess.ovh/masters` is CORS-open but answers `401` to
  everything: from this host by curl, and from a browser on an ordinary
  domestic connection (checked 2026-08-14, with and without `source=analysis`,
  no `WWW-Authenticate` in the reply). lila's own frontend calls it with
  `credentials: 'include'` — a lichess session cookie, which a static page on
  another origin can never send. Treat it as lichess-only. We removed the
  opening-book cancellation because of this and cut the opening off by
  `division.middle` instead; do not re-add it without evidence the endpoint
  answers an unauthenticated cross-origin request.
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
  - **Do not probe the by-user export from this host.** It shares an IP with the
    machine the app is tested on, so a leaked slot here breaks the app there,
    and the recovery is an hour of silence rather than a smaller request rate.
    Sample with `/game/export/{id}` (no limiter) or the fixtures in `test/`.
    If a live check is genuinely unavoidable: one request, `-o` to a file, and
    write down the time.
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

**Nothing serves the puzzle positions.** *Learn from your mistakes* is computed
in the browser by `retroCtrl` + `nodeFinder`, so there is no endpoint to ask;
what the API serves is the *input* (the per-ply `analysis` array), which we use
unmodified whenever lichess has already analysed a game. Re-deriving the
selection is the point, not a workaround — it has to produce the same deck for
the games nobody has analysed, and `request-analysis` is app-only.

The export does carry lichess' own classification in `judgment`, and it is the
same test as ours arrived at from the other side. From
`modules/tree/src/main/Advice.scala` (read 2026-08-14):
`List(.3 -> Blunder, .2 -> Mistake, .1 -> Inaccuracy)` against
`currentWinningChances - prevWinningChances`. That 0.1 floor is our candidate
threshold: `Advice` measures the delta on a 0..1 scale while ceval's
`povChances` runs -1..1, which is what the `/ 2` in `povDiff` is for. So
"lichess gave it a judgment" and "we call it a candidate" agree by construction
— useful as a cross-check (`npm run verify-analysis` does exactly that), and a
reason to be suspicious if they ever diverge. We select on the swing rather than
on `judgment` because `judgment` only exists for analysed games.

Thresholds that are load-bearing and must not drift silently:
- candidate: `|povDiff('white', prev, curr)| > 0.1`, or prev was mate <= 3 and
  curr is not mate
- accept an alternative move: `povDiff(pov, yourEval, prevEval) > -0.04`

## Difficulty

**Ours, not lila's — lila has only the eval test.** `TOP_LINES` in
`src/solve/retro.ts`: easy `0`, medium `5`, hard `2`. It is a *second* test, not
a replacement: on medium and hard a move must pass the -0.04 eval test **and**
be inside the top n of the engine's ranking of the position. Being ranked fifth
is no defence in a position where only two moves hold.

- Easy is the behaviour that predates the setting, and is the default, so a
  returning player who picks it is where they were.
- `classify` short-circuits first, so the engine's own move and a mate are
  accepted at every setting, and the move played in the game is refused at
  every setting. The gate only ever judges an invented move.

**The ranking is gathered before a position is ever shown, and stored.**
`AnalysisEntry.alts` — ours, absent on everything lichess sent — holds the
engine's `RANK_LINES` (5) best moves from the position *before* that ply, with
the eval each line reaches, best first. `alts[0].uci` is `best`.

This is the load-bearing decision in the whole feature, and it is why:

- **A verdict must not depend on when you solved.** A fresh MultiPV search at
  solve time reorders ranks 2–5 run to run, so the same move would be accepted
  on Tuesday and refused on Wednesday. Stored, the rank is a property of the
  position.
- **It buys depth.** Background work can afford `RANK_MOVETIME` (2 s) where an
  interactive one cannot.
- **The solve loop stops needing an engine.** `judgeRanked` reads rank *and*
  score out of `alts`, so Medium and Hard ask the engine nothing at all. The
  one case left is Easy with a move outside the ranking, where nothing stored
  says what it is worth — `Solve.onRanked` returns `'eval'` for exactly that,
  and only then does `App.judge` search.

**A candidate with no ranking is withheld, not shown unranked** —
`puzzlesFromGame` filters on `alts`. So the ranking is not an enhancement that
can be skipped; it gates the deck. Its counterpart is `unrankedPlies`, which
returns exactly the positions that were withheld, and both go through the same
`chosenCandidates` helper so that what gets ranked is always what would be
shown (the `maxPerGame` cap included — raising it queues work rather than
producing positions instantly, which is a change from when derivation was free).

**Where the ranking comes from.** `analyseGame`'s pass 2 already searched the
before-position for `best` and `variation`, so it now does that search with
MultiPV and writes `alts` from the same result — our own analysis pays almost
nothing extra. Games *lichess* analysed are the expensive case: the export
carries one variation per ply and there is no way to ask for four more, so
every candidate in them needs a `rankCandidates` search that we did not used to
pay. `Pipeline.rankBacklog` does that once per session, before any fetching,
over the stored games; `Pipeline.analyse` does it for newly fetched ones. It is
**not** a re-analysis — the sweep already happened and the candidates are known,
so it is one search per position that would be shown.

**MultiPV is sent on every search**, `analyse` included, because one session is
shared between the background pass and the solve loop and a MultiPV left at 5
would make the sweep about five times slower. Verified against the real engine
by `npm run engine-smoke`: five ranks come back in order, with distinct first
moves and descending White-POV scores; a position with one legal move yields one
line; the next ordinary search is single-line.

`scripts/rank-stability.ts` is what `RANK_MOVETIME` is set from — it ranks a
real game's positions at several budgets against a long reference search and
reports how often the best move, the top 2, and the whole order survive. Re-run
it before changing the number, and keep the copy honest about what it says: the
app tells the player, in Settings and on the notice and under the board, that
this is a seconds-long search and not a deep one.

## This uses the processor, and that is the point

Blindspot is a chess engine running in a tab. Ranking every position before
showing it is CPU work by design, and the app says so rather than hiding it:
the loading screen names the phase, and the landing page says the fan is
supposed to spin. **Do not "fix" this by making the engine do less.** If
something here needs to get cheaper, make it *fewer positions* (the
`maxPerGame` cap) or *better scheduled* (the pipeline yields to the solve loop
between searches), never a shallower ranking — a ranking nobody can trust is
worse than no setting at all.

**Running with no engine is not a supported mode.** It used to be a degraded
one: games lichess had already analysed produced positions for free. That is
over — no engine means no ranking means no deck, for everyone. `engineNag`
therefore says so on every screen and links to a prefilled GitHub issue
carrying the isolation diagnostics, rather than apologising and carrying on.
The three causes (no cross-origin isolation, a service worker that never took
control, a dropped net download) are indistinguishable from the outside, which
is why the link carries the numbers.

The reveal draws the ranking: `Board.reveal` puts numbered arrows on the board
**as it stands** — the position after the move that ended the solve, not the one
the puzzle handed out — so the arrows leave squares their pieces have left,
which reads as "these were the options". Blue fading through the `rank1`..
`rank5` brushes, the move that solved it in green if the engine ranked it, and
the game's move in red on top. Numbered because five shades of one blue is not
a ranking anyone can read, and chessground has no per-shape opacity, so a fade
has to be a brush per step — merged into the defaults by its deep-merging
config.

**How an existing user is told a setting exists.** The same shape as the schema
reset, and the only other thing in the app that gates the front door:
`Settings.difficulty` is **absent** until chosen, and `App.begin` asks
`profile.hasGames()`. Games present and no choice recorded means someone who
has been solving under the old rule, and they get `renderDifficultyNotice`
once — which is also where the catch-up ranking pass is explained, since that
is the visible cost of the change. An *empty* store is a first visit — nothing
to be surprised by — so the default is written silently and the notice never
appears. Without that stamp a new player would meet the notice on their second
visit, announcing a change that never happened to them.

## Browsers that refuse storage

Firefox with cookies blocked for a site throws `SecurityError: The operation is
insecure` when a storage API is **touched** — reading, not just writing. So:

- **Never call a storage API at module scope.** `idb-keyval`'s `createStore`
  opens the database eagerly, and at module scope that throw happens while the
  bundle is being evaluated: nothing renders at all, no board, no error, no
  page. Open on first use. (`src/engine/assetCache.ts` did this and was the
  worst of three such bugs.)
- Every `sessionStorage` / `localStorage` / IndexedDB access is inside a
  `try`, and `Profile` records `available: false` and fails soft rather than
  throwing.
- **Nothing on the boot path may reject.** `ensureIsolation` cannot throw and
  `main.ts` catches anyway; a page that renders without an engine beats a page
  that renders nothing.
- Failing soft is not sufficient on its own: session state that lives only in
  storage stops advancing when writes no-op. The pipeline's paging state
  (`until`, `seen`) is held in memory and written through, or a refill would
  re-fetch and re-analyse the same twenty games forever.

## Storage

- IndexedDB via `idb-keyval`, one store per username. Four keys and no others:
  `game:<id>`, `solve:<gameId>:<ply>`, `meta` (the paging cursor) and `schema`.
- localStorage only for tiny prefs (last username, positions per game, threads,
  difficulty). It is a separate, fixed ~5 MiB box, not a slice of the IndexedDB
  quota. Prefs are per browser, not per username: choosing a difficulty once
  covers every profile, which is why the notice is not shown again after a
  switch. A schema reset takes them with it, so someone who resets comes back
  on Easy without being asked — the reset copy already promises that.
- Call `navigator.storage.persist()` once, or the browser LRU-evicts solve
  history under disk pressure.

**Puzzles are not stored.** They are a view over a stored game, rebuilt by
`puzzlesFromGame` (`src/deck/derive.ts`) every time the deck is built — on
load, and again whenever something that shapes the deck changes. So:

- The durable artefact is the game's **`analysis` field**: lichess' evals if it
  analysed the game, ours written into the same field if it didn't. The payload
  is a download away; the analysis on it is an evening of engine time, so a
  stored game is no longer the cheap half of the store. Nothing purges it
  automatically — `purgeGames` is the Settings button, and its copy says the
  positions go with it, which is now literally true.
- Changing "positions per game" is retroactive, because the cap is applied on
  derivation. Raising it only finds more in games lichess analysed, though:
  `analyseGame`'s `maxCandidates` stops our own pass searching, so the evidence
  for the extra candidates was never gathered.
- Puzzle identity stays `gameId:ply` whatever a puzzle contains, which is why
  `solve:` records survive any change to its shape. Keep it that way.
- The reason this exists: every change to what a puzzle holds used to need a
  migration (`App.withIntro` backfilled the opening animation onto old
  records). Don't reintroduce a stored puzzle to save a derivation.

**`purgeIfTight` is gone and nothing replaced it.** It shed the oldest game
payloads over 80% of quota, which was safe when a payload was a download away
and is not safe now. `storagePressure()` warns instead, on the loading and
solving screens, and the person chooses what goes. Growth is therefore
unbounded: roughly 2.7 KB per game we analyse and 6.6 KB per game lichess had
analysed, so ~1 MB per 200 games — latent, not urgent, but do not add an
automatic purge back without solving "this deletes work the engine did".
`alts` adds roughly 150 bytes per position kept, which is noise against those
figures and is the cheapest part of the store to hold and the dearest to
recreate: two seconds of engine time each, and a purge throws it away.

**Schema resets, `SCHEMA_VERSION` in `src/storage/db.ts`.** There is no
migration machinery and there should not be. `Profile.stale()` is true when a
store holds records but no current stamp; `App.renderReset` says what changed
and why it cannot be converted; `Profile.reset()` clears the store outright and
`forgetPrefs()` takes localStorage with it. **Nothing is carried across, solve
history included.** It could be — a `solve:` key is `gameId:ply`, which is what
a position is rather than what a record of it looked like — and the deliberate
choice is not to: keeping one table across a break leaves every later version
reasoning about a store that is part old and part new, and the deck rebuilt
from re-fetched games is not the deck those solves were taken against. Say it
plainly once. Version 2 was the change to derived puzzles: a version-1 store held
`puzzle:` records nothing reads plus games our engine had analysed whose evals
were never written down and which `meta.analysed` guaranteed would never be
looked at again. Neither is repairable, which is why this is a reset and not a
backfill. Bump the version whenever that is true again.

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
