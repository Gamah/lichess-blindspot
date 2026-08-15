// What is a position that was already decided before the mistake?
//
// `findCandidates` tests only the *swing*, so a game lost at -8 that becomes
// -12 is a candidate exactly like an equal position thrown away. Since
// `judgeEval` measures against the move played rather than against the best
// move, almost every legal move beats a blunder in a hopeless position — so
// those puzzles are a free win that teaches nothing.
//
// This script measures where that starts. For every candidate in a corpus of
// analysed games it ranks the position with the real engine and reports, at
// each level of `povChances(pov, prevEval)`, what share of the engine's own
// five lines would be accepted. A position where all five pass is one the app
// cannot get wrong; a position where one or two pass is a real question.
//
//   node --experimental-strip-types scripts/decided-band.ts [count|gameId...]
//
// With no argument it draws random analysed games from /api/puzzle/next, which
// is not under the export concurrency limiter (see CLAUDE.md). Exports are
// cached under .cache/games/ so a re-run costs no requests. Note the corpus
// bias: puzzle-source games are stronger than a typical history. The share of
// lines that beat a blunder is a property of chess rather than of the corpus,
// but the *distribution* of prevEval is not — read the columns, not the counts.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCandidates, type Candidate } from '../src/analysis/candidates.ts';
import { povChances, povDiff, type Color, type EvalScore } from '../src/analysis/winningChances.ts';
import { replay } from '../src/deck/positions.ts';
import { RANK_LINES, RANK_MOVETIME } from '../src/engine/analyse.ts';
import { UciSession } from '../src/engine/protocol.ts';
import { IMPROVE_DIFF } from '../src/solve/retro.ts';
import { povOf, type ExportedGame } from '../src/lichess/export.ts';
import { parsePgn, relaxedCandidates } from './pgn.ts';

const UA = { 'User-Agent': 'blindspot-band (github.com/Gamah/lichess-blindspot)' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(root, '.cache', 'games');
// Deliberately not inside CACHE: that directory is read back as a list of game
// ids, so anything else living in it becomes a game called `rows`.
const ROWS = join(root, '.cache', 'band-rows.json');
const NNUE_CACHE = join(homedir(), '.local', 'share', 'toolchains', 'nnue');

// The corpus is only usable if the game carries lichess' evals; anything else
// would need a full analysis pass and this is not that script.
const analysed = (g: ExportedGame): boolean => (g.analysis?.length ?? 0) > 0;

// Wide enough to cover an ordinary legal move list, and short because the
// question asked of the far lines is only "does this beat the blunder", not
// where it ranks. Stockfish returns one line per legal move and no more, so
// `all.length` is the legal move count.
const WIDE_LINES = 80;
const WIDE_MOVETIME = 1500;

async function cached(id: string): Promise<ExportedGame> {
  const path = join(CACHE, `${id}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ExportedGame;
  } catch {
    /* not cached yet */
  }
  const res = await fetch(`https://lichess.org/game/export/${id}?evals=true&division=true`, {
    headers: { ...UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`game export ${id} returned ${res.status}`);
  const game = (await res.json()) as ExportedGame;
  await writeFile(path, JSON.stringify(game));
  return game;
}

/** Random analysed games, by way of the puzzle endpoint. Not rate-limited. */
async function sampleIds(want: number): Promise<string[]> {
  const ids = new Set<string>();
  // Whatever is already cached is free, so spend the requests on new games.
  for (const f of await readdir(CACHE)) if (f.endsWith('.json')) ids.add(f.slice(0, -5));
  // Politely: this is not the export limiter, just lichess' ordinary rate
  // limit, and it answers 429 to a tight loop. A minute's wait is what it asks
  // for. Everything fetched stays in the cache, so a run that gives up part
  // way still leaves the next one better off.
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (let tries = 0; ids.size < want && tries < want * 4; tries++) {
    const res = await fetch('https://lichess.org/api/puzzle/next', { headers: UA });
    if (res.status === 429) {
      console.log('\nrate limited, waiting a minute');
      await sleep(65_000);
      continue;
    }
    if (!res.ok) throw new Error(`puzzle/next returned ${res.status}`);
    ids.add(((await res.json()) as { game: { id: string } }).game.id);
    await sleep(2_000);
  }
  return [...ids].slice(0, want);
}

async function bootEngine(): Promise<UciSession> {
  const path = join(root, 'node_modules/@lichess-org/stockfish-web/sf_18_smallnet.js');
  const factory = (await import(path)).default;
  const sf = await factory();
  for (let i = 0; ; i++) {
    const name = sf.getRecommendedNnue(i);
    if (!name) break;
    sf.setNnueBuffer(new Uint8Array(await readFile(join(NNUE_CACHE, name))), i);
  }
  const session = new UciSession((cmd: string) => sf.uci(cmd));
  sf.listen = (line: string) => session.receive(line);
  sf.onError = (msg: string) => console.error('engine error:', msg);
  await session.handshake({ threads: 4, hashMb: 128 });
  return session;
}

interface Row {
  game: string;
  pov: Color;
  index: number;
  played: string;
  /** povChances(pov, prevEval): +1 winning, -1 lost, before the mistake. */
  before: number;
  /** Same, after the move played — how far the mistake actually threw it. */
  after: number;
  /** How many of the engine's five lines `judgeEval` would accept. */
  pass: number;
  lines: number;
  /**
   * The free-win measure: the share of **all legal moves** `judgeEval` would
   * accept. 1.0 means literally any move solves the puzzle, which is what a
   * position that was already decided looks like from the solver's side.
   */
  freeShare: number;
  legal: number;
  judgment: string | undefined;
}

const scoreOf = (l: { score: EvalScore }): EvalScore => l.score;

await mkdir(CACHE, { recursive: true });
const args = process.argv.slice(2);
const count = args.length === 1 && /^\d+$/.test(args[0]!) ? Number(args[0]) : 0;

// A PGN dump plus the name of its player: one person's real history, which is
// the corpus this question actually wants — the puzzle-sourced games are all
// strong players and have no lost middlegames in them at all.
const dump = args.find(a => a.endsWith('.pgn') || a.endsWith('.ndjson'));
const username = dump ? args[args.indexOf(dump) + 1] : undefined;
let corpus: ExportedGame[];
if (dump) {
  if (!username) throw new Error('a PGN dump needs the username to take the point of view of');
  corpus = parsePgn(await readFile(dump, 'utf8'));
} else {
  const ids = count || !args.length ? await sampleIds(count || 12) : args;
  corpus = [];
  for (const id of ids) {
    try {
      corpus.push(await cached(id));
    } catch (e) {
      console.warn('skip', id, String(e));
    }
  }
}
console.log(
  `corpus: ${corpus.length} games${dump ? ` from ${dump}, as ${username}` : ` (cache ${CACHE})`}`,
);

const session = await bootEngine();
const rows: Row[] = [];
let agreed = 0;

for (const game of corpus) {
  const id = game.id;
  if (!analysed(game)) {
    console.warn('skip', id, 'no analysis');
    continue;
  }
  // Both sides, and no `maxPerGame` — the question is which candidates are
  // worth showing, so every one the finder returns has to be measured.
  const moves = game.moves.split(' ').filter(Boolean);
  const fromPly = game.division?.middle;
  let steps;
  try {
    steps = replay(moves, game.initialFen);
  } catch (e) {
    console.warn('skip', id, 'unreplayable', String(e));
    continue;
  }
  // One person's dump is scanned from their side only; a corpus of strangers'
  // games is scanned from both, since neither player is the one solving.
  const sides = dump ? ([povOf(game, username!)].filter(Boolean) as Color[]) : (['white', 'black'] as Color[]);
  for (const pov of sides) {
    const candidates: Candidate[] = dump
      ? relaxedCandidates(moves, game.analysis ?? [], pov)
      : findCandidates(moves, game.analysis ?? [], {
          pov,
          ...(fromPly !== undefined ? { fromPly } : {}),
        });
    for (const c of candidates) {
      const fen = steps[c.index]?.fen;
      if (!fen) continue;
      // Every legal move, in one search. MultiPV wide enough to cover a legal
      // move list is what makes "how much of the board would be accepted"
      // measurable at all: the top five always beat a blunder — that is the
      // design, and it is why they cannot answer this question.
      const all = await session.analyseLines({ fen, movetime: WIDE_MOVETIME, multiPv: WIDE_LINES });
      // The reconstructed `variation.length > 0`: the engine's own first choice
      // being the move played is lila's "no comp child", and such a position is
      // not a candidate however far the eval moved.
      if (all[0]?.pv[0] === steps[c.index]?.uci) {
        agreed++;
        continue;
      }
      const lines = all.slice(0, RANK_LINES);
      const accepted = (l: { score: EvalScore }) => povDiff(pov, scoreOf(l), c.eval) > IMPROVE_DIFF;
      // Exactly `altVerdicts`: the eval test alone, against the move played.
      const pass = lines.filter(accepted).length;
      const freeShare = all.length ? all.filter(accepted).length / all.length : 0;
      rows.push({
        game: game.id,
        pov,
        index: c.index,
        played: c.played,
        before: povChances(pov, c.prevEval),
        after: povChances(pov, c.eval),
        pass,
        lines: lines.length,
        freeShare,
        legal: all.length,
        judgment: c.judgment,
      });
      process.stdout.write('.');
    }
  }
}
console.log(
  `\n\n${rows.length} candidates measured` +
    (agreed ? `, ${agreed} dropped because the engine played the same move` : '') +
    '\n',
);

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');

// The band, as a table. Each row is a slice of "how decided was it already",
// and the columns are what the app can still get wrong there.
const BANDS = [-1, -0.9, -0.8, -0.7, -0.6, -0.5, -0.4, -0.2, 0.2, 0.4, 0.6, 0.8, 1.01];
// `free` is the column that matters: the share of all legal moves the eval
// test would accept. Near 100% the puzzle cannot be failed by anyone who moves
// at all, which is the thing this row set out to withhold.
console.log('before (pov)      n    free   free>90%   free>75%   blunder');
for (let i = 0; i < BANDS.length - 1; i++) {
  const lo = BANDS[i]!;
  const hi = BANDS[i + 1]!;
  const inBand = rows.filter(r => r.before >= lo && r.before < hi);
  if (!inBand.length) continue;
  const avgFree = inBand.reduce((s, r) => s + r.freeShare, 0) / inBand.length;
  const over90 = inBand.filter(r => r.freeShare > 0.9).length;
  const over75 = inBand.filter(r => r.freeShare > 0.75).length;
  const blunder = inBand.filter(r => r.judgment === 'Blunder').length;
  console.log(
    `${lo.toFixed(1)} .. ${hi.toFixed(1)}`.padEnd(16) +
      String(inBand.length).padStart(4) +
      `${(100 * avgFree).toFixed(0)}%`.padStart(8) +
      pct(over90, inBand.length).padStart(11) +
      pct(over75, inBand.length).padStart(11) +
      pct(blunder, inBand.length).padStart(10),
  );
}

// And what a floor would cost, so the number is chosen against the deck it
// leaves rather than against the shape of a curve.
console.log('\nfloor   candidates kept   free>90% among kept   free>90% among dropped');
for (const floor of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
  const kept = rows.filter(r => Math.abs(r.before) < floor);
  const dropped = rows.filter(r => Math.abs(r.before) >= floor);
  const free = (rs: Row[]) => pct(rs.filter(r => r.freeShare > 0.9).length, rs.length);
  console.log(
    `${floor.toFixed(2)}`.padEnd(8) +
      `${kept.length} (${pct(kept.length, rows.length)})`.padStart(17) +
      free(kept).padStart(21) +
      free(dropped).padStart(24),
  );
}

// The question a floor exists to answer: are the free wins actually out at the
// edges? If the worst offenders sit near 0.0 then no floor on `prevEval` can
// find them and the whole idea is misaimed.
const worst = [...rows].sort((a, b) => b.freeShare - a.freeShare).slice(0, 15);
console.log('\nthe 15 freest positions — where a floor would have to reach');
for (const r of worst) {
  console.log(
    `  ${r.game} ${r.pov.padEnd(5)} ply ${String(r.index + 1).padStart(3)} ${r.played.padEnd(6)}` +
      ` before ${r.before.toFixed(2).padStart(5)} after ${r.after.toFixed(2).padStart(5)}` +
      ` free ${(100 * r.freeShare).toFixed(0).padStart(3)}% of ${r.legal}`,
  );
}

await writeFile(ROWS, JSON.stringify(rows, null, 1));
console.log(`\nrows written to ${ROWS}`);
process.exit(0);
