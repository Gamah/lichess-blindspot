// The whole UI. Plain DOM: three screens, one board, no framework.
//
// The rule this file exists to keep: until a position is solved, the screen
// says nothing about where it came from. No game link, no opponent, no date,
// no ply, no eval, no "you played". Everything of that kind lives in
// `renderReveal`, which is only ever called after the solve is done.

import { Deck } from '../app/deck.ts';
import { Pipeline, type Progress } from '../app/pipeline.ts';
import type { Puzzle } from '../deck/build.ts';
import { Engine, EngineUnavailable, type BootProgress } from '../engine/stockfish.ts';
import type { Analyser } from '../engine/analyse.ts';
import { ExportError, type ExportedGame } from '../lichess/export.ts';
import { Solve } from '../solve/retro.ts';
import { Profile, requestPersistence, storageEstimate, type SolveRecord } from '../storage/db.ts';
import { recentUsernames, rememberUsername } from '../storage/prefs.ts';
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
  private enginePromise: Promise<Analyser> | undefined;
  private engineFailed: string | undefined;
  private progress: Progress = { gamesDone: 0, gamesPending: 0, engineBusy: false };
  private booting: BootProgress | undefined;
  private unlocked = false;
  /** Set when lichess asks us to wait; no export before this. */
  private notBefore = 0;
  private notice: string | undefined;
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
    this.renderLanding(preset);
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
              rule lichess itself uses. Opening moves the masters play are dropped rather than
              held against you.</p>
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
        <button id="storage" class="quiet">Storage</button>
        <button id="switch" class="quiet">Switch player</button>
      </header>
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
    this.board = new Board(this.root.querySelector('#board') as HTMLElement, m => void this.onMove(m));
    (this.root.querySelector('#solution') as HTMLButtonElement).onclick = () => void this.showSolution();
    (this.root.querySelector('#skip') as HTMLButtonElement).onclick = () => this.skip();
    (this.root.querySelector('#next') as HTMLButtonElement).onclick = () => void this.nextPuzzle();
    (this.root.querySelector('#switch') as HTMLButtonElement).onclick = () => this.switchPlayer();
    (this.root.querySelector('#storage') as HTMLButtonElement).onclick = () => void this.toggleStorage();
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

  private async toggleStorage(): Promise<void> {
    const panel = this.root.querySelector('#panel') as HTMLElement | null;
    if (!panel || !this.profile) return;
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    const estimate = await storageEstimate();
    const solved = this.deck.solvedCount();
    panel.hidden = false;
    panel.innerHTML = `
      <h2>Storage</h2>
      <p class="line">${
        estimate
          ? `${mb(estimate.usage)} used of ${mb(estimate.quota)} available`
          : 'This browser will not say how much space it is using.'
      }</p>
      <p class="hint">Games can always be fetched again. Puzzles and your ${solved} solved
        position${solved === 1 ? '' : 's'} cannot, and are never purged automatically.</p>
      <div class="controls">
        <button id="purge" class="quiet">Purge stored games</button>
        <button id="unsolve" class="quiet">Bring back solved</button>
        <button id="wipe" class="quiet danger">Delete everything for ${escape(
          this.profile.username,
        )}</button>
        <button id="close">Close</button>
      </div>
      <p class="line" id="panel-status"></p>`;

    const status = (text: string) => {
      const el = panel.querySelector('#panel-status');
      if (el) el.textContent = text;
    };
    (panel.querySelector('#close') as HTMLButtonElement).onclick = () => (panel.hidden = true);
    (panel.querySelector('#purge') as HTMLButtonElement).onclick = async () => {
      const dropped = await this.profile?.purgeGames();
      status(`${dropped ?? 0} game payload${dropped === 1 ? '' : 's'} dropped.`);
    };
    (panel.querySelector('#unsolve') as HTMLButtonElement).onclick = async () => {
      await this.profile?.clearSolves();
      status('Solve history cleared. Reload to shuffle the solved positions back in.');
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

    const [puzzles, solves] = await Promise.all([profile.puzzles(), profile.solves()]);
    this.deck.markSolved(solves.map((s: SolveRecord) => s.puzzleId));
    this.deck.add(puzzles);

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

    void this.pipeline.run().then(() => this.maybeUnlock(true));
    this.maybeUnlock();
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
    this.solve = new Solve(puzzle, puzzle.openingUcis ?? []);
    this.attempts = 0;
    this.board?.set(puzzle.fen, puzzle.pov, true);
    this.setReveal('');
    this.setFeedback(
      `<strong>${puzzle.pov === 'white' ? 'White' : 'Black'} to play.</strong>
       <span>Find the move. There is a better one than the one that was played.</span>`,
    );
    this.toggleNext(false);
    this.renderCounters();
  }

  private async onMove(move: PlayedMove): Promise<void> {
    const solve = this.solve;
    if (!solve || !solve.isSolving()) return;
    this.attempts++;
    const verdict = solve.play(move);
    if (verdict === 'eval') {
      this.setFeedback(`<strong>Checking ${escape(move.san)}…</strong>`);
      const judged = await this.judge(move);
      // With no engine there is no verdict to give, so only the move it would
      // have played can be accepted, and the note says as much.
      if (judged.score) solve.onCeval(judged.score);
      else solve.feedback = move.uci === solve.puzzle.best ? 'win' : 'fail';
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
   */
  private async judge(move: PlayedMove): Promise<{ score?: { cp?: number; mate?: number }; note?: string }> {
    this.pipeline?.pause();
    try {
      const engine = await this.engine();
      const line = await engine.analyse({ fen: move.after, movetime: JUDGE_MOVETIME });
      return { score: line.score };
    } catch {
      return {
        note: 'The engine is unavailable here, so only its own move can be accepted.',
      };
    } finally {
      this.pipeline?.resume();
    }
  }

  private async finish(result: 'win' | 'view'): Promise<void> {
    const solve = this.solve;
    if (!solve || !this.profile) return;
    this.board?.freeze();
    // Finding it is the moment the context comes back, so show what the game
    // did instead. Red, and only once the answer can no longer be a hint.
    if (result === 'win') this.board?.drawMove(solve.puzzle.played.uci);
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
    if (this.deck.unsolvedCount() < REFILL_AT) void this.refill();
  }

  private async showSolution(): Promise<void> {
    const solve = this.solve;
    if (!solve || solve.isDone()) return;
    solve.viewSolution();
    this.setFeedback(`<strong>${escape(solve.puzzle.pv.join(' '))}</strong>`);
    await this.finish('view');
    await this.board?.playLine([solve.puzzle.best], solve.puzzle.fen);
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
    }).then(
      engine => {
        this.booting = undefined;
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
      ${analysing ? `<span class="working">analysing ${p.gamesDone + 1}…</span>` : ''}`;
  }
}

// --- formatting -------------------------------------------------------------

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

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
