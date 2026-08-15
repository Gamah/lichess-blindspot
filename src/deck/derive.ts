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
import type { RankTask } from '../engine/analyse.ts';
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
  /**
   * Re-rank anything given less time than this. Only `unrankedPlies` uses it:
   * a quick ranking is still a ranking, so the deck keeps showing the position
   * while the better one is being worked out.
   */
  minMs?: number;
}

/**
 * The candidates this game would contribute, in order and already capped. The
 * step between "the finder found it" and "it can be shown": both the deck and
 * the ranking backlog work from this list, so the position that gets ranked is
 * always the position that would be shown.
 */
function chosenCandidates(game: ExportedGame, username: string, opts: DeriveOptions) {
  if (!game.analysis?.length) return undefined;
  const prepared = prepareGame(game, username);
  if (!prepared) return undefined;
  const kept = findCandidates(prepared.moves, game.analysis, {
    pov: prepared.pov,
    ...(prepared.fromPly !== undefined ? { fromPly: prepared.fromPly } : {}),
  });
  // The engine pass already stopped searching once it had this many; a game
  // lichess analysed for us costs nothing to find but is capped too, so a deck
  // looks the same whichever way the evals arrived.
  const max = opts.maxPerGame ?? 0;
  return { prepared, chosen: max > 0 ? kept.slice(0, max) : kept };
}

/**
 * The deck's whole build step, for one game. Empty when the game has no
 * analysis yet — a game nobody has evaluated holds no puzzles, and this is not
 * the place that pays for one.
 *
 * A candidate with no ranking is **withheld**, not shown unranked: the whole
 * point of gathering `alts` up front is that a position arrives knowing what
 * the engine's five best moves are, and a puzzle that does not know cannot be
 * judged on Medium or Hard, cannot draw its arrows, and would answer
 * differently on a later showing. `unrankedPlies` is how it gets un-withheld.
 */
export function puzzlesFromGame(
  game: ExportedGame,
  username: string,
  opts: DeriveOptions = {},
): Puzzle[] {
  const found = chosenCandidates(game, username, opts);
  if (!found) return [];
  const ranked = found.chosen.filter(c => c.alts?.length);
  return buildPuzzles(game.id, found.prepared.steps, ranked, found.prepared.pov);
}

/**
 * A stamp of everything `puzzlesFromGame` would read off this game, cheap
 * enough to compute on every deck build.
 *
 * The deck is rebuilt from storage on every load and on every Settings click
 * that shapes it, and the rebuild is not free: `prepareGame` replays the whole
 * game through chessops, where `parseSan` is a full move generator and
 * `makeFen` runs twice a ply — measured at ~18 µs a ply, so ~450 ms for 200
 * analysed games of 120 plies on a dev machine and several times that on a
 * phone, blocking the thread with no spinner behind it. Almost all of that work
 * is repeated: nothing about a stored game changes between two rebuilds unless
 * the engine has been at it.
 *
 * So the caller keeps the derived puzzles and re-derives only when this stamp
 * moves. It has to be a stamp rather than object identity, because every
 * rebuild reads fresh objects out of IndexedDB. What it covers is what the
 * finder and the build actually consume — the score, whether the engine
 * disagreed with the move, the ranking and how long the ranking got — plus the
 * cap, which is retroactive. Everything else about a game (its moves, its
 * variant, its division) is fixed from the moment it was fetched, and the id
 * covers those.
 */
export function derivedKey(game: ExportedGame, opts: DeriveOptions = {}): string {
  const analysis = game.analysis;
  const head = `${game.id}|${opts.maxPerGame ?? 0}`;
  if (!analysis?.length) return `${head}|none`;
  const parts = [head, String(analysis.length)];
  for (const entry of analysis)
    parts.push(
      `${entry.eval ?? ''},${entry.mate ?? ''},${entry.variation ? 1 : 0},${
        entry.alts?.length ?? 0
      },${entry.altsMs ?? 0}`,
    );
  return parts.join('|');
}

/**
 * The positions in this game that would be puzzles if they had been ranked.
 * Empty for a game that is fully ranked, which is the common case and is why
 * the backlog pass can walk the whole store cheaply.
 */
export function unrankedPlies(
  game: ExportedGame,
  username: string,
  opts: DeriveOptions = {},
): RankTask[] {
  const found = chosenCandidates(game, username, opts);
  if (!found) return [];
  const minMs = opts.minMs ?? 0;
  return found.chosen
    .filter(c => !c.alts?.length || (c.altsMs ?? 0) < minMs)
    .map(c => ({ index: c.index, fen: found.prepared.steps[c.index]?.fen ?? '' }))
    .filter(task => task.fen);
}
