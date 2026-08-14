// Replay a game's SAN into the FENs a puzzle needs. The export gives us moves
// and evals but no positions, so we rebuild them here.

import { Chess } from 'chessops/chess';
import { INITIAL_FEN, makeFen, parseFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import { makeUci, parseUci } from 'chessops/util';

export interface ReplayStep {
  /** FEN of the position *before* this move. */
  fen: string;
  /** The move played, in SAN and UCI. */
  san: string;
  uci: string;
}

/**
 * One step per move. Throws on an illegal or unparseable move, which in
 * practice means the export and our parser disagree — worth failing loudly
 * rather than serving a puzzle from a wrong position.
 */
export function replay(moves: string[], initialFen?: string): ReplayStep[] {
  const setup = parseFen(initialFen ?? INITIAL_FEN).unwrap();
  const pos = Chess.fromSetup(setup).unwrap();
  const steps: ReplayStep[] = [];
  for (const [i, san] of moves.entries()) {
    const fen = makeFen(pos.toSetup());
    const move = parseSan(pos, san);
    if (!move) throw new Error(`Illegal move ${san} at index ${i} in ${fen}`);
    steps.push({ fen, san, uci: makeUci(move) });
    pos.play(move);
  }
  return steps;
}

/** Render a UCI line as SAN from a given position, for showing a solution. */
export function lineToSan(fen: string, ucis: string[]): string[] {
  const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  const out: string[] = [];
  for (const uci of ucis) {
    const move = parseUci(uci);
    if (!move || !pos.isLegal(move)) break;
    out.push(makeSan(pos, move));
    pos.play(move);
  }
  return out;
}
