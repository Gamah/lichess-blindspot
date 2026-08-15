// The three formatting helpers that more than one screen needs.
//
// They lived in `app.ts` while the reveal was the only thing that knew where a
// position came from. The deck panel is the second, and it says the same things
// about a solved position — the swing, the game, the link — so they moved here
// rather than being written twice and drifting.

import type { Puzzle } from '../deck/build.ts';

export const escape = (s: string): string =>
  s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export const showEval = (e: { cp?: number; mate?: number }): string =>
  e.mate !== undefined ? `#${e.mate}` : `${e.cp! > 0 ? '+' : ''}${(e.cp! / 100).toFixed(1)}`;

/**
 * `puzzle.ply` is the ply of the *mistake*, and lichess' `#n` fragment selects
 * the position **after** ply n — so linking it lands one move past the puzzle,
 * with the blunder already on the board. `ply - 1` opens the position that was
 * handed out, and stepping forward once is then the reveal.
 */
export const gameUrl = (id: string, puzzle: Puzzle): string =>
  `https://lichess.org/${escape(id)}/${puzzle.pov}#${Math.max(0, puzzle.ply - 1)}`;

/** Move number from ply, the way a scoresheet counts. */
export const moveNumber = (ply: number): number => Math.ceil(ply / 2);
