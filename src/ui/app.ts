// The whole UI. Plain DOM: three screens, one board, no framework.
//
// The rule this file exists to keep: until a position is solved, the screen
// says nothing about where it came from. No game link, no opponent, no date,
// no ply, no eval. Everything of that kind lives in `renderReveal`, which is
// only ever called after the solve is done.
//
// One deliberate exception: the move played in the game is drawn in red from
// the start. It is the one answer that is always wrong, so withholding it does
// not make the puzzle harder — it makes it longer, for exactly the people who
// do not remember the game they are being shown. That is a hint about what
// failed, not about what works.

import { Deck } from '../app/deck.ts';
import { Pipeline, type Progress } from '../app/pipeline.ts';
import type { Puzzle } from '../deck/build.ts';
import { derivedKey, puzzlesFromGame } from '../deck/derive.ts';
import { Engine, EngineUnavailable, type BootProgress } from '../engine/stockfish.ts';
import type { Analyser } from '../engine/analyse.ts';
import { ExportError, type ExportedGame } from '../lichess/export.ts';
import { altVerdicts, DIFFICULTIES, Solve, TOP_LINES, type Difficulty } from '../solve/retro.ts';
import {
  mb,
  Profile,
  requestPersistence,
  storageEstimate,
  storagePressure,
  type SolveRecord,
} from '../storage/db.ts';
import {
  BYTES_PER_GAME,
  difficulty,
  difficultyChosen,
  MOBILE_GAME_LIMIT,
  forgetPrefs,
  recentUsernames,
  rememberUsername,
  saveSettings,
  settings,
} from '../storage/prefs.ts';
import type { IsolationReport } from '../isolation.ts';
import { hiddenRows, lookup, reviewRows, waitingSummary, type ReviewRow } from '../deck/review.ts';
import { deckStats } from '../deck/stats.ts';
import { aboutPanel, fineprint, pitch, steps } from './about.ts';
import { escape, gameUrl, moveNumber, showEval } from './format.ts';
import { deckPanel, NO_PAGES, type DeckPages } from './review.ts';
import { Board, miniBoard, type PlayedMove } from './board.ts';
import { footer, GATE_GAMES, GATE_PUZZLES, LoadingScreen } from './loading.ts';

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

/** The inline panel under the board has two tenants; `App.panel` says which. */
type PanelKind = 'settings' | 'about';

export class App {
  private profile: Profile | undefined;
  private pipeline: Pipeline | undefined;
  private deck = new Deck();
  /**
   * Puzzles already derived, per game, with the stamp they were derived from.
   * Kept because `buildDeck` runs on every load and every Settings click that
   * shapes the deck, and re-deriving is a full chessops replay per game.
   */
  private derived = new Map<string, { key: string; puzzles: Puzzle[] }>();
  private board: Board | undefined;
  /** Which of the two things the inline panel is currently showing, if it is open. */
  private panel: PanelKind | undefined;
  /**
   * The position on the board is a replay of one already solved, picked out of
   * the deck panel. It must not be recorded again: a replay that went badly
   * would otherwise overwrite "found it, first try" with "looked at the
   * answer", which is a worse record of what happened than no record.
   */
  private replaying = false;
  /**
   * The deck dialog's rows, held only while it is open — closing it drops them
   * so the next open reads fresh records rather than showing a stale list.
   */
  private deckRows: { solved: readonly ReviewRow[]; hidden: readonly ReviewRow[] } | undefined;
  private deckPages: DeckPages = NO_PAGES;
  /** Games indexed for the dialog, alongside `deckRows` and dropped with them. */
  private deckGames: ReadonlyMap<string, ExportedGame> = new Map();
  /** Owns the loading screen's DOM between progress events; see `renderLoading`. */
  private loading: LoadingScreen | undefined;
  private solve: Solve | undefined;
  private attempts = 0;
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

        ${pitch()}

        <form class="start">
          <input name="username" list="recent" placeholder="lichess username" autocomplete="off"
                 autocapitalize="off" spellcheck="false" value="${escape(preset)}" required>
          <datalist id="recent">${recentUsernames().map(u => `<option value="${escape(u)}">`).join('')}</datalist>
          <button type="submit">Find my blindspots</button>
        </form>
        <p class="hint">Any lichess username works — practising someone else's blindspots is a
          perfectly good way to spend an evening.</p>

        ${error ? `<p class="error">${escape(error)}</p>` : ''}
        ${engineNag(this.isolation, this.engineFailed)}
        ${batteryWarning()}

        ${steps()}
        ${fineprint()}
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

  /**
   * The loading screen, mounted once and patched thereafter.
   *
   * This is called on **every** pipeline progress event — several a second for
   * as long as the analysis runs — so it must not be a render. `LoadingScreen`
   * owns the DOM and compares each field against what is already in it; the
   * only thing that happens here is assembling the values.
   */
  private renderLoading(): void {
    // Another screen may have taken the root since this was last shown.
    if (!this.loading?.attached()) this.loading = new LoadingScreen(this.root);
    this.loading.update({
      boot: this.booting,
      gamesDone: this.progress.gamesDone,
      found: this.deck.unsolvedCount(),
      within: this.progress.current ?? 0,
      backlog: this.progress.backlog ?? 0,
      notice: this.notice,
      nag: engineNag(this.isolation, this.engineFailed),
      battery: batteryWarning(),
    });
  }

  private renderSolving(): void {
    this.root.innerHTML = `
      <header class="topbar">
        <span class="who">${escape(this.profile?.username ?? '')}</span>
        <span class="spacer"></span>
        <button id="deck-open" class="quiet">Deck</button>
        <button id="about" class="quiet">About</button>
        <button id="settings" class="quiet">Settings</button>
        <button id="switch" class="quiet">Switch player</button>
      </header>
      <p class="warn" id="notice" hidden></p>
      <div id="engine-nag"></div>
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
          <!-- Putting a position aside belongs here as much as in the deck
               dialog: the moment you want it gone is usually the moment you
               are looking at it. -->
          <div class="controls minor">
            <button id="hide" class="quiet">Hide this position</button>
          </div>
          <div class="counters" id="counters"></div>
        </aside>
      </main>
      <div class="panel" id="panel" hidden></div>
      <dialog class="deck-dialog" id="deck-dialog"></dialog>
      ${footer()}`;
    this.panel = undefined;
    this.paintStorageNote();
    this.board = new Board(this.root.querySelector('#board') as HTMLElement, m => void this.onMove(m));
    (this.root.querySelector('#solution') as HTMLButtonElement).onclick = () => void this.showSolution();
    (this.root.querySelector('#skip') as HTMLButtonElement).onclick = () => this.skip();
    (this.root.querySelector('#next') as HTMLButtonElement).onclick = () => void this.nextPuzzle();
    (this.root.querySelector('#hide') as HTMLButtonElement).onclick = () => {
      const id = this.solve?.puzzle.id;
      if (id) void this.hidePuzzle(id);
    };
    (this.root.querySelector('#switch') as HTMLButtonElement).onclick = () => this.switchPlayer();
    (this.root.querySelector('#settings') as HTMLButtonElement).onclick = () => void this.togglePanel('settings');
    (this.root.querySelector('#about') as HTMLButtonElement).onclick = () => void this.togglePanel('about');
    (this.root.querySelector('#deck-open') as HTMLButtonElement).onclick = () => void this.openDeck();
    // Escape and the backdrop are the dialog's own; this is the only state we keep.
    (this.root.querySelector('#deck-dialog') as HTMLDialogElement).onclose = () => {
      this.deckRows = undefined;
    };
  }

  /**
   * The inline panel, in one of two modes. The deck is not one of them — it is
   * a modal dialog, for the reason written at the top of `review.ts`.
   *
   * About is here because there is otherwise **no way back to the explanation**
   * once a username has been typed: the landing page is reachable only through
   * Switch player, which throws the session away to get there, and someone who
   * arrives with a name already remembered never sees it at all. Its copy is
   * shared with the landing page rather than written twice — see `about.ts`.
   */
  private async togglePanel(kind: PanelKind): Promise<void> {
    const panel = this.root.querySelector('#panel') as HTMLElement | null;
    if (!panel || !this.profile) return;
    // The button that opened it also closes it; the other button switches.
    if (!panel.hidden && this.panel === kind) return this.closePanel();
    this.panel = kind;
    panel.hidden = false;
    // Prose wants a narrower measure than a settings grid does.
    panel.className = kind === 'about' ? 'panel about' : 'panel';
    if (kind === 'about') {
      panel.innerHTML = aboutPanel(batteryWarning());
      this.wireClose(panel);
      panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    await this.renderSettings(panel);
  }

  private closePanel(): void {
    const panel = this.root.querySelector('#panel') as HTMLElement | null;
    if (panel) panel.hidden = true;
    this.panel = undefined;
  }

  private wireClose(panel: HTMLElement): void {
    (panel.querySelector('#close') as HTMLButtonElement).onclick = () => this.closePanel();
  }

  /**
   * The deck, looked at rather than dealt from — a modal dialog rather than the
   * inline panel, because it is a grid of boards that can run to hundreds and
   * reading it must not scroll the board being solved off the screen.
   *
   * Everything shown comes out of what is already in memory (the derivation
   * cache) plus one read of the solve records, so opening it costs no engine
   * time. The rows are then held for as long as the dialog is open: turning a
   * page re-renders a dozen cards and touches storage again for nothing.
   */
  private async openDeck(): Promise<void> {
    const dialog = this.root.querySelector('#deck-dialog') as HTMLDialogElement | null;
    const profile = this.profile;
    if (!dialog || !profile) return;
    this.deckPages = NO_PAGES;
    dialog.innerHTML = '<p class="hint">Reading your deck…</p>';
    dialog.showModal();
    const [solves, games, hides] = await Promise.all([
      profile.solves(),
      profile.games(),
      profile.hidden(),
    ]);
    // Switch player is one click, and three reads are not instant.
    if (this.profile !== profile || !dialog.open) return;
    const from = lookup(
      [...this.derived.values()].flatMap(entry => entry.puzzles),
      games,
    );
    const hiddenIds = new Set(hides.map(h => h.puzzleId));
    this.deckRows = {
      solved: reviewRows(solves, from, hiddenIds),
      hidden: hiddenRows(hides, solves, from),
    };
    this.deckGames = from.games;
    this.paintDeck();
  }

  /**
   * Render the dialog from what is held. Called on open and on every page turn,
   * which is why it mounts its own boards: `innerHTML` throws the previous
   * page's chessground instances away with the markup, and they hold no state
   * worth keeping — `miniBoard` is view-only and has no listeners of its own.
   */
  private paintDeck(): void {
    const dialog = this.root.querySelector('#deck-dialog') as HTMLDialogElement | null;
    const rows = this.deckRows;
    if (!dialog?.open || !rows) return;
    const waiting = this.deck.waiting();
    dialog.innerHTML = deckPanel({
      summary: waitingSummary(waiting),
      waiting,
      games: this.deckGames,
      solved: rows.solved,
      hidden: rows.hidden,
      stats: deckStats(rows.solved, { waiting: waiting.length, hidden: rows.hidden.length }, Date.now()),
      pages: this.deckPages,
    });
    (dialog.querySelector('#close') as HTMLButtonElement).onclick = () => dialog.close();
    for (const el of dialog.querySelectorAll<HTMLElement>('.mini[data-fen]'))
      miniBoard(el, el.dataset.fen!, el.dataset.pov === 'black' ? 'black' : 'white', {
        ...(el.dataset.played ? { played: el.dataset.played } : {}),
        ...(el.dataset.last ? { last: el.dataset.last } : {}),
      });
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button[data-review]'))
      button.onclick = () => void this.fromDeck(button.dataset.review!, true);
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button[data-serve]'))
      button.onclick = () => void this.fromDeck(button.dataset.serve!, false);
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button[data-hide]'))
      button.onclick = () => void this.hidePuzzle(button.dataset.hide!);
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button[data-restore]'))
      button.onclick = () => void this.restorePuzzle(button.dataset.restore!);
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button[data-forget]'))
      button.onclick = () => void this.forgetSolve(button.dataset.forget!);
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('button[data-page]')) {
      const [half, page] = button.dataset.page!.split(':') as ['waiting' | 'solved', string];
      button.onclick = () => {
        this.deckPages = { ...this.deckPages, [half]: Number(page) };
        this.paintDeck();
        dialog.scrollTop = 0;
      };
    }
  }

  // --- putting positions aside, and deleting games -------------------------

  /**
   * Out of the shuffle, kept, reversible. There is nothing to delete: a puzzle
   * is derived from its game on every deck build, so the only way one stops
   * coming round is a note saying so — which is what `hide:` is.
   *
   * Works on a solved position too, where it means "take this off the solved
   * list"; the two facts are independent and the Hidden section shows both.
   */
  private async hidePuzzle(puzzleId: string): Promise<void> {
    if (!this.profile) return;
    await this.profile.hide(puzzleId, Date.now());
    this.deck.markHidden([puzzleId]);
    // Hiding what is on the board deals the next one, or the position stays up
    // with nothing behind it.
    if (this.solve?.puzzle.id === puzzleId) {
      (this.root.querySelector('#deck-dialog') as HTMLDialogElement | null)?.close();
      await this.nextPuzzle();
    }
    await this.refreshDeckDialog();
    this.renderCounters();
  }

  private async restorePuzzle(puzzleId: string): Promise<void> {
    if (!this.profile) return;
    await this.profile.restore(puzzleId);
    // `Deck` has no un-hide: the set is rebuilt from storage every time, so a
    // full rebuild is both the simplest correct answer and the cheap one, since
    // `derivedKey` means nothing is re-derived.
    await this.buildDeck();
    await this.refreshDeckDialog();
    this.renderCounters();
  }

  /** A solve record whose position no longer exists. Tidying, nothing more. */
  private async forgetSolve(puzzleId: string): Promise<void> {
    if (!this.profile) return;
    await this.profile.forgetSolve(puzzleId);
    await this.buildDeck();
    await this.refreshDeckDialog();
    this.renderCounters();
  }

  /** Re-read and repaint the dialog, if it is open. Cheap: no engine, one read. */
  private async refreshDeckDialog(): Promise<void> {
    const dialog = this.root.querySelector('#deck-dialog') as HTMLDialogElement | null;
    if (!dialog?.open || !this.profile) return;
    const from = lookup(
      [...this.derived.values()].flatMap(entry => entry.puzzles),
      await this.profile.games(),
    );
    const [solves, hides] = await Promise.all([this.profile.solves(), this.profile.hidden()]);
    if (!dialog.open) return;
    const hiddenIds = new Set(hides.map(h => h.puzzleId));
    this.deckRows = {
      solved: reviewRows(solves, from, hiddenIds),
      hidden: hiddenRows(hides, solves, from),
    };
    this.deckGames = from.games;
    this.paintDeck();
  }

  /**
   * Put a position from the dialog on the board. Two doors into one thing:
   *
   * - **replay** a solved one. It stays solved — the deck already counts it
   *   that way, `serve` only makes it the thing on screen — and `finish` writes
   *   nothing while `replaying` is set, so a replay cannot overwrite the record
   *   of how it went the first time.
   * - **deal** a waiting one out of turn. `take` lifts it out of `pending`
   *   exactly as `next()` would have when its turn came, so it is an ordinary
   *   solve and is recorded like one.
   *
   * Whatever was on the board goes back in the queue, unsolved, exactly as Skip
   * leaves it. `requeue` ignores a puzzle that is already solved, so a run of
   * replays cannot pile them into `pending`.
   */
  private async fromDeck(puzzleId: string, replaying: boolean): Promise<void> {
    const puzzle = replaying
      ? [...this.derived.values()].flatMap(entry => entry.puzzles).find(p => p.id === puzzleId)
      : this.deck.waiting().find(p => p.id === puzzleId);
    if (!puzzle) return;
    const current = this.deck.current();
    if (current && current.id !== puzzleId) this.deck.requeue(current);
    (this.root.querySelector('#deck-dialog') as HTMLDialogElement | null)?.close();
    this.awaitingPuzzles = false;
    clearTimeout(this.exhaustedTimer);
    if (replaying) this.deck.serve(puzzle);
    else if (!this.deck.take(puzzleId)) return;
    this.replaying = replaying;
    await this.present(puzzle);
  }

  /** Back to the landing screen, with the background work stopped. */
  private switchPlayer(): void {
    this.pipeline?.stop();
    const previous = this.profile?.username ?? '';
    this.pipeline = undefined;
    this.profile = undefined;
    this.deck = new Deck();
    this.panel = undefined;
    // Keyed by game id, and two profiles can hold the same game from opposite
    // sides — so it belongs to the profile, not to the app.
    this.derived = new Map();
    this.solve = undefined;
    this.replaying = false;
    this.deckRows = undefined;
    this.board = undefined;
    this.progress = { gamesDone: 0, gamesPending: 0, engineBusy: false };
    this.unlocked = false;
    // The engine stays booted: it is expensive to start and belongs to nobody.
    this.renderLanding(previous);
  }

  private async renderSettings(panel: HTMLElement): Promise<void> {
    if (!this.profile) return;
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
        <p class="hint">Finding mistakes is cheap; confirming one and ranking its alternatives
          costs a few seconds of engine time. Fewer per game means games are analysed faster and
          the deck draws from a wider spread of them. Raising it can only find more in games
          lichess analysed for us — our own pass stops searching once it has enough — and those
          extra positions appear as the engine gets round to ranking them, not immediately.</p>
      </div>

      <div class="setting">
        <label for="rank-ms">Thinking time per position</label>
        <select id="rank-ms">${rankTimeOptions()}</select>
        <p class="hint">How long the engine gets on <em>one position it is preparing</em>, which is
          where the five best moves — and so the whole difficulty setting — come from. It does not
          touch the quick pass that hunts for your mistakes in the first place, and it does not
          change <em>which</em> positions become puzzles, only how well they are understood.
          <br>
          Spending more is not worth as much as it sounds: measured against a twelve-second
          search, two seconds already names the same best move every time, and the tail of the
          list stays uncertain however long it is given. Worth lowering on a phone, where this is
          the bulk of the work and the battery. Raising it re-ranks positions done at the old
          setting, in the background; lowering it leaves the better work alone.</p>
      </div>

      <div class="setting">
        <label for="max-games">Games to keep</label>
        <select id="max-games">${gameLimitOptions()}</select>
        <p class="hint">Stops fetching once this many games are stored${
          estimate ? ` — you are using ${mb(estimate.usage)} of ${mb(estimate.quota)}` : ''
        }, at roughly ${(BYTES_PER_GAME / 1000).toFixed(0)} KB a game. It is a limit, not a
          budget: reaching it stops new games arriving, it never deletes what is held, because a
          stored game carries minutes of engine time that cannot be fetched back. Purge below is
          the manual way to make room. Worth setting on a phone, where the browser is quicker to
          throw a large database away.</p>
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
          that, so deleting games deletes their positions — <strong>and the record of having
          solved them</strong>, which would otherwise be a note about a position that no longer
          exists. Nothing is ever discarded on its own initiative; this button is the only thing
          that deletes games.</p>
      </div>

      <div class="setting">
        <span class="label-text">Solved positions</span>
        <button id="unsolve" class="quiet">Bring back ${solved}</button>
        <p class="hint">Solved positions leave the shuffle but stay stored. This puts them all
          back in, and re-solving them is recorded as solving them. To go back over one without
          disturbing any of that, use Deck in the bar above — it lists them and will put a
          single position back on the board as a replay.</p>
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
    (panel.querySelector('#close') as HTMLButtonElement).onclick = () => {
      panel.hidden = true;
      this.panel = undefined;
    };
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
      // a record: the cap can simply be applied again to everything. Raising it
      // can turn up candidates nothing has ranked, though, and those stay
      // withheld until the engine has been round them — so the backlog is
      // opened again rather than left until the next session.
      this.pipeline?.recheckBacklog();
      await this.buildDeck();
      this.renderCounters();
      status(
        `${
          value === 0
            ? 'Taking every mistake it finds from each game'
            : `Taking up to ${value} position${value === 1 ? '' : 's'} from each game`
        }. Deck rebuilt: ${this.deck.unsolvedCount()} waiting. Any positions this newly
         allows are ranked in the background and appear as they are done.`,
      );
      void this.refill();
    };
    (panel.querySelector('#rank-ms') as HTMLSelectElement).onchange = e => {
      const value = Number((e.target as HTMLSelectElement).value);
      const previous = settings().rankMs;
      saveSettings({ rankMs: value });
      // Raising it makes every shallower ranking into work again; lowering it
      // is simply believed from here on, because a deeper ranking is not worse.
      if (value > previous) this.pipeline?.recheckBacklog();
      status(
        value > previous
          ? `${seconds(value)} a position. The ones done in less are being redone in the background.`
          : `${seconds(value)} a position. Positions already given longer keep their ranking.`,
      );
      if (value > previous) void this.refill();
    };
    (panel.querySelector('#max-games') as HTMLSelectElement).onchange = e => {
      const value = Number((e.target as HTMLSelectElement).value);
      saveSettings({ maxGames: value });
      // Raising it means the pipeline can go back to lichess; lowering it does
      // nothing to what is already here, on purpose.
      this.pipeline?.recheckFull();
      status(
        value === 0
          ? 'Keeping games until the browser runs out of room.'
          : `Keeping at most ${value} games — about ${mb(value * BYTES_PER_GAME)}. Nothing already stored is deleted.`,
      );
      if (value === 0 || value > 0) void this.refill();
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
      const dropped = (await this.profile?.purgeGames()) ?? { games: 0, solves: 0 };
      this.pipeline?.recheckFull();
      await this.buildDeck();
      this.renderCounters();
      status(
        `${dropped.games} game${dropped.games === 1 ? '' : 's'} deleted, the positions from them, ` +
          `and ${dropped.solves} solved record${dropped.solves === 1 ? '' : 's'}. ` +
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
      // A first visit, so the defaults are simply recorded. On a phone that
      // includes a storage limit: an unbounded history is worst exactly where
      // the browser is keenest to throw the whole database away, and starting
      // bounded and raising it beats discovering it.
      saveSettings({ difficulty: 'easy', ...(onMobile() ? { maxGames: MOBILE_GAME_LIMIT } : {}) });
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
        <p class="warn">Those rankings are worked out in this browser before a position is ever
          put in front of you, and each one gets a couple of seconds — so a faster machine
          searches further in the same time, and the list is a seconds-long opinion rather than a
          settled fact. Measured against a twelve-second search over thirty positions from real
          games: the best move agreed 93% of the time and the top 5 always contained the longer
          search's second choice, but the <em>top 2</em> missed it about a quarter to a third of
          the time. So Medium's top 5 is something the engine is fairly sure of, and Hard is
          deliberately asking for more certainty than the search really has. Neither is a verdict
          on your move from on high.</p>
        <p><strong>Whichever you pick, every position already stored has to be ranked first.</strong>
          That includes the games lichess analysed for you — its export gives one best move per
          position and no way to ask for four more. It is one search per position you would be
          shown rather than a re-analysis, and it runs in the background with the deck opening as
          soon as the first few are done. On a long history it will keep the processor busy for a
          while. Nothing is downloaded again and nothing stored is lost.</p>
        ${batteryWarning()}
        <p>A solved position now also shows those five as numbered arrows, with the one you found
          in green and the move the game played in red. The setting can be changed at any time in
          Settings.</p>
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
    const [games, solves, hidden] = await Promise.all([
      profile.games(),
      profile.solves(),
      profile.hidden(),
    ]);
    // Switch player is one click and three IndexedDB reads are not instant.
    if (this.profile !== profile) return;
    const deck = new Deck();
    deck.markSolved(solves.map((s: SolveRecord) => s.puzzleId));
    // After markSolved, so a position that is both stays counted as solved and
    // leaves `pending` either way.
    deck.markHidden(hidden.map(h => h.puzzleId));
    const maxPerGame = settings().maxPerGame;
    // Re-derived only where something moved. See `derivedKey`: the replay this
    // skips is ~18 µs a ply, which on a long analysed history is most of a
    // second of blocked thread behind a Settings click. The new map is built
    // from the games that are still here, so purging prunes it for free.
    const fresh = new Map<string, { key: string; puzzles: Puzzle[] }>();
    const derived = games.flatMap(game => {
      const key = derivedKey(game, { maxPerGame });
      const hit = this.derived.get(game.id);
      const entry =
        hit?.key === key
          ? hit
          : { key, puzzles: puzzlesFromGame(game, profile.username, { maxPerGame }) };
      fresh.set(game.id, entry);
      return entry.puzzles;
    });
    this.derived = fresh;
    // One add, not one per game: `add` reshuffles what is left each time, and
    // the shuffle is what keeps two positions from one game apart.
    deck.add(derived);
    // Whatever is on the board is still on the board. Without this the new deck
    // holds the served position in `pending` with nothing marking it served, so
    // Next could deal the position already in front of them and Skip has to be
    // defended against duplicating it.
    const served = this.deck.current();
    if (served) deck.serve(served);
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
    this.replaying = false;
    await this.present(puzzle);
  }

  /**
   * Put a position on the board and start a solve on it. Shared by dealing the
   * next one and by replaying a solved one out of the deck panel — the two
   * differ only in what the deck did beforehand and in whether the result is
   * written down, never in what is shown.
   */
  private async present(puzzle: Puzzle): Promise<void> {
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
    // The move played in the game, from the start. It is the one answer that
    // can never be right, so hiding it only costs guesses to someone who does
    // not remember the game — which is most people, and is rather the point.
    this.board?.mark(puzzle.played.uci);
    this.setFeedback(
      `<strong>${puzzle.pov === 'white' ? 'White' : 'Black'} to play.</strong>
       <span>The red arrow is what was played here, and it was a mistake. Find something
       better.</span>`,
    );
  }

  private async onMove(move: PlayedMove): Promise<void> {
    const solve = this.solve;
    if (!solve || !solve.isSolving()) return;
    this.attempts++;
    const verdict = solve.play(move);
    if (verdict === 'eval') {
      const lines = TOP_LINES[difficulty()];
      // The ranking was gathered before this position was ever shown, so the
      // usual answer is instant and costs the engine nothing.
      const ranked = solve.onRanked(lines);
      if (ranked !== 'eval') return this.afterVerdict(ranked === 'win', move, rankNote(solve, lines));

      // All that is left is Easy with a move the engine did not rank: nothing
      // stored says what it is worth, so go and find out.
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
   * The last case that needs an engine at solve time: Easy, and a move the
   * ranking does not cover. lila's question and lila's search — one line, from
   * the position the move led to.
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
    // Everything about the position at once, on the board as it stands — the
    // engine's five best as numbered arrows, each green or red by whether the
    // eval test would have taken it, the move the game played in red over the
    // top, and the move that ended the solve at full strength. No search: the
    // ranking arrived with the puzzle and `altVerdicts` is arithmetic on it.
    const sound = altVerdicts(solve.puzzle);
    this.board?.reveal(
      solve.puzzle.alts.map((a, i) => ({ uci: a.uci, sound: sound[i] ?? false })),
      solve.puzzle.played.uci,
      result === 'win' ? solve.lastAttempt?.uci : undefined,
    );
    this.deck.markSolved([solve.puzzle.id]);
    // A replay is not a solve. Recording it would overwrite what actually
    // happened the first time — "found it, first try" becoming "looked at the
    // answer" is a worse record than none — and the position is already out of
    // the shuffle, so there is nothing else the write would achieve.
    if (!this.replaying)
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

  /**
   * Repainted rather than rendered once: the engine can fail long after the
   * solving screen was built — a dropped net download on the first position
   * that needs one — and a nag that only appears on the next full render is a
   * nag nobody sees.
   */
  private paintEngineNag(): void {
    const el = this.root.querySelector('#engine-nag');
    if (el) el.innerHTML = engineNag(this.isolation, this.engineFailed);
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
    const move = moveNumber(puzzle.ply);
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
      status === 'noEngine'
        ? `<span>The engine did not start, so nothing can be prepared and no more games are
             being fetched — the games already here are kept, unanalysed, and picked up as soon
             as there is an engine. The report link above carries the diagnostics.</span>`
        : status === 'full'
        ? `<span>The storage limit is reached, so no more games are being fetched — nothing
             stored has been deleted. Settings can raise the limit or purge older games.</span>`
        : status === 'exhausted'
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

  private toggleNext(show: boolean): void {
    const next = this.root.querySelector('#next') as HTMLButtonElement | null;
    const solution = this.root.querySelector('#solution') as HTMLButtonElement | null;
    const skip = this.root.querySelector('#skip') as HTMLButtonElement | null;
    if (next) next.hidden = !show;
    if (solution) solution.hidden = show;
    if (skip) skip.hidden = show;
  }

  private renderCounters(): void {
    this.paintEngineNag();
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
  Every position is ranked before it is shown to you, so this takes effect immediately and the
  same move always gets the same answer every time that position comes round. That ranking is a
  search of a couple of seconds, not an exhaustive one, and it is not equally sure of every part
  of its list. Measured against a twelve-second search over thirty positions from real games: the
  best move matched 93% of the time and the top 5 always contained the longer search's second
  choice — but the <strong>top 2</strong> missed it about a quarter to a third of the time. So
  Medium asks for something the engine is fairly confident about, and Hard asks for more
  certainty than a search this long can give. Spending longer does not fix it: eight times the
  time measured no better.`;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} seconds`;

function rankTimeOptions(): string {
  const chosen = settings().rankMs;
  const labels: Record<number, string> = {
    500: 'quickest — hard on nothing',
    1000: 'quick',
    2000: 'normal',
    4000: 'thorough',
    8000: 'as much as it can use',
  };
  return [500, 1000, 2000, 4000, 8000]
    .map(
      ms =>
        `<option value="${ms}"${ms === chosen ? ' selected' : ''}>${seconds(ms)} — ${labels[ms]}</option>`,
    )
    .join('');
}

function gameLimitOptions(): string {
  const chosen = settings().maxGames;
  return [50, 100, 150, 300, 500, 0]
    .map(
      n =>
        `<option value="${n}"${n === chosen ? ' selected' : ''}>${
          n === 0 ? 'no limit' : `${n} games (~${mb(n * BYTES_PER_GAME)})`
        }</option>`,
    )
    .join('');
}

function difficultyOptions(): string {
  const chosen = difficulty();
  return DIFFICULTIES.map(
    d =>
      `<option value="${d}"${d === chosen ? ' selected' : ''}>${DIFFICULTY_NAMES[d]}${
        d === 'easy' ? '' : ` — top ${TOP_LINES[d]}`
      }</option>`,
  ).join('');
}

/**
 * What the ranking decided, for the feedback line. The interesting half is
 * always where the engine put the move, whichever way the verdict went.
 */
function rankNote(solve: Solve, lines: number): string | undefined {
  if (solve.rank < 0)
    return lines > 0 ? `The engine does not have it in its top ${solve.puzzle.alts.length}.` : undefined;
  const where = `The engine has it ${ordinal(solve.rank + 1)}`;
  return lines > 0 && solve.rank >= lines
    ? `${where}, and this setting asks for its top ${lines}.`
    : `${where}.`;
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

function gameLine(game: ExportedGame, puzzle: Puzzle, move: number): string {
  const them = puzzle.pov === 'white' ? game.players.black : game.players.white;
  const name = them.user?.name ?? 'Anonymous';
  const when = new Date(game.createdAt).toLocaleDateString();
  return `<p class="line"><span class="label">Game</span>
    <a href="${gameUrl(game.id, puzzle)}" target="_blank"
       rel="noopener">move ${move} vs ${escape(name)}</a>, ${escape(when)}</p>`;
}

const REPO = 'https://github.com/Gamah/lichess-blindspot';

/**
 * Best effort, and it has to *be* best effort: there is no reliable way to ask
 * a browser "are you a phone". `navigator.userAgentData.mobile` is the one
 * honest answer and only Chromium has it, so the string sniff is the fallback
 * and both are wrapped — a wrong guess here must never be able to throw on the
 * boot path.
 *
 * Being wrong is cheap in one direction only: a laptop shown the battery
 * warning has been told something irrelevant, while a phone not shown it gets
 * a hot device and a flat battery with no explanation. So it errs towards
 * warning.
 */
function onMobile(): boolean {
  try {
    const hinted = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
    if (typeof hinted?.mobile === 'boolean') return hinted.mobile;
    return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/**
 * Said out loud rather than engineered around. Blindspot runs a chess engine
 * on every position before it shows it, and on a phone that is a real cost in
 * heat and battery — which is a thing to tell someone, not a reason to give
 * them a worse ranking. The dial that actually helps is fewer positions per
 * game, so it points at that.
 */
function batteryWarning(): string {
  if (!onMobile()) return '';
  return `<p class="warn"><strong>This will work your phone hard.</strong> Stockfish runs in this
    tab and searches every position before you are shown it, so a long history means sustained
    processor use — a warm device and a noticeable dent in the battery. It is meant to do that,
    and it is worth plugging in for. Settings can lower "positions per game" and the number of
    processor cores, which is the honest way to spend less.</p>`;
}

/**
 * **Running without an engine is not a supported mode.** It used to be a
 * degraded one — games lichess had already analysed produced positions for
 * free — and it no longer is: a position is not shown until the engine has
 * ranked its alternatives, so no engine means no deck at all, for everyone.
 *
 * So this does not apologise, it nags, and it nags on every screen until it is
 * fixed. The report link carries the diagnostics, because the three causes
 * (no isolation, a service worker that never took control, a dropped net
 * download) look identical from the outside and only the numbers tell them
 * apart.
 */
function engineNag(report: IsolationReport, failure?: string): string {
  if (report.isolated && !failure) return '';
  const facts = [
    `isolated: ${report.isolated}`,
    `service worker: ${report.controlled ? 'in control' : 'not in control'}`,
    `SharedArrayBuffer: ${report.sharedArrayBuffer ? 'yes' : 'no'}`,
    ...(report.problem ? [`problem: ${report.problem}`] : []),
    ...(failure ? [`engine: ${failure}`] : []),
  ];
  const body = [
    'The engine did not start. Diagnostics:',
    '',
    ...facts.map(f => `- ${f}`),
    `- url: ${location.href}`,
    `- userAgent: ${navigator.userAgent}`,
    '',
    'What I did before this appeared:',
  ].join('\n');
  const url = `${REPO}/issues/new?title=${encodeURIComponent('Engine did not start')}&body=${encodeURIComponent(body)}`;
  return `<p class="warn nag"><strong>The engine is not running, and it should be.</strong>
    Stockfish runs in this tab and every position is prepared by it, so without one there is
    nothing to solve — this is a bug rather than a way to use the app.
    <a href="${url}" target="_blank" rel="noopener">Report it</a>, and the link will carry the
    numbers below.
    <span class="dim">${escape(facts.join(' · '))}</span></p>`;
}

