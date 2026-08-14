// Puzzles are a *view* over a stored game, not a stored thing.
//
// What costs something is the eval array: lichess' when it analysed the game,
// ours written back into the same field when it didn't. That lives on the game
// (`ExportedGame.analysis`) and is the only durable artefact. Everything a
// puzzle holds — the FENs, the SAN, the opening animation, the cap on how many
// come out of one game — is re-derived from it whenever the deck is built.
//
// The point is that changing what a puzzle contains stops needing a migration:
// there is no old record to backfill, because there is no record. Puzzle
// identity is `gameId:ply` either way, so `solve:` history survives untouched.
//
// Pure: no DOM, no engine, no network. Runs under `node --test`.

import { findCandidates } from '../analysis/candidates.ts';
import type { Color } from '../analysis/winningChances.ts';
import { povOf, type ExportedGame } from '../lichess/export.ts';
import { buildPuzzles, type Puzzle } from './build.ts';
import { replay, type ReplayStep } from './positions.ts';

/** Everything both the engine pass and the puzzle build need from a game. */
export interface Prepared {
  pov: Color;
  moves: string[];
  steps: ReplayStep[];
  /**
   * Where the opening stops, from `division.middle`. Ply, not index. This used
   * to be a masters-explorer lookup; see CLAUDE.md for why it isn't.
   */
  fromPly?: number;
}

/**
 * The replay and the checks that decide a game is usable at all: the named
 * player was in it, the variant is one we can replay, and it went past the
 * fourth ply. Undefined when any of that fails — including an unreplayable
 * move list, which means the export and chessops disagree and there is nothing
 * to be done with the game but skip it.
 */
export function prepareGame(game: ExportedGame, username: string): Prepared | undefined {
  const pov = povOf(game, username);
  // Someone else's game (a username that changed case is handled by povOf), or
  // a variant our replay can't play out.
  if (!pov || (game.variant !== 'standard' && game.variant !== 'fromPosition')) return undefined;
  const moves = game.moves?.split(' ').filter(Boolean) ?? [];
  if (moves.length < 4) return undefined;
  try {
    const steps = replay(moves, game.initialFen);
    return { pov, moves, steps, ...(game.division?.middle !== undefined ? { fromPly: game.division.middle } : {}) };
  } catch (e) {
    console.warn('unreplayable game', game.id, e);
    return undefined;
  }
}

export interface DeriveOptions {
  /** 0 or undefined means every candidate the finder returns. */
  maxPerGame?: number;
  /** Stamped on the puzzles; the deck only uses it for display. */
  now?: number;
}

/**
 * The deck's whole build step, for one game. Empty when the game has no
 * analysis yet — a game nobody has evaluated holds no puzzles, and this is not
 * the place that pays for one.
 */
export function puzzlesFromGame(
  game: ExportedGame,
  username: string,
  opts: DeriveOptions = {},
): Puzzle[] {
  if (!game.analysis?.length) return [];
  const prepared = prepareGame(game, username);
  if (!prepared) return [];
  const kept = findCandidates(prepared.moves, game.analysis, {
    pov: prepared.pov,
    ...(prepared.fromPly !== undefined ? { fromPly: prepared.fromPly } : {}),
  });
  // The engine pass already stopped searching once it had this many; a game
  // lichess analysed for us costs nothing to find but is capped too, so a deck
  // looks the same whichever way the evals arrived.
  const max = opts.maxPerGame ?? 0;
  const chosen = max > 0 ? kept.slice(0, max) : kept;
  return buildPuzzles(game.id, prepared.steps, chosen, prepared.pov, opts.now ?? game.createdAt ?? 0);
}
