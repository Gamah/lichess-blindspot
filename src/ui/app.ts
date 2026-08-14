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
import type { ExportedGame } from '../lichess/export.ts';
import { Solve } from '../solve/retro.ts';
import { Profile, requestPersistence, type SolveRecord } from '../storage/db.ts';
import { recentUsernames, rememberUsername } from '../storage/prefs.ts';
import { Board, type PlayedMove } from './board.ts';

/** Unlock the board once this many games are through, or this many puzzles exist. */
const GATE_GAMES = 5;
const GATE_PUZZLES = 5;
/** Fetch more when the deck gets this thin. */
const REFILL_AT = 5;
/** How long the engine gets to judge a move the player invented. */
const JUDGE_MOVETIME = 1000;

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

  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  start(): void {
    const preset = new URLSearchParams(location.search).get('u') ?? recentUsernames()[0] ?? '';
    this.renderLanding(preset);
  }

  // --- screens ------------------------------------------------------------

  private renderLanding(preset: string, error?: string): void {
    this.root.innerHTML = `
      <main class="landing">
        <h1>Blindspot</h1>
        <p class="tagline">Puzzles from your own games. No account, nothing stored anywhere but here.</p>
        <form class="start">
          <input name="username" list="recent" placeholder="lichess username" autocomplete="off"
                 autocapitalize="off" spellcheck="false" value="${escape(preset)}" required>
          <datalist id="recent">${recentUsernames().map(u => `<option value="${escape(u)}">`).join('')}</datalist>
          <button type="submit">Find my blindspots</button>
        </form>
        ${error ? `<p class="error">${escape(error)}</p>` : ''}
        ${isolationWarning()}
      </main>
      ${footer()}`;
    const form = this.root.querySelector('form.start') as HTMLFormElement;
    form.addEventListener('submit', e => {
      e.preventDefault();
      const username = (new FormData(form).get('username') as string).trim();
      if (username) void this.begin(username);
    });
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
      ${footer()}`;
    this.board = new Board(this.root.querySelector('#board') as HTMLElement, m => void this.onMove(m));
    (this.root.querySelector('#solution') as HTMLButtonElement).onclick = () => void this.showSolution();
    (this.root.querySelector('#skip') as HTMLButtonElement).onclick = () => this.skip();
    (this.root.querySelector('#next') as HTMLButtonElement).onclick = () => void this.nextPuzzle();
  }

  // --- flow ---------------------------------------------------------------

  private async begin(username: string): Promise<void> {
    rememberUsername(username);
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
      },
      onProgress: p => {
        this.progress = p;
        this.maybeUnlock();
      },
      onError: e => this.fail(e),
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
    if (!puzzle) {
      this.renderExhausted();
      void this.refill();
      return;
    }
    this.solve = new Solve(puzzle);
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
      solve.onCeval(judged.score ?? { cp: 0 });
      if (!judged.score) solve.feedback = move.uci === solve.puzzle.best ? 'win' : 'fail';
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
    this.setFeedback(
      `<strong>That is the deck.</strong>
       <span>Fetching more games — leave this open and they will appear.</span>`,
    );
    this.board?.freeze();
    this.toggleNext(true);
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

function isolationWarning(): string {
  if (crossOriginIsolated) return '';
  return `<p class="warn">The multithreaded engine is not available on this load
    (no cross-origin isolation yet). Reload once and it should be — games lichess has
    already analysed work either way.</p>`;
}

function footer(): string {
  return `<footer>
    <a href="https://github.com/Gamah/lichess-blindspot">Source</a> · AGPL-3.0-or-later ·
    positions from <a href="https://lichess.org">lichess.org</a>
  </footer>`;
}
