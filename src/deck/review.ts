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
import type { HideRecord, SolveRecord } from '../storage/db.ts';
import type { Puzzle } from './build.ts';

export interface ReviewRow {
  puzzleId: string;
  /** When the record was written — solved, or put aside. */
  at: number;
  /** 'win' found it, 'view' gave up and looked. Absent on a hidden-but-unsolved one. */
  result?: 'win' | 'view';
  attempts?: number;
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

/** Everything the three lists are built from, indexed once. */
export interface Lookup {
  puzzles: Map<string, Puzzle>;
  games: Map<string, ExportedGame>;
}

export function lookup(puzzles: Iterable<Puzzle>, games: readonly ExportedGame[]): Lookup {
  const byId = new Map<string, Puzzle>();
  for (const p of puzzles) byId.set(p.id, p);
  const byGame = new Map<string, ExportedGame>();
  for (const g of games) byGame.set(g.id, g);
  return { puzzles: byId, games: byGame };
}

const rowOf = (puzzleId: string, at: number, from: Lookup): ReviewRow => {
  const puzzle = from.puzzles.get(puzzleId);
  const game = puzzle ? from.games.get(puzzle.gameId) : undefined;
  return { puzzleId, at, ...(puzzle ? { puzzle } : {}), ...(game ? { game } : {}) };
};

const newestFirst = (rows: ReviewRow[]): ReviewRow[] => rows.sort((a, b) => b.at - a.at);

/**
 * The solved list, newest first. Hidden ones are left out — putting a solved
 * position aside is how you take it off this list, and having it in both would
 * make "hide" look like it did nothing.
 */
export function reviewRows(
  solves: readonly SolveRecord[],
  from: Lookup,
  hidden: ReadonlySet<string> = new Set(),
): ReviewRow[] {
  return newestFirst(
    solves
      .filter(s => !hidden.has(s.puzzleId))
      .map(s => ({ ...rowOf(s.puzzleId, s.at, from), result: s.result, attempts: s.attempts })),
  );
}

/**
 * The put-aside list, most recently hidden first. A hidden position may also
 * have been solved, in which case the row carries how that went — the two facts
 * are independent and both are worth seeing here.
 */
export function hiddenRows(
  hides: readonly HideRecord[],
  solves: readonly SolveRecord[],
  from: Lookup,
): ReviewRow[] {
  const bySolve = new Map(solves.map(s => [s.puzzleId, s]));
  return newestFirst(
    hides.map(h => {
      const solved = bySolve.get(h.puzzleId);
      return {
        ...rowOf(h.puzzleId, h.at, from),
        ...(solved ? { result: solved.result, attempts: solved.attempts } : {}),
      };
    }),
  );
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
