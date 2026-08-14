// Two passes over a game, producing exactly the `analysis` array shape the
// lichess export would have given us — so a game we analyse ourselves and a
// game lichess already analysed both feed the one candidate finder.
//
// Pass 1 sweeps every position at a shallow fixed depth. That is enough to see
// where the eval moved, and nothing else. Pass 2 re-searches only the plies
// that moved, on both sides of the move, for the time it takes to be worth
// showing someone: the puzzle's numbers all come from pass 2, so a candidate is
// never accepted on sweep-quality evidence.
//
// Takes an `Analyser` rather than the Engine class, so tests can drive it with
// a table of positions.

import type { Alt, AnalysisEntry } from '../analysis/candidates.ts';
import { povDiff, type Color, type EvalScore } from '../analysis/winningChances.ts';
import { lineToSan, type ReplayStep } from '../deck/positions.ts';
import type { EngineLine, Request } from './protocol.ts';

export interface Analyser {
  analyse(req: Request): Promise<EngineLine>;
  /**
   * The top `req.multiPv` moves, best first. Optional so a test double can be
   * a table of positions and nothing else; the solve loop degrades to the
   * one-line judgement when it isn't there.
   */
  analyseLines?(req: Request): Promise<EngineLine[]>;
}

export interface AnalyseOptions {
  /** Only the plies this side moved can become puzzles, so only they get pass 2. */
  pov: Color;
  /** Skip everything before this ply, for leaving the opening alone. */
  fromPly?: number;
  /**
   * Asked about a ply the sweep flagged, before the expensive second search.
   * The pipeline answers "yes, that is a book move" here, so an opening the
   * engine dislikes costs one explorer lookup rather than two 1-second
   * searches. 0-based index, like everything else in this file.
   */
  skipPly?: (index: number, step: ReplayStep) => Promise<boolean>;
  sweepDepth?: number;
  deepMovetime?: number;
  /**
   * Stop after this many mistakes have been confirmed, leaving the rest of the
   * game unsearched. 0 or undefined means all of them. The sweep still covers
   * the whole game — it has to, since a swing is only visible against the
   * previous ply — but the expensive half stops early.
   */
  maxCandidates?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * Awaited before every search. The solve loop shares this engine, and a
   * person waiting on a verdict should never wait for more than the one search
   * already in flight, so this is where the background work yields.
   */
  beforeEach?: () => Promise<void>;
  signal?: AbortSignal;
}

export const SWEEP_DEPTH = 12;
export const DEEP_MOVETIME = 1000;
/**
 * The ranking search: how many alternatives, and how long they get. This is
 * the number the difficulty gate is built on and the fan of arrows a solved
 * position shows, so it is deliberately more generous than the eval searches
 * either side of it — it is gathered once, in the background, and then it is
 * what every showing of that position uses forever.
 */
export const RANK_LINES = 5;
export const RANK_MOVETIME = 2000;

/** Same test the finder applies, run early to decide what deserves pass 2. */
const moved = (prev: EvalScore, curr: EvalScore): boolean =>
  Math.abs(povDiff('white', prev, curr)) > 0.1 ||
  (prev.mate !== undefined && curr.mate === undefined && Math.abs(prev.mate) <= 3);

export class Aborted extends Error {}

export async function analyseGame(
  engine: Analyser,
  steps: readonly ReplayStep[],
  opts: AnalyseOptions,
): Promise<AnalysisEntry[]> {
  const sweepDepth = opts.sweepDepth ?? SWEEP_DEPTH;
  const movetime = opts.deepMovetime ?? DEEP_MOVETIME;
  const check = async () => {
    await opts.beforeEach?.();
    if (opts.signal?.aborted) throw new Aborted('Analysis cancelled');
  };

  const ours = (i: number): boolean =>
    (i % 2 === 0 ? 'white' : 'black') === opts.pov &&
    (opts.fromPly === undefined || i + 1 >= opts.fromPly);

  // Pass 1. Every position after a move, at a fixed depth. We need index i-1
  // as well as i to see a swing, so the sweep can't be restricted to our plies.
  const analysis: AnalysisEntry[] = [];
  const total = steps.length;
  for (const [i, step] of steps.entries()) {
    await check();
    try {
      const line = await engine.analyse({ fen: step.after, depth: sweepDepth });
      analysis[i] = toEntry(line.score);
    } catch (e) {
      if (e instanceof Aborted) throw e;
      // A position the engine won't score (a finished game, most often) just
      // leaves a hole, the same way lichess' own analysis array does.
      console.warn('no eval for', step.after, e);
    }
    opts.onProgress?.(i + 1, total);
  }

  // Pass 2. Only where the sweep saw the eval move on one of our plies.
  let found = 0;
  for (let i = 1; i < steps.length; i++) {
    if (opts.maxCandidates && found >= opts.maxCandidates) break;
    if (!ours(i)) continue;
    const prev = scoreOf(analysis[i - 1]);
    const curr = scoreOf(analysis[i]);
    if (!prev || !curr || !moved(prev, curr)) continue;
    await check();

    const step = steps[i]!;
    if (opts.skipPly && (await opts.skipPly(i, step))) continue;
    // Before the move: the ranking, which gives us `best`, the line to show,
    // and the alternatives a puzzle is judged against. After it: the eval the
    // mistake actually led to.
    const ranked = await rankPosition(engine, step.fen);
    await check();
    const after = await engine.analyse({ fen: step.after, movetime });

    const before = ranked[0]!;
    // Safe to overwrite outright: i-1 is the other side's ply, so pass 2 never
    // wrote a variation there.
    analysis[i - 1] = toEntry(before.score);
    const best = before.pv[0];
    const entry: AnalysisEntry = toEntry(after.score);
    // An empty variation is the export's way of saying the engine agreed with
    // the move played — the finder reads it as exactly that, so we must write
    // it the same way rather than storing a line nobody should be shown.
    if (best && best !== step.uci) {
      entry.best = best;
      entry.variation = lineToSan(step.fen, before.pv.slice(0, 12)).join(' ');
      entry.alts = toAlts(ranked);
      found++;
    }
    analysis[i] = entry;
  }
  return analysis;
}

/**
 * The ranking search. Falls back to a single line for an `Analyser` that has
 * no `analyseLines` — the test doubles, and nothing in the browser — so a
 * position ranked that way holds one alternative rather than none.
 */
async function rankPosition(engine: Analyser, fen: string): Promise<EngineLine[]> {
  if (engine.analyseLines)
    return engine.analyseLines({ fen, movetime: RANK_MOVETIME, multiPv: RANK_LINES });
  return [await engine.analyse({ fen, movetime: RANK_MOVETIME })];
}

const toAlts = (lines: readonly EngineLine[]): Alt[] =>
  lines
    .filter(l => l.pv[0])
    .map(l => ({
      uci: l.pv[0]!,
      ...(l.score.mate !== undefined ? { mate: l.score.mate } : { eval: l.score.cp! }),
    }));

/** One position that needs ranking: where in the game, and what it looks like. */
export interface RankTask {
  /** 0-based index into `analysis`, i.e. the ply that was the mistake. */
  index: number;
  /** The position *before* the mistake — the one a puzzle hands out. */
  fen: string;
}

/**
 * Fill in `alts` for candidates that have none. That is every game lichess
 * analysed for us — the export carries one variation per ply and there is no
 * way to ask it for four more — and anything we analysed before the ranking
 * existed.
 *
 * Mutates the entries in place, so the caller stores the game again; returns
 * how many positions it ranked. This is the whole of the catch-up pass, and it
 * is deliberately not a re-analysis: the sweep already happened, the candidates
 * are already known, and only the ranking is missing.
 */
export async function rankCandidates(
  engine: Analyser,
  analysis: AnalysisEntry[],
  tasks: readonly RankTask[],
  opts: Pick<AnalyseOptions, 'signal' | 'beforeEach' | 'onProgress'> = {},
): Promise<number> {
  let done = 0;
  for (const task of tasks) {
    await opts.beforeEach?.();
    if (opts.signal?.aborted) throw new Aborted('Analysis cancelled');
    const entry = analysis[task.index];
    if (!entry) continue;
    try {
      entry.alts = toAlts(await rankPosition(engine, task.fen));
      done++;
    } catch (e) {
      if (e instanceof Aborted) throw e;
      // A position the engine won't rank stays unranked, and the puzzle stays
      // withheld. Better than a puzzle whose difficulty gate is a guess.
      console.warn('no ranking for', task.fen, e);
    }
    opts.onProgress?.(done, tasks.length);
  }
  return done;
}

const toEntry = (score: EvalScore): AnalysisEntry =>
  score.mate !== undefined ? { mate: score.mate } : { eval: score.cp! };

const scoreOf = (a: AnalysisEntry | undefined): EvalScore | undefined =>
  !a ? undefined : a.mate !== undefined ? { mate: a.mate } : a.eval !== undefined ? { cp: a.eval } : undefined;
