// Runs our own two-pass analysis over a game lichess has already analysed, with
// the real engine, and compares what we find against what lichess found.
//
// This is the closest thing to a test of the whole analysis path that exists
// off a browser: same UciSession, same analyseGame, same findCandidates, real
// Stockfish. It also prints the wall-clock cost per game, which is the number
// the load gate is spending on someone's behalf.
//
//   node --experimental-strip-types scripts/verify-analysis.ts <gameId|file.json>
//
// With no argument it takes the daily puzzle's game, which is always analysed.
// The by-user export is permanently 429 from this host; single-game export is
// not (see CLAUDE.md).

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCandidates, type Candidate } from '../src/analysis/candidates.ts';
import { replay } from '../src/deck/positions.ts';
import { analyseGame, DEEP_MOVETIME, SWEEP_DEPTH } from '../src/engine/analyse.ts';
import { UciSession } from '../src/engine/protocol.ts';
import type { ExportedGame } from '../src/lichess/export.ts';

const UA = { 'User-Agent': 'blindspot-verify (github.com/Gamah/lichess-blindspot)' };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NNUE_CACHE = join(homedir(), '.local', 'share', 'toolchains', 'nnue');

async function loadGame(arg: string | undefined): Promise<ExportedGame> {
  if (arg?.endsWith('.json')) return JSON.parse(await readFile(arg, 'utf8')) as ExportedGame;
  let id = arg;
  if (!id) {
    const daily = await fetch('https://lichess.org/api/puzzle/daily', { headers: UA });
    id = ((await daily.json()) as { game: { id: string } }).game.id;
    console.log(`daily puzzle game: ${id}`);
  }
  const res = await fetch(`https://lichess.org/game/export/${id}?evals=true&division=true`, {
    headers: { ...UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`game export returned ${res.status}`);
  return (await res.json()) as ExportedGame;
}

async function bootEngine() {
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

const show = (c: Candidate): string =>
  `${Math.floor(c.index / 2) + 1}${c.index % 2 === 0 ? '.' : '...'} ${c.played} (best ${c.best})`;

const game = await loadGame(process.argv[2]);
const moves = game.moves.split(' ').filter(Boolean);
const steps = replay(moves, game.initialFen);
const fromPly = game.division?.middle;
console.log(
  `game ${game.id}: ${moves.length} moves, ${game.analysis?.length ?? 0} lichess entries,` +
    ` middlegame at ply ${fromPly ?? '?'}`,
);

const session = await bootEngine();
console.log(`engine: sweep depth ${SWEEP_DEPTH}, deep ${DEEP_MOVETIME}ms\n`);

for (const pov of ['white', 'black'] as const) {
  const theirs = findCandidates(moves, game.analysis ?? [], { pov, fromPly });

  const started = Date.now();
  let deep = 0;
  const analysis = await analyseGame(session, steps, { pov, fromPly });
  const ours = findCandidates(moves, analysis, { pov, fromPly });
  const took = ((Date.now() - started) / 1000).toFixed(1);
  deep = analysis.filter(a => a?.variation).length;

  const theirPlies = new Set(theirs.map(c => c.index));
  const ourPlies = new Set(ours.map(c => c.index));
  const both = [...ourPlies].filter(i => theirPlies.has(i)).length;

  console.log(`${pov}: ${took}s, ${deep} deep-searched plies`);
  console.log(`  lichess found ${theirs.length}: ${theirs.map(show).join(', ') || '—'}`);
  console.log(`  we found      ${ours.length}: ${ours.map(show).join(', ') || '—'}`);
  console.log(`  agreed on ${both} of ${theirPlies.size}\n`);
}

session.close();
