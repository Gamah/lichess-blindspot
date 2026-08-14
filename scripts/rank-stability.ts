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
//   node --experimental-strip-types scripts/rank-stability.ts [gameId|game.json]

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCandidates } from '../src/analysis/candidates.ts';
import { replay } from '../src/deck/positions.ts';
import { RANK_LINES } from '../src/engine/analyse.ts';
import { UciSession } from '../src/engine/protocol.ts';
import type { ExportedGame } from '../src/lichess/export.ts';

const UA = { 'User-Agent': 'blindspot-verify (github.com/Gamah/lichess-blindspot)' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NNUE_CACHE = join(homedir(), '.local', 'share', 'toolchains', 'nnue');

/** The budgets to compare, and the reference they are compared against. */
const BUDGETS = [500, 1000, 2000, 4000];
const REFERENCE = 12_000;

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

const game = await loadGame(process.argv[2]);
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
const sampled = steps
  .map((step, i) => ({ step, i }))
  .filter(({ i }) => i >= middle && (candidates.has(i) || i % 3 === 0))
  .slice(0, 30);

console.log(`${sampled.length} positions from ${game.id} (${candidates.size} candidates)\n`);

const session = await bootEngine();
const rank = async (fen: string, movetime: number): Promise<string[]> =>
  (await session.analyseLines({ fen, movetime, multiPv: RANK_LINES }))
    .map(l => l.pv[0] ?? '')
    .filter(Boolean);

const tally = new Map(BUDGETS.map(b => [b, { best: 0, top2: 0, overlap: 0, exact: 0, n: 0 }]));

for (const { step, i } of sampled) {
  const reference = await rank(step.fen, REFERENCE);
  const row: string[] = [];
  for (const budget of BUDGETS) {
    const got = await rank(step.fen, budget);
    const t = tally.get(budget)!;
    t.n++;
    if (got[0] === reference[0]) t.best++;
    if (sameSet(got.slice(0, 2), reference.slice(0, 2))) t.top2++;
    t.overlap += got.filter(u => reference.includes(u)).length / Math.max(1, reference.length);
    if (got.join() === reference.join()) t.exact++;
    row.push(`${budget}ms ${got[0] === reference[0] ? '=' : '≠'}`);
  }
  console.log(`ply ${String(i + 1).padStart(3)}  ${row.join('  ')}  ref: ${reference.join(' ')}`);
}

console.log('\nagainst a %ss reference, over %d positions:', REFERENCE / 1000, sampled.length);
console.log('budget   best move   same top 2   top-5 overlap   identical order');
for (const [budget, t] of tally) {
  console.log(
    `${String(budget).padStart(5)}ms   ${pct(t.best / t.n)}        ${pct(t.top2 / t.n)}         ${pct(
      t.overlap / t.n,
    )}           ${pct(t.exact / t.n)}`,
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
