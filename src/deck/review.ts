// What the deck panel shows, worked out away from the DOM.
//
// The rule at the top of `ui/app.ts` decides the whole shape of this, and it is
// worth restating because it is easy to break here of all places: **until a
// position is solved, nothing may say where it came from.** So the two halves
// of the deck cannot be listed the same way.
//
//   waiting  — a count and a spread, no rows. Naming a waiting position is
//              exactly the leak the app exists to avoid, and a list of
//              anonymous rows would be a list of things that cannot be told
//              apart, which is what the shuffle already is.
//   solved   — everything. The game, the opponent, the date, the move number,
//              the swing, how it went. This is the half that makes the feature
//              worth having.
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
   * corruption: a `solve:` record is keyed by `gameId:ply` and outlives
   * everything, so purging the game, or lowering "positions per game" until
   * this one falls outside the cap, leaves a record with no position behind it.
   * The row still appears, because quietly dropping someone's history is worse
   * than a row that says the position is gone.
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
 * All that may be said about the unsolved half. The spread is worth saying —
 * "forty positions, from six games" is a different deck from "forty, from
 * thirty-eight" — and it names no position, so it leaks nothing.
 */
export function waitingSummary(pending: readonly Puzzle[]): WaitingSummary {
  return { count: pending.length, games: new Set(pending.map(p => p.gameId)).size };
}
