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
 * `top` is the engine's moves in its own order, best first. Rank is decided on
 * the move alone: the same move reached by a different move order does not
 * exist here, a uci is a uci.
 */
export function withinTopLines(uci: string, top: readonly string[], lines: number): boolean {
  return lines <= 0 || top.slice(0, lines).includes(uci);
}

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
   * The answer to the 'eval' state, once the local engine has one.
   *
   * `ranked` is the difficulty gate: false means the move was outside the top
   * lines the setting asks for, which fails whatever the eval says — and there
   * is then usually no score to weigh either, because a move the engine did
   * not rank never got one.
   */
  onCeval(yourEval: EvalScore | undefined, ranked = true): Feedback {
    if (this.feedback !== 'eval') return this.feedback;
    this.feedback = ranked && yourEval ? judgeEval(this.puzzle, yourEval) : 'fail';
    return this.feedback;
  }

  viewSolution(): void {
    this.feedback = 'view';
  }
}
