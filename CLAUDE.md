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

**Finding a position and ranking it are separate searches, deliberately.**
`analyseGame`'s pass 2 searches the same position the ranking wants — the one
before the mistake — and folding the two together is the obvious saving and the
wrong one: pass 2's two searches are *subtracted from each other* to measure
the swing, and a MultiPV search on one side of that subtraction against a
single-line one on the other biases every candidate decision it makes. So pass
2 stays exactly as `npm run verify-analysis` verified it, and `rankCandidates`
is a third pass over what pass 2 confirmed. It also means the ranking's cost and
depth can move without disturbing lila's thresholds.

Every game therefore takes the same ranking path, whoever did the analysis:
`Pipeline.rankBacklog` walks the stored games once per session before any
fetching, and `Pipeline.analyse` handles newly fetched ones. Games lichess
analysed are the expensive case only because they arrive with *no* rankings at
all — the export carries one variation per ply and no way to ask for four more.
It is **not** a re-analysis: the sweep already happened and the candidates are
known, so it is one search per position that would be shown, roughly 2 s each.
`Pipeline.recheckBacklog()` reopens the pass, which raising `maxPerGame` has to
do — the extra candidates it allows have never been ranked.

**MultiPV is sent on every search**, `analyse` included, because one session is
shared between the background pass and the solve loop and a MultiPV left at 5
would make the sweep about five times slower. Verified against the real engine
by `npm run engine-smoke`: five ranks come back in order, with distinct first
moves and descending White-POV scores; a position with one legal move yields one
line; the next ordinary search is single-line.

`scripts/rank-stability.ts` is what `RANK_MOVETIME` is set from — it ranks a
real game's positions at several budgets against a long reference search and
reports how often the best move, the top 2, and the whole order survive.

**Measured 2026-08-14**, 10 midgame positions from one game (`NIvSfA68`), 4
threads, against a 12-second reference:

| budget | best move | same top 2 | top-5 overlap | identical order | avg time |
| --- | --- | --- | --- | --- | --- |
| 1000 ms | 100% | 70% | 96% | 10% | 0.9 s |
| 2000 ms | 100% | 90% | 94% | 40% | 1.8 s |
| depth 16 | 100% | 70% | 96% | 10% | 3.5 s |
| depth 18 | 100% | 70% | 94% | 30% | 11.9 s |
| depth 20 | 100% | 70% | 94% | 20% | 25.9 s |

Small sample, so read the shape and not the digits. Two things decided the
design:

**Spending more does not buy a better ranking.** The best move is already
settled at 1 s, and the exact order is not settled anywhere — a re-run moved
the *reference's* own top two. Do not reach for a bigger number expecting the
ranking to firm up; the variance is the positions and the thread
nondeterminism, not the budget.

**Depth was tried and rejected.** It is the theoretically better limit for
something stored and then trusted forever — the same setting means the same
ranking on a phone as on a desktop, instead of the phone keeping a worse one —
and it costs fourteen times as much for no measured gain. Depth 20 is 26
seconds a position, i.e. hours per hundred games and most of a day on a phone.
So the limit is time, `altsMs` records what each position was given, and the
device-dependence is accepted and written down here rather than paid for.
(Note the confound before re-deriving this: the reference is itself a movetime
search, which flatters movetime budgets. It does not flatter them by 14×.)

The consequence for Hard is real and worth stating: its top-2 boundary
disagrees with a longer search perhaps a tenth to a third of the time, so it
will sometimes refuse a move a stronger engine ranks second. That is why the
copy in Settings, on the notice, and under the board says this is a
seconds-long search and not an exhaustive one — keep it honest.

## The settings, and what each one is allowed to touch

Four dials, and the boundaries between them are the design:

- **Difficulty** — the verdict only. Reads the stored ranking; changes nothing
  about what is stored or fetched, so it takes effect on the next move tried.
- **Thinking time per position** (`rankMs`) — the *ranking* search only, one
  position at a time. **Not the sweep**, which is a fixed shallow pass over
  every ply and is the wrong place to spend; and **not** pass 2's confirming
  pair, because those decide *whether* a position is a puzzle at all and a
  dial there would silently change which mistakes the deck contains rather than
  how well they are understood. Raising it re-queues everything ranked in less
  (`unrankedPlies` compares `altsMs`); lowering it leaves better work alone,
  because a longer ranking is not worse.
- **Positions per game** (`maxPerGame`) — how many candidates a game may
  contribute. Retroactive on the deck; raising it queues ranking work.
- **Games to keep** (`maxGames`) — a **limit, not a budget**. Reaching it stops
  new games being fetched; it never deletes what is held, because a stored game
  carries minutes of engine time that cannot be fetched back. `Pipeline.full`
  is that state and it gets its own sentence on the exhausted screen, separate
  from "lichess has no more games". Purge in Settings is the manual answer, and
  `recheckFull()` un-sticks the pipeline after either that or a raise. Counted
  in games rather than megabytes so it can be enforced exactly and still works
  in a browser that will not report a quota; a first visit **on a phone** is
  stamped with `MOBILE_GAME_LIMIT` rather than unlimited, since that is where
  an unbounded database is both slowest to build and likeliest to be evicted
  wholesale.

## This uses the processor, and that is the point

Blindspot is a chess engine running in a tab. Every position is searched
before anyone is shown it, and that is CPU work by design.

What it costs, per candidate position, all of it background and none of it
while someone is looking at a board:

| | |
| --- | --- |
| sweep (pass 1) | ~0.1 s **per ply of the game**, depth 12, single line |
| confirm the swing (pass 2) | ~1 s + ~1 s, single line, both sides of the move |
| rank it (`rankCandidates`) | one search of `rankMs` (default 2 s), MultiPV 5 |

At the default three positions a game that is roughly a dozen seconds of engine
time per game, plus the sweep. A first run over a long history is therefore
tens of minutes of sustained load, and **that is fine** — it is what the app
is. Solving costs nothing on Medium and Hard, where the verdict comes off the
stored ranking; Easy still pays one ~1 s search for a move the engine did not
rank.

**Do not "fix" this by making the engine do less.** If something has to get
cheaper, make it *fewer positions* (the `maxPerGame` cap) or *better scheduled*
(the pipeline yields to the solve loop between searches), never a shorter
ranking search than the measurements support — a ranking nobody can trust is
worse than no setting at all. The person may spend less if they choose to;
that is what the setting is for, and it is their battery.

Say it, rather than hiding it. The loading screen names the phase and the count
remaining, the landing page says the work is supposed to be happening, and
`batteryWarning()` tells a phone plainly that this will run it hard and is
worth plugging in for. That warning is best-effort by construction:
`navigator.userAgentData.mobile` where it exists (Chromium only) and a
user-agent sniff behind it, both inside a `try`, because nothing on the boot
path may throw — and it errs towards warning, since a laptop shown it has
merely read something irrelevant while a phone denied it gets a hot device and
no explanation.

**Running with no engine is not a supported mode.** It used to be a degraded
one: games lichess had already analysed produced positions for free. That is
over — no engine means no ranking means no deck, for everyone. `engineNag`
therefore says so on every screen and links to a prefilled GitHub issue
carrying the isolation diagnostics, rather than apologising and carrying on.
The three causes (no cross-origin isolation, a service worker that never took
control, a dropped net download) are indistinguishable from the outside, which
is why the link carries the numbers.

**The move played in the game is drawn in red from the start**, not held back
until the solve is over. It is the one answer `classify` can never accept, so
hiding it does not make the position harder — it makes it longer, for exactly
the people who do not remember the game being shown, which is most of them.
`Board.mark` holds it across every `set`, because a wrong answer re-sets the
position and would otherwise wipe it. That is the single exception to the rule
at the top of `ui/app.ts`; everything else about where a position came from
still waits for `renderReveal`. It is meant to become a setting, default on —
it is not one yet, so don't infer one from the code.

The reveal draws the ranking: `Board.reveal` puts numbered arrows on the board
**as it stands** — the position after the move that ended the solve, not the one
the puzzle handed out — so the arrows leave squares their pieces have left,
which reads as "these were the options". Blue fading through the `rank1`..
`rank5` brushes, the move that solved it in green if the engine ranked it, and
the game's move in red on top. Numbered because five shades of one blue is not
a ranking anyone can read, and chessground has no per-shape opacity, so a fade
has to be a brush per step — merged into the defaults by its deep-merging
config.

The numbers are a `customSvg`, not chessground's `label`: `renderLabel`
hardcodes a white-outlined disc behind the text, and five of those read as a
row of buttons rather than a ranking. Plain white glyph, no outline, at full
opacity whatever the brush does, so rank 5 is still readable at 0.28.

Its size and position come out of the arrowhead's geometry rather than taste,
because **the head shrinks with the rank** — the brushes thin as they fade, and
one fixed size sits neatly in the first arrow and overflows the fifth. The
marker path is `M0,0 V4 L3,2 Z` with default `markerUnits`, so a head is `3 *
lineWidth / 64` of a square long and `4 *` that tall at its base. `center:
'label'` anchors the box at `labelCoords`, a flat `33/64` back from the
destination square, and the head's position comes from **`refX: 2.05`** — the
marker point that lands on the line's end, which is itself `10/64` short of the
square. In stroke-widths the base is 2.05 behind that anchor, the tip 0.95
beyond it, and the centroid 1.05 behind, so the offset to aim for is `(23 -
1.05 * lineWidth) / 64`. Assume instead that the tip is at the line's end and
you land ~16 units short — which is exactly on the base of the triangle, and is
the bug this went through twice. (When two arrows share a destination both
offsets grow by `10/64` and cancel, so shortening needs no special case;
chessground's extra `0.4` for a boxed-in knight move is not modelled.) Sizing
at `2.2 * lineWidth` puts every glyph at about half the head's height there,
whatever its rank.

**Draw anything that must survive as an auto-shape.** Pressing the board runs
chessground's `drawClear`, which empties `drawable.shapes` but leaves
`autoShapes` alone — so a reveal drawn with `setShapes` vanishes the moment
someone touches the board to look at it. That was a real bug, found by
touching the board.

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
recreate: seconds of engine time each, and a purge throws it away. Growth is no
longer strictly unbounded either — `maxGames` stops it — but the stopping is
"fetch no more", never "delete the oldest", for that same reason.

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
