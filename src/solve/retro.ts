// Port of the judging half of lila's ui/analyse/src/retrospect/retroCtrl.ts.
// Its other half — walking a move tree, jumping paths, drawing shapes — is
// lila's, not ours: we hand out one position at a time and there is nowhere to
// go off-track to. What survives is the part that decides whether a move you
// found is good enough, and that is kept move for move:
//
//   found in the opening explorer, or mate, or the engine's own move -> win
//   the move you actually played in the game                         -> fail
//   anything else                                                    -> ask
//                                                                       ceval
//
// See CLAUDE.md: -0.04 is load-bearing and comes straight from retroCtrl.

import type { Alt } from '../analysis/candidates.ts';
import { povDiff, type EvalScore } from '../analysis/winningChances.ts';
import type { Puzzle } from '../deck/build.ts';

export type Feedback = 'find' | 'eval' | 'win' | 'fail' | 'view';

/** retroCtrl: `if (diff > -0.04) onWin(); else onFail();` */
export const ACCEPT_DIFF = -0.04;

/**
 * Ours, not lila's — lila only has the eval test above.
 *
 * The eval test asks "did that throw anything away", which in a position with
 * several sound moves accepts all of them. That is the right question for a
 * mistake-review tool and it is what Easy keeps. The harder settings ask a
 * second, narrower one: is this a move the engine itself would name, i.e. is
 * it inside the top few lines of a MultiPV search of the position.
 *
 * 0 means no such test. Both tests must pass on medium and hard: being ranked
 * fifth is no defence in a position where only two moves hold.
 */
export type Difficulty = 'easy' | 'medium' | 'hard';

export const TOP_LINES: Record<Difficulty, number> = { easy: 0, medium: 5, hard: 2 };

/** How many lines the board draws on a solved position, whatever the setting. */
export const SHOWN_LINES = 5;

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

export const isDifficulty = (value: unknown): value is Difficulty =>
  DIFFICULTIES.includes(value as Difficulty);

/**
 * Where this move sits in the engine's own order, 0-based, or -1. Rank is
 * decided on the move alone: the same move reached by a different move order
 * does not exist here, a uci is a uci.
 */
export const rankOf = (uci: string, alts: readonly Alt[]): number =>
  alts.findIndex(a => a.uci === uci);

export function withinTopLines(uci: string, alts: readonly Alt[], lines: number): boolean {
  if (lines <= 0) return true;
  const rank = rankOf(uci, alts);
  return rank >= 0 && rank < lines;
}

/**
 * The whole verdict on an invented move at a given difficulty, decided from
 * what the puzzle already carries — no engine, because the ranking was
 * gathered before the position was ever shown.
 *
 * `outside` means the engine did not rank the move at all, so there is no
 * score for it and no verdict to give from here: Easy has to go and search it,
 * and the harder settings do not have to, because not being ranked is already
 * the answer.
 */
export function judgeRanked(
  puzzle: Puzzle,
  uci: string,
  lines: number,
): { verdict: 'win' | 'fail'; rank: number } | { verdict: 'outside'; rank: -1 } {
  const rank = rankOf(uci, puzzle.alts);
  if (rank < 0) return lines > 0 ? { verdict: 'fail', rank: -1 } : { verdict: 'outside', rank: -1 };
  if (!withinTopLines(uci, puzzle.alts, lines)) return { verdict: 'fail', rank };
  // Inside the ranking, the eval test still has to pass: being fifth-best is
  // no defence in a position where only two moves hold.
  return { verdict: judgeEval(puzzle, scoreOf(puzzle.alts[rank]!)), rank };
}

const scoreOf = (alt: Alt): EvalScore =>
  alt.mate !== undefined ? { mate: alt.mate } : { cp: alt.eval ?? 0 };

/**
 * The eval verdict on every ranked line, best first — what the reveal colours
 * its arrows by.
 *
 * The eval test only, without any difficulty gate: this asks "is the move
 * sound", which is a property of the position, and the ranks themselves say
 * what a setting would have made of it. Being ranked at all means nothing —
 * MultiPV fills five slots whether or not five moves hold, so this is
 * routinely `[true, true, false, false, false]`, and that is the thing the
 * board has to be able to say.
 */
export const altVerdicts = (puzzle: Puzzle): boolean[] =>
  puzzle.alts.map(alt => judgeEval(puzzle, scoreOf(alt)) === 'win');

export interface Move {
  uci: string;
  san: string;
}

/**
 * Everything that can be decided without an engine. 'eval' means "no verdict
 * yet, go and analyse the position this move led to".
 */
export function classify(
  puzzle: Puzzle,
  move: Move,
  openingUcis: readonly string[] = [],
): 'win' | 'fail' | 'eval' {
  if (openingUcis.includes(move.uci)) return 'win';
  if (move.san.endsWith('#')) return 'win'; // checkmate ends the game
  if (move.uci === puzzle.best) return 'win'; // the comp solution line
  if (move.uci === puzzle.played.uci) return 'fail'; // the move played in the game
  return 'eval';
}

/**
 * `yourEval` is the score after your move, White's point of view, like
 * everything else here. Compared against the position you were given, so this
 * asks "did that throw anything away", not "was that the best move".
 */
export function judgeEval(puzzle: Puzzle, yourEval: EvalScore): 'win' | 'fail' {
  return povDiff(puzzle.pov, yourEval, puzzle.prevEval) > ACCEPT_DIFF ? 'win' : 'fail';
}

/**
 * The state around those two, for the UI to hold. One puzzle; the deck decides
 * what comes next.
 */
export class Solve {
  feedback: Feedback = 'find';
  /** Set on a fail, so the board can show what went wrong before resetting. */
  lastAttempt: Move | undefined;
  /** Where the last attempt sat in the engine's order, 0-based, or -1. */
  rank = -1;

  readonly puzzle: Puzzle;
  readonly openingUcis: readonly string[];

  constructor(puzzle: Puzzle, openingUcis: readonly string[] = []) {
    this.puzzle = puzzle;
    this.openingUcis = openingUcis;
  }

  /** Solving means we are still accepting moves — 'fail' is a retry, not an end. */
  isSolving(): boolean {
    return this.feedback === 'find' || this.feedback === 'fail';
  }

  /** Solved one way or another, so it should leave the shuffle. */
  isDone(): boolean {
    return this.feedback === 'win' || this.feedback === 'view';
  }

  play(move: Move, openingUcis: readonly string[] = this.openingUcis): Feedback {
    if (!this.isSolving()) return this.feedback;
    this.lastAttempt = move;
    const verdict = classify(this.puzzle, move, openingUcis);
    this.feedback = verdict;
    return verdict;
  }

  /**
   * The difficulty gate, decided from what the puzzle already carries — no
   * engine. Returns 'eval' when there is a search still to do, which is now
   * only ever one case: Easy, and a move the engine did not rank, so nothing
   * stored says what it is worth.
   *
   * On Medium and Hard that case cannot arise, because not being ranked is
   * itself the answer. So the harder the setting, the less the solve loop asks
   * of the engine.
   */
  onRanked(lines: number): Feedback {
    if (this.feedback !== 'eval' || !this.lastAttempt) return this.feedback;
    const judged = judgeRanked(this.puzzle, this.lastAttempt.uci, lines);
    this.rank = judged.rank;
    if (judged.verdict === 'outside') return 'eval';
    this.feedback = judged.verdict;
    return this.feedback;
  }

  /** The answer to a leftover 'eval', once the local engine has one. */
  onCeval(yourEval: EvalScore): Feedback {
    if (this.feedback !== 'eval') return this.feedback;
    this.feedback = judgeEval(this.puzzle, yourEval);
    return this.feedback;
  }

  viewSolution(): void {
    this.feedback = 'view';
  }
}
