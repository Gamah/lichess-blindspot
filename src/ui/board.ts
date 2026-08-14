// Chessground, wrapped so the rest of the app never touches it directly.
//
// The one bit of chrome on an otherwise bare screen is the promotion chooser,
// which exists because auto-queening would make a puzzle whose answer is an
// underpromotion unsolvable rather than merely hard.

import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';

import { applyUci, dests, isCheck } from '../deck/positions.ts';
import type { Color } from '../analysis/winningChances.ts';

/**
 * One brush per rank, the same blue fading out as it goes down the list —
 * lila's paleBlue is `#003088` at 0.4, and this is that idea spread over five
 * arrows so the ordering is visible without reading the numbers.
 *
 * Chessground has no per-shape opacity (`modifiers` is lineWidth and hilite
 * only), so a fade has to be a brush per step.
 */
type Brush = { key: string; color: string; opacity: number; lineWidth: number };

const RANK_BRUSHES: Record<string, Brush> = {
  ...Object.fromEntries(
    [0.85, 0.65, 0.5, 0.38, 0.28].map((opacity, i) => [
      `rank${i + 1}`,
      { key: `r${i + 1}`, color: '#003088', opacity, lineWidth: 12 - i },
    ]),
  ),
  // The one you found, at full strength — chessground's green, so it reads as
  // the same "yes" the feedback line gives.
  found: { key: 'fnd', color: '#15781B', opacity: 0.9, lineWidth: 12 },
};

export interface PlayedMove {
  uci: string;
  san: string;
  /** Position after the move, for handing to the engine. */
  after: string;
}

export class Board {
  private cg: Api;
  private fen = '';
  /** Bumps per position shown, so a slow intro cannot land on the next puzzle. */
  private presenting = 0;
  private orientation: Color = 'white';

  private readonly el: HTMLElement;
  private readonly onMove: (move: PlayedMove) => void;

  constructor(el: HTMLElement, onMove: (move: PlayedMove) => void) {
    this.el = el;
    this.onMove = onMove;
    this.cg = Chessground(el, {
      coordinates: true,
      animation: { enabled: true, duration: 200 },
      movable: { free: false, showDests: true, events: { after: (o, d) => void this.afterMove(o, d) } },
      draggable: { showGhost: true },
      // chessground deep-merges its config, so naming a few extra brushes adds
      // them to the defaults rather than replacing the set. The cast is for
      // that: the type wants the whole set, the merge does not.
      drawable: { enabled: true, brushes: RANK_BRUSHES as unknown as DrawBrushes },
    });
  }

  /**
   * Open on the previous position, play the opponent's move, then hand over —
   * the way a lichess puzzle starts. Returns once the position is solvable.
   */
  async present(
    fen: string,
    orientation: Color,
    intro: { fen: string; uci: string } | undefined,
    pause = 700,
  ): Promise<void> {
    const token = ++this.presenting;
    if (!intro) return this.set(fen, orientation, true);

    this.set(intro.fen, orientation, false);
    await sleep(pause);
    // Someone hit Next while this was playing; that puzzle owns the board now.
    if (token !== this.presenting) return;
    const orig = intro.uci.slice(0, 2) as Key;
    const dest = intro.uci.slice(2, 4) as Key;
    this.cg.move(orig, dest);
    this.set(fen, orientation, true, [orig, dest]);
  }

  /** Show a position, taking moves from `orientation`'s side. */
  set(fen: string, orientation: Color, movable: boolean, lastMove?: [Key, Key]): void {
    this.fen = fen;
    this.orientation = orientation;
    this.cg.set({
      fen,
      orientation,
      turnColor: orientation,
      lastMove,
      check: isCheck(fen),
      movable: {
        color: movable ? orientation : undefined,
        dests: movable ? (dests(fen) as Map<Key, Key[]>) : new Map(),
      },
    });
    this.cg.setShapes([]);
  }

  /**
   * An arrow for one move. Used to show what the game actually did with a
   * position, once solving it is over and the context is allowed back.
   */
  drawMove(uci: string, brush = 'red'): void {
    this.cg.setShapes([arrow(uci, brush)]);
  }

  /**
   * The reveal, drawn on the board **as it stands** — the position after
   * whatever move ended the solve, not the one the puzzle handed out. So the
   * arrows leave from squares their pieces have left, which reads as what it
   * is: these were the options, and here is what happened instead.
   *
   * `top` is the engine's own ordering, best first, numbered and fading.
   * `played` is what the game did, in red. `found` is the move that solved it:
   * if the engine ranked it, that arrow turns green and keeps its number, so
   * "you found its third choice" is legible from the board alone.
   *
   * Numbered rather than coloured alone, because five shades of one blue is a
   * ranking nobody can read.
   */
  reveal(top: readonly string[], played?: string, found?: string): void {
    const shapes: DrawShape[] = top.slice(0, 5).map((uci, i) => ({
      ...arrow(uci, uci === found ? 'found' : `rank${i + 1}`),
      label: { text: String(i + 1) },
    }));
    // Last, so it draws over the fan of blue rather than under it.
    if (played) shapes.push(arrow(played, 'red'));
    this.cg.setShapes(shapes);
  }

  /** Rewind to the position we handed out, after a wrong move. */
  reset(): void {
    this.set(this.fen, this.orientation, true);
  }

  freeze(): void {
    this.cg.set({ movable: { color: undefined, dests: new Map() } });
  }

  /** Play a line out on the board, for showing the solution. */
  async playLine(ucis: readonly string[], fen = this.fen, delay = 600): Promise<void> {
    let at = fen;
    for (const uci of ucis) {
      const played = applyUci(at, uci);
      if (!played) return;
      this.cg.move(uci.slice(0, 2) as Key, uci.slice(2, 4) as Key);
      this.cg.set({
        fen: played.after,
        turnColor: turnOf(played.after),
        check: isCheck(played.after),
      });
      at = played.after;
      await sleep(delay);
    }
    this.freeze();
  }

  private async afterMove(orig: Key, dest: Key): Promise<void> {
    const uci = orig + dest;
    // chessground has already moved the piece, so ask chessops what the move
    // actually was and re-set the board from its answer. A move that is only
    // legal with a promotion piece attached is exactly how we detect one.
    let played = applyUci(this.fen, uci);
    let full = uci;
    if (!played) {
      const piece = await this.askPromotion(dest);
      if (!piece) return this.reset(); // cancelled
      full = uci + piece;
      played = applyUci(this.fen, full);
    }
    if (!played) return this.reset();
    this.cg.set({
      fen: played.after,
      turnColor: turnOf(played.after),
      check: isCheck(played.after),
    });
    this.freeze();
    this.onMove({ uci: full, san: played.san, after: played.after });
  }

  /**
   * Underpromotion is rare and a puzzle whose answer is one is rarer, but
   * auto-queening makes such a puzzle unsolvable rather than hard, so it gets
   * asked. Escape or a click outside cancels the move.
   */
  private askPromotion(dest: Key): Promise<'q' | 'r' | 'b' | 'n' | undefined> {
    const colour = turnOf(this.fen);
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'promotion';
      overlay.innerHTML = (['q', 'r', 'b', 'n'] as const)
        .map(
          p =>
            `<button data-piece="${p}" title="${PIECE_NAMES[p]} on ${dest}">
               <piece class="${PIECE_NAMES[p]} ${colour}"></piece>
             </button>`,
        )
        .join('');

      const done = (piece?: 'q' | 'r' | 'b' | 'n') => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(piece);
      };
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && done();

      overlay.addEventListener('click', e => {
        const piece = (e.target as HTMLElement).closest('button')?.dataset['piece'];
        done(piece as 'q' | 'r' | 'b' | 'n' | undefined);
      });
      document.addEventListener('keydown', onKey);
      // Inside .cg-wrap, because that is the ancestor the piece-set stylesheet
      // keys its images off. Our own rules undo its absolute positioning.
      (this.el.querySelector('.cg-wrap') ?? this.el).appendChild(overlay);
    });
  }
}

const arrow = (uci: string, brush: string): DrawShape => ({
  orig: uci.slice(0, 2) as Key,
  dest: uci.slice(2, 4) as Key,
  brush,
});

const PIECE_NAMES ={ q: 'queen', r: 'rook', b: 'bishop', n: 'knight' } as const;

const turnOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'black' : 'white');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
