// Port of lila's evalSwings (ui/analyse/src/nodeFinder.ts), expressed over the
// shape the public game export actually hands us, so that lichess-provided
// analysis and our own Stockfish pass feed the same finder.
//
// See CLAUDE.md for the semantics this relies on. Restated, because getting any
// of them wrong produces plausible nonsense:
//   - analysis[i] describes move index i (0-based), i.e. ply i + 1
//   - its `eval` is the score AFTER that move, from WHITE's point of view
//   - its `variation` is the engine's line from the position BEFORE that move,
//     and is empty when the played move was the engine's own first choice.
//     That emptiness is lila's `hasCompChild(prev)` test.
//
// No DOM, no chessops, no network: runs under `node --test`.

import { povDiff, type Color, type EvalScore } from './winningChances.ts';

/** One entry of the `analysis` array from GET /api/games/user/{u}?evals=true */
export interface AnalysisEntry {
  eval?: number; // centipawns, white POV
  mate?: number; // white POV
  best?: string; // uci
  variation?: string; // SAN, space separated, <= 12 plies
  judgment?: { name: string; comment: string };
}

export interface Candidate {
  /** 0-based index into `moves` of the move that was a mistake. */
  index: number;
  /** The mistake, in whatever notation `moves` was given in. */
  played: string;
  /** Engine's move instead, uci. */
  best: string;
  /** Engine's line from the position before the mistake, SAN. */
  variation: string[];
  /** Eval before the mistake, white POV. */
  prevEval: EvalScore;
  /** Eval after the mistake, white POV. */
  eval: EvalScore;
  /** Inaccuracy | Mistake | Blunder, when lichess supplied one. */
  judgment?: string;
}

const score = (a: AnalysisEntry | undefined): EvalScore | undefined => {
  if (!a) return undefined;
  if (a.mate !== undefined) return { mate: a.mate };
  if (a.eval !== undefined) return { cp: a.eval };
  return undefined;
};

/** Whose move is at this 0-based index. */
const moverAt = (index: number): Color => (index % 2 === 0 ? 'white' : 'black');

export interface FindOptions {
  /** Only look at this player's moves. */
  pov: Color;
  /**
   * Skip moves before this ply — lila uses game.division.middle to leave the
   * opening alone. Ply, not index: ply = index + 1.
   */
  fromPly?: number;
}

export function findCandidates(
  moves: string[],
  analysis: readonly AnalysisEntry[],
  opts: FindOptions,
): Candidate[] {
  const out: Candidate[] = [];
  // From index 1: index 0 has no preceding move to compare against. lila starts
  // at mainline.slice(1) and compares against a root whose eval is the score
  // after ply 1, which makes first-move "swings" meaningless. We just skip them.
  for (let i = 1; i < moves.length; i++) {
    if (moverAt(i) !== opts.pov) continue;
    if (opts.fromPly !== undefined && i + 1 < opts.fromPly) continue;

    const entry = analysis[i];
    const prev = score(analysis[i - 1]);
    const curr = score(entry);
    if (!entry || !prev || !curr) continue;

    // Empty variation means the engine agreed with the move played.
    const variation = entry.variation?.split(' ').filter(Boolean) ?? [];
    if (!variation.length || !entry.best) continue;

    const swing = Math.abs(povDiff('white', prev, curr)) > 0.1;
    const lostMate = prev.mate !== undefined && curr.mate === undefined && Math.abs(prev.mate) <= 3;
    if (!swing && !lostMate) continue;

    out.push({
      index: i,
      played: moves[i]!,
      best: entry.best,
      variation,
      prevEval: prev,
      eval: curr,
      judgment: entry.judgment?.name,
    });
  }
  return out;
}
