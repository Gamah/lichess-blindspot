// Fetch -> analyse -> build -> store, in the background, forever.
//
// The engine is shared with the solve loop, and the solve loop's questions are
// the ones a human is waiting on, so the pipeline yields: `pause()` stops it
// between positions, which is at most one search away.

import { findCandidates } from '../analysis/candidates.ts';
import { buildPuzzles, type Puzzle } from '../deck/build.ts';
import { replay } from '../deck/positions.ts';
import { analyseGame, Aborted } from '../engine/analyse.ts';
import type { Analyser } from '../engine/analyse.ts';
import { fetchGames, povOf, type ExportedGame } from '../lichess/export.ts';
import { purgeIfTight, type Profile } from '../storage/db.ts';

export interface PipelineEvents {
  /** New puzzles, already stored. */
  onPuzzles: (puzzles: Puzzle[]) => void;
  /** Games finished this session, and the game being worked on right now. */
  onProgress: (p: Progress) => void;
  onError: (e: Error) => void;
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

export class Pipeline {
  private queue: ExportedGame[] = [];
  private running = false;
  private paused = false;
  private wake: (() => void) | undefined;
  private progress: Progress = { gamesDone: 0, gamesPending: 0, engineBusy: false };
  private abort = new AbortController();

  private readonly profile: Profile;
  /** Boots on first use: a game lichess already analysed needs no engine at all. */
  private readonly engine: () => Promise<Analyser>;
  private readonly events: PipelineEvents;

  constructor(profile: Profile, engine: () => Promise<Analyser>, events: PipelineEvents) {
    this.profile = profile;
    this.engine = engine;
    this.events = events;
  }

  /** Fetch a batch and work through it. Safe to call again; it won't double up. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.fetchBatch();
      await this.drain();
      // Between batches, not during: purging mid-analysis would drop a payload
      // the queue still holds a reference to.
      await purgeIfTight(this.profile);
    } catch (e) {
      if (!(e instanceof Aborted)) this.events.onError(e as Error);
    } finally {
      this.running = false;
    }
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
    const games: ExportedGame[] = [];
    for await (const game of fetchGames(this.profile.username, {
      max: BATCH,
      ...(meta.until !== undefined ? { until: meta.until } : {}),
      signal: this.abort.signal,
    })) {
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

    const fromPly = game.division?.middle;
    // Games lichess has already analysed ship their evals in the export, and
    // cost us nothing.
    const analysis = game.analysis?.length
      ? game.analysis
      : await this.engineAnalysis(steps, pov, fromPly);

    const candidates = findCandidates(moves, analysis, {
      pov,
      ...(fromPly !== undefined ? { fromPly } : {}),
    });
    return buildPuzzles(game.id, steps, candidates, pov, Date.now());
  }

  private async engineAnalysis(
    steps: ReturnType<typeof replay>,
    pov: 'white' | 'black',
    fromPly: number | undefined,
  ) {
    this.emit({ engineBusy: true });
    const engine = await this.engine();
    return analyseGame(engine, steps, {
      pov,
      ...(fromPly !== undefined ? { fromPly } : {}),
      signal: this.abort.signal,
      beforeEach: () => this.gate(),
      onProgress: (done, total) => this.emit({ current: done / total }),
    });
  }
}
