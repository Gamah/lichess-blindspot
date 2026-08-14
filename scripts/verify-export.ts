// Checks a real game export against the field semantics CLAUDE.md claims, since
// those were derived by reading lila rather than from documentation.
//
//   node --experimental-strip-types scripts/verify-export.ts game.json
//
// Fetch a game to test with (the daily puzzle is always from an analysed game):
//   gid=$(curl -s https://lichess.org/api/puzzle/daily | jq -r .game.id)
//   curl -s "https://lichess.org/game/export/$gid?evals=true&division=true" > game.json

import { readFileSync } from 'node:fs';

import { Chess } from 'chessops/chess';
import { INITIAL_FEN, parseFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';
import { makeUci } from 'chessops/util';

import { findCandidates } from '../src/analysis/candidates.ts';
import { replay } from '../src/deck/positions.ts';
import type { ExportedGame } from '../src/lichess/export.ts';

const legalSan = (fen: string, san: string): string | undefined => {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  const move = parseSan(pos, san);
  return move ? makeUci(move) : undefined;
};

const game: ExportedGame = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const analysis = game.analysis ?? [];
const moves = game.moves.split(' ');
const steps = replay(moves, game.initialFen);

console.log(`game ${game.id}  ${moves.length} moves, ${analysis.length} analysis entries`);
console.log(`initial fen: ${game.initialFen ?? '(standard)'}\n`);

let ok = { before: 0, after: 0, bestMatches: 0, differsFromPlayed: 0, withVariation: 0 };

for (const [i, entry] of analysis.entries()) {
  const variation = entry.variation?.split(' ').filter(Boolean) ?? [];
  if (!variation.length) continue;
  ok.withVariation++;

  const beforeFen = steps[i]!.fen;
  const afterFen = steps[i + 1]?.fen ?? INITIAL_FEN;

  // Claim: variation is the engine's line from the position BEFORE this move.
  const uciBefore = legalSan(beforeFen, variation[0]!);
  const uciAfter = legalSan(afterFen, variation[0]!);
  if (uciBefore) ok.before++;
  if (uciAfter) ok.after++;

  // Claim: best is variation[0], as uci.
  if (uciBefore && entry.best === uciBefore) ok.bestMatches++;

  // Claim: a variation is only present when the engine disagreed.
  if (variation[0] !== steps[i]!.san) ok.differsFromPlayed++;
}

const pct = (n: number) => `${n}/${ok.withVariation}`;
console.log(`entries carrying a variation: ${ok.withVariation} of ${analysis.length}`);
console.log(`  variation[0] legal in the position BEFORE the move: ${pct(ok.before)}`);
console.log(`  variation[0] legal in the position AFTER  the move: ${pct(ok.after)}`);
console.log(`  best === uci(variation[0]) from before-position:    ${pct(ok.bestMatches)}`);
console.log(`  variation[0] differs from the move played:          ${pct(ok.differsFromPlayed)}`);

// Claim: eval is white POV. The final eval should favour the winner.
const last = analysis[analysis.length - 1];
console.log(`\nwinner: ${game.winner ?? 'draw'}, status: ${game.status}`);
console.log(`final entry: ${JSON.stringify(last)}`);

for (const pov of ['white', 'black'] as const) {
  const found = findCandidates(moves, analysis, { pov, fromPly: game.division?.middle });
  console.log(`\n${pov} candidates (from ply ${game.division?.middle ?? 1}): ${found.length}`);
  for (const c of found) {
    const moveNo = Math.floor(c.index / 2) + 1;
    console.log(
      `  ${moveNo}${c.index % 2 === 0 ? '.' : '...'} ${c.played}` +
        `  best ${c.variation[0]}  [${c.judgment ?? 'no judgment'}]` +
        `  ${JSON.stringify(c.prevEval)} -> ${JSON.stringify(c.eval)}`,
    );
  }
}
