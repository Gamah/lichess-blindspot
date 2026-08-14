// Runs the real Stockfish build against the real protocol wrapper, on node.
//
// The browser is where this code lives, but the engine package builds for node
// too, and the parts most likely to be wrong — the UCI handshake, score
// normalisation, what `bestmove` means when the search is cut off — do not care
// which one they are running on. So they get exercised here rather than
// reviewed.
//
// Not part of `npm test`: it needs the 15 MB net, which it caches outside the
// repo.
//
//   node scripts/engine-smoke.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UciSession } from '../src/engine/protocol.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(homedir(), '.local', 'share', 'toolchains', 'nnue');
const NNUE_BASE = 'https://lichess1.org/assets/lifat/nnue/';

async function net(name) {
  const path = join(CACHE, name);
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    process.stdout.write(`fetching ${name}… `);
    const res = await fetch(NNUE_BASE + name);
    if (!res.ok) throw new Error(`${res.status} fetching ${name}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, bytes);
    console.log(`${bytes.length} bytes, cached`);
    return bytes;
  }
}

const factory = (await import(join(root, 'node_modules/@lichess-org/stockfish-web/sf_18_smallnet.js')))
  .default;
const sf = await factory();
for (let i = 0; ; i++) {
  const name = sf.getRecommendedNnue(i);
  if (!name) break;
  sf.setNnueBuffer(await net(name), i);
}

// The browser's session object, driving the node build of the same engine.
const session = new UciSession(cmd => sf.uci(cmd));
sf.listen = line => session.receive(line);
sf.onError = msg => console.error('engine error:', msg);

await session.handshake({ threads: 2, hashMb: 64 });
console.log('handshake: ok');

const analyse = (fen, limit) => {
  const [kind, value] = limit.split(' ');
  return session.analyse({ fen, [kind]: Number(value) });
};

const cases = [
  // Start of the game: roughly level, and White to move.
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'depth 12', l =>
    Math.abs(l.score.cp) < 100 && l.pv.length > 0],
  // Black is a queen up. White POV means a large *negative* number: if this
  // comes back positive, the normalisation in parseInfo is inverted.
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1', 'depth 12', l => l.score.cp < -500],
  // Mate in one for White, from White's side: Qxf7#.
  ['r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 1', 'depth 12', l =>
    l.score.mate === 1 && l.pv[0] === 'f3f7'],
  // Black to move, a queen down. The UCI score arrives negative (bad for the
  // side to move) and must come out positive, for White.
  ['rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1', 'movetime 500', l => l.score.cp > 500],
  // Checkmate on the board: no move to make, and a score all the same.
  ['rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', 'depth 8', l =>
    l.score.mate === 0 || l.score.cp < -5000],
];

let failed = 0;
for (const [fen, limit, ok] of cases) {
  const started = Date.now();
  const line = await analyse(fen, limit);
  const took = Date.now() - started;
  const verdict = line && ok(line) ? 'ok  ' : 'FAIL';
  if (verdict === 'FAIL') failed++;
  console.log(
    `${verdict} ${limit.padEnd(13)} ${took.toString().padStart(5)}ms  ${JSON.stringify(line?.score)} ${
      line?.pv.slice(0, 3).join(' ') ?? ''
    }`,
  );
}

session.close();
console.log(failed ? `${failed} case(s) failed` : 'all cases ok');
process.exit(failed ? 1 : 0);
