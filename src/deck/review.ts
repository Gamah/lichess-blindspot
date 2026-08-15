// What the deck panel shows, worked out away from the DOM.
//
// The rule at the top of `ui/app.ts` decides the shape of this, and it is worth
// being precise about what it actually forbids, because the obvious reading is
// too strong: **until a position is solved, nothing may say where it came
// from** — the game, the opponent, the date, the move number, the evaluation.
// It says nothing about the position itself, which is handed over in full the
// moment the puzzle is dealt.
//
// So both halves of the deck can be shown, and they differ only in how much
// goes around the board:
//
//   waiting  — the position, and which side is to move. Nothing else. Seeing a
//              dozen at once adds nothing to seeing one, because there is
//              nothing shared between them to read off.
//   solved   — everything. The game, the opponent, the date, the move number,
//              the swing, how it went. `renderReveal` has already said all of
//              it once.
//
// Pure: no DOM, no engine, no storage. Runs under `node --test`.

import type { ExportedGame } from '../lichess/export.ts';
import type { SolveRecord } from '../storage/db.ts';
import type { Puzzle } from './build.ts';

export interface ReviewRow {
  puzzleId: string;
  /** When it was solved, from the solve record. */
  at: number;
  /** 'win' found it, 'view' gave up and looked. */
  result: 'win' | 'view';
  attempts: number;
  /**
   * The position itself — absent when it can no longer be derived. That is not
   * corruption: a `solve:` record is keyed by `gameId:ply`, so lowering
   * "positions per game" until this one falls outside the cap leaves a record
   * with no position behind it. (Purging the game no longer does — `purgeGames`
   * takes the solve records with it.) The row still appears, because quietly
   * dropping someone's history is worse than a row that says why it is not
   * showing the position.
   */
  puzzle?: Puzzle;
  /** The game it came from, when that is still stored. */
  game?: ExportedGame;
}

/** Newest solve first — the same order as the games and for the same reason. */
export function reviewRows(
  solves: readonly SolveRecord[],
  puzzles: Iterable<Puzzle>,
  games: readonly ExportedGame[],
): ReviewRow[] {
  const byId = new Map<string, Puzzle>();
  for (const p of puzzles) byId.set(p.id, p);
  const byGame = new Map<string, ExportedGame>();
  for (const g of games) byGame.set(g.id, g);
  return solves
    .map(s => {
      const puzzle = byId.get(s.puzzleId);
      const game = puzzle ? byGame.get(puzzle.gameId) : undefined;
      return {
        puzzleId: s.puzzleId,
        at: s.at,
        result: s.result,
        attempts: s.attempts,
        ...(puzzle ? { puzzle } : {}),
        ...(game ? { game } : {}),
      };
    })
    .sort((a, b) => b.at - a.at);
}

export interface WaitingSummary {
  /** Positions still to be solved. */
  count: number;
  /** How many different games they come from. */
  games: number;
}

/**
 * The heading over the unsolved half. The spread is worth saying — "forty
 * positions, from six games" is a different deck from "forty, from thirty-eight"
 * — and it is a fact about the deck rather than about any position in it, so it
 * gives none of them away.
 */
export function waitingSummary(pending: readonly Puzzle[]): WaitingSummary {
  return { count: pending.length, games: new Set(pending.map(p => p.gameId)).size };
}
