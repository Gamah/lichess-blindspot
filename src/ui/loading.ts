// The wait before the board opens, which on a first visit or a catch-up is
// minutes rather than seconds.
//
// **It is built once and then patched.** This screen is driven by the
// pipeline's progress events, which arrive once per swept position — several a
// second, all day, on a long history. It used to answer each one by rewriting
// the whole page: `innerHTML` on the root, which throws away and re-parses a
// dozen elements and a couple of hundred words of prose to move a bar a
// pixel. Nothing else in the app is on a hot path at all, so this is the one
// place where a render has to be a diff, and the diff is small enough to write
// out by hand — half a dozen fields, each compared against what is already
// there so an unchanged one costs a string comparison.
//
// Two rules learned by watching it, which the copy and the bar both encode:
//
// - The bar measures **progress towards being able to start**, not towards all
//   the work being done. Those are wildly different when a long history is
//   being caught up, and only the first one ends when the board appears.
// - It has to move *within* a game, not once per game. The gate is five games,
//   so a bar stepping in fifths moved twice and then the board was there —
//   which is indistinguishable from a bar that is broken. The pipeline already
//   reports a fraction through the game it is on; that is what makes it
//   continuous.

import type { BootProgress } from '../engine/stockfish.ts';

/**
 * Unlock the board once this many games are through, or this many puzzles
 * exist. They live here because they are what the bar is measured against and
 * what its copy promises; `App.maybeUnlock` is the other half.
 */
export const GATE_GAMES = 5;
export const GATE_PUZZLES = 5;

export interface LoadingView {
  /** Set while the engine is starting, and its own phase with its own bar. */
  boot?: BootProgress | undefined;
  /** Games finished this session. */
  gamesDone: number;
  /** Positions ready to solve. */
  found: number;
  /** 0..1 through the game being worked on. */
  within: number;
  /** Stored games still owing a ranking pass. */
  backlog: number;
  /** lichess asked us to wait, or something else worth a line. */
  notice?: string | undefined;
  /** The engine-nag block, already rendered. Empty when there is nothing wrong. */
  nag: string;
  /** The phone battery warning, already rendered. Empty on a desktop. */
  battery: string;
}

/** One field of the screen: where it lives, and what was last put in it. */
interface Slot {
  el: HTMLElement;
  last: string | undefined;
}

export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly main: HTMLElement;
  private readonly status: Slot;
  private readonly notice: Slot;
  private readonly nag: Slot;
  private readonly battery: Slot;
  private readonly fill: HTMLElement;
  private readonly detail: Slot;
  private readonly hint: Slot;
  private lastWidth = -1;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <main class="loading">
        <h1>Blindspot</h1>
        <p class="status"></p>
        <p class="warn" id="loading-notice" hidden></p>
        <div id="loading-nag"></div>
        <div id="loading-battery"></div>
        <div class="bar"><div class="fill" style="width:0%"></div></div>
        <p class="detail"></p>
        <p class="hint"></p>
      </main>
      ${footer()}`;
    const find = (sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
    this.main = find('main.loading');
    this.status = { el: find('.status'), last: undefined };
    this.notice = { el: find('#loading-notice'), last: undefined };
    this.nag = { el: find('#loading-nag'), last: undefined };
    this.battery = { el: find('#loading-battery'), last: undefined };
    this.fill = find('.fill');
    this.detail = { el: find('.detail'), last: undefined };
    this.hint = { el: find('.hint'), last: undefined };
  }

  /** False once another screen has taken the root, so `App` knows to rebuild. */
  attached(): boolean {
    return this.root.contains(this.main);
  }

  update(view: LoadingView): void {
    const { boot, gamesDone, found, within, backlog } = view;
    // Either gate can open the board, so the bar tracks whichever is closer.
    const ready = Math.min(1, Math.max(found / GATE_PUZZLES, (gamesDone + within) / GATE_GAMES));
    // The net download is its own phase and its own bar; the status line above
    // says which of the two is being shown.
    const width = Math.round((boot?.download ?? ready) * 100);

    text(
      this.status,
      boot?.message ?? (backlog ? 'Working out the best moves' : 'Analysing your games'),
    );

    // The one field that appears and disappears rather than merely changing.
    if (this.notice.last !== view.notice) {
      this.notice.last = view.notice;
      this.notice.el.textContent = view.notice ?? '';
      this.notice.el.hidden = !view.notice;
    }

    html(this.nag, view.nag);
    html(this.battery, view.battery);

    if (width !== this.lastWidth) {
      this.lastWidth = width;
      this.fill.style.width = `${width}%`;
    }

    text(
      this.detail,
      boot?.download !== undefined
        ? `Neural net, ${Math.round(boot.download * 100)}% — about 15 MB, once, then never again`
        : `${gamesDone} game${gamesDone === 1 ? '' : 's'} done · ${found} position${
            found === 1 ? '' : 's'
          } ready · the board opens at ${GATE_PUZZLES}`,
    );

    text(this.hint, backlog ? backlogHint(backlog) : STEADY_HINT);
  }
}

/** Only touches the DOM when the string actually changed. */
function text(slot: Slot, value: string): void {
  if (slot.last === value) return;
  slot.last = value;
  slot.el.textContent = value;
}

function html(slot: Slot, value: string): void {
  if (slot.last === value) return;
  slot.last = value;
  slot.el.innerHTML = value;
}

const backlogHint = (backlog: number): string =>
  `Every position is searched before you are shown it, so that finding the move means the same
   thing each time you meet it. ${backlog} stored game${backlog === 1 ? '' : 's'} still to go —
   nothing is being downloaded again, this is the processor doing the work, and it is one-time
   per game. The board opens as soon as there is enough to solve and the rest carries on behind
   it.`;

const STEADY_HINT = `Games lichess has already analysed skip the slow half. Every position is then
  searched here to work out the engine's best few moves in it, which is the slow, warm, deliberate
  part — and is what lets a position be judged the same way every time it comes round.`;

/** Shared with `App`; the licence requires the source link on every screen. */
export function footer(): string {
  return `<footer>
    <a href="https://github.com/Gamah/lichess-blindspot">Source</a> · AGPL-3.0-or-later ·
    positions from <a href="https://lichess.org">lichess.org</a>
  </footer>`;
}
