// The whole UI. Plain DOM: three screens, one board, no framework.
//
// The rule this file exists to keep: until a position is solved, the screen
// says nothing about where it came from. No game link, no opponent, no date,
// no ply, no eval, no "you played". Everything of that kind lives in
// `renderReveal`, which is only ever called after the solve is done.

import { Deck } from '../app/deck.ts';
import { Pipeline, type Progress } from '../app/pipeline.ts';
import type { Puzzle } from '../deck/build.ts';
import { puzzlesFromGame } from '../deck/derive.ts';
import { Engine, EngineUnavailable, type BootProgress } from '../engine/stockfish.ts';
import type { Analyser } from '../engine/analyse.ts';
import type { EngineLine } from '../engine/protocol.ts';
import { ExportError, type ExportedGame } from '../lichess/export.ts';
import {
  DIFFICULTIES,
  SHOWN_LINES,
  Solve,
  TOP_LINES,
  withinTopLines,
  type Difficulty,
} from '../solve/retro.ts';
import {
  mb,
  Profile,
  requestPersistence,
  storageEstimate,
  storagePressure,
  type SolveRecord,
} from '../storage/db.ts';
import {
  difficulty,
  difficultyChosen,
  forgetPrefs,
  recentUsernames,
  rememberUsername,
  saveSettings,
  settings,
} from '../storage/prefs.ts';
import type { IsolationReport } from '../isolation.ts';
import { Board, type PlayedMove } from './board.ts';

/** Unlock the board once this many games are through, or this many puzzles exist. */
const GATE_GAMES = 5;
const GATE_PUZZLES = 5;
/** Fetch more when the deck gets this thin. */
const REFILL_AT = 5;
/** How long the engine gets to judge a move the player invented. */
const JUDGE_MOVETIME = 1000;
/**
 * And to rank the position's moves, for the difficulty gate and the arrows on
 * a solved position. Longer than the single-line judgement because the same
 * time spread over five lines buys each of them less depth, and the ranking is
 * the thing being shown.
 */
const RANK_MOVETIME = 1500;
/**
 * After lichess has said "busy" we hold the front door too. The pipeline backs
 * itself off, but typing the name again builds a fresh one, so the wait has to
 * live out here as well or the retry button becomes a way round it.
 */
const BUSY_WAIT = 60_000;

export class App {
  private profile: Profile | undefined;
  private pipeline: Pipeline | undefined;
  private deck = new Deck();
  private board: Board | undefined;
  private solve: Solve | undefined;
  private attempts = 0;
  /**
   * The engine's top moves for the position on screen, memoised for as long as
   * it is on screen: the difficulty gate asks for them on every invented move,
   * and the reveal draws them, and that is one search rather than four.
   */
  private ranking: { puzzleId: string; lines: EngineLine[] } | undefined;
  private enginePromise: Promise<Analyser> | undefined;
  private booted: Engine | undefined;
  private engineFailed: string | undefined;
  private progress: Progress = { gamesDone: 0, gamesPending: 0, engineBusy: false };
  private booting: BootProgress | undefined;
  private unlocked = false;
  /** Set when lichess asks us to wait; no export before this. */
  private notBefore = 0;
  private notice: string | undefined;
  /** Set when the quota is getting tight; shown until it isn't. */
  private storageNote: string | undefined;
  /** The deck emptied and we are waiting on the pipeline to hand us more. */
  private awaitingPuzzles = false;
  private countdown: ReturnType<typeof setInterval> | undefined;
  private exhaustedTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly root: HTMLElement;
  private readonly isolation: IsolationReport;

  constructor(root: HTMLElement, isolation: IsolationReport) {
    this.root = root;
    this.isolation = isolation;
  }

  start(): void {
    // Leaving an export streaming holds lichess' one-per-IP slot open, and the
    // next thing this page does on the way back is start another one.
    addEventListener('pagehide', e => {
      if (!e.persisted) this.pipeline?.stop();
    });
    const preset = new URLSearchParams(location.search).get('u') ?? recentUsernames()[0] ?? '';
    // Someone who has been here before came back to solve, not to type their
    // own name again. The landing screen is still one click away, on Switch
    // player, and any failure drops back to it with the name filled in.
    if (preset) void this.begin(preset);
    else this.renderLanding('');
  }

  // --- screens ------------------------------------------------------------

  private renderLanding(preset: string, error?: string): void {
    this.root.innerHTML = `
      <main class="landing">
        <h1>Blindspot</h1>
        <p class="tagline">Your own blunders, with the game taken off them.</p>

        <p>Lichess' <em>Learn from your mistakes</em> walks you through one game's mistakes in
          order, with the game around them — it reads as review, and you already know something
          went wrong. Blindspot takes the same positions, strips them, and shuffles them across
          your recent games. No opponent, no date, no move number, no eval bar, no “you played
          Qh5”. Just a position, from your side of the board, and no clue whether the answer is a
          combination or a quiet pawn move.</p>

        <form class="start">
          <input name="username" list="recent" placeholder="lichess username" autocomplete="off"
                 autocapitalize="off" spellcheck="false" value="${escape(preset)}" required>
          <datalist id="recent">${recentUsernames().map(u => `<option value="${escape(u)}">`).join('')}</datalist>
          <button type="submit">Find my blindspots</button>
        </form>
        <p class="hint">Any lichess username works — practising someone else's blindspots is a
          perfectly good way to spend an evening.</p>

        ${error ? `<p class="error">${escape(error)}</p>` : ''}
        ${isolationWarning(this.isolation)}

        <ol class="steps">
          <li>
            <h2>Your games, from lichess</h2>
            <p>Straight from the public API — no account, no token, nothing to authorise. Twenty
              at a time, and when you work through those it reaches further back into your
              history, for as long as you have games.</p>
          </li>
          <li>
            <h2>Analysed here, in this tab</h2>
            <p>Games lichess has already analysed bring their evaluations with them and cost
              nothing. The rest are analysed by Stockfish running in this page — the first visit
              downloads about 15 MB of neural net, once, and a game takes some seconds.</p>
          </li>
          <li>
            <h2>The moments it fell apart</h2>
            <p>Every move where your position dropped sharply becomes a puzzle, using the same
              rule lichess itself uses. The opening is left out of it rather than held against
              you.</p>
          </li>
          <li>
            <h2>Judged on merit, not on one answer</h2>
            <p>A move is right if it doesn't throw away winning chances — not if it matches one
              blessed solution. Quiet positional saves count. The move you actually played never
              does.</p>
          </li>
        </ol>

        <p class="fineprint"><strong>There is no server.</strong> This page is static, your games
          are fetched straight from lichess, the engine runs in this tab, and the puzzles and your
          solving history are kept in this browser and sent nowhere. Clear the site data and it is
          all gone. The source is linked below, as the licence requires.</p>
      </main>
      ${footer()}`;
    const form = this.root.querySelector('form.start') as HTMLFormElement;
    form.addEventListener('submit', e => {
      e.preventDefault();
      const username = (new FormData(form).get('username') as string).trim();
      if (username) void this.begin(username);
    });
    this.tickBusyButton();
  }

  /**
   * While lichess wants us to wait, the button says how long and does nothing.
   * The wait is the point — a retry button that retries straight into the same
   * limit is how one 429 becomes five.
   */
  private tickBusyButton(): void {
    clearInterval(this.countdown);
    const button = this.root.querySelector('form.start button') as HTMLButtonElement | null;
    if (!button) return;
    const paint = () => {
      const left = Math.ceil((this.notBefore - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(this.countdown);
        button.disabled = false;
        button.textContent = 'Find my blindspots';
        return;
      }
      button.disabled = true;
      button.textContent = `lichess is busy — ${left}s`;
    };
    paint();
    if (this.notBefore > Date.now()) this.countdown = setInterval(paint, 1000);
  }

  private renderLoading(): void {
    const done = this.progress.gamesDone;
    const found = this.deck.unsolvedCount();
    const boot = this.booting;
    const bar = boot?.download !== undefined ? boot.download : Math.min(1, done / GATE_GAMES);
    this.root.innerHTML = `
      <main class="loading">
        <h1>Blindspot</h1>
        <p class="status">${escape(boot?.message ?? 'Analysing your games')}</p>
        ${this.notice ? `<p class="warn">${escape(this.notice)}</p>` : ''}
        <div class="bar"><div class="fill" style="width:${Math.round(bar * 100)}%"></div></div>
        <p class="detail">${done} game${done === 1 ? '' : 's'} analysed · ${found} position${
          found === 1 ? '' : 's'
        } found</p>
        <p class="hint">Games lichess has already analysed are free; the rest are analysed here, in your
          browser, which is slower and warmer.</p>
      </main>
      ${footer()}`;
  }

  private renderSolving(): void {
    this.root.innerHTML = `
      <header class="topbar">
        <span class="who">${escape(this.profile?.username ?? '')}</span>
        <span class="spacer"></span>
        <button id="settings" class="quiet">Settings</button>
        <button id="switch" class="quiet">Switch player</button>
      </header>
      <p class="warn" id="notice" hidden></p>
      <main class="solving">
        <div class="board-wrap"><div class="board" id="board"></div></div>
        <aside class="side">
          <div class="feedback" id="feedback"></div>
          <div class="reveal" id="reveal"></div>
          <div class="controls">
            <button id="solution">Show solution</button>
            <button id="skip">Skip</button>
            <button id="next" hidden>Next position</button>
          </div>
          <div class="counters" id="counters"></div>
        </aside>
      </main>
      <div class="panel" id="panel" hidden></div>
      ${footer()}`;
    this.paintStorageNote();
    this.board = new Board(this.root.querySelector('#board') as HTMLElement, m => void this.onMove(m));
    (this.root.querySelector('#solution') as HTMLButtonElement).onclick = () => void this.showSolution();
    (this.root.querySelector('#skip') as HTMLButtonElement).onclick = () => this.skip();
    (this.root.querySelector('#next') as HTMLButtonElement).onclick = () => void this.nextPuzzle();
    (this.root.querySelector('#switch') as HTMLButtonElement).onclick = () => this.switchPlayer();
    (this.root.querySelector('#settings') as HTMLButtonElement).onclick = () => void this.toggleSettings();
  }

  /** Back to the landing screen, with the background work stopped. */
  private switchPlayer(): void {
    this.pipeline?.stop();
    const previous = this.profile?.username ?? '';
    this.pipeline = undefined;
    this.profile = undefined;
    this.deck = new Deck();
    this.solve = undefined;
    this.board = undefined;
    this.progress = { gamesDone: 0, gamesPending: 0, engineBusy: false };
    this.unlocked = false;
    // The engine stays booted: it is expensive to start and belongs to nobody.
    this.renderLanding(previous);
  }

  private async toggleSettings(): Promise<void> {
    const panel = this.root.querySelector('#panel') as HTMLElement | null;
    if (!panel || !this.profile) return;
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    const estimate = await storageEstimate();
    const solved = this.deck.solvedCount();
    const chosen = settings().maxPerGame;
    const options = [1, 2, 3, 5, 10, 0]
      .map(
        n =>
          `<option value="${n}"${n === chosen ? ' selected' : ''}>${
            n === 0 ? 'every one it finds' : `${n} position${n === 1 ? '' : 's'}`
          }</option>`,
      )
      .join('');

    panel.hidden = false;
    panel.innerHTML = `
      <div class="panel-head">
        <h2>Settings</h2>
        <button id="close" class="quiet">Close</button>
      </div>

      <div class="setting">
        <label for="difficulty">Difficulty</label>
        <select id="difficulty">${difficultyOptions()}</select>
        <p class="hint">${DIFFICULTY_HINT}</p>
      </div>

      <div class="setting">
        <label for="max-per-game">Positions per game</label>
        <select id="max-per-game">${options}</select>
        <p class="hint">Finding mistakes is cheap; confirming one costs a pair of second-long
          searches. Fewer per game means games are analysed faster and the deck draws from a
          wider spread of them. Changing it rebuilds the deck from the games already analysed —
          though raising it only finds more in games lichess analysed for us, since our own pass
          stops searching once it has enough.</p>
      </div>

      <div class="setting">
        <label for="threads">Processor cores</label>
        <select id="threads">${threadOptions()}</select>
        <p class="hint">How many cores the engine may use while it analyses. More is faster;
          fewer leaves the device usable and, on a phone, cooler. Takes effect on the next
          position analysed — the engine is not restarted.</p>
      </div>

      <div class="setting">
        <span class="label-text">Stored games</span>
        <button id="purge" class="quiet">Purge</button>
        <p class="hint">${
          estimate
            ? `Using ${mb(estimate.usage)} of ${mb(estimate.quota)} available. `
            : 'This browser will not say how much space it is using. '
        }A stored game carries the analysis of it, and the positions you solve are built from
          that, so deleting games deletes their positions too. Nothing is ever discarded on its
          own; your solve history survives either way.</p>
      </div>

      <div class="setting">
        <span class="label-text">Solved positions</span>
        <button id="unsolve" class="quiet">Bring back ${solved}</button>
        <p class="hint">Solved positions leave the shuffle but stay stored. This puts them back
          in, which is a way to revisit them without re-analysing anything.</p>
      </div>

      <div class="setting">
        <span class="label-text">This profile</span>
        <button id="wipe" class="quiet danger">Delete ${escape(this.profile.username)}</button>
        <p class="hint">Games, their analysis and your solve history for this username, gone. The engine's
          neural net is shared and stays.</p>
      </div>

      <p class="line" id="panel-status"></p>`;

    const status = (text: string) => {
      const el = panel.querySelector('#panel-status');
      if (el) el.textContent = text;
    };
    (panel.querySelector('#close') as HTMLButtonElement).onclick = () => (panel.hidden = true);
    (panel.querySelector('#difficulty') as HTMLSelectElement).onchange = e => {
      const value = (e.target as HTMLSelectElement).value as Difficulty;
      saveSettings({ difficulty: value });
      // Nothing to rebuild: difficulty is the verdict on a move, not which
      // positions the deck holds, so it takes effect on the next move tried.
      status(`${DIFFICULTY_NAMES[value]}. ${DIFFICULTY_SUMMARY[value]}`);
    };
    (panel.querySelector('#max-per-game') as HTMLSelectElement).onchange = async e => {
      const value = Number((e.target as HTMLSelectElement).value);
      saveSettings({ maxPerGame: value });
      // Retroactive, because a puzzle is a view over a stored game rather than
      // a record: the cap can simply be applied again to everything.
      await this.buildDeck();
      this.renderCounters();
      status(
        `${
          value === 0
            ? 'Taking every mistake it finds from each game'
            : `Taking up to ${value} position${value === 1 ? '' : 's'} from each game`
        }. Deck rebuilt: ${this.deck.unsolvedCount()} waiting.`,
      );
    };
    (panel.querySelector('#threads') as HTMLSelectElement).onchange = e => {
      const value = Number((e.target as HTMLSelectElement).value);
      saveSettings({ threads: value });
      const using = value || Engine.defaultThreads();
      // Live, if an engine is already running; otherwise it boots with this.
      void this.booted?.setThreads(using).catch(() => {});
      status(`Using ${using} core${using === 1 ? '' : 's'}.`);
    };
    (panel.querySelector('#purge') as HTMLButtonElement).onclick = async () => {
      const dropped = await this.profile?.purgeGames();
      await this.buildDeck();
      this.renderCounters();
      status(
        `${dropped ?? 0} game${dropped === 1 ? '' : 's'} deleted, and the positions from them. ` +
          `${this.deck.unsolvedCount()} waiting.`,
      );
    };
    (panel.querySelector('#unsolve') as HTMLButtonElement).onclick = async () => {
      await this.profile?.clearSolves();
      await this.buildDeck();
      this.renderCounters();
      status(`Solve history cleared. ${this.deck.unsolvedCount()} positions back in the deck.`);
    };
    (panel.querySelector('#wipe') as HTMLButtonElement).onclick = async () => {
      await this.profile?.wipe();
      status('Deleted.');
      this.switchPlayer();
    };
  }

  // --- flow ---------------------------------------------------------------

  private async begin(username: string): Promise<void> {
    if (Date.now() < this.notBefore) return this.tickBusyButton();
    rememberUsername(username);
    this.notice = undefined;
    const profile = new Profile(username);
    this.profile = profile;
    this.renderLoading();

    // A store from before puzzles were derived cannot be read as it stands, and
    // there is nothing to migrate: the evals behind its puzzles were never
    // written down. Say so and start again.
    if (await profile.stale()) return this.renderReset(profile);
    void profile.stamp();

    // Same shape of gate, for a change that costs nothing to make: a setting
    // that did not exist when this store was written. Someone with games here
    // has been solving under the old rule, so it is offered once rather than
    // waiting to be found in Settings. A store with nothing in it belongs to
    // someone who has no old rule to be surprised by, so it is stamped with
    // the default instead and never asked.
    if (!difficultyChosen()) {
      if (await profile.hasGames()) return this.renderDifficultyNotice(profile);
      saveSettings({ difficulty: 'easy' });
    }

    await this.buildDeck();

    this.pipeline = new Pipeline(profile, () => this.engine(), {
      onPuzzles: p => {
        this.deck.add(p);
        this.maybeUnlock();
        // The deck ran dry and we told them to wait. Don't make them click.
        if (this.awaitingPuzzles && this.deck.unsolvedCount()) {
          this.awaitingPuzzles = false;
          void this.nextPuzzle();
        }
      },
      onProgress: p => {
        this.progress = p;
        this.maybeUnlock();
      },
      onError: e => this.fail(e),
      onRetry: (e, delayMs) => {
        this.notice = `${e.message} Trying again in ${Math.round(delayMs / 1000)}s.`;
        if (!this.unlocked) this.renderLoading();
      },
    });

    void this.pipeline
      .run()
      .then(() => this.maybeUnlock(true))
      .then(() => this.checkStorage());
    this.maybeUnlock();
  }

  /**
   * The one-time reset. This version stores what it works out on the game
   * itself rather than as puzzle records, and a store written by the previous
   * one cannot be brought forward: the evals its puzzles were built from were
   * never written down, so there is nothing to convert.
   *
   * So nothing is carried across — not the solve history either, though it
   * technically could be. Half-migrating leaves every future version reasoning
   * about a store that is part old and part new, for a saving nobody asked
   * for. Say it plainly once and start clean.
   */
  private renderReset(profile: Profile): void {
    // Its "lichess is busy" ticker hunts for `form.start button`, and there is
    // one on this screen that has nothing to do with lichess.
    clearInterval(this.countdown);
    this.root.innerHTML = `
      <main class="landing reset">
        <h1>Blindspot has changed how it stores things</h1>
        <p>This version keeps the analysis on the game it came from, instead of keeping the
          positions it produced. It is a better arrangement — changing what a position shows no
          longer means rebuilding everything — but the old store cannot be converted into the new
          one, because the evaluations behind those positions were never saved.</p>
        <p><strong>So everything this browser had stored is deleted and starts again:</strong>
          the games, the positions, your solving history and your settings. The games are fetched
          from lichess and analysed again, which takes a few minutes in the background — you can
          solve while it happens — and positions you had already solved will come round again.</p>
        <p>Nothing was on a server, so there is nothing to restore. This is a one-off; storing
          the analysis rather than the positions is what stops it happening for the next change.</p>
        <form class="start">
          <button type="submit">Delete it and start again</button>
        </form>
      </main>
      ${footer()}`;
    (this.root.querySelector('form.start') as HTMLFormElement).addEventListener('submit', e => {
      e.preventDefault();
      void this.doReset(profile);
    });
  }

  /**
   * The other kind of one-time screen: nothing is deleted and nothing has to
   * be, but the rule that decides whether you found the move has grown two
   * stricter settings, and picking one is a choice the person should make
   * rather than one made for them by a default. Easy is the old behaviour, so
   * the safe answer is also the one that changes nothing.
   */
  private renderDifficultyNotice(profile: Profile): void {
    clearInterval(this.countdown);
    this.root.innerHTML = `
      <main class="landing notice">
        <h1>There is a difficulty setting now</h1>
        <p>Until now a move you invented was accepted whenever it did not throw the position
          away — which in most positions is several different moves. That is still there, it is
          called <strong>Easy</strong>, and choosing it changes nothing at all.</p>
        <p>The other two ask the engine a narrower question: not "is this move alright" but "is
          this one of the moves I would name". <strong>Medium</strong> wants your move inside the
          engine's top 5 from that position, <strong>Hard</strong> inside its top 2. The engine's
          own move and a move that mates are accepted whatever you pick.</p>
        <p class="warn">Those rankings come from a ${(RANK_MOVETIME / 1000).toFixed(1)}-second
          search in this browser. That is enough to be confident about the best move or two and
          not much more: a deeper search, or lichess' own analysis, will sometimes put a different
          move third. Hard is strict about something the engine is sure of; Medium's top 5 is
          wide enough that the disagreement rarely reaches its edge. Neither is a verdict on your
          move from on high.</p>
        <p>Whatever you pick, a solved position now shows the engine's top five as numbered blue
          arrows, and it can be changed at any time in Settings. Your games, analysis and solving
          history are untouched — this is a setting, not a change to what is stored.</p>
        <div class="choices">
          ${DIFFICULTIES.map(
            d => `<button data-difficulty="${d}">${DIFFICULTY_NAMES[d]}${
              d === 'easy' ? ' — as before' : ` — top ${TOP_LINES[d]}`
            }</button>`,
          ).join('')}
        </div>
      </main>
      ${footer()}`;
    (this.root.querySelector('.choices') as HTMLElement).addEventListener('click', e => {
      const chosen = (e.target as HTMLElement).closest('button')?.dataset['difficulty'];
      if (!chosen) return;
      saveSettings({ difficulty: chosen as Difficulty });
      // Back through the front door, like the reset does: this time the gate
      // above finds a choice recorded and falls through to an ordinary load.
      this.profile = undefined;
      void this.begin(profile.username);
    });
  }

  private async doReset(profile: Profile): Promise<void> {
    await profile.reset();
    // The prefs box is small and separate, but "start fresh" means it too:
    // recent usernames and settings both go. The name they are about to carry
    // on with is remembered again by `begin`.
    forgetPrefs();
    // Straight back through the front door: `begin` finds a store it can read
    // this time, and everything from there is an ordinary first visit.
    this.profile = undefined;
    await this.begin(profile.username);
  }

  /**
   * Build the deck out of what is stored. Nothing persists a puzzle any more:
   * the games hold their eval arrays and the positions are derived from those
   * here, every time. Which is also why this can simply be run again when
   * something that shapes the deck — how many positions a game may contribute
   * — changes.
   */
  private async buildDeck(): Promise<void> {
    const profile = this.profile;
    if (!profile) return;
    const [games, solves] = await Promise.all([profile.games(), profile.solves()]);
    // Switch player is one click and two IndexedDB reads are not instant.
    if (this.profile !== profile) return;
    const deck = new Deck();
    deck.markSolved(solves.map((s: SolveRecord) => s.puzzleId));
    const maxPerGame = settings().maxPerGame;
    // One add, not one per game: `add` reshuffles what is left each time, and
    // the shuffle is what keeps two positions from one game apart.
    deck.add(games.flatMap(game => puzzlesFromGame(game, profile.username, { maxPerGame })));
    this.deck = deck;
  }

  /** The load gate: a progress bar until there is enough to solve. */
  private maybeUnlock(pipelineDone = false): void {
    if (this.unlocked) {
      this.renderCounters();
      return;
    }
    const enough =
      this.deck.unsolvedCount() >= GATE_PUZZLES ||
      this.progress.gamesDone >= GATE_GAMES ||
      (pipelineDone && this.deck.unsolvedCount() > 0);
    if (!enough) return this.renderLoading();
    this.unlocked = true;
    void requestPersistence();
    this.renderSolving();
    void this.nextPuzzle();
  }

  private async nextPuzzle(): Promise<void> {
    const puzzle = this.deck.next();
    if (puzzle) {
      this.awaitingPuzzles = false;
      clearTimeout(this.exhaustedTimer);
    }
    if (!puzzle) {
      this.renderExhausted();
      void this.refill();
      return;
    }
    this.solve = new Solve(puzzle);
    this.attempts = 0;
    this.setReveal('');
    this.toggleNext(false);
    this.renderCounters();

    const them = puzzle.pov === 'white' ? 'Black' : 'White';
    if (puzzle.intro)
      this.setFeedback(`<strong>${them} has just moved.</strong> <span>Watch.</span>`);
    await this.board?.present(puzzle.fen, puzzle.pov, puzzle.intro);
    // A later puzzle may have taken over while the opponent's move played out.
    if (this.solve?.puzzle.id !== puzzle.id) return;
    this.setFeedback(
      `<strong>${puzzle.pov === 'white' ? 'White' : 'Black'} to play.</strong>
       <span>Find the move. There is a better one than the one that was played.</span>`,
    );
  }

  private async onMove(move: PlayedMove): Promise<void> {
    const solve = this.solve;
    if (!solve || !solve.isSolving()) return;
    this.attempts++;
    const verdict = solve.play(move);
    if (verdict === 'eval') {
      this.setFeedback(`<strong>Checking ${escape(move.san)}…</strong>`);
      const judged = await this.judge(solve, move);
      // With no engine there is no verdict to give, so only the move it would
      // have played can be accepted, and the note says as much.
      if (judged.engineless) solve.feedback = move.uci === solve.puzzle.best ? 'win' : 'fail';
      else solve.onCeval(judged.score, judged.ranked);
      this.afterVerdict(solve.feedback === 'win', move, judged.note);
    } else {
      this.afterVerdict(verdict === 'win', move);
    }
  }

  private afterVerdict(won: boolean, move: PlayedMove, note?: string): void {
    if (won) {
      this.setFeedback(
        `<strong class="good">${escape(move.san)} — yes.</strong>${note ? ` <span>${escape(note)}</span>` : ''}`,
      );
      void this.finish('win');
    } else {
      this.setFeedback(
        `<strong class="bad">${escape(move.san)} — no.</strong> <span>Try another move.</span>${
          note ? ` <span>${escape(note)}</span>` : ''
        }`,
      );
      setTimeout(() => this.board?.reset(), 700);
    }
  }

  /**
   * The 'eval' branch of retroCtrl: the player found a move that is neither the
   * engine's nor the one from the game, so it has to be judged on its merits.
   *
   * On Easy that is lila's question and lila's search — one line, from the
   * position the move led to. On Medium and Hard the move must additionally be
   * one of the engine's own top few, so the search is a MultiPV one from the
   * position *before* the move, and it answers both questions at once: a move
   * inside the ranking comes with the score of its line, and a move outside it
   * is refused without a second search.
   */
  private async judge(
    solve: Solve,
    move: PlayedMove,
  ): Promise<{
    score?: { cp?: number; mate?: number };
    ranked?: boolean;
    note?: string;
    engineless?: boolean;
  }> {
    const top = TOP_LINES[difficulty()];
    this.pipeline?.pause();
    try {
      const engine = await this.engine();
      if (!top) {
        const line = await engine.analyse({ fen: move.after, movetime: JUDGE_MOVETIME });
        return { score: line.score, ranked: true };
      }
      const lines = await this.rankPosition(solve.puzzle, engine);
      const ucis = lines.map(l => l.pv[0] ?? '');
      const rank = ucis.indexOf(move.uci);
      if (!withinTopLines(move.uci, ucis, top))
        return {
          ranked: false,
          note:
            rank < 0
              ? `The engine does not have it in its top ${lines.length}.`
              : `The engine has it ${ordinal(rank + 1)}, and this setting asks for its top ${top}.`,
        };
      // The score of the line starting with this move is the eval after it —
      // the same number the one-line search would have gone and found.
      return { score: lines[rank]!.score, ranked: true };
    } catch {
      return {
        engineless: true,
        note: 'The engine is unavailable here, so only its own move can be accepted.',
      };
    } finally {
      this.pipeline?.resume();
    }
  }

  /**
   * The engine's best moves for a position, best first, memoised for as long
   * as that position is the one on screen. Throws like any other search, and
   * the callers treat that as "no engine".
   */
  private async rankPosition(puzzle: Puzzle, engine: Analyser): Promise<EngineLine[]> {
    // Memoised on the position, not the attempt: three tries at one puzzle on
    // Hard is one search, and the reveal that follows re-uses the same one.
    if (this.ranking?.puzzleId === puzzle.id) return this.ranking.lines;
    if (!engine.analyseLines) throw new EngineUnavailable('This engine cannot rank moves.');
    const lines = await engine.analyseLines({
      fen: puzzle.fen,
      movetime: RANK_MOVETIME,
      multiPv: SHOWN_LINES,
    });
    this.ranking = { puzzleId: puzzle.id, lines };
    return lines;
  }

  /**
   * The ranking for the position just solved, for the arrows. Already in hand
   * whenever the difficulty gate ran; otherwise it is one search, and worth it
   * — this is the only moment the alternatives can be shown without being the
   * answer.
   */
  private async rankingFor(puzzle: Puzzle): Promise<string[]> {
    this.pipeline?.pause();
    try {
      const lines = await this.rankPosition(puzzle, await this.engine());
      return lines.map(l => l.pv[0] ?? '').filter(Boolean);
    } catch {
      // No engine, or it went away. The reveal still has the played move and
      // the line from the stored analysis; it just has no fan of alternatives.
      return [];
    } finally {
      this.pipeline?.resume();
    }
  }

  private async finish(result: 'win' | 'view'): Promise<void> {
    const solve = this.solve;
    if (!solve || !this.profile) return;
    this.board?.freeze();
    // The position back as it was handed out, with what the game did on it in
    // red. Immediately, because the ranking below can take a search and the
    // board should not sit on the move that ended the solve while it runs.
    this.board?.reveal(solve.puzzle.fen, solve.puzzle.pov, [], solve.puzzle.played.uci);
    this.deck.markSolved([solve.puzzle.id]);
    await this.profile.recordSolve({
      puzzleId: solve.puzzle.id,
      at: Date.now(),
      result,
      attempts: this.attempts,
    });
    await this.renderReveal(solve.puzzle);
    this.toggleNext(true);
    this.renderCounters();
    // Then the engine's top few over the top of it, numbered and fading. Last,
    // because it can take a search — a puzzle moved on from in the meantime
    // must not have arrows drawn over it.
    const top = await this.rankingFor(solve.puzzle);
    if (this.solve === solve && top.length) {
      this.board?.reveal(solve.puzzle.fen, solve.puzzle.pov, top, solve.puzzle.played.uci);
      this.appendReveal(`<p class="line dim">Blue arrows are the engine's top ${top.length},
        numbered best first, from a ${(RANK_MOVETIME / 1000).toFixed(1)}-second search — a deeper
        one can order them differently, and often does past the first two. Red is the move the
        game played.</p>`);
    }
    if (this.deck.unsolvedCount() < REFILL_AT) void this.refill();
  }

  private async showSolution(): Promise<void> {
    const solve = this.solve;
    if (!solve || solve.isDone()) return;
    solve.viewSolution();
    this.setFeedback(`<strong>${escape(solve.puzzle.pv.join(' '))}</strong>`);
    // The answer played out first, then `finish` puts the position back and
    // draws the ranking on it: an arrow fan over a board that has moved on is
    // nonsense.
    await this.board?.playLine([solve.puzzle.best], solve.puzzle.fen);
    await this.finish('view');
  }

  private skip(): void {
    const solve = this.solve;
    if (!solve) return;
    // Skipping is not solving: it goes back in the deck, at the end.
    this.deck.requeue(solve.puzzle);
    void this.nextPuzzle();
  }

  private async refill(): Promise<void> {
    await this.pipeline?.run();
    await this.checkStorage();
  }

  /**
   * Nothing here is thrown away on our own initiative any more — a stored game
   * carries the engine time spent on it — so a filling disk has to be said out
   * loud instead. Checked after a batch, which is when it grows.
   */
  private async checkStorage(): Promise<void> {
    this.storageNote = await storagePressure();
    this.paintStorageNote();
  }

  private paintStorageNote(): void {
    const el = this.root.querySelector('#notice') as HTMLElement | null;
    if (!el) return;
    el.textContent = this.storageNote ?? '';
    el.hidden = !this.storageNote;
  }

  // --- the part that is allowed to know where a position came from ---------

  private async renderReveal(puzzle: Puzzle): Promise<void> {
    const game = await this.profile?.game(puzzle.gameId);
    const move = Math.ceil(puzzle.ply / 2);
    this.setReveal(`
      <h2>${escape(puzzle.played.san)} was played</h2>
      <p class="line"><span class="label">Engine</span> ${escape(puzzle.pv.slice(0, 6).join(' '))}</p>
      <p class="line"><span class="label">Swing</span> ${escape(
        `${showEval(puzzle.prevEval)} → ${showEval(puzzle.eval)}`,
      )}${puzzle.judgment ? ` · ${escape(puzzle.judgment)}` : ''}</p>
      ${game ? gameLine(game, puzzle, move) : ''}`);
  }

  private renderExhausted(): void {
    this.awaitingPuzzles = true;
    this.board?.freeze();
    this.toggleNext(true);
    this.paintExhausted();
  }

  /**
   * Four different things can be true when the deck is empty, and they call for
   * four different sentences — particularly "there are no more games", which is
   * the only one that means stop waiting.
   */
  private paintExhausted(): void {
    if (!this.awaitingPuzzles) return;
    const pipeline = this.pipeline;
    const status = pipeline?.status() ?? 'idle';
    const message =
      status === 'exhausted'
        ? '<span>That is every game lichess has for you. Come back after a few more.</span>'
        : status === 'working'
          ? '<span>Analysing older games — the next position will appear here by itself.</span>'
          : status === 'waiting'
            ? `<span>Fetching older games in ${Math.ceil((pipeline?.waitMs() ?? 0) / 1000)}s.
                 lichess allows one export at a time, so this waits rather than pesters.</span>`
            : '<span>Fetching older games — the next position will appear here by itself.</span>';
    this.setFeedback(`<strong>That is the deck, for now.</strong> ${message}`);
    clearTimeout(this.exhaustedTimer);
    if (status !== 'exhausted') this.exhaustedTimer = setTimeout(() => this.paintExhausted(), 1000);
  }

  // --- small bits ---------------------------------------------------------

  private engine(): Promise<Analyser> {
    if (this.engineFailed) return Promise.reject(new EngineUnavailable(this.engineFailed));
    this.enginePromise ??= Engine.boot(p => {
      this.booting = p;
      if (!this.unlocked) this.renderLoading();
    }, threadSetting()).then(
      engine => {
        this.booting = undefined;
        this.booted = engine;
        return engine as Analyser;
      },
      e => {
        this.engineFailed = String(e.message ?? e);
        this.booting = undefined;
        throw e;
      },
    );
    return this.enginePromise;
  }

  private fail(e: Error): void {
    if (e instanceof ExportError && (e.kind === 'rateLimit' || e.kind === 'concurrent'))
      this.notBefore = Date.now() + BUSY_WAIT;
    if (this.unlocked) {
      this.setFeedback(`<strong class="bad">${escape(e.message)}</strong>`);
    } else {
      this.unlocked = false;
      this.renderLanding(this.profile?.username ?? '', e.message);
    }
  }

  private setFeedback(html: string): void {
    const el = this.root.querySelector('#feedback');
    if (el) el.innerHTML = html;
  }

  private setReveal(html: string): void {
    const el = this.root.querySelector('#reveal');
    if (el) el.innerHTML = html;
  }

  /** For the parts of the reveal that arrive after a search. */
  private appendReveal(html: string): void {
    const el = this.root.querySelector('#reveal');
    if (el) el.insertAdjacentHTML('beforeend', html);
  }

  private toggleNext(show: boolean): void {
    const next = this.root.querySelector('#next') as HTMLButtonElement | null;
    const solution = this.root.querySelector('#solution') as HTMLButtonElement | null;
    const skip = this.root.querySelector('#skip') as HTMLButtonElement | null;
    if (next) next.hidden = !show;
    if (solution) solution.hidden = show;
    if (skip) skip.hidden = show;
  }

  private renderCounters(): void {
    const el = this.root.querySelector('#counters');
    if (!el) return;
    const p = this.progress;
    const analysing = p.gamesPending || p.current !== undefined;
    el.innerHTML = `
      <span>${this.deck.solvedCount()} solved</span>
      <span>${this.deck.unsolvedCount()} waiting</span>
      <span class="dim">${DIFFICULTY_NAMES[difficulty()]}</span>
      ${analysing ? `<span class="working">analysing ${p.gamesDone + 1}…</span>` : ''}`;
  }
}

// --- formatting -------------------------------------------------------------

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

/** One line each, used in the panel status and on the notice. */
const DIFFICULTY_SUMMARY: Record<Difficulty, string> = {
  easy: 'Any move that does not throw the position away is accepted.',
  medium: 'A move must also be one of the engine’s top 5 from that position.',
  hard: 'A move must also be one of the engine’s top 2 from that position.',
};

const DIFFICULTY_HINT = `What counts as finding it. <strong>Easy</strong> accepts any move that
  does not throw the position away — several moves usually qualify, and that is what this app
  did before the setting existed. <strong>Medium</strong> and <strong>Hard</strong> also require
  the move to be one the engine itself would name: inside its top 5, or its top 2. The move the
  engine actually plays and a move that mates always count, whatever the setting.
  <br>
  Those rankings come from a ${(RANK_MOVETIME / 1000).toFixed(1)}-second search on this device,
  not from a deep one: past the first move or two the order is genuinely uncertain, and a longer
  search — or lichess' own analysis — will sometimes disagree about what the third-best move is.
  Hard is the honest setting for that reason; Medium's top 5 is wide enough that the wobble
  rarely reaches it. Takes effect on the next move you try; the deck does not change.`;

function difficultyOptions(): string {
  const chosen = difficulty();
  return DIFFICULTIES.map(
    d =>
      `<option value="${d}"${d === chosen ? ' selected' : ''}>${DIFFICULTY_NAMES[d]}${
        d === 'easy' ? '' : ` — top ${TOP_LINES[d]}`
      }</option>`,
  ).join('');
}

const ordinal = (n: number): string =>
  n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : n === 4 ? 'fourth' : `${n}th`;

/** 0 means "decide for me", which is what most people want and what we default to. */
const threadSetting = (): number => settings().threads || Engine.defaultThreads();

function threadOptions(): string {
  const chosen = settings().threads;
  const cores = navigator.hardwareConcurrency || 0;
  const counts = [1, 2, 3, 4, 6, 8].filter(n => !cores || n <= cores);
  return [
    `<option value="0"${chosen === 0 ? ' selected' : ''}>automatic (${Engine.defaultThreads()})</option>`,
    ...counts.map(
      n => `<option value="${n}"${n === chosen ? ' selected' : ''}>${n} core${n === 1 ? '' : 's'}</option>`,
    ),
  ].join('');
}

const showEval = (e: { cp?: number; mate?: number }): string =>
  e.mate !== undefined ? `#${e.mate}` : `${e.cp! > 0 ? '+' : ''}${(e.cp! / 100).toFixed(1)}`;

function gameLine(game: ExportedGame, puzzle: Puzzle, move: number): string {
  const them = puzzle.pov === 'white' ? game.players.black : game.players.white;
  const name = them.user?.name ?? 'Anonymous';
  const when = new Date(game.createdAt).toLocaleDateString();
  return `<p class="line"><span class="label">Game</span>
    <a href="https://lichess.org/${escape(game.id)}/${puzzle.pov}#${puzzle.ply}" target="_blank"
       rel="noopener">move ${move} vs ${escape(name)}</a>, ${escape(when)}</p>`;
}

/**
 * Isolation failing is not a detail: without it there is no engine, so games
 * lichess has not already analysed produce nothing at all. Say which piece is
 * missing rather than "unavailable", because the three causes have three
 * different answers.
 */
function isolationWarning(report: IsolationReport): string {
  if (report.isolated) return '';
  const detail = report.problem
    ? escape(report.problem)
    : 'The page is not cross-origin isolated.';
  return `<p class="warn"><strong>No engine on this load.</strong> ${detail}
    Games lichess has already analysed still work; the rest need the engine.
    <span class="dim">isolated: ${report.isolated} · service worker: ${
      report.controlled ? 'in control' : 'not in control'
    } · SharedArrayBuffer: ${report.sharedArrayBuffer ? 'yes' : 'no'}</span></p>`;
}

function footer(): string {
  return `<footer>
    <a href="https://github.com/Gamah/lichess-blindspot">Source</a> · AGPL-3.0-or-later ·
    positions from <a href="https://lichess.org">lichess.org</a>
  </footer>`;
}
