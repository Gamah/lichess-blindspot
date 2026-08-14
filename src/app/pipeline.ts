// Fetch -> analyse -> build -> store, in the background, forever.
//
// The engine is shared with the solve loop, and the solve loop's questions are
// the ones a human is waiting on, so the pipeline yields: `pause()` stops it
// between positions, which is at most one search away.

import type { Puzzle } from '../deck/build.ts';
import { prepareGame, puzzlesFromGame, unrankedPlies } from '../deck/derive.ts';
import type { ReplayStep } from '../deck/positions.ts';
import { analyseGame, rankCandidates, Aborted } from '../engine/analyse.ts';
import type { Analyser } from '../engine/analyse.ts';
import { ExportError, fetchGames, type ExportedGame } from '../lichess/export.ts';
import type { Meta, Profile } from '../storage/db.ts';
import { settings } from '../storage/prefs.ts';

export interface PipelineEvents {
  /**
   * Positions derived from a game that has just been analysed. Nothing stores
   * these — the analysis they came from is on the stored game, and the same
   * call rebuilds them next session.
   */
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
  /**
   * Stored games still waiting for their positions to be ranked, or undefined
   * once there are none. Only ever non-zero on the first run after the ranking
   * arrived, and the loading screen says what it is doing.
   */
  backlog?: number;
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
  'username' | 'meta' | 'setMeta' | 'putGame' | 'games' | 'gameCount'
>;

export class Pipeline {
  private queue: ExportedGame[] = [];
  private running = false;
  private paused = false;
  private wake: (() => void) | undefined;
  private progress: Progress = { gamesDone: 0, gamesPending: 0, engineBusy: false };
  private abort = new AbortController();
  /**
   * Paging state for this session. Seeded from storage once and thereafter
   * authoritative, with writes going through to storage best-effort.
   *
   * It has to work this way. A browser that refuses us storage — Firefox with
   * cookies blocked — makes every write a no-op, and if this were read back
   * from storage each time then `until` would never advance and `seen` would
   * always be empty: the same twenty games fetched and re-analysed forever.
   * In memory it pages properly and simply forgets at the end of the session.
   */
  private memo: Meta | undefined;
  private lastExportAt = -Infinity;
  private blockedUntil = 0;
  private exhausted = false;
  /**
   * The storage limit is reached, so no more games are being kept. Not the
   * same as `exhausted` — there are more games, we are choosing not to hold
   * them — and the two need different sentences.
   */
  private full = false;
  /** The catch-up ranking pass is a once-per-session thing. */
  private backlogDone = false;
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
    if (this.running) return;
    this.running = true;
    try {
      // Before anything is fetched: the games already in the store are paid
      // for, and ranking them costs nobody a download. This is also what makes
      // the deck fill at all on the first run after the ranking arrived, since
      // every stored game is withholding its positions until it has one.
      await this.rankBacklog();
      // Asking lichess for games we have already decided not to keep is a
      // request against a one-per-IP limit for nothing.
      const limit = settings().maxGames;
      this.full = limit > 0 && (await this.profile.gameCount()) >= limit;
      if (this.full || !this.mayFetch()) return;
      this.lastExportAt = this.now();
      await this.fetchWithRetry();
      await this.drain();
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
  status(): 'idle' | 'working' | 'waiting' | 'exhausted' | 'full' {
    if (this.running) return 'working';
    if (this.full) return 'full';
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

  /**
   * Ask for the backlog to be walked again. Raising "positions per game" makes
   * candidates that were never ranked into candidates that would be shown, and
   * without this they would sit unranked — and so withheld — until the next
   * session.
   */
  recheckBacklog(): void {
    this.backlogDone = false;
  }

  /** Raising the storage limit, or purging, un-sticks a full store. */
  recheckFull(): void {
    this.full = false;
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

  /** The session's paging state, read from storage the first time only. */
  private async state(): Promise<Meta> {
    this.memo ??= await this.profile.meta();
    return this.memo;
  }

  private async remember(change: (meta: Meta) => void): Promise<void> {
    const meta = await this.state();
    change(meta);
    await this.profile.setMeta(meta);
  }

  /**
   * Rank the candidates of stored games that have none — once per session,
   * before any fetching.
   *
   * Every game already in the store is withholding its positions until this
   * has run: a puzzle is not shown until the engine's five best moves for it
   * are known. So on the first run after the ranking arrived this *is* the
   * deck filling, and it is engine work on games that were free before. That
   * is the trade, and it is deliberate — see CLAUDE.md. It is not a
   * re-analysis: the sweep already happened and the candidates are already
   * known, so it is one search per position that would be shown, not one per
   * ply of the game.
   */
  private async rankBacklog(): Promise<void> {
    if (this.backlogDone) return;
    this.backlogDone = true;
    const { maxPerGame, rankMs } = settings();
    const work = (await this.profile.games())
      .map(game => ({
        game,
        tasks: unrankedPlies(game, this.profile.username, { maxPerGame, minMs: rankMs }),
      }))
      .filter(w => w.tasks.length && w.game.analysis);
    if (!work.length) return;

    this.emit({ backlog: work.length, engineBusy: true });
    try {
      for (const [i, { game, tasks }] of work.entries()) {
        await this.gate();
        await rankCandidates(await this.engine(), game.analysis!, tasks, {
          movetime: rankMs,
          signal: this.abort.signal,
          beforeEach: () => this.gate(),
          onProgress: (done, total) => this.emit({ current: done / total }),
        });
        await this.profile.putGame(game);
        const puzzles = puzzlesFromGame(game, this.profile.username, { maxPerGame });
        if (puzzles.length) this.events.onPuzzles(puzzles);
        this.emit({
          backlog: work.length - i - 1,
          gamesDone: this.progress.gamesDone + 1,
          current: undefined,
        });
      }
    } catch (e) {
      if (e instanceof Aborted) throw e;
      // No engine, most likely, which is a broken install rather than a mode
      // we support: say so and carry on to the fetch, where the same failure
      // will be waiting and the UI will have something to nag about.
      this.events.onError(e as Error);
    } finally {
      this.emit({ backlog: 0, engineBusy: false, current: undefined });
    }
  }

  private async fetchBatch(): Promise<void> {
    const meta = await this.state();
    const seen = new Set([...meta.analysed, ...meta.fetched]);
    const limit = settings().maxGames;
    let held = limit ? await this.profile.gameCount() : 0;
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
      // The limit stops us taking more, it never deletes what is held. Break
      // rather than skip: `fetchGames` cancels the reader in a `finally`, and
      // leaving the export streaming is what holds lichess' one-per-IP slot.
      if (limit && held >= limit) {
        this.full = true;
        break;
      }
      held++;
      games.push(game);
      await this.profile.putGame(game);
    }
    // Page backwards from the oldest game of this batch next time. Without this
    // the second batch is the first batch.
    if (oldest !== undefined) await this.remember(m => (m.until = oldest - 1));
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
        if (puzzles.length) this.events.onPuzzles(puzzles);
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

  private markDone(id: string, produced: boolean): Promise<void> {
    return this.remember(meta => {
      const list = produced ? meta.analysed : meta.fetched;
      if (!list.includes(id)) list.push(id);
    });
  }

  /**
   * Make sure the game has an eval array, paying the engine for one if lichess
   * did not, and store it on the game. The puzzles are then only a view over
   * it — see deck/derive.ts — so nothing but the game is written.
   */
  private async analyse(game: ExportedGame): Promise<Puzzle[]> {
    // Read per game rather than per session, so changing the setting takes
    // effect on the next game rather than the next reload.
    const maxPerGame = settings().maxPerGame;

    // Games lichess has already analysed ship their evals in the export and
    // cost us nothing.
    if (!game.analysis?.length) {
      const prepared = prepareGame(game, this.profile.username);
      if (!prepared) return [];
      game.analysis = await this.engineAnalysis(
        prepared.steps,
        prepared.pov,
        prepared.fromPly,
        maxPerGame,
      );
      // The expensive half of the session lives in this write.
      await this.profile.putGame(game);
    }

    // Lichess' analysis carries one variation per ply and no way to ask for
    // four more, so a game it analysed still owes us a ranking search per
    // candidate before any of them can be shown. Our own pass gathers them as
    // it goes, so this is usually empty for those.
    const tasks = unrankedPlies(game, this.profile.username, {
      maxPerGame,
      minMs: settings().rankMs,
    });
    if (tasks.length && game.analysis) {
      this.emit({ engineBusy: true });
      await rankCandidates(await this.engine(), game.analysis, tasks, {
        movetime: settings().rankMs,
        signal: this.abort.signal,
        beforeEach: () => this.gate(),
        onProgress: (done, total) => this.emit({ current: done / total }),
      });
      await this.profile.putGame(game);
    }

    return puzzlesFromGame(game, this.profile.username, { maxPerGame });
  }

  private async engineAnalysis(
    steps: readonly ReplayStep[],
    pov: 'white' | 'black',
    fromPly: number | undefined,
    maxCandidates: number,
  ) {
    this.emit({ engineBusy: true });
    const engine = await this.engine();
    return analyseGame(engine, steps, {
      pov,
      maxCandidates,
      ...(fromPly !== undefined ? { fromPly } : {}),
      signal: this.abort.signal,
      beforeEach: () => this.gate(),
      onProgress: (done, total) => this.emit({ current: done / total }),
    });
  }
}

/** The two 429s both mean "not now"; only the sentence we show differs. */
const isBusy = (e: unknown): boolean =>
  e instanceof ExportError && (e.kind === 'rateLimit' || e.kind === 'concurrent');
