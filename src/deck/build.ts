// Candidates are per-game and in game order, which is exactly the shape a
// puzzle must not arrive in: consecutive positions from one game leak the game.
// This turns them into standalone records and shuffles them apart.

import type { Alt, Candidate } from '../analysis/candidates.ts';
import type { Color, EvalScore } from '../analysis/winningChances.ts';
import { lineToSan, type ReplayStep } from './positions.ts';

export interface Puzzle {
  /** `${gameId}:${ply}` — stable, so re-analysing a game can't duplicate it. */
  id: string;
  gameId: string;
  /** 1-based, like everywhere else in lichess. */
  ply: number;
  /** The position to solve, i.e. before the mistake. */
  fen: string;
  /**
   * One ply earlier: the position before the opponent's last move, and that
   * move. Played out on the board first, the way a lichess puzzle opens, so a
   * position arrives with a moment of context instead of cold. Optional only
   * for the puzzle records older versions persisted, which may predate it;
   * anything derived here has one.
   */
  intro?: { fen: string; uci: string; san: string };
  /** The side to move, and the side whose blindspot this is. */
  pov: Color;
  /** What was actually played — the one answer that is definitely wrong. */
  played: { san: string; uci: string };
  /** The engine's move, uci. */
  best: string;
  /** The engine's line from `fen`, SAN. */
  pv: string[];
  /** Eval before the mistake and after it, White's point of view. */
  prevEval: EvalScore;
  eval: EvalScore;
  judgment?: string;
  /**
   * The engine's best moves from `fen`, best first, gathered before this
   * position was ever shown. `alts[0].uci` is `best`. The difficulty gate reads
   * the rank of your move out of this and the eval test reads its score, so a
   * solve on Medium or Hard asks the engine nothing at all — and the verdict
   * is the same on every showing, which it would not be if it came from a
   * fresh search each time.
   */
  alts: Alt[];
}

export function buildPuzzles(
  gameId: string,
  steps: readonly ReplayStep[],
  candidates: readonly Candidate[],
  pov: Color,
): Puzzle[] {
  const out: Puzzle[] = [];
  for (const c of candidates) {
    const step = steps[c.index];
    if (!step) continue;
    // Candidates never start at index 0 — a swing needs a previous ply — so
    // there is always an opponent move to show. Guarded anyway.
    const before = steps[c.index - 1];
    out.push({
      id: `${gameId}:${c.index + 1}`,
      gameId,
      ply: c.index + 1,
      fen: step.fen,
      ...(before ? { intro: { fen: before.fen, uci: before.uci, san: before.san } } : {}),
      pov,
      played: { san: step.san, uci: step.uci },
      best: c.best,
      // The export gives the line in SAN already; ours comes from the engine in
      // uci. Re-render from `best` either way so one path can't drift.
      pv: c.variation.length ? c.variation.slice() : lineToSan(step.fen, [c.best]),
      prevEval: c.prevEval,
      eval: c.eval,
      ...(c.judgment ? { judgment: c.judgment } : {}),
      // Derivation withholds a candidate with no ranking, so this is never
      // empty in practice; defaulted rather than asserted because `buildPuzzles`
      // is also what the tests drive directly.
      alts: c.alts ?? [],
    });
  }
  return out;
}

export type Rng = () => number;

/**
 * Shuffle so that no two consecutive puzzles come from the same game, as long
 * as that is possible at all (it isn't when one game holds more than half the
 * deck — then we do as well as the counts allow).
 *
 * Always taking from the largest remaining game is what makes it possible:
 * greedily spending the scarce games first strands the big one at the end.
 */
export function shuffleDeck(puzzles: readonly Puzzle[], rng: Rng = Math.random): Puzzle[] {
  const byGame = new Map<string, Puzzle[]>();
  for (const p of puzzles) {
    const bucket = byGame.get(p.gameId);
    if (bucket) bucket.push(p);
    else byGame.set(p.gameId, [p]);
  }
  for (const bucket of byGame.values()) shuffleInPlace(bucket, rng);

  const out: Puzzle[] = [];
  let last: string | undefined;
  while (byGame.size) {
    const eligible = [...byGame.keys()].filter(id => id !== last);
    const pool = eligible.length ? eligible : [...byGame.keys()];
    const most = Math.max(...pool.map(id => byGame.get(id)!.length));
    const best = pool.filter(id => byGame.get(id)!.length === most);
    const id = best[Math.floor(rng() * best.length)] ?? best[0]!;
    const bucket = byGame.get(id)!;
    out.push(bucket.pop()!);
    if (!bucket.length) byGame.delete(id);
    last = id;
  }
  return out;
}

function shuffleInPlace<T>(items: T[], rng: Rng): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}
