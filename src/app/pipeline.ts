// Fetch -> analyse -> build -> store, in the background, forever.
//
// The engine is shared with the solve loop, and the solve loop's questions are
// the ones a human is waiting on, so the pipeline yields: `pause()` stops it
// between positions, which is at most one search away.

import { findCandidates } from '../analysis/candidates.ts';
import { buildPuzzles, type Puzzle } from '../deck/build.ts';
import { replay, type ReplayStep } from '../deck/positions.ts';
import { analyseGame, Aborted } from '../engine/analyse.ts';
import type { Analyser } from '../engine/analyse.ts';
import { OpeningBook } from '../lichess/explorer.ts';
import { ExportError, fetchGames, povOf, type ExportedGame } from '../lichess/export.ts';
import { purgeIfTight, type Profile } from '../storage/db.ts';

export interface PipelineEvents {
  /** New puzzles, already stored. */
  onPuzzles: (puzzles: Puzzle[]) => void;
  /** Games finished this session, and the game being worked on right now. */
  onProgress: (p: Progress) => void;
  onError: (e: Error) => void;
  /** lichess said "busy"; we are waiting `delayMs` and trying once more. */
  onRetry?: (e: ExportError, delayMs: number) => void;
}

export interface Progress {
  gamesDone: number;
  /** Games fetched but not yet analysed, this batch. */
  gamesPending: number;
  /** 0..1 through the current game's positions, or undefined between games. */
  current?: number;
  /** True while the engine is doing the work rather than lichess having done it. */
  engineBusy: boolean;
}

const BATCH = 20;

/**
 * lichess allows **one games export per IP at a time**, and the callers here
 * are hair-triggered: the deck asks for more after every solve it finishes
 * thin, and at the end of the deck, on every click. Without a governor that is
 * a burst, and a burst against a concurrency limit of one is a 429.
 *
 * So: no two exports closer together than this, whoever asks.
 */
const EXPORT_GAP = 30_000;
/** And after lichess has said no twice, leave it alone for considerably longer. */
const BACKOFF = 120_000;
/** How long a transient "another export is running" is given to clear. */
const RETRY_DELAY = 8_000;

/** Just the storage this needs, so tests can hand it something that isn't IndexedDB. */
export type Store = Pick<
  Profile,
  'username' | 'meta' | 'setMeta' | 'putGame' | 'putPuzzles' | 'purgeGames'
>;

export class Pipeline {
  private queue: ExportedGame[] = [];
  private running = false;
  private paused = false;
  private wake: (() => void) | undefined;
  private progress: Progress = { gamesDone: 0, gamesPending: 0, engineBusy: false };
  private abort = new AbortController();
  private readonly book = new OpeningBook();
  private lastExportAt = -Infinity;
  private blockedUntil = 0;
  private exhausted = false;
  /** Injectable so the governor can be tested without waiting 30 real seconds. */
  private readonly now: () => number;

  private readonly profile: Store;
  /** Boots on first use: a game lichess already analysed needs no engine at all. */
  private readonly engine: () => Promise<Analyser>;
  private readonly events: PipelineEvents;

  constructor(
    profile: Store,
    engine: () => Promise<Analyser>,
    events: PipelineEvents,
    now: () => number = Date.now,
  ) {
    this.profile = profile;
    this.engine = engine;
    this.events = events;
    this.now = now;
  }

  /**
   * Fetch a batch and work through it. Safe to call as often as you like — it
   * won't double up, won't fetch inside the gap, and won't ask again once
   * lichess has run out of games to give.
   */
  async run(): Promise<void> {
    if (this.running || !this.mayFetch()) return;
    this.running = true;
    try {
      this.lastExportAt = this.now();
      await this.fetchWithRetry();
      await this.drain();
      // Between batches, not during: purging mid-analysis would drop a payload
      // the queue still holds a reference to.
      await purgeIfTight(this.profile as Profile);
    } catch (e) {
      if (e instanceof Aborted) return;
      // Past the retry, a 429 means back off rather than let the next caller
      // through here walk straight into the same limit.
      if (isBusy(e)) this.blockedUntil = this.now() + BACKOFF;
      this.events.onError(e as Error);
    } finally {
      this.running = false;
    }
  }

  /**
   * The concurrency 429 is usually transient — a reload that left the previous
   * export still streaming, or a second tab — and it clears in seconds. Being
   * thrown back to the landing screen for that is a much worse answer than
   * waiting a moment, so we wait a moment.
   */
  private async fetchWithRetry(): Promise<void> {
    try {
      await this.fetchBatch();
    } catch (e) {
      if (!isBusy(e)) throw e;
      this.events.onRetry?.(e as ExportError, RETRY_DELAY);
      await this.sleep(RETRY_DELAY);
      if (this.abort.signal.aborted) throw new Aborted('cancelled');
      this.lastExportAt = this.now();
      await this.fetchBatch();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Why the deck is not filling, for the UI to say out loud. */
  status(): 'idle' | 'working' | 'waiting' | 'exhausted' {
    if (this.running) return 'working';
    if (this.exhausted) return 'exhausted';
    return this.mayFetch() ? 'idle' : 'waiting';
  }

  /** When the next fetch becomes possible, in ms from now. 0 if it already is. */
  waitMs(): number {
    return Math.max(0, Math.max(this.blockedUntil, this.lastExportAt + EXPORT_GAP) - this.now());
  }

  private mayFetch(): boolean {
    return !this.exhausted && this.waitMs() === 0;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.wake?.();
  }

  stop(): void {
    this.abort.abort();
    this.resume();
  }

  private async gate(): Promise<void> {
    while (this.paused) await new Promise<void>(resolve => (this.wake = resolve));
    this.wake = undefined;
  }

  private emit(patch: Partial<Progress>): void {
    this.progress = { ...this.progress, ...patch };
    this.events.onProgress(this.progress);
  }

  private async fetchBatch(): Promise<void> {
    const meta = await this.profile.meta();
    const seen = new Set([...meta.analysed, ...meta.fetched]);
    let oldest: number | undefined;
    let total = 0;
    const games: ExportedGame[] = [];
    for await (const game of fetchGames(this.profile.username, {
      max: BATCH,
      ...(meta.until !== undefined ? { until: meta.until } : {}),
      signal: this.abort.signal,
    })) {
      total++;
      oldest = Math.min(oldest ?? game.createdAt, game.createdAt);
      if (seen.has(game.id)) continue;
      games.push(game);
      await this.profile.putGame(game);
    }
    // Page backwards from the oldest game of this batch next time. Without this
    // the second batch is the first batch.
    await this.profile.setMeta({
      ...meta,
      ...(oldest !== undefined ? { until: oldest - 1 } : {}),
    });
    // No games at all means we have paged back past the first one they ever
    // played. Asking again would get the same nothing, forever.
    if (total === 0) this.exhausted = true;
    this.queue.push(...games);
    this.emit({ gamesPending: this.queue.length });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      await this.gate();
      const game = this.queue.shift()!;
      this.emit({ gamesPending: this.queue.length, current: 0 });
      try {
        const puzzles = await this.analyse(game);
        if (puzzles.length) {
          await this.profile.putPuzzles(puzzles);
          this.events.onPuzzles(puzzles);
        }
        await this.markDone(game.id, puzzles.length > 0);
      } catch (e) {
        if (e instanceof Aborted) throw e;
        // One unplayable game must not stop the deck filling.
        console.warn('skipping', game.id, e);
        await this.markDone(game.id, false);
      }
      this.emit({ gamesDone: this.progress.gamesDone + 1, engineBusy: false, current: undefined });
    }
  }

  private async markDone(id: string, produced: boolean): Promise<void> {
    const meta = await this.profile.meta();
    if (produced) meta.analysed = [...new Set([...meta.analysed, id])];
    else meta.fetched = [...new Set([...meta.fetched, id])];
    await this.profile.setMeta(meta);
  }

  private async analyse(game: ExportedGame): Promise<Puzzle[]> {
    const pov = povOf(game, this.profile.username);
    // Someone else's game (a username that changed case is handled by povOf),
    // or a variant our replay can't play out.
    if (!pov || (game.variant !== 'standard' && game.variant !== 'fromPosition')) return [];
    const moves = game.moves?.split(' ').filter(Boolean) ?? [];
    if (moves.length < 4) return [];
    const steps = replay(moves, game.initialFen);

    // The opening is not cut off by ply. It is cut off by the masters
    // explorer, as retro does it: an early move is dropped because masters have
    // played it, not because it is early. When the explorer can't be reached
    // `isBook` says yes and the effect is the old blanket cut.
    const isBook = (index: number): Promise<boolean> => this.isBook(game, steps, index);

    // Games lichess has already analysed ship their evals in the export, and
    // cost us nothing.
    const analysis = game.analysis?.length
      ? game.analysis
      : await this.engineAnalysis(steps, pov, isBook);

    const candidates = findCandidates(moves, analysis, { pov });
    const kept: typeof candidates = [];
    for (const c of candidates) if (!(await isBook(c.index))) kept.push(c);

    const puzzles = buildPuzzles(game.id, steps, kept, pov, Date.now());
    // A book alternative is a right answer, not just a cancelled mistake, so
    // the list travels with the puzzle for the solver to accept.
    for (const puzzle of puzzles) {
      // Only where the question means something. A middlegame position is not
      // in any book, and asking costs a request to find that out.
      if (!inOpening(game, puzzle.ply)) continue;
      const ucis = await this.book.ucis(puzzle.fen);
      if (ucis?.length) puzzle.openingUcis = ucis;
    }
    return puzzles;
  }

  private async isBook(game: ExportedGame, steps: readonly ReplayStep[], index: number): Promise<boolean> {
    if (!inOpening(game, index + 1)) return false;
    const step = steps[index];
    return step ? this.book.contains(step.fen, step.uci) : false;
  }

  private async engineAnalysis(
    steps: readonly ReplayStep[],
    pov: 'white' | 'black',
    isBook: (index: number) => Promise<boolean>,
  ) {
    this.emit({ engineBusy: true });
    const engine = await this.engine();
    return analyseGame(engine, steps, {
      pov,
      skipPly: index => isBook(index),
      signal: this.abort.signal,
      beforeEach: () => this.gate(),
      onProgress: (done, total) => this.emit({ current: done / total }),
    });
  }
}

/** retroCtrl's guard: standard chess, and before the middlegame if lichess said where that is. */
const inOpening = (game: ExportedGame, ply: number): boolean =>
  game.variant === 'standard' && (game.division?.middle === undefined || ply < game.division.middle);

/** The two 429s both mean "not now"; only the sentence we show differs. */
const isBusy = (e: unknown): boolean =>
  e instanceof ExportError && (e.kind === 'rateLimit' || e.kind === 'concurrent');
