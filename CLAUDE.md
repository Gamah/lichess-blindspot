# Blindspot

Static site. No backend, ever — if something seems to need one, it doesn't.
Vite + TypeScript, deployed to Cloudflare Pages.

## The contract with lichess

The lichess API is the canonical contract; this file loses to it. Re-derive from
https://lichess.org/api rather than from memory, and from lila source when the
apidoc is silent.

Facts established 2026-08-14 by reading lila at `lichess-org/lila@master`:

- `GET /api/games/user/{u}` is `OpenOrScoped` — **no token required**, games are
  public. Stream throttle, from the apidoc 2026-08-14 (spec 2.0.163): anon
  **20 games/sec**, 30 authenticated, 60 for your own games with a token.
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
- accept an alternative move: `povDiff(pov, yourEval, puzzle.eval) > +0.04`

**That second one is the one place we knowingly leave lila, and the sign is
the whole of it.** retroCtrl compares your move against `prevEval` — the
position *before* the move — which measures it against the **best** move and
allows it to fall 0.04 short. Correct for lila, where retro mode is a walk
through an analysed game. Wrong here: a Blindspot puzzle is "you played this,
play something else", the move played is on the board in red from the first
second, and the question being asked is whether you improved on it. Judged
against `prevEval`, a position with one saving move refuses every other answer
— which on a setting called Easy is near-perfect play rather than leniency,
and is what the port shipped with until it was caught by someone playing the
engine's own second line and being told no.

So the baseline is `puzzle.eval`, the eval after the move played, and the
tolerance flips: `IMPROVE_DIFF = -ACCEPT_DIFF`. It has to flip. Against the
best move you are allowed to be slightly worse; against the mistake, "not
worse" scores a diff of exactly 0 and a move as bad as the blunder would win.
You must beat it by more than the noise. Same 0.04, derived from `ACCEPT_DIFF`
so there is still one number tracking lila.

The measured consequence, on the position that prompted it (`0akgYMDV` ply 40,
Black, `prevEval` +1.33, `f5` played at +4.13):

| move | vs `prevEval` (old) | vs `f5` (now) |
| --- | --- | --- |
| Kh7 (best) | -0.0035 win | +0.1971 win |
| f6 | -0.0736 **fail** | +0.1270 win |
| a4 | -0.0752 **fail** | +0.1254 win |
| c4 | -0.0853 **fail** | +0.1153 win |

**The eval test is now the weak one, and that is deliberate.** It asks only
"did you beat what you played", so it passes a lot. The top-5 / top-2 rank gate
is what Medium and Hard actually rest on; Easy is meant to be forgiving and
previously was not.

**How weak, measured — and it is not weak where you would guess.**
`scripts/decided-band.ts` searches every legal move in a candidate's position
(one wide-MultiPV search) and counts what share of them the eval test accepts.
Over **1136 candidates from 240 real games at ~1100**, 2026-08-15:

| `povChances` before the mistake | n | share of legal moves accepted |
| --- | ---: | ---: |
| -0.8 .. -0.7 | 22 | 38% |
| -0.6 .. -0.5 | 43 | 44% |
| -0.2 .. 0.2 | 422 | 34% |
| 0.4 .. 0.6 | 128 | 29% |
| 0.8 .. 1.0 | 84 | 34% |

**Flat.** "A hopeless position accepts anything" is false, and it was PLAN row
65 until this measured it. Two reasons, both worth keeping:

- **A hopeless position is never a candidate.** `cpWinningChances` clamps at
  ±1000cp and `mateWinningChances` bottoms out at -0.9987, while a candidate
  needs a `povChances` swing over 0.2. So **no candidate can exist beyond
  `|povChances(pov, prevEval)| > 0.7987`** — the clamp eats the swing before
  the position gets that lost. A floor at 0.8 is a provable no-op. Observed
  range over the corpus: -0.80 to +1.00.
- **Most legal moves are terrible.** Beating a blunder still means beating it,
  and roughly two thirds of the board fails to.

Only **30 of the 1136** were free wins (>90% of legal moves accepted), and they
sit at every `prevEval` from -0.68 to +1.00, so no floor finds them: one at 0.5
deletes 30% of the deck to remove 13 of the 30.

**The variable that does predict it is `after`, not `before`** — how bad the
move played was, which is exactly what the test measures against:

| `povChances` after the move played | n | accepted | >75% accepted |
| --- | ---: | ---: | ---: |
| -0.90 .. -0.80 | 62 | 57% | 31% |
| -0.80 .. -0.60 | 237 | 42% | 18% |
| -0.20 .. 0.20 | 287 | 23% | 2% |
| 0.20 .. 0.60 | 76 | 19% | 4% |

Monotone, and it turns back down below -0.95 because the alternatives clamp
too. So the positions the eval test judges most loosely are the ones where the
mistake was worst — which are the most instructive puzzles in the deck, and the
last thing to withhold. If this is ever worth tightening, tighten
`IMPROVE_DIFF` against the headroom the position has; do not filter the deck.

## Difficulty

**Ours, not lila's — lila has only the eval test.** `TOP_LINES` in
`src/solve/retro.ts`: easy `0`, medium `5`, hard `2`. It is a *second* test, not
a replacement: on medium and hard a move must pass the eval test **and** be
inside the top n of the engine's ranking of the position.

Since the eval test only asks "did you beat what you played", the rank gate is
carrying most of the weight — it is what stops Medium and Hard accepting any of
the several moves that beat a blunder. The eval test's remaining job on those
settings is the awkward case the rank gate cannot see: a line the engine
*named* that is still no better than the move that lost the game.

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

**Re-measured 2026-08-15 over a corpus**, which is what that table needed and
did not have: 30 candidate positions, one from each of 30 different games out
of a 240-game PGN dump of one ~1100 player's history, movetime budgets only,
same 12-second reference. The last two columns are the ones this run was for —
how often the *reference's second move* falls outside the budget's top 2 (what
Hard would refuse) and outside its top 5 (what Medium would refuse):

| budget | best move | same top 2 | top-5 overlap | identical order | Hard refuses ref#2 | Medium refuses ref#2 |
| --- | --- | --- | --- | --- | --- | --- |
| 500 ms | 93% | 73% | 93% | 30% | 27% | 0% |
| 1000 ms | 93% | 67% | 95% | 30% | 30% | 0% |
| 2000 ms | 93% | 77% | 96% | 27% | 23% | 0% |
| 4000 ms | 87% | 63% | 95% | 33% | 37% | 0% |

Three things it settles:

- **The one-game table was right about the shape.** Flat. Eight times the
  search time makes every column no better, and the best move is already at
  93% in half a second. The 4000 ms row being the *worst* on three columns is
  the size of the noise, and is the honest answer to "would a bigger number
  help": no, and you cannot tell it from a smaller one.
- **Hard's boundary disagrees with a long search about a quarter to a third of
  the time**, and no budget available to a browser fixes that. It is a property
  of MultiPV rank 2 in ordinary positions, not of `RANK_MOVETIME`. That
  number belongs in the copy, and now is.
- **Medium's does not disagree at all** — 0 of 30 at every budget. The
  reference's second move was always somewhere in the stored top 5. So the two
  settings are not the same claim at different strengths: Medium's top 5 is
  something the search is sure of, and Hard's top 2 is not.

Also worth knowing: `0 skipped`. The run reconstructs lila's "the engine
disagreed with the move played" test against the reference, since PGN carries
no `variation` — and it never fired. A swing over 0.1 in winning chances and
the engine's own first choice being the move played did not co-occur once in
30. The two tests are close to redundant on a real history at this strength.

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

The consequence for Hard is real, measured, and worth stating: its top-2
boundary refuses a move the 12-second reference ranks second **roughly a
quarter to a third of the time**, at every budget. Medium's top 5 refused one
0 times in 30. That asymmetry is the honest description of the two settings and
the copy in Settings and on the notice says it in those words — keep it that
way, and do not let the copy claim a fixed *depth*: the limit is time, which is
device-dependent, and that is written down a few paragraphs up.

## The hint

Lichess' puzzle hint rings the piece to move. Here there is usually more than
one right answer, so it rings **up to five pieces**: `hintSquares`
(`src/solve/retro.ts`) takes the origin square of every ranked line the eval
test accepts, best first, deduplicated — two of the five lines are often the
same piece going to different places, and a hint counts pieces.

- **The eval test alone, not the difficulty gate.** The same decision as
  `altVerdicts` and for the same reason: a hint is then a property of the
  position and says the same thing on Easy as on Hard, rather than shrinking as
  a setting is raised. A ring means "moving this improves on what was played";
  Medium and Hard may still ask that the move be one the engine ranks highly,
  which is what those settings *are*.
- **Never empty.** If no ranked line passes the eval test, `classify` still
  accepts `best` outright, so that piece is the hint. A hint that rings nothing
  would be a lie about a position that has an answer.
- It rings four of five pieces on a position where four lines are sound, and
  that is the honest answer rather than a reason to show fewer.
- `Board.hint` holds the squares the way `Board.mark` holds the red arrow, and
  for the same reason: every `set` clears the shapes and a wrong answer re-sets
  the position, so a hint drawn once would vanish on the first miss after it was
  asked for. Both go through `applyMarks` as **auto**-shapes, so pressing the
  board does not wipe them.

**Asking for one is recorded.** `SolveRecord.hinted` is optional and absent on
every record written before the button existed, which reads as false and is what
it was — no schema bump, and the figures start at zero for a returning player
rather than being wrong. The stats split "found" into `unaided` (no hint, no
solution) and `hinted`, because "found it" and "found it after being shown which
piece" are different results and one figure covering both would flatter.

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
which reads as "these were the options".

**A rank arrow says two independent things, so colour carries only one.** The
fade and the number say *which* line it is; green or red says whether the app
would have accepted it. It was a single blue fade, and that was wrong: MultiPV
returns five lines whether or not five moves are sound, so ranks 3–5 are "the
least bad remaining" and are routinely losing. Drawing them like rank 1 read as
a fan of five options when the position had one move and four ways to throw the
game away — and in the case that prompted this, the game's own blunder *was*
the engine's fourth line, so the fan contained the mistake being reviewed.
`pass1`..`pass5` and `fail1`..`fail5` are the same opacity/lineWidth ramp in
chessground's green and lila's paleRed; `found` is the solving move at full
strength; the game's move stays red on top. Numbered because a fade alone is
not a ranking anyone can read, and chessground has no per-shape opacity, so a
fade has to be a brush per step — merged into the defaults by its deep-merging
config. `rankNumber` sizes the glyph from `RANK_BRUSHES[brush].lineWidth`, so a
brush that is not in that table silently mis-sizes its number.

**The colour is `altVerdicts`, the eval test alone — deliberately not the
difficulty gate.** So it is a property of the position: the same reveal looks
the same on Easy and on Hard, instead of a move changing colour because of a
setting. The numbers already say what a difficulty made of it, and a green 3 on
Hard means "sound, and Hard asked more than sound of you", which is what Hard
is.

**The lichess link is `ply - 1`, not `ply`.** `puzzle.ply` is the ply of the
mistake and lichess' `#n` fragment selects the position *after* ply n, so the
obvious link lands one move late with the blunder already played. `gameUrl`
opens the position that was handed out; stepping forward once is the reveal.

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

**The explanation is reachable after the front door, and there is one copy of
it.** Once a username is typed there is no way back to the landing page except
Switch player, which throws the session away to get there — and someone who
arrives with a name already remembered never sees it at all. So the topbar has
an **About** button, and `src/ui/about.ts` holds `pitch`/`steps`/`fineprint`,
which the landing page and the About panel both assemble. Two copies of an
explanation drift, and the one behind a button is the one nobody would notice
going stale.

About carries three things the landing page cannot, because they are only met
*after* solving starts: what the numbered arrows mean, what Deck does, and why
the machine is working. `#panel` is one element in **three** modes (`App.panel`
says which, `PanelKind`), so opening one closes the others; `panel.about` is the
class that gives prose a measure. Nothing in `about.ts` interpolates anything a
person typed, and so nothing in it escapes anything — keep it that way.

## The deck, looked at rather than dealt from

The **Deck** dialog shows every position in the deck as a board. `#panel` stays
two modes; the deck is a `<dialog>` opened with `showModal()`, and that is not
decoration — it is a grid that runs to hundreds of cards, and reading it must
not push the board being solved off the screen. Native modal also brings the
backdrop, Escape, the focus trap and inerting the page behind it, none of which
a hand-rolled overlay gets right for free.

**The rule at the top of `ui/app.ts` forbids less than it first appears, and
this is where the distinction gets made.** It is about **where a position came
from** — the game, the opponent, the date, the move number, the evaluation —
not about the position itself, which is handed over in full the moment the
puzzle is dealt. So *both* halves of the deck are shown as boards, and they
differ only in what goes around them. An earlier version withheld the unsolved
half entirely, reasoning from the strong reading; that was wrong, and the
argument against it is that a dozen boards side by side tell you no more than
each one does alone, because there is nothing shared between them to read off.

**The dialog is the one place an unsolved position is described, and that is
deliberate.** The rule governs the *solving screen*, where the point is to meet
a position cold. The dialog is the opposite activity: you opened it to look
through what you have, and a list of positions you cannot tell apart is not
something anyone can choose from. So a waiting card carries the same fields as
a solved one — the move played, the move number, the swing, the judgment, the
game and the opponent — **minus the engine's line**, which is the only thing
that would make solving it pointless rather than merely informed. Nothing about
the solving screen changed; it still hands positions over cold.

The boards carry what the solving screen puts on a position when it is dealt:
the check, the squares the opponent's move came from and went to
(`puzzle.intro.uci`), and the red arrow on the move played (`MiniMarks`).

**Hide, and no delete.** `hide:<puzzleId>` is a fourth key kind, and hiding is
the only way a position stops coming round: a puzzle is derived from its game on
every deck build, so there is nothing to delete short of the game. Deleting the
*game* was built and then removed on purpose — it throws away the minutes of
engine time that analysed it, and because `meta.until` has already paged past
it and `meta.analysed` still names it, **the game is not re-fetched and the work
is simply gone**. Hiding does everything wanting-it-gone needs, costs nothing
and is reversible. Purge in Settings remains for reclaiming space, where losing
the analysis is the point rather than a side effect. `Deck.markHidden` is the
in-memory half, applied after `markSolved` so a position that is both stays
counted as solved. `purgeGames`/`forgetGame` take `hide:` keys with them.

A hidden position is left out of the Solved list — having it in both would make
Hide look as though it had done nothing — and the Hidden section carries how the
solve went, if it was ever solved, because those are independent facts.

**`deckStats` is arithmetic over records the app already keeps.** No timing, no
rating, no comparison with anyone: a solve is a result, a number of tries and a
date, so that is all it can honestly report. The band breakdown uses lila's own
`Advice.scala` thresholds (0.3 / 0.2 / 0.1 against the drop in winning chances),
so "you find blunders and miss inaccuracies" is a statement about play rather
than about this app. `now` is a parameter, not a call to the clock, so the
streak is testable; the streak counts from today *or yesterday*, so it is not
broken by the fact that it is nine in the morning.

A record whose position can no longer be derived still counts in the totals — it
happened — but is left out of every breakdown, which needs the position.

All three sections page at `PAGE_SIZE` (12), independently, because each card is a
chessground instance and a few hundred of them built on open is not a dialog
that appears instantly. `clampPage` is applied on render rather than on the
click, so a page held while a purge or a settings change shrank the list lands
on the last page instead of on nothing. The rows are read once per open and held
in `App.deckRows`, dropped on `close` so the next open is fresh.

Three things worth keeping:

- **A replay is not a solve.** `App.replaying` is set by `App.fromDeck` and
  cleared by `nextPuzzle`; `finish` skips `recordSolve` while it is set. Without
  that, going back over a position you found first time and then pressing Show
  solution would overwrite the record with "looked at the answer", which is a
  worse account of what happened than none. The position is already out of the
  shuffle, so the write would buy nothing either. Dealing a *waiting* position
  out of turn is the other door through `fromDeck` and is an ordinary solve:
  `Deck.take` lifts it out of `pending` exactly as `next()` would have.
- **`App.present` is the shared half of `nextPuzzle` and `fromDeck`.** They
  differ only in what the deck did first and whether the result is written down,
  never in what is shown.
- **A solve record can outlive its position, and the row survives that.** A
  `solve:` key is `gameId:ply`, so lowering `maxPerGame` past a ply leaves a
  record with nothing to derive from. `ReviewRow.puzzle` is optional for exactly
  that and the row still renders, saying why, with a "forget this record" button
  — quietly dropping someone's history is worse. Purging no longer causes this;
  see below.

`src/ui/format.ts` exists because of this dialog: `escape`, `showEval`,
`gameUrl` and `moveNumber` were private to `app.ts` while the reveal was the
only screen allowed to know a position's origin. There are two now.

**Purging games takes their solve records with them.** `purgeGames` deletes the
`solve:<gameId>:` keys of every game it drops and returns `{games, solves}`;
`forgetGame` does the same for one. It did not, on the grounds that a record is
tiny and `gameId:ply` is what a position *is* — but deleting a game deletes the
position, so what survived was a record of solving something that no longer
exists: unshowable in the deck dialog, unreplayable, and silently inflating
"bring back solved" with positions that can never come back. Purging is asked
for in order to be rid of something. The copy in Settings, About and
`storagePressure()` says so; it used to promise the opposite ("your solve
history survives either way"), so do not reintroduce that sentence.

A schema reset still takes everything (see `Profile.reset`), and that is
unchanged and unrelated.

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
**Confirmed working in Firefox 2026-08-15** by the person who reported the
original `SecurityError: The operation is insecure`. All three defects were
found by reading rather than by reproduction — there is no Firefox on the dev
host — so the confirmation is the only evidence there is that the reading was
right. It covers ordinary Firefox; the blocked-cookies and private-window cases
behind the original report were never reproduced and never will be from here.

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

**`meta.fetched` means "looked at, found nothing" — and only the engine may
say so.** A game is written to the store the moment it is fetched and analysed
afterwards, so a session whose engine never started used to stamp every game it
touched and walk backwards through the whole history doing it; seen for real on
a phone, seventy games, and the deck never filled again even once there was an
engine. So `Pipeline.analyser()` collapses every reason the engine did not
start into one `NoEngine`, and `drain` on that error stamps nothing, empties the
queue, and sets `engineDown` — which blocks fetching for the rest of the
session, since more payloads nothing can read is not progress. `status()`
reports `noEngine` ahead of everything else so the exhausted screen does not
claim to be fetching.

The repair pass is `Pipeline.sweepBacklog`, and **its work list is derived from
the store, not from a list in `meta`**: a stored game with no analysis that
`prepareGame` accepts is exactly a game that owes the engine a pass. That needs
no new `meta` field and so no schema bump, and — the reason to prefer it — it
heals stores that the broken version *already* stamped, which a list written
from here on could not. `prepareGame` is what keeps a genuinely unplayable game
(wrong variant, four plies, a move list chessops rejects) from being re-queued
every session; it is pure and cheap, so paying it per session is nothing.
`markDone` moves an id between `analysed` and `fetched` rather than adding to
both, because a repaired game is usually already in the wrong one.

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

**Two places in the app are on a hot path, and both are handled by not doing
the work twice.** Everything else renders or derives once and can be as naive
as it likes; do not generalise from these two.

- **The loading screen is built once and patched** (`src/ui/loading.ts`). It is
  driven by the pipeline's progress events, which arrive once per swept
  position — several a second for as long as the analysis runs — and it used to
  answer each one by rewriting the root's `innerHTML`: re-parsing a dozen
  elements and two hundred words of prose to move a bar a pixel. `LoadingScreen`
  owns its DOM, compares each field against what is in it, and `App` only
  assembles values. `attached()` is how it survives another screen taking the
  root without every other `render*` having to know about it.
- **`buildDeck` re-derives only the games that moved.** It runs on every load
  and on every Settings click that shapes the deck, and derivation is a full
  chessops replay: `parseSan` is a move generator and `makeFen` runs twice a
  ply, measured at ~18 µs/ply, so ~450 ms for 200 analysed games of 120 plies on
  the dev host and several times that on a phone — with no spinner behind the
  click. `derivedKey` (`src/deck/derive.ts`) stamps everything
  `puzzlesFromGame` reads: the per-ply score, whether the engine disagreed, the
  ranking and its `altsMs`, plus `maxPerGame`. It has to be a stamp rather than
  object identity, because every rebuild reads fresh objects out of IndexedDB.
  The cache is per profile — two profiles can hold the same game from opposite
  sides — and is rebuilt from the games still present each time, so purging
  prunes it for free.

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
