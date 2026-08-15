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
import { historyFloor, settings } from '../storage/prefs.ts';

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

/** Why the deck is not filling. `full`, `horizon` and `exhausted` are all "stopped". */
export type Status =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'exhausted'
  | 'horizon'
  | 'full'
  | 'noEngine';

/** The edges of one export, for whichever cursor is going to move. */
interface Batch {
  /** Games lichess sent, including ones already held. Short means caught up. */
  total: number;
  /** `createdAt` of the oldest and newest it sent, over all of them. */
  oldest?: number | undefined;
  newest?: number | undefined;
  /** How many were actually new to us. */
  kept: number;
}

/**
 * The engine did not start. Its own thing, because it is the one failure that
 * must not be recorded against the *game* — see `sweepBacklog`.
 */
export class NoEngine extends Error {}

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
  /**
   * Reaching further back is over: an empty batch came back. Its counterpart is
   * `refreshDone`, and the two are separate because they are separate
   * questions — "lichess has nothing older" and "lichess has nothing newer" are
   * different sentences on the exhausted screen, and only the first one is
   * permanent.
   */
  private noOlder = false;
  /**
   * `noOlder` was reached at the "how far back" floor rather than at the first
   * game they ever played. Indistinguishable from lichess' side — both are an
   * empty batch — so this is what the *setting* was, and the copy says so
   * rather than claiming to know which.
   */
  private horizon = false;
  /** The forward refresh has caught up with lichess; once per session. */
  private refreshDone = false;
  /** Newest `createdAt` seen by this session's refresh, before it has finished. */
  private refreshTop: number | undefined;
  /** Cursor *within* a refresh that took more than one batch. */
  private refreshUntil: number | undefined;
  /** Games the refresh brought in, for the exhausted screen to report. */
  private newGames = 0;
  /** `meta.newest` has been worked out for stores written before it existed. */
  private seeded = false;
  /**
   * The storage limit is reached, so no more games are being kept. Not the
   * same as `exhausted` — there are more games, we are choosing not to hold
   * them — and the two need different sentences.
   */
  private full = false;
  /** The catch-up ranking pass is a once-per-session thing. */
  private backlogDone = false;
  /** So is the catch-up *analysis* pass, for games stored but never swept. */
  private sweepBacklogDone = false;
  /**
   * The engine could not be started this session. `App.engine()` caches its
   * failure, so nothing will change until the page is reloaded — which makes
   * this both a fact and a decision: stop asking lichess for games we have no
   * way to analyse, rather than paging backwards through someone's whole
   * history collecting payloads nothing can read.
   */
  private engineDown = false;
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
      // Games that were stored and then never analysed — the engine was not
      // there when their turn came. Before the fetch for the same reason: they
      // are paid for, and they are the reason the deck is empty.
      await this.sweepBacklog();
      // No engine means nothing that arrives can be analysed, so fetching more
      // only walks backwards through the history collecting payloads. Stop.
      if (this.engineDown) return;
      // Asking lichess for games we have already decided not to keep is a
      // request against a one-per-IP limit for nothing.
      const limit = settings().maxGames;
      this.full = limit > 0 && (await this.profile.gameCount()) >= limit;
      if (this.full) return;
      // Before the first export of the session, so the refresh knows where
      // "new" starts even in a store written before the cursor existed.
      await this.seedNewest();
      if (!this.mayFetch()) return;
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
  status(): Status {
    if (this.running) return 'working';
    // Ahead of everything else: with no engine nothing else is the reason.
    if (this.engineDown) return 'noEngine';
    if (this.full) return 'full';
    // `horizon` first: "you told me to stop here" is a different sentence from
    // "there is nothing left", and only one of them has an answer in Settings.
    if (this.noOlder && this.refreshDone) return this.horizon ? 'horizon' : 'exhausted';
    return this.mayFetch() ? 'idle' : 'waiting';
  }

  /**
   * What the session's look for new games found, for the exhausted screen. Its
   * own accessor rather than a `status`, because it is true *alongside* every
   * other status rather than instead of one: the deck can be exhausted, and
   * separately have been brought up to date on the way there.
   */
  refresh(): { done: boolean; found: number } {
    return { done: this.refreshDone, found: this.newGames };
  }

  /** When the next fetch becomes possible, in ms from now. 0 if it already is. */
  waitMs(): number {
    return Math.max(0, Math.max(this.blockedUntil, this.lastExportAt + EXPORT_GAP) - this.now());
  }

  private mayFetch(): boolean {
    return (!this.noOlder || !this.refreshDone) && this.waitMs() === 0;
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

  /**
   * Reaching further back is worth trying again. Only "how far back" moves this:
   * the paging stopped at a floor that has since been lowered, so the games
   * beyond it are reachable now and were not a moment ago.
   *
   * Deliberately also clears a `noOlder` that lichess itself caused. It costs
   * one export against a history that will answer empty again, and the
   * alternative is remembering *which* of the two reasons stopped us and being
   * wrong about it — the two are indistinguishable from an empty batch, which
   * is the whole reason `horizon` exists.
   */
  recheckReach(): void {
    this.noOlder = false;
    this.horizon = false;
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
        await rankCandidates(await this.analyser(), game.analysis!, tasks, {
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

  /**
   * Analyse stored games that carry no evals at all — once per session, after
   * the ranking backlog and before any fetching.
   *
   * **This is the repair for a session that ran without an engine.** A game is
   * written to the store the moment it is fetched, and analysed afterwards; if
   * the engine was not there for the second half, the game sits in the store
   * with nothing on it. It used to be stamped into `meta.fetched` — "looked at,
   * found nothing" — and so was never looked at again, which is how a phone
   * that failed to boot the engine once walked backwards through seventy games
   * and ended with an empty deck for good.
   *
   * The backlog is therefore **derived from the store, not from a list in
   * `meta`**. "A stored game with no analysis that `prepareGame` accepts" is
   * exactly the set of games that owe the engine a pass, it needs no new field
   * and so no schema bump, and — the reason it is worth preferring — it repairs
   * stores that were *already* wrongly stamped, which a list written from here
   * on could not. `prepareGame` is the cheap half of the check and is what
   * keeps a genuinely unplayable game (wrong variant, four plies long, a move
   * list chessops rejects) out of the backlog for good rather than re-queued
   * every session.
   */
  private async sweepBacklog(): Promise<void> {
    if (this.sweepBacklogDone || this.engineDown) return;
    this.sweepBacklogDone = true;
    const work = (await this.profile.games()).filter(
      game => !game.analysis?.length && prepareGame(game, this.profile.username),
    );
    if (!work.length) return;
    this.queue.push(...work);
    this.emit({ gamesPending: this.queue.length });
    await this.drain();
  }

  /**
   * Work out where "new" starts, for a store that has none written down.
   *
   * `meta.newest` is the forward cursor and it is optional, because it did not
   * exist when some stores were written. Absent must not mean "the beginning of
   * time" — that would refresh someone's entire history through a filter that
   * dedup then throws away — so it is taken from the newest game held. A store
   * with no games at all keeps it undefined, and the first backwards batch
   * seeds it from what lichess sends.
   */
  private async seedNewest(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    const meta = await this.state();
    if (meta.newest !== undefined) return;
    const newest = (await this.profile.games())[0]?.createdAt;
    if (newest !== undefined) await this.remember(m => (m.newest = newest));
  }

  /**
   * One export, in whichever direction is owed.
   *
   * **Forward first, and only once per session.** New games are the ones a
   * returning player is most likely to want reviewed and the only ones the old
   * single cursor could never reach; older ones have been there for months and
   * can wait the thirty seconds until the next export. Once the refresh has
   * caught up, every later batch reaches further back as before.
   */
  private async fetchBatch(): Promise<void> {
    const meta = await this.state();
    if (!this.refreshDone && meta.newest !== undefined) return this.fetchNewer(meta.newest);
    return this.fetchOlder(meta);
  }

  /**
   * Games played since the newest one we hold.
   *
   * It can take more than one batch — someone who has not been here for a month
   * may have a hundred new games and the batch is twenty — and the export is
   * newest-first, so it pages *backwards* within the refresh: `since` stays at
   * the old high-water mark and `until` walks down through the new games until
   * a batch comes back short.
   *
   * `meta.newest` moves only when that happens. Advancing it per batch would
   * leave the games below the last one fetched in a window nothing ever looks
   * at again: `until` is already past them and `since` would now be above them.
   */
  private async fetchNewer(newest: number): Promise<void> {
    const max = settings().batchSize;
    const batch = await this.consume({
      max,
      since: newest + 1,
      ...(this.refreshUntil !== undefined ? { until: this.refreshUntil } : {}),
    });
    this.newGames += batch.kept;
    if (batch.newest !== undefined)
      this.refreshTop = Math.max(this.refreshTop ?? batch.newest, batch.newest);
    // The limit was hit partway through, so this batch is not the whole answer
    // and neither cursor may move. Nothing more is fetched this session anyway.
    if (this.full) return;
    if (batch.total >= max && batch.oldest !== undefined) {
      this.refreshUntil = batch.oldest - 1;
      return;
    }
    this.refreshDone = true;
    this.refreshUntil = undefined;
    const top = this.refreshTop;
    if (top !== undefined) await this.remember(m => (m.newest = Math.max(m.newest ?? 0, top)));
  }

  /** The next batch further back, stopping at the "how far back" floor. */
  private async fetchOlder(meta: Meta): Promise<void> {
    const floor = historyFloor(this.now());
    const batch = await this.consume({
      max: settings().batchSize,
      ...(meta.until !== undefined ? { until: meta.until } : {}),
      ...(floor !== undefined ? { since: floor } : {}),
    });
    // A first session has no forward cursor until lichess names one, and the
    // newest of this newest-first first batch is exactly it. Either way there
    // was nothing newer to go and look for, so the refresh is done rather than
    // owed — without this an empty history would be asked for its new games
    // once every thirty seconds, forever.
    if (meta.newest === undefined) {
      if (batch.newest !== undefined) {
        const top = batch.newest;
        await this.remember(m => (m.newest ??= top));
      }
      this.refreshDone = true;
    }
    // Same as in the refresh: a batch cut short by the storage limit has not
    // been paged through, so moving the cursor past it would lose the rest for
    // good — the limit is meant to stop us keeping games, not to hide them.
    if (this.full) return;
    // Page backwards from the oldest game of this batch next time. Without this
    // the second batch is the first batch.
    if (batch.oldest !== undefined) await this.remember(m => (m.until = batch.oldest! - 1));
    // No games at all means we have reached the end of what we are asking for:
    // the first game they ever played, or the floor, and from here those look
    // identical. Asking again would get the same nothing, forever.
    if (batch.total === 0) {
      this.noOlder = true;
      this.horizon = floor !== undefined;
    }
  }

  /**
   * Read one export to the end, keep what is new, and report the edges of what
   * came back. Shared by both directions, which differ only in the window they
   * ask for and in which cursor they move afterwards.
   */
  private async consume(params: { max: number; until?: number; since?: number }): Promise<Batch> {
    const meta = await this.state();
    const seen = new Set([...meta.analysed, ...meta.fetched]);
    const limit = settings().maxGames;
    let held = limit ? await this.profile.gameCount() : 0;
    let oldest: number | undefined;
    let newest: number | undefined;
    let total = 0;
    const games: ExportedGame[] = [];
    for await (const game of fetchGames(this.profile.username, {
      ...params,
      signal: this.abort.signal,
    })) {
      total++;
      oldest = Math.min(oldest ?? game.createdAt, game.createdAt);
      newest = Math.max(newest ?? game.createdAt, game.createdAt);
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
    this.queue.push(...games);
    this.emit({ gamesPending: this.queue.length });
    return { total, oldest, newest, kept: games.length };
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
        if (e instanceof NoEngine) {
          // **Do not stamp it.** A game skipped for want of an engine has not
          // been "looked at and found nothing" — nobody has looked. Leaving it
          // in the store with no analysis is what puts it in `sweepBacklog`
          // next session, and stopping here rather than grinding through the
          // rest of the queue keeps the same true of those.
          console.warn('no engine; leaving', game.id, 'unanalysed');
          this.queue.length = 0;
          this.emit({ gamesPending: 0, engineBusy: false, current: undefined });
          this.events.onError(e);
          return;
        }
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
      const other = produced ? meta.fetched : meta.analysed;
      if (!list.includes(id)) list.push(id);
      // A game re-analysed out of the backlog may already be stamped the other
      // way — that is the bug this pass repairs — so move it rather than let it
      // sit in both lists.
      const stale = other.indexOf(id);
      if (stale >= 0) other.splice(stale, 1);
    });
  }

  /**
   * The engine, with any reason it could not start collapsed into one error the
   * rest of this file can recognise.
   *
   * It has to be recognisable. "There is no engine" and "this game is
   * unplayable" want opposite answers — try again next session, versus never
   * again — and `App.engine()` rejects with whatever actually went wrong, which
   * for a dropped 15 MB net download is a `TypeError` and for a page that is
   * not cross-origin isolated is an `EngineUnavailable`.
   */
  private async analyser(): Promise<Analyser> {
    try {
      return await this.engine();
    } catch (e) {
      this.engineDown = true;
      throw new NoEngine(String((e as Error)?.message ?? e));
    }
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
      await rankCandidates(await this.analyser(), game.analysis, tasks, {
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
    const engine = await this.analyser();
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
