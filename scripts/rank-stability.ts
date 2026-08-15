// How long does the ranking search have to be?
//
// The difficulty gate stands on the engine's top 5 for a position, gathered
// once and then believed forever. `RANK_MOVETIME` is what buys that list, and
// picking it by feel would make the "a deeper search might disagree" caveat a
// guess rather than a measurement. So: rank a real game's positions at several
// budgets, and compare each against a long reference search.
//
// Reports, per budget: how often the best move matches the reference, how often
// the top 2 are the same pair, how much of the top 5 is the same set, and how
// often the whole order is identical. The first two are what Hard rests on; the
// last is what we must not claim.
//
// **And the number Hard actually turns on**, which the first version of this
// did not measure: how often the reference's *second* move falls outside the
// budget's top 2 — i.e. how often Hard refuses a move a long search calls the
// second best. "Same top 2" is a stricter question (the whole pair has to
// match) and answering it does not tell you how often a player is wronged.
// `medium refuses ref#2` is the same question of Medium's top 5.
//
//   node --experimental-strip-types scripts/rank-stability.ts [gameId|game.json]
//   node --experimental-strip-types scripts/rank-stability.ts dump.pgn <username> [--positions N]
//
// The second form is the one worth trusting. A single game is ten positions
// from one opening at one strength; a PGN dump is a real history, which is
// what a browser hands someone who downloads their own games and the only way
// to get a corpus onto this host (see CLAUDE.md on why the by-user export is
// never called from here). `--depth` adds the depth-limited budgets, which are
// slow and were already measured and rejected — see `RANK_MOVETIME`.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCandidates } from '../src/analysis/candidates.ts';
import { replay, type ReplayStep } from '../src/deck/positions.ts';
import { RANK_LINES } from '../src/engine/analyse.ts';
import { UciSession } from '../src/engine/protocol.ts';
import { povOf, type ExportedGame } from '../src/lichess/export.ts';
import type { Color } from '../src/analysis/winningChances.ts';
import { parsePgn, relaxedCandidates } from './pgn.ts';

const UA = { 'User-Agent': 'blindspot-verify (github.com/Gamah/lichess-blindspot)' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NNUE_CACHE = join(homedir(), '.local', 'share', 'toolchains', 'nnue');

/**
 * The budgets to compare, and the reference they are compared against.
 *
 * Depth as well as time, because the ranking is *stored* and then believed on
 * every later showing: with a movetime limit the answer depends on the device
 * that happened to compute it, so a phone would keep a worse top 5 than a
 * desktop forever and Hard would mean something different on each. A depth
 * limit is the same answer everywhere, bought at whatever speed the device
 * manages. What has to be checked is the price.
 */
type Budget = { label: string; req: { movetime?: number; depth?: number } };
const TIME_BUDGETS: Budget[] = [
  { label: '500ms', req: { movetime: 500 } },
  { label: '1000ms', req: { movetime: 1000 } },
  { label: '2000ms', req: { movetime: 2000 } },
  { label: '4000ms', req: { movetime: 4000 } },
];
const DEPTH_BUDGETS: Budget[] = [
  { label: 'depth 16', req: { depth: 16 } },
  { label: 'depth 18', req: { depth: 18 } },
  { label: 'depth 20', req: { depth: 20 } },
];
const REFERENCE = 12_000;
/** Stands in for `division.middle`, which a PGN dump does not carry. Index, not ply. */
const OPENING_FLOOR = 16;

async function loadGame(arg: string | undefined): Promise<ExportedGame> {
  if (arg?.endsWith('.json')) return JSON.parse(await readFile(arg, 'utf8')) as ExportedGame;
  let id = arg;
  if (!id) {
    const daily = await fetch('https://lichess.org/api/puzzle/daily', { headers: UA });
    id = ((await daily.json()) as { game: { id: string } }).game.id;
    console.log(`daily puzzle game: ${id}`);
  }
  // exportOne, which has no concurrency limiter — see CLAUDE.md. Never the
  // by-user export from this host.
  const res = await fetch(`https://lichess.org/game/export/${id}?evals=true&division=true`, {
    headers: { ...UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`game export returned ${res.status}`);
  return (await res.json()) as ExportedGame;
}

async function bootEngine(): Promise<UciSession> {
  const factory = (await import(join(root, 'node_modules/@lichess-org/stockfish-web/sf_18_smallnet.js')))
    .default;
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

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BUDGETS = flag('--depth') ? [...TIME_BUDGETS, ...DEPTH_BUDGETS] : TIME_BUDGETS;
const WANT = Number(value('--positions') ?? 30);

/** One position to measure, and enough about it to print a useful line. */
interface Sample {
  game: string;
  /** 0-based index of the mistake, so the position is `steps[i].fen`. */
  i: number;
  fen: string;
  /** The move actually played, for the reconstructed "the engine disagreed" test. */
  uci: string;
}

const dump = args.find(a => a.endsWith('.pgn'));
let sampled: Sample[];

if (dump) {
  // A real history. Candidates only — a position that would never be handed
  // out is not a position whose ranking has to be stable — and taken one game
  // at a time round the corpus rather than all of the first game, so the
  // sample is not one opening at one time control.
  const username = args[args.indexOf(dump) + 1];
  if (!username || username.startsWith('--'))
    throw new Error('a PGN dump needs the username to take the point of view of');
  const corpus = parsePgn(await readFile(dump, 'utf8'));
  const perGame: Sample[][] = [];
  for (const g of corpus) {
    const moves = g.moves?.split(' ').filter(Boolean) ?? [];
    const pov = povOf(g, username) as Color | undefined;
    if (!pov || g.variant !== 'standard' || moves.length < 4) continue;
    let steps: ReplayStep[];
    try {
      steps = replay(moves, g.initialFen);
    } catch {
      continue;
    }
    // PGN carries `[%eval]` and no `variation`, so the finder's "the engine
    // disagreed" test cannot run here; it is reconstructed below against the
    // reference search, which is the deepest opinion this script owns.
    perGame.push(
      relaxedCandidates(moves, g.analysis ?? [], pov)
        // The app cuts the opening off by `division.middle`, which PGN does not
        // carry, so this is a flat floor in its place. Crude, and only here:
        // without it the sample fills up with book positions the deck would
        // never hand out.
        .filter(c => c.index >= OPENING_FLOOR)
        .map(c => ({ game: g.id, i: c.index, fen: steps[c.index]?.fen ?? '', uci: steps[c.index]?.uci ?? '' }))
        .filter(s => s.fen),
    );
  }
  sampled = [];
  for (let round = 0; sampled.length < WANT; round++) {
    const before = sampled.length;
    for (const list of perGame) {
      if (sampled.length >= WANT) break;
      if (list[round]) sampled.push(list[round]!);
    }
    if (sampled.length === before) break;
  }
  console.log(
    `${sampled.length} candidate positions from ${perGame.filter(l => l.length).length} of ` +
      `${corpus.length} games in ${dump}, as ${username}\n`,
  );
} else {
  const game = await loadGame(args.find(a => !a.startsWith('--')));
  const moves = game.moves?.split(' ').filter(Boolean) ?? [];
  const steps = replay(moves, game.initialFen);
  // Every position a puzzle could be handed out from — the position *before* a
  // candidate move — plus a spread of ordinary middlegame positions, so this is
  // not measured only on the sharp ones.
  const middle = game.division?.middle ?? 20;
  const candidates = new Set(
    findCandidates(moves, game.analysis ?? [], { pov: 'white' })
      .concat(findCandidates(moves, game.analysis ?? [], { pov: 'black' }))
      .map(c => c.index),
  );
  sampled = steps
    .map((step, i) => ({ game: game.id, i, fen: step.fen, uci: step.uci }))
    .filter(({ i }) => i >= middle && (candidates.has(i) || i % 3 === 0))
    .slice(0, WANT);
  console.log(`${sampled.length} positions from ${game.id} (${candidates.size} candidates)\n`);
}

const session = await bootEngine();
const rank = async (fen: string, req: { movetime?: number; depth?: number }) => {
  const started = Date.now();
  const lines = await session.analyseLines({ fen, ...req, multiPv: RANK_LINES });
  return { moves: lines.map(l => l.pv[0] ?? '').filter(Boolean), ms: Date.now() - started };
};

const tally = new Map(
  BUDGETS.map(b => [
    b.label,
    { best: 0, top2: 0, overlap: 0, exact: 0, hardMiss: 0, mediumMiss: 0, ms: 0, n: 0 },
  ]),
);

let agreed = 0;
let measured = 0;
for (const { game: id, i, fen, uci } of sampled) {
  const reference = (await rank(fen, { movetime: REFERENCE })).moves;
  // The reconstructed `variation.length > 0`. lila's rule is that a move the
  // engine would itself have played is not a mistake however far the eval
  // moved, and a PGN corpus has no `variation` to read it off — so it is asked
  // of the reference search, which is the deepest opinion here. A position the
  // engine agrees with would never be handed out, so its ranking's stability is
  // not the question.
  if (reference[0] === uci) {
    agreed++;
    continue;
  }
  measured++;
  const row: string[] = [];
  for (const budget of BUDGETS) {
    const { moves: got, ms } = await rank(fen, budget.req);
    const t = tally.get(budget.label)!;
    t.n++;
    t.ms += ms;
    if (got[0] === reference[0]) t.best++;
    if (sameSet(got.slice(0, 2), reference.slice(0, 2))) t.top2++;
    t.overlap += got.filter(u => reference.includes(u)).length / Math.max(1, reference.length);
    if (got.join() === reference.join()) t.exact++;
    // The verdict Hard and Medium would actually give the reference's second
    // move: refused when the stored ranking does not have it that high.
    const second = reference[1];
    if (second && !got.slice(0, 2).includes(second)) t.hardMiss++;
    if (second && !got.includes(second)) t.mediumMiss++;
    row.push(`${budget.label} ${got[0] === reference[0] ? '=' : '≠'}`);
  }
  console.log(
    `${id} ply ${String(i + 1).padStart(3)}  ${row.join('  ')}  ref: ${reference.join(' ')}`,
  );
}

console.log(
  '\nagainst a %ss reference, over %d positions (%d skipped: the reference played the game move):',
  REFERENCE / 1000,
  measured,
  agreed,
);
console.log(
  'budget      best move  same top 2  top-5 overlap  identical order  hard refuses ref#2  medium refuses ref#2  avg time',
);
for (const [label, t] of tally) {
  if (!t.n) continue;
  console.log(
    `${label.padEnd(10)}  ${pct(t.best / t.n)}       ${pct(t.top2 / t.n)}        ${pct(
      t.overlap / t.n,
    )}          ${pct(t.exact / t.n)}               ${pct(t.hardMiss / t.n)}                 ${pct(
      t.mediumMiss / t.n,
    )}             ${Math.round(t.ms / t.n)}ms`,
  );
}

session.close();
process.exit(0);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(x => b.includes(x));
}

function pct(x: number): string {
  return `${Math.round(x * 100).toString().padStart(3)}%`;
}
